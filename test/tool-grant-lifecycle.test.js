import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolGrantLifecycle } from '../src/application/tool-grant-lifecycle.js';
import { createToolExecutor } from '../src/ai/tools/tool-executor.js';
import { createToolOrchestrator } from '../src/ai/tool-orchestrator.js';
import { createToolRegistry } from '../src/ai/tools/tool-registry.js';

const NOW = 5000;
const PRINCIPAL_ID = 'fixture-principal';
const SCOPE = 'fixture-scope';
const POLICY_REVISION = 'policy-v1';
const CAPABILITIES = ['lookup', 'private_context'];
const REQUIRED_CAPABILITIES = ['lookup'];
const TRUSTED_CONTEXT = Object.freeze({
  authorizedTools: ['lookup_data'],
  grantedCapabilities: ['lookup', 'private_context'],
  principalId: PRINCIPAL_ID,
  grantScope: SCOPE,
});
const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function grant(overrides = {}) {
  return {
    principalId: PRINCIPAL_ID,
    scope: SCOPE,
    status: 'active',
    revoked: false,
    capabilities: CAPABILITIES,
    expiresAt: NOW + 100,
    revision: 'grant-v1',
    policyRevision: POLICY_REVISION,
    ...overrides,
  };
}

function createLifecycle(options = {}) {
  return createToolGrantLifecycle({
    knownCapabilities: CAPABILITIES,
    now: options.now || (() => NOW),
    getPolicyRevision: options.getPolicyRevision || (() => POLICY_REVISION),
    getGrant: options.getGrant || (() => grant()),
  });
}

async function evaluate(lifecycle, overrides = {}) {
  return lifecycle.authorize({
    principalId: PRINCIPAL_ID,
    scope: SCOPE,
    requiredCapabilities: REQUIRED_CAPABILITIES,
    ...overrides,
  });
}

test('authorizes an active grant and records one deterministic evaluation timestamp', async () => {
  let clockCalls = 0;
  const lifecycle = createLifecycle({
    now: () => {
      clockCalls += 1;
      return NOW;
    },
  });

  const decision = await evaluate(lifecycle);

  assert.equal(decision.authorized, true);
  assert.equal(decision.reason, 'grant_active');
  assert.equal(decision.evaluatedAt, NOW);
  assert.equal(decision.grantRevision, 'grant-v1');
  assert.equal(clockCalls, 1);
});

test('denies a missing grant, expiration, and the exact expiration boundary', async () => {
  const missing = await evaluate(createLifecycle({ getGrant: () => null }));
  const expired = await evaluate(createLifecycle({
    getGrant: () => grant({ expiresAt: NOW - 1 }),
  }));
  const atBoundary = await evaluate(createLifecycle({
    getGrant: () => grant({ expiresAt: NOW }),
  }));

  assert.equal(missing.reason, 'grant_missing');
  assert.equal(expired.reason, 'grant_expired');
  assert.equal(atBoundary.reason, 'grant_expired');
});

test('denies revoked or invalid-status grants', async () => {
  const revoked = await evaluate(createLifecycle({
    getGrant: () => grant({ status: 'revoked', revoked: true }),
  }));
  const revocationFlag = await evaluate(createLifecycle({
    getGrant: () => grant({ revoked: true }),
  }));
  const invalidStatus = await evaluate(createLifecycle({
    getGrant: () => grant({ status: 'pending' }),
  }));

  assert.equal(revoked.reason, 'grant_revoked');
  assert.equal(revocationFlag.reason, 'grant_revoked');
  assert.equal(invalidStatus.reason, 'grant_state_invalid');
});

test('requires all registered capabilities and rejects unknown capabilities', async () => {
  const partial = await evaluate(createLifecycle({
    getGrant: () => grant({ capabilities: ['lookup'] }),
  }), { requiredCapabilities: ['lookup', 'private_context'] });
  const empty = await evaluate(createLifecycle({
    getGrant: () => grant({ capabilities: [] }),
  }));
  const allPresent = await evaluate(createLifecycle(), {
    requiredCapabilities: ['lookup', 'private_context'],
  });
  const unknown = await evaluate(createLifecycle(), {
    requiredCapabilities: ['unconfigured'],
  });

  assert.equal(partial.reason, 'required_capabilities_missing');
  assert.equal(empty.reason, 'required_capabilities_missing');
  assert.equal(allPresent.authorized, true);
  assert.equal(unknown.reason, 'invalid_grant_request');
});

