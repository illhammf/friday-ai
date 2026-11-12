import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createGeminiToolGenerator,
  GeminiToolAdapterError,
} from '../src/ai/gemini-tool-adapter.js';
import { createToolRegistry } from '../src/ai/tools/tool-registry.js';

const schema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 40 },
    limit: { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['query'],
  additionalProperties: false,
};

function createDeclaration(overrides = {}) {
  return {
    name: 'search_memory',
    description: 'Find relevant saved notes.',
    parametersJsonSchema: schema,
    ...overrides,
  };
}

function createAdapter({ response, ...overrides } = {}) {
  const requests = [];
  const adapter = createGeminiToolGenerator({
    model: 'gemini-test',
    generateContent: async (request) => {
      requests.push(request);
      if (overrides.generateContent) return overrides.generateContent(request);
      return response;
    },
    ...overrides,
  });
  return { adapter, requests };
}

test('translates public declarations without handler or permission metadata', async () => {
  const publicDeclaration = createDeclaration();
  const { adapter, requests } = createAdapter({ response: { text: 'Ready.' } });
  const result = await adapter({
    input: 'Find a note.',
    tools: [publicDeclaration],
  });

  assert.deepEqual(result, { text: 'Ready.' });
  assert.deepEqual(requests[0].config.tools, [{
    functionDeclarations: [{
      name: 'search_memory',
      description: 'Find relevant saved notes.',
      parametersJsonSchema: schema,
    }],
  }]);
  assert.deepEqual(requests[0].contents, [{
    role: 'user',
    parts: [{ text: 'Find a note.' }],
  }]);
  assert.equal('handler' in requests[0].config.tools[0].functionDeclarations[0], false);
  assert.equal('category' in requests[0].config.tools[0].functionDeclarations[0], false);
});

test('translates normal text and normalized text conversation history', async () => {
  const { adapter, requests } = createAdapter({ response: { text: '  Answer.  ' } });
  assert.deepEqual(await adapter({
    input: [
      { role: 'user', text: 'Question?' },
      { role: 'assistant', text: 'Thinking.' },
    ],
    tools: [],
  }), { text: 'Answer.' });
  assert.deepEqual(requests[0].contents, [
    { role: 'user', parts: [{ text: 'Question?' }] },
    { role: 'model', parts: [{ text: 'Thinking.' }] },
  ]);
});

test('translates a function call and preserves its provider call ID and arguments', async () => {
  const { adapter, requests } = createAdapter({
    response: {
      functionCalls: [{
        id: 'provider-id-1',
        name: 'search_memory',
        args: { query: 'Friday', limit: 2 },
      }],
    },
  });
  assert.deepEqual(await adapter({
    input: 'Find Friday.',
    tools: [createDeclaration()],
  }), {
    functionCalls: [{
      id: 'provider-id-1',
      name: 'search_memory',
      arguments: { query: 'Friday', limit: 2 },
    }],
  });
  assert.equal(requests.length, 1);
});

test('translates multiple function calls and generates an ID only when the SDK omits one', async () => {
  const { adapter } = createAdapter({
    response: {
      functionCalls: [
        { id: 'kept-id', name: 'search_memory', args: { query: 'one' } },
        { name: 'search_memory', args: { query: 'two' } },
      ],
    },
  });
  assert.deepEqual(await adapter({
    input: 'Search.',
    tools: [createDeclaration()],
  }), {
    functionCalls: [
      {
        id: 'kept-id',
        name: 'search_memory',
        arguments: { query: 'one' },
      },
      {
        id: 'gemini-call-1',
        name: 'search_memory',
        arguments: { query: 'two' },
      },
    ],
  });
});

test('maps successful and normalized error function responses into Gemini history', async () => {
  const { adapter, requests } = createAdapter({ response: { text: 'Done.' } });
  const functionResponses = [
    {
      round: 1,
      call: {
        id: 'success-id',
        name: 'search_memory',
        arguments: { query: 'Friday' },
      },
      id: 'success-id',
      name: 'search_memory',
      result: { matches: ['Friday project'] },
    },
    {
      round: 1,
      call: {
        id: 'error-id',
        name: 'search_memory',
        arguments: { query: 'missing' },
      },
      id: 'error-id',
      name: 'search_memory',
      error: {
        code: 'TOOL_PERMISSION_DENIED',
        message: 'do not trust caller-supplied error text',
      },
    },
  ];

  assert.deepEqual(await adapter({
    input: 'Look up these notes.',
    tools: [createDeclaration()],
    functionResponses,
  }), { text: 'Done.' });
  assert.deepEqual(requests[0].contents, [
    { role: 'user', parts: [{ text: 'Look up these notes.' }] },
    {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'success-id',
            name: 'search_memory',
            args: { query: 'Friday' },
          },
        },
        {
          functionCall: {
            id: 'error-id',
            name: 'search_memory',
            args: { query: 'missing' },
          },
        },
      ],
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'success-id',
            name: 'search_memory',
            response: { output: { matches: ['Friday project'] } },
          },
        },
        {
          functionResponse: {
            id: 'error-id',
            name: 'search_memory',
            response: {
              error: {
                code: 'TOOL_PERMISSION_DENIED',
                message: 'Tool permission denied.',
              },
            },
          },
        },
      ],
    },
  ]);
});

