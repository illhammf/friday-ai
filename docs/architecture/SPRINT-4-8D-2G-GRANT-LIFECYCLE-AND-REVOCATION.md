# Sprint 4.8D.2G — Grant Lifecycle and Revocation Foundation

## Status and boundary

This sprint adds an isolated, injected grant-state evaluator and uses it at
both model declaration filtering and executor dispatch. It does not connect
the mechanism to `src/friday-runtime.js`, register production tools, add real
grants, or change legacy message routing or assistant behavior.

Production WhatsApp identity validation remains unavailable. The principal
resolver is an application-owned dependency; it receives no phone, display
name, chat name, or model-generated value from this mechanism. Tests use
synthetic fixture principals only. Production authorization therefore
remains deny-all, and production tool execution remains disabled.

## Existing architecture inspected

The Sprint 4.8D.2F implementation was inspected in:

- `src/ai/tools/tool-registry.js`
- `src/ai/tools/tool-permission-policy.js`
- `src/ai/tools/tool-executor.js`
- `src/ai/tool-orchestrator.js`
- `src/application/tool-authorization-policy.js`
- `src/application/trusted-runtime-context.js`
- `src/application/tool-assistant.js`
- `docs/architecture/SPRINT-4-8D-2F-CAPABILITY-REQUIREMENTS-AND-DECLARATION-FILTERING.md`
- Related tool, orchestration, assistant, provider-policy, and trusted-context
  tests.

The registry owns immutable tool categories and required capabilities.
`tool-authorization-policy.js` creates an `authorizedTools` and capability
snapshot; `tool-orchestrator.js` filters declarations from that snapshot;
`tool-executor.js` independently checks permissions before dispatch.

The prior executor check still treated its copied grant arrays as sufficient.
Those immutable values could become stale after declarations were generated.
The smallest safe integration was to add a common injected lifecycle evaluator,
call it from the executor's declaration eligibility check, and call it again
immediately before invoking the handler. Existing capability snapshots remain
an additional restrictive check, not the live source of authority.

## Grant lifecycle contract

`createToolGrantLifecycle()` in
`src/application/tool-grant-lifecycle.js` accepts three application-owned
dependencies:

- `getGrant({ principalId, scope })`: current grant state; may be asynchronous.
- `getPolicyRevision()`: current non-empty policy revision; may be
  asynchronous.
- `now()`: one safe-integer Unix timestamp in milliseconds per evaluation.

The evaluator also receives the application-owned list of known capability
names. For each check it accepts a principal ID, scope, and non-empty set of
required capabilities. It does not accept tool arguments or model input.

The provider's grant record is:

```js
{
  principalId: 'opaque-application-principal',
  scope: 'application-scope',
  status: 'active', // or 'revoked'
  revoked: false,
  capabilities: ['lookup'],
  expiresAt: 1760000000000,
  revision: 'grant-revision',
  policyRevision: 'policy-revision',
}
```

Records with unknown keys, accessors, invalid types, duplicate or unknown
capabilities, missing revision fields, or mismatched principal/scope are
rejected. Empty capability lists are structurally valid but cannot satisfy a
tool's non-empty required-capability set.

## Validity and failure semantics

- Grant status must be exactly `active`, and `revoked` must be `false`.
- The grant's `policyRevision` must equal the current injected policy revision.
- Every required capability must be present (all-of semantics).
- A grant expires when `expiresAt <= evaluatedAt`; equality is expired.
- One timestamp is read and reused for one evaluation.
- Missing grants, malformed records, provider/revision/clock errors, invalid
  timestamps, invalid principal/scope, missing capabilities, expired grants,
  revoked grants, and stale policy revisions all deny authorization.
- Provider failures return a generic authorization denial; no provider error
  details or grant data are exposed to the model.

## Declaration filtering and dispatch revalidation

Before exposing declarations, the orchestrator first restricts candidates to
registered tools whose existing trusted snapshot allows them, and then calls
`executor.isAuthorized()` for a current lifecycle evaluation of each
candidate. A missing or malformed context produces no eligible declarations.
The model cannot add tools, principals, scopes, or capabilities.

At dispatch, the executor independently checks the registered category,
`authorizedTools`, and snapshot capabilities, then re-reads lifecycle state.
The live grant is evaluated after argument/context preparation and immediately
before the handler is invoked. Any failure rejects dispatch before `onStarted`
and before handler invocation. The lifecycle provider receives only the
principal, scope, and registered required capabilities; model-supplied
arguments are not used in authorization.

The application authorization policy requires an application-owned
`getTrustedPrincipalId()` resolver and passes its result to the executor
context; the principal is not accepted as a runtime-context or model-input
field. The grant scope is the already-validated private session scope. This is
an isolated contract change, not production identity validation.

## Revocation, retries, and limitations

Revocation or expiry prevents future declaration checks and dispatches once
the provider reports that state. A declaration generated earlier does not
preserve authorization: executor dispatch rechecks current grant, expiration,
and policy revision.

An already-running handler is not automatically cancelled when a grant is
revoked. The mechanism does not provide atomicity across external grant-state
updates and handler start, nor exactly-once execution. A state change can race
after a successful check. Uncertain handler outcomes continue to use existing
executor timeout and provider retry-safety rules; this sprint does not change
them.

`action` and `approval_required` tools remain denied. Existing all-of
capability checks, orchestration limits, and retry-safety behavior remain in
place. No grant persistence, migration, production grant, or production
runtime integration was added.

## Test coverage

Fake grant providers and injected clocks cover valid/missing/expired grants,
the exact expiry boundary, revocation, invalid status, empty and partial
capabilities, all-of requirements, scope mismatch, stale policy revisions,
provider/clock/revision failures, malformed records, unknown capabilities,
and missing principal/scope.

Orchestration tests cover revocation, expiry, and policy revision changes
between declaration filtering and dispatch; handler non-invocation after
denial; model argument spoofing; and the fact that revocation does not cancel
an already-running handler. Existing tests cover read-only restrictions,
action/approval denial, orchestration limits, legacy assistant behavior, and
provider retry safety.

## Files changed

- `src/application/tool-grant-lifecycle.js`
- `src/application/tool-authorization-policy.js`
- `src/application/trusted-runtime-context.js`
- `src/ai/tools/tool-executor.js`
- `src/ai/tool-orchestrator.js`
- `test/helpers/tool-grant-fixture.js`
- `test/tool-grant-lifecycle.test.js`
- `test/ai-tools.test.js`
- `test/tool-authorization-policy.test.js`
- `test/trusted-runtime-context.test.js`
- `test/tool-orchestrator.test.js`
- `test/tool-pipeline.test.js`
- `test/application-tool-assistant.test.js`
- `test/tool-provider-policy.test.js`
- `package.json`
- `docs/architecture/SPRINT-4-8D-2G-GRANT-LIFECYCLE-AND-REVOCATION.md`

## Explicit production status

Production WhatsApp identity validation remains unavailable, and production
authorization stays deny-all. No production tool execution or runtime
integration is enabled. This document does not claim production readiness.
