const INPUT_KEYS = new Set([
  'chatType',
  'senderId',
  'privateSessionId',
  'conversationSessionId',
]);

const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const DENIAL_REASONS = Object.freeze({
  invalid_context: 'invalid_trusted_runtime_context',
  unknown_type: 'unknown_conversation_type',
  group: 'group_tool_execution_disabled',
  sender: 'missing_or_invalid_sender_identity',
  private_session: 'missing_or_invalid_private_session',
  conversation_session: 'missing_or_invalid_conversation_session',
  scope_mismatch: 'conversation_session_scope_mismatch',
});

export class TrustedRuntimeContextError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'TrustedRuntimeContextError';
    this.code = 'INVALID_TRUSTED_RUNTIME_CONTEXT_CONFIGURATION';
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

function copyRuntimeInput(value) {
  if (!isPlainRecord(value)) return null;

  const input = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === 'string'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (
      typeof key !== 'string' ||
      !INPUT_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return null;
    }
    Object.defineProperty(input, key, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return input;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) {
    throw new TrustedRuntimeContextError(
      'requestedCapabilities must be an array.',
    );
  }

  const capabilities = [];
  const seen = new Set();
  for (const capability of value) {
    if (
      typeof capability !== 'string' ||
      !CAPABILITY_PATTERN.test(capability) ||
      seen.has(capability)
    ) {
      throw new TrustedRuntimeContextError(
        'requestedCapabilities must contain unique valid names.',
      );
    }
    seen.add(capability);
    capabilities.push(capability);
  }
  return Object.freeze(capabilities);
}

function denial(reason) {
  return Object.freeze({
    authorized: false,
    reason,
    context: null,
  });
}

function hasCanonicalString(value) {
  return typeof value === 'string' && Boolean(value.trim()) &&
    value === value.trim();
}

/**
 * Projects trusted adapter identity and application session state through the
 * existing authorization policy. Capabilities are fixed at construction time.
 */
export function createTrustedRuntimeContextProjector({
  authorizationPolicy,
  getPrivateSessionId,
  isValidSenderId,
  applicationCapabilities = [],
} = {}) {
  if (typeof authorizationPolicy?.authorize !== 'function') {
    throw new TrustedRuntimeContextError(
      'An application tool authorization policy is required.',
    );
  }
  if (typeof getPrivateSessionId !== 'function') {
    throw new TrustedRuntimeContextError(
      'An application-owned private-session resolver is required.',
    );
  }
  if (typeof isValidSenderId !== 'function') {
    throw new TrustedRuntimeContextError(
      'An application-owned sender identity validator is required.',
    );
  }

  const capabilities = normalizeCapabilities(applicationCapabilities);

  return Object.freeze({
    project(runtimeContext) {
      const input = copyRuntimeInput(runtimeContext);
      if (!input) return denial(DENIAL_REASONS.invalid_context);

      if (input.chatType !== 'private') {
        return authorizationPolicy.authorize({
          chatType: input.chatType,
          requestedCapabilities: capabilities,
        });
      }

      if (!hasCanonicalString(input.senderId)) {
        return denial(DENIAL_REASONS.sender);
      }

      try {
        if (isValidSenderId(input.senderId) !== true) {
          return denial(DENIAL_REASONS.sender);
        }
      } catch {
        return denial(DENIAL_REASONS.sender);
      }

      if (!hasCanonicalString(input.privateSessionId)) {
        return denial(DENIAL_REASONS.private_session);
      }
      if (!hasCanonicalString(input.conversationSessionId)) {
        return denial(DENIAL_REASONS.conversation_session);
      }

      let canonicalPrivateSessionId;
      try {
        canonicalPrivateSessionId = getPrivateSessionId(input.senderId);
      } catch {
        return denial(DENIAL_REASONS.private_session);
      }
      if (!hasCanonicalString(canonicalPrivateSessionId)) {
        return denial(DENIAL_REASONS.private_session);
      }
      if (
        input.privateSessionId !== canonicalPrivateSessionId ||
        input.conversationSessionId !== canonicalPrivateSessionId
      ) {
        return denial(DENIAL_REASONS.scope_mismatch);
      }

      return authorizationPolicy.authorize({
        chatType: input.chatType,
        senderId: input.senderId,
        privateSessionId: canonicalPrivateSessionId,
        conversationSessionId: canonicalPrivateSessionId,
        requestedCapabilities: capabilities,
      });
    },
  });
}
