/**
 * Local persistence: the last-synced snapshot, the pending-op queue, and the
 * in-progress workout draft (PRD 5, offline behaviour).
 *
 * The ordering rule that makes T10 work: an op is written to the queue BEFORE
 * the network call that would clear it. If the browser dies mid-save, the op
 * is still queued on next open, so the session shows as unsaved rather than
 * vanishing — and because ops are keyed and the merge is idempotent, replaying
 * it cannot double-count.
 *
 * `storage` is injectable so the tests can run against a fake.
 */

const KEYS = {
  snapshot: 'kbwt.snapshot',
  token: 'kbwt.token',
  fileId: 'kbwt.fileId',
  pending: 'kbwt.pending',
  draft: 'kbwt.draft',
  dismissedOn: 'kbwt.missedPromptDismissedOn',
  warmup: 'kbwt.warmup',
};

export function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

export function createStore(storage) {
  const read = (key, fallback) => {
    const raw = storage.getItem(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      // A corrupt entry must not brick the app on open.
      return fallback;
    }
  };
  const write = (key, value) => storage.setItem(key, JSON.stringify(value));

  return {
    // --- last-synced snapshot, for offline viewing (T29) -------------------
    getSnapshot: () => read(KEYS.snapshot, null),
    setSnapshot(data, token) {
      write(KEYS.snapshot, data);
      if (token != null) write(KEYS.token, token);
    },
    getToken: () => read(KEYS.token, null),
    setToken: (token) => write(KEYS.token, token),

    getFileId: () => read(KEYS.fileId, null),
    setFileId: (id) => write(KEYS.fileId, id),

    // --- pending op queue --------------------------------------------------
    getPending: () => read(KEYS.pending, []),

    /** Queue an op. Called before the network request, never after. */
    enqueue(op) {
      const queue = read(KEYS.pending, []);
      // Replacing by key keeps a re-saved session from queueing twice.
      const idx = queue.findIndex((o) => o.type === op.type && o.key === op.key);
      if (idx === -1) queue.push(op);
      else queue[idx] = op;
      write(KEYS.pending, queue);
      return queue;
    },

    clearPending() {
      write(KEYS.pending, []);
    },

    /** Drop only the ops that were actually written, keeping anything newer. */
    removePending(opsWritten) {
      const written = new Set(opsWritten.map((o) => `${o.type}|${o.key}`));
      write(
        KEYS.pending,
        read(KEYS.pending, []).filter((o) => !written.has(`${o.type}|${o.key}`))
      );
    },

    hasUnsynced: () => read(KEYS.pending, []).length > 0,

    // --- in-progress workout ----------------------------------------------
    getDraft: () => read(KEYS.draft, null),
    setDraft: (draft) => write(KEYS.draft, draft),
    clearDraft: () => storage.removeItem(KEYS.draft),

    // --- ephemeral UI state, deliberately local-only -----------------------
    // The warm-up checklist is per-session state, not logged history (PRD 4.2).
    getWarmup: () => read(KEYS.warmup, []),
    setWarmup: (items) => write(KEYS.warmup, items),
    clearWarmup: () => storage.removeItem(KEYS.warmup),

    getDismissedOn: () => read(KEYS.dismissedOn, null),
    setDismissedOn: (date) => write(KEYS.dismissedOn, date),

    clearAll() {
      for (const key of Object.values(KEYS)) storage.removeItem(key);
    },
  };
}
