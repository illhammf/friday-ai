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

function createRegistry(
  names = ['lookup_data', 'read_notes'],
  capabilityRequirements = {},
) {
  const registry = createToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: `Read ${name}.`,
      inputSchema: EMPTY_SCHEMA,
      category: 'read_only',
      requiredCapabilities: capabilityRequirements[name] || ['lookup'],
      handler: async () => ({ ok: true }),
    });
  }
  return registry;
}

function createPolicy({
  registry = createRegistry(),
  allowedTools = ['lookup_data'],
  knownCapabilities = ['lookup'],
  getPrivateSessionId = (senderId) => `private:${senderId}`,
  isValidSenderId = (senderId) =>
    /^[a-z0-9._+-]+@(?:c\.us|lid|s\.whatsapp\.net)$/i.test(senderId),
} = {}) {
  return {
    registry,
    policy: createToolAuthorizationPolicy({
      registry,
      allowedTools,
      knownCapabilities,
      getPrivateSessionId,
      isValidSenderId,
    }),
  };
}

function privateRuntimeContext(overrides = {}) {
  return {
    chatType: 'private',
    senderId: 'user@c.us',
    privateSessionId: 'private:user@c.us',
    conversationSessionId: 'private:user@c.us',
    grantedCapabilities: ['lookup'],
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
    authorizedTools: ['lookup_data'],
    grantedCapabilities: ['lookup'],
  });
  assert.deepEqual(decision.identity, { senderId: 'user@c.us' });
  assert.deepEqual(decision.sessionScope, {
    privateSessionId: 'private:user@c.us',
    conversationSessionId: 'private:user@c.us',
  });
  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.context), true);
  assert.equal(Object.isFrozen(decision.context.authorizedTools), true);
  assert.equal(Object.isFrozen(decision.identity), true);
  assert.equal(Object.isFrozen(decision.sessionScope), true);
});

test('denies a private conversation with no granted capabilities', () => {
  const { policy } = createPolicy();

  const noCapabilities = policy.authorize(
    privateRuntimeContext({ grantedCapabilities: [] }),
  );
  assert.equal(noCapabilities.authorized, false);
  assert.equal(noCapabilities.reason, 'no_explicit_tool_grants');
  assert.equal(noCapabilities.context, null);

  const emptyGrantPolicy = createPolicy({
    allowedTools: [],
    knownCapabilities: ['lookup'],
  }).policy;
  const emptyAllowlist = emptyGrantPolicy.authorize(
    privateRuntimeContext({ grantedCapabilities: [] }),
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
    grantedCapabilities: ['lookup'],
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
  const { policy: strictPolicy } = createPolicy({
    isValidSenderId: () => false,
  });
  assert.equal(
    strictPolicy.authorize(privateRuntimeContext()).reason,
    'missing_or_invalid_sender_identity',
  );
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
    grantedCapabilities: ['lookup'],
    question: 'Use lookup_data.',
  };
  const modelDecision = policy.authorize(modelInput);
  assert.equal(modelDecision.authorized, false);
  assert.equal(modelDecision.reason, 'invalid_runtime_context');
});

test('grants tools only when all registered requirements are in trusted capability context', () => {
  const registry = createRegistry(
    ['lookup_data', 'read_notes'],
    { read_notes: ['lookup', 'private_context'] },
  );
  const { policy } = createPolicy({
    registry,
    allowedTools: ['lookup_data', 'read_notes'],
    knownCapabilities: ['lookup', 'private_context'],
  });
  const partialDecision = policy.authorize(privateRuntimeContext({
    grantedCapabilities: ['lookup'],
  }));
  assert.equal(partialDecision.authorized, true);
  assert.deepEqual(partialDecision.context.authorizedTools, ['lookup_data']);

  const decision = policy.authorize(privateRuntimeContext({
    grantedCapabilities: ['lookup', 'private_context'],
  }));

  assert.equal(decision.authorized, true);
  assert.deepEqual(decision.context.authorizedTools, ['lookup_data', 'read_notes']);
  assert.deepEqual(
    decision.context.grantedCapabilities,
    ['lookup', 'private_context'],
  );
});

