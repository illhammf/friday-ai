import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../src/ai/tools/tool-registry.js';
import { createToolAuthorizationPolicy } from '../src/application/tool-authorization-policy.js';
import {
  createTrustedRuntimeContextProjector,
  TrustedRuntimeContextError,
} from '../src/application/trusted-runtime-context.js';

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const USER_ID = 'user@c.us';
const PRIVATE_SESSION = `private:${USER_ID}`;

function createDependencies({
  applicationCapabilities = ['lookup'],
  getPrivateSessionId = (senderId) => `private:${senderId}`,
  isValidSenderId = (senderId) => senderId === USER_ID,
} = {}) {
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read an allowlisted value.',
    inputSchema: EMPTY_SCHEMA,
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler: async () => ({ ok: true }),
  });
  const authorizationPolicy = createToolAuthorizationPolicy({
    registry,
    allowedTools: ['lookup_data'],
    knownCapabilities: ['lookup'],
    getPrivateSessionId,
    isValidSenderId,
  });
  const projector = createTrustedRuntimeContextProjector({
    authorizationPolicy,
    getPrivateSessionId,
    isValidSenderId,
    applicationCapabilities,
  });

  return { registry, projector };
}

function privateRuntimeContext(overrides = {}) {
  return {
    chatType: 'private',
    senderId: USER_ID,
    privateSessionId: PRIVATE_SESSION,
    conversationSessionId: PRIVATE_SESSION,
    ...overrides,
  };
}

test('authorizes a valid private adapter identity using the canonical private session', () => {
  let resolvedSender;
  const { projector } = createDependencies({
    getPrivateSessionId(senderId) {
      resolvedSender = senderId;
      return `private:${senderId}`;
    },
  });

  const decision = projector.project(privateRuntimeContext());

  assert.equal(decision.authorized, true);
  assert.equal(resolvedSender, USER_ID);
  assert.equal(decision.identity.senderId, USER_ID);
  assert.deepEqual(decision.sessionScope, {
    privateSessionId: PRIVATE_SESSION,
    conversationSessionId: PRIVATE_SESSION,
  });
  assert.deepEqual(decision.context, {
    conversationType: 'private',
    authorizedTools: ['lookup_data'],
    grantedCapabilities: ['lookup'],
  });
});

test('denies invalid and missing sender identity', () => {
  const { projector } = createDependencies();

  for (const context of [
    privateRuntimeContext({ senderId: 'not-a-valid-id' }),
    privateRuntimeContext({ senderId: undefined }),
  ]) {
    const decision = projector.project(context);
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, 'missing_or_invalid_sender_identity');
    assert.equal(decision.context, null);
  }
});

test('denies missing session information', () => {
  const { projector } = createDependencies();

  const missingPrivateSession = privateRuntimeContext({
    privateSessionId: undefined,
  });
  const missingConversationSession = privateRuntimeContext({
    conversationSessionId: undefined,
  });

  assert.equal(
    projector.project(missingPrivateSession).reason,
    'missing_or_invalid_private_session',
  );
  assert.equal(
    projector.project(missingConversationSession).reason,
    'missing_or_invalid_conversation_session',
  );
});

test('denies private-session and conversation-session mismatches', () => {
  const { projector } = createDependencies();

  for (const context of [
    privateRuntimeContext({ privateSessionId: 'private:other@c.us' }),
    privateRuntimeContext({ conversationSessionId: 'group:chat@g.us' }),
  ]) {
    const decision = projector.project(context);
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, 'conversation_session_scope_mismatch');
    assert.equal(decision.context, null);
  }
});

test('denies groups and unknown conversation types', () => {
  const { projector } = createDependencies();

  const group = projector.project({
    chatType: 'group',
    senderId: 'member@c.us',
    privateSessionId: 'private:member@c.us',
    conversationSessionId: 'group:chat@g.us',
  });
  const unknown = projector.project(
    privateRuntimeContext({ chatType: 'broadcast' }),
  );

  assert.equal(group.authorized, false);
  assert.equal(group.reason, 'group_tool_execution_disabled');
  assert.equal(unknown.authorized, false);
  assert.equal(unknown.reason, 'unknown_conversation_type');
});

