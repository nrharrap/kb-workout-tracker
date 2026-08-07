/**
 * UI and orchestration.
 *
 * The rules live in model.js / merge.js / sync.js — this file renders them and
 * wires up events. Anything here that looks like a decision (which week we're
 * in, whether a save conflicts) is delegated, not re-implemented.
 */

import {
  WARMUP, RETEST_METRICS, AUTOREGULATION, PROGRESSION_RULES,
  DAY_TYPES, allExercises, findExercise, getDay,
} from './programme.js';
import {
  deriveState, prescriptionFor, missedSessionPrompt, reEntryDeloadSuggestion,
  lifetimeStats, retestComparison, toISODate, addDays, blockForWeek, scaledSets,
} from './model.js';
import { merge, ops, sessionKey, describeOps } from './merge.js';
import { migrate, emptyData } from './schema.js';
import { pushChanges, resolveConflict, OUTCOME, versionToken } from './sync.js';
import { createStore } from './store.js';
import { GitHubAuth, createGistClient } from './github.js';

const store = createStore(window.localStorage);
const auth = new GitHubAuth();
let client = null;

const app = {
  data: null,
  fileId: null,
  view: 'today',
  signedIn: false,
  syncState: 'idle',
  syncNote: null,
  draft: null,
  readOnly: false,
  showSigninForm: false,
  conflict: null,
  notes: [],
};

// State for renderToday()/renderModals()/renderHistory() (each defined much
// further down, near the section they belong to). Declared here — before
// boot() is invoked below, not near the code that reads them, despite the
// natural instinct — because a real bug shipped from getting that backwards
// once already: a `let` binding stays in its temporal dead zone until its
// own declaration line actually runs, and boot() calls render() *and*
// renderModals() synchronously, before boot()'s own first await. Two
// separate variables declared after that point (currentPrescriptionMeta,
// editing) got referenced while still in TDZ and threw — on every single
// return visit where a cycle already existed, aborting boot() before it
// ever reached loadRemote(). historyFilter isn't reachable this way today
// (app.view always starts as 'today'), but lives here too so it can't
// become the next instance of the same mistake.
let currentPrescriptionMeta = {};
let editing = null;
let historyFilter = 'kb-swing-2h';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

boot();

async function boot() {
  // Show cached data immediately — the app must be usable with no signal (T29).
  const cached = store.getSnapshot();
  if (cached) {
    try {
      app.data = migrate(cached).data;
    } catch {
      app.data = null;
    }
  }
  app.fileId = store.getFileId();
  app.draft = store.getDraft();

  // A pasted token has no renewal/expiry concept the app can check locally —
  // it's trusted until an actual API call says otherwise (a 401, handled in
  // loadRemote()/flushQueue() below), rather than validated up front on
  // every load just to find out.
  //
  // client is set in the SAME breath as app.signedIn, not after the render()
  // below — a real bug shipped here once: with client assigned only after
  // that render(), the Save button rendered enabled (app.signedIn was
  // already true) for however long loadRemote()'s network round trip took,
  // and tapping Save inside that window hit flushQueue()'s `!client` guard,
  // which queues the op and quietly gives up (setSync('idle')) with no
  // further retry and no visible error — a silent, permanently-stuck "Not
  // synced". Reported on Safari, where the window is more likely to be wide
  // enough to tap into, but the race exists on any device.
  const savedToken = store.getAuthToken();
  if (savedToken) {
    auth.restore(savedToken, store.getAuthUsername());
    app.signedIn = true;
    client = createGistClient(auth);
  }

  bindChrome();
  render();

  if (app.signedIn) {
    await loadRemote();
  }
  render();
}

function bindChrome() {
  document.getElementById('signin-form').addEventListener('submit', (e) => {
    e.preventDefault();
    connectWithToken();
  });
  document.getElementById('btn-signin-cancel').addEventListener('click', () => {
    app.showSigninForm = false;
    hide('signin-error');
    render();
  });
  document.getElementById('sync-badge').addEventListener('click', onBadgeClick);

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      app.view = tab.dataset.view;
      render();
      window.scrollTo(0, 0);
    });
  }

  window.addEventListener('online', () => { setSync('idle'); flushQueue(); });
  window.addEventListener('offline', () => setSync('offline'));

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

