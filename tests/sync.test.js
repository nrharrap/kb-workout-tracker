/**
 * Save flow, conflict handling and offline queueing.
 * Covers T5, T6, T8, T9, T10, T29, T30, T31.
 *
 * A fake Drive client stands in for the API so the multi-device races can be
 * staged deterministically.
 */

import { test, assert } from './harness.js';
import { makeData, makeSession, withSets } from './helpers.js';
import { ops, sessionKey } from '../js/merge.js';
import { pushChanges, resolveConflict, OUTCOME, versionToken } from '../js/sync.js';
import { createStore, memoryStorage } from '../js/store.js';
import { emptyData } from '../js/schema.js';

/** Fake Drive: an in-memory file with a version that bumps on every upload. */
function fakeDrive(initial) {
  let content = JSON.parse(JSON.stringify(initial));
  let version = 1;
  const calls = { getMeta: 0, getContent: 0, upload: 0 };
  const hooks = {};
  let sawGetContent = false;

  return {
    calls,
    /**
     * Simulate another device writing in the window between our merge and our
     * upload. In the save flow the pre-upload re-check is always the getMeta
     * immediately following a getContent, so that is what this keys off —
     * keying off a call count instead is brittle and silently no-ops.
     */
    onBeforeRecheck(fn) { hooks.beforeRecheck = fn; },
    externalWrite(mutate) {
      content = JSON.parse(JSON.stringify(content));
      mutate(content);
      version += 1;
    },
    currentVersion: () => version,
    currentContent: () => JSON.parse(JSON.stringify(content)),

    client: {
      async getMeta() {
        calls.getMeta += 1;
        if (sawGetContent && hooks.beforeRecheck) {
          sawGetContent = false;
          hooks.beforeRecheck();
        }
        return { version, modifiedTime: `2026-01-0${version}T00:00:00.000Z` };
      },
      async getContent() {
        calls.getContent += 1;
        sawGetContent = true;
        return JSON.parse(JSON.stringify(content));
      },
      async upload(_fileId, data) {
        calls.upload += 1;
        content = JSON.parse(JSON.stringify(data));
        version += 1;
        return { version, modifiedTime: `2026-01-0${version}T00:00:00.000Z` };
      },
    },
  };
}

const sessionA = makeSession({
  date: '2026-01-05', dayType: 'A', weekInCycle: 1,
  exercises: [withSets('kb-swing-2h', [{ kg: 16, reps: 12, rpe: 7 }])],
  loggedAt: '2026-01-05T18:00:00.000Z',
});
const sessionB = makeSession({
  date: '2026-01-07', dayType: 'B', weekInCycle: 1,
  exercises: [withSets('goblet-squat-rotation', [{ kg: 12, reps: 8, rpe: 6 }])],
  loggedAt: '2026-01-07T19:00:00.000Z',
});

function withSession(base, session) {
  const d = JSON.parse(JSON.stringify(base));
  d.sessions.push(session);
  return d;
}

// --- T6: the ordinary save --------------------------------------------------

test('T6 — an uncontended save writes straight through', async () => {
  const drive = fakeDrive(makeData());
  const base = versionToken({ version: drive.currentVersion() });

  const result = await pushChanges({
    client: drive.client,
    fileId: 'f1',
    baseToken: base,
    pendingOps: [ops.upsertSession(sessionA)],
    localData: withSession(makeData(), sessionA),
  });

  assert.equal(result.outcome, OUTCOME.SYNCED);
  assert.equal(result.merged, false, 'no merge needed');
  assert.equal(drive.calls.getContent, 0, 'and no wasted re-fetch');
  assert.equal(drive.currentContent().sessions.length, 1);
});

test('an empty queue is a no-op, not a write', async () => {
  const drive = fakeDrive(makeData());
  const result = await pushChanges({
    client: drive.client, fileId: 'f1', baseToken: '1', pendingOps: [], localData: makeData(),
  });
  assert.equal(result.outcome, OUTCOME.SYNCED);
  assert.equal(drive.calls.upload, 0, 'saving nothing must not touch Drive');
});

// --- T8: the two-device merge ----------------------------------------------

test('T8 — phone save after laptop save merges both, neither is lost', async () => {
  const drive = fakeDrive(makeData());

  // Both devices load at version 1.
  const baseToken = versionToken({ version: drive.currentVersion() });

  // Laptop saves first — straight through.
  await pushChanges({
    client: drive.client, fileId: 'f1', baseToken,
    pendingOps: [ops.upsertSession(sessionA)],
    localData: withSession(makeData(), sessionA),
  });

  // Phone still holds the version-1 token and now saves its own session.
  const result = await pushChanges({
    client: drive.client, fileId: 'f1', baseToken,
    pendingOps: [ops.upsertSession(sessionB)],
    localData: withSession(makeData(), sessionB),
  });

  assert.equal(result.outcome, OUTCOME.SYNCED);
  assert.equal(result.merged, true, 'the phone detected the change and merged');

  const final = drive.currentContent();
  assert.equal(final.sessions.length, 2, 'both sessions in the final file');
  assert.deepEqual(final.sessions.map((s) => s.dayType), ['A', 'B']);
});

