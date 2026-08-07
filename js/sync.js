/**
 * The save flow (PRD 3.2) — read-check-write with exactly one merge retry.
 *
 * This module holds no backend-specific code. It talks to a `client`
 * interface:
 *
 *   getMeta(fileId)    -> { version, modifiedTime }
 *   getContent(fileId) -> parsed JSON
 *   upload(fileId, d)  -> { version, modifiedTime }
 *
 * github.js supplies the real one (backed by a Gist); the tests supply a
 * fake. That split is what makes T8 (two devices merge), T9 (second conflict
 * aborts) and T10 (crash mid-save) testable without staging them on two
 * physical devices — and it's also what let the storage backend itself move
 * from Google Drive to GitHub Gists without a single line changing here.
 */

import { merge } from './merge.js';
import { migrate } from './schema.js';

export const OUTCOME = {
  SYNCED: 'synced',
  OFFLINE: 'offline',
  AUTH_REQUIRED: 'auth-required',
  CONFLICT_UNRESOLVED: 'conflict-unresolved',
  SCHEMA_TOO_NEW: 'schema-too-new',
  ERROR: 'error',
};

/**
 * A content-addressed or monotonically increasing `version` (a Gist revision
 * SHA, for the current backend) is a sounder change token than comparing
 * `modifiedTime` strings — no clock skew, no second-level truncation.
 * modifiedTime is kept only as a fallback for a response that omits version.
 */
export function versionToken(meta) {
  if (!meta) return null;
  return meta.version != null ? String(meta.version) : meta.modifiedTime || null;
}

function unchanged(meta, token) {
  return versionToken(meta) === token;
}

/**
 * Push queued changes to the remote store.
 *
 * `baseToken` is the version captured when the local snapshot was loaded —
 * i.e. what this device believes the file looked like when the session began.
 */
export async function pushChanges({
  client,
  fileId,
  baseToken,
  pendingOps,
  localData,
  isOnline = true,
}) {
  if (!pendingOps.length) {
    return { outcome: OUTCOME.SYNCED, data: localData, token: baseToken, merged: false, notes: [] };
  }

  // Offline is not a failure — the queue simply stays put and the UI shows
  // "not yet synced" until connectivity returns (T30).
  if (!isOnline) {
    return { outcome: OUTCOME.OFFLINE, pendingOps };
  }

  try {
    const meta = await client.getMeta(fileId);

    // --- Fast path: nobody else has written since we loaded. ---------------
    if (unchanged(meta, baseToken)) {
      const uploaded = await client.upload(fileId, localData);
      return {
        outcome: OUTCOME.SYNCED,
        data: localData,
        token: versionToken(uploaded),
        merged: false,
        notes: [],
      };
    }

    // --- Conflict path: re-fetch, merge, write. Once. ----------------------
    const conflictToken = versionToken(meta);
    const rawRemote = await client.getContent(fileId);

    let remote;
    try {
      remote = migrate(rawRemote).data;
    } catch (err) {
      if (err.name === 'SchemaTooNewError') {
        return { outcome: OUTCOME.SCHEMA_TOO_NEW, error: err, pendingOps };
      }
      throw err;
    }

    const { data, notes } = merge(remote, pendingOps);

    // Check again immediately before writing. If a third write landed while we
    // were merging, stop — do not loop. Hand both versions to the user (T9).
    const recheck = await client.getMeta(fileId);
    if (!unchanged(recheck, conflictToken)) {
      return {
        outcome: OUTCOME.CONFLICT_UNRESOLVED,
        remote,
        localData,
        pendingOps,
        notes,
        token: versionToken(recheck),
      };
    }

    const uploaded = await client.upload(fileId, data);
    return {
      outcome: OUTCOME.SYNCED,
      data,
      token: versionToken(uploaded),
      merged: true,
      notes,
    };
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      // Session expired mid-use. The queue is untouched, so nothing in
      // progress is lost when the user signs back in (T5).
      return { outcome: OUTCOME.AUTH_REQUIRED, error: err, pendingOps };
    }
    if (isNetworkError(err)) {
      return { outcome: OUTCOME.OFFLINE, error: err, pendingOps };
    }
    return { outcome: OUTCOME.ERROR, error: err, pendingOps };
  }
}

function isNetworkError(err) {
  return (
    err instanceof TypeError ||
    err.name === 'NetworkError' ||
    /network|fetch|offline/i.test(err.message || '')
  );
}

/**
 * Resolution choices offered when a second conflict aborts the retry (T9).
 * There is deliberately no automatic pick: the user is shown both and chooses.
 */
export async function resolveConflict({ client, fileId, choice, remote, localData, pendingOps }) {
  const fresh = await client.getMeta(fileId);

  if (choice === 'keep-remote') {
    // Discard the local queue; the remote copy stands.
    return { outcome: OUTCOME.SYNCED, data: remote, token: versionToken(fresh), discarded: pendingOps };
  }

  if (choice === 'retry-merge') {
    const latest = migrate(await client.getContent(fileId)).data;
    const { data, notes } = merge(latest, pendingOps);
    const uploaded = await client.upload(fileId, data);
    return { outcome: OUTCOME.SYNCED, data, token: versionToken(uploaded), merged: true, notes };
  }

  if (choice === 'force-local') {
    const uploaded = await client.upload(fileId, localData);
    return { outcome: OUTCOME.SYNCED, data: localData, token: versionToken(uploaded), forced: true };
  }

  throw new Error(`Unknown conflict resolution: ${choice}`);
}
