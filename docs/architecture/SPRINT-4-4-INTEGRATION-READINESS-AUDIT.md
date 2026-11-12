# Sprint 4.4 — Tool Calling Integration Readiness Audit

## Executive Summary

**Status: not ready for runtime integration.** The Sprint 4.1 registry,
validator, permission policy, and executor form a useful isolated foundation.
The Sprint 4.2 orchestrator and Sprint 4.3 Gemini adapter can interoperate for
bounded text-only inputs and valid tool-call history. They are not yet a
drop-in replacement for the existing `askFriday()` generation path.

The main blockers are:

1. The runtime's assistant input and Gemini content history do not match the
   adapter's accepted text-only input contract. In particular, current image
   requests carry inline image data and history uses Gemini-style `parts`.
2. The adapter normalizes provider errors and the orchestrator then normalizes
   them again. Existing retry/model-fallback logic cannot inspect the original
   status, and a caller cannot distinguish a failure before any tool execution
   from one after tools have executed.

No live Gemini or WhatsApp integrations were started. The existing model
fallback, retry, and message-delivery behavior was not changed. This audit
created only this report.

## Audited Modules

- [`tool-registry.js`](../../src/ai/tools/tool-registry.js): trusted
  registration, duplicate rejection, public declaration projection.
- [`tool-validator.js`](../../src/ai/tools/tool-validator.js): supported
  schema subset and bounded JSON argument validation.
- [`tool-permission-policy.js`](../../src/ai/tools/tool-permission-policy.js):
  read-only authorization and denial of action categories.
- [`tool-executor.js`](../../src/ai/tools/tool-executor.js): registered handler
  invocation, permission enforcement, timeout and output limits.
- [`tool-orchestrator.js`](../../src/ai/tool-orchestrator.js): call validation,
  limits, executor dispatch, and accumulated function responses.
- [`gemini-tool-adapter.js`](../../src/ai/gemini-tool-adapter.js): Gemini SDK
  request/response translation.
- [`gemini.js`](../../src/ai/gemini.js), [`model-fallback.js`](../../src/ai/model-fallback.js),
  [`friday-runtime.js`](../../src/friday-runtime.js), and
  [`message-service.js`](../../src/application/message-service.js): current
  provider and application flow.
- [`ai-tools.test.js`](../../test/ai-tools.test.js),
  [`tool-orchestrator.test.js`](../../test/tool-orchestrator.test.js),
  [`gemini-tool-adapter.test.js`](../../test/gemini-tool-adapter.test.js),
  [`model-fallback.test.js`](../../test/model-fallback.test.js),
  and relevant image, voice, and message-service tests.
- Sprint 4.0–4.3 architecture reports.

The installed `@google/genai` version is **2.30.0**. Its checked-in Node
declarations define `GenerateContentParameters` (`model`, `contents`, `config`),
`FunctionDeclaration.parametersJsonSchema`, `FunctionCall` (`id?`, `name?`,
`args?`), `FunctionResponse` (`id?`, `name?`, `response?`),
`Part.functionCall` / `Part.functionResponse`, and
`AutomaticFunctionCallingConfig.disable`. The adapter uses those interfaces
and sets `automaticFunctionCalling: { disable: true }`. Compatibility has been
verified against local declarations and fake-client request shapes, not a live
provider request.

## Contract Compatibility Matrix

