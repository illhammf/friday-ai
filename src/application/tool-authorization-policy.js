const RUNTIME_CONTEXT_KEYS = new Set([
  'chatType',
  'senderId',
  'privateSessionId',
  'conversationSessionId',
  'requestedCapabilities',
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
  capabilities: 'invalid_requested_capabilities',
  unknown_capability: 'unconfigured_application_capability',
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

function normalizeCapabilityGrants(capabilityToolGrants, allowlist, registry) {
  if (!isPlainRecord(capabilityToolGrants)) {
    throw new ToolAuthorizationPolicyError(
      'capabilityToolGrants must be a plain object.',
    );
  }

  const grants = new Map();
  for (const key of Reflect.ownKeys(capabilityToolGrants)) {
    const descriptor = typeof key === 'string'
      ? Object.getOwnPropertyDescriptor(capabilityToolGrants, key)
      : null;
    if (
      typeof key !== 'string' ||
      !CAPABILITY_PATTERN.test(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new ToolAuthorizationPolicyError(
        'Capability grants contain an invalid property.',
      );
    }

    const toolNames = normalizeNames(
      descriptor.value,
      `Tool grants for capability "${key}"`,
      TOOL_NAME_PATTERN,
    );
    for (const toolName of toolNames) {
      if (!allowlist.has(toolName)) {
        throw new ToolAuthorizationPolicyError(
          `Tool "${toolName}" is not in the fixed application allowlist.`,
        );
      }
      if (!registry.has(toolName)) {
        throw new ToolAuthorizationPolicyError(
          `Tool "${toolName}" is not registered.`,
        );
      }
      if (registry.get(toolName)?.category !== 'read_only') {
        throw new ToolAuthorizationPolicyError(
          `Tool "${toolName}" is not registered as read_only.`,
        );
      }
    }
    grants.set(key, toolNames);
  }
  return grants;
}

/**
 * Builds an immutable, least-privilege tool authorization decision from
 * application-owned normalized runtime context.
 */
export function createToolAuthorizationPolicy({
  registry,
  allowedTools = [],
  capabilityToolGrants = {},
  getPrivateSessionId,
  isValidSenderId,
} = {}) {
  if (
    !registry ||
    typeof registry.get !== 'function' ||
    typeof registry.has !== 'function' ||
    typeof registry.getPublicDeclarations !== 'function'
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

  const configuredAllowlist = normalizeNames(
    allowedTools,
    'allowedTools',
    TOOL_NAME_PATTERN,
  );
  const allowlist = new Set(configuredAllowlist);
  for (const toolName of configuredAllowlist) {
    if (!registry.has(toolName)) {
      throw new ToolAuthorizationPolicyError(
        `Allowlisted tool "${toolName}" is not registered.`,
      );
    }
  }
  const grants = normalizeCapabilityGrants(
    capabilityToolGrants,
    allowlist,
    registry,
  );

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

      let requestedCapabilities;
      try {
        requestedCapabilities = normalizeNames(
          input.requestedCapabilities,
          'requestedCapabilities',
          CAPABILITY_PATTERN,
        );
      } catch {
        return denial(DENIAL_REASONS.capabilities);
      }

      const requestedTools = new Set();
      for (const capability of requestedCapabilities) {
        const capabilityTools = grants.get(capability);
        if (!capabilityTools) {
          return denial(DENIAL_REASONS.unknown_capability);
        }
        for (const toolName of capabilityTools) {
          if (allowlist.has(toolName) && registry.has(toolName)) {
            requestedTools.add(toolName);
          }
        }
      }

      if (requestedTools.size === 0) {
        return denial(DENIAL_REASONS.no_grants);
      }

      const authorizedTools = Object.freeze([...requestedTools]);
      const context = Object.freeze({
        conversationType: 'private',
        authorizedTools,
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
