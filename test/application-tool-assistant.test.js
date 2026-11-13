import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolAssistant, ToolAssistantError } from '../src/application/tool-assistant.js';
import { createToolRegistry } from '../src/ai/tools/tool-registry.js';
import { createToolExecutor } from '../src/ai/tools/tool-executor.js';

const emptyObjectSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function createHarness({
  generator,
  handler = async () => ({ value: 'ok' }),
  trustedContextFactory = async (context) => context,
  createOrchestrator,
} = {}) {
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read an allowlisted value.',
    inputSchema: emptyObjectSchema,
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler,
  });
  const executor = createToolExecutor({ registry });
  const assistant = createToolAssistant({
    registry,
    executor,
    generator: generator || (async () => ({ text: 'Done.' })),
    createTrustedContext: trustedContextFactory,
    createOrchestrator,
  });
  return { assistant, registry, executor };
}

function privateContext(overrides = {}) {
  return {
    conversationType: 'private',
    senderName: 'Trusted name',
    senderId: 'trusted-sender',
    sessionId: 'private:trusted-sender',
    authorizedTools: ['lookup_data'],
    grantedCapabilities: ['lookup'],
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    question: 'Look this up.',
    systemInstruction: 'Use tools when needed.',
    ...overrides,
  };
}

test('constructs a single injected orchestration boundary with the exact registry/executor pair', async () => {
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read an allowlisted value.',
    inputSchema: emptyObjectSchema,
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler: async () => ({ value: 'ok' }),
  });
  const executor = createToolExecutor({ registry });
  const orchestrationOptions = [];
  let orchestratorConstructionCount = 0;
  const injectedAssistant = createToolAssistant({
    registry,
    executor,
    generator: async () => ({ text: 'Ready.' }),
    createTrustedContext: async (context) => context,
    createRequest: (options) => ({
      ...options,
      version: 1,
      metadata: { conversationType: options.conversationType },
    }),
    validateRequest: (value) => value,
    createOrchestrator: (options) => {
      orchestratorConstructionCount += 1;
      orchestrationOptions.push(options);
      return {
        async run(input, trustedContext) {
          return {
            status: 'succeeded',
            text: input.question,
            executionProgress: {
              calls: [],
              hasExecutionStarted: false,
              hasUncertainOutcome: false,
            },
            functionResponses: [],
            retrySafety: { safeToRetry: true },
            trustedContext,
          };
        },
      };
    },
  });

  assert.equal(orchestratorConstructionCount, 1);
  assert.equal(orchestrationOptions[0].registry, registry);
  assert.equal(orchestrationOptions[0].executor, executor);
  assert.equal(orchestrationOptions[0].generator instanceof Function, true);
  const result = await injectedAssistant.run({
    request: request(),
    applicationContext: privateContext(),
  });
  assert.equal(result.text, 'Look this up.');
});

test('builds a validated DTO from request data and keeps trusted context out of model input', async () => {
  let handlerContext;
  let providerInput;
  const { assistant } = createHarness({
    handler: async (_args, context) => {
      handlerContext = context;
      return { value: 'trusted result' };
    },
    generator: async ({ input }) => {
      providerInput = input;
      if (providerInputCalls === 0) {
        providerInputCalls += 1;
        return {
          functionCalls: [{
            id: 'provider-call',
            name: 'lookup_data',
            arguments: {},
          }],
        };
      }
      return { text: 'Finished.' };
    },
  });
  let providerInputCalls = 0;

  const context = privateContext();
  const result = await assistant.run({
    request: request(),
    applicationContext: context,
  });

  assert.equal(result.text, 'Finished.');
  assert.equal(result.executionProgress.calls[0].state, 'succeeded');
  assert.equal(providerInput.version, 1);
  assert.deepEqual(providerInput.metadata, { conversationType: 'private' });
  assert.equal(providerInput.modelInput.currentMessage.parts[0].text, 'Look this up.');
  assert.equal('senderId' in providerInput, false);
  assert.equal('sessionId' in providerInput.metadata, false);
  assert.equal('authorizedTools' in providerInput, false);
  assert.equal(handlerContext.senderId, 'trusted-sender');
  assert.equal(handlerContext.sessionId, 'private:trusted-sender');
});

