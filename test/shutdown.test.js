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
    setExitCode() {},
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
  assert.equal(loggedErrors.length, 1);
  assert.deepEqual(exitCodes, [1]);
});

test('bounds queue drain wait and keeps client/database open until pending work settles', async () => {
  let resolveDrain;
  let finishLateCleanup;
  const drain = new Promise((resolve) => { resolveDrain = resolve; });
  const lateCleanup = new Promise((resolve) => { finishLateCleanup = resolve; });
  const calls = [];
  const loggedErrors = [];
  const exitCodes = [];
  const shutdown = createShutdownHandler({
    stopAccepting: async () => calls.push('stop'),
    drainMessages: () => drain,
    drainTimeoutMs: 5,
    destroyClient: async () => calls.push('destroy'),
    closeResources: async () => calls.push('close'),
    logger: {
      log: () => {},
      error: (...args) => loggedErrors.push(args),
    },
    setExitCode: (code) => exitCodes.push(code),
    onComplete: ({ completed }) => {
      if (completed) finishLateCleanup();
    },
  });

  assert.equal(await shutdown('SIGTERM'), false);
  assert.deepEqual(calls, ['stop']);
  assert.equal(loggedErrors.length, 1);
  assert.deepEqual(exitCodes, [1]);

  resolveDrain();
  await lateCleanup;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['stop', 'destroy', 'close']);
});

test('does not close the database when queue drain fails', async () => {
  const calls = [];
  const shutdown = createShutdownHandler({
    stopAccepting: async () => calls.push('stop'),
    drainMessages: async () => { throw new Error('queue failed'); },
    destroyClient: async () => calls.push('destroy'),
    closeResources: async () => calls.push('close'),
    logger: { log() {}, error() {} },
    setExitCode() {},
  });

  assert.equal(await shutdown('SIGTERM'), false);
  assert.deepEqual(calls, ['stop']);
});

test('bounds a hanging client destroy without claiming cleanup is complete', async () => {
  let releaseDestroy;
  let complete;
  const destroy = new Promise((resolve) => { releaseDestroy = resolve; });
  const completion = new Promise((resolve) => { complete = resolve; });
  const calls = [];
  const shutdown = createShutdownHandler({
    drainMessages: async () => {},
    cleanupTimeoutMs: 5,
    destroyClient: () => {
      calls.push('destroy');
      return destroy;
    },
    closeResources: async () => calls.push('close'),
    logger: { log() {}, error() {} },
    setExitCode() {},
    onComplete: complete,
  });

  assert.equal(await shutdown('SIGTERM'), false);
  assert.deepEqual(calls, ['destroy', 'close']);
  releaseDestroy();
  const result = await completion;
  assert.deepEqual(result, { completed: true, failed: true });
});
