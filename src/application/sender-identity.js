export const IDENTITY_STATUSES = Object.freeze([
  'verified',
  'unavailable',
  'invalid',
  'ambiguous',
]);

function unavailable(reason = 'identity_verification_unavailable') {
  return Object.freeze({ status: 'unavailable', reason });
}

function normalizeResult(result) {
  if (!result || !IDENTITY_STATUSES.includes(result.status)) {
    return unavailable('identity_result_invalid');
  }
  if (result.status !== 'verified') {
    return Object.freeze({
      status: result.status,
      ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
    });
  }
  if (
    typeof result.principalId !== 'string' ||
    !/^principal:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.principalId)
  ) {
    return unavailable('verified_identity_missing_principal');
  }
  return Object.freeze({
    status: 'verified',
    principalId: result.principalId,
  });
}

/**
 * Application-owned sender verification boundary. The default resolver is
 * deny-by-default because whatsapp-web.js fields are evidence, not proof of a
 * canonical principal identity.
 */
export function createSenderIdentityVerifier({ resolve } = {}) {
  return Object.freeze({
    async verify(message) {
      if (typeof resolve !== 'function') return unavailable();
      try {
        const result = await resolve({
          conversationType: message?.chatType,
          senderEvidence: typeof message?.senderId === 'string'
            ? message.senderId
            : null,
          messageId: typeof message?.messageId === 'string'
            ? message.messageId
            : null,
        });
        return normalizeResult(result);
      } catch {
        return unavailable('identity_provider_failure');
      }
    },
  });
}

export function canUsePersonalMemory(identity) {
  return identity?.status === 'verified' &&
    typeof identity.principalId === 'string';
}
