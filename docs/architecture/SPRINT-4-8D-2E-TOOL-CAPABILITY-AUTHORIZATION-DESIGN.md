# Sprint 4.8D.2E — Tool Capability and Authorization Boundary Design

## 1. Objective and scope

This read-only design defines an application-controlled permission model for
future tool registration, capability requirements, grants, authorization,
and denial. It examines the actual implementation rather than assuming
previous sprint documents exactly describe current source.

No tool, grant, approval workflow, runtime route, identity validator, or
production behavior is added. WhatsApp identity validation remains
unavailable/deny-all for privileged operations, and production tool
execution remains disabled.

## 2. Current architecture and source evidence

### Tool registry and argument validation

`createToolRegistry()` in `src/ai/tools/tool-registry.js` validates a
tool's name, description, object input schema, category, and handler. It
freezes the registered metadata and schema. The allowed categories are
`read_only`, `action`, and `approval_required`. Registration defines that a
tool exists; it does not itself grant execution rights.

`getPublicDeclarations()` currently returns declarations for every
registered tool. It does not filter by authorization. The current tool
definition contains only name, description, schema, category, and handler;
it has no trusted capability requirement metadata.

`validateToolArguments()` in `src/ai/tools/tool-validator.js` validates
arguments against the registered schema. It validates shape, not permission
to execute.

### Executor and permission policy

`assertToolPermission()` in `src/ai/tools/tool-permission-policy.js`
requires an explicitly named tool in `trustedContext.authorizedTools` and
rejects every category except `read_only`. Both `action` and
`approval_required` therefore remain unavailable even if a caller supplies
their names.

`createToolExecutor()` in `src/ai/tools/tool-executor.js` performs registry
lookup, schema validation, trusted-context snapshotting, and permission
checking before invoking a handler. It denies unknown tools and malformed
trusted context. It strips `authorizedTools` before constructing
handler-facing context, then adds an abort signal. The executor does not
itself verify WhatsApp identity, grant provenance, expiry, or revocation; it
trusts the application-supplied context.

### Orchestration and model adapter

`createToolOrchestrator()` in `src/ai/tool-orchestrator.js` captures
`registry.getPublicDeclarations()` when constructed and passes those
declarations to its generator. A model-generated call is normalized and
checked for call shape and limits. Unknown registry names are rejected
without calling the executor. Registered calls are dispatched to the
executor with the separately supplied trusted context; executor permission
checking remains the final enforcement before a handler runs.

`createGeminiToolAdapter()` in `src/ai/gemini-tool-adapter.js` translates
declarations to Gemini function declarations, normalizes returned function
calls, and disables provider automatic function execution. The adapter does
not grant capabilities or authorize a call.

An important current limitation is that the model receives declarations for
all registered tools, including tools the current runtime context might not
be authorized to invoke. The executor can still deny dispatch, but the
declarations expose tool names, descriptions, and schemas. A future design
should filter declarations before provider invocation as a least-disclosure
measure, while retaining executor-side enforcement.

### Application assistant and provider policy

`createToolAssistant()` in `src/application/tool-assistant.js` receives an
application-owned `createTrustedContext` dependency. `run()` calls it with
`applicationContext`, denies a trusted context classified as group, builds a
validated assistant request, then passes request and trusted context as
separate orchestrator inputs. The wrapper can enforce the behavior of its
injected dependencies but cannot prove that arbitrary caller-supplied
`applicationContext` or an injected context factory is trustworthy.

`createToolProviderPolicy()` in `src/application/tool-provider-policy.js`
selects and pins a provider/model and limits switching based on structured
pre-dispatch execution progress. It does not grant capabilities or authorize
tools.

### Trusted runtime policy and projection

`createToolAuthorizationPolicy()` in
`src/application/tool-authorization-policy.js` validates a fixed tool
allowlist, a capability-to-tool map, injected sender validation, and session
resolution. Its defaults for `allowedTools` and `capabilityToolGrants` are
empty. It denies groups and unknown conversation types, rejects invalid
sender/session scopes and unknown capabilities, and only allows grants to
registered `read_only` tools.

The current grant map is `capability -> array of tool names`. At
authorization, each requested capability contributes its tool names to a
set; multiple requested capabilities therefore combine as a union (OR for
tool eligibility), not as an all-required-capabilities rule for a tool.
Capability names currently follow `^[a-z][a-z0-9_]{0,63}$`, so conceptual
dotted examples such as `datetime.read` are not valid under this
implementation.

