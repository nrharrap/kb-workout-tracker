/**
 * GitHubAuth (token validation, scope checking) and createGistClient
 * (file discovery, read, write, conflict version tokens).
 *
 * Fakes window.fetch for api.github.com rather than the client interface
 * itself — that's the boundary sync.js already treats as generic (see
 * sync.test.js's fakeDrive-style fakes), so this file is what actually
 * proves the Gist-specific request/response shapes are handled correctly.
 */

import { test, assert } from './harness.js';
import { GitHubAuth, createGistClient } from '../js/github.js';
import { DATA_FILE_NAME } from '../js/schema.js';

/** A fake GitHub API. Only one token is ever "valid" per fake, matching one signed-in device. */
function fakeGitHub({ validToken = 'tok-good', scopes = 'gist', login = 'nrharrap', gists = [] } = {}) {
  const state = {
    gists: new Map(gists.map((g) => [g.id, structuredCloneCompat(g)])),
    nextId: 9000,
    calls: [],
  };
  const original = window.fetch;

  function tokenFrom(options) {
    const h = options.headers || {};
    const auth = h.Authorization || h.authorization;
    return auth ? auth.replace(/^Bearer\s+/, '') : null;
  }

  function json(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  window.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== 'api.github.com') return original(url, options);

    const method = (options.method || 'GET').toUpperCase();
    state.calls.push(`${method} ${u.pathname}${u.search}`);
    const token = tokenFrom(options);

    if (u.pathname === '/user') {
      if (token !== validToken) return json({ message: 'Bad credentials' }, 401);
      return json({ login }, 200, { 'x-oauth-scopes': scopes });
    }

    if (token !== validToken) return json({ message: 'Bad credentials' }, 401);

    if (u.pathname === '/gists' && method === 'GET') {
      return json([...state.gists.values()].map(summarise));
    }

    if (u.pathname === '/gists' && method === 'POST') {
      const body = JSON.parse(options.body);
      const id = `gist-${state.nextId++}`;
      const gist = makeGist(id, body.files, body.description, body.public);
      state.gists.set(id, gist);
      return json({ id });
    }

    const single = u.pathname.match(/^\/gists\/([^/]+)$/);
    if (single && method === 'GET') {
      const g = state.gists.get(single[1]);
      if (!g) return json({ message: 'Not Found' }, 404);
      return json(g);
    }

    if (single && method === 'PATCH') {
      const g = state.gists.get(single[1]);
      if (!g) return json({ message: 'Not Found' }, 404);
      const body = JSON.parse(options.body);
      Object.assign(g.files, body.files);
      bumpRevision(g);
      return json(g);
    }

    return json({ message: `unhandled ${method} ${u.pathname}` }, 500);
  };

  function summarise(g) {
    return { id: g.id, created_at: g.created_at, files: g.files };
  }

  return {
    state,
    calls: state.calls,
    gists: state.gists,
    restore: () => { window.fetch = original; },
  };
}

let seq = 0;
function makeGist(id, files, description = '', isPublic = false) {
  const now = new Date(2026, 0, 1, 0, 0, seq++).toISOString();
  const gist = { id, description, public: isPublic, created_at: now, updated_at: now, files: {}, history: [] };
  for (const [name, f] of Object.entries(files)) gist.files[name] = { content: f.content, truncated: false };
  bumpRevision(gist);
  return gist;
}

function bumpRevision(gist) {
  gist.updated_at = new Date(2026, 0, 1, 0, 0, seq++).toISOString();
  gist.history.unshift({ version: `sha-${seq}`, committed_at: gist.updated_at });
}

function structuredCloneCompat(v) {
  return JSON.parse(JSON.stringify(v));
}

// --- GitHubAuth ---------------------------------------------------------

test('connect() validates the token, checks the gist scope, and stores the username', async () => {
  const gh = fakeGitHub({ validToken: 'tok-good', scopes: 'gist', login: 'nrharrap' });
  const auth = new GitHubAuth();

  const result = await auth.connect('tok-good');

  assert.equal(result.username, 'nrharrap');
  assert.equal(auth.isSignedIn(), true);
  assert.equal(auth.username, 'nrharrap');
  gh.restore();
});

