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

function createRegistry({ name = 'lookup_data', handler = async () => ({ value: 'ok' }) } = {}) {
  const registry = createToolRegistry();
  registry.register({
    name,
    description: 'Read an allowlisted value.',
    inputSchema: emptyObjectSchema,
    category: 'read_only',
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

  assert.equal(await orchestrator.run(input), 'Hello back.');
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

  assert.equal(
    await orchestrator.run({ prompt: 'lookup' }, { authorizedTools: ['lookup_data'] }),
    'Found the value.',
  );
  assert.deepEqual(requests[1].functionResponses, [{
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

  assert.equal(await orchestrator.run('input'), 'Both done.');
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

  assert.equal(await orchestrator.run('input'), 'Finished.');
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

  assert.equal(await orchestrator.run('input'), 'Tool unavailable.');
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
      throw Object.assign(new Error('private stack or secret'), { code });
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
    assert.equal(await orchestrator.run('input'), 'Handled.');
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
      error.message === 'The response generator failed.' &&
      !error.message.includes('credentials'),
  );

  const invalidOutput = createToolOrchestrator({
    registry,
    executor: createFakeExecutor(async () => undefined).executor,
    generator: async (request) => request.functionResponses.length
      ? { text: 'Handled.' }
      : { functionCalls: [functionCall('invalid-output')] },
  });
  assert.equal(await invalidOutput.run('input'), 'Handled.');
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
  await assert.rejects(maxRounds.run('input'), { code: 'TOOL_ROUND_LIMIT' });
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
  await assert.rejects(tooManyAtOnce.run('input'), { code: 'TOOL_CALL_LIMIT' });
  assert.equal(calls.length, 1);

  const totalLimit = createToolOrchestrator({
    registry,
    executor,
    maxTotalCalls: 1,
    generator: async (request) => request.functionResponses.length
      ? { functionCalls: [functionCall('over-total')] }
      : { functionCalls: [functionCall('within-total')] },
  });
  await assert.rejects(totalLimit.run('input'), { code: 'TOOL_CALL_LIMIT' });
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
      async execute() {
        executorCalls += 1;
        return {};
      },
    },
    generator: async (request) => request.functionResponses.length
      ? { text: 'Rejected.' }
      : { functionCalls: [functionCall('not-registered', 'unregistered_tool')] },
  });

  assert.equal(await orchestrator.run('input'), 'Rejected.');
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
