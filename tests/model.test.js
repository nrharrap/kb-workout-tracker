/**
 * Cycle logic, deload triggers and missed-session handling.
 * Covers T13, T14, T20-T25, T28 and the set-scaling rules.
 */

import { test, assert } from './harness.js';
import { makeData, makeSession, fillSessions, withSets, START } from './helpers.js';
import {
  deriveState,
  missedSessionPrompt,
  reEntryDeloadSuggestion,
  prescriptionFor,
  carryForwardLoad,
  scaledSets,
  blockForWeek,
  calendarCeilingDay,
  lifetimeStats,
  retestComparison,
  addDays,
  daysBetween,
  GRACE_WEEKS,
} from '../js/model.js';

// --- date helpers -----------------------------------------------------------

test('date maths is DST-proof', () => {
  // 2026-03-29 is the UK clock change; a naive local-midnight diff returns 0.
  assert.equal(daysBetween('2026-03-28', '2026-03-29'), 1);
  assert.equal(daysBetween('2026-10-24', '2026-10-25'), 1);
  assert.equal(daysBetween('2026-01-05', '2026-01-05'), 0);
  assert.equal(daysBetween('2026-01-05', '2026-01-04'), -1);
  assert.equal(addDays('2026-02-28', 1), '2026-03-01', '2026 is not a leap year');
});

// --- block classification ---------------------------------------------------

test('weeks map to the right block', () => {
  assert.deepEqual([1, 2, 3, 4].map(blockForWeek), [1, 1, 1, 1]);
  assert.deepEqual([5, 6, 7, 8].map(blockForWeek), [2, 2, 2, 2]);
  assert.deepEqual([9, 10, 11, 12].map(blockForWeek), [3, 3, 3, 3]);
  assert.equal(blockForWeek(13), 1, 'week 13 runs Block 1 loads at half volume');
});

test('consolidation and deload weeks scale sets, normal weeks do not', () => {
  assert.equal(scaledSets(4, 3), 4, 'normal week untouched');
  assert.equal(scaledSets(4, 4), 3, 'consolidation: 4 -> 3');
  assert.equal(scaledSets(3, 4), 2, 'consolidation: 3 -> 2');
  assert.equal(scaledSets(2, 8), 2, 'consolidation never drops below 2');
  assert.equal(scaledSets(5, 12), 4, 'consolidation: 5 -> 4');
  assert.equal(scaledSets(4, 13), 2, 'deload: half volume');
  assert.equal(scaledSets(2, 13), 1, 'deload can drop to a single set');
});

test('the calendar backstop for week 4 lands on day 35, per the PRD example', () => {
  assert.equal(GRACE_WEEKS, 2);
  assert.equal(calendarCeilingDay(4), 35);
  assert.equal(calendarCeilingDay(8), 63);
  assert.equal(calendarCeilingDay(13), 98);
});

// --- baseline derivation ----------------------------------------------------

test('a brand-new cycle opens on week 1, Day A', () => {
  const state = deriveState(makeData(), START);
  assert.equal(state.started, true);
  assert.equal(state.weekInCycle, 1);
  assert.equal(state.dayType, 'A');
  assert.equal(state.block, 1);
  assert.equal(state.slotIndex, 0);
  assert.isNull(state.adherence, 'no adherence figure before anything is scheduled');
});

test('with no cycle started at all, nothing is derived', () => {
  const state = deriveState({ cycles: [], sessions: [], skips: [], retests: [], deleted: [] }, START);
  assert.equal(state.started, false);
});

test('the A/B/C rotation advances one slot at a time within a week', () => {
  const data = makeData();
  const at = (n) => deriveState(data, addDays(START, n));

  assert.equal(at(0).dayType, 'A');
  data.sessions.push(makeSession({ date: START, dayType: 'A' }));
  assert.equal(at(2).dayType, 'B');
  data.sessions.push(makeSession({ date: addDays(START, 2), dayType: 'B' }));
  assert.equal(at(4).dayType, 'C');
});

// --- T23 / T24: the hybrid deload trigger ----------------------------------

