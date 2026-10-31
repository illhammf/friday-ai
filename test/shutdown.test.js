import test from 'node:test';
import assert from 'node:assert/strict';
import { createShutdownHandler } from '../src/whatsapp/shutdown.js';

test('drains messages before destroying WhatsApp and closing resources', async () => {
  const calls = [];
  const shutdown = createShutdownHandler({
    drainMessages: async () => calls.push('drain'),
    destroyClient: async () => calls.push('destroy'),
    closeResources: async () => calls.push('close'),
    logger: { log() {}, error() {} },
  });

  await shutdown('SIGTERM');
  assert.deepEqual(calls, ['drain', 'destroy', 'close']);
});

test('runs shutdown only once when multiple signals arrive', async () => {
  let destroyCount = 0;
  let closeCount = 0;
  const shutdown = createShutdownHandler({
    drainMessages: async () => {},
    destroyClient: async () => {
      destroyCount++;
    },
    closeResources: async () => {
      closeCount++;
    },
    logger: { log() {}, error() {} },
  });

  await Promise.all([shutdown('SIGINT'), shutdown('SIGTERM')]);
  assert.equal(destroyCount, 1);
  assert.equal(closeCount, 1);
});

test('still closes all resources and reports failures', async () => {
  const loggedErrors = [];
  const exitCodes = [];
  const calls = [];
  const shutdown = createShutdownHandler({
    drainMessages: async () => {
      calls.push('drain');
      throw new Error('drain failed');
    },
    destroyClient: async () => {
      calls.push('destroy');
      throw new Error('client failed');
    },
    closeResources: async () => {
      calls.push('close');
    },
    logger: {
      log() {},
      error: (...args) => loggedErrors.push(args),
    },
    setExitCode: (code) => exitCodes.push(code),
  });

  await shutdown('SIGINT');
  assert.deepEqual(calls, ['drain', 'destroy', 'close']);
  assert.equal(loggedErrors.length, 2);
  assert.deepEqual(exitCodes, [1]);
});
