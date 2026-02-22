/**
 * Lightweight opt-in counters and timers for new code paths.
 * Disabled by default; call enable() from test harnesses.
 *
 * bump(name)        — record that a branch was taken
 * begin(name)       — start a timer, returns a token
 * end(token)        — stop the timer, accumulate elapsed ms
 * snapshot()        — { counts: {name: N}, timings: {name: {calls, totalMs}} }
 */

let enabled = false;
const counts = {};
const timings = {};

function bump(name) {
  if (!enabled) return;
  counts[name] = (counts[name] || 0) + 1;
}

function begin(name) {
  if (!enabled) return null;
  return { name, t0: performance.now() };
}

function end(token) {
  if (!token) return;
  const ms = performance.now() - token.t0;
  const entry = timings[token.name] || (timings[token.name] = { calls: 0, totalMs: 0 });
  entry.calls++;
  entry.totalMs += ms;
}

function reset() {
  for (const k of Object.keys(counts)) delete counts[k];
  for (const k of Object.keys(timings)) delete timings[k];
}

function snapshot() {
  const t = {};
  for (const [k, v] of Object.entries(timings)) {
    t[k] = { calls: v.calls, totalMs: +v.totalMs.toFixed(2) };
  }
  return { counts: { ...counts }, timings: t };
}

function enable() { enabled = true; }
function disable() { enabled = false; }

module.exports = { bump, begin, end, reset, snapshot, enable, disable };
