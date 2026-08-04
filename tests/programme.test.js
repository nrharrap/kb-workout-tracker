/**
 * T12 — "Compare every exercise/set/rep/load value shown in-app, Block 1/2/3,
 * Days A/B/C. Matches the markdown programme document exactly, no
 * transcription errors."
 *
 * Rather than assert against values retyped by hand — which would only check a
 * transcription against itself — this parses the actual source markdown and
 * diffs it cell by cell against programme.js.
 *
 * The source lives in Nick's Drive folder, outside the repo, and is not
 * committed. tests/fixtures/source-programme.md is a gitignored symlink to it;
 * when that's absent the parse test reports as skipped.
 */

import { test, assert } from './harness.js';
import { DAYS, DAY_TYPES, WARMUP, RETEST_METRICS } from '../js/programme.js';

const SOURCE_URL = './fixtures/source-programme.md';

/** Extract `| a | b | c |` rows from the table under each `## DAY X` heading. */
function parseSourceTables(markdown) {
  const days = {};
  let current = null;

  for (const line of markdown.split('\n')) {
    const heading = line.match(/^##\s+DAY\s+([ABC])\s+—/);
    if (heading) {
      current = heading[1];
      days[current] = [];
      continue;
    }
    if (/^##\s/.test(line)) {
      current = null;
      continue;
    }
    if (!current || !line.trim().startsWith('|')) continue;

    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    if (cells[0] === 'Exercise') continue;
    if (cells.every((c) => /^-+$/.test(c))) continue;

    days[current].push({ name: cells[0], blocks: [cells[1], cells[2], cells[3]], note: cells[4] });
  }
  return days;
}

async function loadSource() {
  try {
    const res = await fetch(SOURCE_URL);
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes('## DAY A') ? text : null;
  } catch {
    return null;
  }
}

test('T12 — every block cell matches the source markdown exactly', async () => {
  const markdown = await loadSource();
  if (!markdown) {
    console.warn('T12 parse check SKIPPED — tests/fixtures/source-programme.md not reachable');
    return;
  }

  const source = parseSourceTables(markdown);

  for (const dayType of DAY_TYPES) {
    const rows = source[dayType];
    const appExercises = DAYS[dayType].exercises;

    assert.ok(rows && rows.length, `no source rows parsed for Day ${dayType}`);
    assert.equal(appExercises.length, rows.length, `Day ${dayType}: exercise count differs from source`);

    rows.forEach((row, i) => {
      const ex = appExercises[i];
      assert.equal(ex.name, row.name, `Day ${dayType} row ${i + 1}: exercise name`);
      assert.equal(ex.note, row.note, `Day ${dayType} — ${row.name}: notes column`);

      row.blocks.forEach((cellText, bi) => {
        const block = bi + 1;
        const cell = ex.blocks[block];
        if (cellText === '—') {
          assert.equal(cell, null, `Day ${dayType} — ${row.name}, Block ${block}: source is "—", app must have no prescription`);
          return;
        }
        assert.ok(cell, `Day ${dayType} — ${row.name}, Block ${block}: missing in app`);
        assert.equal(cell.source, cellText, `Day ${dayType} — ${row.name}, Block ${block}: prescription text`);
      });
    });
  }
});

test('T12 — parsed set/rep fields agree with the verbatim source string', () => {
  for (const dayType of DAY_TYPES) {
    for (const ex of DAYS[dayType].exercises) {
      for (const block of [1, 2, 3]) {
        const cell = ex.blocks[block];
        if (!cell) continue;

        // Every prescription in this programme opens "<sets>x<reps>".
        const m = cell.source.match(/^(\d+)x([\dA-Za-z-]+)/);
        assert.ok(m, `${ex.name} B${block}: source "${cell.source}" not in NxM form`);
        assert.equal(cell.sets, Number(m[1]), `${ex.name} B${block}: sets`);

        const reps = m[2];
        const distance = reps.match(/^(\d+)m$/);
        if (distance) {
          // The rack carry is prescribed as a distance, not a rep count.
          assert.equal(String(cell.reps), distance[1], `${ex.name} B${block}: distance`);
          assert.equal(cell.unit, 'm', `${ex.name} B${block}: unit`);
        } else if (/^\d+$/.test(reps)) {
          assert.equal(String(cell.reps), reps, `${ex.name} B${block}: reps`);
          assert.equal(cell.unit, 'reps', `${ex.name} B${block}: unit`);
        } else {
          assert.equal(cell.reps, reps, `${ex.name} B${block}: non-numeric reps (AMRAP)`);
        }

        assert.equal(
          cell.perSide,
          cell.source.includes('/side'),
          `${ex.name} B${block}: perSide should track "/side" in the source`
        );
      }
    }
  }
});

test('T12 — the standing med ball throw is absent from Block 1 only', () => {
  const ex = DAYS.C.exercises.find((e) => e.id === 'standing-med-ball-rotational-throw');
  assert.isNull(ex.blocks[1], 'source shows "—" for Block 1');
  assert.ok(ex.blocks[2], 'added from Block 2');
  assert.ok(ex.blocks[3]);
});

test('warm-up and retest metrics are complete', () => {
  assert.equal(WARMUP.length, 6, 'the warm-up is a 6-item checklist');
  // PRD 4.6 counts 5 metrics but treats both SL-RDL sides as one line item;
  // they are stored separately here because each side is timed on its own.
  assert.equal(RETEST_METRICS.length, 6);
  assert.deepEqual(
    RETEST_METRICS.map((m) => m.id),
    ['kbSwing60s', 'plankHold', 'slRdlLeft', 'slRdlRight', 'sitAndReach', 'soreness']
  );
  assert.equal(
    RETEST_METRICS.find((m) => m.id === 'soreness').better,
    'down',
    'less soreness is an improvement; direction matters for the delta arrow'
  );
});

test('exercise ids are unique across the whole programme', () => {
  const ids = DAY_TYPES.flatMap((t) => DAYS[t].exercises.map((e) => e.id));
  assert.equal(new Set(ids).size, ids.length, 'a duplicate id would collide in logs');
});