test('T8 — the phone does not clobber the laptop even holding a stale snapshot', async () => {
  const drive = fakeDrive(makeData());
  const baseToken = versionToken({ version: 1 });

  drive.externalWrite((d) => d.sessions.push(sessionA)); // laptop, out of band

  await pushChanges({
    client: drive.client, fileId: 'f1', baseToken,
    pendingOps: [ops.upsertSession(sessionB)],
    // The phone's local copy has never seen sessionA.
    localData: withSession(makeData(), sessionB),
  });

  const final = drive.currentContent();
  assert.equal(final.sessions.length, 2, 'the merge reads the remote, not the stale local copy');
});

// --- T9: second conflict aborts --------------------------------------------

test('T9 — a second conflict on the retry stops rather than looping', async () => {
  const drive = fakeDrive(makeData());
  const baseToken = versionToken({ version: 1 });

  drive.externalWrite((d) => d.sessions.push(sessionA)); // first conflict

  // A third write lands while we are merging.
  drive.onBeforeRecheck(() => {
    drive.externalWrite((d) => d.sessions.push(makeSession({ date: '2026-01-09', dayType: 'C', weekInCycle: 1 })));
  });

  const result = await pushChanges({
    client: drive.client, fileId: 'f1', baseToken,
    pendingOps: [ops.upsertSession(sessionB)],
    localData: withSession(makeData(), sessionB),
  });

  assert.equal(result.outcome, OUTCOME.CONFLICT_UNRESOLVED);
  assert.equal(drive.calls.upload, 0, 'nothing written — no silent pick');
  assert.ok(result.remote, 'the Drive version is handed back for display');
  assert.ok(result.localData, 'alongside the local version');
  assert.equal(result.pendingOps.length, 1, 'the queue is preserved for a retry');
  assert.ok(drive.calls.getMeta <= 3, 'exactly one merge attempt, then stop');
});

test('T9 — the user can resolve by retrying the merge', async () => {
  const drive = fakeDrive(withSession(makeData(), sessionA));
  const result = await resolveConflict({
    client: drive.client, fileId: 'f1', choice: 'retry-merge',
    remote: drive.currentContent(),
    localData: withSession(makeData(), sessionB),
    pendingOps: [ops.upsertSession(sessionB)],
  });

  assert.equal(result.outcome, OUTCOME.SYNCED);
  assert.equal(drive.currentContent().sessions.length, 2, 'both survive');
});

test('T9 — or by keeping the Drive copy and discarding the local queue', async () => {
  const drive = fakeDrive(withSession(makeData(), sessionA));
  const before = drive.currentVersion();

  const result = await resolveConflict({
    client: drive.client, fileId: 'f1', choice: 'keep-remote',
    remote: drive.currentContent(),
    localData: withSession(makeData(), sessionB),
    pendingOps: [ops.upsertSession(sessionB)],
  });

  assert.equal(result.outcome, OUTCOME.SYNCED);
  assert.equal(result.discarded.length, 1, 'the discarded work is named, not silently dropped');
  assert.equal(drive.currentVersion(), before, 'nothing written');
});

// --- T5: auth expiry --------------------------------------------------------

test('T5 — a 401 mid-save preserves the queue and asks for sign-in', async () => {
  const client = {
    async getMeta() { const e = new Error('Invalid Credentials'); e.status = 401; throw e; },
    async getContent() { throw new Error('should not reach'); },
    async upload() { throw new Error('should not reach'); },
  };

  const result = await pushChanges({
    client, fileId: 'f1', baseToken: '1',
    pendingOps: [ops.upsertSession(sessionA)],
    localData: withSession(makeData(), sessionA),
  });

  assert.equal(result.outcome, OUTCOME.AUTH_REQUIRED);
  assert.equal(result.pendingOps.length, 1, 'in-progress work is not lost by a token expiry');
});

// --- T30 / T31: offline -----------------------------------------------------

test('T30 — saving offline queues without error', async () => {
  const drive = fakeDrive(makeData());
  const result = await pushChanges({
    client: drive.client, fileId: 'f1', baseToken: '1',
    pendingOps: [ops.upsertSession(sessionA)],
    localData: withSession(makeData(), sessionA),
    isOnline: false,
  });

  assert.equal(result.outcome, OUTCOME.OFFLINE);
  assert.equal(drive.calls.getMeta, 0, 'no network attempted');
  assert.equal(result.pendingOps.length, 1);
});

test('T30 — a network failure mid-request is treated as offline, not an error', async () => {
  const client = {
    async getMeta() { throw new TypeError('Failed to fetch'); },
    async getContent() {}, async upload() {},
  };
  const result = await pushChanges({
    client, fileId: 'f1', baseToken: '1',
    pendingOps: [ops.upsertSession(sessionA)],
    localData: makeData(),
  });
  assert.equal(result.outcome, OUTCOME.OFFLINE);
});

