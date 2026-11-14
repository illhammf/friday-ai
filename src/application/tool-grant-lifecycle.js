const CAPABILITY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const GRANT_KEYS = new Set([
  'principalId',
  'scope',
  'status',
  'revoked',
  'capabilities',
  'expiresAt',
  'revision',
  'policyRevision',
]);

const DENIALS = Object.freeze({
  invalid_request: 'invalid_grant_request',
  missing: 'grant_missing',
  malformed: 'grant_state_invalid',
  revoked: 'grant_revoked',
  expired: 'grant_expired',
  scope: 'grant_scope_mismatch',
  revision: 'policy_revision_mismatch',
  capabilities: 'required_capabilities_missing',
  unavailable: 'authorization_state_unavailable',
});

function isPlainRecord(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  );
}

function isCanonicalString(value) {
  return typeof value === 'string' &&
    Boolean(value.trim()) &&
    value === value.trim();
}

function isValidCapabilityList(value, knownCapabilities) {
  return Array.isArray(value) &&
    value.every((capability, index) =>
      typeof capability === 'string' &&
      CAPABILITY_PATTERN.test(capability) &&
      knownCapabilities.has(capability) &&
      value.indexOf(capability) === index);
}

function denial(reason, evaluatedAt = null) {
  return Object.freeze({
    authorized: false,
    reason,
    evaluatedAt,
  });
}

function validateGrant(grant, knownCapabilities) {
  if (!isPlainRecord(grant)) return false;
  for (const key of Reflect.ownKeys(grant)) {
    const descriptor = typeof key === 'string'
      ? Object.getOwnPropertyDescriptor(grant, key)
      : null;
    if (
      typeof key !== 'string' ||
      !GRANT_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return false;
    }
  }
  return (
    isCanonicalString(grant.principalId) &&
    isCanonicalString(grant.scope) &&
    ['active', 'revoked'].includes(grant.status) &&
    typeof grant.revoked === 'boolean' &&
    isValidCapabilityList(grant.capabilities, knownCapabilities) &&
    Number.isSafeInteger(grant.expiresAt) &&
    grant.expiresAt >= 0 &&
    isCanonicalString(grant.revision) &&
    isCanonicalString(grant.policyRevision)
  );
}

function normalizeNames(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((name, index) =>
      typeof name !== 'string' ||
      !CAPABILITY_PATTERN.test(name) ||
      value.indexOf(name) !== index)
  ) {
    throw new TypeError(`${label} must contain unique valid capability names.`);
  }
  return value;
}

/**
 * Creates a read-only evaluator over application-owned grant state.
 * The provider, clock, and policy revision source must not be user/model input.
 */
export function createToolGrantLifecycle({
  getGrant,
  getPolicyRevision,
  now,
  knownCapabilities = [],
} = {}) {
  if (typeof getGrant !== 'function') {
    throw new TypeError('An application grant-state provider is required.');
  }
  if (typeof getPolicyRevision !== 'function') {
    throw new TypeError('An application policy-revision provider is required.');
  }
  if (typeof now !== 'function') {
    throw new TypeError('An application clock is required.');
  }

  const known = new Set(normalizeNames(knownCapabilities, 'knownCapabilities'));
  if (known.size !== knownCapabilities.length) {
    throw new TypeError('knownCapabilities must be unique.');
  }

  return Object.freeze({
    async authorize({ principalId, scope, requiredCapabilities } = {}) {
      let required;
      try {
        required = normalizeNames(requiredCapabilities, 'requiredCapabilities');
      } catch {
        return denial(DENIALS.invalid_request);
      }
      if (
        !isCanonicalString(principalId) ||
        !isCanonicalString(scope) ||
        required.length === 0 ||
        required.some((capability) => !known.has(capability))
      ) {
        return denial(DENIALS.invalid_request);
      }

      let evaluatedAt;
      let currentPolicyRevision;
      let grant;
      try {
        evaluatedAt = now();
        if (!Number.isSafeInteger(evaluatedAt) || evaluatedAt < 0) {
          return denial(DENIALS.unavailable);
        }
        grant = await getGrant({ principalId, scope });
        currentPolicyRevision = await getPolicyRevision();
        if (!isCanonicalString(currentPolicyRevision)) {
          return denial(DENIALS.unavailable, evaluatedAt);
        }
      } catch {
        return denial(DENIALS.unavailable, evaluatedAt ?? null);
      }

      if (grant == null) return denial(DENIALS.missing, evaluatedAt);
      let grantIsValid;
      try {
        grantIsValid = validateGrant(grant, known);
      } catch {
        return denial(DENIALS.malformed, evaluatedAt);
      }
      if (!grantIsValid) {
        return denial(DENIALS.malformed, evaluatedAt);
      }
      if (grant.status === 'revoked' || grant.revoked) {
        return denial(DENIALS.revoked, evaluatedAt);
      }
      if (grant.status !== 'active') {
        return denial(DENIALS.malformed, evaluatedAt);
      }
      if (
        grant.principalId !== principalId ||
        grant.scope !== scope
      ) {
        return denial(DENIALS.scope, evaluatedAt);
      }
      if (grant.policyRevision !== currentPolicyRevision) {
        return denial(DENIALS.revision, evaluatedAt);
      }
      if (grant.expiresAt <= evaluatedAt) {
        return denial(DENIALS.expired, evaluatedAt);
      }
      if (required.some((capability) =>
        !grant.capabilities.includes(capability))
      ) {
        return denial(DENIALS.capabilities, evaluatedAt);
      }

      return Object.freeze({
        authorized: true,
        reason: 'grant_active',
        evaluatedAt,
        grantRevision: grant.revision,
        policyRevision: currentPolicyRevision,
      });
    },
  });
}
