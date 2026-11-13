import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createToolOrchestrator, ToolOrchestrationError } from '../src/ai/tool-orchestrator.js';
import { createToolRegistry } from '../src/ai/tools/tool-registry.js';
import { createToolExecutor } from '../src/ai/tools/tool-executor.js';

const emptyObjectSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};
const AUTHORIZED_CONTEXT = {
  authorizedTools: ['lookup_data'],
  grantedCapabilities: ['lookup'],
};

function createRegistry({ name = 'lookup_data', handler = async () => ({ value: 'ok' }) } = {}) {
  const registry = createToolRegistry();
  registry.register({
    name,
    description: 'Read an allowlisted value.',
    inputSchema: emptyObjectSchema,
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler,
  });
  return registry;
}

function functionCall(id, name = 'lookup_data', args = {}) {
  return { id, name, arguments: args };
}

function createFakeExecutor(implementation = async () => ({ value: 'ok' })) {
  const calls = [];
  return {
    calls,
    executor: {
      isBoundTo() {
        return true;
      },
      async execute(...args) {
        calls.push(args);
        return implementation(...args);
      },
    },
  };
}

test('returns normal text and provides registry declarations through the generator contract', async () => {
  const registry = createRegistry();
  const { executor, calls } = createFakeExecutor();
  const input = { messages: [{ role: 'user', text: 'hello' }] };
  let request;
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async (value) => {
      request = value;
      return { text: '  Hello back.  ' };
    },
  });

  const result = await orchestrator.run(input, AUTHORIZED_CONTEXT);
  assert.equal(result.text, 'Hello back.');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.executionProgress.state, 'not_started');
  assert.equal(result.executionProgress.hasExecutionStarted, false);
  assert.equal(result.retrySafety.safeToRetry, true);
  assert.equal(request.input, input);
  assert.equal(request.tools[0].name, 'lookup_data');
  assert.deepEqual(Object.keys(request.tools[0]).sort(), [
    'description',
    'name',
    'parametersJsonSchema',
  ]);
  assert.deepEqual(request.functionResponses, []);
  assert.deepEqual(calls, []);
});

test('filters declarations to registered tools with all required granted capabilities', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'read_private_notes',
    description: 'Read private notes.',
    inputSchema: emptyObjectSchema,
    category: 'read_only',
    requiredCapabilities: ['lookup', 'private_context'],
    handler: async () => ({ value: 'secret' }),
  });
  let observedTools;
  const orchestrator = createToolOrchestrator({
    registry,
    executor: createToolExecutor({ registry }),
    generator: async ({ tools }) => {
      observedTools = tools;
      return { text: 'No eligible private-note tool.' };
    },
  });

  await orchestrator.run('input', AUTHORIZED_CONTEXT);

  assert.deepEqual(observedTools.map(({ name }) => name), ['lookup_data']);
});

test('model-requested tools excluded from declarations are denied before dispatch', async () => {
  let executions = 0;
  const registry = createRegistry();
  registry.register({
    name: 'read_private_notes',
    description: 'Read private notes.',
    inputSchema: emptyObjectSchema,
    category: 'read_only',
    requiredCapabilities: ['lookup', 'private_context'],
    handler: async () => {
      executions += 1;
      return { value: 'secret' };
    },
  });
  let generation = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor: createToolExecutor({ registry }),
    generator: async ({ tools }) => {
      generation += 1;
      assert.deepEqual(tools.map(({ name }) => name), ['lookup_data']);
      return generation === 1
        ? {
          functionCalls: [
            functionCall('excluded-tool', 'read_private_notes'),
          ],
        }
        : { text: 'Not available.' };
    },
  });

  const result = await orchestrator.run({
    authorizedTools: ['read_private_notes'],
    grantedCapabilities: ['private_context'],
  }, AUTHORIZED_CONTEXT);

  assert.equal(result.functionResponses[0].error.code, 'TOOL_PERMISSION_DENIED');
  assert.equal(executions, 0);
});

test('missing or malformed authorization context exposes no declarations', async () => {
  const registry = createRegistry();
  for (const trustedContext of [
    undefined,
    {},
    { authorizedTools: ['lookup_data'] },
    {
      authorizedTools: ['not_registered'],
      grantedCapabilities: ['lookup'],
    },
  ]) {
    let observedTools;
    const orchestrator = createToolOrchestrator({
      registry,
      executor: createToolExecutor({ registry }),
      generator: async ({ tools }) => {
        observedTools = tools;
        return { text: 'No eligible tools.' };
      },
    });
    await orchestrator.run('input', trustedContext);
    assert.deepEqual(observedTools, []);
  }
});