| Boundary | Actual contract | Finding |
|---|---|---|
| Registry → adapter | `getPublicDeclarations()` returns `name`, `description`, `parametersJsonSchema`; adapter accepts exactly these fields and revalidates the supported schema. | **Compatible.** Registry handler and category are not projected. See `createToolRegistry()` / `getPublicDeclarations()` and `getToolDeclarations()`. |
| Executor → orchestrator | Executor exposes `execute(name, args, trustedContext)`; orchestrator calls it with the same arguments. | **Interface compatible.** Dependency pairing is not enforced; composition must use an executor constructed with the same registry. |
| Orchestrator → generator | Orchestrator sends `{ input, tools, functionResponses }`; adapter returns `{ text }` or `{ functionCalls: [{ id, name, arguments }] }`. | **Compatible at the outer shape.** Adapter's accepted `input` is narrower than the runtime's actual request/history format; see blocker B1. |
| Function response records | Orchestrator now appends `round`, `call: { id, name, arguments }`, `id`, `name`, and either `result` or `error`. Adapter requires the metadata to rebuild SDK history. | **Compatible for the current orchestrator.** `round` and `call` are additive fields, so consumers ignoring extra fields remain compatible. Exact-shape consumers and consumers expecting only the former `{id,name,result/error}` shape may not. |
| Model declarations → Gemini | Adapter maps to `{ functionDeclarations: [{ name, description, parametersJsonSchema }] }`, with `AUTO` calling mode and automatic execution disabled. | **Locally type-compatible.** The subset uses lowercase JSON Schema types; no live API/model compatibility test exists. |
| Gemini response → orchestrator | Adapter maps text or function calls and returns plain application data. | **Compatible for valid text/tool-call responses.** SDK call IDs are optional; adapter synthesizes an ID when absent, then uses it in later history. This behavior is test-covered locally but not provider-validated. |

`round` is one-based and is set by the orchestrator immediately before
dispatching each tool-call batch. `call` preserves the bounded normalized call
arguments, which the adapter needs to echo the model function-call content.
The history test asserts round role order; the successful orchestrator test
asserts the first record's `round` and `call`. The tests do not form a complete
end-to-end assertion of the real adapter + orchestrator + executor chain.

## Findings and Severity

### BLOCKER — Runtime input/history is incompatible with the text-only adapter

