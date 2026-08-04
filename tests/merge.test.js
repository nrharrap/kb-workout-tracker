/**
 * Merge and schema migration — T8, T9, T11, T15.
 *
 * These are the cases that are near-impossible to stage by hand on two real
 * devices, which is exactly why the merge is a pure function.
 */

import { test, assert } from './harness.js';
import { makeData, makeSession, withSets } from './helpers.js';
import { merge, ops, sessionKey, normalise, describeOps } from '../js/merge.js';
import { migrate, emptyData, CURRENT_SCHEMA_VERSION, SchemaTooNewError } from '../js/schema.js';
import { deriveState } from '../js/model.js';

const laptopSession = makeSession({
  date: '2026-01-05', dayType: 'A', weekInCycle: 1,
  exercises: [withSets('kb-swing-2h', [{ kg: 16, reps: 12, rpe: 7 }])],
  loggedAt: '2026-01-05T18:00:00.000Z',
});

const phoneSession = makeSession({
  date: '2026-01-07', dayType: 'B', weekInCycle: 1,
  exercises: [withSets('goblet-squat-rotation', [{ kg: 12, reps: 8, rpe: 6 }])],
  loggedAt: '2026-01-07T19:00:00.000Z',
});

// --- T8: additive merge -----------------------------------------------------

test('T8 — two devices logging different sessions both survive the merge', () => {
  // Laptop saved first, so the remote file already has its session.
  const remote = makeData();
  remote.sessions.push(laptopSession);

  // The phone loaded before that write and now saves its own session.
  const { data, notes } = merge(remote, [ops.upsertSession(phoneSession)]);

  assert.equal(data.sessions.length, 2, 'neither overwrites the other');
  assert.deepEqual(data.sessions.map((s) => s.dayType), ['A', 'B']);
  assert.equal(notes.length, 0, 'different keys — no judgment call needed');
});

test('T8 — merge order does not change the result', () => {
  const base = makeData();
  const a = merge(merge(base, [ops.upsertSession(laptopSession)]).data, [ops.upsertSession(phoneSession)]).data;
  const b = merge(merge(base, [ops.upsertSession(phoneSession)]).data, [ops.upsertSession(laptopSession)]).data;
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'canonical ordering keeps saves byte-identical');
});

test('T8 — the merged file derives the same state either device computes', () => {
  const remote = makeData();
  remote.sessions.push(laptopSession);
  const { data } = merge(remote, [ops.upsertSession(phoneSession)]);

  const state = deriveState(data, '2026-01-09');
  assert.equal(state.completedSessions, 2);
  assert.equal(state.dayType, 'C', 'two slots consumed, next is C');
});

test('re-applying the same op is idempotent', () => {
  const remote = makeData();
  const once = merge(remote, [ops.upsertSession(laptopSession)]).data;
  const twice = merge(once, [ops.upsertSession(laptopSession)]).data;
  assert.equal(twice.sessions.length, 1, 'a retried save must not duplicate the session');
});

test('a skip recorded on both devices lands once', () => {
  const skip = { cycleNumber: 1, slotIndex: 1, dayType: 'B', weekInCycle: 1, markedAt: '2026-01-10T09:00:00.000Z' };
  const remote = makeData();
  remote.skips.push(skip);
  const { data } = merge(remote, [ops.addSkip(skip)]);
  assert.equal(data.skips.length, 1);
});

// --- same-key collision -----------------------------------------------------

test('the same session logged on both devices keeps the later one and reports it', () => {
  const early = { ...laptopSession, updatedAt: '2026-01-05T18:00:00.000Z' };
  const late = {
    ...laptopSession,
    updatedAt: '2026-01-05T20:00:00.000Z',
    exercises: [withSets('kb-swing-2h', [{ kg: 20, reps: 12, rpe: 8 }])],
  };

  const remote = makeData();
  remote.sessions.push(early);
  const { data, notes } = merge(remote, [ops.upsertSession(late)]);

  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].exercises[0].sets[0].kg, 20, 'later write wins');

  const note = notes.find((n) => n.kind === 'session-collision');
  assert.ok(note, 'the collision is surfaced, not silent');
  assert.equal(note.discarded.exercises[0].sets[0].kg, 16, 'the losing version travels with the note');
});