test('connect() rejects a bad token with a clear message, not a raw 401', async () => {
  const gh = fakeGitHub({ validToken: 'tok-good' });
  const auth = new GitHubAuth();

  try {
    await auth.connect('tok-wrong');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(/rejected|check/i.test(err.message), `message should be actionable, got: ${err.message}`);
  }
  assert.equal(auth.isSignedIn(), false);
  gh.restore();
});

test('connect() rejects a token missing the gist scope', async () => {
  const gh = fakeGitHub({ validToken: 'tok-good', scopes: 'repo,read:user' }); // no "gist"
  const auth = new GitHubAuth();

  try {
    await auth.connect('tok-good');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(/gist/i.test(err.message), `message should mention the missing scope, got: ${err.message}`);
  }
  assert.equal(auth.isSignedIn(), false, 'a token with the wrong scope must not be accepted even though it is otherwise valid');
  gh.restore();
});

test('connect() rejects a blank paste without making a network call', async () => {
  const gh = fakeGitHub();
  const auth = new GitHubAuth();

  try {
    await auth.connect('   ');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.message.length > 0);
  }
  assert.equal(gh.calls.length, 0, 'no request should fire for an empty token');
  gh.restore();
});

test('restore() sets signed-in state without touching the network', () => {
  const gh = fakeGitHub();
  const auth = new GitHubAuth();
  auth.restore('tok-good', 'nrharrap');

  assert.equal(auth.isSignedIn(), true);
  assert.equal(gh.calls.length, 0);
  gh.restore();
});

test('signOut() clears the in-memory token', () => {
  const auth = new GitHubAuth();
  auth.restore('tok-good', 'nrharrap');
  let signedOutFired = false;
  auth.onSignedOut = () => { signedOutFired = true; };

  auth.signOut();

  assert.equal(auth.isSignedIn(), false);
  assert.isNull(auth.token);
  assert.equal(signedOutFired, true);
});

// --- createGistClient: discovery ----------------------------------------

test('findOrCreateFile creates a gist when none exists yet', async () => {
  const gh = fakeGitHub({ gists: [] });
  const auth = new GitHubAuth();
  auth.restore('tok-good');
  const client = createGistClient(auth);

  const result = await client.findOrCreateFile();

  assert.equal(result.created, true);
  assert.equal(result.duplicates, 0);
  assert.ok(gh.gists.has(result.fileId));
  const created = gh.gists.get(result.fileId);
  assert.equal(created.public, false, 'the gist must be secret, not public');
  assert.ok(created.files[DATA_FILE_NAME], 'seeded with the right filename');
  gh.restore();
});

test('findOrCreateFile finds an existing gist by filename rather than creating a second one', async () => {
  const existing = makeGist('gist-existing', { [DATA_FILE_NAME]: { content: '{"schemaVersion":2,"sessions":[]}' } });
  const gh = fakeGitHub({ gists: [existing] });
  const auth = new GitHubAuth();
  auth.restore('tok-good');
  const client = createGistClient(auth);

  const result = await client.findOrCreateFile();

  assert.equal(result.created, false);
  assert.equal(result.fileId, 'gist-existing');
  assert.equal(gh.calls.filter((c) => c.startsWith('POST')).length, 0, 'must not create a duplicate');
  gh.restore();
});

test('findOrCreateFile ignores gists that are not ours (no matching filename)', async () => {
  const unrelated = makeGist('gist-other', { 'notes.txt': { content: 'hello' } });
  const gh = fakeGitHub({ gists: [unrelated] });
  const auth = new GitHubAuth();
  auth.restore('tok-good');
  const client = createGistClient(auth);

  const result = await client.findOrCreateFile();

  assert.equal(result.created, true, 'the unrelated gist should not be mistaken for ours');
  assert.notEqual(result.fileId, 'gist-other');
  gh.restore();
});