test('executor rechecks capabilities if the trusted grant changes after declaration generation', async () => {
  let executions = 0;
  const registry = createRegistry({
    handler: async () => {
      executions += 1;
      return { value: 'must not run' };
    },
  });
  const executor = createToolExecutor({ registry });
  const context = {
    authorizedTools: ['lookup_data'],
    grantedCapabilities: ['lookup'],
  };
  let generation = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async ({ tools }) => {
      generation += 1;
      if (generation === 1) {
        assert.deepEqual(tools.map(({ name }) => name), ['lookup_data']);
        context.grantedCapabilities = [];
        return { functionCalls: [functionCall('revoked-call')] };
      }
      return { text: 'Denied.' };
    },
  });

  const result = await orchestrator.run('input', context);

  assert.equal(result.functionResponses[0].error.code, 'TOOL_PERMISSION_DENIED');
  assert.equal(result.executionProgress.calls[0].executionStarted, false);
  assert.equal(executions, 0);
});

test('executes a successful tool through the executor and returns its function response', async () => {
  const registry = createRegistry();
  const executor = createToolExecutor({ registry });
  const requests = [];
  let invocation = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async (request) => {
      requests.push(request);
      invocation += 1;
      return invocation === 1
        ? { functionCalls: [functionCall('call-1')] }
        : { text: 'Found the value.' };
    },
  });

  const result = await orchestrator.run(
    { prompt: 'lookup' },
    AUTHORIZED_CONTEXT,
  );
  assert.equal(result.text, 'Found the value.');
  assert.equal(result.executionProgress.hasExecutionStarted, true);
  assert.equal(result.executionProgress.calls[0].state, 'succeeded');
  assert.equal(result.retrySafety.safeToRetry, false);
  assert.deepEqual(requests[1].functionResponses, [{
    round: 1,
    roundCallIndex: 1,
    roundCallCount: 1,
    call: {
      id: 'call-1',
      name: 'lookup_data',
      arguments: {},
    },
    id: 'call-1',
    name: 'lookup_data',
    result: { value: 'ok' },
  }]);
});

test('executes multiple calls in order and returns every function response', async () => {
  const registry = createRegistry();
  const { executor, calls } = createFakeExecutor(async (name, args) => ({
    name,
    value: args.value,
  }));
  const requests = [];
  let invocation = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async (request) => {
      requests.push(request);
      invocation += 1;
      return invocation === 1
        ? {
          functionCalls: [
            functionCall('first', 'lookup_data', { value: 1 }),
            functionCall('second', 'lookup_data', { value: 2 }),
          ],
        }
        : { text: 'Both done.' };
    },
  });

  const result = await orchestrator.run('input', AUTHORIZED_CONTEXT);
  assert.equal(result.text, 'Both done.');
  assert.deepEqual(
    result.executionProgress.calls.map(({ state }) => state),
    ['succeeded', 'succeeded'],
  );
  assert.deepEqual(calls.map(([name, args]) => [name, args]), [
    ['lookup_data', { value: 1 }],
    ['lookup_data', { value: 2 }],
  ]);
  assert.deepEqual(requests[1].functionResponses.map(({ result }) => result), [
    { name: 'lookup_data', value: 1 },
    { name: 'lookup_data', value: 2 },
  ]);
});

test('supports multiple tool-call rounds and sends accumulated responses', async () => {
  const registry = createRegistry();
  const { executor, calls } = createFakeExecutor();
  const requests = [];
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return { functionCalls: [functionCall('first')] };
      }
      if (requests.length === 2) {
        return { functionCalls: [functionCall('second')] };
      }
      return { text: 'Finished.' };
    },
  });

  const result = await orchestrator.run('input', AUTHORIZED_CONTEXT);
  assert.equal(result.text, 'Finished.');
  assert.deepEqual(
    result.executionProgress.calls.map(({ state }) => state),
    ['succeeded', 'succeeded'],
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(
    requests[2].functionResponses.map(({ id }) => id),
    ['first', 'second'],
  );
});

