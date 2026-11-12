import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantRequest } from '../src/ai/assistant-request.js';
import {
  createGeminiToolGenerator,
  GeminiToolAdapterError,
} from '../src/ai/gemini-tool-adapter.js';
import {
  createToolOrchestrator,
  ToolOrchestrationError,
} from '../src/ai/tool-orchestrator.js';
import { createToolRegistry } from '../src/ai/tools/tool-registry.js';
import { createToolExecutor } from '../src/ai/tools/tool-executor.js';

const lookupSchema = {
  type: 'object',
  properties: { key: { type: 'string', maxLength: 20 } },
  required: ['key'],
  additionalProperties: false,
};

function createRequest(overrides = {}) {
  return createAssistantRequest({
    question: 'Look up these values.',
    systemInstruction: 'Be accurate.',
    history: [
      { role: 'user', parts: [{ text: 'Previous question.' }] },
      { role: 'model', parts: [{ text: 'Previous answer.' }] },
    ],
    ...overrides,
  });
}

function createRegistry(handler = async ({ key }) => ({ key, value: `value:${key}` })) {
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read an allowlisted value.',
    inputSchema: lookupSchema,
    category: 'read_only',
    handler,
  });
  return registry;
}

function createPipeline({ registry, generateContent, ...options }) {
  const executor = createToolExecutor({
    registry,
    ...(options.executorOptions || {}),
  });
  const generator = createGeminiToolGenerator({
    model: 'gemini-fake',
    generateContent,
    ...(options.adapterOptions || {}),
  });
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator,
    ...(options.orchestratorOptions || {}),
  });
  return { executor, generator, orchestrator };
}

test('composes DTO, Gemini adapter, orchestrator, executor, and history across multi-call rounds', async () => {
  const registry = createRegistry();
  const requests = [];
  let generation = 0;
  const { orchestrator } = createPipeline({
    registry,
    generateContent: async (request) => {
      requests.push(request);
      generation += 1;
      if (generation === 1) {
        return {
          functionCalls: [
            { id: 'provider-alpha', name: 'lookup_data', args: { key: 'alpha' } },
            { id: 'provider-beta', name: 'lookup_data', args: { key: 'beta' } },
          ],
        };
      }
      if (generation === 2) {
        assert.deepEqual(request.contents.slice(-2), [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'provider-alpha',
                  name: 'lookup_data',
                  args: { key: 'alpha' },
                },
              },
              {
                functionCall: {
                  id: 'provider-beta',
                  name: 'lookup_data',
                  args: { key: 'beta' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'provider-alpha',
                  name: 'lookup_data',
                  response: { output: { key: 'alpha', value: 'value:alpha' } },
                },
              },
              {
                functionResponse: {
                  id: 'provider-beta',
                  name: 'lookup_data',
                  response: { output: { key: 'beta', value: 'value:beta' } },
                },
              },
            ],
          },
        ]);
        return {
          functionCalls: [{
            id: 'provider-gamma',
            name: 'lookup_data',
            args: { key: 'gamma' },
          }],
        };
      }
      assert.deepEqual(
        request.contents.slice(-4).map(({ role }) => role),
        ['model', 'user', 'model', 'user'],
      );
      return { text: 'All three values were found.' };
    },
  });
  const input = createRequest({
    image: {
      mimetype: 'image/png',
      data: Buffer.from('fake image').toString('base64'),
    },
  });

  const result = await orchestrator.run(input, {
    authorizedTools: ['lookup_data'],
  });
  assert.equal(result.text, 'All three values were found.');
  assert.deepEqual(result.executionProgress.calls.map(({ providerCallId }) =>
    providerCallId,
  ), ['provider-alpha', 'provider-beta', 'provider-gamma']);
  assert.deepEqual(result.functionResponses.map(({ round, roundCallIndex, roundCallCount }) =>
    ({ round, roundCallIndex, roundCallCount }),
  ), [
    { round: 1, roundCallIndex: 1, roundCallCount: 2 },
    { round: 1, roundCallIndex: 2, roundCallCount: 2 },
    { round: 2, roundCallIndex: 1, roundCallCount: 1 },
  ]);
  assert.deepEqual(result.functionResponses.map(({ result: toolResult }) =>
    toolResult.key,
  ), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(requests[0].contents, [
    { role: 'user', parts: [{ text: 'Previous question.' }] },
    { role: 'model', parts: [{ text: 'Previous answer.' }] },
    {
      role: 'user',
      parts: [
        { text: 'Look up these values.' },
        {
          inlineData: {
            mimeType: 'image/png',
            data: Buffer.from('fake image').toString('base64'),
          },
        },
      ],
    },
  ]);
  assert.equal(result.retrySafety.safeToRetry, false);
});

