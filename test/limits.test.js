import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConsultLimit, recordConsult, consultSignature } from '../src/limits.js';

const policy = { max_consults_per_task: 3 };

test('checkConsultLimit: a non-array state entry is treated as empty, never crashes', () => {
  // GIVEN a corrupt/wrong-typed state entry (a number), WHEN checked, THEN it does NOT throw a
  // TypeError on .includes/.length — it is treated as "no prior consults".
  assert.doesNotThrow(() => checkConsultLimit({ t: 5 }, 't', 'sig', policy));
  assert.doesNotThrow(() => checkConsultLimit({ t: 'oops' }, 't', 'sig', policy));
});

test('checkConsultLimit: a prototype task-id does not resolve to Object.prototype and crash', () => {
  // GIVEN --task-id toString (an Object.prototype key), WHEN checked against a plain state object,
  // THEN state['toString'] (the inherited function) is NOT treated as prior consults — no crash.
  assert.doesNotThrow(() => checkConsultLimit({}, 'toString', 'sig', policy));
  assert.doesNotThrow(() => checkConsultLimit({}, 'constructor', 'sig', policy));
});

test('recordConsult: resets a non-array slot instead of pushing onto it', () => {
  // GIVEN a corrupt slot, WHEN recording, THEN it is replaced with a fresh array holding the sig.
  const state = { t: 'corrupt' };
  recordConsult(state, 't', 'sig1');
  assert.deepEqual(state.t, ['sig1']);
});

test('recordConsult + checkConsultLimit: the cap is enforced across recorded consults', () => {
  // GIVEN a cap of 3, WHEN 3 distinct consults are recorded, THEN the 4th check throws limit-exceeded.
  const state = {};
  for (let i = 0; i < 3; i++) {
    const sig = consultSignature(`q${i}`, 'ctx');
    checkConsultLimit(state, 'T', sig, policy);
    recordConsult(state, 'T', sig);
  }
  assert.throws(() => checkConsultLimit(state, 'T', consultSignature('q4', 'ctx'), policy), (e) => e.kind === 'limit-exceeded');
});