`createTrustedRuntimeContextProjector()` in
`src/application/trusted-runtime-context.js` captures an application
capability list at construction (empty by default), checks its narrow input
shape, validates sender/session dependencies, and delegates to the existing
authorization policy. The projector does not establish that its input came
from the WhatsApp event boundary.

### Production runtime and tests

`src/friday-runtime.js` continues to compose the legacy `message-service`
and `askFriday()` path. Repository search found no production construction of
`createToolRegistry`, `createToolExecutor`, `createToolAssistant`,
`createToolAuthorizationPolicy`, or the trusted projector in that runtime.
No production tool registration or grant is active.

Relevant tests include:

- `test/ai-tools.test.js`: registry/schema validation, explicit executor
  permissions, category denial, and handler-context isolation.
- `test/tool-orchestrator.test.js`: call normalization/limits, unknown-tool
  rejection, and execution progress.
- `test/tool-pipeline.test.js`: pipeline dispatch and authorization denial.
- `test/tool-authorization-policy.test.js`: empty defaults, group and
  unknown-type denial, injected identity/session validation, grant
  intersections, invalid grant configuration, and executor context
  isolation.
- `test/trusted-runtime-context.test.js`: trusted-input shape, fixed
  application capabilities, denial defaults, and projection isolation.
- `test/application-tool-assistant.test.js`: context factory separation,
  group denial, and missing-authorization denial.

These are local/fake-based tests of mechanics. They do not establish a
production identity contract, grant administrator, persistent grant store,
revocation lifecycle, or runtime integration.

## 3. Tool, capability, and authorization separation

### Tool registry: existence and risk metadata

The registry owns the set of executable handlers and their schemas. A tool
can be registered without being authorized. Registry lookup, tool metadata
validation, and schema validation answer whether a candidate call is
well-formed and known, not whether it is permitted.

Registration must remain application-owned code. Model output must never
register, replace, or change a handler, schema, risk category, or capability
requirement.

### Capability: application-defined permission requirement

A capability is a stable named permission concept owned by application
policy. Capability definitions and mappings are reviewed application
configuration, not model vocabulary and not user grants.

Proposed future naming should be explicit, lowercase, and stable. To remain
compatible with the current capability validator, initial identifiers should
use the existing simple lowercase alphanumeric/underscore form; do not adopt
dotted names without a separately reviewed format change. Names must not
embed mutable privilege semantics. Capability definitions are versioned in
an application-owned policy manifest with a monotonic `policyVersion` (or
equivalent schema version). A capability's meaning is never silently
reassigned; retire and replace it with an explicit versioned policy change.

The registry/tool definition or trusted policy manifest should declare a
tool's required capabilities. For tools requiring several capabilities,
all required capabilities must be granted (AND semantics). This is distinct
from a user's or application context's available capabilities. The current
capability-to-tools union model does not express this safely by itself and
must not be interpreted as all-of.

Unknown required capabilities or inconsistent tool metadata make policy
construction invalid and fail closed. Unknown requested capability names
are denied; they are never ignored or inferred.

### Authorization: context-specific decision

Authorization combines:

- A registered, schema-valid tool.
- A positively classified eligible private incoming conversation.
- A verified canonical sender identity and matching private session.
- A known, valid capability definition and the tool's requirements.
- A current application-owned grant applicable in this environment/scope.
- Any separate approval required for a high-risk operation.

Only the application decides these facts. Tool registration, a `read_only`
category, a model function call, valid arguments, or user request alone
never authorizes execution.

## 4. Proposed capability model

### Ownership and relation to tools

An application-owned, validated policy manifest should define a version,
environment applicability, known capabilities, tool requirements, and
grant sources. No such production manifest exists today; no real
capabilities or tools are proposed as active by this design.

Each tool may require one or more capabilities. Eligibility requires every
required capability to be present in the caller's validated application
grant snapshot. A tool with no explicit requirement must be denied rather
than treated as public by default. Configuration errors must not downgrade
requirements or fall back to an empty requirement list.

Capability-to-tool mappings should be generated or validated against the
registered tool metadata, not independently maintained in a way that can
silently drift. Construction must reject:

- Unknown capabilities.
- Unregistered tool names.
- Duplicate or malformed names.
- Requirements inconsistent with configured grants.
- Grants to categories that are not enabled by policy.
- Conflicting or duplicate definitions.