test('an older write does not clobber a newer one already in the file', () => {
  const late = { ...laptopSession, updatedAt: '2026-01-05T20:00:00.000Z', exercises: [withSets('kb-swing-2h', [{ kg: 20, reps: 12 }])] };
  const early = { ...laptopSession, updatedAt: '2026-01-05T18:00:00.000Z', exercises: [withSets('kb-swing-2h', [{ kg: 16, reps: 12 }])] };

  const remote = makeData();
  remote.sessions.push(late);
  const { data } = merge(remote, [ops.upsertSession(early)]);
  assert.equal(data.sessions[0].exercises[0].sets[0].kg, 20, 'newer remote survives a stale local write');
});

// --- T11: edit and delete ---------------------------------------------------

test('T11 — editing a past entry goes through the same merge path', () => {
  const remote = makeData();
  remote.sessions.push(laptopSession);

  const edited = { ...laptopSession, updatedAt: '2026-01-08T09:00:00.000Z', exercises: [withSets('kb-swing-2h', [{ kg: 16, reps: 15, rpe: 8 }])] };
  const { data } = merge(remote, [ops.upsertSession(edited)]);

  assert.equal(data.sessions.length, 1, 'an edit updates in place, it does not append');
  assert.equal(data.sessions[0].exercises[0].sets[0].reps, 15);
});

test('T11 — a deleted entry is not resurrected by a stale remote copy', () => {
  const key = sessionKey(laptopSession);

  // Phone deletes the session and saves.
  const remoteAfterDelete = merge(
    (() => { const d = makeData(); d.sessions.push(laptopSession); return d; })(),
    [ops.deleteSession(key, '2026-01-09T09:00:00.000Z')]
  ).data;

  assert.equal(remoteAfterDelete.sessions.length, 0);
  assert.equal(remoteAfterDelete.deleted.length, 1, 'a tombstone is left behind');

  // The laptop, holding a stale copy, now saves an unrelated session. Without
  // the tombstone its stale copy of the deleted entry would come back.
  const { data, notes } = merge(remoteAfterDelete, [
    ops.upsertSession(laptopSession), // stale: updatedAt predates the delete
    ops.upsertSession(phoneSession),
  ]);

  assert.equal(data.sessions.length, 1, 'only the genuinely new session lands');
  assert.equal(data.sessions[0].dayType, 'B');
  assert.ok(notes.find((n) => n.kind === 'upsert-after-delete'), 'the dropped write is reported');
});

test('T11 — a genuine re-log after a delete is allowed through', () => {
  const key = sessionKey(laptopSession);
  const remote = merge(
    (() => { const d = makeData(); d.sessions.push(laptopSession); return d; })(),
    [ops.deleteSession(key, '2026-01-09T09:00:00.000Z')]
  ).data;

  const relogged = { ...laptopSession, updatedAt: '2026-01-10T09:00:00.000Z' };
  const { data } = merge(remote, [ops.upsertSession(relogged)]);

  assert.equal(data.sessions.length, 1, 'deliberately logging it again after the delete works');
  assert.equal(data.deleted.length, 0, 'and the tombstone is cleared');
});

// --- cycles and overrides ---------------------------------------------------

test('both devices starting the same cycle does not create two cycles', () => {
  const remote = makeData();
  const { data, notes } = merge(remote, [
    ops.startCycle({ cycleNumber: 1, startDate: '2026-01-03', endedAt: null, loadOverrides: {} }),
  ]);
  assert.equal(data.cycles.length, 1);
  assert.equal(data.cycles[0].startDate, '2026-01-03', 'the earlier start date is the honest one');
  assert.ok(notes.find((n) => n.kind === 'duplicate-cycle-start'));
});

test('load overrides merge into the right cycle and can be cleared', () => {
  const remote = makeData();
  const { data } = merge(remote, [ops.setLoadOverride(1, 'A:kb-swing-2h', 20)]);
  assert.equal(data.cycles[0].loadOverrides['A:kb-swing-2h'], 20);

  const cleared = merge(data, [ops.setLoadOverride(1, 'A:kb-swing-2h', null)]).data;
  assert.equal('A:kb-swing-2h' in cleared.cycles[0].loadOverrides, false);
});

test('the merge does not mutate the snapshot it was given', () => {
  const remote = makeData();
  remote.sessions.push(laptopSession);
  const snapshot = JSON.stringify(remote);
  merge(remote, [ops.upsertSession(phoneSession), ops.deleteSession(sessionKey(laptopSession), '2026-02-01T00:00:00.000Z')]);
  assert.equal(JSON.stringify(remote), snapshot, 'callers rely on the original for conflict display');
});