test('returns unknown-tool errors to the generator without calling the executor', async () => {
  const registry = createRegistry();
  const { executor, calls } = createFakeExecutor();
  let invocation = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async (request) => {
      invocation += 1;
      if (invocation === 1) {
        return { functionCalls: [functionCall('unknown', 'not_registered')] };
      }
      assert.deepEqual(request.functionResponses[0].error, {
        code: 'TOOL_NOT_FOUND',
        message: 'Requested tool is not available.',
      });
      return { text: 'Tool unavailable.' };
    },
  });

  const result = await orchestrator.run('input');
  assert.equal(result.text, 'Tool unavailable.');
  assert.equal(result.executionProgress.calls[0].state, 'failed');
  assert.equal(result.executionProgress.hasExecutionStarted, false);
  assert.equal(result.retrySafety.safeToRetry, true);
  assert.deepEqual(calls, []);
});

test('rejects malformed generator responses and function calls before execution', async () => {
  const registry = createRegistry();
  const { executor, calls } = createFakeExecutor();
  for (const response of [
    null,
    { text: 'ambiguous', functionCalls: [functionCall('ambiguous')] },
    { functionCalls: null },
    { functionCalls: [functionCall('', 'lookup_data')] },
    { functionCalls: [{ id: 'missing-name', arguments: {} }] },
    { functionCalls: [functionCall('bad-args', 'lookup_data', [])] },
    { unsupported: true },
  ]) {
    const orchestrator = createToolOrchestrator({
      registry,
      executor,
      generator: async () => response,
    });
    await assert.rejects(
      orchestrator.run('input'),
      ToolOrchestrationError,
      JSON.stringify(response),
    );
  }
  assert.deepEqual(calls, []);
});

test('normalizes executor failures without leaking internal details', async () => {
  const registry = createRegistry();
  for (const [code, expectedCode, expectedMessage] of [
    ['TOOL_PERMISSION_DENIED', 'TOOL_PERMISSION_DENIED', 'Tool permission denied.'],
    ['TOOL_TIMEOUT', 'TOOL_TIMEOUT', 'Tool execution timed out.'],
    ['TOOL_ARGUMENTS_INVALID', 'TOOL_ARGUMENTS_INVALID', 'Tool arguments are invalid.'],
    ['INTERNAL_FAILURE', 'TOOL_EXECUTION_FAILED', 'Tool execution failed.'],
  ]) {
    const { executor } = createFakeExecutor(async () => {
      throw Object.assign(new Error('private stack or secret'), {
        code,
        executionStarted: ['TOOL_TIMEOUT', 'INTERNAL_FAILURE'].includes(code),
        outcomeUnknown: code === 'TOOL_TIMEOUT',
      });
    });
    let invocation = 0;
    const orchestrator = createToolOrchestrator({
      registry,
      executor,
      generator: async (request) => {
        invocation += 1;
        if (invocation === 1) {
          return { functionCalls: [functionCall(`call-${code}`)] };
        }
        const error = request.functionResponses[0].error;
        assert.deepEqual(error, {
          code: expectedCode,
          message: expectedMessage,
        });
        assert.equal(JSON.stringify(error).includes('private'), false);
        return { text: 'Handled.' };
      },
    });
    if (code === 'TOOL_TIMEOUT') {
      await assert.rejects(orchestrator.run('input', AUTHORIZED_CONTEXT), (error) =>
        error.code === 'TOOL_OUTCOME_UNKNOWN' &&
        error.kind === 'tool_execution' &&
        error.executionProgress.hasUncertainOutcome &&
        error.executionProgress.calls[0].state === 'unknown' &&
        error.retrySafety.safeToRetry === false,
      );
      assert.equal(invocation, 1);
    } else {
      const result = await orchestrator.run('input', AUTHORIZED_CONTEXT);
      assert.equal(result.text, 'Handled.');
      assert.equal(result.executionProgress.calls[0].state, 'failed');
      assert.equal(
        result.retrySafety.safeToRetry,
        !['INTERNAL_FAILURE'].includes(code),
      );
    }
  }
});

test('normalizes generator failures and invalid output', async () => {
  const registry = createRegistry();
  const executor = createFakeExecutor().executor;
  const failing = createToolOrchestrator({
    registry,
    executor,
    generator: async () => {
      throw new Error('provider credentials must not escape');
    },
  });
  await assert.rejects(
    failing.run('input'),
    (error) => error.code === 'GENERATOR_FAILED' &&
    error.kind === 'provider' &&
    error.message === 'The response generator failed.' &&
    !error.message.includes('credentials') &&
    error.executionProgress.hasExecutionStarted === false &&
    error.retrySafety.safeToRetry === true,
  );

  const invalidOutput = createToolOrchestrator({
    registry,
    executor: createFakeExecutor(async () => undefined).executor,
    generator: async (request) => request.functionResponses.length
      ? { text: 'Handled.' }
      : { functionCalls: [functionCall('invalid-output')] },
  });
  const result = await invalidOutput.run('input');
  assert.equal(result.text, 'Handled.');
  assert.equal(result.executionProgress.calls[0].state, 'failed');
});

