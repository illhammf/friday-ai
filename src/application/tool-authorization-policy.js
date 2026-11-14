import { hasRequiredCapabilities } from '../ai/tools/tool-permission-policy.js';

const RUNTIME_CONTEXT_KEYS = new Set([
  'chatType',
  'senderId',
  'privateSessionId',
  'conversationSessionId',
  'grantedCapabilities',
]);

const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const DENIAL_REASONS = Object.freeze({
  invalid_context: 'invalid_runtime_context',
  unknown_type: 'unknown_conversation_type',
  group: 'group_tool_execution_disabled',
  sender: 'missing_or_invalid_sender_identity',
  private_session: 'missing_or_invalid_private_session',
  conversation_session: 'missing_or_invalid_conversation_session',
  scope_mismatch: 'conversation_session_scope_mismatch',
  principal: 'missing_or_invalid_trusted_principal',
  capabilities: 'invalid_granted_capabilities',
  unknown_capability: 'unknown_application_capability',
  no_grants: 'no_explicit_tool_grants',
});

export class ToolAuthorizationPolicyError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'ToolAuthorizationPolicyError';
    this.code = 'INVALID_TOOL_AUTHORIZATION_POLICY';
  }
}

function isPlainRecord(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  );
}

function normalizeNames(value, label, pattern) {
  if (!Array.isArray(value)) {
    throw new ToolAuthorizationPolicyError(`${label} must be an array.`);
  }

  const names = [];
  const seen = new Set();
  for (const name of value) {
    if (
      typeof name !== 'string' ||
      !pattern.test(name) ||
      seen.has(name)
    ) {
      throw new ToolAuthorizationPolicyError(
        `${label} must contain unique valid names.`,
      );
    }
    seen.add(name);
    names.push(name);
  }
  return Object.freeze(names);
}

