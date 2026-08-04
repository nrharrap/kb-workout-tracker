/**
 * Google sign-in and the Drive REST API (PRD 3.2).
 *
 * Uses Google Identity Services for the token and plain `fetch` for Drive —
 * no gapi client library, which keeps the "no build step, no framework"
 * constraint honest and avoids pulling a large script for four endpoints.
 *
 * Scope is `drive.file`: the app can only see files it created itself. Nick's
 * wider Drive is not visible to this code even in principle.
 *
 * Worth knowing, so it isn't mistaken for a bug: a browser-only OAuth flow
 * gets a ~1 hour access token and no refresh token. Silent renewal works while
 * the Google session is alive, and with the consent screen in "Testing" status
 * Google caps that at roughly 7 days — so re-signing in about weekly is
 * expected behaviour, exactly as the PRD anticipates.
 */

import { DATA_FILE_NAME } from './schema.js';

export const CLIENT_ID =
  '723125167188-kapsm6m28bvqit9o2d66ijfa2dt2pm8m.apps.googleusercontent.com';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export class AuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AuthError';
    this.status = status || 401;
  }
}

// --- Auth -------------------------------------------------------------------

export class DriveAuth {
  constructor(clientId = CLIENT_ID) {
    this.clientId = clientId;
    this.tokenClient = null;
    this.accessToken = null;
    this.expiresAt = 0;
    this.onSignedOut = null;
  }

  /** Load the GIS script. Resolves false if it can't be reached (offline). */
  async init() {
    if (window.google?.accounts?.oauth2) return this._initTokenClient();
    try {
      await loadScript(GIS_SRC);
    } catch {
      return false;
    }
    return this._initTokenClient();
  }

  _initTokenClient() {
    if (!window.google?.accounts?.oauth2) return false;
    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: SCOPE,
      callback: () => {}, // replaced per-request in requestToken()
    });
    return true;
  }

  isSignedIn() {
    return Boolean(this.accessToken) && Date.now() < this.expiresAt;
  }

  /**
   * @param {boolean} interactive  false attempts a silent renewal against an
   *   existing Google session; true shows the account chooser/consent screen.
   *
   * Interactive requests fire immediately and synchronously — `_fire()` is
   * called directly, not queued behind a `.then()`. Browsers only let the
   * OAuth popup through when `requestAccessToken()` is called within the
   * same call stack as the triggering click; even a single microtask of
   * delay is enough for some browsers (desktop Safari in particular, some
   * Chrome configurations too) to decide it wasn't user-initiated and block
   * it silently — no error, the button just looks like it does nothing. That
   * was a real bug here, not hypothetical: it worked on mobile, which is
   * more lenient about this, and failed on desktop.
   *
   * Silent requests still queue behind whatever's pending. The GIS token
   * client has a single `callback` slot, so two overlapping silent renewals
   * (e.g. two Drive calls hitting a 401 at once) would have the second
   * overwrite the first's handler and then receive the first's result —
   * queuing is what avoids that. An interactive request never waits in this
   * queue; `_fire()` instead supersedes whatever silent request was in
   * flight (rejecting it) so the two can't cross-resolve each other either.
   */
  requestToken(options = {}) {
    if (!this.tokenClient) {
      return Promise.reject(new AuthError('Google sign-in is unavailable — check your connection.'));
    }

    if (options.interactive) {
      return this._fire(options);
    }

    const run = () => this._fire(options);
    // `.then(run, run)` so a rejected earlier request doesn't stall the queue.
    this._chain = (this._chain || Promise.resolve()).then(run, run);
    return this._chain;
  }

  _fire({ interactive = false } = {}) {
    if (this.isSignedIn()) return Promise.resolve(this.accessToken);

    // A newer request (typically an interactive one jumping the queue)
    // supersedes whatever's in flight, rather than letting the two race for
    // the token client's one callback slot.
    if (this._pendingReject) {
      this._pendingReject(new AuthError('Superseded by a newer sign-in request'));
    }

    return new Promise((resolve, reject) => {
      this._pendingReject = reject;
      this.tokenClient.callback = (response) => {
        this._pendingReject = null;
        if (response.error) {
          // The user closing or declining the popup is a normal outcome, not
          // a crash — the caller shows a retry rather than an error state.
          reject(new AuthError(response.error_description || response.error));
          return;
        }
        this.accessToken = response.access_token;
        // Renew a minute early so a request never races the expiry.
        this.expiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000 - 60_000;
        resolve(this.accessToken);
      };

      try {
        this.tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      } catch (err) {
        this._pendingReject = null;
        reject(new AuthError(err.message));
      }
    });
  }

  /** A valid token, renewing silently if the current one has expired. */
  async getToken() {
    if (this.isSignedIn()) return this.accessToken;
    return this.requestToken({ interactive: false });
  }

  signOut() {
    const token = this.accessToken;
    this.accessToken = null;
    this.expiresAt = 0;
    if (token && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(token, () => {});
    }
    this.onSignedOut?.();
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.defer = true;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

// --- Drive client -----------------------------------------------------------

/**
 * Implements the `client` interface sync.js expects:
 * getMeta / getContent / upload, plus file discovery.
 */
export function createDriveClient(auth) {
  async function request(url, options = {}, { retryOnAuthFailure = true } = {}) {
    const token = await auth.getToken();
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });

    if (res.status === 401 && retryOnAuthFailure) {
      // Token rejected — try one silent renewal before asking the user.
      auth.accessToken = null;
      return request(url, options, { retryOnAuthFailure: false });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Drive API ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  return {
    /**
     * Locate the data file, creating it on first sign-in (T2).
     * `drive.file` scope means this listing only ever sees our own file.
     */
    async findOrCreateFile() {
      const query = encodeURIComponent(`name = '${DATA_FILE_NAME}' and trashed = false`);
      const res = await request(
        `${API}/files?q=${query}&spaces=drive&fields=files(id,name,version,modifiedTime)&pageSize=10`
      );
      const { files } = await res.json();

      if (files?.length) {
        // Sort for determinism if a duplicate ever appears; oldest wins, since
        // that is the one with the history in it.
        files.sort((a, b) => (a.id < b.id ? -1 : 1));
        return { fileId: files[0].id, created: false, duplicates: files.length - 1 };
      }
      return { fileId: await this.createFile(), created: true, duplicates: 0 };
    },

    async createFile(initialContent = null) {
      const metadata = {
        name: DATA_FILE_NAME,
        mimeType: 'application/json',
        description: 'Golf Strength & Speed Programme tracker data. Managed by kb-workout-tracker.',
      };
      const body = multipart(metadata, initialContent ?? { schemaVersion: 2, cycles: [], sessions: [], skips: [], retests: [], deleted: [] });

      const res = await request(`${UPLOAD_API}/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${BOUNDARY}` },
        body,
      });
      return (await res.json()).id;
    },

    async getMeta(fileId) {
      const res = await request(`${API}/files/${fileId}?fields=version,modifiedTime`);
      return res.json();
    },

    async getContent(fileId) {
      const res = await request(`${API}/files/${fileId}?alt=media`);
      const text = await res.text();
      if (!text.trim()) return null; // freshly created, still empty
      return JSON.parse(text);
    },

    async upload(fileId, data) {
      const res = await request(
        `${UPLOAD_API}/files/${fileId}?uploadType=media&fields=version,modifiedTime`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        }
      );
      return res.json();
    },
  };
}

const BOUNDARY = 'kbwt-boundary-7f3a9c';

function multipart(metadata, content) {
  return [
    `--${BOUNDARY}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${BOUNDARY}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(content),
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n');
}
