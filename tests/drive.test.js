/**
 * DriveAuth token-request timing.
 *
 * The bug this guards against: an interactive sign-in call that doesn't
 * invoke tokenClient.requestAccessToken() synchronously within the
 * triggering click's call stack gets its popup silently blocked by some
 * browsers (desktop Safari in particular) — no error, the button just does
 * nothing. It worked on mobile and failed on desktop precisely because
 * mobile browsers are more lenient about this. A functional fake that just
 * calls through to requestAccessToken() regardless of timing wouldn't catch
 * a regression here — the test has to check synchronously, without
 * awaiting, that the call already happened.
 */

import { test, assert } from './harness.js';
import { DriveAuth } from '../js/drive.js';

function fakeTokenClient() {
  const calls = [];
  return {
    calls,
    requestAccessToken({ prompt }) {
      calls.push({ prompt, at: calls.length });
    },
  };
}

function authWithFakeClient() {
  const auth = new DriveAuth('fake-client-id');
  auth.tokenClient = fakeTokenClient();
  return auth;
}

test('an interactive request calls requestAccessToken synchronously, not after a microtask', () => {
  const auth = authWithFakeClient();

  // Deliberately not awaited — a regression here (routing through a
  // `.then()` queue) would mean requestAccessToken() hasn't been called yet
  // at this line, even though it eventually would be a tick later.
  const promise = auth.requestToken({ interactive: true });

  assert.equal(auth.tokenClient.calls.length, 1, 'requestAccessToken should already have been called');
  assert.equal(auth.tokenClient.calls[0].prompt, 'consent');

  promise.catch(() => {}); // never resolved in this test; avoid an unhandled rejection
});

test('a silent request still queues behind one already in flight', async () => {
  const auth = authWithFakeClient();

  // Silent requests are deferred by a microtask (the `.then()` queue), unlike
  // interactive ones — so unlike the synchronous-call test above, this one
  // has to let a tick pass before either call has actually fired.
  const first = auth.requestToken({ interactive: false });
  await Promise.resolve();
  assert.equal(auth.tokenClient.calls.length, 1, 'the first silent request fires once queued');

  const second = auth.requestToken({ interactive: false });
  await Promise.resolve();
  assert.equal(auth.tokenClient.calls.length, 1, 'the second silent request should wait its turn, not fire alongside the first');

  auth.tokenClient.callback({ access_token: 'tok-1', expires_in: 3600 });
  assert.equal(await first, 'tok-1');

  // By the time the second request gets its turn, isSignedIn() is already
  // true from the first — so it resolves straight from that check, with no
  // second popup call needed.
  assert.equal(await second, 'tok-1');
  assert.equal(auth.tokenClient.calls.length, 1, 'the second request needed no round trip once already signed in');
});

test('an interactive request jumps the queue and supersedes a pending silent one', async () => {
  const auth = authWithFakeClient();

  const silent = auth.requestToken({ interactive: false });
  await Promise.resolve(); // silent requests fire on the next microtask, not synchronously
  assert.equal(auth.tokenClient.calls.length, 1, 'the silent request already fired');

  const interactive = auth.requestToken({ interactive: true });
  assert.equal(auth.tokenClient.calls.length, 2, 'the interactive request does not wait behind it');
  assert.equal(auth.tokenClient.calls[1].prompt, 'consent');

  // Rejection has to propagate through the queue's own `.then()` wrapper
  // before reaching this promise, which takes an extra microtask tick or two
  // beyond the reject() call itself — awaiting `silent` directly waits
  // however many ticks that actually takes. A single Promise.resolve() tick
  // (tried first) undercounted this and failed even though the rejection
  // does happen correctly, one tick later.
  let silentRejected = false;
  try {
    await silent;
  } catch {
    silentRejected = true;
  }
  assert.equal(silentRejected, true, 'the superseded silent request is rejected, not left hanging forever');

  auth.tokenClient.callback({ access_token: 'tok-2', expires_in: 3600 });
  assert.equal(await interactive, 'tok-2');
});

test('a successful token satisfies a request queued behind it without a second popup', async () => {
  const auth = authWithFakeClient();

  const first = auth.requestToken({ interactive: true });
  auth.tokenClient.callback({ access_token: 'tok-3', expires_in: 3600 });
  await first;

  const second = await auth.requestToken({ interactive: false });
  assert.equal(second, 'tok-3', 'already signed in — no round trip needed');
  assert.equal(auth.tokenClient.calls.length, 1, 'only the original popup call was made');
});
