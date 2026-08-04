/**
 * Cycle-aware derivation logic (PRD 4.1, 4.4, 4.7).
 *
 * Design note — everything in here is a PURE FUNCTION of stored facts.
 *
 * `weekInCycle`, `block`, the next session's day type, adherence and the
 * deload countdown are all DERIVED from `sessions` + `skips` + the cycle's
 * start date. None of them is stored as a mutable counter.
 *
 * That is deliberate and it is what makes cross-device merging safe: sessions
 * and skips are additive facts, so two devices that each log something
 * converge on the same derived state after a merge. A stored counter would
 * not — two devices each incrementing `weekInCycle` would land on week 5 when
 * the truth is week 4, and nothing would catch it.
 */

import {
  DAY_TYPES,
  WEEKS_PER_CYCLE,
  SESSIONS_PER_WEEK,
  CONSOLIDATION_WEEKS,
  DELOAD_WEEK,
  BLOCKS,
  getDay,
} from './programme.js';

// ---------------------------------------------------------------------------
// Tunable rules — every one of these is a decision from the PRD, named here
// rather than buried as a magic number at the call site.
// ---------------------------------------------------------------------------

/**
 * How far behind schedule you may fall before the calendar backstop drags you
 * into the next week regardless of sessions completed (PRD 4.4, hybrid
 * trigger). Confirmed with Nick: 2 weeks.
 *
 * This is what makes week `w` fall on day `(w + 1) * 7` via the calendar path:
 * week 4 by day 35, matching the worked example in the PRD.
 */
export const GRACE_WEEKS = 2;

/** Days since the last logged session before we ask "did you miss one?" */
export const MISSED_PROMPT_DAYS = 5;

/** Days with no session before suggesting a mini re-entry deload (PRD 4.4). */
export const RE_ENTRY_GAP_DAYS = 14;

/** Set multipliers for reduced-volume weeks. Confirmed with Nick. */
export const CONSOLIDATION_SET_FACTOR = 0.75;
export const DELOAD_SET_FACTOR = 0.5;

// ---------------------------------------------------------------------------
// Dates. Stored as 'YYYY-MM-DD'; compared at UTC noon so DST transitions can
// never shift a day boundary.
// ---------------------------------------------------------------------------

