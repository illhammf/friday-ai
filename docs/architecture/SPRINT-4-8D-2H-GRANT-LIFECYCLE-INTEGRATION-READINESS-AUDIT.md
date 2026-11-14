# Sprint 4.8D.2H — Grant Lifecycle Integration Readiness Audit

## 1. Executive summary

This was a read-only audit of the actual tool authorization path, its adapters,
and the current WhatsApp runtime.

The isolated pipeline has meaningful safeguards: the registry freezes tool
metadata, declarations expose only public schema fields, the Gemini adapter
disables SDK automatic function execution, the orchestrator validates and
bounds calls, and the executor checks permissions and current grant state
before invoking a handler. Grant expiry, revocation, and policy revision
changes are re-evaluated at dispatch.

These are not production integration guarantees. `friday-runtime.js` does not
construct or call the tool assistant, grant lifecycle, trusted-context
projector, or tool executor. The production message service still calls the
legacy `askFriday()` implementation. WhatsApp identity is not validated to a
supported canonical contract; the adapter classifies every non-group
`from` value as private and falls back from a missing group `author` to the
group chat ID. The principal resolver is an injected no-argument dependency,
not a verified mapping from the incoming event to an identity.

**Overall verdict: NOT READY for runtime integration or a private text-only
pilot.** The isolated architecture is sufficiently developed to inform a
separately gated integration design, but identity provenance and the
runtime-owned boundary must be established first. Production authorization
and production tool execution remain **NOT READY**.

## 2. Audit scope and constraints

This report is based on static inspection of source, tests, package scripts,
and architecture reports. No tests were run for this read-only audit. Test
names cited below are existing evidence, not a claim that the tests were
executed during this audit. No application behavior was changed.

The worktree was clean before inspection. The only expected addition is this
report. No source, test, package, lock, runtime, adapter, or database file was
modified.

## 3. Source files and evidence inspected

### Authorization and tool flow

- `src/ai/tools/tool-registry.js`
- `src/ai/tools/tool-validator.js`
- `src/ai/tools/tool-permission-policy.js`
- `src/ai/tools/tool-executor.js`
- `src/ai/tool-orchestrator.js`
- `src/ai/gemini-tool-adapter.js`
- `src/ai/assistant-request.js`
- `src/application/tool-grant-lifecycle.js`
- `src/application/tool-authorization-policy.js`
- `src/application/trusted-runtime-context.js`
- `src/application/tool-assistant.js`
- `src/application/tool-provider-policy.js`

### Production composition and compatibility

- `src/friday-runtime.js`
- `src/application/message-service.js`
- `src/application/application-lifecycle.js`
- `src/whatsapp/message-adapter.js`
- `src/whatsapp/message-queue.js`
- `src/database/history.js`
- `src/database/sqlite.js`
- `package.json`

### Relevant tests and architecture reports

- `test/ai-tools.test.js`
- `test/tool-orchestrator.test.js`
- `test/tool-grant-lifecycle.test.js`
- `test/gemini-tool-adapter.test.js`
- `test/tool-pipeline.test.js`
- `test/application-tool-assistant.test.js`
- `test/tool-provider-policy.test.js`
- `test/tool-authorization-policy.test.js`
- `test/trusted-runtime-context.test.js`
- `test/message-adapter.test.js`
- `test/message-service.test.js`
- `docs/architecture/SPRINT-4-8D-2A-PRODUCTION-IDENTITY-VALIDATION-AUDIT.md`
- `docs/architecture/SPRINT-4-8D-2B-WHATSAPP-IDENTITY-CONTRACT-INVESTIGATION.md`
- `docs/architecture/SPRINT-4-8D-2C-MESSAGE-CLASSIFICATION-IDENTITY-BOUNDARY-DESIGN.md`
- `docs/architecture/SPRINT-4-8D-2D-IDENTITY-VALIDATION-EVIDENCE-AND-STRATEGY.md`
- `docs/architecture/SPRINT-4-8D-2E-TOOL-CAPABILITY-AUTHORIZATION-DESIGN.md`
- `docs/architecture/SPRINT-4-8D-2F-CAPABILITY-REQUIREMENTS-AND-DECLARATION-FILTERING.md`
- `docs/architecture/SPRINT-4-8D-2G-GRANT-LIFECYCLE-AND-REVOCATION.md`

