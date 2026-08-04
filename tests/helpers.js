/** Fixture builders shared across the test suite. */

import { emptyData } from '../js/schema.js';
import { addDays } from '../js/model.js';

export const START = '2026-01-05';

export function makeData({ startDate = START, cycleNumber = 1 } = {}) {
  const data = emptyData('2026-01-05T08:00:00.000Z');
  data.cycles.push({ cycleNumber, startDate, endedAt: null, loadOverrides: {} });
  return data;
}

export function makeSession({
  cycleNumber = 1,
  date,
  dayType,
  weekInCycle = 1,
  exercises = [],
  loggedAt = `${date}T18:00:00.000Z`,
} = {}) {
  return {
    cycleNumber,
    date,
    dayType,
    weekInCycle,
    slotIndex: null,
    golfTomorrow: false,
    golfToday: false,
    warmup: [],
    exercises,
    loggedAt,
    updatedAt: loggedAt,
  };
}

/**
 * Fill a cycle with `count` sessions on a fixed cadence from the start date,
 * following the natural A/B/C rotation.
 */
export function fillSessions(data, count, { cadenceDays = 2, startDate = START } = {}) {
  const types = ['A', 'B', 'C'];
  for (let i = 0; i < count; i++) {
    data.sessions.push(
      makeSession({
        cycleNumber: data.cycles[0].cycleNumber,
        date: addDays(startDate, i * cadenceDays),
        dayType: types[i % 3],
        weekInCycle: Math.floor(i / 3) + 1,
      })
    );
  }
  return data;
}

export function withSets(exerciseId, sets) {
  return { exerciseId, sets, note: '' };
}
