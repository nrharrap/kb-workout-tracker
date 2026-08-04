/**
 * Programme data — transcribed verbatim from
 * "Golf Strength & Speed Programme — 90 Day.md".
 *
 * Every block cell carries `source`: the exact string from the markdown table.
 * The UI renders `source` for the target line, so what you see in the app is
 * character-for-character what the programme document says. The parsed fields
 * (sets/reps/load) exist for logic — set counts for consolidation weeks, load
 * pre-fill, progression carry-forward — never for display of the target.
 *
 * This file is read-only reference data. It contains no personal data.
 */

export const PROGRAMME_TITLE = 'Golf Strength & Speed Programme';
export const WEEKS_PER_CYCLE = 13;
export const SESSIONS_PER_WEEK = 3;
export const DAY_TYPES = ['A', 'B', 'C'];

/** Warm-up — every session, ~6 min. Checklist only, not logged in detail. */
export const WARMUP = [
  { id: 'chin-tucks', label: 'Chin tucks', prescription: '2x10' },
  { id: 'band-pull-apart', label: 'Band pull-apart / arm circles if no band', prescription: '2x12' },
  { id: 'hip-90-90', label: '90/90 hip rotations', prescription: '8 each side', note: 'Targets hip mobility directly' },
  { id: 'glute-bridge', label: 'Glute bridge', prescription: '2x10', note: 'Wakes up the glutes before hinging/squatting — key for low-back protection' },
  { id: 'cat-camel', label: 'Cat-camel', prescription: '8 reps', note: 'Spine mobility' },
  { id: 'bw-good-mornings', label: 'Bodyweight good mornings', prescription: '10 reps', note: 'Grooves the hinge pattern, primes the RDL/swing pattern' },
];

/** Week 13 retest metrics. No pass/fail thresholds — deltas only, by design. */
export const RETEST_METRICS = [
  { id: 'kbSwing60s', label: 'Max unbroken KB swings in 60 sec (16kg)', unit: 'reps', better: 'up' },
  { id: 'plankHold', label: 'Front-loaded plank hold', unit: 'sec', better: 'up' },
  { id: 'slRdlLeft', label: 'Single-leg RDL balance hold — left', unit: 'sec', better: 'up' },
  { id: 'slRdlRight', label: 'Single-leg RDL balance hold — right', unit: 'sec', better: 'up' },
  { id: 'sitAndReach', label: 'Sit-and-reach / toe-touch', unit: 'cm', better: 'up' },
  { id: 'soreness', label: 'Golf-round soreness (low back/hip/knee)', unit: '0-10', better: 'down' },
];

/**
 * Block metadata — from the "Periodization overview" table.
 */
export const BLOCKS = {
  1: { number: 1, name: 'Foundation', weeks: [1, 2, 3, 4], focus: 'Movement quality, hip/low-back/knee resilience, work capacity', load: 'Moderate', volume: 'Moderate-high', intent: 'Groove patterns, build a durable base' },
  2: { number: 2, name: 'Strength-Power', weeks: [5, 6, 7, 8], focus: 'Progressive overload, heavier KB work, rotational force', load: 'Higher', volume: 'Moderate', intent: 'Build the strength that power is built on' },
  3: { number: 3, name: 'Speed & Transfer', weeks: [9, 10, 11, 12], focus: 'Ballistic intent, faster bar/bell speed, lower fatigue cost', load: 'Moderate-high (but light-fast)', volume: 'Lower', intent: 'Convert strength into clubhead speed, arrive fresh for golf' },
  4: { number: 4, name: 'Deload/Retest', weeks: [13], focus: 'Active recovery + retest', load: 'Low', volume: 'Low', intent: 'Recover, measure, plan next block' },
};

/** Consolidation weeks — last week of each block: ~25% fewer sets, same loads. */
export const CONSOLIDATION_WEEKS = [4, 8, 12];
/** Deload/retest week. */
export const DELOAD_WEEK = 13;

// Shorthand for a block cell. `source` is verbatim markdown; the rest is parsed.
const c = (source, parsed) => ({ source, ...parsed });

