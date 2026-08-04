/**
 * data.json shape and migrations (PRD 4.1, schema versioning).
 *
 * The programme structure has already changed twice during design, so old
 * files must migrate rather than break. `migrate()` runs a chain — v1 -> v2 ->
 * ... — so a file can be several versions behind and still open cleanly.
 */

import { normalise } from './merge.js';

export const CURRENT_SCHEMA_VERSION = 2;

export const DATA_FILE_NAME = 'kb-workout-tracker-data.json';

export function emptyData(now = new Date().toISOString()) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: now,
    cycles: [],
    sessions: [],
    skips: [],
    retests: [],
    deleted: [],
  };
}

/**
 * v1 was the pre-cycle shape: a flat session list with no cycle concept, no
 * explicit skip records and no delete tombstones. Everything logged then
 * belongs to cycle 1 by definition.
 */
const MIGRATIONS = {
  1: (data) => {
    const sessions = (data.sessions || []).map((s) => ({
      ...s,
      cycleNumber: s.cycleNumber ?? 1,
      weekInCycle: s.weekInCycle ?? s.week ?? 1,
      updatedAt: s.updatedAt || s.loggedAt || data.createdAt,
    }));

    const firstDate = sessions.length
      ? sessions.map((s) => s.date).sort()[0]
      : (data.createdAt || new Date().toISOString()).slice(0, 10);

    const cycles = (data.cycles || []).length
      ? data.cycles
      : [{ cycleNumber: 1, startDate: data.startDate || firstDate, endedAt: null, loadOverrides: {} }];

    return {
      ...data,
      schemaVersion: 2,
      cycles,
      sessions,
      skips: data.skips || [],
      retests: (data.retests || []).map((r) => ({
        cycleNumber: r.cycleNumber ?? 1,
        date: r.date,
        metrics: r.metrics || stripToMetrics(r),
        updatedAt: r.updatedAt || r.date,
      })),
      deleted: data.deleted || [],
    };
  },
};

function stripToMetrics(r) {
  // v1 stored retest values as loose top-level keys.
  const { cycleNumber, date, updatedAt, ...rest } = r;
  return rest;
}

/**
 * Bring `data` up to the current schema version.
 * Returns `{ data, migrated, from }` so the UI can note that a migration ran.
 */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') {
    return { data: emptyData(), migrated: false, from: null };
  }

  let version = Number(raw.schemaVersion) || 1;
  const from = version;
  let data = raw;

  if (version > CURRENT_SCHEMA_VERSION) {
    // A newer device wrote this file. Refusing is safer than guessing at a
    // shape we do not know — the caller surfaces this rather than overwriting.
    throw new SchemaTooNewError(version, CURRENT_SCHEMA_VERSION);
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`No migration path from schemaVersion ${version}`);
    data = step(data);
    version = Number(data.schemaVersion);
  }

  return { data: normalise(ensureArrays(data)), migrated: from !== version, from };
}

function ensureArrays(data) {
  for (const key of ['cycles', 'sessions', 'skips', 'retests', 'deleted']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  data.schemaVersion = CURRENT_SCHEMA_VERSION;
  return data;
}

export class SchemaTooNewError extends Error {
  constructor(found, supported) {
    super(
      `This file was written by a newer version of the app (schema ${found}, this app supports ${supported}). Reload the page to pick up the latest version before logging anything else.`
    );
    this.name = 'SchemaTooNewError';
    this.found = found;
    this.supported = supported;
  }
}
