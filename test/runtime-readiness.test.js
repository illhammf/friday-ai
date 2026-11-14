import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeReadinessGate } from '../src/application/runtime-readiness.js';

test('readiness opens admission after ready and cannot reopen it after shutdown starts', () => {
  const gate = createRuntimeReadinessGate();
  assert.equal(gate.canAccept(), false);
  assert.equal(gate.markReady(), true);
  assert.equal(gate.canAccept(), true);

  gate.stop();
  assert.equal(gate.canAccept(), false);
  assert.equal(gate.markReady(), false);
  assert.equal(gate.canAccept(), false);
});