test('T23 — week 4 arrives by session count before day 35', () => {
  const data = fillSessions(makeData(), 9, { cadenceDays: 2 }); // 9 sessions over 16 days
  const state = deriveState(data, addDays(START, 21));

  assert.equal(state.weekInCycle, 4, 'three weeks of sessions completed');
  assert.equal(state.weekDrivenBy, 'sessions');
  assert.equal(state.isConsolidation, true);
  assert.equal(state.droppedSlots, 0, 'nothing skipped — session path took us here');
  assert.equal(state.daysSinceStart < 35, true, 'arrived ahead of the calendar ceiling');
});

test('T24 — week 4 arrives by the calendar ceiling when training is inconsistent', () => {
  const data = makeData();
  // Six sessions spread thinly across five weeks: only two weeks' worth of work.
  ['A', 'B', 'C', 'A', 'B', 'C'].forEach((dayType, i) => {
    data.sessions.push(makeSession({ date: addDays(START, i * 5), dayType, weekInCycle: Math.floor(i / 3) + 1 }));
  });

  const before = deriveState(data, addDays(START, 34));
  assert.equal(before.weekInCycle, 3, 'day 34: backstop has not bitten yet');

  const state = deriveState(data, addDays(START, 35));
  assert.equal(state.weekInCycle, 4, 'day 35: calendar forces the consolidation week');
  assert.equal(state.weekDrivenBy, 'calendar');
  assert.equal(state.isConsolidation, true);
  assert.equal(state.sessionWeek, 3, 'session count alone would still say week 3');
  assert.equal(state.droppedSlots, 3, 'week 3 sessions are dropped, not made up');
});

test('the calendar jump snaps the rotation back to Day A', () => {
  const data = makeData();
  // One session done, then a long gap.
  data.sessions.push(makeSession({ date: START, dayType: 'A' }));

  const state = deriveState(data, addDays(START, 21));
  assert.equal(state.weekInCycle, 2);
  assert.equal(state.dayType, 'A', 'a new week always opens on Day A, repeating A across the gap');
  assert.equal(state.snappedToWeekBoundary, true);
  assert.equal(state.droppedSlots, 2, 'B and C were passed over, not queued up');
});

test('the week counter never runs backwards', () => {
  const data = fillSessions(makeData(), 12, { cadenceDays: 2 });
  let previous = 0;
  for (let d = 0; d <= 120; d++) {
    const week = deriveState(data, addDays(START, d)).weekInCycle;
    assert.ok(week >= previous, `week went backwards at day ${d}: ${previous} -> ${week}`);
    previous = week;
  }
  assert.equal(previous, 13, 'the cycle tops out at week 13');
});

// --- T20 / T21 / T22 / T25: missed sessions ---------------------------------

test('T20 — a five-day gap prompts the missed-session question', () => {
  const data = makeData();
  data.sessions.push(makeSession({ date: START, dayType: 'A' }));

  const quiet = deriveState(data, addDays(START, 3));
  assert.isNull(missedSessionPrompt(quiet), 'a normal 2-3 day cadence must not prompt');

  const state = deriveState(data, addDays(START, 5));
  const prompt = missedSessionPrompt(state);
  assert.ok(prompt, 'five days without a session should prompt');
  assert.equal(prompt.dayType, 'B');
  assert.equal(prompt.weekInCycle, 1);
  assert.equal(prompt.daysSinceLastSession, 5);
  assert.deepEqual(prompt.options, ['missed', 'do-now', 'not-logged']);
});

test('T20 — dismissing the prompt suppresses it for that day only', () => {
  const data = makeData();
  data.sessions.push(makeSession({ date: START, dayType: 'A' }));
  const state = deriveState(data, addDays(START, 5));

  assert.isNull(missedSessionPrompt(state, state.today), 'dismissed today');
  assert.ok(missedSessionPrompt(state, addDays(state.today, -1)), 'yesterday\'s dismissal has expired');
});

