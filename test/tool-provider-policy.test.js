import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolProviderPolicy,
} from '../src/application/tool-provider-policy.js';
import {
  createGeminiToolGenerator,
  GeminiToolAdapterError,
} from '../src/ai/gemini-tool-adapter.js';
import {
  createToolOrchestrator,
  ToolOrchestrationError,
} from '../src/ai/tool-orchestrator.js';
import { createToolAssistant } from '../src/application/tool-assistant.js';
import { createToolRegistry } from '../src/ai/tools/tool-registry.js';
import { createToolExecutor as createToolExecutorFactory } from '../src/ai/tools/tool-executor.js';
import { createTestGrantLifecycle } from './helpers/tool-grant-fixture.js';

function createToolExecutor(options) {
  return createToolExecutorFactory({
    grantLifecycle: createTestGrantLifecycle(),
    ...options,
  });
}

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function retryProgress(overrides = {}) {
  return {
    hasExecutionStarted: false,
    hasUncertainOutcome: false,
    calls: [],
    retrySafety: { safeToRetry: true },
    ...overrides,
  };
}

function createRetryableFailure(selection, overrides = {}) {
  return {
    code: 'GENERATOR_FAILED',
    kind: 'provider',
    providerFailure: {
      providerId: selection.providerId,
      modelId: selection.modelId,
      status: 503,
      code: null,
      retryable: true,
    },
    ...overrides,
  };
}

function createPolicy({
  maxProviderAttempts,
  generators = {},
} = {}) {
  const created = [];
  const policy = createToolProviderPolicy({
    providers: [
      {
        providerId: 'google-gemini',
        modelId: 'model-primary',
        createGenerator: () => {
          created.push('primary');
          return generators.primary || (async () => ({ text: 'primary' }));
        },
      },
      {
        providerId: 'google-gemini',
        modelId: 'model-backup',
        createGenerator: () => {
          created.push('backup');
          return generators.backup || (async () => ({ text: 'backup' }));
        },
      },
      {
        providerId: 'alternate-provider',
        modelId: 'model-third',
        createGenerator: () => {
          created.push('third');
          return generators.third || (async () => ({ text: 'third' }));
        },
      },
    ],
    maxProviderAttempts,
  });
  return { policy, created };
}

function createActualAssistant(generator, handler = async () => ({ ok: true })) {
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read an allowlisted value.',
    inputSchema: EMPTY_SCHEMA,
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler,
  });
  const executor = createToolExecutor({ registry });
  const assistant = createToolAssistant({
    registry,
    executor,
    generator,
    createTrustedContext: async (context) => context,
  });
  return { assistant, registry, executor };
}

const PRIVATE_CONTEXT = {
  conversationType: 'private',
  sessionId: 'private:test',
  senderId: 'test',
  authorizedTools: ['lookup_data'],
  grantedCapabilities: ['lookup'],
  principalId: 'fixture-principal',
  grantScope: 'fixture-scope',
};
const REQUEST = {
  question: 'Find the value.',
  systemInstruction: 'Use the available tool if needed.',
};

test('selects one provider and pins its generator across orchestration rounds', async () => {
  const observedModels = [];
  const { policy, created } = createPolicy({
    generators: {
      primary: async () => {
        observedModels.push('primary');
        return { text: 'first round' };
      },
      backup: async () => {
        observedModels.push('backup');
        return { text: 'backup' };
      },
    },
  });
  const session = policy.createSession();
  const selection = session.selectInitial();

  assert.equal(selection.providerId, 'google-gemini');
  assert.equal(selection.modelId, 'model-primary');
  assert.equal(selection.attempt, 1);
  assert.equal(created.length, 1);
  assert.equal(Object.isFrozen(selection.generator), true);

  await selection.generator({ round: 1 });
  await selection.generator({ round: 2 });
  assert.deepEqual(observedModels, ['primary', 'primary']);
  assert.deepEqual(created, ['primary']);
});

