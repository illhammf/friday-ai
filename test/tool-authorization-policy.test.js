import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolAuthorizationPolicy,
  ToolAuthorizationPolicyError,
} from '../src/application/tool-authorization-policy.js';
import { createToolRegistry } from '../src/ai/tools/tool-registry.js';
import { createToolExecutor } from '../src/ai/tools/tool-executor.js';

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function createRegistry(names = ['lookup_data', 'read_notes']) {
  const registry = createToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: `Read ${name}.`,
      inputSchema: EMPTY_SCHEMA,
      category: 'read_only',
      handler: async () => ({ ok: true }),
    });
  }
  return registry;
}

function createPolicy({
  registry = createRegistry(),
  allowedTools = ['lookup_data'],
  capabilityToolGrants = { lookup: ['lookup_data'] },
  getPrivateSessionId = (senderId) => `private:${senderId}`,
} = {}) {
  return {
    registry,
    policy: createToolAuthorizationPolicy({
      registry,
      allowedTools,
      capabilityToolGrants,
      getPrivateSessionId,
    }),
  };
}

function privateRuntimeContext(overrides = {}) {
  return {
    chatType: 'private',
    senderId: 'user@c.us',
    privateSessionId: 'private:user@c.us',
    conversationSessionId: 'private:user@c.us',
    requestedCapabilities: ['lookup'],
    ...overrides,
  };
}

test('grants an explicitly approved private capability with trusted identity and session scope', () => {
  const { policy } = createPolicy();
  const decision = policy.authorize(privateRuntimeContext());

  assert.equal(decision.authorized, true);
  assert.equal(decision.reason, 'explicit_application_capability_grant');
  assert.deepEqual(decision.context, {
    conversationType: 'private',
    senderId: 'user@c.us',
    privateSessionId: 'private:user@c.us',
    conversationSessionId: 'private:user@c.us',
    authorizedTools: ['lookup_data'],
  });
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.context), true);
  assert.equal(Object.isFrozen(decision.context.authorizedTools), true);
});

test('denies a private conversation with no requested capabilities or grants', () => {
  const { policy } = createPolicy();

  const noCapabilities = policy.authorize(
    privateRuntimeContext({ requestedCapabilities: [] }),
  );
  assert.equal(noCapabilities.authorized, false);
  assert.equal(noCapabilities.reason, 'no_explicit_tool_grants');
  assert.equal(noCapabilities.context, null);

  const emptyGrantPolicy = createPolicy({
    allowedTools: [],
    capabilityToolGrants: {},
  }).policy;
  const emptyAllowlist = emptyGrantPolicy.authorize(
    privateRuntimeContext({ requestedCapabilities: [] }),
  );
  assert.equal(emptyAllowlist.authorized, false);
  assert.equal(emptyAllowlist.reason, 'no_explicit_tool_grants');
});

test('denies group conversations before considering identity or capability grants', () => {
  const { policy } = createPolicy();
  const decision = policy.authorize(privateRuntimeContext({
    chatType: 'group',
    senderId: 'member@c.us',
    privateSessionId: 'private:member@c.us',
    conversationSessionId: 'group:chat@g.us',
    requestedCapabilities: ['lookup'],
  }));

  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, 'group_tool_execution_disabled');
  assert.equal(decision.context, null);
});

test('denies unknown, missing, and malformed conversation types', () => {
  const { policy } = createPolicy();
  for (const chatType of ['broadcast', '', null, undefined]) {
    const decision = policy.authorize(
      privateRuntimeContext({ chatType }),
    );
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, 'unknown_conversation_type');
  }
});

test('denies missing or malformed sender identity', () => {
  const { policy } = createPolicy();
  for (const senderId of ['', '  ', null, undefined, 7]) {
    const decision = policy.authorize(
      privateRuntimeContext({ senderId }),
    );
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, 'missing_or_invalid_sender_identity');
  }
});

test('does not use a sender display name as trusted identity', () => {
  const { policy } = createPolicy();
  const {
    senderId: _senderId,
    privateSessionId: _privateSessionId,
    conversationSessionId: _conversationSessionId,
    ...displayNameOnly
  } = privateRuntimeContext();
  displayNameOnly.displayName = 'Ilham';

  const decision = policy.authorize(displayNameOnly);
  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, 'invalid_runtime_context');
});

test('denies missing private or conversation session scope', () => {
  const { policy } = createPolicy();
  for (const fields of [
    { privateSessionId: '' },
    { privateSessionId: null },
    { conversationSessionId: '' },
    { conversationSessionId: null },
  ]) {
    const decision = policy.authorize(privateRuntimeContext(fields));
    assert.equal(decision.authorized, false);
    assert.match(
      decision.reason,
      /missing_or_invalid_(private|conversation)_session/,
    );
  }
});