test('T21 — "missed, skip it" advances the rotation and drops adherence', () => {
  const data = makeData();
  data.sessions.push(makeSession({ date: START, dayType: 'A' }));

  const before = deriveState(data, addDays(START, 5));
  assert.equal(before.dayType, 'B');
  assert.equal(before.adherence, 1, 'one scheduled, one done');

  data.skips.push({ cycleNumber: 1, slotIndex: 1, dayType: 'B', weekInCycle: 1, markedAt: '2026-01-10T09:00:00.000Z' });

  const after = deriveState(data, addDays(START, 5));
  assert.equal(after.dayType, 'C', 'you do the next session, not the missed one');
  assert.equal(after.completedSessions, 1);
  assert.equal(after.scheduledSessions, 2);
  assert.equal(after.adherence, 0.5, 'adherence drops accordingly');
});

test('T22 — "do it now instead" changes nothing; the session is already today\'s', () => {
  const data = makeData();
  data.sessions.push(makeSession({ date: START, dayType: 'A' }));

  const before = deriveState(data, addDays(START, 5));
  const after = deriveState(data, addDays(START, 5)); // no state written
  assert.equal(after.dayType, before.dayType);
  assert.equal(after.slotIndex, before.slotIndex);
  assert.equal(after.adherence, before.adherence);
});

test('T25 — 15 days without a session suggests a re-entry deload, unapplied', () => {
  // Far enough in to be in Block 2, so there is a previous block to drop to.
  const data = fillSessions(makeData(), 15, { cadenceDays: 2 });
  const lastDate = data.sessions[data.sessions.length - 1].date;

  const recent = deriveState(data, addDays(lastDate, 13));
  assert.isNull(reEntryDeloadSuggestion(recent), 'under two weeks: no nudge');

  const state = deriveState(data, addDays(lastDate, 15));
  const suggestion = reEntryDeloadSuggestion(state);
  assert.ok(suggestion, '15 days off should flag');
  assert.equal(suggestion.daysOff, 15);
  assert.equal(suggestion.applied, false, 'suggested, never auto-applied');
  assert.equal(state.block, 2, 'fixture is mid-Block-2');
  assert.equal(suggestion.suggestedBlock, 1, 'drop back to the previous block');
  assert.equal(suggestion.reducedVolumeOnly, false);
});

test('T25 — in Block 1 there is no previous block, so it suggests reduced volume', () => {
  const data = makeData();
  data.sessions.push(makeSession({ date: START, dayType: 'A' }));
  const state = deriveState(data, addDays(START, 16));

  const suggestion = reEntryDeloadSuggestion(state);
  assert.ok(suggestion);
  assert.equal(suggestion.currentBlock, 1);
  assert.equal(suggestion.reducedVolumeOnly, true);
});

// --- T13: cycle rollover ----------------------------------------------------

test('T13 — completing week 13 marks the cycle ready to close', () => {
  const data = fillSessions(makeData(), 39, { cadenceDays: 2 }); // 13 weeks x 3
  const state = deriveState(data, addDays(START, 90));

  assert.equal(state.weekInCycle, 13);
  assert.equal(state.isDeload, true);
  assert.equal(state.blockMeta.name, 'Deload/Retest');
  assert.equal(state.cycleComplete, true, 'app should now offer to start cycle 2');
});

test('T13 — starting cycle 2 resets the week and increments the cycle', () => {
  const data = fillSessions(makeData(), 39, { cadenceDays: 2 });
  data.cycles[0].endedAt = '2026-04-10T09:00:00.000Z';
  data.cycles.push({ cycleNumber: 2, startDate: '2026-04-11', endedAt: null, loadOverrides: {} });

  const state = deriveState(data, '2026-04-11');
  assert.equal(state.cycleNumber, 2);
  assert.equal(state.weekInCycle, 1, 'week resets');
  assert.equal(state.block, 1);
  assert.equal(state.dayType, 'A');
  assert.equal(state.completedSessions, 0, 'cycle 1 sessions do not count against cycle 2');
});

test('cycle 1 history survives the rollover', () => {
  const data = fillSessions(makeData(), 39, { cadenceDays: 2 });
  data.cycles[0].endedAt = '2026-04-10T09:00:00.000Z';
  data.cycles.push({ cycleNumber: 2, startDate: '2026-04-11', endedAt: null, loadOverrides: {} });

  const stats = lifetimeStats(data);
  assert.equal(stats.completedCycles, 1);
  assert.equal(stats.currentCycle, 2);
  assert.equal(stats.totalSessions, 39, 'lifetime totals span cycles');
});