test('does not allow request data to choose trusted sender, scope, or authorization', async () => {
  let generatorCalls = 0;
  const { assistant } = createHarness({
    generator: async () => {
      generatorCalls += 1;
      return { text: 'Should not run.' };
    },
  });

  for (const spoofedFields of [
    { conversationType: 'group' },
    { senderName: 'Model-controlled name' },
    { senderId: 'model-controlled-sender' },
    { sessionId: 'model-controlled-session' },
    { authorizedTools: ['lookup_data'] },
    { requestId: 'model-controlled-request' },
  ]) {
    await assert.rejects(
      assistant.run({
        request: request(spoofedFields),
        applicationContext: privateContext(),
      }),
      (error) =>
        error instanceof ToolAssistantError &&
        error.code === 'INVALID_ASSISTANT_REQUEST' &&
        error.kind === 'validation' &&
        error.executionProgress.state === 'not_started' &&
        error.retrySafety.safeToRetry,
    );
  }
  assert.equal(generatorCalls, 0);
});

test('rejects group execution based only on trusted application context', async () => {
  let generatorCalls = 0;
  const { assistant } = createHarness({
    generator: async () => {
      generatorCalls += 1;
      return { text: 'Should not run.' };
    },
  });

  await assert.rejects(
    assistant.run({
      request: request(),
      applicationContext: privateContext({
        conversationType: 'group',
        authorizedTools: ['lookup_data'],
      }),
    }),
    (error) =>
      error instanceof ToolAssistantError &&
      error.code === 'GROUP_TOOL_EXECUTION_DISABLED' &&
      error.kind === 'authorization' &&
      error.executionProgress.hasExecutionStarted === false,
  );
  assert.equal(generatorCalls, 0);
});

test('missing authorization denies handler execution without granting tools by default', async () => {
  let handlerCalls = 0;
  let generation = 0;
  const { assistant } = createHarness({
    handler: async () => {
      handlerCalls += 1;
      return { value: 'should not execute' };
    },
    generator: async () => {
      generation += 1;
      return generation === 1
        ? {
            functionCalls: [{
              id: 'unauthorized-call',
              name: 'lookup_data',
              arguments: {},
            }],
          }
        : { text: 'I could not access that tool.' };
    },
  });

  const result = await assistant.run({
    request: request(),
    applicationContext: privateContext({ authorizedTools: undefined }),
  });

  assert.equal(handlerCalls, 0);
  assert.equal(result.executionProgress.calls[0].executionStarted, false);
  assert.equal(result.executionProgress.calls[0].state, 'failed');
  assert.equal(result.functionResponses[0].error.code, 'TOOL_PERMISSION_DENIED');
  assert.equal(result.retrySafety.safeToRetry, true);
});

test('preserves the full structured success result', async () => {
  let resultFromOrchestrator;
  const registry = createToolRegistry();
  const executor = createToolExecutor({ registry });
  const assistant = createToolAssistant({
    registry,
    executor,
    generator: async () => ({ text: 'unused' }),
    createTrustedContext: async (context) => context,
    createOrchestrator: () => ({
      async run() {
        resultFromOrchestrator = {
          status: 'succeeded',
          text: 'Complete.',
          executionProgress: {
            calls: [],
            hasExecutionStarted: true,
            hasUncertainOutcome: false,
          },
          functionResponses: [{ id: 'preserved-response' }],
          retrySafety: {
            safeToRetry: false,
            reason: 'tool_execution_started',
          },
        };
        return resultFromOrchestrator;
      },
    }),
  });

  const result = await assistant.run({
    request: request(),
    applicationContext: privateContext(),
  });
  assert.equal(result, resultFromOrchestrator);
  assert.equal(result.functionResponses[0].id, 'preserved-response');
  assert.equal(result.retrySafety.safeToRetry, false);
});