### Names, versioning, and unknown values

- Keep current capability-name syntax unless an explicit schema migration
  is reviewed.
- Use a separate policy-manifest version to represent definition and
  mapping changes. Do not encode version changes by silently changing an
  existing capability's meaning.
- New or unknown names deny authorization.
- Removed/retired names cannot remain valid in an old cached authorization
  snapshot after the policy version changes.
- Maintain a documented migration/review record outside of user/model
  content; no configuration file or grant list is created in this sprint.

### Multiple required capabilities

When a tool requires capabilities `[a, b]`, both must be present in the
current application grant snapshot. Missing any one denies the tool. A
capability request cannot grant itself: the application context is derived
from trusted policy, and model-generated tool calls do not carry
`requestedCapabilities`.

The present authorization policy accepts `requestedCapabilities` and
expands their mapped tools as a union. It does not currently enforce
per-tool all-of requirements. A future implementation must explicitly add
and test all-of semantics rather than rely on the current union as if it
were a requirement check.

## 5. Trusted grant model

### Grant authority and loading

For an initial future pilot, grants should be created only by reviewed
application configuration owned by the operator/deployment, validated at
startup, and bound to an explicit deployment environment. Neither end users,
WhatsApp metadata, model prompts, function arguments, nor assistant DTOs
may create or modify grants.

No persistence store, admin workflow, operator identity contract, or
production capability configuration currently exists in the inspected
runtime. Do not invent a database table or add user-managed grants as part of
this design.

Load and validate the entire manifest before tool declarations are exposed
to a provider. Missing or empty configuration yields no grants. Malformed,
ambiguous, unknown, or conflicting configuration should prevent tool
assistant construction/dispatch and produce an explicit application
diagnostic; it must not be silently filtered into a success-shaped empty
policy.

### Scope and environment

Grants must be explicit about environment (for example, test versus
production) and scope. No production environment grant is approved here.
Until sender identity validation is evidence-backed, there is no verified
private principal to which an identity-specific grant can safely attach.
Thus identity-dependent private authorization remains unavailable/deny-all.
Do not treat all private-looking conversations as verified.

Future per-user grants, if ever needed, must refer to the exact canonical
identity produced by the separately approved validator. Group grants are
out of scope and prohibited for private tools. Group conversations remain
denied regardless of tool category or capability.

### Empty configuration, expiry, and revocation

- Empty allowlist, empty capability definitions, or empty grants means deny
  all tool execution.
- Missing identity eligibility, missing context, or unavailable grant state
  means deny.
- A grant may carry an expiry and policy version. Expired grants are denied
  at the final pre-dispatch check; no stale assistant-session cache may
  extend an expiry.
- Revocation must take effect on every subsequent tool dispatch, including
  within a long-running assistant session. Do not persist `authorizedTools`
  in conversation history or reuse an earlier authorization decision for a
  later call.
- If revocation cannot be checked or current policy state is unavailable,
  deny the dispatch.
- An approval, if later designed for an `approval_required` tool, is
  separate from a capability grant and should be one-time, short-lived, and
  bound to the exact tool plus validated argument digest and request/scope.
  No approval workflow is implemented here.

The existing policy snapshots configuration at construction and has no
expiry/revocation mechanism. A later implementation must explicitly provide
a current, trusted grant/policy revision at authorization time or rebuild
the application authorization components in a way that invalidates all
stale contexts. Merely changing config on disk must not be assumed to revoke
already issued executor contexts.

## 6. Authorization decision flow

The future application flow must separate discovery from final execution
permission and perform final checks at dispatch:

1. **Load policy:** validate versioned application configuration and
   registered-tool metadata before serving tool requests. Empty grants are
   a valid deny-all state; malformed configuration disables the tool route.
2. **Registry lookup:** confirm the model-requested name identifies a
   registered tool. Unknown names produce a stable generic denial and never
   reach a handler.
3. **Tool metadata/schema validation:** verify trusted registration metadata
   and validate the arguments against its bounded schema. Arguments do not
   affect grants or identity.
4. **Conversation eligibility:** application-owned adapter/composition must
   positively classify an incoming supported private conversation. Groups,
   channels, broadcasts/status, self-authored, unknown, or unsupported
   categories are ineligible.
5. **Identity and session:** require an evidence-backed verified canonical
   private identity and matching session scope. Current identity status is
   unavailable/deny-all; stop here for privileged operations.