The prompt mentions `src/ai/tool-provider-policy.js`; the checked-out
implementation is `src/application/tool-provider-policy.js`.

## 4. Complete authorization flow and runtime connection

### Isolated tool path

1. `createToolRegistry()` requires a valid name, object schema, category,
   handler, and non-empty unique required-capability list. It freezes
   authorization metadata. Public declarations contain only name,
   description, and schema.
2. `createToolAuthorizationPolicy()` validates normalized private context,
   validates sender and session through injected functions, obtains a
   principal from injected `getTrustedPrincipalId()`, and creates the
   executor context. Eligible tools require all their declared capabilities.
3. `createToolGrantLifecycle()` checks a provider-returned grant, one injected
   timestamp, and the current policy revision. Expiry is inclusive at the
   boundary (`expiresAt <= evaluatedAt` denies).
4. `createToolOrchestrator()` computes declarations once per `run()`. It
   restricts candidates using the trusted `authorizedTools` and capability
   snapshot, then calls `executor.isAuthorized()` for a current grant check.
5. `createGeminiToolGenerator()` maps those declarations into Gemini
   `functionDeclarations`, sets function calling to `AUTO`, and sets
   `automaticFunctionCalling.disable` to `true`. Calls are returned to Friday;
   the adapter does not invoke handlers.
6. The orchestrator validates call shape, IDs, JSON arguments, registry
   membership, authorization-at-declaration, round/call limits, and response
   history. It processes calls sequentially.
7. `createToolExecutor()` validates arguments, snapshots trusted context,
   checks read-only category, snapshot tool/capabilities, and re-evaluates
   current grant state immediately before invoking the registered handler.
   It strips grant/principal/scope fields from handler context.
8. The orchestrator records per-call progress and builds retry-safety state.
   `createToolAssistant()` preserves progress, function responses, and
   provider-failure metadata.

This path exists as injected modules and tests. No production composition
connects these steps to WhatsApp.

### Current production path

`src/friday-runtime.js` imports and composes the legacy assistant, message
queue, and `createMessageService()`. Its assistant dependency calls
`askFriday()`; that function calls the existing Gemini generation/fallback
path. The runtime has no construction of the tool registry, executor,
orchestrator, grant lifecycle, trusted runtime projector, or tool assistant.
The current image, voice, sticker, video, memory, queue, history, and reply
routes remain separate.

## 5. Findings by audit area

### A. Registry and metadata — isolated safeguards confirmed

- Registration rejects malformed schemas/categories/capabilities and
  duplicate tool names.
- Required capabilities and nested schemas are copied/frozen.
- Public model declarations do not include handler, category, or permission
  metadata.
- Unknown capability requirements fail authorization-policy construction.
- The executor rejects `action` and `approval_required`; only `read_only` is
  executable.
- The registry alone does not make a tool invocable: current snapshot
  eligibility, live grant eligibility, argument validation, and executor
  permission checks also apply.

Evidence: registry and permission-policy implementations; tests
`registry registers valid definitions and exposes only immutable public data`,
`registry freezes application-owned capability requirements separately from
declarations`, and `refuses to configure grants for action-category tools`.

### B. Capability authorization — restrictive snapshot plus live grant

`hasRequiredCapabilities()` enforces all-of semantics and rejects malformed or
duplicate snapshot capability values. `authorizedTools` and
`grantedCapabilities` are necessary snapshot checks at declaration and
executor time, but they are not sufficient: executor authorization also
requires the injected current grant lifecycle to return `authorized: true`.
Thus these snapshots can restrict an invocation; they cannot alone authorize
the handler.