// --- T9: describing an aborted merge ---------------------------------------

test('T9 — pending changes render as readable lines for manual resolution', () => {
  const lines = describeOps([
    ops.upsertSession(phoneSession),
    ops.addSkip({ cycleNumber: 1, slotIndex: 1, dayType: 'B', weekInCycle: 1, markedAt: 'x' }),
    ops.upsertRetest({ cycleNumber: 1, date: '2026-04-05', metrics: {}, updatedAt: 'x' }),
  ]);

  assert.equal(lines.length, 3);
  assert.equal(lines[0].includes('Day B'), true);
  assert.equal(lines[0].includes('2026-01-07'), true);
  assert.equal(lines[2].includes('cycle 1'), true);
});

// --- T15: schema migration --------------------------------------------------

test('T15 — a v1 file migrates without data loss', () => {
  const v1 = {
    schemaVersion: 1,
    createdAt: '2025-11-01T09:00:00.000Z',
    startDate: '2025-11-03',
    sessions: [
      { date: '2025-11-03', dayType: 'A', week: 1, exercises: [withSets('kb-swing-2h', [{ kg: 16, reps: 12 }])], loggedAt: '2025-11-03T18:00:00.000Z' },
      { date: '2025-11-05', dayType: 'B', week: 1, exercises: [], loggedAt: '2025-11-05T18:00:00.000Z' },
    ],
    retests: [{ date: '2026-01-30', kbSwing60s: 38, plankHold: 55 }],
  };

  const { data, migrated, from } = migrate(v1);

  assert.equal(migrated, true);
  assert.equal(from, 1);
  assert.equal(data.schemaVersion, CURRENT_SCHEMA_VERSION);

  assert.equal(data.sessions.length, 2, 'no sessions lost');
  assert.equal(data.sessions[0].cycleNumber, 1, 'pre-cycle data belongs to cycle 1');
  assert.equal(data.sessions[0].weekInCycle, 1, 'the old `week` field is carried across');
  assert.equal(data.sessions[0].exercises[0].sets[0].kg, 16, 'logged values intact');

  assert.equal(data.cycles.length, 1, 'a cycle record is synthesised');
  assert.equal(data.cycles[0].startDate, '2025-11-03');

  assert.equal(data.retests[0].cycleNumber, 1);
  assert.equal(data.retests[0].metrics.kbSwing60s, 38, 'loose v1 retest keys move under `metrics`');

  assert.deepEqual(data.skips, []);
  assert.deepEqual(data.deleted, []);
});

test('T15 — the migrated file derives sane state', () => {
  const { data } = migrate({
    schemaVersion: 1,
    createdAt: '2025-11-01T09:00:00.000Z',
    startDate: '2025-11-03',
    sessions: [{ date: '2025-11-03', dayType: 'A', week: 1, exercises: [], loggedAt: '2025-11-03T18:00:00.000Z' }],
  });

  const state = deriveState(data, '2025-11-05');
  assert.equal(state.started, true);
  assert.equal(state.cycleNumber, 1);
  assert.equal(state.dayType, 'B');
});

test('a current-version file passes through untouched', () => {
  const current = emptyData('2026-01-01T00:00:00.000Z');
  const { data, migrated } = migrate(current);
  assert.equal(migrated, false);
  assert.equal(data.schemaVersion, CURRENT_SCHEMA_VERSION);
});

test('a file from a newer app version is refused rather than guessed at', () => {
  assert.throws(() => migrate({ schemaVersion: 99, sessions: [] }));
  try {
    migrate({ schemaVersion: 99, sessions: [] });
  } catch (err) {
    assert.equal(err instanceof SchemaTooNewError, true);
    assert.equal(err.found, 99);
  }
});

test('missing or malformed input yields an empty file rather than throwing', () => {
  assert.equal(migrate(null).data.schemaVersion, CURRENT_SCHEMA_VERSION);
  const { data } = migrate({ schemaVersion: 2, sessions: 'not an array' });
  assert.deepEqual(data.sessions, []);
});

test('normalise produces a stable ordering', () => {
  const d = makeData();
  d.sessions.push(phoneSession, laptopSession);
  const sorted = normalise(d).sessions.map((s) => s.date);
  assert.deepEqual(sorted, ['2026-01-05', '2026-01-07']);
});