test('allows an explicit bounded provider switch only for typed pre-dispatch provider failures', () => {
  const { policy, created } = createPolicy();
  const session = policy.createSession();
  const initial = session.selectInitial();

  const decision = session.assessNext({
    failure: createRetryableFailure(initial),
    executionProgress: retryProgress(),
    requestValid: true,
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.next.modelId, 'model-backup');
  assert.deepEqual(created, ['primary']);

  const switched = session.selectNext({
    failure: createRetryableFailure(initial),
    executionProgress: retryProgress(),
    requestValid: true,
  });
  assert.equal(switched.eligible, true);
  assert.equal(switched.selection.modelId, 'model-backup');
  assert.equal(switched.selection.attempt, 2);
  assert.deepEqual(created, ['primary', 'backup']);
});

test('does not trust safeToRetry alone or provider-like message text', () => {
  const { policy } = createPolicy();
  const session = policy.createSession();
  const initial = session.selectInitial();

  for (const failure of [
    { code: 'GENERATOR_FAILED', kind: 'provider', message: 'UNAVAILABLE' },
    {
      ...createRetryableFailure(initial),
      providerFailure: {
        ...createRetryableFailure(initial).providerFailure,
        retryable: false,
      },
    },
  ]) {
    const decision = session.assessNext({
      failure,
      executionProgress: retryProgress(),
      requestValid: true,
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, 'provider_failure_not_retryable');
  }
});

test('denies provider switching after handler dispatch or successful execution', () => {
  const { policy, created } = createPolicy();
  const session = policy.createSession();
  const initial = session.selectInitial();
  const failure = createRetryableFailure(initial);

  for (const executionProgress of [
    retryProgress({
      hasExecutionStarted: true,
      calls: [{ executionStarted: true, state: 'failed' }],
      retrySafety: { safeToRetry: false },
    }),
    retryProgress({
      hasExecutionStarted: true,
      calls: [{ executionStarted: true, state: 'succeeded' }],
      retrySafety: { safeToRetry: false },
    }),
  ]) {
    const decision = session.selectNext({
      failure,
      executionProgress,
      requestValid: true,
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, 'tool_execution_started');
  }
  assert.deepEqual(created, ['primary']);
});

test('denies switching after timeout or any unknown execution outcome', () => {
  const { policy } = createPolicy();
  const session = policy.createSession();
  const initial = session.selectInitial();

  const decision = session.assessNext({
    failure: createRetryableFailure(initial),
    executionProgress: retryProgress({
      hasExecutionStarted: true,
      hasUncertainOutcome: true,
      calls: [{ executionStarted: true, state: 'unknown' }],
      retrySafety: { safeToRetry: false },
    }),
    requestValid: true,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, 'execution_outcome_unknown');
});

test('denies provider switching after pre-dispatch tool validation or permission failures', () => {
  const { policy } = createPolicy();
  const session = policy.createSession();
  const initial = session.selectInitial();

  for (const code of ['TOOL_ARGUMENTS_INVALID', 'TOOL_PERMISSION_DENIED', 'TOOL_NOT_FOUND']) {
    const decision = session.assessNext({
      failure: createRetryableFailure(initial),
      executionProgress: retryProgress({
        calls: [{
          executionStarted: false,
          state: 'failed',
          error: { code },
        }],
      }),
      requestValid: true,
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, 'pre_execution_tool_call_failed');
  }
});

test('denies switching after malformed provider responses, validation, and permission errors', () => {
  const { policy } = createPolicy();
  const session = policy.createSession();
  session.selectInitial();

  const failures = [
    {
      code: 'INVALID_GEMINI_RESPONSE',
      kind: 'protocol',
      providerFailure: null,
    },
    {
      code: 'TOOL_ARGUMENTS_INVALID',
      kind: 'validation',
    },
    {
      code: 'TOOL_PERMISSION_DENIED',
      kind: 'tool_execution',
    },
  ];
  for (const failure of failures) {
    const decision = session.assessNext({
      failure,
      executionProgress: retryProgress(),
      requestValid: true,
    });
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, 'failure_not_provider_generation');
  }
});

test('requires a valid request and reliable execution progress for switching', () => {
  const { policy } = createPolicy();
  const session = policy.createSession();
  const initial = session.selectInitial();
  const failure = createRetryableFailure(initial);

  assert.equal(session.assessNext({
    failure,
    executionProgress: retryProgress(),
    requestValid: false,
  }).reason, 'request_invalid_or_unconfirmed');
  assert.equal(session.assessNext({
    failure,
    executionProgress: null,
    requestValid: true,
  }).reason, 'execution_progress_unavailable');
  assert.equal(session.assessNext({
    failure,
    executionProgress: retryProgress({
      retrySafety: { safeToRetry: false },
    }),
    requestValid: true,
  }).reason, 'retry_safety_denied');
  assert.equal(session.assessNext({
    failure,
    executionProgress: retryProgress({
      calls: [{ executionStarted: false, state: 'succeeded' }],
    }),
    requestValid: true,
  }).reason, 'tool_execution_started');
  assert.equal(session.assessNext({
    failure,
    executionProgress: retryProgress({
      calls: [{ executionStarted: false, state: 'unrecognized' }],
    }),
    requestValid: true,
  }).reason, 'execution_progress_unavailable');
});

test('enforces retry-budget exhaustion and does not allow unbounded switches', () => {
  const { policy } = createPolicy({ maxProviderAttempts: 1 });
  const session = policy.createSession();
  const initial = session.selectInitial();

  const decision = session.assessNext({
    failure: createRetryableFailure(initial),
    executionProgress: retryProgress(),
    requestValid: true,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, 'provider_attempt_budget_exhausted');
});

test('preserves provider cause, status/code, model identity, and progress through the pipeline', async () => {
  const originalProviderError = Object.assign(
    new Error('private provider details'),
    { status: 503, code: 'OVERLOADED' },
  );
  const { policy } = createPolicy();
  const session = policy.createSession();
  const selection = session.selectInitial();
  const providerGenerator = createGeminiToolGenerator({
    model: selection.modelId,
    generateContent: async () => {
      throw originalProviderError;
    },
  });
  const assistantWithProvider = createActualAssistant(
    providerGenerator,
  ).assistant;

  await assert.rejects(
    assistantWithProvider.run({
      request: REQUEST,
      applicationContext: PRIVATE_CONTEXT,
    }),
    (error) => {
      assert.equal(error.kind, 'provider');
      assert.equal(error.code, 'GENERATOR_FAILED');
      assert.equal(error.cause instanceof ToolOrchestrationError, true);
      assert.equal(error.cause.cause instanceof GeminiToolAdapterError, true);
      assert.equal(error.cause.cause.cause, originalProviderError);
      assert.deepEqual(error.providerFailure, {
        providerId: 'google-gemini',
        modelId: 'model-primary',
        status: 503,
        code: 'OVERLOADED',
        retryable: true,
      });
      assert.equal(error.executionProgress.hasExecutionStarted, false);
      assert.equal(
        session.assessNext({
          failure: error,
          executionProgress: error.executionProgress,
          requestValid: true,
        }).eligible,
        true,
      );
      assert.equal(selection.modelId, 'model-primary');
      return true;
    },
  );
});

test('denies provider switching after a completed handler and preserves the partial result', async () => {
  let handlerCalls = 0;
  let providerCalls = 0;
  const { policy } = createPolicy();
  const session = policy.createSession();
  const selection = session.selectInitial();
  const providerCause = Object.assign(
    new Error('later generation failed'),
    { status: 503 },
  );
  const generator = createGeminiToolGenerator({
    model: selection.modelId,
    generateContent: async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          functionCalls: [{
            id: 'completed-call',
            name: 'lookup_data',
            args: {},
          }],
        };
      }
      throw providerCause;
    },
  });
  const { assistant } = createActualAssistant(generator, async () => {
    handlerCalls += 1;
    return { value: 'completed result' };
  });

  await assert.rejects(
    assistant.run({
      request: REQUEST,
      applicationContext: PRIVATE_CONTEXT,
    }),
    (error) => {
      assert.equal(error.kind, 'provider');
      assert.equal(error.providerFailure.retryable, true);
      assert.equal(error.executionProgress.calls[0].state, 'succeeded');
      assert.equal(error.functionResponses[0].result.value, 'completed result');
      const decision = session.assessNext({
        failure: error,
        executionProgress: error.executionProgress,
        requestValid: true,
      });
      assert.equal(decision.eligible, false);
      assert.equal(decision.reason, 'tool_execution_started');
      return true;
    },
  );
  assert.equal(handlerCalls, 1);
  assert.equal(providerCalls, 2);
});

test('makes malformed Gemini responses a protocol failure, not a retryable provider failure', async () => {
  const selection = {
    providerId: 'google-gemini',
    modelId: 'model-primary',
  };
  const policy = createPolicy().policy.createSession();
  policy.selectInitial();
  const { assistant } = createActualAssistant(createGeminiToolGenerator({
    model: selection.modelId,
    generateContent: async () => ({ functionCalls: 'not-an-array' }),
  }));

  await assert.rejects(
    assistant.run({
      request: REQUEST,
      applicationContext: PRIVATE_CONTEXT,
    }),
    (error) => {
      assert.equal(error.kind, 'protocol');
      assert.equal(error.code, 'INVALID_GEMINI_RESPONSE');
      assert.equal(error.executionProgress.hasExecutionStarted, false);
      assert.equal(policy.assessNext({
        failure: error,
        executionProgress: error.executionProgress,
        requestValid: true,
      }).eligible, false);
      return true;
    },
  );
});

test('denies retry for malformed function-call history before another provider request', async () => {
  const policySession = createPolicy().policy.createSession();
  policySession.selectInitial();
  let providerCalls = 0;
  const adapter = createGeminiToolGenerator({
    model: 'model-primary',
    generateContent: async () => {
      providerCalls += 1;
      return { text: 'Not expected.' };
    },
  });
  const registry = createToolRegistry();
  const executor = createToolExecutor({ registry });
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: ({ input, tools }) => adapter({
      input,
      tools,
      functionResponses: [{
        round: 1,
        roundCallIndex: 1,
        roundCallCount: 2,
        call: {
          id: 'incomplete-call',
          name: 'lookup_data',
          arguments: {},
        },
        id: 'incomplete-call',
        name: 'lookup_data',
        result: { ok: true },
      }],
    }),
  });

  await assert.rejects(orchestrator.run('Request.'), (error) => {
    assert.equal(error.kind, 'protocol');
    assert.equal(error.code, 'INVALID_FUNCTION_RESPONSES');
    assert.equal(policySession.assessNext({
      failure: error,
      executionProgress: error.executionProgress,
      requestValid: true,
    }).eligible, false);
    return true;
  });
  assert.equal(providerCalls, 0);
});