test('preserves successful tool results when a later provider generation fails', async () => {
  const registry = createRegistry();
  let executions = 0;
  const executor = createToolExecutor({ registry });
  let generations = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor: {
      isBoundTo(candidateRegistry) {
        return executor.isBoundTo(candidateRegistry);
      },
      async execute(...args) {
        executions += 1;
        return executor.execute(...args);
      },
    },
    createRequestId: () => 'trusted-request-1',
    generator: async () => {
      generations += 1;
      if (generations === 1) {
        return { functionCalls: [functionCall('provider-call-1')] };
      }
      throw new Error('provider went away');
    },
  });

  await assert.rejects(orchestrator.run('input', {
    authorizedTools: ['lookup_data'],
    grantedCapabilities: ['lookup'],
  }), (error) => {
    assert.equal(error.code, 'GENERATOR_FAILED');
    assert.equal(error.kind, 'provider');
    assert.equal(error.executionProgress.requestId, 'trusted-request-1');
    assert.equal(error.executionProgress.calls[0].providerCallId, 'provider-call-1');
    assert.equal(error.executionProgress.calls[0].state, 'succeeded');
    assert.deepEqual(error.functionResponses[0].result, { value: 'ok' });
    assert.equal(error.retrySafety.safeToRetry, false);
    return true;
  });
  assert.equal(generations, 2);
  assert.equal(executions, 1);
});

test('reports executor schema validation failure before dispatch as retry-safe', async () => {
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read an allowlisted value.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 10 } },
      required: ['query'],
      additionalProperties: false,
    },
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler: async () => {
      throw new Error('must not execute');
    },
  });
  const executor = createToolExecutor({ registry });
  let invocation = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async (request) => {
      invocation += 1;
      if (invocation === 1) {
        return {
          functionCalls: [functionCall('bad-args', 'lookup_data', { unexpected: true })],
        };
      }
      assert.equal(request.functionResponses[0].error.code, 'TOOL_ARGUMENTS_INVALID');
      return { text: 'Invalid call handled.' };
    },
  });

  const result = await orchestrator.run('input', {
    authorizedTools: ['lookup_data'],
    grantedCapabilities: ['lookup'],
  });
  assert.equal(result.executionProgress.calls[0].state, 'failed');
  assert.equal(result.executionProgress.calls[0].executionStarted, false);
  assert.equal(result.retrySafety.safeToRetry, true);
});

test('records a started handler failure as failed and unsafe to replay', async () => {
  const registry = createRegistry({
    handler: async () => {
      throw new Error('private handler failure');
    },
  });
  const executor = createToolExecutor({ registry });
  let invocation = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async (request) => {
      invocation += 1;
      if (invocation === 1) {
        return { functionCalls: [functionCall('failed-call')] };
      }
      assert.deepEqual(request.functionResponses[0].error, {
        code: 'TOOL_EXECUTION_FAILED',
        message: 'Tool execution failed.',
      });
      return { text: 'Failure handled.' };
    },
  });

  const result = await orchestrator.run('input', {
    authorizedTools: ['lookup_data'],
    grantedCapabilities: ['lookup'],
  });
  assert.equal(result.executionProgress.calls[0].state, 'failed');
  assert.equal(result.executionProgress.calls[0].executionStarted, true);
  assert.equal(result.retrySafety.safeToRetry, false);
  assert.equal(JSON.stringify(result).includes('private handler failure'), false);
});

