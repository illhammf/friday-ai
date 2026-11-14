import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createToolRegistry } from '../src/ai/tools/tool-registry.js';
import {
  assertSupportedToolSchema,
  ToolSchemaError,
  validateToolArguments,
} from '../src/ai/tools/tool-validator.js';
import {
  assertToolPermission,
  ToolPermissionError,
} from '../src/ai/tools/tool-permission-policy.js';
import {
  createToolExecutor as createToolExecutorFactory,
  ToolExecutionError,
} from '../src/ai/tools/tool-executor.js';
import { createTestGrantLifecycle } from './helpers/tool-grant-fixture.js';

function createToolExecutor(options) {
  return createToolExecutorFactory({
    grantLifecycle: createTestGrantLifecycle(),
    ...options,
  });
}

const emptyObjectSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function createDefinition(overrides = {}) {
  return {
    name: 'read_status',
    description: 'Read a safe status value.',
    inputSchema: emptyObjectSchema,
    category: 'read_only',
    requiredCapabilities: ['read_status'],
    handler: async () => ({ status: 'ok' }),
    ...overrides,
  };
}

test('registry registers valid definitions and exposes only immutable public data', () => {
  const registry = createToolRegistry();
  const handler = async () => 'private implementation';
  registry.register(createDefinition({ handler }));

  const [declaration] = registry.getPublicDeclarations();
  assert.deepEqual(Object.keys(declaration).sort(), [
    'description',
    'name',
    'parametersJsonSchema',
  ]);
  assert.equal('handler' in declaration, false);
  assert.equal('category' in declaration, false);
  assert.equal(Object.isFrozen(declaration), true);
  assert.equal(Object.isFrozen(declaration.parametersJsonSchema), true);
  assert.equal(Object.isFrozen(declaration.parametersJsonSchema.properties), true);
  assert.throws(() => registry.getPublicDeclarations().push({}), TypeError);
  assert.equal(registry.get('read_status').handler, handler);
  assert.equal(registry.has('read_status'), true);
  assert.equal(registry.size, 1);
});

test('registry rejects duplicate names, invalid names, and incomplete definitions', () => {
  const registry = createToolRegistry();
  registry.register(createDefinition());
  assert.throws(
    () => registry.register(createDefinition()),
    /already registered/,
  );
  for (const invalidName of ['UpperCase', 'contains-dash', '9tool', 'x'.repeat(65)]) {
    assert.throws(
      () => createToolRegistry().register(createDefinition({ name: invalidName })),
      /Tool name/,
    );
  }
  for (const definition of [
    null,
    {},
    createDefinition({ description: '' }),
    createDefinition({ inputSchema: null }),
    createDefinition({ category: 'unknown' }),
    createDefinition({ handler: null }),
    createDefinition({ requiredCapabilities: undefined }),
    createDefinition({ requiredCapabilities: [] }),
    createDefinition({ requiredCapabilities: ['lookup', 'lookup'] }),
    createDefinition({ requiredCapabilities: ['invalid.capability'] }),
  ]) {
    assert.throws(() => createToolRegistry().register(definition));
  }
});

test('registry freezes application-owned capability requirements separately from declarations', () => {
  const requiredCapabilities = ['project_read', 'private_context_read'];
  const registry = createToolRegistry();
  registry.register(createDefinition({ requiredCapabilities }));
  requiredCapabilities.push('injected');

  assert.deepEqual(
    registry.getAuthorizationMetadata('read_status'),
    {
      name: 'read_status',
      category: 'read_only',
      requiredCapabilities: ['project_read', 'private_context_read'],
    },
  );
  assert.deepEqual(
    Object.keys(registry.getPublicDeclarations()[0]).sort(),
    ['description', 'name', 'parametersJsonSchema'],
  );
});