test('findOrCreateFile picks the oldest match when duplicates exist', async () => {
  const older = { ...makeGist('gist-older', { [DATA_FILE_NAME]: { content: '{}' } }), created_at: '2026-01-01T00:00:00.000Z' };
  const newer = { ...makeGist('gist-newer', { [DATA_FILE_NAME]: { content: '{}' } }), created_at: '2026-02-01T00:00:00.000Z' };
  const gh = fakeGitHub({ gists: [newer, older] }); // deliberately out of order
  const auth = new GitHubAuth();
  auth.restore('tok-good');
  const client = createGistClient(auth);

  const result = await client.findOrCreateFile();

  assert.equal(result.fileId, 'gist-older', 'the one with the longer history wins');
  assert.equal(result.duplicates, 1);
  gh.restore();
});

// --- createGistClient: read / write / version tokens ---------------------

test('getMeta and getContent read the file and its revision', async () => {
  const seed = makeGist('gist-1', { [DATA_FILE_NAME]: { content: '{"schemaVersion":2,"sessions":[{"a":1}]}' } });
  const gh = fakeGitHub({ gists: [seed] });
  const auth = new GitHubAuth();
  auth.restore('tok-good');
  const client = createGistClient(auth);

  const meta = await client.getMeta('gist-1');
  const content = await client.getContent('gist-1');

  assert.ok(meta.version, 'a revision SHA is present');
  assert.equal(content.sessions[0].a, 1);
  gh.restore();
});

test('getContent returns null for a gist with no matching file (freshly created, or wrong gist)', async () => {
  const seed = makeGist('gist-1', { 'unrelated.txt': { content: 'x' } });
  const gh = fakeGitHub({ gists: [seed] });
  const auth = new GitHubAuth();
  auth.restore('tok-good');
  const client = createGistClient(auth);

  assert.isNull(await client.getContent('gist-1'));
  gh.restore();
});

test('getContent follows raw_url when GitHub reports the file as truncated', async () => {
  const seed = makeGist('gist-1', { [DATA_FILE_NAME]: { content: 'ignored — replaced below' } });
  seed.files[DATA_FILE_NAME].truncated = true;
  seed.files[DATA_FILE_NAME].raw_url = 'https://api.github.com/raw-fixture/full-content';
  const gh = fakeGitHub({ gists: [seed] });

  const originalFetch = window.fetch;
  window.fetch = async (url, options) => {
    if (String(url) === seed.files[DATA_FILE_NAME].raw_url) {
      return new Response('{"schemaVersion":2,"sessions":[{"full":true}]}', { status: 200 });
    }
    return originalFetch(url, options);
  };

  const auth = new GitHubAuth();
  auth.restore('tok-good');
  const client = createGistClient(auth);
  const content = await client.getContent('gist-1');

  assert.equal(content.sessions[0].full, true, 'the truncated response was not used as-is');
  window.fetch = originalFetch;
  gh.restore();
});

test('upload writes the new content and returns a version token that changes', async () => {
  const seed = makeGist('gist-1', { [DATA_FILE_NAME]: { content: '{"schemaVersion":2,"sessions":[]}' } });
  const gh = fakeGitHub({ gists: [seed] });
  const auth = new GitHubAuth();
  auth.restore('tok-good');
  const client = createGistClient(auth);

  const before = await client.getMeta('gist-1');
  const after = await client.upload('gist-1', { schemaVersion: 2, sessions: [{ a: 1 }] });

  assert.notEqual(after.version, before.version, 'writing must produce a new revision token');
  const stored = JSON.parse(gh.gists.get('gist-1').files[DATA_FILE_NAME].content);
  assert.equal(stored.sessions[0].a, 1);
  gh.restore();
});

test('a request with no signed-in token is rejected before any fetch happens', async () => {
  const gh = fakeGitHub();
  const auth = new GitHubAuth(); // never restored/connected
  const client = createGistClient(auth);

  try {
    await client.getMeta('gist-1');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.name, 'AuthError');
  }
  assert.equal(gh.calls.length, 0);
  gh.restore();
});

test('a 401 from the API surfaces with .status set, for sync.js\'s AUTH_REQUIRED path', async () => {
  const gh = fakeGitHub({ validToken: 'tok-good' });
  const auth = new GitHubAuth();
  auth.restore('tok-stale'); // a token the fake no longer accepts, e.g. revoked
  const client = createGistClient(auth);

  try {
    await client.getMeta('gist-1');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.status, 401);
  }
  gh.restore();
});