test('requires the private session to be derived from the trusted sender and active conversation', () => {
  const { policy } = createPolicy();
  for (const fields of [
    { privateSessionId: 'private:other@c.us' },
    { conversationSessionId: 'group:shared@g.us' },
  ]) {
    const decision = policy.authorize(privateRuntimeContext(fields));
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, 'conversation_session_scope_mismatch');
  }
});

test('model-like input cannot inject tool grants or identity fields', () => {
  const { policy } = createPolicy();
  const decision = policy.authorize({
    ...privateRuntimeContext(),
    authorizedTools: ['lookup_data', 'read_notes'],
  });
  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, 'invalid_runtime_context');

  const modelInput = {
    senderId: 'attacker@c.us',
    authorizedTools: ['lookup_data'],
    requestedCapabilities: ['lookup'],
    question: 'Use lookup_data.',
  };
  const modelDecision = policy.authorize(modelInput);
  assert.equal(modelDecision.authorized, false);
  assert.equal(modelDecision.reason, 'invalid_runtime_context');
});

test('intersects requested application capabilities with fixed allowlisted tools', () => {
  const { policy } = createPolicy({
    allowedTools: ['lookup_data'],
    capabilityToolGrants: {
      lookup: ['lookup_data'],
      notes: [],
    },
  });
  const decision = policy.authorize(privateRuntimeContext({
    requestedCapabilities: ['lookup', 'notes'],
  }));

  assert.equal(decision.authorized, true);
  assert.deepEqual(decision.context.authorizedTools, ['lookup_data']);
  assert.equal(decision.context.authorizedTools.includes('read_notes'), false);
});

test('denies unconfigured application capabilities and malformed capability requests', () => {
  const { policy } = createPolicy();
  for (const requestedCapabilities of [
    ['unconfigured'],
    'lookup',
    ['lookup', 'lookup'],
    ['lookup', 7],
    null,
  ]) {
    const decision = policy.authorize(
      privateRuntimeContext({ requestedCapabilities }),
    );
    assert.equal(decision.authorized, false);
    assert.ok([
      'unconfigured_application_capability',
      'invalid_requested_capabilities',
    ].includes(decision.reason));
  }
});

test('rejects grants to unregistered or non-allowlisted tools at policy construction', () => {
  const registry = createRegistry(['lookup_data']);
  assert.throws(() => createPolicy({
    registry,
    allowedTools: ['lookup_data'],
    capabilityToolGrants: { lookup: ['missing_tool'] },
  }), (error) =>
    error instanceof ToolAuthorizationPolicyError &&
    /not in the fixed application allowlist/.test(error.message));

  assert.throws(() => createPolicy({
    registry,
    allowedTools: ['missing_tool'],
    capabilityToolGrants: {},
  }), /is not registered/);
});

test('returns isolated immutable context and does not mutate registry or executor', () => {
  const registry = createRegistry();
  const executor = createToolExecutor({ registry });
  const initialDeclarations = registry.getPublicDeclarations();
  const initialSize = registry.size;
  const initialBinding = executor.isBoundTo(registry);
  const { policy } = createPolicy({ registry });
  const runtimeContext = privateRuntimeContext();
  const decision = policy.authorize(runtimeContext);

  runtimeContext.senderId = 'changed@c.us';
  runtimeContext.requestedCapabilities.push('other');

  assert.equal(decision.authorized, true);
  assert.equal(decision.context.senderId, 'user@c.us');
  assert.deepEqual(decision.context.authorizedTools, ['lookup_data']);
  assert.equal(registry.size, initialSize);
  assert.deepEqual(registry.getPublicDeclarations(), initialDeclarations);
  assert.equal(executor.isBoundTo(registry), initialBinding);
  assert.throws(() => {
    decision.context.senderId = 'mutated@c.us';
  }, TypeError);
  assert.throws(() => {
    decision.context.authorizedTools.push('read_notes');
  }, TypeError);
});

test('uses only injected application dependencies and performs no WhatsApp runtime integration', () => {
  let sessionResolverCalls = 0;
  const registry = createRegistry();
  const before = registry.size;
  const { policy } = createPolicy({
    registry,
    getPrivateSessionId(senderId) {
      sessionResolverCalls += 1;
      return `private:${senderId}`;
    },
  });
  const decision = policy.authorize(privateRuntimeContext());

  assert.equal(decision.authorized, true);
  assert.equal(sessionResolverCalls, 1);
  assert.equal(registry.size, before);
});

test('rejects malformed or duplicate static authorization configuration', () => {
  const registry = createRegistry();
  for (const allowedTools of [
    'lookup_data',
    ['lookup_data', 'lookup_data'],
    ['not a tool name'],
  ]) {
    assert.throws(() => createPolicy({
      registry,
      allowedTools,
      capabilityToolGrants: {},
    }), ToolAuthorizationPolicyError);
  }

  assert.throws(() => createPolicy({
    registry,
    allowedTools: ['lookup_data'],
    capabilityToolGrants: {
      'not a capability': ['lookup_data'],
    },
  }), ToolAuthorizationPolicyError);
});