test('registry validates public schemas and keeps declarations detached from caller mutation', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 100 },
    },
    required: ['query'],
    additionalProperties: false,
  };
  const registry = createToolRegistry();
  registry.register(createDefinition({ inputSchema: schema }));
  schema.properties.query.maxLength = 10000;
  assert.equal(
    registry.getPublicDeclarations()[0].parametersJsonSchema.properties.query.maxLength,
    100,
  );
  assert.throws(
    () => createToolRegistry().register(createDefinition({
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
        patternProperties: {},
      },
    })),
    ToolSchemaError,
  );
});

test('validator accepts supported nested object, scalar, enum, and bound constraints', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 20 },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      score: { type: 'number', minimum: 0, maximum: 1 },
      includeArchived: { type: 'boolean' },
      category: { type: 'string', enum: ['project', 'fact'] },
      filters: {
        type: 'object',
        properties: { owner: { type: 'string', maxLength: 30 } },
        required: ['owner'],
        additionalProperties: false,
      },
    },
    required: ['query', 'count', 'score', 'includeArchived', 'category', 'filters'],
    additionalProperties: false,
  };

  assert.deepEqual(assertSupportedToolSchema(schema), schema);
  const validation = validateToolArguments(schema, {
    query: 'Friday',
    count: 3,
    score: 0.5,
    includeArchived: false,
    category: 'project',
    filters: { owner: 'user' },
  });
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.value.query, 'Friday');
});

test('validator reports missing, mistyped, unknown, enum, length, and numeric errors', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 4, enum: ['ok', 'fine'] },
      count: { type: 'integer', minimum: 1, maximum: 3 },
    },
    required: ['query', 'count'],
    additionalProperties: false,
  };
  const result = validateToolArguments(schema, {
    query: 'tool-too-long',
    count: 4.5,
    unexpected: true,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ path, message }) => path === '$.count' && /safe integer/.test(message)));
  assert.ok(result.errors.some(({ path }) => path === '$.unexpected'));

  assert.ok(validateToolArguments(schema, { query: 'x', count: 0 }).errors.length >= 3);
  assert.ok(validateToolArguments(schema, { count: 2 }).errors.some(({ path }) => path === '$.query'));
  assert.ok(validateToolArguments(schema, { query: 'good', count: 2.2 }).errors.length > 0);
});

test('validator rejects unsupported keywords, schema types, and malformed constraints', () => {
  const unsupported = [
    { type: 'array', items: { type: 'string' } },
    { type: 'string', pattern: '.*' },
    { type: 'object', properties: {}, required: ['missing'] },
    { type: 'string', minLength: -1 },
    { type: 'number', minimum: 4, maximum: 2 },
    { type: 'string', enum: [] },
    { type: 'object', properties: {}, additionalProperties: { type: 'string' } },
  ];
  for (const schema of unsupported) {
    assert.throws(() => assertSupportedToolSchema(schema), ToolSchemaError);
  }
});

test('validator enforces serialized byte limits and rejects non-JSON data safely', () => {
  const schema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    additionalProperties: false,
  };
  assert.match(
    validateToolArguments(schema, { query: 'x'.repeat(50) }, {
      maxSerializedBytes: 16,
    }).errors[0].message,
    /exceed 16 bytes/,
  );
  assert.equal(validateToolArguments(schema, { query: undefined }).valid, false);

  let getterCalled = false;
  const args = {};
  Object.defineProperty(args, 'query', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'unexpected';
    },
  });
  assert.equal(validateToolArguments(schema, args).valid, false);
  assert.equal(getterCalled, false);
});

test('permission policy requires explicit read-only authorization and denies other classes', () => {
  const readOnly = {
    name: 'read_status',
    category: 'read_only',
    requiredCapabilities: ['read_status'],
  };
  assert.throws(() => assertToolPermission(readOnly), ToolPermissionError);
  assert.throws(
    () => assertToolPermission(readOnly, {
      authorizedTools: ['other'],
      grantedCapabilities: ['read_status'],
    }),
    ToolPermissionError,
  );
  assert.equal(
    assertToolPermission(readOnly, {
      authorizedTools: new Set(['read_status']),
      grantedCapabilities: ['read_status'],
    }),
    true,
  );
  for (const category of ['action', 'approval_required', 'unknown']) {
    assert.throws(
      () => assertToolPermission({ name: 'write', category }, {
        authorizedTools: ['write'],
        grantedCapabilities: ['read_status'],
      }),
      ToolPermissionError,
    );
  }
});

