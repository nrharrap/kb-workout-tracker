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
 *
 * Interactive sign-in and silent renewal use two different mechanisms, on
 * purpose:
 *
 * - **Interactive** (the "Sign in with Google" button) is a full-page
 *   redirect to Google's consent screen and back — the standard OAuth
 *   implicit flow, built by hand rather than via the GIS token client. A
 *   full-page navigation cannot be blocked as a popup; it's the same browser
 *   mechanism as following an ordinary link. This replaced a GIS popup-based
 *   flow that desktop Safari (and some Chrome configurations) silently
 *   blocked outright, no error shown, regardless of call timing.
 * - **Silent renewal** (on boot, and whenever a Drive call hits a 401) still
 *   uses the GIS token client with `prompt: ''`. That path was never the
 *   problem — it doesn't open a visible popup — and GIS is the simplest way
 *   to ask "is there still a live Google session for this browser?"
 *
 * The redirect flow needs the app's exact URL registered as an *Authorized
 * redirect URI* on the OAuth client (Cloud Console → Credentials → this
 * client → Authorized redirect URIs) — a different setting from the
 * Authorized JavaScript origins already set up for the old popup flow, and
 * something only Nick can do (his Google Cloud project).
 */

import { DATA_FILE_NAME } from './schema.js';

export const CLIENT_ID =
  '723125167188-kapsm6m28bvqit9o2d66ijfa2dt2pm8m.apps.googleusercontent.com';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const OAUTH_STATE_KEY = 'kbwt.oauthState';

export class AuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AuthError';
    this.status = status || 401;
  }
}

/** The exact URL Google should send the browser back to after sign-in. */
export function redirectUri(loc = window.location) {
  return loc.origin + loc.pathname;
}

/** Pure — builds the OAuth consent-screen URL. Exported for testing. */
export function buildAuthUrl(clientId, redirect, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Pure — parses the URL fragment Google appends on redirect back
 * (`#access_token=...&expires_in=...&state=...`, or `#error=...` if the user
 * declined). Returns null for a fragment that isn't an OAuth return at all
 * (e.g. plain "#", or absent). Exported for testing.
 */
export function parseRedirectFragment(hash) {
  if (!hash) return null;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!body.includes('access_token=') && !body.includes('error=')) return null;

  const params = new URLSearchParams(body);
  return {
    accessToken: params.get('access_token'),
    expiresIn: params.get('expires_in'),
    state: params.get('state'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  };
}

// --- Auth -------------------------------------------------------------------

export class DriveAuth {
  constructor(clientId = CLIENT_ID) {
    this.clientId = clientId;
    this.tokenClient = null;
    this.accessToken = null;
    this.expiresAt = 0;
    this.onSignedOut = null;
    this._redirectError = null;
  }

  /**
   * Consumes a redirect-return token (if the URL has one) first, then loads
   * the GIS script for silent renewal. Resolves false only if GIS can't be
   * reached (offline) — a token already consumed from the URL is still usable
   * even then, since it needed no network round-trip of its own to obtain.
   */
  async init() {
    this._consumeRedirectToken();
    if (window.google?.accounts?.oauth2) return this._initTokenClient();
    try {
      await loadScript(GIS_SRC);
    } catch {
      return this.isSignedIn();
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
   * Navigates the whole page to Google's consent screen. Nothing after this
   * call runs in the current page load — the browser leaves. On return,
   * `init()` (called again on the fresh page load) picks the token up out of
   * the URL via `_consumeRedirectToken()`.
   */
  signIn() {
    const state = randomState();
    sessionStorage.setItem(OAUTH_STATE_KEY, state);
    window.location.href = buildAuthUrl(this.clientId, redirectUri(), state);
  }

  /** Any error from the last redirect return (e.g. consent declined), consumed once. */
  takeRedirectError() {
    const err = this._redirectError;
    this._redirectError = null;
    return err;
  }

  _consumeRedirectToken() {
    const parsed = parseRedirectFragment(window.location.hash);
    if (!parsed) return;

    // Strip the fragment immediately either way, so the token never lingers
    // in the address bar/history and a page refresh can't resubmit it.
    history.replaceState(null, '', window.location.pathname + window.location.search);

    const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);

    if (parsed.error) {
      this._redirectError = new AuthError(parsed.errorDescription || parsed.error);
      return;
    }
    if (!parsed.accessToken || parsed.state !== expectedState) return; // not a return we started

    this.accessToken = parsed.accessToken;
    this.expiresAt = Date.now() + (Number(parsed.expiresIn) || 3600) * 1000 - 60_000;
  }

  /**
   * Silent renewal only now — interactive sign-in goes through signIn()
   * above instead. Requests still queue behind whatever's pending: the GIS
   * token client has a single `callback` slot, so two overlapping silent
   * renewals (e.g. two Drive calls hitting a 401 at once) would otherwise
   * have the second overwrite the first's handler and then receive the
   * first's result.
   */
  requestToken() {
    if (!this.tokenClient) {
      return Promise.reject(new AuthError('Google sign-in is unavailable — check your connection.'));
    }
    const run = () => this._fire();
    // `.then(run, run)` so a rejected earlier request doesn't stall the queue.
    this._chain = (this._chain || Promise.resolve()).then(run, run);
    return this._chain;
  }

  _fire() {
    if (this.isSignedIn()) return Promise.resolve(this.accessToken);

    return new Promise((resolve, reject) => {
      this.tokenClient.callback = (response) => {
        if (response.error) {
          reject(new AuthError(response.error_description || response.error));
          return;
        }
        this.accessToken = response.access_token;
        // Renew a minute early so a request never races the expiry.
        this.expiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000 - 60_000;
        resolve(this.accessToken);
      };

      try {
        this.tokenClient.requestAccessToken({ prompt: '' });
      } catch (err) {
        reject(new AuthError(err.message));
      }
    });
  }

  /** A valid token, renewing silently if the current one has expired. */
  async getToken() {
    if (this.isSignedIn()) return this.accessToken;
    return this.requestToken();
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

function randomState() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