test('marks timed-out execution unknown and does not ask the generator again', async () => {
  const registry = createRegistry({
    handler: () => new Promise(() => {}),
  });
  const executor = createToolExecutor({ registry, timeoutMs: 10 });
  let generations = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async () => {
      generations += 1;
      return { functionCalls: [functionCall('timeout-call')] };
    },
  });

  await assert.rejects(orchestrator.run('input', {
    authorizedTools: ['lookup_data'],
    grantedCapabilities: ['lookup'],
  }), (error) => {
    assert.equal(error.code, 'TOOL_OUTCOME_UNKNOWN');
    assert.equal(error.executionProgress.calls[0].state, 'unknown');
    assert.equal(error.executionProgress.calls[0].executionStarted, true);
    assert.equal(error.executionProgress.hasUncertainOutcome, true);
    assert.equal(error.retrySafety.reason, 'execution_outcome_unknown');
    assert.equal(error.retrySafety.safeToRetry, false);
    assert.equal(error.functionResponses[0].error.code, 'TOOL_TIMEOUT');
    return true;
  });
  assert.equal(generations, 1);
});

test('treats an unclassified post-dispatch executor failure as uncertain', async () => {
  const registry = createRegistry();
  let generations = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor: {
      isBoundTo() {
        return true;
      },
      async execute(_name, _args, _context, { onStarted }) {
        onStarted();
        throw new Error('completion cannot be confirmed');
      },
    },
    generator: async () => {
      generations += 1;
      return { functionCalls: [functionCall('uncertain-call')] };
    },
  });

  await assert.rejects(orchestrator.run('input', AUTHORIZED_CONTEXT), (error) =>
    error.code === 'TOOL_OUTCOME_UNKNOWN' &&
    error.executionProgress.calls[0].state === 'unknown' &&
    error.retrySafety.safeToRetry === false,
  );
  assert.equal(generations, 1);
});

test('rejects a repeated provider call ID across rounds without executing it twice', async () => {
  const registry = createRegistry();
  const { executor, calls } = createFakeExecutor();
  let invocation = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async () => {
      invocation += 1;
      if (invocation === 1) {
        return { functionCalls: [functionCall('same-id')] };
      }
      return { functionCalls: [functionCall('same-id')] };
    },
  });

  await assert.rejects(orchestrator.run('input', AUTHORIZED_CONTEXT), (error) =>
    error.code === 'DUPLICATE_FUNCTION_CALL_ID' &&
    error.executionProgress.calls.length === 1 &&
    error.executionProgress.calls[0].state === 'succeeded' &&
    error.functionResponses.length === 1 &&
    error.retrySafety.safeToRetry === false,
  );
  assert.equal(calls.length, 1);
});

test('keeps separate progress for multiple calls and identifies validated undispatched calls', async () => {
  const registry = createRegistry();
  let invocation = 0;
  const executor = {
    isBoundTo() {
      return true;
    },
    async execute(name, args, context, hooks) {
      if (args.fail) {
        hooks.onStarted();
        throw Object.assign(new Error('failure'), {
          code: 'TOOL_EXECUTION_FAILED',
          executionStarted: true,
        });
      }
      hooks.onStarted();
      return { value: 'ok' };
    },
  };
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    maxCallsPerRound: 2,
    generator: async () => {
      invocation += 1;
      if (invocation === 1) {
        return {
          functionCalls: [
            functionCall('first', 'lookup_data', {}),
            functionCall('second', 'lookup_data', { fail: true }),
          ],
        };
      }
      return { text: 'Handled.' };
    },
  });

  const result = await orchestrator.run('input', AUTHORIZED_CONTEXT);
  assert.deepEqual(
    result.executionProgress.calls.map(({ providerCallId, state }) => ({
      providerCallId,
      state,
    })),
    [
      { providerCallId: 'first', state: 'succeeded' },
      { providerCallId: 'second', state: 'failed' },
    ],
  );
  assert.equal(result.retrySafety.safeToRetry, false);
});

test('enforces round, per-round, and total call limits before execution', async () => {
  const registry = createRegistry();
  const { executor, calls } = createFakeExecutor();

  const maxRounds = createToolOrchestrator({
    registry,
    executor,
    maxToolRounds: 1,
    generator: async (request) => request.functionResponses.length
      ? { functionCalls: [functionCall('second-round')] }
      : { functionCalls: [functionCall('first-round')] },
  });
  await assert.rejects(
    maxRounds.run('input', AUTHORIZED_CONTEXT),
    { code: 'TOOL_ROUND_LIMIT' },
  );
  assert.equal(calls.length, 1);

  const tooManyAtOnce = createToolOrchestrator({
    registry,
    executor,
    maxCallsPerRound: 1,
    generator: async () => ({
      functionCalls: [
        functionCall('batch-1'),
        functionCall('batch-2'),
      ],
    }),
  });
  await assert.rejects(
    tooManyAtOnce.run('input', AUTHORIZED_CONTEXT),
    { code: 'TOOL_CALL_LIMIT' },
  );
  assert.equal(calls.length, 1);

  const totalLimit = createToolOrchestrator({
    registry,
    executor,
    maxTotalCalls: 1,
    generator: async (request) => request.functionResponses.length
      ? { functionCalls: [functionCall('over-total')] }
      : { functionCalls: [functionCall('within-total')] },
  });
  await assert.rejects(
    totalLimit.run('input', AUTHORIZED_CONTEXT),
    { code: 'TOOL_CALL_LIMIT' },
  );
  assert.equal(calls.length, 2);
});