The policy accepts only a fixed set of runtime-context keys and gets its
principal from application-owned injection rather than a runtime field. The
principal resolver has no event argument, however, so this API does not prove
that a returned principal is bound to the current sender or session.

Evidence: `tool-permission-policy.js`,
`tool-authorization-policy.js`, `trusted-runtime-context.js`, and tests
`grants tools only when all registered requirements are in trusted capability
context`, `model-like input cannot inject tool grants or identity fields`, and
`executor enforces every registered capability requirement at dispatch`.

### C. Grant lifecycle — live recheck confirmed, consistency limits remain

- Grant records must have only expected data fields and valid status, revocation
  flag, capability set, expiration, and revisions.
- Requested scope and principal must match the record.
- Every registered required capability must be present.
- Expiration uses `expiresAt <= evaluatedAt`.
- The clock is read once per lifecycle evaluation.
- Provider, revision, or clock exceptions and malformed values deny.
- The orchestrator checks lifecycle state when filtering declarations; the
  executor checks it again immediately before handler invocation.
- A revocation after declaration filtering denies before `onStarted` and
  before handler invocation, as do an expiry or policy-revision change.
- A handler already running is not cancelled by revocation.

The lifecycle provider is injected and has no persistence or consistency
protocol. A grant/policy update can race after the final check; the design
does not provide an atomic transaction spanning authorization and handler
start. Failures are reduced to a boolean at executor boundary; this protects
details but currently offers no safe operational audit event from that
boundary.

Evidence: `tool-grant-lifecycle.js`, `tool-executor.js`, and
`tool-grant-lifecycle.test.js` tests `revocation after declaration filtering
denies dispatch before the handler starts`, `expiry and policy revision
changes after declaration filtering deny dispatch`, and `revocation does not
cancel an already-running handler`.

### D. Trusted identity — production blocker remains

`normalizeWhatsAppMessage()` classifies `from.endsWith('@g.us')` as group and
every other non-empty `from` value as private. It sets group sender to
`message.author || message.from`, so missing group author falls back to the
group chat ID. It does not preserve `fromMe` in normalized context.
`isQueueableMessage()` rejects truthy `fromMe` before normalization, but
classification and identity provenance are not validated there.

The private-session resolver uses the supplied sender string, and the policy
requires injected sender validation. The installed WhatsApp package evidence
documented in Sprint 4.8D.2D does not establish an exhaustive accepted format
or stable LID/phone canonicalization contract. Test validators are fakes;
they are not production evidence.

`getTrustedPrincipalId()` receives no sender/session input. An injected
resolver can therefore supply a fixture or fixed principal, but the code does
not demonstrate a verified per-event identity binding. A grant scope based on
the unverified session ID does not repair the missing identity provenance.

Evidence: `message-adapter.js`, `message-queue.js`,
`tool-authorization-policy.js`, `trusted-runtime-context.js`, and the 2A–2D
identity reports.

### E. Gemini adapter and orchestrator — manual dispatch safeguards confirmed

- The adapter validates declaration shapes and sizes, response/function-call
  shapes, arguments, call IDs, and function-response reconstruction.
- It disables SDK automatic function execution; model calls return through
  the orchestrator.
- The orchestrator validates plain-data calls, unique IDs across the request,
  registry membership, and authorization membership. Unknown tools are
  rejected without executor dispatch.
- Limits are at most 2 rounds, 3 calls per round, 6 calls total, and 64 KiB
  accumulated function-response history. Calls are executed sequentially.
- Partial results are retained on later failures.

Declarations are computed once at the beginning of `run()`, not refreshed
between Gemini rounds. This can leave stale declarations visible to Gemini
within that request; every dispatch still passes the executor's live
authorization check.

Evidence: `gemini-tool-adapter.js`, `tool-orchestrator.js`, and tests
`prevents SDK automatic function execution`, `rejects repeated provider call
IDs across rounds without executing it twice`, `enforces round, per-round, and
total call limits before execution`, and `reconstructs function history in
round order`.

