import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../src/application/application-lifecycle.js';

function createHarness(overrides = {}) {
  const calls = [];
  const loggedErrors = [];
  const exitCodes = [];
  const startupError = new Error('client initialize failed');
  const dependencies = {
    openDatabase: async () => {
      calls.push('openDatabase');
      return { close: async () => calls.push('closeDatabase') };
    },
    createClient: async () => {
      calls.push('createClient');
      return {
        initialize: async () => calls.push('initializeClient'),
        destroy: async () => calls.push('destroyClient'),
      };
    },
    configureClient: async () => calls.push('configureClient'),
    initializeClient: async (client) => client.initialize(),
    stopAccepting: () => calls.push('stopAccepting'),
    drainMessages: () => calls.push('drainMessages'),
    logger: {
      log: () => {},
      error: (...args) => loggedErrors.push(args),
    },
    setExitCode: (code) => exitCodes.push(code),
    startupError,
  };

  for (const [key, value] of Object.entries(overrides)) {
    dependencies[key] = value;
  }

  return {
    calls,
    loggedErrors,
    exitCodes,
    startupError,
    application: createApplication(dependencies),
  };
}

test('constructs the application without opening resources or starting integrations', () => {
  const { calls, application } = createHarness();

  assert.equal(application.state, 'idle');
  assert.deepEqual(application.resources, {
    database: undefined,
    client: undefined,
  });
  assert.deepEqual(calls, []);
});

test('starts injected resources in order and returns them', async () => {
  const { calls, application } = createHarness();

  const resources = await application.start();

  assert.deepEqual(calls, [
    'openDatabase',
    'createClient',
    'configureClient',
    'initializeClient',
  ]);
  assert.deepEqual(resources, application.resources);
  assert.equal(application.state, 'running');
});

test('does not initialize the client when database construction fails', async () => {
  const databaseError = new Error('database unavailable');
  const { calls, application } = createHarness({
    openDatabase: async () => {
      calls.push('openDatabase');
      throw databaseError;
    },
  });

  await assert.rejects(application.start(), (error) => error === databaseError);
  assert.deepEqual(calls, [
    'openDatabase',
    'stopAccepting',
    'drainMessages',
  ]);
  assert.equal(application.state, 'stopped');
});

test('startup failure preserves its error and cleans up created resources', async () => {
  const { calls, startupError, application } = createHarness({
    initializeClient: async () => {
      calls.push('initializeClient');
      throw startupError;
    },
  });

  await assert.rejects(application.start(), (error) => error === startupError);
  assert.deepEqual(calls, [
    'openDatabase',
    'createClient',
    'configureClient',
    'initializeClient',
    'stopAccepting',
    'drainMessages',
    'destroyClient',
    'closeDatabase',
  ]);
  assert.equal(application.state, 'stopped');
});

test('continues cleanup when admission stop, queue drain, and client destruction fail', async () => {
  const { calls, exitCodes, loggedErrors, startupError, application } = createHarness({
    initializeClient: async () => {
      calls.push('initializeClient');
      throw startupError;
    },
    stopAccepting: async () => {
      calls.push('stopAccepting');
      throw new Error('stop failed');
    },
    drainMessages: async () => {
      calls.push('drainMessages');
      throw new Error('drain failed');
    },
    createClient: async () => {
      calls.push('createClient');
      return {
        initialize: async () => {},
        destroy: async () => {
          calls.push('destroyClient');
          throw new Error('destroy failed');
        },
      };
    },
    openDatabase: async () => {
      calls.push('openDatabase');
      return { close: async () => calls.push('closeDatabase') };
    },
  });

  await assert.rejects(application.start(), (error) => error === startupError);
  assert.deepEqual(calls.slice(4, 8), [
    'stopAccepting',
    'drainMessages',
    'destroyClient',
    'closeDatabase',
  ]);
  assert.equal(loggedErrors.length, 3);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(application.state, 'stopped');
});

test('graceful shutdown remains ordered and idempotent', async () => {
  const { calls, application } = createHarness();
  await application.start();
  calls.length = 0;

  await Promise.all([
    application.shutdown('SIGINT'),
    application.shutdown('SIGTERM'),
  ]);

  assert.deepEqual(calls, [
    'stopAccepting',
    'drainMessages',
    'destroyClient',
    'closeDatabase',
  ]);
  assert.equal(application.state, 'stopped');
});

test('shutdown requested during startup waits for initialization before cleanup', async () => {
  let releaseInitialization;
  const initializationGate = new Promise((resolve) => {
    releaseInitialization = resolve;
  });
  const { calls, application } = createHarness({
    initializeClient: async () => {
      calls.push('initializeClient');
      await initializationGate;
      calls.push('initializationFinished');
    },
  });

  const startup = application.start();
  await new Promise((resolve) => setImmediate(resolve));
  const shutdown = application.shutdown('SIGTERM');
  releaseInitialization();

  await assert.rejects(startup, /interrupted by shutdown/i);
  await shutdown;

  assert.deepEqual(calls, [
    'openDatabase',
    'createClient',
    'configureClient',
    'initializeClient',
    'initializationFinished',
    'stopAccepting',
    'drainMessages',
    'destroyClient',
    'closeDatabase',
  ]);
  assert.equal(application.state, 'stopped');
});