test('rejects unexpected input properties, including display metadata and model grants', () => {
  const { projector } = createDependencies();

  for (const context of [
    privateRuntimeContext({ displayName: 'Trusted name?' }),
    privateRuntimeContext({ requestedCapabilities: ['lookup'] }),
    privateRuntimeContext({ grantedCapabilities: ['lookup'] }),
    privateRuntimeContext({ authorizedTools: ['lookup_data'] }),
  ]) {
    const decision = projector.project(context);
    assert.equal(decision.authorized, false);
    assert.equal(decision.reason, 'invalid_trusted_runtime_context');
    assert.equal(decision.context, null);
  }
});

test('display names cannot replace sender identity', () => {
  const { projector } = createDependencies();

  const decision = projector.project({
    chatType: 'private',
    displayName: USER_ID,
    privateSessionId: PRIVATE_SESSION,
    conversationSessionId: PRIVATE_SESSION,
  });

  assert.equal(decision.authorized, false);
  assert.equal(decision.reason, 'invalid_trusted_runtime_context');
  assert.equal(decision.context, null);
});

test('user-provided capability data cannot grant tools and empty configuration denies by default', () => {
  const { projector } = createDependencies({ applicationCapabilities: [] });

  const injection = projector.project({
    ...privateRuntimeContext(),
    grantedCapabilities: ['lookup'],
  });
  const noConfiguredCapabilities = projector.project(privateRuntimeContext());

  assert.equal(injection.authorized, false);
  assert.equal(injection.reason, 'invalid_trusted_runtime_context');
  assert.equal(noConfiguredCapabilities.authorized, false);
  assert.equal(noConfiguredCapabilities.reason, 'no_explicit_tool_grants');
  assert.equal(noConfiguredCapabilities.context, null);
});

test('keeps identity and session evidence out of executor context', () => {
  const { projector } = createDependencies();
  const decision = projector.project(privateRuntimeContext());

  assert.equal(decision.authorized, true);
  assert.equal('senderId' in decision.context, false);
  assert.equal('privateSessionId' in decision.context, false);
  assert.equal('conversationSessionId' in decision.context, false);
  assert.deepEqual(decision.context.authorizedTools, ['lookup_data']);
});

test('denied authorization exposes no tools and does not mutate the registry', () => {
  const { registry, projector } = createDependencies({
    applicationCapabilities: [],
  });
  const registrySize = registry.size;

  const decision = projector.project(privateRuntimeContext());

  assert.equal(decision.authorized, false);
  assert.equal(decision.context, null);
  assert.equal(registry.size, registrySize);
});

test('rejects invalid trusted capability configuration at construction', () => {
  const registry = createToolRegistry();
  const authorizationPolicy = createToolAuthorizationPolicy({
    registry,
    getPrivateSessionId: (senderId) => `private:${senderId}`,
    isValidSenderId: () => true,
  });

  assert.throws(() => createTrustedRuntimeContextProjector({
    authorizationPolicy,
    getPrivateSessionId: (senderId) => `private:${senderId}`,
    isValidSenderId: () => true,
    applicationCapabilities: 'lookup',
  }), TrustedRuntimeContextError);
});

test('fails closed when the injected validator or session resolver throws', () => {
  const invalidIdentity = createDependencies({
    isValidSenderId() {
      throw new Error('validator failure');
    },
  }).projector.project(privateRuntimeContext());
  const invalidSession = createDependencies({
    getPrivateSessionId() {
      throw new Error('resolver failure');
    },
  }).projector.project(privateRuntimeContext());

  assert.equal(invalidIdentity.authorized, false);
  assert.equal(invalidIdentity.reason, 'missing_or_invalid_sender_identity');
  assert.equal(invalidSession.authorized, false);
  assert.equal(invalidSession.reason, 'missing_or_invalid_private_session');
});