async function connectWithToken() {
  hide('signin-error');
  const input = document.getElementById('signin-token-input');
  const btn = document.getElementById('btn-connect');

  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const { username } = await auth.connect(input.value);
    store.setAuth(auth.token, username);
    input.value = ''; // the secret shouldn't linger in the DOM longer than it has to
    app.signedIn = true;
    app.showSigninForm = false;
    client = createGistClient(auth);
    await loadRemote();
  } catch (err) {
    show('signin-error', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
  render();
}

async function loadRemote() {
  setSync('syncing');
  try {
    if (!app.fileId) {
      const { fileId } = await client.findOrCreateFile();
      app.fileId = fileId;
      store.setFileId(fileId);
    }

    let meta, content;
    try {
      [meta, content] = await Promise.all([
        client.getMeta(app.fileId),
        client.getContent(app.fileId),
      ]);
    } catch (err) {
      if (err.status !== 404) throw err;
      // The cached fileId doesn't resolve to a real gist any more — deleted,
      // or left over from a different account/token on this device. Rather
      // than getting stuck (this used to fall through to a plain "offline"
      // label, which was actively misleading — it isn't a connectivity
      // problem at all), forget it and let findOrCreateFile() locate or
      // create a fresh one, the same as it would on a device that has never
      // connected before.
      app.fileId = null;
      store.setFileId(null);
      const { fileId } = await client.findOrCreateFile();
      app.fileId = fileId;
      store.setFileId(fileId);
      [meta, content] = await Promise.all([
        client.getMeta(app.fileId),
        client.getContent(app.fileId),
      ]);
    }

    const { data, migrated, from } = migrate(content ?? emptyData());
    app.data = data;
    store.setSnapshot(data, versionToken(meta));
    if (migrated) app.notes = [{ kind: 'migrated', from }];

    setSync('synced');
    await flushQueue(); // anything queued while offline goes now (T31)
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      app.signedIn = false;
      store.clearAuth();
      setSync('error', 'Sign in again');
    } else if (err.name === 'SchemaTooNewError') {
      setSync('error', 'Newer data version');
      app.notes = [{ kind: 'schema-too-new', message: err.message }];
    } else {
      setSync('offline', 'Could not reach GitHub');
    }
  }
  render();
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function setSync(state, note = null) {
  app.syncState = state;
  app.syncNote = note;
  renderBadge();
}

function renderBadge() {
  const badge = document.getElementById('sync-badge');
  const unsynced = store.hasUnsynced();

  // Signed-out is a state of its own, not a flavour of "idle" — otherwise the
  // badge reads "Ready" while there is no way to actually save anything,
  // which happens whenever the pasted token expires or gets revoked (PRD
  // 8.2). The badge is a reliable reconnect affordance from any view, so it
  // needs to say so.
  if (!app.signedIn) {
    badge.textContent = 'Sign in';
    badge.dataset.state = 'offline';
    return;
  }

  const label = {
    idle: unsynced ? 'Not synced' : 'Ready',
    syncing: 'Syncing…',
    synced: unsynced ? 'Not synced' : 'Synced',
    offline: unsynced ? 'Offline — queued' : 'Offline',
    error: app.syncNote || 'Error',
  }[app.syncState] || 'Ready';

  const dataState = app.syncState === 'error' ? 'error'
    : app.syncState === 'offline' ? 'offline'
    : unsynced ? 'pending'
    : app.syncState === 'synced' ? 'synced' : 'idle';

  badge.textContent = label;
  badge.dataset.state = dataState;
}

/** Apply an op locally, persist it, then attempt the GitHub write. */
async function commit(op) {
  store.enqueue(op); // queued BEFORE the network call — see store.js (T10)
  const { data, notes } = merge(app.data, [op]);
  app.data = data;
  if (notes.length) app.notes = notes;
  store.setSnapshot(app.data, store.getToken());
  render();
  await flushQueue();
}

async function flushQueue() {
  const pending = store.getPending();
  if (!pending.length) { renderBadge(); return; }
  if (!app.signedIn || !client) { setSync('idle'); return; }

  setSync('syncing');
  const result = await pushChanges({
    client,
    fileId: app.fileId,
    baseToken: store.getToken(),
    pendingOps: pending,
    localData: app.data,
    isOnline: navigator.onLine,
  });

  switch (result.outcome) {
    case OUTCOME.SYNCED:
      store.removePending(pending);
      app.data = result.data;
      store.setSnapshot(result.data, result.token);
      app.notes = result.notes || [];
      setSync('synced');
      break;

    case OUTCOME.OFFLINE:
      setSync('offline');
      break;

    case OUTCOME.AUTH_REQUIRED:
      // Queue is intentionally left intact so nothing is lost (T5).
      app.signedIn = false;
      setSync('error', 'Sign in again');
      break;

    case OUTCOME.CONFLICT_UNRESOLVED:
      app.conflict = result;
      setSync('error', 'Needs resolving');
      break;

    case OUTCOME.SCHEMA_TOO_NEW:
      setSync('error', 'Newer data version');
      app.notes = [{ kind: 'schema-too-new', message: result.error.message }];
      break;

    default:
      setSync('error', 'Save failed');
  }
  render();
}

// ---------------------------------------------------------------------------
// Render dispatch
// ---------------------------------------------------------------------------

function render() {
  const gated = !app.signedIn && !app.data;
  app.readOnly = !app.signedIn && Boolean(app.data);
  // Reconnecting mid-session (readOnly + the banner's "Reconnect" tapped)
  // shows the same form as the first-run gate, full-screen — a token paste
  // needs no more room than that, and it keeps one form to maintain instead
  // of a second inline copy in the banner.
  const showGate = gated || app.showSigninForm;

  document.getElementById('view-signin').hidden = !showGate;
  // Only meaningful when there's cached data to go back to — the true
  // first-run gate has nothing behind it to cancel to.
  document.getElementById('btn-signin-cancel').hidden = !app.readOnly;
  document.getElementById('tabbar').hidden = showGate;

  for (const name of ['today', 'history', 'retest', 'progress']) {
    document.getElementById(`view-${name}`).hidden = showGate || app.view !== name;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === app.view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  renderBadge();
  if (showGate) { document.getElementById('header-sub').textContent = ''; return; }

  const state = app.data ? deriveState(app.data, toISODate()) : { started: false };
  document.getElementById('header-sub').textContent = state.started
    ? `Cycle ${state.cycleNumber} · Week ${state.weekInCycle} · ${state.blockMeta.name}`
    : 'No cycle started';

  if (app.view === 'today') renderToday(state);
  if (app.view === 'history') renderHistory();
  if (app.view === 'retest') renderRetest(state);
  if (app.view === 'progress') renderProgress(state);

  renderModals();
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

function renderToday(state) {
  const el = document.getElementById('view-today');

  if (!state.started) {
    el.innerHTML = `
      <div class="card centred">
        <h2>Start your first cycle</h2>
        <p class="muted">13 weeks: three 4-week blocks plus a deload and retest week.</p>
        <button class="btn btn-primary btn-lg" data-act="start-cycle" data-n="1">Start Cycle 1</button>
      </div>`;
    return;
  }

  const p = prescriptionFor(state, app.data);
  ensureDraft(state, p);
  currentPrescriptionMeta = Object.fromEntries(
    p.exercises.map((ex) => [ex.exerciseId, { sets: ex.sets, tracksLoad: ex.prescribedLoadKg != null }])
  );

  const missed = missedSessionPrompt(state, store.getDismissedOn());
  const reEntry = reEntryDeloadSuggestion(state);

  el.innerHTML = [
    app.readOnly ? readOnlyBanner() : '',
    state.cycleComplete ? cycleCompleteBanner(state) : '',
    missed ? missedBanner(missed) : '',
    reEntry ? reEntryBanner(reEntry) : '',
    state.snappedToWeekBoundary ? weekJumpBanner(state) : '',
    volumeBanner(state),
    app.draft.golfTomorrow ? rpeCapBanner() : '',
    todayHeaderCard(state, p),
    golfCard(),
    warmupCard(),
    p.exercises.map(exerciseCard).join(''),
    notesCard(),
    `<div class="save-bar">
       <button class="btn btn-primary btn-lg" data-act="save-workout" ${app.readOnly ? 'disabled' : ''}>
         ${store.hasUnsynced() ? 'Retry save' : 'Save workout'}
       </button>
     </div>`,
  ].join('');
}

function todayHeaderCard(state, p) {
  return `
    <div class="card">
      <div class="row-between">
        <div>
          <h2>Day ${p.dayType} — ${esc(p.dayName)}</h2>
          <p class="muted small">Week ${state.weekInCycle} of 13 · ${esc(state.blockMeta.name)} · ${getDay(p.dayType).duration}</p>
        </div>
        <span class="pill pill-accent">Cycle ${state.cycleNumber}</span>
      </div>
      <p class="muted small" style="margin-top:.6rem">${esc(p.purpose)}</p>
    </div>`;
}

function volumeBanner(state) {
  if (state.isDeload) {
    return banner('accent', 'Deload &amp; retest week',
      'Volume roughly halved at Block 1 loads. Prioritise recovery and the mobility work, then log your retest.');
  }
  if (state.isConsolidation) {
    return banner('accent', 'Consolidation week',
      'Same loads as last week, about 25% fewer sets. Don\'t chase PRs this week.');
  }
  return '';
}

function weekJumpBanner(state) {
  return banner('warn', `Moved on to week ${state.weekInCycle}`,
    `A gap in training pushed the programme forward, so ${state.droppedSlots} session${state.droppedSlots === 1 ? '' : 's'} ` +
    `w${state.droppedSlots === 1 ? 'as' : 'ere'} passed over rather than made up — no cramming, per the programme's own rule. ` +
    `A new week always restarts on Day A, so a day type can repeat across the gap.`);
}

function missedBanner(missed) {
  return `
    <div class="banner banner-warn">
      <h3>Did you miss Day ${missed.dayType}, week ${missed.weekInCycle}?</h3>
      <p class="small">${missed.daysSinceLastSession} days since your last logged session${missed.lastSessionDate ? ` (${fmtDate(missed.lastSessionDate)})` : ''}.</p>
      <div class="row wrap">
        <button class="btn btn-sm" data-act="missed-skip">Missed, skip it</button>
        <button class="btn btn-sm" data-act="missed-donow">Do it now instead</button>
        <button class="btn btn-sm btn-ghost" data-act="missed-notlogged">Not missed, haven't logged yet</button>
      </div>
    </div>`;
}

function reEntryBanner(s) {
  const what = s.reducedVolumeOnly
    ? 'You\'re in Block 1, so there\'s no earlier block to drop to — consider cutting the sets instead for your first session back.'
    : `Consider using Block ${s.suggestedBlock} loads for your first session back.`;
  return banner('warn', `${s.daysOff} days since your last session`, `${what} This is a suggestion only — nothing has been changed.`);
}

function readOnlyBanner() {
  return `
    <div class="banner banner-warn">
      <h3>Signed out</h3>
      <p class="small">Showing your last synced data. Your token expired, was revoked, or hasn't been entered on this device yet — reconnect to log a session or pick up changes from another device.</p>
      <div class="row">
        <button class="btn btn-sm btn-primary" data-act="show-signin">Reconnect</button>
      </div>
    </div>`;
}

function rpeCapBanner() {
  return `
    <div class="banner banner-warn">
      <h3>Golf tomorrow — cap at RPE ${AUTOREGULATION.rpeCapMin}-${AUTOREGULATION.rpeCapMax}</h3>
      <p class="small">${esc(AUTOREGULATION.golfTomorrow)}</p>
    </div>`;
}

function cycleCompleteBanner(state) {
  return `
    <div class="banner banner-accent">
      <h3>Cycle ${state.cycleNumber} complete</h3>
      <p class="small">Log your retest if you haven't, then start the next 90-day block. Your history stays tagged by cycle.</p>
      <div class="row">
        <button class="btn btn-sm btn-primary" data-act="start-cycle" data-n="${state.cycleNumber + 1}">Start Cycle ${state.cycleNumber + 1}</button>
      </div>
    </div>`;
}

function golfCard() {
  return `
    <div class="card">
      <h3>Autoregulation</h3>
      <label class="check">
        <input type="checkbox" data-act="golf-tomorrow" ${app.draft.golfTomorrow ? 'checked' : ''}>
        <span>Playing golf tomorrow?</span>
      </label>
      <label class="check">
        <input type="checkbox" data-act="golf-today" ${app.draft.golfToday ? 'checked' : ''}>
        <span>Played golf today?</span>
      </label>
    </div>`;
}

function warmupCard() {
  const ticked = new Set(store.getWarmup());
  const allDone = WARMUP.every((w) => ticked.has(w.id));
  return `
    <div class="card${allDone ? ' is-collapsed' : ''}" data-warmup-card>
      <div class="ex-head" data-act="toggle-warmup" role="button" tabindex="0" aria-expanded="${allDone ? 'false' : 'true'}">
        <div class="grow">
          <h3>Warm-up <span class="muted small">~6 min</span> ${allDone ? '<span class="ex-done">✓ Done</span>' : ''}</h3>
        </div>
        <span class="ex-chevron" aria-hidden="true">▾</span>
      </div>
      <div class="ex-body">
        ${WARMUP.map((w) => `
          <label class="check">
            <input type="checkbox" data-act="warmup" data-id="${w.id}" ${ticked.has(w.id) ? 'checked' : ''}>
            <span>${esc(w.label)} <span class="presc">${esc(w.prescription)}</span></span>
          </label>`).join('')}
      </div>
    </div>`;
}

function exerciseCard(ex) {
  const logged = app.draft.exercises[ex.exerciseId] || { sets: [], note: '' };
  const capped = app.draft.golfTomorrow;
  // Bodyweight and band exercises (push-ups, deadbug, Pallof press) carry no
  // prescribed kg — the programme cell's loadKg is null for these — so the
  // load field is dropped rather than shown as an always-empty distraction.
  const tracksLoad = ex.prescribedLoadKg != null;
  // AMRAP sets ("3xAMRAP-2") have no fixed target, so only pre-fill reps when
  // the programme gives an actual number — including distance-based sets
  // like the rack carry's "30m", which share the reps field under a
  // different label.
  const suggestedReps = typeof ex.reps === 'number' ? ex.reps : null;

  let allComplete = true;
  const rows = Array.from({ length: ex.sets }, (_, i) => {
    const set = logged.sets[i] || {};
    const kg = set.kg ?? (ex.suggestedLoadKg ?? '');
    const reps = set.reps ?? (suggestedReps ?? '');
    if (set.reps == null || set.rpe == null || (tracksLoad && set.kg == null)) allComplete = false;
    return setBlock({
      label: `Set ${i + 1}${ex.perSide ? ' · each side' : ''}`,
      showFieldLabels: i === 0,
      exId: ex.exerciseId,
      index: i,
      kg,
      reps,
      rpe: set.rpe ?? '',
      repsLabel: ex.unit === 'm' ? 'Metres' : 'Reps',
      capped,
      tracksLoad,
    });
  }).join('');

  const loadHint = ex.loadSource === 'carry-forward'
    ? `<div class="ex-adjust">Pre-filled ${ex.suggestedLoadKg}kg — carried from last cycle. Editable.</div>`
    : ex.loadSource === 'override'
      ? `<div class="ex-adjust">Pre-filled ${ex.suggestedLoadKg}kg — your override for this cycle.</div>`
      : '';

  // Starts collapsed if it's already fully logged (e.g. reopening the app
  // mid-workout with this one already done) — see checkAutoCollapse() for
  // the live version that fires as you finish typing the last value.
  return `
    <div class="card${allComplete ? ' is-collapsed' : ''}" data-exercise-card="${ex.exerciseId}">
      <div class="ex-head" data-act="toggle-exercise" role="button" tabindex="0" aria-expanded="${allComplete ? 'false' : 'true'}">
        <div class="grow">
          <div class="ex-name">${esc(ex.name)}</div>
          <span class="ex-target">${esc(ex.target)}</span>
          ${allComplete ? '<span class="ex-done">✓ Logged</span>' : ''}
        </div>
        <span class="ex-chevron" aria-hidden="true">▾</span>
      </div>
      <div class="ex-body">
        ${ex.setsAdjustedFrom ? `<div class="ex-adjust">Reduced to ${ex.sets} sets this week (normally ${ex.setsAdjustedFrom}) — same load.</div>` : ''}
        ${loadHint}
        <div class="ex-note">${esc(ex.note)}</div>
        ${rows}
        <div class="field" style="margin-top:.7rem">
          <label for="note-${ex.exerciseId}">Note</label>
          <textarea id="note-${ex.exerciseId}" data-act="ex-note" data-id="${ex.exerciseId}" rows="1"
            placeholder="How did it feel?">${esc(logged.note || '')}</textarea>
        </div>
      </div>
    </div>`;
}

/** One set: its number on its own line, then the fields at full width. */
function setBlock({ label, showFieldLabels, exId, index, kg, reps, rpe, repsLabel = 'Reps', capped = false, tracksLoad = true }) {
  return `
    <div class="set-block">
      <div class="set-label">${esc(label)}</div>
      <div class="set-fields${tracksLoad ? '' : ' set-fields-2col'}">
        ${tracksLoad ? stepper('kg', exId, index, kg, 'Kg', 0.5, false, showFieldLabels) : ''}
        ${stepper('reps', exId, index, reps, repsLabel, 1, false, showFieldLabels)}
        ${stepper('rpe', exId, index, rpe, 'RPE', 1, capped, showFieldLabels)}
      </div>
    </div>`;
}

/**
 * Numeric field with +/- steppers. `inputmode="decimal"` brings up the phone's
 * number keypad; the steppers mean most logging needs no typing at all.
 * Field labels show on the first set only — repeating them on every row costs
 * vertical space without telling you anything new.
 */
function stepper(field, exId, index, value, label, step, capped = false, showLabel = true) {
  const id = `${field}-${exId}-${index}`;
  return `
    <div class="field">
      ${showLabel
        ? `<label for="${id}">${esc(label)}</label>`
        : `<label for="${id}" class="sr-only">${esc(label)} for set ${index + 1}</label>`}
      <div class="stepper ${capped && field === 'rpe' ? 'rpe-capped' : ''}">
        <button type="button" data-act="step" data-dir="-1" data-field="${field}" data-id="${exId}" data-i="${index}" aria-label="Decrease ${esc(label)}">−</button>
        <input id="${id}" type="number" inputmode="decimal" step="${step}"
          ${field === 'rpe' ? 'min="1" max="10"' : 'min="0"'}
          data-act="set-input" data-field="${field}" data-id="${exId}" data-i="${index}" value="${value}">
        <button type="button" data-act="step" data-dir="1" data-field="${field}" data-id="${exId}" data-i="${index}" aria-label="Increase ${esc(label)}">+</button>
      </div>
    </div>`;
}

function notesCard() {
  return `
    <div class="card">
      <h3 class="muted small">RPE — how hard did that set feel?</h3>
      <p class="muted small">
        1–10. 10 means you couldn't have done another rep; a solid working set with
        "2 reps in reserve" is roughly RPE 8. Log it honestly — it's what the progression
        rule below reads to decide whether to add load, and it's what the golf-day
        effort cap limits you to.
      </p>
      <h3 class="muted small" style="margin-top:.9rem">Progression rules</h3>
      <ul class="muted small" style="padding-left:1.1rem;margin:.3rem 0 0">
        ${PROGRESSION_RULES.map((r) => `<li style="margin-bottom:.3rem">${esc(r)}</li>`).join('')}
      </ul>
    </div>`;
}

// --- auto-collapse on completion ---------------------------------------------
//
// Once every set of an exercise has its required fields, the card collapses
// so the next thing to do is what's on screen — PRD 4.2's "minimal scrolling
// per exercise" applies just as much once you're five exercises deep as it
// does to the first one. A tap on the header always reopens it, and once a
// card has been toggled by hand it stops auto-collapsing/expanding itself —
// manual control wins over the automatic behaviour from that point on. The
// override is stored on the card's own DOM node (data-userToggled), so it
// resets naturally whenever the view re-renders (new session, tab switch).
//
// This runs off targeted DOM edits rather than a full render() because
// render() rebuilds every card's innerHTML — doing that on every keystroke
// would drop focus out of the input the user is still typing into.
// (currentPrescriptionMeta itself is declared near the top of the file,
// alongside `app` — see the comment there for why that placement matters.)

function isExerciseComplete(exId) {
  const meta = currentPrescriptionMeta[exId];
  const entry = app.draft?.exercises?.[exId];
  if (!meta || !entry) return false;
  for (let i = 0; i < meta.sets; i++) {
    const s = entry.sets[i];
    if (!s || s.reps == null || s.rpe == null) return false;
    if (meta.tracksLoad && s.kg == null) return false;
  }
  return true;
}

function checkAutoCollapse(exId) {
  const card = document.querySelector(`[data-exercise-card="${exId}"]`);
  if (!card) return;
  applyCollapseState(card, isExerciseComplete(exId), '.ex-target', 'afterend');
}

function checkWarmupAutoCollapse() {
  const card = document.querySelector('[data-warmup-card]');
  if (!card) return;
  const ticked = new Set(store.getWarmup());
  applyCollapseState(card, WARMUP.every((w) => ticked.has(w.id)), 'h3', 'beforeend');
}

function applyCollapseState(card, complete, doneTagAnchorSelector, position) {
  const doneTag = card.querySelector('.ex-done');
  if (complete && !doneTag) {
    card.querySelector(doneTagAnchorSelector)?.insertAdjacentHTML(position, ' <span class="ex-done">✓ Logged</span>');
  } else if (!complete && doneTag) {
    doneTag.remove();
  }

  if (card.dataset.userToggled) return; // manual control, once taken, sticks

  card.classList.toggle('is-collapsed', complete);
  card.querySelector('[role="button"]')?.setAttribute('aria-expanded', String(!complete));
}

// --- draft ------------------------------------------------------------------

function ensureDraft(state, prescription) {
  const key = `${state.cycleNumber}:${toISODate()}:${state.dayType}`;
  if (app.draft && app.draft.key === key) return;

  app.draft = {
    key,
    cycleNumber: state.cycleNumber,
    date: toISODate(),
    dayType: state.dayType,
    weekInCycle: state.weekInCycle,
    slotIndex: state.slotIndex,
    golfTomorrow: false,
    golfToday: false,
    exercises: Object.fromEntries(
      prescription.exercises.map((ex) => [ex.exerciseId, { sets: [], note: '' }])
    ),
  };
  store.setDraft(app.draft);
}

function updateDraftSet(exId, index, field, value) {
  const entry = (app.draft.exercises[exId] ||= { sets: [], note: '' });
  const set = (entry.sets[index] ||= {});
  if (value === '' || value == null || Number.isNaN(Number(value))) delete set[field];
  else set[field] = Number(value);
  store.setDraft(app.draft);
}

async function saveWorkout() {
  const state = deriveState(app.data, toISODate());
  const now = new Date().toISOString();

  const exercises = Object.entries(app.draft.exercises)
    .map(([exerciseId, entry]) => ({
      exerciseId,
      sets: entry.sets
        .map((s) => s || {})
        .filter((s) => s.kg != null || s.reps != null || s.rpe != null),
      note: entry.note || '',
    }))
    .filter((e) => e.sets.length || e.note);

  if (!exercises.length) {
    alert('Nothing logged yet — enter at least one set before saving.');
    return;
  }

  const session = {
    cycleNumber: app.draft.cycleNumber,
    date: app.draft.date,
    dayType: app.draft.dayType,
    // Recorded as the app presented it at log time; current state is always
    // re-derived, so these are history, not a source of truth.
    weekInCycle: app.draft.weekInCycle,
    slotIndex: app.draft.slotIndex,
    golfTomorrow: app.draft.golfTomorrow,
    golfToday: app.draft.golfToday,
    warmup: store.getWarmup(),
    exercises,
    loggedAt: now,
    updatedAt: now,
  };

  await commit(ops.upsertSession(session));

  store.clearDraft();
  store.clearWarmup();
  app.draft = null;
  render();
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
// (historyFilter is declared near the top of the file, alongside app — not
// because renderHistory() is ever reached during boot()'s synchronous chain
// today [app.view starts as 'today'], but so it can never become the next
// instance of this bug if that ever changes.)

function renderHistory() {
  const el = document.getElementById('view-history');
  const sessions = [...app.data.sessions].sort((a, b) => (a.date < b.date ? 1 : -1));

  const options = allExercises()
    .map((ex) => `<option value="${ex.id}" ${ex.id === historyFilter ? 'selected' : ''}>Day ${ex.dayType} — ${esc(ex.name)}</option>`)
    .join('');

  const points = app.data.sessions
    .flatMap((s) => {
      const entry = (s.exercises || []).find((e) => e.exerciseId === historyFilter);
      if (!entry) return [];
      const weights = entry.sets.map((x) => x.kg).filter((n) => typeof n === 'number');
      const reps = entry.sets.map((x) => x.reps).filter((n) => typeof n === 'number');
      if (!weights.length) return [];
      return [{ date: s.date, cycleNumber: s.cycleNumber, kg: Math.max(...weights), topReps: reps.length ? Math.max(...reps) : null }];
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  el.innerHTML = `
    <div class="card">
      <h2>Load progression</h2>
      <div class="field" style="margin:.6rem 0">
        <label for="hist-filter">Exercise</label>
        <select id="hist-filter" data-act="hist-filter">${options}</select>
      </div>
      ${points.length >= 2 ? chart(points) : `<p class="muted small">Log this exercise at least twice to see a trend.</p>`}
      ${points.length ? `<p class="muted small">Top set: ${points[points.length - 1].kg}kg${points[points.length - 1].topReps ? ` × ${points[points.length - 1].topReps}` : ''} on ${fmtDate(points[points.length - 1].date)}</p>` : ''}
    </div>

    <div class="card">
      <h2>Logged sessions <span class="muted small">${sessions.length}</span></h2>
      ${sessions.length === 0 ? '<p class="muted small">Nothing logged yet.</p>' : ''}
      ${sessions.slice(0, 60).map(logEntry).join('')}
    </div>`;
}

function logEntry(s) {
  const total = (s.exercises || []).reduce((n, e) => n + e.sets.length, 0);
  // Metadata gets its own lines rather than sharing a row with the buttons —
  // side by side on a 375px screen it wrapped mid-phrase ("cycle / 1, week 6").
  return `
    <div class="log-entry">
      <div><strong>Day ${s.dayType}</strong> <span class="muted small">${fmtDate(s.date)}</span></div>
      <div class="log-sets">
        Cycle ${s.cycleNumber}, week ${s.weekInCycle} · ${total} sets across ${(s.exercises || []).length} exercises${s.golfTomorrow ? ' · golf next day' : ''}
      </div>
      <div class="row log-actions">
        <button class="btn btn-sm" data-act="edit-session" data-key="${sessionKey(s)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-act="delete-session" data-key="${sessionKey(s)}">Delete</button>
      </div>
    </div>`;
}

/** Plain SVG — no chart library, per PRD 5. */
function chart(points) {
  const W = 560, H = 180, pad = 30;
  const xs = points.map((_, i) => i);
  const ys = points.map((p) => p.kg);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanY = maxY - minY || 1;

  const px = (i) => pad + (xs.length === 1 ? 0 : (i / (xs.length - 1)) * (W - pad * 2));
  const py = (v) => H - pad - ((v - minY) / spanY) * (H - pad * 2);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(p.kg).toFixed(1)}`).join(' ');
  const dots = points.map((p, i) => `<circle cx="${px(i).toFixed(1)}" cy="${py(p.kg).toFixed(1)}" r="3.5" fill="var(--accent)"/>`).join('');

  // Mark where a new cycle begins so multi-cycle history reads clearly.
  const breaks = points
    .map((p, i) => (i > 0 && p.cycleNumber !== points[i - 1].cycleNumber
      ? `<line x1="${px(i - 0.5).toFixed(1)}" y1="${pad / 2}" x2="${px(i - 0.5).toFixed(1)}" y2="${H - pad / 2}" stroke="var(--line)" stroke-dasharray="3 3"/>`
      : ''))
    .join('');

  return `
    <div class="chart-wrap">
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Load over time">
        <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="var(--line)"/>
        ${breaks}
        <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
        ${dots}
        <text x="${pad}" y="${pad - 8}" fill="var(--muted)" font-size="12">${maxY}kg</text>
        <text x="${pad}" y="${H - pad + 18}" fill="var(--muted)" font-size="12">${minY}kg</text>
      </svg>
    </div>`;
}

// ---------------------------------------------------------------------------
// Retest
// ---------------------------------------------------------------------------

function renderRetest(state) {
  const el = document.getElementById('view-retest');
  const compared = retestComparison(app.data);
  const cycleNo = state.started ? state.cycleNumber : 1;
  const existing = app.data.retests.find((r) => r.cycleNumber === cycleNo);

  el.innerHTML = `
    <div class="card">
      <h2>Retest — cycle ${cycleNo}</h2>
      <p class="muted small">Repeat exactly at the end of each cycle for a true comparison. No pass marks here by design — you get the direction of travel, the interpretation is yours.</p>
      ${RETEST_METRICS.map((m) => `
        <div class="field" style="margin-top:.7rem">
          <label for="rt-${m.id}">${esc(m.label)} <span class="muted">(${m.unit})</span></label>
          <input id="rt-${m.id}" type="number" inputmode="decimal" data-act="retest-input" data-id="${m.id}"
            value="${existing?.metrics?.[m.id] ?? ''}">
        </div>`).join('')}
      <button class="btn btn-primary btn-lg" style="margin-top:1rem" data-act="save-retest" data-cycle="${cycleNo}" ${app.readOnly ? 'disabled' : ''}>
        Save retest
      </button>
    </div>
    ${compared.length ? retestTable(compared) : ''}`;
}

function retestTable(compared) {
  return `
    <div class="card">
      <h2>Across cycles</h2>
      <table class="deltas">
        <thead><tr><th>Metric</th>${compared.map((c) => `<th class="num">C${c.cycleNumber}</th>`).join('')}</tr></thead>
        <tbody>
          ${RETEST_METRICS.map((m) => `
            <tr>
              <td>${esc(m.label)}</td>
              ${compared.map((c) => {
                const v = c.metrics?.[m.id];
                const d = c.deltas?.[m.id];
                return `<td class="num">${v ?? '—'}${d ? ` <span class="${deltaClass(d.direction, m.better)}">${arrow(d.direction)}${d.diff > 0 ? '+' : ''}${d.diff}</span>` : ''}</td>`;
              }).join('')}
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="muted small" style="margin-top:.6rem">Arrows show change versus your previous cycle only.</p>
    </div>`;
}

function arrow(direction) {
  return direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→';
}

/** Colour tracks whether the change moved in the metric's better direction. */
function deltaClass(direction, better) {
  if (direction === 'unchanged') return 'delta-flat';
  return direction === better ? 'delta-up' : 'delta-down';
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function renderProgress(state) {
  const el = document.getElementById('view-progress');
  const life = lifetimeStats(app.data);

  if (!state.started) {
    el.innerHTML = `<div class="card"><p class="muted">No cycle started yet.</p></div>`;
    return;
  }

  const adherence = state.adherence == null ? '—' : `${Math.round(state.adherence * 100)}%`;

  el.innerHTML = `
    <div class="card">
      <h2>This cycle</h2>
      <div class="stat-grid" style="margin-top:.6rem">
        ${stat('Cycle', state.cycleNumber, `day ${state.daysSinceStart}`)}
        ${stat('Week', `${state.weekInCycle} / 13`, `by ${state.weekDrivenBy === 'calendar' ? 'calendar' : 'sessions'}`)}
        ${stat('Block', state.blockMeta.name, state.blockMeta.focus.split(',')[0])}
        ${stat('Adherence', adherence, `${state.completedSessions} of ${state.scheduledSessions} sessions`)}
      </div>
    </div>

    <div class="card">
      <h2>Next reduced-volume week</h2>
      ${state.nextReducedWeek == null ? '<p class="muted small">None remaining this cycle.</p>' : `
        <p class="small">Week ${state.nextReducedWeek}${state.nextReducedWeek === 13 ? ' (deload &amp; retest)' : ' (consolidation)'} arrives on whichever comes first:</p>
        <div class="stat-grid" style="margin-top:.6rem">
          ${stat('By sessions', state.sessionsUntilReduced, state.sessionsUntilReduced === 0 ? 'you are in it' : 'sessions away')}
          ${stat('By calendar', state.daysUntilReduced, state.daysUntilReduced === 0 ? 'you are in it' : 'days away')}
        </div>
        <p class="muted small" style="margin-top:.6rem">The calendar limit stops a long break postponing a recovery week indefinitely.</p>`}
    </div>

    <div class="card">
      <h2>Lifetime</h2>
      <div class="stat-grid" style="margin-top:.6rem">
        ${stat('Cycles completed', life.completedCycles, '90-day blocks')}
        ${stat('Sessions logged', life.totalSessions, life.firstSessionDate ? `since ${fmtDate(life.firstSessionDate)}` : '')}
        ${stat('Sessions skipped', life.totalSkipped, 'marked missed')}
        ${stat('Days elapsed', state.daysSinceStart, 'this cycle')}
      </div>
    </div>

    <div class="card">
      <button class="btn" data-act="sign-out">Sign out</button>
    </div>`;
}

function stat(k, v, sub = '') {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div><div class="sub">${esc(sub)}</div></div>`;
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
// (editing is declared near the top of the file, alongside app — see that
// comment for why: renderModals() is reached synchronously from boot().)

function renderModals() {
  const root = document.getElementById('modal-root');

  if (app.conflict) { root.innerHTML = conflictModal(app.conflict); return; }
  if (editing) { root.innerHTML = editModal(editing); return; }

  const blocker = app.notes.find((n) => n.kind === 'schema-too-new');
  if (blocker) {
    root.innerHTML = `
      <div class="modal-backdrop"><div class="modal">
        <h2>Newer data version</h2>
        <p class="small">${esc(blocker.message)}</p>
        <button class="btn btn-primary" data-act="reload">Reload</button>
      </div></div>`;
    return;
  }
  root.innerHTML = '';
}

/** T9 — both versions shown; the app never picks for you. */
function conflictModal(conflict) {
  const mine = describeOps(conflict.pendingOps);
  const theirs = (conflict.remote.sessions || []).slice(-5)
    .map((s) => `Day ${s.dayType}, ${s.date} (cycle ${s.cycleNumber})`);

  return `
    <div class="modal-backdrop"><div class="modal">
      <h2>This file changed twice while saving</h2>
      <p class="small muted">Rather than retry in a loop or pick one for you, here is what's on each side.</p>

      <h3 style="margin-top:.8rem">Your unsaved changes</h3>
      <pre>${esc(mine.join('\n') || 'none')}</pre>

      <h3>Most recent in the Gist</h3>
      <pre>${esc(theirs.join('\n') || 'none')}</pre>

      <button class="btn btn-primary" data-act="conflict" data-choice="retry-merge">Merge mine into that copy</button>
      <button class="btn" data-act="conflict" data-choice="keep-remote">Keep that copy, discard mine</button>
      <button class="btn btn-danger" data-act="conflict" data-choice="force-local">Overwrite it with mine</button>
    </div></div>`;
}

function editModal(session) {
  const day = getDay(session.dayType);
  return `
    <div class="modal-backdrop"><div class="modal">
      <h2>Edit — Day ${session.dayType}, ${fmtDate(session.date)}</h2>
      <p class="muted small">Cycle ${session.cycleNumber}, week ${session.weekInCycle}</p>
      ${session.exercises.map((entry) => {
        const ex = findExercise(entry.exerciseId);
        const block = blockForWeek(session.weekInCycle);
        const tracksLoad = ex ? ex.blocks[block]?.loadKg != null : true;
        return `
          <div style="margin-top:.9rem">
            <strong>${esc(ex ? ex.name : entry.exerciseId)}</strong>
            ${entry.sets.map((s, i) => setBlock({
              label: `Set ${i + 1}`,
              showFieldLabels: i === 0,
              exId: entry.exerciseId,
              index: i,
              kg: s.kg ?? '',
              reps: s.reps ?? '',
              rpe: s.rpe ?? '',
              tracksLoad,
            })).join('')}
          </div>`;
      }).join('')}
      <button class="btn btn-primary" data-act="edit-save">Save changes</button>
      <button class="btn btn-ghost" data-act="edit-cancel">Cancel</button>
    </div></div>`;
}

// ---------------------------------------------------------------------------
// Events — one delegated listener, since views re-render wholesale
// ---------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;

  if (act === 'step') {
    e.preventDefault();
    const input = document.getElementById(`${t.dataset.field}-${t.dataset.id}-${t.dataset.i}`);
    const step = Number(input.step) || 1;
    const next = Math.max(0, (Number(input.value) || 0) + step * Number(t.dataset.dir));
    input.value = t.dataset.field === 'rpe' ? Math.min(10, next) : next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  switch (act) {
    case 'show-signin':
      app.showSigninForm = true;
      render();
      break;

    case 'start-cycle': {
      const n = Number(t.dataset.n);
      const previous = app.data?.cycles?.find((c) => !c.endedAt);
      if (!app.data) app.data = emptyData();
      if (previous) await commit(ops.endCycle(previous.cycleNumber, new Date().toISOString()));
      await commit(ops.startCycle({ cycleNumber: n, startDate: toISODate(), endedAt: null, loadOverrides: {} }));
      break;
    }

    case 'save-workout': await saveWorkout(); break;

    case 'missed-skip': {
      const state = deriveState(app.data, toISODate());
      await commit(ops.addSkip({
        cycleNumber: state.cycleNumber,
        slotIndex: state.slotIndex,
        dayType: state.dayType,
        weekInCycle: state.weekInCycle,
        markedAt: new Date().toISOString(),
      }));
      // The draft was built for the session just skipped.
      store.clearDraft();
      app.draft = null;
      render();
      break;
    }

    case 'missed-donow':
    case 'missed-notlogged':
      // Both simply stop the prompt for today. "Do it now" needs no state
      // change — that session already is today's session.
      store.setDismissedOn(toISODate());
      render();
      break;

    case 'save-retest': {
      const cycleNumber = Number(t.dataset.cycle);
      const metrics = {};
      for (const m of RETEST_METRICS) {
        const v = document.getElementById(`rt-${m.id}`).value;
        if (v !== '') metrics[m.id] = Number(v);
      }
      await commit(ops.upsertRetest({ cycleNumber, date: toISODate(), metrics, updatedAt: new Date().toISOString() }));
      break;
    }

    case 'edit-session':
      editing = structuredClone(app.data.sessions.find((s) => sessionKey(s) === t.dataset.key));
      renderModals();
      break;

    case 'edit-cancel':
      editing = null;
      renderModals();
      break;

    case 'edit-save': {
      const updated = { ...editing, updatedAt: new Date().toISOString() };
      editing = null;
      await commit(ops.upsertSession(updated));
      break;
    }

    case 'delete-session': {
      const s = app.data.sessions.find((x) => sessionKey(x) === t.dataset.key);
      if (!confirm(`Delete Day ${s.dayType} on ${fmtDate(s.date)}? This can't be undone.`)) break;
      await commit(ops.deleteSession(t.dataset.key, new Date().toISOString()));
      break;
    }

    case 'conflict': {
      const c = app.conflict;
      app.conflict = null;
      setSync('syncing');
      try {
        const result = await resolveConflict({
          client, fileId: app.fileId, choice: t.dataset.choice,
          remote: c.remote, localData: c.localData, pendingOps: c.pendingOps,
        });
        store.clearPending();
        app.data = result.data;
        store.setSnapshot(result.data, result.token);
        setSync('synced');
      } catch (err) {
        setSync('error', 'Resolve failed');
      }
      render();
      break;
    }

    case 'sign-out':
      auth.signOut();
      store.clearAuth(); // otherwise the token would silently restore itself on next open
      app.signedIn = false;
      client = null; // kept in lockstep with signedIn everywhere — see boot()'s comment
      render();
      break;

    case 'reload':
      location.reload();
      break;

    case 'toggle-exercise':
    case 'toggle-warmup': {
      const card = t.closest('.card');
      if (!card) break;
      card.dataset.userToggled = '1'; // manual control from here on — see checkAutoCollapse
      const collapsed = card.classList.toggle('is-collapsed');
      card.querySelector('[role="button"]')?.setAttribute('aria-expanded', String(!collapsed));
      break;
    }
  }
});

// Enter/Space activates the collapse toggle, since it's a div with
// role="button" rather than a real <button> (it wraps multi-line content).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest('[data-act="toggle-exercise"], [data-act="toggle-warmup"]');
  if (!t) return;
  e.preventDefault();
  t.click();
});

document.addEventListener('input', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;

  if (t.dataset.act === 'set-input') {
    if (editing) {
      const entry = editing.exercises.find((x) => x.exerciseId === t.dataset.id);
      const set = (entry.sets[Number(t.dataset.i)] ||= {});
      if (t.value === '') delete set[t.dataset.field];
      else set[t.dataset.field] = Number(t.value);
    } else {
      updateDraftSet(t.dataset.id, Number(t.dataset.i), t.dataset.field, t.value);
      checkAutoCollapse(t.dataset.id);
    }
  }

  if (t.dataset.act === 'ex-note') {
    (app.draft.exercises[t.dataset.id] ||= { sets: [], note: '' }).note = t.value;
    store.setDraft(app.draft);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;

  switch (t.dataset.act) {
    case 'golf-tomorrow':
      app.draft.golfTomorrow = t.checked;
      store.setDraft(app.draft);
      render(); // surfaces or clears the RPE cap banner
      break;
    case 'golf-today':
      app.draft.golfToday = t.checked;
      store.setDraft(app.draft);
      break;
    case 'warmup': {
      const set = new Set(store.getWarmup());
      t.checked ? set.add(t.dataset.id) : set.delete(t.dataset.id);
      store.setWarmup([...set]);
      checkWarmupAutoCollapse();
      break;
    }
    case 'hist-filter':
      historyFilter = t.value;
      renderHistory();
      break;
  }
});

function onBadgeClick() {
  if (!app.signedIn) { app.showSigninForm = true; render(); return; }
  if (store.hasUnsynced()) { flushQueue(); return; }
  loadRemote();
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function banner(kind, title, body) {
  return `<div class="banner banner-${kind}"><h3>${title}</h3><p class="small">${body}</p></div>`;
}

function show(id, text) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.hidden = false;
}

function hide(id) {
  document.getElementById(id).hidden = true;
}

function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
