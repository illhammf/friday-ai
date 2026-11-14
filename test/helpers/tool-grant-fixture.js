import { createToolGrantLifecycle } from '../../src/application/tool-grant-lifecycle.js';

export const TEST_PRINCIPAL_ID = 'fixture-principal';
export const TEST_GRANT_SCOPE = 'fixture-scope';

const TEST_CAPABILITIES = [
  'action',
  'lookup',
  'private_context',
  'private_context_read',
  'project_read',
  'read_status',
];

export function createTestGrantLifecycle(options = {}) {
  const policyRevision = options.policyRevision || 'fixture-policy-v1';
  return createToolGrantLifecycle({
    knownCapabilities: options.knownCapabilities || TEST_CAPABILITIES,
    now: options.now || (() => 1000),
    getPolicyRevision: options.getPolicyRevision || (() => policyRevision),
    getGrant: options.getGrant || (({ principalId, scope }) => ({
      principalId,
      scope,
      status: 'active',
      revoked: false,
      capabilities: TEST_CAPABILITIES,
      expiresAt: 10000,
      revision: 'fixture-grant-v1',
      policyRevision,
    })),
  });
}