[`createGeminiToolGenerator()`](../../src/ai/gemini-tool-adapter.js#L522)
accepts a string or an array of `{ role: 'user' | 'assistant', text }`
messages in `mapInputToContents()`. In contrast,
[`message-service.handle()`](../../src/application/message-service.js#L405)
calls the assistant with `{ question, privateSession, sharedGroupSession,
senderName, image }`. [`askFriday()`](../../src/friday-runtime.js#L231) then
loads history as Gemini-shaped records and constructs the current request.

[`loadHistory()`](../../src/database/sqlite.js#L120) returns
`{ role, parts: [{ text }] }`; stored assistant turns use role `model`
([`askFriday()`](../../src/friday-runtime.js#L335)). The adapter rejects
history records with `parts`, and it only accepts roles `user` and `assistant`.
Current image handling adds `inlineData: { mimeType, data }` to a user part
([`askFriday()`](../../src/friday-runtime.js#L262)); the adapter has no image
part mapping and rejects that request shape. It also cannot accept the runtime
request object directly.

The current runtime builds `systemInstruction` from base instructions,
conversation style, and memory on each request
([`askFriday()`](../../src/friday-runtime.js#L279)). The adapter captures
`config` when the generator is constructed, so a long-lived generator would
not naturally receive per-request system instructions.

**Impact:** Wiring the adapter directly into `assistant.ask` would reject
existing requests or lose history/image/prompt behavior. Do not integrate it as
a drop-in generator.

**Required before integration:** Define a provider-independent per-request
input that preserves history roles and content parts (including image data),
and dynamic prompt/config values. Add contract tests using the actual
`askFriday()` input shape and current history records.

### BLOCKER — Retry/fallback cannot safely distinguish pre-tool and post-tool failures

[`createGeminiToolGenerator()`](../../src/ai/gemini-tool-adapter.js#L557)
catches every injected SDK error and emits a new
`GeminiToolAdapterError('GEMINI_GENERATION_FAILED', 'Gemini generation failed.')`
([adapter error conversion](../../src/ai/gemini-tool-adapter.js#L583)).
[`createToolOrchestrator.run()`](../../src/ai/tool-orchestrator.js#L288)
then catches any generator exception and replaces it with
`GENERATOR_FAILED` and a generic message
([generator error normalization](../../src/ai/tool-orchestrator.js#L300)).
The original SDK status/code used by
[`isModelFallbackError()`](../../src/ai/model-fallback.js#L11) is therefore
unavailable. The adapter also does not invoke the runtime's
[`generateWithRetry()`](../../src/friday-runtime.js#L104).

The orchestrator throws the same `GENERATOR_FAILED` whether generation fails
before the first call or after one or more executor calls. It returns no
execution-progress metadata. An outer caller therefore cannot safely infer
that a whole-request retry or model fallback is still pre-execution. Existing
[`generateWithModelFallback()`](../../src/ai/model-fallback.js#L35) retries
model generation calls, but it does not understand orchestration progress.

**Impact:** A future wrapper that retries/falls back around the whole
orchestrator can rerun already-executed tools. Error normalization also
prevents the existing transient/quota fallback policy from working unchanged.

**Required before integration:** Select/fallback among models before any
tool-call batch is executed. Pin the selected model/provider for subsequent
rounds. Do not restart an orchestration after a tool call unless a future
idempotency mechanism and explicit progress state make that safe. Preserve a
sanitized retryable/non-retryable classification without exposing raw provider
errors.

### HIGH — Re-execution is not prevented across different IDs or orchestration requests

Within one `run()`, the orchestrator tracks `knownCallIds` and rejects a
repeated ID before dispatch
([`normalizeCalls()`](../../src/ai/tool-orchestrator.js#L105) and
[`run()`](../../src/ai/tool-orchestrator.js#L288)). This prevents a second call
with the same ID in that invocation. It does **not** deduplicate by tool name
and arguments: the same tool request with a new ID can execute again. Every new
`run()` creates a new set, so a caller retry can execute the same request
again. No idempotency key or cross-request execution ledger exists.

**Impact:** The current policy denies `action` and `approval_required` tools,
but even read-only calls can return changed data or perform side effects if a
handler is mislabeled. Future action tools must not rely on ID checks as
exactly-once execution.

**Required before integration:** Do not automatically retry the whole
orchestration. Before enabling action tools, add explicit idempotency/approval
semantics and a clear policy for repeated model calls with new IDs.

### MEDIUM — Adapter/executor registry pairing is a trusted composition invariant

`createToolOrchestrator()` independently accepts `registry` and `executor`.
It checks `registry.has(call.name)` before calling
`executor.execute(call.name, ...)`; it does not verify that the executor was
created with that same registry. The normal executor does its own lookup and
permission check ([`execute()`](../../src/ai/tools/tool-executor.js#L132)), so
this is not a model-controlled bypass by itself. A mismatched or custom
executor at composition time can nevertheless make registry declarations and
actual execution target different contracts.

**Required before integration:** Construct registry, executor, orchestrator,
and adapter together in one trusted composition root; pass only the canonical
executor and registry. Keep executor authorization enabled and do not expose
dependency construction to model-controlled code.

### MEDIUM — Aggregate request size is not capped as one unit

The executor caps each argument object at 4 KiB and each result at 8 KiB.
The orchestrator allows at most six calls and accumulates every result. The
adapter also enforces six response records, 4 KiB per recorded argument, 8 KiB
per successful result, and 64 KiB of declarations. This bounds tool history by
call count and per-item caps, but there is no explicit combined byte limit for
the entire accumulated function history/request. More importantly,
`mapInputToContents()` imposes no total message-count or input-byte cap.

**Impact:** The maximum tool history can still be on the order of 72 KiB for
arguments and successful results before metadata/serialization overhead, and
caller-supplied conversation input is unbounded by this adapter. Per-result
limits do not establish a total request/token budget.

**Required before integration:** Set an aggregate serialized-byte/token
budget for input, declarations, and all function history. Reject oversized
requests; do not truncate function-call history mid-round.

### MEDIUM — History validation cannot detect every externally truncated batch

The adapter checks each record's round, call metadata, matching ID/name,
unique IDs, response shape, contiguous round numbers, and maximum of three
records per round in `buildFunctionResponseContents()`. It does not carry an
expected call count or batch identifier for a round. If an external caller
omits one record from a previously multi-call round, the adapter cannot detect
that omission and will reconstruct a smaller, internally matched model/user
turn. The current orchestrator appends the whole round only after sequentially
processing its calls, so its normal output is complete; the gap is at the
adapter's independently callable input boundary.

There is no code that truncates the internal history. The adapter rejects more
than six records and rejects non-contiguous rounds rather than silently
truncating. No test currently simulates truncating one response from a
multi-call round.

**Required before integration:** Keep the function history private to the
orchestrator/adapter composition, or add per-round expected call-count/batch
metadata and test incomplete-history rejection.

### MEDIUM — Synthesized IDs are not distinguished from provider IDs

The installed SDK marks `FunctionCall.id` and `FunctionResponse.id` optional.
`normalizeFunctionCalls()` creates `gemini-call-N` when the provider omits an
ID, satisfying the orchestrator's required-ID contract. Later,
`buildFunctionResponseContents()` echoes that generated ID into both
`Part.functionCall` and `Part.functionResponse`; the response record has no
field identifying that the ID was synthesized. This preserves application
correlation, but its acceptance as a Gemini provider call ID has only been
tested with a fake client, not the live API.

**Required before integration:** Confirm the no-ID round trip against supported
Gemini models, or preserve provenance and omit the SDK ID fields when the
provider did not supply them while retaining an internal application ID.

### LOW — End-to-end compatibility coverage is incomplete

The 4.1 tests cover registry/validator/permission/executor behavior. The 4.2
tests cover the orchestrator with fake generators/executors. The 4.3 tests
cover adapter translation with fake SDK response objects. These are useful
unit tests, but no test composes the real registry, executor, orchestrator,
and Gemini adapter through multiple rounds. There is also no runtime input
adapter test, model-fallback integration test, or provider contract test.

**Required before integration:** Add a fake-SDK round-trip integration test
covering multiple calls/rounds, IDs, errors, history, aggregate limits, and
permission denial; separately test runtime DTO/history adaptation.

## Function Call History Integrity

### What is enforced

- `normalizeFunctionCalls()` preserves non-empty provider IDs; when absent it
  generates `gemini-call-N`. It rejects duplicate IDs inside one provider
  response and bounds each argument object to 4 KiB.
- The orchestrator tracks IDs across all rounds within one `run()` and rejects
  a repeated ID before executing that repeated batch. It does not persist IDs
  across independent calls to `run()`.
- `buildFunctionResponseContents()` validates that each response ID and name
  match the stored `call` record; IDs are unique across the supplied history.
- Calls and responses are translated into SDK `Content`: a `model` message
  containing `functionCall` parts followed by a `user` message containing
  corresponding `functionResponse` parts. Multiple calls in one round share
  those two messages; rounds are sorted and must be contiguous starting at 1.
- Successful results are JSON-cloned and capped at 8 KiB each. Errors are
  translated through a fixed allowlist, not forwarded as arbitrary exceptions.
- Orchestrator limits are two tool rounds, three calls per round, and six calls
  total. The adapter rejects histories over six records and does not silently
  truncate them.

### Gaps and truncation conclusion

There is no internal truncation path. A mid-round truncation supplied from
outside cannot be detected because records do not state the expected number of
calls in that round. Per-item and count caps bound the expected tool history
but do not establish an aggregate request budget; the input content is
unbounded. Generated IDs also lack provider-ID provenance. These cases should
be resolved or explicitly constrained before production integration.

## Permission and Execution Safety

- **Permissions from model arguments:** No. Gemini arguments are passed only
  as tool arguments. `authorizedTools` comes from `trustedContext`, and the
  executor snapshots it separately from handler context.
- **Unregistered names:** The orchestrator checks the canonical registry and
  returns a normalized `TOOL_NOT_FOUND` response without invoking the
  executor. The executor also performs registry lookup.
- **Action categories:** `assertToolPermission()` rejects every category other
  than explicitly authorized `read_only`; `action` and `approval_required`
  remain denied even if named in `authorizedTools`.
- **Session identity:** The adapter does not accept or return trusted context.
  The orchestrator receives it from the caller and passes it to the executor.
  There is no tool context in the runtime today; future session IDs must be
  derived in the application from the normalized message, not model input.
- **Only execution path:** The orchestrator calls the injected executor and
  never imports or invokes handlers directly. The trusted composition root must
  ensure the executor was constructed from the same registry whose
  declarations are given to Gemini.
- **Handler timeout:** Executor timeout signals cooperative abort but cannot
  forcibly stop synchronous or signal-ignoring handler work.
- **No current tools:** The registry has no production tool definitions wired
  in the runtime, so this audit identifies integration risks, not an active
  tool execution path.

The existing group/private memory boundary remains in `askFriday()`: group
requests use `sharedGroupSession` for history and an empty memory list; private
requests retrieve memories for `privateSession`. Any future memory tool needs
to receive that trusted, request-scoped boundary and must not expose private
memory to groups.

## Provider Failure and Duplicate Execution

| Situation | Actual behavior |
|---|---|
| Gemini fails before a function call is returned | Adapter normalizes the provider error; orchestrator wraps it as `GENERATOR_FAILED`. No executor call has occurred, but the caller does not receive a progress marker. |
| Gemini fails after a tool executed, on a later round | Same generic `GENERATOR_FAILED`; earlier execution is not rolled back. No retry occurs inside the orchestrator, but an external retry of `run()` starts from empty call-ID/history state. |
| Same call ID appears again later in one run | Rejected by the orchestrator's `knownCallIds` before that repeated call is executed. |
| Same name/arguments appear with a new ID | Executed again; there is no argument-based or idempotency deduplication. |
| Caller retries the whole orchestration | Nothing in the implementation prevents previously executed calls from running again. |
| Existing runtime retry/fallback used around adapter | Adapter removes the provider status; orchestrator removes adapter error code. Existing classifiers cannot make the prior decision from the surfaced error. |

**Recommended future policy:** Use the existing retry/fallback policy only before
any tool batch is executed, or introduce explicit execution-progress state and
idempotency before allowing retries after a tool. Pin the chosen provider/model
for all rounds once the first function call is accepted. Do not wrap an entire
orchestration in the current `generateWithModelFallback()`. Do not retry a
post-tool failure by restarting `run()`. Map only a sanitized provider
retryability/status category across the adapter boundary; never forward raw
SDK errors to users.

## Runtime Integration Recommendation

The existing entry point is the assistant call from
[`message-service.handle()`](../../src/application/message-service.js#L405).
`askFriday()` is currently the right composition boundary for AI request
details, but an integration should keep channel transport and delivery logic
out of the tools:

1. Construct one trusted registry and an executor bound to that registry.
   Construct the adapter/orchestrator in a controlled application composition
   path; no WhatsApp object should enter either tool module.
2. For each `askFriday()` call, derive active private/group session, history,
   memory context, and tool permission context from application state.
   Construct a request-scoped generator/config if necessary so the dynamic
   system instruction remains request-specific.
3. Preserve existing `history`, current user message, and image content as
   structured application input. Adapt database roles (`user`/`model`) and
   `parts` deliberately; do not simply pass the current database history to
   the adapter.
4. Keep memory text in the existing untrusted memory instruction. For a future
   memory tool, pass only an application-selected private session and deny
   group access; never accept a session ID from Gemini arguments.
5. Keep image generation and sticker routing in their current
   `message-service` branches, which run before `assistant.ask()`. Keep voice
   transcription before `askFriday()` and voice generation/delivery after the
   returned answer.
6. Preserve `askFriday()`'s plain-text answer contract, history persistence
   behavior, and `message-service` formatting/reply or voice-delivery paths.
   Tool-call intermediate messages should not be persisted as ordinary user or
   assistant turns unless a separate history design explicitly supports them.
7. Add failure semantics so partial tool execution is not mistaken for a
   pre-generation failure, and select/fallback model before execution only.

This is a design recommendation only; no runtime integration was performed.

## Multimodal Compatibility

### Current behavior

- Images are downloaded and validated by `message-service`; ordinary images
  reach `askFriday()` as `{ mimetype, data }`. `askFriday()` adds a Gemini
  `inlineData` part. The adapter currently only accepts text input.
- Sticker requests are handled and delivered before the assistant path.
- Image-generation requests are handled before `assistant.ask()` through the
  separate image service with `responseModalities: ['TEXT', 'IMAGE']`.
- Voice notes are transcribed before `assistant.ask()`; the transcript is
  appended to the text question. When requested, voice generation and
  WhatsApp voice delivery happen after the assistant answer.

### Requirements before participating in the current flow

The adapter/input contract would need safe support for existing content parts,
at minimum text and inline image data with MIME type, while remaining strictly
provider-independent above the adapter. It must preserve model/user roles,
dynamic system instructions, image size/MIME validation, and history ordering.
If future tool calls can occur on multimodal requests, every subsequent Gemini
round must include the same relevant image content and full compatible model /
function-response history. Voice can remain text-only at the current assistant
boundary if transcription continues before it and TTS continues after it.
Image generation and stickers should remain on their existing independent paths.

No current evidence shows the Sprint 4.3 adapter handles image, audio,
generated image output, or WhatsApp media. It should not replace those flows.

## Test and Verification Review

### Coverage observed

- Sprint 4.1 tests cover duplicate/invalid registration, supported schema
  validation, explicit read-only permission, denial, executor errors, bounds,
  and import safety.
- Sprint 4.2 tests cover normal text, tool execution, multiple calls/rounds,
  unknown tools, malformed calls, normalized errors, call/round caps, duplicate
  IDs within an invocation, and import safety.
- Sprint 4.3 tests cover declaration conversion, text/function-call mapping,
  missing-ID generation, function response formatting, history order,
  unsupported input/schema, provider error normalization, disabled automatic
  function execution, result bounds, and import safety.
- Existing model-fallback tests cover model ordering and recognized statuses,
  but not the adapter/orchestrator normalization boundary.
- Existing message-service tests cover image routing, voice transcription
  routing, and normal text delivery using fakes; they do not exercise the
  Gemini tool adapter.

### Actual commands

Executed with Node.js `v24.22.1`:

| Command | Result |
|---|---|
| `npm run check` | Passed. |
| `npm test` | **182 passed, 0 failed, 0 skipped.** |
| `git diff --check` | Passed. |

Tests use the repository's existing temporary/in-memory test setup. No live
Gemini request or WhatsApp session was started.

## Recommended Implementation Order

1. Define and test the runtime-to-generator request DTO: current history,
   roles, text/image parts, and per-request system/memory instructions.
2. Define safe provider retry/fallback semantics and surface orchestration
   progress without leaking provider internals; prohibit whole-run retries
   after execution.
3. Strengthen history transaction integrity (including missing-ID provenance,
   complete call batches, and aggregate input/history size budgets).
4. Add an end-to-end fake-generator/fake-SDK test using the real registry,
   executor, orchestrator, adapter, and permission policy.
5. Only then wire into `askFriday()` behind a controlled configuration and
   preserve existing image/sticker/voice and WhatsApp delivery paths.
6. Add real tool definitions individually, starting with narrow read-only
   tools and trusted session-context tests. Keep action tools disabled until an
   approval and idempotency design exists.

## Overall Readiness Decision

**Not ready to wire into the current runtime.** The isolated foundation is
testable and the local suite passes, but the input/history/multimodal contract
and post-execution failure policy must be resolved first. No source, test,
package, database, credential, or runtime configuration was modified by this
audit.