export const DAYS = {
  A: {
    type: 'A',
    name: 'Posterior Chain & Hip Power',
    duration: '45 min',
    purpose: 'Build the hip-hinge/glute power that drives clubhead speed, while strengthening the exact muscles (glutes, hamstrings, low back) that protect your lower back under rotational load.',
    timeNote: 'Superset the Rack Carry and Push-ups (carry, straight into push-ups, rest, repeat) to keep this session inside 45 min with the extra exercise.',
    exercises: [
      {
        id: 'kb-swing-2h',
        name: 'KB Swing (2-hand)',
        note: 'Hinge, snap hips, let the bell float — power, not arms',
        blocks: {
          1: c('4x12 @ 16kg', { sets: 4, reps: 12, unit: 'reps', perSide: false, loadKg: 16, loadText: '16kg' }),
          2: c('4x10 @ 20kg', { sets: 4, reps: 10, unit: 'reps', perSide: false, loadKg: 20, loadText: '20kg' }),
          3: c('5x8 @ 16-20kg, max speed', { sets: 5, reps: 8, unit: 'reps', perSide: false, loadKg: [16, 20], loadText: '16-20kg', intent: 'max speed' }),
        },
      },
      {
        id: 'barbell-rdl',
        name: 'Barbell RDL',
        note: 'Soft knees, bar stays close, stop at mid-shin',
        blocks: {
          1: c('3x8 @ 30-35kg', { sets: 3, reps: 8, unit: 'reps', perSide: false, loadKg: [30, 35], loadText: '30-35kg' }),
          2: c('3x6 @ 40-45kg', { sets: 3, reps: 6, unit: 'reps', perSide: false, loadKg: [40, 45], loadText: '40-45kg' }),
          3: c('3x5 @ 35kg, fast concentric', { sets: 3, reps: 5, unit: 'reps', perSide: false, loadKg: 35, loadText: '35kg', intent: 'fast concentric' }),
        },
      },
      {
        id: 'single-leg-kb-rdl',
        name: 'Single-Leg KB RDL',
        note: 'Balance first, then load — direct knee/hip stability work',
        blocks: {
          1: c('3x8/side @ 12kg', { sets: 3, reps: 8, unit: 'reps', perSide: true, loadKg: 12, loadText: '12kg' }),
          2: c('3x8/side @ 12-16kg', { sets: 3, reps: 8, unit: 'reps', perSide: true, loadKg: [12, 16], loadText: '12-16kg' }),
          3: c('2x8/side @ 12kg', { sets: 2, reps: 8, unit: 'reps', perSide: true, loadKg: 12, loadText: '12kg' }),
        },
      },
      {
        id: 'kb-rack-carry',
        name: 'KB Rack Carry',
        note: 'Braced core, walk tall — anti-flexion, grip, low-back endurance',
        blocks: {
          1: c('2x30m @ 20kg', { sets: 2, reps: 30, unit: 'm', perSide: false, loadKg: 20, loadText: '20kg' }),
          2: c('2x40m @ 20kg', { sets: 2, reps: 40, unit: 'm', perSide: false, loadKg: 20, loadText: '20kg' }),
          3: c('2x30m @ 20kg', { sets: 2, reps: 30, unit: 'm', perSide: false, loadKg: 20, loadText: '20kg' }),
        },
      },
      {
        id: 'push-ups-bars-a',
        name: 'Push-ups (bars)',
        note: 'Superset with the carry to save time — full range on the bars',
        blocks: {
          1: c('3xAMRAP-2', { sets: 3, reps: 'AMRAP-2', unit: 'reps', perSide: false, loadKg: null, loadText: 'bodyweight' }),
          2: c('3xAMRAP-2', { sets: 3, reps: 'AMRAP-2', unit: 'reps', perSide: false, loadKg: null, loadText: 'bodyweight' }),
          3: c('3x10, tempo (3s down)', { sets: 3, reps: 10, unit: 'reps', perSide: false, loadKg: null, loadText: 'bodyweight', intent: 'tempo (3s down)' }),
        },
      },
      {
        id: 'deadbug',
        name: 'Deadbug',
        note: 'Low back protection — keep ribs down, no arch',
        blocks: {
          1: c('3x10/side', { sets: 3, reps: 10, unit: 'reps', perSide: true, loadKg: null, loadText: 'bodyweight' }),
          2: c('3x10/side', { sets: 3, reps: 10, unit: 'reps', perSide: true, loadKg: null, loadText: 'bodyweight' }),
          3: c('3x10/side (add 2s hold at extension)', { sets: 3, reps: 10, unit: 'reps', perSide: true, loadKg: null, loadText: 'bodyweight', intent: 'add 2s hold at extension' }),
        },
      },
    ],
  },

  B: {
    type: 'B',
    name: 'Rotational Strength & Anti-Rotation Core',
    duration: '45 min',
    purpose: 'The golf swing is rotation controlled by anti-rotation stability. This day trains both directions — generating rotational force safely, and resisting unwanted rotation/extension, which is what actually protects your low back through the swing.',
    timeNote: "That's 7 exercises in 45 min. Superset Half-Kneeling Press with Rotational DB Row (opposite muscle groups, no equipment clash), and Halo with Deadbug-style holds, to keep pace. If a session is running long, Lateral Goblet Squat is the first one to trim — Bulgarian Split Squat and Pallof Press are the priority pieces on this day given your goals. If your single-leg strength/balance is solid by Block 3, progress the split squat toward an assisted pistol squat (hold a rail or door frame for balance, lower under control) — same knee/hip benefit, less external load needed.",
    exercises: [
      {
        id: 'goblet-squat-rotation',
        name: 'Goblet Squat + Rotation',
        note: 'Squat tall, rotate from the top, not the low back',
        blocks: {
          1: c('3x8 @ 12kg', { sets: 3, reps: 8, unit: 'reps', perSide: false, loadKg: 12, loadText: '12kg' }),
          2: c('3x8 @ 16kg', { sets: 3, reps: 8, unit: 'reps', perSide: false, loadKg: 16, loadText: '16kg' }),
          3: c('3x6 @ 12kg, faster tempo', { sets: 3, reps: 6, unit: 'reps', perSide: false, loadKg: 12, loadText: '12kg', intent: 'faster tempo' }),
        },
      },
      {
        id: 'half-kneeling-kb-press',
        name: 'Half-Kneeling KB Press',
        note: 'Ribs down — trains anti-extension through the shoulder',
        blocks: {
          1: c('3x8/side @ 8kg', { sets: 3, reps: 8, unit: 'reps', perSide: true, loadKg: 8, loadText: '8kg' }),
          2: c('3x8/side @ 8-12kg', { sets: 3, reps: 8, unit: 'reps', perSide: true, loadKg: [8, 12], loadText: '8-12kg' }),
          3: c('2x8/side @ 8kg', { sets: 2, reps: 8, unit: 'reps', perSide: true, loadKg: 8, loadText: '8kg' }),
        },
      },
      {
        id: 'rotational-db-row',
        name: 'Rotational DB Row',
        note: 'Row + rotate through the thoracic spine, not the lumbar',
        blocks: {
          1: c('3x8/side @ 10-15kg', { sets: 3, reps: 8, unit: 'reps', perSide: true, loadKg: [10, 15], loadText: '10-15kg' }),
          2: c('3x8/side @ 12-15kg', { sets: 3, reps: 8, unit: 'reps', perSide: true, loadKg: [12, 15], loadText: '12-15kg' }),
          3: c('2x8/side @ 10kg, controlled speed', { sets: 2, reps: 8, unit: 'reps', perSide: true, loadKg: 10, loadText: '10kg', intent: 'controlled speed' }),
        },
      },
      {
        id: 'pallof-press',
        name: 'Pallof Press',
        note: "The single best anti-rotation exercise for your low back — don't rush this one",
        blocks: {
          1: c('3x10/side (band)', { sets: 3, reps: 10, unit: 'reps', perSide: true, loadKg: null, loadText: 'band' }),
          2: c('3x12/side (band, further out)', { sets: 3, reps: 12, unit: 'reps', perSide: true, loadKg: null, loadText: 'band, further out' }),
          3: c('3x8/side + 2s hold', { sets: 3, reps: 8, unit: 'reps', perSide: true, loadKg: null, loadText: 'band', intent: '+ 2s hold' }),
        },
      },
      {
        id: 'kb-halo',
        name: 'KB Halo',
        note: 'Slow and controlled — thoracic/shoulder mobility, not a strength move',
        blocks: {
          1: c('2x8/side @ 8kg', { sets: 2, reps: 8, unit: 'reps', perSide: true, loadKg: 8, loadText: '8kg' }),
          2: c('2x10/side @ 8-12kg', { sets: 2, reps: 10, unit: 'reps', perSide: true, loadKg: [8, 12], loadText: '8-12kg' }),
          3: c('2x8/side @ 8kg', { sets: 2, reps: 8, unit: 'reps', perSide: true, loadKg: 8, loadText: '8kg' }),
        },
      },
      {
        id: 'bulgarian-split-squat',
        name: 'Bulgarian Split Squat (rear foot on a low step/chair)',
        note: 'Your single-leg squat — knee tracking over the toe, most of the load through the front heel. Directly targets knee/hip resilience',
        blocks: {
          1: c('3x8/side, bodyweight-8kg goblet', { sets: 3, reps: 8, unit: 'reps', perSide: true, loadKg: [0, 8], loadText: 'bodyweight-8kg goblet' }),
          2: c('3x8/side @ 12-16kg goblet', { sets: 3, reps: 8, unit: 'reps', perSide: true, loadKg: [12, 16], loadText: '12-16kg goblet' }),
          3: c('3x6/side @ 12kg, faster tempo', { sets: 3, reps: 6, unit: 'reps', perSide: true, loadKg: 12, loadText: '12kg', intent: 'faster tempo' }),
        },
      },
      {
        id: 'lateral-goblet-squat',
        name: 'Lateral Goblet Squat',
        note: 'Stay tall, no leaning — trains the lateral hip stability golf demands',
        blocks: {
          1: c('3x6/side @ 16kg', { sets: 3, reps: 6, unit: 'reps', perSide: true, loadKg: 16, loadText: '16kg' }),
          2: c('3x6/side @ 16-20kg', { sets: 3, reps: 6, unit: 'reps', perSide: true, loadKg: [16, 20], loadText: '16-20kg' }),
          3: c('2x6/side @ 16kg', { sets: 2, reps: 6, unit: 'reps', perSide: true, loadKg: 16, loadText: '16kg' }),
        },
      },
    ],
  },

  C: {
    type: 'C',
    name: 'Total-Body Strength & Speed Transfer',
    duration: '45 min',
    purpose: 'General strength base (what everything else is built on) plus, from Block 3 onward, explosive/ballistic work that actually converts gym strength into swing speed.',
    timeNote: null,
    exercises: [
      {
        id: 'front-squat',
        name: 'Front Squat (KB or barbell)',
        note: 'Upright torso, elbows high — builds the leg/hip drive for the swing',
        blocks: {
          1: c('3x8 @ 20kg KB', { sets: 3, reps: 8, unit: 'reps', perSide: false, loadKg: 20, loadText: '20kg KB' }),
          2: c('3x6 @ barbell 30-40kg', { sets: 3, reps: 6, unit: 'reps', perSide: false, loadKg: [30, 40], loadText: 'barbell 30-40kg' }),
          3: c('3x5 @ moderate load, fast up-phase', { sets: 3, reps: 5, unit: 'reps', perSide: false, loadKg: null, loadText: 'moderate load', intent: 'fast up-phase' }),
        },
      },
      {
        id: 'db-bench-press',
        name: 'DB Bench Press',
        note: 'Control the descent, press with intent',
        blocks: {
          1: c('3x8 @ 10-12.5kg', { sets: 3, reps: 8, unit: 'reps', perSide: false, loadKg: [10, 12.5], loadText: '10-12.5kg' }),
          2: c('3x6 @ 12.5-15kg', { sets: 3, reps: 6, unit: 'reps', perSide: false, loadKg: [12.5, 15], loadText: '12.5-15kg' }),
          3: c('3x6 @ 10-12.5kg, explosive press', { sets: 3, reps: 6, unit: 'reps', perSide: false, loadKg: [10, 12.5], loadText: '10-12.5kg', intent: 'explosive press' }),
        },
      },
      {
        id: 'dead-stop-kb-swing',
        name: 'Dead-Stop KB Swing',
        note: 'Reset each rep — pure power, not conditioning',
        blocks: {
          1: c('3x8 @ 16-20kg', { sets: 3, reps: 8, unit: 'reps', perSide: false, loadKg: [16, 20], loadText: '16-20kg' }),
          2: c('3x6 @ 20kg', { sets: 3, reps: 6, unit: 'reps', perSide: false, loadKg: 20, loadText: '20kg' }),
          3: c('4x5 @ 16-20kg, max intent', { sets: 4, reps: 5, unit: 'reps', perSide: false, loadKg: [16, 20], loadText: '16-20kg', intent: 'max intent' }),
        },
      },
      {
        id: 'push-ups-bars-c',
        name: 'Push-ups (bars)',
        note: 'Full range using the bars — chest/shoulder/tricep strength',
        blocks: {
          1: c('3xAMRAP-2', { sets: 3, reps: 'AMRAP-2', unit: 'reps', perSide: false, loadKg: null, loadText: 'bodyweight' }),
          2: c('3xAMRAP-2', { sets: 3, reps: 'AMRAP-2', unit: 'reps', perSide: false, loadKg: null, loadText: 'bodyweight' }),
          3: c('3x8, explosive/plyo push if ready', { sets: 3, reps: 8, unit: 'reps', perSide: false, loadKg: null, loadText: 'bodyweight', intent: 'explosive/plyo push if ready' }),
        },
      },
      {
        id: 'rotational-med-ball-slam',
        name: 'Rotational Med Ball Slam or Throw',
        note: 'This is your speed-transfer exercise — rotate from the hips, throw with intent',
        // The markdown states no load for the med-ball work; 10kg is the only
        // med ball in the equipment list, so it is used for pre-fill only.
        blocks: {
          1: c('2x6/side, moderate effort', { sets: 2, reps: 6, unit: 'reps', perSide: true, loadKg: 10, loadText: null, intent: 'moderate effort' }),
          2: c('3x6/side, harder effort', { sets: 3, reps: 6, unit: 'reps', perSide: true, loadKg: 10, loadText: null, intent: 'harder effort' }),
          3: c('3x5/side, max speed', { sets: 3, reps: 5, unit: 'reps', perSide: true, loadKg: 10, loadText: null, intent: 'max speed' }),
        },
      },
      {
        id: 'standing-med-ball-rotational-throw',
        name: 'Standing Med Ball Rotational Throw (against wall, if space)',
        note: 'Add from Block 2 — closest gym analog to the swing itself',
        blocks: {
          // Not present in Block 1 — the markdown shows "—" for this cell.
          1: null,
          2: c('2x6/side', { sets: 2, reps: 6, unit: 'reps', perSide: true, loadKg: 10, loadText: null }),
          3: c('3x6/side, max speed', { sets: 3, reps: 6, unit: 'reps', perSide: true, loadKg: 10, loadText: null, intent: 'max speed' }),
        },
      },
    ],
  },
};