function copyAndValidateRuntimeContext(value) {
  if (!isPlainRecord(value)) return null;

  const context = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === 'string'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (
      typeof key !== 'string' ||
      !RUNTIME_CONTEXT_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return null;
    }
    Object.defineProperty(context, key, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return context;
}

function denial(reason) {
  return Object.freeze({
    authorized: false,
    reason,
    context: null,
  });
}

/**
 * Builds an immutable, least-privilege tool authorization decision from
 * application-owned normalized runtime context.
 */
export function createToolAuthorizationPolicy({
  registry,
  allowedTools = [],
  knownCapabilities = [],
  getPrivateSessionId,
  isValidSenderId,
  getTrustedPrincipalId,
} = {}) {
  if (
    !registry ||
    typeof registry.get !== 'function' ||
    typeof registry.has !== 'function' ||
    typeof registry.getPublicDeclarations !== 'function' ||
    typeof registry.getAuthorizationMetadata !== 'function'
  ) {
    throw new ToolAuthorizationPolicyError(
      'A tool registry is required.',
    );
  }
  if (typeof getPrivateSessionId !== 'function') {
    throw new ToolAuthorizationPolicyError(
      'An application-owned private-session resolver is required.',
    );
  }
  if (typeof isValidSenderId !== 'function') {
    throw new ToolAuthorizationPolicyError(
      'An application-owned sender identity validator is required.',
    );
  }
  if (typeof getTrustedPrincipalId !== 'function') {
    throw new ToolAuthorizationPolicyError(
      'An application-owned trusted-principal resolver is required.',
    );
  }

  const configuredAllowlist = normalizeNames(
    allowedTools,
    'allowedTools',
    TOOL_NAME_PATTERN,
  );
  const capabilities = normalizeNames(
    knownCapabilities,
    'knownCapabilities',
    CAPABILITY_PATTERN,
  );
  const knownCapabilitySet = new Set(capabilities);
  const declarations = registry.getPublicDeclarations();
  if (!Array.isArray(declarations)) {
    throw new ToolAuthorizationPolicyError(
      'Registry public declarations must be an array.',
    );
  }
  for (const { name } of declarations) {
    const metadata = registry.getAuthorizationMetadata(name);
    if (
      !metadata ||
      !Array.isArray(metadata.requiredCapabilities) ||
      metadata.requiredCapabilities.length === 0 ||
      metadata.requiredCapabilities.some((capability) =>
        !knownCapabilitySet.has(capability))
    ) {
      throw new ToolAuthorizationPolicyError(
        `Tool "${name}" has missing or unknown capability requirements.`,
      );
    }
  }
  for (const toolName of configuredAllowlist) {
    if (!registry.has(toolName)) {
      throw new ToolAuthorizationPolicyError(
        `Allowlisted tool "${toolName}" is not registered.`,
      );
    }
    const metadata = registry.getAuthorizationMetadata(toolName);
    if (metadata?.category !== 'read_only') {
      throw new ToolAuthorizationPolicyError(
        `Tool "${toolName}" is not registered as read_only.`,
      );
    }
  }

  return Object.freeze({
    authorize(runtimeContext) {
      const input = copyAndValidateRuntimeContext(runtimeContext);
      if (!input) return denial(DENIAL_REASONS.invalid_context);
      if (!['private', 'group'].includes(input.chatType)) {
        return denial(DENIAL_REASONS.unknown_type);
      }
      if (input.chatType === 'group') {
        return denial(DENIAL_REASONS.group);
      }
      if (
        typeof input.senderId !== 'string' ||
        !input.senderId.trim() ||
        input.senderId !== input.senderId.trim()
      ) {
        return denial(DENIAL_REASONS.sender);
      }
      try {
        if (isValidSenderId(input.senderId) !== true) {
          return denial(DENIAL_REASONS.sender);
        }
      } catch {
        return denial(DENIAL_REASONS.sender);
      }
      if (
        typeof input.privateSessionId !== 'string' ||
        !input.privateSessionId.trim() ||
        input.privateSessionId !== input.privateSessionId.trim()
      ) {
        return denial(DENIAL_REASONS.private_session);
      }
      if (
        typeof input.conversationSessionId !== 'string' ||
        !input.conversationSessionId.trim() ||
        input.conversationSessionId !== input.conversationSessionId.trim()
      ) {
        return denial(DENIAL_REASONS.conversation_session);
      }
      let principalId;
      try {
        principalId = getTrustedPrincipalId();
      } catch {
        return denial(DENIAL_REASONS.principal);
      }
      if (
        typeof principalId !== 'string' ||
        !principalId.trim() ||
        principalId !== principalId.trim()
      ) {
        return denial(DENIAL_REASONS.principal);
      }

      let expectedPrivateSessionId;
      try {
        expectedPrivateSessionId = getPrivateSessionId(input.senderId);
      } catch {
        return denial(DENIAL_REASONS.private_session);
      }
      if (
        typeof expectedPrivateSessionId !== 'string' ||
        !expectedPrivateSessionId ||
        expectedPrivateSessionId !== input.privateSessionId ||
        input.conversationSessionId !== input.privateSessionId
      ) {
        return denial(DENIAL_REASONS.scope_mismatch);
      }

      let grantedCapabilities;
      try {
        grantedCapabilities = normalizeNames(
          input.grantedCapabilities,
          'grantedCapabilities',
          CAPABILITY_PATTERN,
        );
      } catch {
        return denial(DENIAL_REASONS.capabilities);
      }
      if (grantedCapabilities.some((capability) =>
        !knownCapabilitySet.has(capability))
      ) {
        return denial(DENIAL_REASONS.unknown_capability);
      }

      const eligibleTools = configuredAllowlist.filter((toolName) =>
        hasRequiredCapabilities(
          registry.getAuthorizationMetadata(toolName),
          grantedCapabilities,
        ));

      if (eligibleTools.length === 0) {
        return denial(DENIAL_REASONS.no_grants);
      }

      const authorizedTools = Object.freeze(eligibleTools);
      const context = Object.freeze({
        conversationType: 'private',
        authorizedTools,
        grantedCapabilities,
        principalId,
        grantScope: input.privateSessionId,
      });

      return Object.freeze({
        authorized: true,
        reason: 'explicit_application_capability_grant',
        context,
        identity: Object.freeze({
          senderId: input.senderId,
        }),
        sessionScope: Object.freeze({
          privateSessionId: input.privateSessionId,
          conversationSessionId: input.conversationSessionId,
        }),
      });
    },
  });
}