test('executor validates, authorizes, and executes only registered tools', async () => {
  const registry = createToolRegistry();
  const received = [];
  registry.register(createDefinition({
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 20 } },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      received.push({ args, context });
      return { result: `found ${args.query}` };
    },
  }));
  const executor = createToolExecutor({ registry });
  let started = 0;

  assert.deepEqual(await executor.execute(
    'read_status',
    { query: 'status' },
    {
      authorizedTools: ['read_status'],
      grantedCapabilities: ['read_status'],
      principalId: 'fixture-principal',
      grantScope: 'fixture-scope',
      chatType: 'private',
      privateSessionId: 'private:user',
    },
    { onStarted: () => { started += 1; } },
  ), { result: 'found status' });
  assert.equal(started, 1);
  assert.equal(Object.isFrozen(received[0].context), true);
  assert.equal(received[0].context.privateSessionId, 'private:user');
  assert.equal('authorizedTools' in received[0].context, false);
  assert.equal('grantedCapabilities' in received[0].context, false);
  assert.equal(Object.isFrozen(received[0].args), true);
  await assert.rejects(
    executor.execute('not_registered', {}),
    { code: 'TOOL_NOT_FOUND' },
  );
  await assert.rejects(
    executor.execute('read_status', { query: 'x'.repeat(21) }, {
      authorizedTools: ['read_status'],
      grantedCapabilities: ['read_status'],
      principalId: 'fixture-principal',
      grantScope: 'fixture-scope',
    }, { onStarted: () => { started += 1; } }),
    (error) => error.code === 'TOOL_ARGUMENTS_INVALID' &&
      error.executionStarted === false,
  );
  assert.equal(started, 1);
});

test('executor denies unauthorized tools without invoking handlers', async () => {
  let executions = 0;
  const registry = createToolRegistry();
  registry.register(createDefinition({
    handler: async () => {
      executions += 1;
      return 'should not execute';
    },
  }));
  const executor = createToolExecutor({ registry });

  await assert.rejects(
    executor.execute('read_status', {}),
    { code: 'TOOL_PERMISSION_DENIED' },
  );
  assert.equal(executions, 0);
});

test('executor enforces every registered capability requirement at dispatch', async () => {
  let executions = 0;
  const registry = createToolRegistry();
  registry.register(createDefinition({
    requiredCapabilities: ['project_read', 'private_context_read'],
    handler: async () => {
      executions += 1;
      return { ok: true };
    },
  }));
  const executor = createToolExecutor({ registry });
  const authorizedTools = ['read_status'];

  await assert.rejects(
    executor.execute('read_status', {}, {
      authorizedTools,
      grantedCapabilities: ['project_read'],
      principalId: 'fixture-principal',
      grantScope: 'fixture-scope',
    }),
    { code: 'TOOL_PERMISSION_DENIED' },
  );
  assert.equal(executions, 0);

  assert.deepEqual(await executor.execute('read_status', {}, {
    authorizedTools,
    grantedCapabilities: ['project_read', 'private_context_read'],
    principalId: 'fixture-principal',
    grantScope: 'fixture-scope',
  }), { ok: true });
  assert.equal(executions, 1);
});

test('executor reports invalid trusted context as a pre-dispatch denial', async () => {
  const registry = createToolRegistry();
  registry.register(createDefinition());
  const executor = createToolExecutor({ registry });
  let started = false;
  await assert.rejects(
    executor.execute(
      'read_status',
      {},
      'untrusted-shape',
      { onStarted: () => { started = true; } },
    ),
    (error) => error.code === 'TOOL_PERMISSION_DENIED' &&
      error.executionStarted === false,
  );
  assert.equal(started, false);
});