/** Progression rules, shown as reference in the app. */
export const PROGRESSION_RULES = [
  'If you hit the top of the rep range for all sets with 2+ reps in reserve two sessions in a row, add load next session (KB: next size up; barbell/DB: smallest increment available; bodyweight: add reps or slow the tempo).',
  'If a lift feels grindy or form breaks down in the last 2 reps of a set, stay at that load one more week before progressing.',
  "Consolidation weeks (4, 8, 12): same loads as the week before, just fewer total sets — don't chase PRs on these weeks.",
  'Block 3 is about speed, not load — if a KB swing or squat starts feeling slow rather than snappy, drop the weight, not the intent.',
];

/** Autoregulation rule — surfaced when the golf-tomorrow flag is set. */
export const AUTOREGULATION = {
  golfTomorrow: 'Cap effort at RPE 6-7 (2-3 reps in reserve) on everything, and drop the heaviest set of your main lift by one increment. Never test a new rep max the day before you play.',
  rpeCapMin: 6,
  rpeCapMax: 7,
  spacing: 'Leave at least one day between a main session and a round/serious practice where possible.',
  golfToday: 'If you played 18 holes or hit balls hard today, treat your next session as normal — golf itself is low systemic fatigue compared to heavy lifting.',
  noCramming: "Missed a session because of golf? Don't chain sessions back-to-back to catch up — just pick up on the next scheduled day.",
};

/** Look up a day definition by type. */
export function getDay(dayType) {
  const day = DAYS[dayType];
  if (!day) throw new Error(`Unknown day type: ${dayType}`);
  return day;
}

/** Every exercise across all days, flattened — used by the history filter. */
export function allExercises() {
  return DAY_TYPES.flatMap((t) =>
    DAYS[t].exercises.map((ex) => ({ ...ex, dayType: t }))
  );
}

export function findExercise(exerciseId) {
  return allExercises().find((ex) => ex.id === exerciseId) || null;
}