### F. Executor boundary — final gate precedes handler

The executor rejects unregistered tools, validates arguments against the
registered schema and byte limit, snapshots trusted context, enforces
read-only category and snapshot permission, then queries the lifecycle
evaluator. The live authorization result is awaited before `onStarted` and
before the handler call. Grant, principal, and scope fields are omitted from
handler context; the handler receives a frozen context with an `AbortSignal`.
Output is JSON-serialized and bounded.

Timeout aborts the signal and reports an unknown outcome, but cannot ensure
the handler stops if it ignores the signal. Handler exceptions are normalized
without exposing internals.

Evidence: `tool-executor.js`; tests `executor denies unauthorized tools
without invoking handlers`, `executor reports timeout without claiming to
cancel a running handler`, and lifecycle dispatch-denial tests.

### G. Retry and provider fallback — guarded decision API, not automatic

The application provider policy accepts only typed, retryable provider
generation failures from the currently selected model, validates request
state and execution progress, imposes an attempt budget, and denies switching
after a failed tool call, handler start, success, or uncertain outcome.
`tool-assistant.js` preserves progress and failure metadata.

The provider policy is decision-only; the caller must explicitly assess and
select another provider. There is no automatic integration of that policy in
`createToolAssistant()` or the production runtime. Existing legacy
`generateWithModelFallback()` in `friday-runtime.js` has different behavior
and is outside this tool pipeline. Neither policy provides exactly-once
execution; uncertain outcomes remain non-retryable by the isolated policy.

Evidence: `application/tool-provider-policy.js`,
`application/tool-assistant.js`, and tests `does not trust safeToRetry alone or
provider-like message text`, `denies switching after timeout or any unknown
execution outcome`, `preserves provider cause, status/code, model identity,
and progress through the pipeline`, and
`does not retry or fall back when provider generation fails before tool
execution`.

### H. Assistant composition — module boundary works, runtime caller absent

`createToolAssistant()` injects a registry/executor/generator/context factory,
checks the executor-registry binding, rejects group contexts, validates the
request DTO, and preserves structured progress and responses. It treats the
trusted-context factory as an application authority; the wrapper cannot
itself attest that an arbitrary caller supplied genuine adapter context.

Tests exercise the isolated assistant with fake context factories. The
production runtime does not instantiate it.

### I. Runtime compatibility — existing routes remain outside tool path

The current message service keeps memory commands private-only, handles
video-download requests, image generation, stickers, image descriptions, and
voice-note transcription through separate injected services, then invokes
the legacy assistant. It has per-session processing locks and relies on the
WhatsApp queue/deduplicator. No tool route is present.

The current service derives `isGroup` from normalized `chatType`, but the
adapter's broad non-group-to-private mapping means unknown WhatsApp categories
are not preserved as unknown. The service uses the sender's private session
for its active-session lock even for group processing; this is existing
behavior and was not changed or validated for a new tool route.

Do not route image, audio, sticker, group, video, memory, or image-generation
events into tool execution as part of a first integration.

## 6. Cross-module security scenario matrix

“Handler can run” describes the audited isolated pipeline if a caller supplies
the stated context; it does not imply a production runtime connection.

