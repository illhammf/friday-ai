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

test('concurrent and repeated startup calls create and initialize one client once', async () => {
  let configureCount = 0;
  let initializeCount = 0;
  let createCount = 0;
  const { application } = createHarness({
    createClient: async () => {
      createCount += 1;
      return { initialize: async () => {}, destroy: async () => {} };
    },
    configureClient: async (client) => {
      configureCount += 1;
      client.on = (event, handler) => {
        client.listeners ||= new Map();
        client.listeners.set(event, [...(client.listeners.get(event) || []), handler]);
      };
      client.listenerCount = (event) => client.listeners?.get(event)?.length || 0;
      client.on('ready', () => {});
      client.on('message', () => {});
    },
    initializeClient: async () => { initializeCount += 1; },
  });

  const [first, second, third] = await Promise.all([
    application.start(),
    application.start(),
    application.start(),
  ]);
  const repeated = await application.start();

  assert.equal(first.client, second.client);
  assert.equal(first.client, third.client);
  assert.equal(first.client, repeated.client);
  assert.equal(createCount, 1);
  assert.equal(configureCount, 1);
  assert.equal(initializeCount, 1);
  assert.equal(first.client.listenerCount('ready'), 1);
  assert.equal(first.client.listenerCount('message'), 1);
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

test('keeps resources open if admission cannot be stopped safely', async () => {
  const { calls, exitCodes, loggedErrors, startupError, application } = createHarness({
    initializeClient: async () => {
      calls.push('initializeClient');
      throw startupError;
    },
    stopAccepting: async () => {
      calls.push('stopAccepting');
      throw new Error('stop failed');
    },
  });

  await assert.rejects(application.start(), (error) => error === startupError);
  assert.deepEqual(calls, [
    'openDatabase',
    'createClient',
    'configureClient',
    'initializeClient',
    'stopAccepting',
  ]);
  assert.equal(loggedErrors.length, 1);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(application.state, 'failed');
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

test('shutdown stops admission immediately and waits for startup before cleanup', async () => {
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
    'stopAccepting',
    'initializationFinished',
    'drainMessages',
    'destroyClient',
    'closeDatabase',
  ]);
  assert.equal(application.state, 'stopped');
});

test('keeps lifecycle in stopping state until a timed-out queue drain and cleanup finish', async () => {
  let releaseDrain;
  const drain = new Promise((resolve) => { releaseDrain = resolve; });
  const { calls, application } = createHarness({
    drainTimeoutMs: 5,
    drainMessages: () => drain,
  });
  await application.start();

  assert.equal(await application.shutdown('SIGTERM'), false);
  assert.equal(application.state, 'stopping');
  assert.equal(calls.includes('destroyClient'), false);
  assert.equal(calls.includes('closeDatabase'), false);

  releaseDrain();
  for (let attempt = 0; attempt < 10 && application.state === 'stopping'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(calls.slice(-2), ['destroyClient', 'closeDatabase']);
  assert.equal(application.state, 'failed');
});

test('stops admission immediately and bounds shutdown while WhatsApp initialization is pending', async () => {
  let releaseInitialization;
  const initialization = new Promise((resolve) => { releaseInitialization = resolve; });
  const { calls, application, exitCodes } = createHarness({
    startupTimeoutMs: 5,
    initializeClient: async () => {
      calls.push('initializeClient');
      await initialization;
    },
  });
  const startup = application.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await application.shutdown('SIGTERM'), false);
  assert.equal(application.state, 'stopping');
  assert.equal(calls.includes('stopAccepting'), true);
  assert.equal(calls.includes('destroyClient'), false);
  assert.equal(calls.includes('closeDatabase'), false);
  assert.deepEqual(exitCodes, [1]);

  releaseInitialization();
  await assert.rejects(startup, /interrupted by shutdown/i);
  for (let attempt = 0; attempt < 10 && application.state === 'stopping'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(calls.includes('destroyClient'), true);
  assert.equal(calls.includes('closeDatabase'), true);
  assert.equal(application.state, 'stopped');
});