test('preserves partial function responses and progress after provider failure', async () => {
  let generation = 0;
  let handlerCalls = 0;
  const { assistant } = createHarness({
    handler: async () => {
      handlerCalls += 1;
      return { value: 'completed once' };
    },
    generator: async () => {
      generation += 1;
      if (generation === 1) {
        return {
          functionCalls: [{
            id: 'completed-call',
            name: 'lookup_data',
            arguments: {},
          }],
        };
      }
      throw new Error('provider is unavailable');
    },
  });

  await assert.rejects(
    assistant.run({
      request: request(),
      applicationContext: privateContext(),
    }),
    (error) =>
      error instanceof ToolAssistantError &&
      error.code === 'GENERATOR_FAILED' &&
      error.kind === 'provider' &&
      error.executionProgress.calls[0].state === 'succeeded' &&
      error.functionResponses[0].id === 'completed-call' &&
      error.retrySafety.safeToRetry === false &&
      error.hasUncertainOutcome === false,
  );
  assert.equal(generation, 2);
  assert.equal(handlerCalls, 1);
});

test('preserves an unknown timeout outcome and marks it unsafe to retry', async () => {
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read an allowlisted value.',
    inputSchema: emptyObjectSchema,
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler: async () => new Promise(() => {}),
  });
  const executor = createToolExecutor({ registry, timeoutMs: 10 });
  let generation = 0;
  const timeoutAssistant = createToolAssistant({
    registry,
    executor,
    generator: async () => {
      generation += 1;
      return {
        functionCalls: [{
          id: 'timed-out-call',
          name: 'lookup_data',
          arguments: {},
        }],
      };
    },
    createTrustedContext: async (context) => context,
  });

  await assert.rejects(
    timeoutAssistant.run({
      request: request(),
      applicationContext: privateContext(),
    }),
    (error) =>
      error instanceof ToolAssistantError &&
      error.code === 'TOOL_OUTCOME_UNKNOWN' &&
      error.executionProgress.hasUncertainOutcome === true &&
      error.hasUncertainOutcome === true &&
      error.retrySafety.safeToRetry === false,
  );
  assert.equal(generation, 1);
});

test('does not retry or fall back when provider generation fails before tool execution', async () => {
  let generation = 0;
  const { assistant } = createHarness({
    generator: async () => {
      generation += 1;
      throw new Error('provider failure');
    },
  });

  await assert.rejects(
    assistant.run({
      request: request(),
      applicationContext: privateContext(),
    }),
    (error) =>
      error instanceof ToolAssistantError &&
      error.kind === 'provider' &&
      error.executionProgress.hasExecutionStarted === false &&
      error.retrySafety.safeToRetry === true,
  );
  assert.equal(generation, 1);
});

test('rejects a mismatched registry/executor pair before creating an orchestrator', () => {
  const otherRegistry = createToolRegistry();
  const otherExecutor = createToolExecutor({ registry: otherRegistry });
  const registry = createToolRegistry();
  let orchestratorCreated = false;

  assert.throws(() => createToolAssistant({
    registry,
    executor: otherExecutor,
    generator: async () => ({ text: 'unused' }),
    createTrustedContext: async (context) => context,
    createOrchestrator: () => {
      orchestratorCreated = true;
      return { run: async () => ({}) };
    },
  }), /bound to the supplied registry/);
  assert.equal(orchestratorCreated, false);
});

test('invalid DTO input fails before orchestration and preserves stable validation metadata', async () => {
  let generatorCalls = 0;
  const { assistant } = createHarness({
    generator: async () => {
      generatorCalls += 1;
      return { text: 'Should not run.' };
    },
  });

  await assert.rejects(
    assistant.run({
      request: { question: 'Missing required system instruction.' },
      applicationContext: privateContext(),
    }),
    (error) =>
      error instanceof ToolAssistantError &&
      error.code === 'INVALID_ASSISTANT_REQUEST' &&
      error.kind === 'validation' &&
      error.executionProgress.state === 'not_started',
  );
  assert.equal(generatorCalls, 0);
});

test('does not introduce persistence or alter the legacy assistant string contract', async () => {
  let saveCalls = 0;
  let legacyAskCalls = 0;
  const legacyAssistant = {
    async ask() {
      legacyAskCalls += 1;
      return 'Legacy string response.';
    },
  };
  const { assistant } = createHarness({
    generator: async () => ({ text: 'Structured response.' }),
  });

  assert.equal(await legacyAssistant.ask(), 'Legacy string response.');
  const result = await assistant.run({
    request: request(),
    applicationContext: privateContext(),
    saveMessage: () => { saveCalls += 1; },
  });

  assert.equal(result.text, 'Structured response.');
  assert.equal(legacyAskCalls, 1);
  assert.equal(saveCalls, 0);
});
