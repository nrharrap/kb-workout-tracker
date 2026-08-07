/**
 * GitHub-backed auth and storage (replaces Google Drive — see PRD 3.2).
 *
 * Google's OAuth flow was tried two ways — a popup, then a full-page
 * redirect — and both failed on Nick's desktop for reasons that couldn't be
 * pinned down (browser/extension-level popup blocking, and the redirect
 * path needing exact Cloud Console configuration that's easy to get subtly
 * wrong). A pasted Personal Access Token sidesteps that whole category of
 * failure: no popup, no redirect, no consent screen, no origin/redirect-URI
 * registration to get right. The trade-off is the token has to be created
 * and pasted in by hand, once per device, and again whenever it expires.
 *
 * Data lives in a **secret Gist** — one JSON file, in the account that owns
 * the token. Worth knowing plainly: a secret gist is *unlisted*, not
 * authenticated-private the way Drive's `drive.file` scope was. Anyone who
 * somehow obtained the exact gist URL (a long, unguessable ID) could view it
 * without signing in. For a personal fitness log this is an acceptable
 * trade for a static site with no backend, but it is a real difference from
 * the old design and worth knowing rather than assuming.
 *
 * The token needs the classic **gist** scope (not fine-grained — fine-grained
 * PATs don't currently cover Gists at all, so a fine-grained token simply
 * won't work here). That scope grants access to *all* of the account's
 * gists, not just this app's one file — there's no Drive-style per-file
 * scoping available for Gists.
 */

import { DATA_FILE_NAME } from './schema.js';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const GIST_DESCRIPTION = 'kb-workout-tracker data — managed by the app, please don\'t edit by hand';

export class AuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AuthError';
    this.status = status || 401;
  }
}

// --- Auth ---------------------------------------------------------------

export class GitHubAuth {
  constructor() {
    this.token = null;
    this.username = null;
    this.onSignedOut = null;
  }

  isSignedIn() {
    return Boolean(this.token);
  }

  /** Load a previously-pasted token without re-validating it against the network. */
  restore(token, username = null) {
    this.token = token || null;
    this.username = username;
  }

  /**
   * Validates the token against GitHub before storing it, so a typo or a
   * token with the wrong scope fails immediately with a clear message,
   * rather than surfacing later as a confusing 401 on the first save.
   */
  async connect(token) {
    const trimmed = (token || '').trim();
    if (!trimmed) throw new AuthError('Paste a token first.');

    const res = await fetch(`${API}/user`, { headers: authHeaders(trimmed) });
    if (res.status === 401) {
      throw new AuthError('GitHub rejected that token — check it was copied in full and hasn\'t expired.');
    }
    if (!res.ok) {
      throw new AuthError(`GitHub returned an unexpected error (${res.status}). Try again in a moment.`);
    }
    const scopes = (res.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim());
    if (!scopes.includes('gist')) {
      throw new AuthError('That token doesn\'t have the "gist" scope checked — recreate it with only "gist" ticked.');
    }

    const user = await res.json();
    this.token = trimmed;
    this.username = user.login;
    return { username: user.login };
  }

  signOut() {
    this.token = null;
    this.username = null;
    this.onSignedOut?.();
  }
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
}

// --- Gist client ----------------------------------------------------------

/**
 * Implements the `client` interface sync.js expects: getMeta / getContent /
 * upload, plus file discovery — matching drive.js's old shape exactly, so
 * sync.js (the merge/conflict logic) needed no changes at all to move to
 * this backend.
 */
export function createGistClient(auth) {
  async function request(path, options = {}) {
    if (!auth.token) throw new AuthError('Not signed in.');
    const res = await fetch(`${API}${path}`, {
      ...options,
      headers: { ...authHeaders(auth.token), ...(options.headers || {}) },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  /** version token = the latest revision's SHA; falls back to updated_at if history is ever absent. */
  function versionOf(gist) {
    return { version: gist.history?.[0]?.version || null, modifiedTime: gist.updated_at };
  }

  async function readFile(gist) {
    const file = gist.files?.[DATA_FILE_NAME];
    if (!file) return null;
    if (!file.truncated) return file.content;
    // Large-content gists get truncated in list/get responses; the raw file
    // itself never is. Not expected to trigger for this app's data size, but
    // handled rather than silently returning a corrupt partial JSON string.
    const res = await fetch(file.raw_url, { headers: authHeaders(auth.token) });
    return res.text();
  }

  return {
    /**
     * Locate the data gist, creating it on first connect (T2). Since Gist
     * scope has no Drive-style per-file restriction, this searches *all* of
     * the account's gists for one with our filename — a fresh account (or
     * one where this app has never run) finds none and creates one.
     */
    async findOrCreateFile() {
      let page = 1;
      const candidates = [];
      // Bounded rather than unbounded — a personal account is never going to
      // have so many gists that this doesn't terminate quickly, and an
      // infinite loop on an unexpected API response shape would be worse
      // than stopping after a generous cap.
      for (; page <= 20; page++) {
        const res = await request(`/gists?per_page=100&page=${page}`);
        const gists = await res.json();
        if (!gists.length) break;
        candidates.push(...gists.filter((g) => g.files && DATA_FILE_NAME in g.files));
        if (gists.length < 100) break; // last page
      }

      if (candidates.length) {
        candidates.sort((a, b) => (a.created_at < b.created_at ? -1 : 1)); // oldest — the one with history
        return { fileId: candidates[0].id, created: false, duplicates: candidates.length - 1 };
      }
      return { fileId: await this.createFile(), created: true, duplicates: 0 };
    },

    async createFile(initialContent = null) {
      const content = JSON.stringify(
        initialContent ?? { schemaVersion: 2, cycles: [], sessions: [], skips: [], retests: [], deleted: [] }
      );
      const res = await request('/gists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: GIST_DESCRIPTION,
          public: false,
          files: { [DATA_FILE_NAME]: { content } },
        }),
      });
      return (await res.json()).id;
    },

    async getMeta(fileId) {
      const res = await request(`/gists/${fileId}`);
      return versionOf(await res.json());
    },

    async getContent(fileId) {
      const res = await request(`/gists/${fileId}`);
      const gist = await res.json();
      const text = await readFile(gist);
      if (!text || !text.trim()) return null;
      return JSON.parse(text);
    },

    async upload(fileId, data) {
      const res = await request(`/gists/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: { [DATA_FILE_NAME]: { content: JSON.stringify(data) } } }),
      });
      return versionOf(await res.json());
    },
  };
}