| # | Scenario / entry point | Expected and actual behavior evidenced by source | Handler can run? | Limitation / evidence |
|---|---|---|---|---|
| 1 | Valid private context and valid grant; policy → orchestrator → executor | Snapshot and current grant checks pass; registered read-only handler is dispatched. | Yes, in isolated pipeline. | Test fakes establish mechanics only: `tool-grant-lifecycle.test.js`, `tool-authorization-policy.test.js`. |
| 2 | Missing principal; lifecycle/executor | Lifecycle rejects an empty/missing principal before provider lookup; executor denies. | No. | Production resolver is not wired or verified: `tool-grant-lifecycle.js`. |
| 3 | Unverified principal; policy/runtime boundary | No production identity validator exists; policy trusts injected resolver and injected sender validator. | Not safely established. | Resolver is not event-bound; 2A–2D identity reports. |
| 4 | Group conversation; projector/assistant | Authorization policy denies group; assistant also rejects group before orchestration. | No through those isolated boundaries. | WhatsApp normalization can substitute group ID for missing author: `message-adapter.js`. |
| 5 | Unknown conversation type; adapter/projector | Projector/policy deny unknown types, but WhatsApp adapter reduces non-`@g.us` IDs to private. | No if unknown reaches policy; potentially misclassified upstream. | No exhaustive adapter category detection. |
| 6 | Grant revoked after declarations; executor dispatch | Current grant check denies before handler start. | No. | Verified by `revocation after declaration filtering denies dispatch before the handler starts`. |
| 7 | Grant expires after declarations; executor dispatch | Current timestamp is evaluated again; equality is expired. | No. | Verified by lifecycle boundary and expiry-after-filter tests. |
| 8 | Policy revision changes before dispatch | Current revision mismatch denies dispatch. | No. | Verified by `expiry and policy revision changes after declaration filtering deny dispatch`. |
| 9 | Required capability missing; policy/executor | All-of mismatch excludes the declaration and/or executor denies. | No. | Capability and lifecycle tests; snapshot is also restrictive. |
| 10 | Model spoofs principal/capabilities; Gemini call → orchestrator | Arguments are not passed to authorization. Runtime policy rejects a `principalId` context field; executor uses context principal/scope and registered requirements. | Only if application context itself is trusted and valid. | A caller able to forge trusted context is outside the module's attestation; isolated spoof test uses fakes. |
| 11 | Unknown tool name; orchestrator | Registry membership check returns `TOOL_NOT_FOUND`; executor is not called. | No. | `never invokes the executor for an unregistered tool`. |
| 12 | Malformed function arguments; orchestrator/executor | Adapter/orchestrator reject malformed JSON; executor validates schema before authorization/dispatch. | No. | Gemini and orchestrator argument tests. |
| 13 | Duplicate function-call ID; adapter/orchestrator | Adapter rejects duplicate IDs within one response; orchestrator tracks IDs across rounds. | No for malformed batch/repeated ID. | Tests in `gemini-tool-adapter.test.js` and `tool-orchestrator.test.js`. |
| 14 | Provider failure before handler; assistant/provider policy | Progress says no execution; typed retryable provider failures may be eligible for an explicit bounded switch. | No handler has run. | Policy decision does not itself execute a retry; caller composes it. |
| 15 | Provider failure after handler; orchestrator/provider policy | Partial result and started progress are preserved; provider switching is denied. | Handler already ran once. | No exactly-once guarantee; decision-only policy. |
| 16 | Handler timeout; executor/orchestrator | Signal is aborted, outcome is recorded unknown, and retry is denied. | Yes, handler started; completion uncertain. | Handler may ignore signal and continue. |
| 17 | Grant provider unavailable; lifecycle/executor | Lifecycle returns unavailable denial; declarations are omitted and executor denies. | No. | Denial is booleanized at executor; no safe operational audit event currently emitted. |
| 18 | Clock unavailable/invalid; lifecycle | Evaluation fails closed. | No. | Tests cover throws and invalid timestamp. |
| 19 | Authorization context from untrusted caller; assistant boundary | Assistant delegates trust to injected context factory; its direct API does not establish provenance itself. Executor rejects malformed shapes, not a forged but well-formed trusted context. | Potentially, if the application improperly trusts caller input. | Production trusted-context factory is absent; this is a runtime integration blocker. |
| 20 | `approval_required` category; registry/executor | Application policy disallows non-read-only allowlist entries; executor rejects non-read-only categories. | No. | No approval flow is implemented; `refuses to configure grants for action-category tools`. |

## 7. Confirmed strengths

- Authorization layers are independently enforced: declaration visibility
  does not replace executor checks.
- Live grant state is queried both before declaration and immediately before
  handler dispatch.