test('denies mismatched grant scope and stale policy revision', async () => {
  const scopeMismatch = await evaluate(createLifecycle({
    getGrant: () => grant({ scope: 'different-scope' }),
  }));
  const staleRevision = await evaluate(createLifecycle({
    getPolicyRevision: () => 'policy-v2',
  }));

  assert.equal(scopeMismatch.reason, 'grant_scope_mismatch');
  assert.equal(staleRevision.reason, 'policy_revision_mismatch');
});

test('fails closed for provider errors, malformed grants, and invalid clocks or revisions', async () => {
  const providerError = await evaluate(createLifecycle({
    getGrant() {
      throw new Error('provider secret');
    },
  }));
  const malformed = await evaluate(createLifecycle({
    getGrant: () => ({ ...grant(), capabilities: ['lookup', 'lookup'] }),
  }));
  const clockError = await evaluate(createLifecycle({
    now() {
      throw new Error('clock failure');
    },
  }));
  const invalidClock = await evaluate(createLifecycle({ now: () => NaN }));
  const missingRevision = await evaluate(createLifecycle({
    getPolicyRevision: () => null,
  }));

  assert.equal(providerError.reason, 'authorization_state_unavailable');
  assert.equal(malformed.reason, 'grant_state_invalid');
  assert.equal(clockError.reason, 'authorization_state_unavailable');
  assert.equal(invalidClock.reason, 'authorization_state_unavailable');
  assert.equal(missingRevision.reason, 'authorization_state_unavailable');
});

test('denies missing principal and scope without querying the provider', async () => {
  let providerCalls = 0;
  const lifecycle = createLifecycle({
    getGrant() {
      providerCalls += 1;
      return grant();
    },
  });

  assert.equal((await evaluate(lifecycle, { principalId: '' })).reason, 'invalid_grant_request');
  assert.equal((await evaluate(lifecycle, { scope: '' })).reason, 'invalid_grant_request');
  assert.equal(providerCalls, 0);
});

test('executor construction requires live grant state instead of snapshot-only permission', () => {
  const registry = createToolRegistry();
  assert.throws(
    () => createToolExecutor({ registry }),
    /grant lifecycle evaluator/,
  );
});

test('revocation after declaration filtering denies dispatch before the handler starts', async () => {
  let currentGrant = grant();
  let generation = 0;
  let executions = 0;
  const lifecycle = createLifecycle({ getGrant: () => currentGrant });
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read one authorized value.',
    inputSchema: EMPTY_SCHEMA,
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler: async () => {
      executions += 1;
      return { ok: true };
    },
  });
  const executor = createToolExecutor({ registry, grantLifecycle: lifecycle });
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async ({ tools }) => {
      generation += 1;
      if (generation === 1) {
        assert.deepEqual(tools.map(({ name }) => name), ['lookup_data']);
        currentGrant = grant({ status: 'revoked', revoked: true });
        return { functionCalls: [{ id: 'revoked', name: 'lookup_data', arguments: {} }] };
      }
      return { text: 'Denied.' };
    },
  });

  const result = await orchestrator.run('input', TRUSTED_CONTEXT);

  assert.equal(result.functionResponses[0].error.code, 'TOOL_PERMISSION_DENIED');
  assert.equal(result.executionProgress.calls[0].executionStarted, false);
  assert.equal(executions, 0);
});

test('expiry and policy revision changes after declaration filtering deny dispatch', async () => {
  for (const change of ['expiry', 'policy_revision']) {
    let evaluatedAt = NOW;
    let currentPolicyRevision = POLICY_REVISION;
    let generation = 0;
    let executions = 0;
    const lifecycle = createLifecycle({
      now: () => evaluatedAt,
      getPolicyRevision: () => currentPolicyRevision,
    });
    const registry = createToolRegistry();
    registry.register({
      name: 'lookup_data',
      description: 'Read one authorized value.',
      inputSchema: EMPTY_SCHEMA,
      category: 'read_only',
      requiredCapabilities: ['lookup'],
      handler: async () => {
        executions += 1;
        return { ok: true };
      },
    });
    const executor = createToolExecutor({ registry, grantLifecycle: lifecycle });
    const orchestrator = createToolOrchestrator({
      registry,
      executor,
      generator: async ({ tools }) => {
        generation += 1;
        if (generation === 1) {
          assert.deepEqual(tools.map(({ name }) => name), ['lookup_data']);
          if (change === 'expiry') evaluatedAt = NOW + 100;
          else currentPolicyRevision = 'policy-v2';
          return { functionCalls: [{ id: change, name: 'lookup_data', arguments: {} }] };
        }
        return { text: 'Denied.' };
      },
    });

    const result = await orchestrator.run('input', TRUSTED_CONTEXT);

    assert.equal(result.functionResponses[0].error.code, 'TOOL_PERMISSION_DENIED');
    assert.equal(executions, 0);
  }
});