6. **Capability requirements:** resolve requirements only from registered
   application-owned tool metadata and known policy definitions. All
   requirements must be satisfied.
7. **Current grant lookup:** load/check the applicable application-owned
   grant snapshot, environment, policy version, and expiry. Recheck it for
   each individual tool dispatch to honor revocation.
8. **Declaration filtering:** expose to the model only registered tools
   eligible for the current trusted context. This is least disclosure, not
   the final enforcement.
9. **Final permission decision:** immediately before handler invocation,
   revalidate the tool, identity/session eligibility, required capabilities,
   current grant revision/expiry, category policy, and any separate
   approval. Fail closed if any dependency fails or throws.
10. **Executor invocation:** invoke the handler only with the
    application-approved context. The handler never sees the grant map or
    `authorizedTools` list by default.

The model may request a tool name and supply arguments. It cannot provide or
alter capabilities, grants, identity, session scope, category, approval, or
policy version, and cannot skip or reorder these checks.

## 7. Permission category and risk analysis

The existing categories are execution-risk metadata, not authorization:

| Category | Meaning in current code | Proposed policy |
|---|---|---|
| `read_only` | Only category currently accepted by both application authorization grants and executor permission policy. | Still requires an explicit grant, valid private context, and all required capabilities. “Read only” does not mean harmless or automatically allowed. |
| `action` | Registry category exists, but executor denies it. Authorization policy also rejects grants to it. | Remain unavailable until a separate risk review and explicitly approved execution mechanism. A capability alone must not enable it. |
| `approval_required` | Registry category exists, but executor denies it; no approval workflow exists. | Remain unavailable. Future approval is a separate required gate, not implied by model request or capability. Do not implement approval here. |

Tool risk classification, capability requirement, application grant,
human approval, and final authorization are distinct:

- **Risk category** describes consequences and required safeguards.
- **Capability requirement** describes what application permission is needed.
- **Grant** is the operator-approved authority to satisfy that requirement.
- **Human approval** is a separate explicit decision for a specific operation
  where required.
- **Final authorization** is the conjunction of all applicable valid checks
  at dispatch time.

A tool cannot promote itself to a less restrictive category. Unknown or
missing categories fail closed. Current code's category handling is
conservative: non-read-only calls are denied.

## 8. Revocation and failure behavior

### Stable internal denial reasons

Use stable, non-identity-bearing reason codes internally and expose only a
safe generic message to the model/user:

| Condition | Suggested stable reason | Behavior |
|---|---|---|
| Unregistered tool | `tool_not_registered` | Do not call executor/handler. |
| Invalid metadata/schema | `tool_definition_invalid` / `tool_arguments_invalid` | Deny before handler. |
| Missing/malformed authorization configuration | `authorization_configuration_invalid` | Disable route; surface operator diagnostic. |
| Missing context | `authorization_context_missing` | Deny. |
| Unknown conversation category | `conversation_category_unknown` | Deny. |
| Group conversation | `group_tool_execution_disabled` | Deny. |
| Identity unavailable/invalid | `identity_validation_unavailable` / `identity_invalid` | Deny; no private session authorization. |
| Session mismatch | `session_scope_mismatch` | Deny. |
| Unknown capability | `capability_unknown` | Deny; do not ignore. |
| Missing required capability/grant | `capability_not_granted` | Deny. |
| Expired or revoked grant | `grant_inactive` | Deny at dispatch. |
| Conflicting grant or policy revision | `grant_policy_conflict` | Deny and require operator remediation. |
| Category unsupported | `tool_category_unavailable` | Deny. |
| Required approval absent/invalid | `approval_not_present` | Deny. |
| Authorization dependency failure | `authorization_unavailable` | Deny and log operational failure. |

The current code already has structured denial codes such as
`unknown_conversation_type`, `group_tool_execution_disabled`,
`missing_or_invalid_sender_identity`,
`conversation_session_scope_mismatch`,
`unconfigured_application_capability`, and `no_explicit_tool_grants`.
The suggested reasons above are a future normalized taxonomy; this sprint
does not change existing codes.

Never include raw sender IDs, session IDs, grant contents, administrator
identities, secrets, or detailed authorization policy in model-visible
denials. Operator logs may include a bounded reason and correlation ID, not
unnecessary identity evidence.

### Exception and state handling