- Expiry, revocation, stale policy revision, malformed grant data, provider
  failure, and clock failure fail closed.
- Model arguments cannot extend tool registry, required capabilities,
  principal, or grant scope.
- Gemini automatic function execution is disabled; the tool handler is only
  invoked through the orchestrator/executor path.
- Call arguments, schemas, outputs, call history, rounds, and retry state have
  explicit validation or limits.
- Tool calls execute sequentially, and uncertain/started work prevents
  provider switching in the isolated provider policy.
- Current production flow still uses the legacy assistant; no tool execution
  was enabled by these modules.

## 8. Security gaps and unresolved risks

1. **No production identity proof.** WhatsApp sender strings are not validated
   or canonicalized under a supported exhaustive contract. `from`/`author`
   fallback and non-group-to-private classification are unsuitable as
   privileged identity rules.
2. **No runtime-owned trusted event boundary.** The tool assistant trusts its
   injected context factory. No production factory ties a normalized raw
   WhatsApp event to a verified principal and session.
3. **Principal is injectable but not event-bound.**
   `getTrustedPrincipalId()` takes no arguments. A test/fixed principal is
   useful for isolated mechanics but is not evidence of per-sender provenance.
4. **No persistent grant authority.** Grant provider state is injected only;
   there is no persistence, administrative grant lifecycle, audit trail, or
   demonstrated cross-process revocation consistency.
5. **Authorization-to-handler race remains.** The last check is immediately
   before handler call, but grant state can change after the check. No atomic
   transaction spans the provider and handler.
6. **Denied provider failures lack operational diagnostics.** The lifecycle
   returns a generic denial and executor reduces it to `false`; an integration
   needs a non-sensitive audit/diagnostic channel without exposing grant data
   to Gemini or WhatsApp responses.
7. **Retry policy is opt-in.** The tool provider policy requires a caller to
   assess and select the next provider. It is not automatically composed with
   the assistant or production runtime.
8. **Declaration freshness is not continuous.** Declarations are filtered
   once per orchestration run. Stale names can remain model-visible in later
   rounds, though executor revalidation prevents stale authorization from
   reaching a handler.
9. **Timeout is not cancellation.** A handler that ignores `AbortSignal` may
   continue after an uncertain timeout.

## 9. Runtime compatibility findings

No runtime integration exists to audit as a connected tool path:

- `friday-runtime.js` composes `createMessageService()` with the legacy
  `askFriday()` assistant and existing media/video/memory services.
- `message-service.js` routes memory, video, sticker, image generation, image
  understanding, and voice transcription before or around that legacy
  assistant. These paths must remain unchanged in a future pilot.
- The WhatsApp queue filters self-authored messages and deduplicates events;
  message normalization then drops `fromMe` and uses fallback identity
  behavior unsuitable for authorization.
- Existing private/group history and memory sessions are separate concerns
  from verified authorization scope; they must not be treated as proof of
  identity.
- `application-lifecycle.js` owns startup/shutdown resources, not tool
  authorization or grants.

Do not change existing private text, group prefix, image, voice, sticker,
video, image-generation, queue, deduplication, history, memory, or error
behavior while preparing the integration.

## 10. Readiness verdicts

| Category | Verdict | Basis |
|---|---|---|
| Isolated tool infrastructure | CONDITIONALLY READY | Direct registry/orchestrator/executor implementation and broad fake-based tests exist; caller context provenance is assumed, not attested. |
| Grant lifecycle | CONDITIONALLY READY | Expiry, revocation, revision, provider/clock failure, and dispatch revalidation exist; no persistent source, atomicity, or operational audit channel. |
| Trusted identity | NOT READY | Production WhatsApp format/canonical identity contract remains unavailable; adapter classification/fallback is not suitable for privileged authorization. |
| Runtime composition | NOT READY | Tool assistant and grant lifecycle are not composed into `friday-runtime.js` or `message-service.js`. |
| Retry and failure handling | CONDITIONALLY READY | Progress-aware bounded policy is implemented and tested, but explicit caller integration is required and outcomes are not exactly-once. |
| Private text-only pilot | NOT READY | No runtime integration or verified private principal/session boundary. |
| Group and media integration | NOT READY | Group tools are denied; media paths remain legacy and must not be routed into tools without separate review. |
| Production tool execution | NOT READY | No production identity validation, grants, tool registration, or runtime path. |

