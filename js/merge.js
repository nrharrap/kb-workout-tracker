/**
 * Conflict-free merge of local changes into a remote snapshot (PRD 3.2).
 *
 * Everything here is pure: `merge(remote, ops)` has no I/O and no clock reads.
 * That is the point — the two-device conflict cases (T8, T9, T11) are the
 * hardest thing in this app to test by hand, and keeping the merge pure means
 * they can be tested headlessly without touching Drive at all.
 *
 * The unit of merge is the entity, not the file. Local changes are captured as
 * operations; merging replays those operations onto whatever the remote file
 * currently says. Because sessions are additive and keyed by
 * cycle:date:dayType, replaying is unambiguous in the normal case.
 */

/** Stable key for a session — the merge identity from PRD 3.2. */
export function sessionKey(session) {
  return `${session.cycleNumber}:${session.date}:${session.dayType}`;
}

export function skipKey(skip) {
  return `${skip.cycleNumber}:${skip.slotIndex}`;
}

// --- Operation constructors -------------------------------------------------

export const ops = {
  upsertSession: (session) => ({ type: 'upsertSession', key: sessionKey(session), session }),
  deleteSession: (key, deletedAt) => ({ type: 'deleteSession', key, deletedAt }),
  addSkip: (skip) => ({ type: 'addSkip', key: skipKey(skip), skip }),
  upsertRetest: (retest) => ({ type: 'upsertRetest', key: String(retest.cycleNumber), retest }),
  startCycle: (cycle) => ({ type: 'startCycle', key: String(cycle.cycleNumber), cycle }),
  endCycle: (cycleNumber, endedAt) => ({ type: 'endCycle', key: String(cycleNumber), cycleNumber, endedAt }),
  setLoadOverride: (cycleNumber, overrideKey, valueKg) => ({
    type: 'setLoadOverride',
    key: `${cycleNumber}:${overrideKey}`,
    cycleNumber,
    overrideKey,
    valueKg,
  }),
};

// --- Merge ------------------------------------------------------------------

/**
 * Replay `pendingOps` onto `remote`.
 *
 * Returns `{ data, notes }`. `notes` records anything that needed a judgment
 * call — a same-key collision where one version had to lose, or an op dropped
 * because the entity was deleted elsewhere. The UI surfaces notes rather than
 * resolving them silently: the losing version is carried in the note, so a
 * collision is always visible and never a silent data loss.
 */
export function merge(remote, pendingOps) {
  const data = cloneData(remote);
  const notes = [];

  for (const op of pendingOps) {
    switch (op.type) {
      case 'upsertSession':
        applyUpsertSession(data, op, notes);
        break;
      case 'deleteSession':
        applyDeleteSession(data, op);
        break;
      case 'addSkip':
        applyAddSkip(data, op);
        break;
      case 'upsertRetest':
        applyUpsertRetest(data, op, notes);
        break;
      case 'startCycle':
        applyStartCycle(data, op, notes);
        break;
      case 'endCycle':
        applyEndCycle(data, op);
        break;
      case 'setLoadOverride':
        applySetLoadOverride(data, op);
        break;
      default:
        notes.push({ kind: 'unknown-op', op });
    }
  }

  return { data: normalise(data), notes };
}

function applyUpsertSession(data, op, notes) {
  const tombstone = data.deleted.find((t) => t.key === op.key);
  const incomingAt = op.session.updatedAt || op.session.loggedAt;

  // Deleted on another device after this edit was made: the delete stands.
  if (tombstone && tombstone.deletedAt > incomingAt) {
    notes.push({ kind: 'upsert-after-delete', key: op.key, dropped: op.session });
    return;
  }
  if (tombstone) {
    data.deleted = data.deleted.filter((t) => t.key !== op.key);
  }

  const idx = data.sessions.findIndex((s) => sessionKey(s) === op.key);
  if (idx === -1) {
    data.sessions.push(op.session);
    return;
  }

  // Same session logged or edited on both devices. Last write wins, but the
  // losing version travels in the note so it is never silently discarded.
  const existing = data.sessions[idx];
  const existingAt = existing.updatedAt || existing.loggedAt;
  if (existingAt > incomingAt) {
    notes.push({ kind: 'session-collision', key: op.key, kept: existing, discarded: op.session });
  } else {
    notes.push({ kind: 'session-collision', key: op.key, kept: op.session, discarded: existing });
    data.sessions[idx] = op.session;
  }
}