If identity validation, session resolution, policy loading, grant lookup,
revocation check, tool metadata access, or approval verification throws,
returns malformed data, or is unavailable, deny without invoking the
handler. Record a bounded operational error through the repository's normal
logging boundary; do not convert the failure into a successful empty grant
or silently proceed.

For revocation, every subsequent call is evaluated against current policy
state. Already running actions are not automatically undone; a later
implementation must define cancellation semantics for in-flight work.
Approval-required calls remain unavailable until a separately reviewed
approval implementation handles replay, expiry, binding to exact arguments,
and revocation.

## 9. Security threat scenario matrix

| # | Threat | Vulnerable boundary | Required behavior | Expected result |
|---|---|---|---|---|
| 1 | Model requests an unregistered tool | Generator/orchestrator registry boundary | Check registry membership; never call executor or handler for unknown name. | Deny: `tool_not_registered`. |
| 2 | Model requests additional capabilities | Assistant request/function-call boundary | Ignore no model-origin capability field because none is accepted; derive capabilities only from application policy. | Deny unknown capability request; no grant expansion. |
| 3 | User asks Friday to grant itself permissions | Message/prompt boundary | Treat as ordinary untrusted text; no grant mutation path exists. | No authorization change; deny absent application grant. |
| 4 | User message contains fake authorization metadata | Adapter/assistant input boundary | Do not parse text or metadata into trusted context; allowlist trusted context fields. | Invalid/untrusted context denied. |
| 5 | Tool arguments claim a trusted sender identity | Executor argument/context boundary | Keep identity out of arguments; identity comes from application-owned context, and arguments are schema-validated only. | Argument cannot alter principal; deny if trusted identity unavailable. |
| 6 | Display name imitates an administrator | WhatsApp normalization/context boundary | Display names are presentation-only and cannot identify grant authority. | No grant or identity change. |
| 7 | Group message seeks private authorization | Classification/projection boundary | Group is denied before private identity/session authorization; group participant and group remote remain distinct. | Deny: group tool execution disabled. |
| 8 | Unknown category enters private route | Classification boundary | Unknown is not private; fail closed. | Deny before capabilities are considered. |
| 9 | Identity validation returns unavailable | Identity gate | Do not canonicalize by guess, use display name, or derive private tool session. | Deny; current mandated identity strategy is unavailable/deny-all. |
| 10 | App config grants unknown capability | Startup/policy validation | Reject malformed/unknown capability definition; disable tool route and alert operator. | No tool declaration or execution. |
| 11 | `read_only` is treated as automatically authorized | Risk classification/grant boundary | Require explicit capability/grant and trusted private context for every tool. | Deny without grant. |
| 12 | Revoked grant reused by existing assistant session | Grant cache/executor dispatch | Check current policy revision/expiry for each call; never reuse old `authorizedTools` as current authority. | Subsequent calls denied; in-flight work handled by separate cancellation policy. |
| 13 | Tool needs multiple capabilities but only some are granted | Capability resolution | Enforce all-of requirements; current union semantics must not be mistaken for this. | Deny tool; no partial authorization. |
| 14 | Authorization dependency throws | Identity/grant/session/policy integration | Catch only at boundary, record operational failure, and fail closed without handler dispatch. | Deny: authorization unavailable. |
| 15 | Handler tries to access more permission data than approved | Executor context boundary | Pass only narrowly reviewed per-tool data; omit `authorizedTools`, grant maps, raw identity/session by default. | Handler receives least-privilege context; no authority escalation. |

## 10. Runtime integration boundaries

No integration is made in this sprint. A future composition should preserve
these owners:

- **`tool-assistant.js`:** Own one configured registry/executor/orchestrator
  composition; accept only application-owned trusted context; deny groups
  and invalid context before orchestration. It should not infer grants from
  prompts or DTOs.
- **`tool-provider-policy.js`:** Select provider and manage only safe,
  structured provider-switch eligibility. It does not decide authorization
  or add tool permissions.
- **`tool-authorization-policy.js`:** Own capability/grant validation and
  final application authorization decisions; remain the single grant policy
  rather than duplicating grants in Gemini or the WhatsApp adapter.
- **`trusted-runtime-context.js`:** Receive only application-constructed
  evidence after positive category, identity, and session gates. It must not
  be treated as an identity validator or provenance proof by shape alone.