test('model arguments cannot select the principal or add capabilities', async () => {
  const calls = [];
  let executions = 0;
  const lifecycle = createLifecycle({
    getGrant({ principalId, scope }) {
      calls.push({ principalId, scope });
      return principalId === PRINCIPAL_ID ? grant() : null;
    },
  });
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read one authorized value.',
    inputSchema: {
      type: 'object',
      properties: {
        principalId: { type: 'string' },
        capabilities: { type: 'string' },
      },
      additionalProperties: false,
    },
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler: async () => {
      executions += 1;
      return { ok: true };
    },
  });
  const executor = createToolExecutor({ registry, grantLifecycle: lifecycle });
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async ({ tools, functionResponses }) => {
      if (functionResponses.length > 0) return { text: 'Completed.' };
      assert.deepEqual(tools.map(({ name }) => name), ['lookup_data']);
      return {
        functionCalls: [{
          id: 'spoofed-identity',
          name: 'lookup_data',
          arguments: {
            principalId: 'attacker-chosen',
            capabilities: 'lookup,admin',
          },
        }],
      };
    },
  });

  const result = await orchestrator.run('input', TRUSTED_CONTEXT);

  assert.equal(executions, 1);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every(({ principalId, scope }) =>
    principalId === PRINCIPAL_ID && scope === SCOPE));
});

test('arguments cannot make a missing trusted principal grantable', async () => {
  const observedPrincipalIds = [];
  let executions = 0;
  const lifecycle = createLifecycle({
    getGrant({ principalId }) {
      observedPrincipalIds.push(principalId);
      return principalId === 'permitted-principal' ? grant({
        principalId: 'permitted-principal',
      }) : null;
    },
  });
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read one authorized value.',
    inputSchema: {
      type: 'object',
      properties: { principalId: { type: 'string' } },
      additionalProperties: false,
    },
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler: async () => {
      executions += 1;
      return { ok: true };
    },
  });
  const executor = createToolExecutor({ registry, grantLifecycle: lifecycle });
  const orchestrator = createToolOrchestrator({
    registry,
    executor,
    generator: async ({ tools, functionResponses }) => {
      if (functionResponses.length > 0) return { text: 'Denied.' };
      assert.deepEqual(tools, []);
      return {
        functionCalls: [{
          id: 'spoofed-principal',
          name: 'lookup_data',
          arguments: { principalId: 'permitted-principal' },
        }],
      };
    },
  });

  const result = await orchestrator.run('input', {
    ...TRUSTED_CONTEXT,
    principalId: 'untrusted-context-principal',
  });

  assert.equal(result.functionResponses[0].error.code, 'TOOL_PERMISSION_DENIED');
  assert.deepEqual(observedPrincipalIds, ['untrusted-context-principal']);
  assert.equal(executions, 0);
});

test('revocation does not cancel an already-running handler', async () => {
  let currentGrant = grant();
  let completeHandler;
  let handlerSignal;
  let executions = 0;
  const lifecycle = createLifecycle({ getGrant: () => currentGrant });
  const registry = createToolRegistry();
  registry.register({
    name: 'lookup_data',
    description: 'Read one authorized value.',
    inputSchema: EMPTY_SCHEMA,
    category: 'read_only',
    requiredCapabilities: ['lookup'],
    handler: (_args, context) => {
      executions += 1;
      handlerSignal = context.signal;
      return new Promise((resolve) => {
        completeHandler = () => resolve({ ok: true });
      });
    },
  });
  const executor = createToolExecutor({ registry, grantLifecycle: lifecycle });
  const running = executor.execute('lookup_data', {}, TRUSTED_CONTEXT);
  await new Promise((resolve) => setImmediate(resolve));
  currentGrant = grant({ status: 'revoked', revoked: true });

  assert.equal(executions, 1);
  assert.equal(handlerSignal.aborted, false);
  completeHandler();
  assert.deepEqual(await running, { ok: true });
  assert.equal(await executor.isAuthorized('lookup_data', TRUSTED_CONTEXT), false);
});