function applyDeleteSession(data, op) {
  data.sessions = data.sessions.filter((s) => sessionKey(s) !== op.key);
  if (!data.deleted.some((t) => t.key === op.key)) {
    // The tombstone is what stops a stale remote copy resurrecting the entry
    // on the next merge (T11).
    data.deleted.push({ key: op.key, deletedAt: op.deletedAt });
  }
}

function applyAddSkip(data, op) {
  if (data.skips.some((s) => skipKey(s) === op.key)) return; // idempotent
  data.skips.push(op.skip);
}

function applyUpsertRetest(data, op, notes) {
  const idx = data.retests.findIndex((r) => String(r.cycleNumber) === op.key);
  if (idx === -1) {
    data.retests.push(op.retest);
    return;
  }
  const existing = data.retests[idx];
  if ((existing.updatedAt || '') > (op.retest.updatedAt || '')) {
    notes.push({ kind: 'retest-collision', key: op.key, kept: existing, discarded: op.retest });
  } else {
    data.retests[idx] = op.retest;
  }
}

function applyStartCycle(data, op, notes) {
  const existing = data.cycles.find((cy) => cy.cycleNumber === op.cycle.cycleNumber);
  if (existing) {
    // Both devices started the same cycle. Harmless — same number, and the
    // earlier start date is the honest one.
    if (op.cycle.startDate < existing.startDate) existing.startDate = op.cycle.startDate;
    notes.push({ kind: 'duplicate-cycle-start', key: op.key });
    return;
  }
  data.cycles.push(op.cycle);
}

function applyEndCycle(data, op) {
  const cycle = data.cycles.find((cy) => cy.cycleNumber === op.cycleNumber);
  if (cycle && !cycle.endedAt) cycle.endedAt = op.endedAt;
}

function applySetLoadOverride(data, op) {
  const cycle = data.cycles.find((cy) => cy.cycleNumber === op.cycleNumber);
  if (!cycle) return;
  cycle.loadOverrides = cycle.loadOverrides || {};
  if (op.valueKg == null) delete cycle.loadOverrides[op.overrideKey];
  else cycle.loadOverrides[op.overrideKey] = op.valueKg;
}

// --- Helpers ----------------------------------------------------------------

function cloneData(d) {
  return {
    ...structuredCloneCompat(d),
    cycles: structuredCloneCompat(d.cycles || []),
    sessions: structuredCloneCompat(d.sessions || []),
    skips: structuredCloneCompat(d.skips || []),
    retests: structuredCloneCompat(d.retests || []),
    deleted: structuredCloneCompat(d.deleted || []),
  };
}

function structuredCloneCompat(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Canonical ordering. Two devices that merge the same facts in a different
 * order must produce byte-identical JSON, otherwise every save looks like a
 * change and conflict detection gets noisy.
 */
export function normalise(data) {
  data.cycles.sort((a, b) => a.cycleNumber - b.cycleNumber);
  data.sessions.sort((a, b) => cmp(sessionKey(a), sessionKey(b)));
  data.skips.sort((a, b) => cmp(skipKey(a), skipKey(b)));
  data.retests.sort((a, b) => a.cycleNumber - b.cycleNumber);
  data.deleted.sort((a, b) => cmp(a.key, b.key));
  return data;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A compact human-readable description of what a set of ops would add,
 * used by the manual-resolution UI when a second conflict aborts the retry.
 */
export function describeOps(pendingOps) {
  return pendingOps.map((op) => {
    switch (op.type) {
      case 'upsertSession':
        return `Session — Day ${op.session.dayType}, ${op.session.date} (cycle ${op.session.cycleNumber}, week ${op.session.weekInCycle})`;
      case 'deleteSession':
        return `Delete session — ${op.key}`;
      case 'addSkip':
        return `Skipped session — Day ${op.skip.dayType}, week ${op.skip.weekInCycle}`;
      case 'upsertRetest':
        return `Retest — cycle ${op.retest.cycleNumber}`;
      case 'startCycle':
        return `Start cycle ${op.cycle.cycleNumber}`;
      case 'endCycle':
        return `End cycle ${op.cycleNumber}`;
      case 'setLoadOverride':
        return `Load override — ${op.overrideKey} = ${op.valueKg}kg`;
      default:
        return `Unknown change (${op.type})`;
    }
  });
}