- **`tool-executor.js`:** Enforce final permission immediately before handler
  invocation, validate arguments, keep permission data out of handlers, and
  deny by default.
- **`tool-orchestrator.js`:** Enforce call protocol/limits and dispatch only
  through the executor. Future declaration lists should be filtered to tools
  eligible for the current context, while executor-side permission checks
  remain mandatory.
- **`gemini-tool-adapter.js`:** Translate already-filtered declarations and
  model calls only. It must never accept or create application grants.

Application authorization must be decided before exposing declarations and
checked again immediately before dispatch. Model requests are proposals, not
permission decisions. Do not move authorization into prompts, model output,
function arguments, or WhatsApp adapter heuristics.

## 11. Legacy compatibility requirements

The existing `src/friday-runtime.js` legacy composition remains unchanged.
No legacy feature should depend on this capability model. A later,
separately reviewed private text-only pilot must preserve:

- Private text messaging and legacy provider fallback.
- Group text and Friday-prefix handling, with group tool authorization
  disabled.
- Conversation history and private/group memory isolation.
- Memory commands.
- Image analysis and generation.
- Voice transcription and replies.
- Sticker processing.
- Social video download routing.
- Queue order/capacity and deduplication behavior.

Media, group, image generation, video, memory commands, and other specialized
routes must not silently enter a future tool pipeline. Existing behavior
must not change until a separate implementation sprint adds and tests an
explicit route.

## 12. Unresolved dependencies

1. Evidence-backed WhatsApp message classification and identity provenance.
   The Sprint 4.8D.2D identity audit concluded **NOT READY**; private
   identity validation remains unavailable/deny-all for privileged
   operations.
2. An application-owned sender validator/canonicalizer and private session
   composition using the same verified canonical identity.
3. A reviewed application capability manifest, policy version, environment
   scope, grant owner, and operational load/validation strategy.
4. A per-tool all-of capability requirement model. The current policy uses
   capability-to-tools union semantics instead.
5. A decision about static versus dynamically revocable grants, with
   per-dispatch enforcement and invalidation of stale authorization contexts.
6. Tool declaration filtering by current authorization eligibility; current
   orchestrator declares every registered tool to its generator.
7. Approval requirements for any future `approval_required` tool. No
   workflow exists, and the executor currently denies it.
8. Production tool handlers, allowlist/grants, and activation review. None
   are present or approved.
9. A production integration test proving identity, group rejection,
   revocation, and authorization provenance end-to-end without connecting
   automated tests to WhatsApp.

## 13. Recommended implementation sequence

1. Keep production tool execution disabled and grants empty.
2. Complete evidence-backed message classification and identity validation
   work separately; do not bypass the identity blocker.
3. Specify and review the application-owned policy manifest: stable
   capabilities, policy version, environment, tool requirements, grant
   ownership, expiry, and revocation source.
4. Extend tool metadata/policy to model all-of capability requirements and
   reject missing/unknown/conflicting definitions. Preserve risk categories
   as a separate axis.
5. Implement a validated grant provider with deny-all defaults, explicit
   diagnostics, current policy revisions, and per-dispatch revocation/expiry
   checks. Do not grant to an unverified sender.
6. Construct trusted context only inside the application composition
   boundary from verified private incoming event and session evidence.
7. Filter model-visible declarations to currently eligible registered tools,
   but keep executor-side final checks and generic denial responses.
8. Keep `action` and `approval_required` tools disabled until their own
   authorization and approval designs are reviewed.
9. Add focused tests for each threat scenario, including missing/malformed
   configuration, all-of requirements, context provenance, stale/revoked
   grant, exception failure, declaration filtering, and handler isolation.
10. Only after separate security review and user authorization should a
    private text-only pilot be integrated. Preserve all legacy routes and
    make no production grants by default.

## 14. Final readiness verdict

## CONDITIONALLY READY

The existing registry, executor, authorization policy, and trusted runtime
projection provide useful isolated foundations for an application-controlled
design. The permission boundary still has important gaps for a future
capability system: tool declarations are currently not context-filtered,
multi-capability requirements are not modeled as all-of, grants have no
expiry/revocation lifecycle, and the runtime is not composed with the policy.
Most importantly, the verified private WhatsApp identity prerequisite is
still unavailable.

The design can proceed as an isolated future implementation only after those
dependencies are addressed. This verdict does not approve any production
authorization, identity-derived grant, tool registration, or execution.
Production tool execution remains disabled.