test('executor normalizes handler errors without exposing stacks or secrets', async () => {
  const registry = createToolRegistry();
  registry.register(createDefinition({
    handler: async () => {
      throw new Error('private token leaked in error details');
    },
  }));
  const executor = createToolExecutor({ registry });

  await assert.rejects(
    executor.execute('read_status', {}, {
      authorizedTools: ['read_status'],
      grantedCapabilities: ['read_status'],
      principalId: 'fixture-principal',
      grantScope: 'fixture-scope',
    }),
    (error) => error.code === 'TOOL_EXECUTION_FAILED' &&
      error.message === 'Tool execution failed.' &&
      !error.stack.includes('private token') &&
      !error.message.includes('private token'),
  );
});

test('executor bounds tool output and rejects non-serializable results', async () => {
  const registry = createToolRegistry();
  registry.register(createDefinition({
    handler: async () => ({ result: 'x'.repeat(100) }),
  }));
  registry.register(createDefinition({
    name: 'invalid_result',
    handler: async () => undefined,
  }));
  const executor = createToolExecutor({ registry, maxOutputBytes: 32 });

  await assert.rejects(
    executor.execute('read_status', {}, {
      authorizedTools: ['read_status'],
      grantedCapabilities: ['read_status'],
      principalId: 'fixture-principal',
      grantScope: 'fixture-scope',
    }),
    { code: 'TOOL_OUTPUT_TOO_LARGE' },
  );
  await assert.rejects(
    executor.execute('invalid_result', {}, {
      authorizedTools: ['invalid_result'],
      grantedCapabilities: ['read_status'],
      principalId: 'fixture-principal',
      grantScope: 'fixture-scope',
    }),
    { code: 'TOOL_OUTPUT_INVALID' },
  );
});

test('executor does not allow configured limits to exceed safe maxima', () => {
  const registry = createToolRegistry();
  for (const options of [
    { timeoutMs: 3001 },
    { maxArgumentBytes: 4097 },
    { maxOutputBytes: 8193 },
  ]) {
    assert.throws(
      () => createToolExecutor({ registry, ...options }),
      RangeError,
    );
  }
});

test('executor reports timeout without claiming to cancel a running handler', async () => {
  const registry = createToolRegistry();
  let finishHandler;
  let completed = false;
  let handlerSignal;
  registry.register(createDefinition({
    handler: (_args, context) => {
      handlerSignal = context.signal;
      return new Promise((resolve) => {
        finishHandler = () => {
          completed = true;
          resolve({ status: 'late' });
        };
      });
    },
  }));
  const executor = createToolExecutor({ registry, timeoutMs: 10 });

  await assert.rejects(
    executor.execute('read_status', {}, {
      authorizedTools: ['read_status'],
      grantedCapabilities: ['read_status'],
      principalId: 'fixture-principal',
      grantScope: 'fixture-scope',
    }),
    (error) => error instanceof ToolExecutionError &&
      error.code === 'TOOL_TIMEOUT' &&
      error.executionStarted === true &&
      error.outcomeUnknown === true &&
      /may still be running/.test(error.message),
  );
  assert.equal(completed, false);
  assert.equal(handlerSignal.aborted, true);
  finishHandler();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, true);
});

test('tool module imports have no filesystem or integration side effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-ai-tools-import-'));
  const modules = [
    'tool-registry.js',
    'tool-validator.js',
    'tool-permission-policy.js',
    'tool-executor.js',
  ].map((filename) => pathToFileURL(
    join(process.cwd(), 'src', 'ai', 'tools', filename),
  ).href);

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'await Promise.all(process.argv.slice(1).map((specifier) => import(specifier)))',
        ...modules,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(await (await import('node:fs/promises')).readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