test('rejects invalid DTO before provider generation or tool execution', async () => {
  const registry = createRegistry();
  let providerCalls = 0;
  const { orchestrator } = createPipeline({
    registry,
    generateContent: async () => {
      providerCalls += 1;
      return { text: 'unreachable' };
    },
  });

  await assert.rejects(orchestrator.run({
    version: 1,
    modelInput: {},
    metadata: { conversationType: 'private' },
  }), (error) =>
    error instanceof ToolOrchestrationError &&
    error.code === 'GENERATOR_FAILED' &&
    error.executionProgress.hasExecutionStarted === false &&
    error.retrySafety.safeToRetry === true,
  );
  assert.equal(providerCalls, 0);
});

test('distinguishes provider failure before execution and malformed provider calls', async () => {
  const registry = createRegistry();
  for (const generateContent of [
    async () => { throw new Error('provider credentials'); },
    async () => ({
      functionCalls: [{ id: 'bad', name: 'lookup_data', args: [] }],
    }),
    async () => ({
      functionCalls: [
        { id: 'duplicate', name: 'lookup_data', args: {} },
        { id: 'duplicate', name: 'lookup_data', args: {} },
      ],
    }),
  ]) {
    let executions = 0;
    const perCaseRegistry = createRegistry(async () => {
      executions += 1;
      return {};
    });
    const { orchestrator } = createPipeline({
      registry: perCaseRegistry,
      generateContent,
    });
    await assert.rejects(orchestrator.run(createRequest()), (error) =>
      error.code === 'GENERATOR_FAILED' &&
      error.executionProgress.hasExecutionStarted === false &&
      error.retrySafety.safeToRetry === true,
    );
    assert.equal(executions, 0);
  }
  assert.equal(registry.size, 1);
});

test('normalizes unknown tools, invalid arguments, and permission denial without dispatch', async () => {
  const scenarios = [
    {
      name: 'unknown tool',
      toolName: 'missing_tool',
      args: {},
      authorizedTools: ['lookup_data'],
      expected: 'TOOL_NOT_FOUND',
    },
    {
      name: 'invalid arguments',
      toolName: 'lookup_data',
      args: { unexpected: true },
      authorizedTools: ['lookup_data'],
      expected: 'TOOL_ARGUMENTS_INVALID',
    },
    {
      name: 'permission denied',
      toolName: 'lookup_data',
      args: { key: 'value' },
      authorizedTools: [],
      expected: 'TOOL_PERMISSION_DENIED',
    },
  ];

  for (const scenario of scenarios) {
    let executions = 0;
    let providerCalls = 0;
    const registry = createRegistry(async () => {
      executions += 1;
      return {};
    });
    const { orchestrator } = createPipeline({
      registry,
      generateContent: async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? {
            functionCalls: [{
              id: `call-${scenario.expected}`,
              name: scenario.toolName,
              args: scenario.args,
            }],
          }
          : { text: 'Handled.' };
      },
    });
    const result = await orchestrator.run(createRequest(), {
      authorizedTools: scenario.authorizedTools,
    });
    assert.equal(result.text, 'Handled.', scenario.name);
    assert.equal(result.functionResponses[0].error.code, scenario.expected);
    assert.equal(result.executionProgress.calls[0].executionStarted, false);
    assert.equal(result.retrySafety.safeToRetry, true);
    assert.equal(executions, 0);
    assert.equal(providerCalls, 2);
  }
});

