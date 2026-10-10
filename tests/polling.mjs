import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolling } from '../renderer/polling.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
function fakeTimers() {
  let now = 0, sequence = 0;
  const pending = new Map(), cleared = [];
  return {
    setTimeout(callback, delay) { const id = sequence++; pending.set(id, { id, callback, due: now + delay }); return id; },
    clearTimeout(id) { cleared.push(id); pending.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...pending.values()].filter(job => job.due <= end).sort((a,b) => a.due - b.due || a.id - b.id)[0];
        if (!next) break;
        now = next.due; pending.delete(next.id); next.callback();
      }
      now = end;
    },
    next() { return [...pending.values()].sort((a,b) => a.due - b.due || a.id - b.id)[0]; },
    get now() { return now; }, get size() { return pending.size; }, cleared,
  };
}

test('Scheduler validates required callbacks and starts stopped', () => {
  assert.throws(() => createPolling(), TypeError);
  assert.throws(() => createPolling({ run() {}, timers: {} }), TypeError);
  const polling = createPolling({ run() {} });
  assert.equal(polling.getState().stopped, true);
  assert.equal(polling.request(), false);
});
test('Inflight requests coalesce to one tail run without overlapping asynchronous work', async () => {
  const timers = fakeTimers(), first = deferred(), second = deferred();
  let count = 0, concurrent = 0, maximum = 0;
  const polling = createPolling({ timers, run: async () => { count++; concurrent++; maximum = Math.max(maximum, concurrent); await (count === 1 ? first.promise : second.promise); concurrent--; } });
  assert.equal(polling.start(), true); assert.equal(polling.start(), false);
  assert.equal(count, 1); assert.equal(polling.request(), true);
  for (let index = 0; index < 10; index++) assert.equal(polling.request(), false);
  assert.equal(timers.size, 0); assert.equal(polling.getState().queued, true);
  first.resolve(); await flush();
  assert.equal(count, 2); assert.equal(maximum, 1); assert.equal(polling.getState().queued, false);
  second.resolve(); await flush(); assert.equal(timers.size, 1); polling.stop();
});
test('Delay is sampled after completion and the timer starts from completion time', async () => {
  const timers = fakeTimers(), gate = deferred(); let delay = 5000;
  const polling = createPolling({ timers, run: () => gate.promise, delay: () => delay });
  polling.start(); timers.advance(7000); delay = 30000;
  assert.equal(timers.size, 0); gate.resolve(); await flush();
  assert.equal(timers.next().due, 37000); assert.equal(polling.getState().lastDelay, 30000); polling.stop();
});
test('An idle manual request replaces its timer, and a stale callback cannot start a duplicate', async () => {
  const timers = fakeTimers(); let count = 0;
  const polling = createPolling({ timers, run: () => { count++; }, delay: () => 5000 });
  polling.start(); await flush(); const stale = timers.next().callback;
  assert.equal(count, 1); polling.request(); await flush();
  assert.equal(count, 2); assert.equal(timers.size, 1);
  stale(); await flush(); assert.equal(count, 2); polling.stop();
});
test('Feedback events with queue:false cannot create a self-triggered tail loop', async () => {
  const timers = fakeTimers(); let count = 0, polling;
  polling = createPolling({ timers, run: async () => { count++; assert.equal(polling.request({ queue: false }), false); } });
  polling.start(); await flush(); assert.equal(count, 1);
  assert.equal(polling.getState().queued, false); assert.equal(timers.size, 1); polling.stop();
});
test('Stop cancels queued work and timers, including a timer with identifier zero', async () => {
  const timers = fakeTimers(), gate = deferred(); let count = 0;
  const polling = createPolling({ timers, run: () => { count++; return gate.promise; } });
  polling.start(); polling.request(); polling.stop();
  assert.equal(polling.getState().stopped, true); assert.equal(polling.getState().running, true);
  gate.resolve(); await flush(); assert.equal(count, 1); assert.equal(timers.size, 0);
  assert.equal(polling.getState().running, false); assert.equal(polling.request(), false);
  const delayed = createPolling({ timers, run() {} }); delayed.start({ immediate: false });
  assert.equal(timers.next().id, 0); delayed.stop(); assert.equal(timers.size, 0); assert.ok(timers.cleared.includes(0));
});
test('Restart while an old request runs waits for its finish instead of overlapping', async () => {
  const timers = fakeTimers(), old = deferred(), resumed = deferred(); let count = 0;
  const errors = [];
  const polling = createPolling({ timers, run: () => (++count === 1 ? old.promise : resumed.promise), onError: error => errors.push(error) });
  polling.start(); polling.request(); polling.stop(); polling.start();
  assert.equal(count, 1); assert.equal(polling.getState().queued, true);
  old.reject(new Error('stopped request failed')); await flush();
  assert.equal(count, 2); assert.equal(errors.length, 0); assert.equal(polling.getState().failures, 0);
  resumed.resolve(); await flush(); assert.equal(timers.size, 1); polling.stop();
});
test('A delayed restart waits for the old run and schedules rather than queuing an immediate run', async () => {
  const timers = fakeTimers(), gate = deferred(); let count = 0;
  const polling = createPolling({ timers, run: () => { count++; return gate.promise; }, delay: () => 5000 });
  polling.start(); polling.stop(); polling.start({ immediate: false }); gate.resolve(); await flush();
  assert.equal(count, 1); assert.equal(timers.next().due, 5000);
  timers.advance(5000); await flush(); assert.equal(count, 2); polling.stop();
});
test('Consecutive failures inform adaptive backoff and a success resets the failure streak', async () => {
  const timers = fakeTimers(), errors = []; let count = 0;
  const polling = createPolling({ timers, run: async () => { if (++count < 3) throw new Error(`failure ${count}`); }, delay: ({ failures }) => failures ? Math.min(120000, failures * 60000) : 5000, onError: error => errors.push(error.message) });
  polling.start(); await flush(); assert.equal(polling.getState().failures, 1); assert.equal(timers.next().due, 60000);
  timers.advance(60000); await flush(); assert.equal(polling.getState().failures, 2); assert.equal(timers.next().due, 180000);
  timers.advance(120000); await flush(); assert.equal(polling.getState().failures, 0); assert.equal(timers.next().due, 185000);
  assert.deepEqual(errors, ['failure 1', 'failure 2']); polling.stop();
});
test('Delay bounds and invalid configuration prevent tight or unbounded polling', async () => {
  for (const [requested, expected] of [[0,100], [5.8,100], [300000,120000], [NaN,30000], [undefined,30000]]) {
    const timers = fakeTimers(), polling = createPolling({ timers, run() {}, delay: () => requested });
    polling.start(); await flush(); assert.equal(timers.next().due, expected); polling.stop();
  }
  const timers = fakeTimers(), errors = [];
  const polling = createPolling({ timers, run() {}, delay() { throw new Error('bad delay'); }, onError: error => errors.push(error.message) });
  polling.start(); await flush(); assert.equal(timers.next().due, 30000); assert.deepEqual(errors, ['bad delay']); polling.stop();
});
test('State snapshots cannot alter the scheduler, and error reporting cannot break its lifecycle', async () => {
  const timers = fakeTimers();
  const polling = createPolling({ timers, run() { throw new Error('network failed'); }, onError() { throw new Error('observer failed'); } });
  polling.start(); await flush(); const snapshot = polling.getState(); snapshot.running = true; snapshot.stopped = true;
  assert.equal(polling.getState().running, false); assert.equal(polling.getState().stopped, false);
  assert.equal(polling.getState().failures, 1); assert.equal(timers.size, 1); polling.stop();
});