test('T31 — the queued save completes once connectivity returns', async () => {
  const drive = fakeDrive(makeData());
  const store = createStore(memoryStorage());
  const baseToken = versionToken({ version: drive.currentVersion() });

  // Offline: op is queued and stays queued.
  store.enqueue(ops.upsertSession(sessionA));
  const offline = await pushChanges({
    client: drive.client, fileId: 'f1', baseToken,
    pendingOps: store.getPending(),
    localData: withSession(makeData(), sessionA),
    isOnline: false,
  });
  assert.equal(offline.outcome, OUTCOME.OFFLINE);
  assert.equal(store.hasUnsynced(), true, 'the "not yet synced" indicator stays on');

  // Back online: the same queue flushes.
  const online = await pushChanges({
    client: drive.client, fileId: 'f1', baseToken,
    pendingOps: store.getPending(),
    localData: withSession(makeData(), sessionA),
    isOnline: true,
  });
  assert.equal(online.outcome, OUTCOME.SYNCED);

  store.removePending([ops.upsertSession(sessionA)]);
  assert.equal(store.hasUnsynced(), false, 'indicator clears only after Drive confirms');
  assert.equal(drive.currentContent().sessions.length, 1);
});

// --- T10: crash mid-save ----------------------------------------------------

test('T10 — a crash after tapping Save leaves the session queued, not lost', async () => {
  const storage = memoryStorage();
  const store = createStore(storage);

  // Save is tapped: the op hits the queue BEFORE the network call.
  store.enqueue(ops.upsertSession(sessionA));

  const client = {
    async getMeta() { throw new Error('simulated crash — browser killed'); },
    async getContent() {}, async upload() {},
  };
  await pushChanges({
    client, fileId: 'f1', baseToken: '1',
    pendingOps: store.getPending(),
    localData: withSession(makeData(), sessionA),
  }).catch(() => {});

  // Next open: a store built over the same storage still holds the work.
  const reopened = createStore(storage);
  assert.equal(reopened.hasUnsynced(), true, 'session shows as unsaved on next open');
  assert.equal(reopened.getPending()[0].key, sessionKey(sessionA));
});

test('T10 — replaying the queue after a crash does not double-count', async () => {
  const drive = fakeDrive(makeData());
  const store = createStore(memoryStorage());
  const baseToken = versionToken({ version: drive.currentVersion() });

  store.enqueue(ops.upsertSession(sessionA));
  store.enqueue(ops.upsertSession(sessionA)); // user tapped Save twice
  assert.equal(store.getPending().length, 1, 'the queue dedupes by key');

  await pushChanges({
    client: drive.client, fileId: 'f1', baseToken,
    pendingOps: store.getPending(), localData: withSession(makeData(), sessionA),
  });
  // And a replay of the same op against the now-updated file.
  await pushChanges({
    client: drive.client, fileId: 'f1', baseToken: String(drive.currentVersion()),
    pendingOps: store.getPending(), localData: drive.currentContent(),
  });

  assert.equal(drive.currentContent().sessions.length, 1, 'exactly one session, not two');
});

// --- T29: offline viewing ---------------------------------------------------

test('T29 — the last-synced snapshot is readable with no connection', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  const data = withSession(makeData(), sessionA);

  store.setSnapshot(data, '4');

  const afterReload = createStore(storage);
  assert.equal(afterReload.getSnapshot().sessions.length, 1, 'yesterday\'s data still viewable');
  assert.equal(afterReload.getToken(), '4');
});

test('a corrupt local snapshot does not brick the app on open', () => {
  const storage = memoryStorage({ 'kbwt.snapshot': '{not valid json' });
  const store = createStore(storage);
  assert.isNull(store.getSnapshot(), 'falls back to null rather than throwing');
});

// --- store housekeeping -----------------------------------------------------

test('the warm-up checklist is local-only and clears between sessions', () => {
  const store = createStore(memoryStorage());
  store.setWarmup(['chin-tucks', 'glute-bridge']);
  assert.deepEqual(store.getWarmup(), ['chin-tucks', 'glute-bridge']);

  store.clearWarmup();
  assert.deepEqual(store.getWarmup(), [], 'T19 — ticks persist for the session, not into history');
});

test('removePending keeps ops queued after the write started', () => {
  const store = createStore(memoryStorage());
  store.enqueue(ops.upsertSession(sessionA));
  const inFlight = store.getPending();

  store.enqueue(ops.upsertSession(sessionB)); // logged while the save was running
  store.removePending(inFlight);

  assert.equal(store.getPending().length, 1);
  assert.equal(store.getPending()[0].key, sessionKey(sessionB), 'the newer op survives');
});

test('schema version travels with the file', () => {
  assert.equal(emptyData().schemaVersion, 2);
});