## 11. Recommended staged integration plan

These stages are recommendations only; none is implemented by this audit.

| Stage | Dependencies and blockers | Likely files | Security gate and regression risk |
|---|---|---|---|
| 1. Runtime-owned trusted event boundary | Define accepted incoming event shapes and retain message direction/type without identity inference. | `src/whatsapp/message-adapter.js`, a new application boundary module, boundary tests. | Reject self-authored, group, broadcast/status, unsupported, or ambiguous events for privileged flow. Preserve current legacy normalization behavior or isolate new adapter contract. |
| 2. Verified private principal and scope | Obtain authoritative supported WhatsApp identity/canonicalization evidence; define unavailable/ambiguous results. | New identity-validation module; `src/application/trusted-runtime-context.js`; session resolver tests. | Do not accept phone/display/chat/model strings as a principal; fail closed. Do not reuse session IDs as identity proof. |
| 3. Explicit application-owned grant source | Define who administers grants, capability vocabulary, revocation consistency, policy revision lifecycle, and safe diagnostics. | New grant provider module; `src/application/tool-grant-lifecycle.js`; later persistence only in a separately approved sprint. | No message/model grant mutation; no defaults that create grants; define provider outage and audit behavior. |
| 4. Private text-only assistant composition | Wire tool assistant only after the first three gates; preserve legacy routing and keep a separate allowlisted text-only entry point. | `src/friday-runtime.js`, `src/application/message-service.js`, composition tests. | No group/media access; no production tool registration until reviewed. Regression tests must prove existing image, voice, sticker, video, memory, queue, and fallback routes remain unchanged. |
| 5. State-aware retry/failure integration | Decide how the caller selects providers and carries progress across an explicit retry. | `src/application/tool-provider-policy.js`, `src/application/tool-assistant.js`, composition layer. | Prove no retry after dispatch, success, or unknown outcome; handle partial results without replay. |
| 6. Runtime-level fake integration tests | Requires runtime composition behind injected fakes. | New runtime/message-service integration tests, existing adapter/queue tests. | Exercise trusted raw-event to handler denial/dispatch without WhatsApp, Gemini, external services, or real grants. Cover all scenario rows above. |
| 7. Live Gemini compatibility review | Requires isolated runtime-level fake tests to pass first. | `src/ai/gemini-tool-adapter.js`, focused adapter tests, review documentation. | Confirm SDK request/response semantics, auto-call disable behavior, and error mapping for the pinned SDK version. |
| 8. Controlled pilot readiness review | Requires identity, grant source, runtime tests, operations, and rollback plan. | Separate approval/report; no implied source changes. | Separate security review and explicit authorization; keep group/media disabled. A pilot is not production readiness. |

## 12. Explicit production status

Production WhatsApp identity validation is unavailable. The production runtime
does not create the isolated tool pipeline. There are no production grants or
grant persistence. **Production authorization and production tool execution
remain NOT READY and disabled.** The isolated tests and this audit do not
establish production readiness.

## 13. Files changed

Only this audit report was added:

- `docs/architecture/SPRINT-4-8D-2H-GRANT-LIFECYCLE-INTEGRATION-READINESS-AUDIT.md`

## 14. Evidence and limitations

Implementation statements above refer to the current checked-out source;
scenario test names refer to existing test files. The audit did not execute
tests, connect to WhatsApp, make Gemini requests, or validate any real
identity. Runtime behavior conclusions are based on static composition and
call-site inspection. No finding should be interpreted as a guarantee against
all races or as approval to enable production tools.