test('rejects missing and duplicate call IDs without executing the malformed batch', async () => {
  const registry = createRegistry();
  const { executor, calls } = createFakeExecutor();
  for (const functionCalls of [
    [{ name: 'lookup_data', arguments: {} }],
    [
      functionCall('duplicate'),
      functionCall('duplicate'),
    ],
  ]) {
    const orchestrator = createToolOrchestrator({
      registry,
      executor,
      generator: async () => ({ functionCalls }),
    });
    await assert.rejects(orchestrator.run('input'), ToolOrchestrationError);
  }
  assert.deepEqual(calls, []);
});

test('never invokes the executor for an unregistered tool', async () => {
  const registry = createRegistry();
  let executorCalls = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor: {
      isBoundTo() {
        return true;
      },
      async execute() {
        executorCalls += 1;
        return {};
      },
    },
    generator: async (request) => request.functionResponses.length
      ? { text: 'Rejected.' }
      : { functionCalls: [functionCall('not-registered', 'unregistered_tool')] },
  });

  const result = await orchestrator.run('input', AUTHORIZED_CONTEXT);
  assert.equal(result.text, 'Rejected.');
  assert.equal(result.executionProgress.calls[0].state, 'failed');
  assert.equal(result.retrySafety.safeToRetry, true);
  assert.equal(executorCalls, 0);
});

test('rejects limits above hard caps and accepts downward configuration', () => {
  const registry = createRegistry();
  const executor = createFakeExecutor().executor;
  const generator = async () => ({ text: 'ok' });

  for (const options of [
    { maxToolRounds: 3 },
    { maxCallsPerRound: 4 },
    { maxTotalCalls: 7 },
    { maxFunctionResponseBytes: 64 * 1024 + 1 },
    { maxTotalCalls: -1 },
  ]) {
    assert.throws(
      () => createToolOrchestrator({ registry, executor, generator, ...options }),
    );
  }
  assert.doesNotThrow(() => createToolOrchestrator({
    registry,
    executor,
    generator,
    maxToolRounds: 0,
    maxCallsPerRound: 1,
    maxTotalCalls: 2,
  }));
});

test('rejects mismatched registry bindings and caps aggregate function history without replay', async () => {
  const registry = createRegistry();
  const otherRegistry = createRegistry({ name: 'other_tool' });
  const executor = createToolExecutor({ registry: otherRegistry });
  assert.throws(() => createToolOrchestrator({
    registry,
    executor,
    generator: async () => ({ text: 'not reached' }),
  }), /same registry/);

  const matchingExecutor = createToolExecutor({ registry });
  let executions = 0;
  const orchestrator = createToolOrchestrator({
    registry,
    executor: {
      isBoundTo(candidateRegistry) {
        return matchingExecutor.isBoundTo(candidateRegistry);
      },
      async execute(...args) {
        executions += 1;
        return matchingExecutor.execute(...args);
      },
    },
    maxFunctionResponseBytes: 64,
    generator: async () => ({
      functionCalls: [functionCall('large-response')],
    }),
  });
  await assert.rejects(orchestrator.run('input', {
    authorizedTools: ['lookup_data'],
    grantedCapabilities: ['lookup'],
  }), (error) =>
    error.code === 'FUNCTION_RESPONSE_HISTORY_TOO_LARGE' &&
    error.functionResponses.length === 1 &&
    error.executionProgress.calls[0].state === 'succeeded' &&
    error.retrySafety.safeToRetry === false,
  );
  assert.equal(executions, 1);
});

test('imports safely without SDK-specific dependencies or filesystem side effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-tool-orchestrator-'));
  const moduleUrl = pathToFileURL(
    join(process.cwd(), 'src', 'ai', 'tool-orchestrator.js'),
  ).href;

  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', 'await import(process.argv[1])', moduleUrl],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