export function toISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function noonUTC(isoDate) {
  const ms = Date.parse(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO date: ${isoDate}`);
  return ms;
}

/** Whole days from `from` to `to`. Negative if `to` precedes `from`. */
export function daysBetween(from, to) {
  return Math.round((noonUTC(to) - noonUTC(from)) / 86400000);
}

export function addDays(isoDate, n) {
  return toISODate(new Date(noonUTC(isoDate) + n * 86400000));
}

// ---------------------------------------------------------------------------
// Week / block classification
// ---------------------------------------------------------------------------

/**
 * Which programme block's prescriptions apply in a given week.
 * Week 13 is the deload/retest week and runs Block 1 loads at half volume,
 * per "cut volume to roughly half of Block 1, keep loads light".
 */
export function blockForWeek(weekInCycle) {
  if (weekInCycle <= 4) return 1;
  if (weekInCycle <= 8) return 2;
  if (weekInCycle <= 12) return 3;
  return 1;
}

/** The block label to show the user — distinguishes week 13 from Block 1. */
export function blockMetaForWeek(weekInCycle) {
  if (weekInCycle >= DELOAD_WEEK) return BLOCKS[4];
  return BLOCKS[blockForWeek(weekInCycle)];
}

export function isConsolidationWeek(weekInCycle) {
  return CONSOLIDATION_WEEKS.includes(weekInCycle);
}

export function isDeloadWeek(weekInCycle) {
  return weekInCycle >= DELOAD_WEEK;
}

/** Reduced-set count for consolidation (x0.75) and deload (x0.5) weeks. */
export function scaledSets(baseSets, weekInCycle) {
  if (isDeloadWeek(weekInCycle)) {
    return Math.max(1, Math.round(baseSets * DELOAD_SET_FACTOR));
  }
  if (isConsolidationWeek(weekInCycle)) {
    return Math.max(2, Math.round(baseSets * CONSOLIDATION_SET_FACTOR));
  }
  return baseSets;
}

/** The day on which the calendar backstop forces entry into `week`. */
export function calendarCeilingDay(week) {
  return (week + GRACE_WEEKS - 1) * 7;
}

// ---------------------------------------------------------------------------
// Core derivation
// ---------------------------------------------------------------------------

export function activeCycle(data) {
  const open = data.cycles.filter((cy) => !cy.endedAt);
  if (open.length === 0) return null;
  // Defensive: if more than one cycle is somehow open (a merge of two devices
  // that each started a cycle), the highest number wins and the rest are
  // reported so the UI can surface it rather than silently picking.
  return open.reduce((a, b) => (b.cycleNumber > a.cycleNumber ? b : a));
}

export function sessionsInCycle(data, cycleNumber) {
  return data.sessions
    .filter((s) => s.cycleNumber === cycleNumber)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function skipsInCycle(data, cycleNumber) {
  return data.skips.filter((s) => s.cycleNumber === cycleNumber);
}

/**
 * The whole derived state of the programme as of `today`.
 *
 * The hybrid deload trigger (PRD 4.4) lives in the three lines computing
 * sessionWeek / calendarWeek / weekInCycle:
 *
 *   sessionWeek  — 3 consumed slots = 1 week. Tracks work done, ignores time.
 *   calendarWeek — 7 days = 1 week, less a 2-week grace. Tracks time only.
 *   weekInCycle  — max of the two: whichever arrives first.
 *
 * Neither alone is correct. Session-only means a three-week break leaves you
 * stuck mid-week-2 forever and never reaching a recovery week. Calendar-only
 * means one quiet week shunts you into a deload you haven't earned.
 */
export function deriveState(data, today = toISODate()) {
  const cycle = activeCycle(data);
  if (!cycle) {
    return { started: false, cycle: null, cycleNumber: null };
  }

  const sessions = sessionsInCycle(data, cycle.cycleNumber);
  const skips = skipsInCycle(data, cycle.cycleNumber);

  const daysSinceStart = Math.max(0, daysBetween(cycle.startDate, today));

  // Slots explicitly accounted for: done, or deliberately marked missed.
  const explicitSlots = sessions.length + skips.length;

  const sessionWeek = Math.floor(explicitSlots / SESSIONS_PER_WEEK) + 1;
  const calendarWeek = Math.floor(daysSinceStart / 7) + 1 - GRACE_WEEKS;

  const weekInCycle = Math.min(
    WEEKS_PER_CYCLE,
    Math.max(1, sessionWeek, calendarWeek)
  );

  // Where we are in the A/B/C rotation. Within a week the rotation advances
  // one slot at a time. When the calendar backstop pushes us into a new week
  // ahead of the session count, the slot index snaps to that week's boundary —
  // so a new week always opens on Day A, and the sessions skipped over are
  // dropped rather than made up (confirmed with Nick; no cramming, per the
  // programme's own rule). That can mean repeating a day type across the gap.
  const weekBoundarySlot = (weekInCycle - 1) * SESSIONS_PER_WEEK;
  const slotIndex = Math.max(explicitSlots, weekBoundarySlot);
  const droppedSlots = slotIndex - explicitSlots;
  const snappedToWeekBoundary = droppedSlots > 0;

  const dayType = DAY_TYPES[slotIndex % SESSIONS_PER_WEEK];

  const lastSession = sessions.length ? sessions[sessions.length - 1] : null;
  const lastSessionDate = lastSession ? lastSession.date : cycle.startDate;
  const daysSinceLastSession = Math.max(0, daysBetween(lastSessionDate, today));

  return {
    started: true,
    today,
    cycle,
    cycleNumber: cycle.cycleNumber,
    weekInCycle,
    sessionWeek,
    calendarWeek,
    // Which arm of the hybrid trigger is currently governing. Surfaced in the
    // UI so an unexpected week jump reads as the rule working, not a bug.
    weekDrivenBy: calendarWeek > sessionWeek ? 'calendar' : 'sessions',
    block: blockForWeek(weekInCycle),
    blockMeta: blockMetaForWeek(weekInCycle),
    isConsolidation: isConsolidationWeek(weekInCycle),
    isDeload: isDeloadWeek(weekInCycle),
    slotIndex,
    dayType,
    day: getDay(dayType),
    droppedSlots,
    snappedToWeekBoundary,
    daysSinceStart,
    daysSinceLastSession,
    lastSessionDate: lastSession ? lastSession.date : null,
    completedSessions: sessions.length,
    skippedSessions: skips.length,
    scheduledSessions: slotIndex,
    adherence: slotIndex === 0 ? null : sessions.length / slotIndex,
    ...deloadCountdown(weekInCycle, slotIndex, daysSinceStart),
    cycleComplete: isCycleComplete(weekInCycle, explicitSlots),
  };
}

/**
 * Week 13 is the last week. The cycle is ready to close once week 13's
 * (reduced) session slots are accounted for.
 */
function isCycleComplete(weekInCycle, explicitSlots) {
  return (
    weekInCycle >= WEEKS_PER_CYCLE &&
    explicitSlots >= WEEKS_PER_CYCLE * SESSIONS_PER_WEEK
  );
}

/**
 * Distance to the next reduced-volume week, by both arms of the trigger.
 * Both are reported because "whichever comes first" is only meaningful to the
 * user if they can see both numbers.
 */
function deloadCountdown(weekInCycle, slotIndex, daysSinceStart) {
  const upcoming = [...CONSOLIDATION_WEEKS, DELOAD_WEEK].find(
    (w) => w >= weekInCycle
  );

  if (upcoming === undefined) {
    return { nextReducedWeek: null, sessionsUntilReduced: null, daysUntilReduced: null };
  }
  if (upcoming === weekInCycle) {
    return { nextReducedWeek: upcoming, sessionsUntilReduced: 0, daysUntilReduced: 0 };
  }

  return {
    nextReducedWeek: upcoming,
    sessionsUntilReduced: Math.max(
      0,
      (upcoming - 1) * SESSIONS_PER_WEEK - slotIndex
    ),
    daysUntilReduced: Math.max(0, calendarCeilingDay(upcoming) - daysSinceStart),
  };
}

// ---------------------------------------------------------------------------
// Missed sessions (PRD 4.4)
// ---------------------------------------------------------------------------

/**
 * "Missed" is a calendar-gap judgment, not a count of sessions skipped in a
 * row — a gap could be one missed session on a normal cadence or zero missed
 * sessions during a planned break, and it is elapsed time that determines how
 * much readiness was lost.
 */
export function missedSessionPrompt(state, dismissedOn = null) {
  if (!state.started) return null;
  if (state.daysSinceLastSession < MISSED_PROMPT_DAYS) return null;
  if (dismissedOn === state.today) return null;

  return {
    dayType: state.dayType,
    weekInCycle: state.weekInCycle,
    daysSinceLastSession: state.daysSinceLastSession,
    lastSessionDate: state.lastSessionDate,
    options: ['missed', 'do-now', 'not-logged'],
  };
}

/**
 * 2+ weeks with no session: suggest — never auto-apply — dropping back to the
 * previous block's loads for the first session back.
 */
export function reEntryDeloadSuggestion(state) {
  if (!state.started) return null;
  if (state.daysSinceLastSession < RE_ENTRY_GAP_DAYS) return null;

  const currentBlock = state.block;
  const suggestedBlock = Math.max(1, currentBlock - 1);

  return {
    daysOff: state.daysSinceLastSession,
    currentBlock,
    suggestedBlock,
    // In Block 1 there is no previous block to drop to; suggest reduced volume
    // at the same loads instead, which is the nearest equivalent easing-in.
    reducedVolumeOnly: suggestedBlock === currentBlock,
    applied: false,
  };
}

// ---------------------------------------------------------------------------
// Session prescription
// ---------------------------------------------------------------------------

/**
 * The concrete prescription for a session: the day's exercises with the block
 * cell that applies, set counts adjusted for consolidation/deload weeks, and
 * any per-cycle load override.
 *
 * `target` is always the verbatim source string from the programme document.
 * `sets` may differ from the source on reduced-volume weeks, and when it does
 * `setsAdjustedFrom` records the original so the UI can show both.
 */
export function prescriptionFor(state, data) {
  const blockNo = blockForWeek(state.weekInCycle);
  const overrides = (state.cycle && state.cycle.loadOverrides) || {};

  const exercises = state.day.exercises
    .map((ex) => {
      const cell = ex.blocks[blockNo];
      if (!cell) return null; // not programmed in this block (e.g. "—")

      const sets = scaledSets(cell.sets, state.weekInCycle);
      const overrideKey = `${state.dayType}:${ex.id}`;
      const override = overrides[overrideKey];
      const carried = carryForwardLoad(data, state.cycleNumber, state.dayType, ex.id);

      return {
        exerciseId: ex.id,
        name: ex.name,
        note: ex.note,
        target: cell.source,
        sets,
        setsAdjustedFrom: sets !== cell.sets ? cell.sets : null,
        reps: cell.reps,
        unit: cell.unit,
        perSide: cell.perSide,
        intent: cell.intent || null,
        prescribedLoadKg: cell.loadKg,
        // Pre-fill precedence: explicit override for this cycle, then the
        // weight carried forward from the previous cycle, then the
        // programme's own prescription.
        suggestedLoadKg: override ?? carried ?? topOf(cell.loadKg),
        loadSource: override != null ? 'override' : carried != null ? 'carry-forward' : 'programme',
      };
    })
    .filter(Boolean);

  return {
    dayType: state.dayType,
    dayName: state.day.name,
    purpose: state.day.purpose,
    timeNote: state.day.timeNote,
    weekInCycle: state.weekInCycle,
    block: blockNo,
    isConsolidation: state.isConsolidation,
    isDeload: state.isDeload,
    exercises,
  };
}

function topOf(loadKg) {
  if (loadKg == null) return null;
  return Array.isArray(loadKg) ? loadKg[loadKg.length - 1] : loadKg;
}

/**
 * Progression default for a new cycle (PRD 4.1): the last logged working
 * weight for the equivalent day/exercise from the previous cycle's final
 * block. "Working weight" is read as the heaviest weight logged in that
 * session — the top set — since that is what a progression decision hangs on.
 *
 * Returns null for cycle 1, or where the exercise was never logged in the
 * previous cycle's Block 3.
 */
export function carryForwardLoad(data, cycleNumber, dayType, exerciseId) {
  if (cycleNumber <= 1) return null;

  const prior = data.sessions
    .filter(
      (s) =>
        s.cycleNumber === cycleNumber - 1 &&
        s.dayType === dayType &&
        blockForWeek(s.weekInCycle) === 3
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (let i = prior.length - 1; i >= 0; i--) {
    const entry = (prior[i].exercises || []).find((e) => e.exerciseId === exerciseId);
    if (!entry) continue;
    const weights = (entry.sets || [])
      .map((s) => s.kg)
      .filter((kg) => typeof kg === 'number' && kg > 0);
    if (weights.length) return Math.max(...weights);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lifetime totals (PRD 4.7)
// ---------------------------------------------------------------------------

export function lifetimeStats(data) {
  const completedCycles = data.cycles.filter((cy) => cy.endedAt).length;
  return {
    completedCycles,
    currentCycle: activeCycle(data)?.cycleNumber ?? null,
    totalSessions: data.sessions.length,
    totalSkipped: data.skips.length,
    firstSessionDate: data.sessions.length
      ? data.sessions.map((s) => s.date).sort()[0]
      : null,
  };
}

/** Retest deltas across cycles — direction only, never a pass/fail judgment. */
export function retestComparison(data) {
  const sorted = [...data.retests].sort((a, b) => a.cycleNumber - b.cycleNumber);
  return sorted.map((entry, i) => {
    const prev = i > 0 ? sorted[i - 1] : null;
    const deltas = {};
    if (prev) {
      for (const key of Object.keys(entry.metrics || {})) {
        const now = entry.metrics[key];
        const before = prev.metrics?.[key];
        if (typeof now === 'number' && typeof before === 'number') {
          const diff = now - before;
          deltas[key] = {
            diff,
            direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'unchanged',
          };
        }
      }
    }
    return { ...entry, comparedTo: prev?.cycleNumber ?? null, deltas };
  });
}