// --- T14: progression carry-forward ----------------------------------------

test('T14 — cycle 2 targets default to the last working weight from cycle 1 Block 3', () => {
  const data = makeData();
  data.cycles[0].endedAt = '2026-04-10T09:00:00.000Z';
  data.cycles.push({ cycleNumber: 2, startDate: '2026-04-11', endedAt: null, loadOverrides: {} });

  // A Block 3 (week 9-12) Day A session from cycle 1, top set at 24kg.
  data.sessions.push(
    makeSession({
      cycleNumber: 1,
      date: '2026-03-20',
      dayType: 'A',
      weekInCycle: 11,
      exercises: [withSets('kb-swing-2h', [{ kg: 20, reps: 8 }, { kg: 24, reps: 8 }, { kg: 24, reps: 6 }])],
    })
  );

  assert.equal(carryForwardLoad(data, 2, 'A', 'kb-swing-2h'), 24, 'top set carries forward');
  assert.isNull(carryForwardLoad(data, 1, 'A', 'kb-swing-2h'), 'cycle 1 has nothing to carry from');
  assert.isNull(carryForwardLoad(data, 2, 'A', 'barbell-rdl'), 'unlogged exercise carries nothing');

  const state = deriveState(data, '2026-04-11');
  const swing = prescriptionFor(state, data).exercises.find((e) => e.exerciseId === 'kb-swing-2h');
  assert.equal(swing.suggestedLoadKg, 24);
  assert.equal(swing.loadSource, 'carry-forward');
});

test('T14 — a per-cycle override beats the carried-forward weight', () => {
  const data = makeData();
  data.cycles[0].endedAt = '2026-04-10T09:00:00.000Z';
  data.cycles.push({
    cycleNumber: 2,
    startDate: '2026-04-11',
    endedAt: null,
    loadOverrides: { 'A:kb-swing-2h': 16 },
  });
  data.sessions.push(
    makeSession({
      cycleNumber: 1, date: '2026-03-20', dayType: 'A', weekInCycle: 11,
      exercises: [withSets('kb-swing-2h', [{ kg: 24, reps: 8 }])],
    })
  );

  const state = deriveState(data, '2026-04-11');
  const swing = prescriptionFor(state, data).exercises.find((e) => e.exerciseId === 'kb-swing-2h');
  assert.equal(swing.suggestedLoadKg, 16);
  assert.equal(swing.loadSource, 'override');
});

// --- T17: prescriptions show the right block -------------------------------

test('T17 — a Block 2 week shows Block 2 targets, not Block 1 or 3', () => {
  const data = fillSessions(makeData(), 15, { cadenceDays: 2 }); // 5 weeks done -> week 6
  const state = deriveState(data, addDays(START, 30));

  assert.equal(state.weekInCycle, 6);
  assert.equal(state.block, 2);

  const p = prescriptionFor(state, data);
  assert.equal(p.dayType, 'A');
  const swing = p.exercises.find((e) => e.exerciseId === 'kb-swing-2h');
  assert.equal(swing.target, '4x10 @ 20kg', 'the Block 2 cell, verbatim from source');
  assert.equal(swing.sets, 4, 'week 6 is not a consolidation week');
  assert.isNull(swing.setsAdjustedFrom);
});

test('a consolidation week keeps the loads and cuts the sets', () => {
  const data = fillSessions(makeData(), 9, { cadenceDays: 2 });
  const state = deriveState(data, addDays(START, 21));
  const p = prescriptionFor(state, data);

  assert.equal(p.weekInCycle, 4);
  assert.equal(p.isConsolidation, true);

  const swing = p.exercises.find((e) => e.exerciseId === 'kb-swing-2h');
  assert.equal(swing.target, '4x12 @ 16kg', 'target text still shows the programme prescription');
  assert.equal(swing.sets, 3, 'sets reduced');
  assert.equal(swing.setsAdjustedFrom, 4, 'and the original is retained so the UI can show both');
});