test('policy never invokes another provider or replays orchestration automatically', async () => {
  let orchestrationCalls = 0;
  let primaryCalls = 0;
  let backupCalls = 0;
  const { policy, created } = createPolicy({
    generators: {
      primary: async () => {
        primaryCalls += 1;
        throw new Error('provider failed');
      },
      backup: async () => {
        backupCalls += 1;
        return { text: 'backup response' };
      },
    },
  });
  const session = policy.createSession();
  const selection = session.selectInitial();
  const { assistant } = createActualAssistant(async (...args) => {
    orchestrationCalls += 1;
    return selection.generator(...args);
  });

  await assert.rejects(assistant.run({
    request: REQUEST,
    applicationContext: PRIVATE_CONTEXT,
  }), { code: 'GENERATOR_FAILED' });

  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 0);
  assert.equal(orchestrationCalls, 1);
  assert.deepEqual(created, ['primary']);
});

test('retry budget counts selected providers and prevents returning to an earlier model', () => {
  const { policy } = createPolicy();
  const session = policy.createSession();
  let selection = session.selectInitial();
  for (const expectedModel of ['model-backup', 'model-third']) {
    const failure = createRetryableFailure(selection);
    const decision = session.selectNext({
      failure,
      executionProgress: retryProgress(),
      requestValid: true,
    });
    assert.equal(decision.eligible, true);
    selection = decision.selection;
    assert.equal(selection.modelId, expectedModel);
  }

  const exhausted = session.selectNext({
    failure: createRetryableFailure(selection),
    executionProgress: retryProgress(),
    requestValid: true,
  });
  assert.equal(exhausted.eligible, false);
  assert.equal(exhausted.reason, 'provider_attempt_budget_exhausted');
});

test('does not classify a valid pre-execution retry from retrySafety alone', () => {
  const { policy } = createPolicy();
  const session = policy.createSession();
  session.selectInitial();
  const decision = session.assessNext({
    failure: {
      code: 'GENERATOR_FAILED',
      kind: 'provider',
      retrySafety: { safeToRetry: true },
    },
    executionProgress: retryProgress(),
    requestValid: true,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, 'provider_failure_not_retryable');
});