test('retains a failed handler response but marks the request unsafe to replay', async () => {
  let executions = 0;
  const registry = createRegistry(async () => {
    executions += 1;
    throw new Error('private handler detail');
  });
  let providerCalls = 0;
  const { orchestrator } = createPipeline({
    registry,
    generateContent: async () => {
      providerCalls += 1;
      return providerCalls === 1
        ? {
          functionCalls: [{
            id: 'handler-failure',
            name: 'lookup_data',
            args: { key: 'x' },
          }],
        }
        : { text: 'Failure handled.' };
    },
  });

  const result = await orchestrator.run(createRequest(), {
    authorizedTools: ['lookup_data'],
  });
  assert.equal(result.functionResponses[0].error.code, 'TOOL_EXECUTION_FAILED');
  assert.equal(result.executionProgress.calls[0].state, 'failed');
  assert.equal(result.executionProgress.calls[0].executionStarted, true);
  assert.equal(result.retrySafety.safeToRetry, false);
  assert.equal(providerCalls, 2);
  assert.equal(executions, 1);
});

test('timeout stops provider rounds and records an uncertain tool result', async () => {
  let executions = 0;
  const registry = createRegistry(() => {
    executions += 1;
    return new Promise(() => {});
  });
  let providerCalls = 0;
  const { orchestrator } = createPipeline({
    registry,
    executorOptions: { timeoutMs: 10 },
    generateContent: async () => {
      providerCalls += 1;
      return {
        functionCalls: [{
          id: 'timed-out',
          name: 'lookup_data',
          args: { key: 'x' },
        }],
      };
    },
  });

  await assert.rejects(orchestrator.run(createRequest(), {
    authorizedTools: ['lookup_data'],
  }), (error) =>
    error.code === 'TOOL_OUTCOME_UNKNOWN' &&
    error.executionProgress.calls[0].state === 'unknown' &&
    error.functionResponses[0].error.code === 'TOOL_TIMEOUT' &&
    error.retrySafety.safeToRetry === false,
  );
  assert.equal(providerCalls, 1);
  assert.equal(executions, 1);
});

test('preserves successful tool results if provider generation fails afterward', async () => {
  let executions = 0;
  const registry = createRegistry(async ({ key }) => {
    executions += 1;
    return { key, value: 'completed' };
  });
  let providerCalls = 0;
  const { orchestrator } = createPipeline({
    registry,
    generateContent: async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          functionCalls: [{
            id: 'completed-before-provider-failure',
            name: 'lookup_data',
            args: { key: 'x' },
          }],
        };
      }
      throw new Error('provider failed after tool');
    },
  });

  await assert.rejects(orchestrator.run(createRequest(), {
    authorizedTools: ['lookup_data'],
  }), (error) => {
    assert.equal(error.kind, 'provider');
    assert.equal(error.executionProgress.calls[0].state, 'succeeded');
    assert.equal(error.functionResponses[0].id, 'completed-before-provider-failure');
    assert.deepEqual(error.functionResponses[0].result, {
      key: 'x',
      value: 'completed',
    });
    assert.equal(error.retrySafety.safeToRetry, false);
    return true;
  });
  assert.equal(providerCalls, 2);
  assert.equal(executions, 1);
});

test('refuses malformed function history before calling the provider', async () => {
  const registry = createRegistry();
  let providerCalls = 0;
  const adapter = createGeminiToolGenerator({
    model: 'gemini-fake',
    generateContent: async () => {
      providerCalls += 1;
      return { text: 'unreachable' };
    },
  });
  const call = (roundCallIndex) => ({
    round: 1,
    roundCallIndex,
    roundCallCount: 2,
    call: {
      id: `call-${roundCallIndex}`,
      name: 'lookup_data',
      arguments: { key: 'x' },
    },
    id: `call-${roundCallIndex}`,
    name: 'lookup_data',
    result: { key: 'x' },
  });

  await assert.rejects(adapter({
    input: createRequest(),
    tools: registry.getPublicDeclarations(),
    functionResponses: [call(1)],
  }), (error) =>
    error instanceof GeminiToolAdapterError &&
    error.code === 'INVALID_FUNCTION_RESPONSES',
  );
  assert.equal(providerCalls, 0);
});