test('exercises not programmed in the current block are omitted', () => {
  const block1 = deriveState(makeData(), START);
  const names1 = prescriptionFor(block1, makeData()).exercises.map((e) => e.exerciseId);

  const data = fillSessions(makeData(), 15, { cadenceDays: 2 });
  const block2 = deriveState(data, addDays(START, 30));
  const names2 = prescriptionFor(block2, data).exercises.map((e) => e.exerciseId);

  assert.equal(block1.dayType, 'A');
  assert.equal(names1.includes('standing-med-ball-rotational-throw'), false);
  assert.equal(names2.includes('standing-med-ball-rotational-throw'), false, 'Day A anyway');

  // Day C in Block 1 vs Block 2 is where that exercise appears.
  const c1 = makeData();
  c1.sessions.push(makeSession({ date: START, dayType: 'A' }));
  c1.sessions.push(makeSession({ date: addDays(START, 2), dayType: 'B' }));
  const stateC1 = deriveState(c1, addDays(START, 4));
  assert.equal(stateC1.dayType, 'C');
  assert.equal(
    prescriptionFor(stateC1, c1).exercises.some((e) => e.exerciseId === 'standing-med-ball-rotational-throw'),
    false,
    'absent in Block 1'
  );

  const c2 = fillSessions(makeData(), 17, { cadenceDays: 2 });
  const stateC2 = deriveState(c2, addDays(START, 34));
  assert.equal(stateC2.block, 2);
  assert.equal(stateC2.dayType, 'C');
  assert.equal(
    prescriptionFor(stateC2, c2).exercises.some((e) => e.exerciseId === 'standing-med-ball-rotational-throw'),
    true,
    'added from Block 2'
  );
});

// --- T28: dashboard ---------------------------------------------------------

test('T28 — dashboard figures match hand-verified expectations mid-cycle', () => {
  const data = fillSessions(makeData(), 16, { cadenceDays: 2 });
  data.skips.push({ cycleNumber: 1, slotIndex: 16, dayType: 'B', weekInCycle: 6, markedAt: '2026-02-08T09:00:00.000Z' });

  const state = deriveState(data, addDays(START, 32));

  assert.equal(state.cycleNumber, 1);
  assert.equal(state.weekInCycle, 6);
  assert.equal(state.block, 2);
  assert.equal(state.completedSessions, 16);
  assert.equal(state.skippedSessions, 1);
  assert.equal(state.scheduledSessions, 17);
  assert.closeTo(state.adherence, 16 / 17, 1e-9);
  assert.equal(state.nextReducedWeek, 8);
  assert.equal(state.sessionsUntilReduced, 21 - 17, 'week 8 opens at slot 21');
  assert.equal(state.daysUntilReduced, 63 - 32, 'or day 63, whichever comes first');
});

test('the deload countdown reports zero once you are in the reduced week', () => {
  const data = fillSessions(makeData(), 9, { cadenceDays: 2 });
  const state = deriveState(data, addDays(START, 21));
  assert.equal(state.nextReducedWeek, 4);
  assert.equal(state.sessionsUntilReduced, 0);
  assert.equal(state.daysUntilReduced, 0);
});

// --- T27: retest deltas -----------------------------------------------------

test('T27 — retests compare across cycles with direction only, no verdict', () => {
  const data = makeData();
  data.retests.push({ cycleNumber: 1, date: '2026-04-05', metrics: { kbSwing60s: 40, plankHold: 60, soreness: 6 }, updatedAt: '2026-04-05T10:00:00.000Z' });
  data.retests.push({ cycleNumber: 2, date: '2026-07-05', metrics: { kbSwing60s: 48, plankHold: 60, soreness: 3 }, updatedAt: '2026-07-05T10:00:00.000Z' });

  const [first, second] = retestComparison(data);

  assert.isNull(first.comparedTo, 'nothing to compare the first cycle against');
  assert.deepEqual(first.deltas, {});

  assert.equal(second.comparedTo, 1);
  assert.equal(second.deltas.kbSwing60s.diff, 8);
  assert.equal(second.deltas.kbSwing60s.direction, 'up');
  assert.equal(second.deltas.plankHold.direction, 'unchanged');
  assert.equal(second.deltas.soreness.diff, -3);
  assert.equal(second.deltas.soreness.direction, 'down');

  const encoded = JSON.stringify(second.deltas);
  assert.equal(/pass|fail|good|bad|target/i.test(encoded), false, 'no pass/fail judgment, by design');
});