test('denies unknown or malformed trusted capability sets', () => {
  const { policy } = createPolicy();
  for (const grantedCapabilities of [
    ['unconfigured'],
    'lookup',
    ['lookup', 'lookup'],
    ['lookup', 7],
    null,
  ]) {
    const decision = policy.authorize(
      privateRuntimeContext({ grantedCapabilities }),
    );
    assert.equal(decision.authorized, false);
    assert.ok([
      'unknown_application_capability',
      'invalid_granted_capabilities',
    ].includes(decision.reason));
  }
});

test('rejects unknown capability requirements during policy construction', () => {
  const registry = createRegistry(
    ['lookup_data'],
    { lookup_data: ['unconfigured'] },
  );
  assert.throws(() => createPolicy({
    registry,
    allowedTools: ['lookup_data'],
    knownCapabilities: ['lookup'],
  }), ToolAuthorizationPolicyError);
});

test('rejects unregistered allowlist entries at policy construction', () => {
  const registry = createRegistry(['lookup_data']);
  assert.throws(() => createPolicy({
    registry,
    allowedTools: ['missing_tool'],
    knownCapabilities: ['lookup'],
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
  runtimeContext.grantedCapabilities.push('other');

  assert.equal(decision.authorized, true);
  assert.equal(decision.identity.senderId, 'user@c.us');
  assert.deepEqual(decision.context.authorizedTools, ['lookup_data']);
  assert.equal('senderId' in decision.context, false);
  assert.equal('privateSessionId' in decision.context, false);
  assert.equal(registry.size, initialSize);
  assert.deepEqual(registry.getPublicDeclarations(), initialDeclarations);
  assert.equal(executor.isBoundTo(registry), initialBinding);
  assert.throws(() => {
    decision.identity.senderId = 'mutated@c.us';
  }, TypeError);
  assert.throws(() => {
    decision.sessionScope.privateSessionId = 'private:other@c.us';
  }, TypeError);
  assert.throws(() => {
    decision.context.authorizedTools.push('read_notes');
  }, TypeError);
});

test('keeps sender and session identifiers out of handler context', async () => {
  let handlerContext;
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read an allowlisted value.',
    inputSchema: EMPTY_SCHEMA,
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler: async (_arguments, context) => {
      handlerContext = context;
      return { ok: true };
    },
  });
  const executor = createToolExecutor({ registry });
  const { policy } = createPolicy({ registry });
  const decision = policy.authorize(privateRuntimeContext());

  assert.equal(decision.authorized, true);
  await executor.execute('lookup_data', {}, decision.context);
  assert.equal(handlerContext.conversationType, 'private');
  assert.equal('senderId' in handlerContext, false);
  assert.equal('privateSessionId' in handlerContext, false);
  assert.equal('conversationSessionId' in handlerContext, false);
  assert.equal('authorizedTools' in handlerContext, false);
  assert.equal('grantedCapabilities' in handlerContext, false);
  assert.equal(handlerContext.signal instanceof AbortSignal, true);
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
    isValidSenderId: () => true,
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
      knownCapabilities: ['lookup'],
    }), ToolAuthorizationPolicyError);
  }

  assert.throws(() => createPolicy({
    registry,
    allowedTools: ['lookup_data'],
    knownCapabilities: ['not a capability'],
  }), ToolAuthorizationPolicyError);
});

test('default empty allowlist grants no registered tools', () => {
  const registry = createRegistry();
  const policy = createToolAuthorizationPolicy({
    registry,
    knownCapabilities: ['lookup'],
    knownCapabilities: ['lookup'],
    getPrivateSessionId: (senderId) => `private:${senderId}`,
    isValidSenderId: (senderId) => senderId === 'user@c.us',
  });
  const decision = policy.authorize(privateRuntimeContext());

  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, 'no_explicit_tool_grants');
  assert.equal(decision.context, null);
});

test('refuses to configure grants for action-category tools', () => {
  const registry = createToolRegistry();
  registry.register({
    name: 'perform_action',
    description: 'Action tool must not be granted.',
    inputSchema: EMPTY_SCHEMA,
    category: 'action',
    requiredCapabilities: ['action'],
    handler: async () => ({ ok: true }),
  });

  assert.throws(() => createToolAuthorizationPolicy({
    registry,
    allowedTools: ['perform_action'],
    knownCapabilities: ['action'],
    getPrivateSessionId: (senderId) => `private:${senderId}`,
    isValidSenderId: () => true,
  }), /not registered as read_only/);
});
