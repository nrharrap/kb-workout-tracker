/**
 * Minimal test harness.
 *
 * There is no Node on this machine and the app has no build step, so the
 * suite runs in a browser — which is also the actual deployment target, so
 * the logic is exercised in the same engine that will run it for real.
 * Open tests/run.html through a local static server.
 */

const registry = [];

export function test(name, fn) {
  registry.push({ name, fn });
}

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const assert = {
  ok(value, message = 'expected a truthy value') {
    if (!value) throw new AssertionError(`${message} (got ${show(value)})`);
  },

  equal(actual, expected, message = 'values differ') {
    if (actual !== expected) {
      throw new AssertionError(`${message}\n    expected: ${show(expected)}\n    actual:   ${show(actual)}`);
    }
  },

  notEqual(actual, unexpected, message = 'values should differ') {
    if (actual === unexpected) {
      throw new AssertionError(`${message} (both ${show(actual)})`);
    }
  },

  deepEqual(actual, expected, message = 'structures differ') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new AssertionError(`${message}\n    expected: ${b}\n    actual:   ${a}`);
    }
  },

  closeTo(actual, expected, tolerance, message = 'value out of tolerance') {
    if (Math.abs(actual - expected) > tolerance) {
      throw new AssertionError(`${message}\n    expected: ${expected} ±${tolerance}\n    actual:   ${actual}`);
    }
  },

  throws(fn, message = 'expected a throw') {
    try {
      fn();
    } catch {
      return;
    }
    throw new AssertionError(message);
  },

  isNull(value, message = 'expected null') {
    if (value !== null) throw new AssertionError(`${message} (got ${show(value)})`);
  },

  fail(message) {
    throw new AssertionError(message);
  },
};

export async function runAll() {
  const results = [];
  for (const { name, fn } of registry) {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (err) {
      results.push({ name, passed: false, error: err.message, stack: err.stack });
    }
  }
  return results;
}

export function testCount() {
  return registry.length;
}