test('reconstructs function history in round order', async () => {
  const { adapter, requests } = createAdapter({ response: { text: 'Final.' } });
  const call = (round, id) => ({
    round,
    id,
    name: 'search_memory',
    call: {
      id,
      name: 'search_memory',
      arguments: { query: id },
    },
    result: { id },
  });
  await adapter({
    input: 'Question.',
    tools: [createDeclaration()],
    functionResponses: [call(1, 'first'), call(2, 'second')],
  });
  assert.deepEqual(requests[0].contents.slice(1).map(({ role }) => role), [
    'model',
    'user',
    'model',
    'user',
  ]);
});

test('rejects empty, malformed, duplicate, or oversized function calls', async () => {
  for (const response of [
    { text: '' },
    {},
    { text: 'mixed', functionCalls: [{ id: 'mixed', name: 'search_memory', args: {} }] },
    { functionCalls: {} },
    { functionCalls: [{ id: 'x', args: {} }] },
    { functionCalls: [{ name: 'bad-name', args: {} }] },
    {
      functionCalls: [
        { id: 'duplicate', name: 'search_memory', args: {} },
        { id: 'duplicate', name: 'search_memory', args: {} },
      ],
    },
    {
      functionCalls: [{
        id: 'large-args',
        name: 'search_memory',
        args: { query: 'x'.repeat(5000) },
      }],
    },
    {
      functionCalls: Array.from({ length: 4 }, (_, index) => ({
        id: `call-${index}`,
        name: 'search_memory',
        args: {},
      })),
    },
  ]) {
    const { adapter } = createAdapter({ response });
    await assert.rejects(
      adapter({ input: 'Question.', tools: [createDeclaration()] }),
      GeminiToolAdapterError,
    );
  }
});

test('rejects function call accessors without invoking them', async () => {
  let getterCalled = false;
  const call = { id: 'accessor', name: 'search_memory' };
  Object.defineProperty(call, 'args', {
    enumerable: true,
    get() {
      getterCalled = true;
      return {};
    },
  });
  const { adapter } = createAdapter({
    response: { functionCalls: [call] },
  });
  await assert.rejects(
    adapter({ input: 'Question.', tools: [createDeclaration()] }),
    { code: 'INVALID_GEMINI_RESPONSE' },
  );
  assert.equal(getterCalled, false);
});

test('rejects unsupported declarations and unsafe generation configuration', async () => {
  const unsupported = createDeclaration({
    parametersJsonSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
      patternProperties: {},
    },
  });
  const { adapter } = createAdapter({ response: { text: 'No call.' } });
  await assert.rejects(
    adapter({ input: 'Question.', tools: [unsupported] }),
    { code: 'INVALID_TOOL_DECLARATIONS' },
  );
  assert.throws(
    () => createAdapter({
      response: { text: 'No call.' },
      config: { automaticFunctionCalling: { disable: false } },
    }),
    /managed by the adapter/,
  );
});

test('normalizes provider failures and prevents SDK automatic function execution', async () => {
  const failed = createAdapter({
    generateContent: async () => {
      throw new Error('private API key detail');
    },
  }).adapter;
  await assert.rejects(
    failed({ input: 'Question.', tools: [] }),
    (error) => error.code === 'GEMINI_GENERATION_FAILED' &&
      error.message === 'Gemini generation failed.' &&
      !error.message.includes('API key'),
  );

  let generationCount = 0;
  const adapter = createGeminiToolGenerator({
    model: 'gemini-test',
    generateContent: async (request) => {
      generationCount += 1;
      assert.deepEqual(request.config.automaticFunctionCalling, { disable: true });
      assert.deepEqual(request.config.toolConfig, {
        functionCallingConfig: { mode: 'AUTO' },
      });
      return {
        functionCalls: [{ id: 'manual-only', name: 'search_memory', args: {} }],
      };
    },
  });
  const result = await adapter({ input: 'Search.', tools: [createDeclaration()] });
  assert.equal(result.functionCalls[0].id, 'manual-only');
  assert.equal(generationCount, 1);
});

test('validates function response history and bounds result data', async () => {
  const { adapter } = createAdapter({ response: { text: 'Done.' } });
  await assert.rejects(
    adapter({
      input: 'Question.',
      tools: [],
      functionResponses: [{
        round: 1,
        id: 'call-1',
        name: 'search_memory',
        call: {
          id: 'call-1',
          name: 'search_memory',
          arguments: {},
        },
        error: {
          code: 'UNTRUSTED_ERROR',
          message: 'internal details',
        },
      }],
    }),
    { code: 'INVALID_FUNCTION_RESPONSES' },
  );
  await assert.rejects(
    adapter({
      input: 'Question.',
      tools: [],
      functionResponses: [{
        round: 1,
        id: 'call-1',
        name: 'search_memory',
        call: {
          id: 'call-1',
          name: 'search_memory',
          arguments: {},
        },
        result: { value: 'x'.repeat(9000) },
      }],
    }),
    { code: 'INVALID_FUNCTION_RESPONSES' },
  );
});

test('uses the registry public declaration directly and does not expose handlers', () => {
  const registry = createToolRegistry();
  registry.register({
    name: 'search_memory',
    description: 'Find saved notes.',
    inputSchema: schema,
    category: 'read_only',
    handler: async () => ({ private: true }),
  });
  const declaration = registry.getPublicDeclarations()[0];
  assert.deepEqual(Object.keys(declaration).sort(), [
    'description',
    'name',
    'parametersJsonSchema',
  ]);
});

test('imports safely without requiring credentials or creating a client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-gemini-tool-adapter-'));
  const moduleUrl = pathToFileURL(
    join(process.cwd(), 'src', 'ai', 'gemini-tool-adapter.js'),
  ).href;

  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', 'await import(process.argv[1])', moduleUrl],
      {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, GEMINI_API_KEY: '' },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
