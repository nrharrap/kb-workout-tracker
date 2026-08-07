/**
 * DriveAuth: the redirect-based interactive sign-in, and silent renewal.
 *
 * Interactive sign-in used to be a GIS popup. That got silently blocked on
 * desktop Safari (and some Chrome configurations) regardless of how
 * carefully the triggering call was timed — no error, the button just did
 * nothing. It's now a full-page redirect to Google and back instead, which
 * can't be popup-blocked at all. These tests cover the two pure pieces of
 * that flow (the URL built to send the browser to, and the fragment parsed
 * out of the URL when it comes back) plus the queuing behaviour that's still
 * needed for silent renewal.
 */

import { test, assert } from './harness.js';
import { DriveAuth, buildAuthUrl, parseRedirectFragment, redirectUri } from '../js/drive.js';

// --- pure helpers ------------------------------------------------------------

test('buildAuthUrl encodes the implicit-flow request Google expects', () => {
  const url = new URL(buildAuthUrl('client-123', 'https://example.com/app/', 'state-abc'));

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/app/');
  assert.equal(url.searchParams.get('response_type'), 'token');
  assert.equal(url.searchParams.get('state'), 'state-abc');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
});

test('redirectUri is the origin plus path, dropping any query or fragment', () => {
  const fakeLocation = { origin: 'https://nrharrap.github.io', pathname: '/kb-workout-tracker/', search: '?x=1', hash: '#y' };
  assert.equal(redirectUri(fakeLocation), 'https://nrharrap.github.io/kb-workout-tracker/');
});

test('parseRedirectFragment reads a successful return', () => {
  const parsed = parseRedirectFragment('#access_token=tok-1&expires_in=3599&state=abc&token_type=Bearer');
  assert.equal(parsed.accessToken, 'tok-1');
  assert.equal(parsed.expiresIn, '3599');
  assert.equal(parsed.state, 'abc');
  assert.isNull(parsed.error);
});

test('parseRedirectFragment reads a declined-consent return', () => {
  const parsed = parseRedirectFragment('#error=access_denied&state=abc');
  assert.equal(parsed.error, 'access_denied');
  assert.isNull(parsed.accessToken);
});

test('parseRedirectFragment returns null for an ordinary page load', () => {
  assert.isNull(parseRedirectFragment(''));
  assert.isNull(parseRedirectFragment('#'));
  assert.isNull(parseRedirectFragment(undefined));
});

// --- DriveAuth: consuming the redirect return --------------------------------
//
// window.location can't be reassigned in a browser test page, so these drive
// the actual DriveAuth methods but exercise _consumeRedirectToken() through a
// real (harmless) location.hash on this very test page, cleaning up after
// itself. history.replaceState keeps it from touching browser history.

function withHash(hash, fn) {
  const originalHash = window.location.hash;
  window.location.hash = hash;
  try {
    return fn();
  } finally {
    history.replaceState(null, '', window.location.pathname + window.location.search + originalHash);
  }
}

test('a matching state consumes the token and clears the fragment', () => {
  const auth = new DriveAuth('fake-client-id');
  sessionStorage.setItem('kbwt.oauthState', 'expected-state');

  withHash('#access_token=tok-9&expires_in=3600&state=expected-state', () => {
    auth._consumeRedirectToken();
  });

  assert.equal(auth.accessToken, 'tok-9');
  assert.equal(auth.isSignedIn(), true);
  assert.isNull(sessionStorage.getItem('kbwt.oauthState'), 'one-time use — cleared after consuming');
});

test('a mismatched state is not trusted (CSRF guard)', () => {
  const auth = new DriveAuth('fake-client-id');
  sessionStorage.setItem('kbwt.oauthState', 'expected-state');

  withHash('#access_token=tok-evil&expires_in=3600&state=wrong-state', () => {
    auth._consumeRedirectToken();
  });

  assert.isNull(auth.accessToken, 'a token whose state does not match this session is ignored');
});

test('a declined-consent return surfaces as a takeable error, once', () => {
  const auth = new DriveAuth('fake-client-id');
  sessionStorage.setItem('kbwt.oauthState', 'expected-state');

  withHash('#error=access_denied&error_description=User+cancelled&state=expected-state', () => {
    auth._consumeRedirectToken();
  });

  const err = auth.takeRedirectError();
  assert.ok(err, 'the decline is surfaced');
  assert.equal(err.message, 'User cancelled');
  assert.isNull(auth.takeRedirectError(), 'consumed only once');
});

test('an ordinary page load with no fragment leaves auth state untouched', () => {
  const auth = new DriveAuth('fake-client-id');
  withHash('', () => auth._consumeRedirectToken());
  assert.isNull(auth.accessToken);
  assert.isNull(auth.takeRedirectError());
});

// --- silent renewal queue (unchanged behaviour, still needed) ---------------

function fakeTokenClient() {
  const calls = [];
  return { calls, requestAccessToken({ prompt }) { calls.push({ prompt }); } };
}

function authWithFakeClient() {
  const auth = new DriveAuth('fake-client-id');
  auth.tokenClient = fakeTokenClient();
  return auth;
}

test('a silent request queues behind one already in flight, and a settled one needs no second round trip', async () => {
  const auth = authWithFakeClient();

  const first = auth.requestToken();
  await Promise.resolve();
  assert.equal(auth.tokenClient.calls.length, 1);
  assert.equal(auth.tokenClient.calls[0].prompt, '', 'silent renewal never forces the consent screen');

  const second = auth.requestToken();
  await Promise.resolve();
  assert.equal(auth.tokenClient.calls.length, 1, 'the second waits its turn rather than firing alongside the first');

  auth.tokenClient.callback({ access_token: 'tok-1', expires_in: 3600 });
  assert.equal(await first, 'tok-1');

  assert.equal(await second, 'tok-1');
  assert.equal(auth.tokenClient.calls.length, 1, 'already signed in by the time its turn came — no round trip needed');
});

test('getToken reuses a token consumed from a redirect without calling GIS at all', async () => {
  const auth = new DriveAuth('fake-client-id');
  sessionStorage.setItem('kbwt.oauthState', 's');
  withHash('#access_token=tok-redirect&expires_in=3600&state=s', () => auth._consumeRedirectToken());

  auth.tokenClient = fakeTokenClient(); // present, but should never be touched
  const token = await auth.getToken();

  assert.equal(token, 'tok-redirect');
  assert.equal(auth.tokenClient.calls.length, 0);
});
