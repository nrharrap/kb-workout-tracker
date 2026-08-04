# kb-workout-tracker

Mobile-first tracker for the Golf Strength & Speed Programme (90-day cycles).
Live at **https://nrharrap.github.io/kb-workout-tracker/**

Plain HTML/CSS/JS. No build step, no framework, no dependencies.

## How it's split

**Code** lives here in a public repo — the programme structure, exercises and
sets/reps contain no personal data.

**Your logged data** never touches this repo. It lives in a single private
`kb-workout-tracker-data.json` in your own Google Drive, written through the
Drive API under the `drive.file` scope — which means this app can only ever see
the one file it created, not the rest of your Drive.

## Files

| File | What it does |
|---|---|
| `js/programme.js` | The programme, transcribed from the source markdown. Read-only. |
| `js/model.js` | Cycle/week/block derivation, deload triggers, missed-session rules. |
| `js/merge.js` | Pure entity-level merge of local changes into a remote snapshot. |
| `js/schema.js` | `data.json` shape and the migration chain. |
| `js/sync.js` | The save flow: read-check-write with one merge retry. |
| `js/store.js` | localStorage: last-synced snapshot, pending queue, workout draft. |
| `js/drive.js` | Google sign-in (GIS) and the four Drive REST calls. |
| `js/app.js` | UI and orchestration. Renders the rules; doesn't reimplement them. |
| `sw.js` | Service worker — network-first with cache fallback. |

## Three decisions worth knowing

**Week and block are derived, never stored.** `weekInCycle`, the current block,
the next A/B/C session and adherence are all computed from sessions + skips +
the cycle start date. Sessions are additive facts, so two devices converge on
the same answer after a merge. A stored counter would not: two devices each
incrementing `weekInCycle` would land on week 5 when the truth is week 4, and
nothing would catch it.

**Deload weeks use a hybrid trigger.** `weekInCycle = max(sessionWeek,
calendarWeek)`, where the calendar arm carries a two-week grace — so week `w`
is forced by day `(w + 1) × 7`, i.e. week 4 by day 35. Session count normally
leads; the calendar stops a long break postponing a recovery week indefinitely.
When the calendar arm wins, the rotation snaps back to Day A and the sessions
passed over are dropped rather than made up — no cramming, per the programme's
own rule. That means a day type can repeat across a gap.

**The save path retries exactly once.** On a version mismatch it re-fetches,
merges, then re-checks immediately before uploading. If a third write landed in
that window it stops and shows both versions rather than looping or silently
picking one. Deletes leave tombstones so a stale device can't resurrect them.

## Running it locally

```bash
python3 -m http.server 5500
```

Then open <http://localhost:5500>. Google sign-in needs `http://localhost:5500`
listed as an authorised JavaScript origin on the OAuth client, otherwise sign-in
will fail locally while working fine on the deployed site.

## Tests

There's no Node on the build machine and the app has no build step, so the suite
runs in a browser — which is also the deployment target, so the logic is
exercised in the engine that actually runs it. Start the server above, then:

- **<http://localhost:5500/tests/run.html>** — 71 unit tests: programme data,
  cycle logic, deload triggers, merge, migrations, save flow, offline queue.
- **<http://localhost:5500/tests/integration.html>** — 11 end-to-end checks
  driving the real UI against a fake Drive and fake Google sign-in.

The integration page loads `index.html`'s own markup rather than duplicating it,
so it can't drift from the real document.

### The programme-data test

`T12` diffs every block cell against the actual source markdown rather than
against hand-retyped expectations, which would only check a transcription
against itself. It needs the source document symlinked in:

```bash
ln -s "/path/to/Golf Strength & Speed Programme — 90 Day.md" tests/fixtures/source-programme.md
```

`tests/fixtures/` is gitignored — the source document stays out of the public
repo. Without it that one check reports as skipped and the rest still run.

## Deploying

Push to `main`; GitHub Pages picks it up. The service worker is network-first,
so a deploy lands on the next open rather than needing a hard reload.

## Known limitation

A browser-only OAuth flow gets a ~1 hour access token and no refresh token.
Silent renewal works while the Google session is alive, and with the consent
screen in "Testing" status Google caps that at roughly 7 days — so expect to
sign in again about weekly. That's expected, not a sync failure.
