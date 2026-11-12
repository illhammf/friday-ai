# Sprint 4.7.1 — Final Runtime Integration Readiness Audit

## Executive verdict: NOT READY

The isolated tool pipeline has a useful DTO, provider adapter, executor,
permission checks, progress reporting, and fake end-to-end coverage. Friday's
actual WhatsApp runtime does not construct or invoke any of those modules,
however. There are no production tool registrations or runtime-owned
authorization grants, and the existing assistant contract is a text string
with its own retry/fallback and persistence behavior. Connecting the
orchestrator directly to that contract would lose structured progress and
could cause replay after a tool has started.

The verdict is **NOT READY for runtime tool integration**. A staged, private
text-only pilot can be considered after the blockers below are resolved and
the provider adapter is verified against the live Gemini API in a separately
authorized test. This audit made no source, test, or configuration changes and
sent no Gemini or WhatsApp requests.

## Scope and evidence

Reviewed the current runtime composition and message handling, lifecycle,
session/database and memory boundaries, Assistant Request DTO, Gemini tool
adapter, tool orchestrator, registry, permission policy, executor, prior Sprint
4.6/4.7 architecture documents and relevant tests. The installed SDK is
`@google/genai` 2.30.0. All conclusions below are based on local code and SDK
types, not a live API compatibility test.

## Existing runtime data flow and contracts

1. [src/index.js](../../src/index.js) dynamically imports
   [src/friday-runtime.js](../../src/friday-runtime.js) when `startFriday()` is
   called (or when the entry point is run). The runtime composes the WhatsApp
   client, queue, message service, database, memory service, and legacy
   `askFriday()` implementation.
2. The WhatsApp adapter normalizes `message.from` as the chat ID, uses the
   group author as sender ID for group messages, and exposes a sender display
   name separately. The queue is serial per chat ID, deduplicates WhatsApp
   message IDs, and caps pending work.
3. `message-service.handle(message, transport)` filters old/invalid messages,
   enforces the group bot-name prefix, then routes explicit video-download,
   sticker, and image-generation requests before calling the assistant.
   Voice notes are transcribed to text; image media is downloaded and passed
   as base64 data. Its assistant dependency is currently called as
   `ask({ question, privateSession, sharedGroupSession, senderName, image })`.
4. `askFriday()` returns a **string**. It chooses the group session when
   `sharedGroupSession` is truthy, loads up to 10 history messages, retrieves
   memory only for private sessions, builds Gemini `contents` and a system
   instruction, runs the legacy retry/model-fallback chain, saves the user and
   assistant text to that session, and returns the answer. It does not create
   or validate an Assistant Request DTO and does not call the tool
   orchestrator.
5. `message-service` formats that string and replies, or synthesizes/sends a
   voice note. Its outer error handler logs the failure and sends a generic
   AI failure message. Generated images and stickers have separate delivery
   and history-save paths.
6. The isolated pipeline instead accepts a DTO (or legacy adapter input), and
   `orchestrator.run(input, trustedContext)` returns a result object containing
   text, execution progress, function responses, and retry-safety metadata.
   On failure it throws `ToolOrchestrationError` with a `kind`, progress,
   completed function responses, and retry safety. This is not compatible
   with the current `assistant.ask` string contract without an application
   wrapper.

Relevant implementation: [src/friday-runtime.js](../../src/friday-runtime.js),
[src/application/message-service.js](../../src/application/message-service.js),
[src/whatsapp/message-adapter.js](../../src/whatsapp/message-adapter.js),
[src/whatsapp/message-queue.js](../../src/whatsapp/message-queue.js),
[src/ai/assistant-request.js](../../src/ai/assistant-request.js), and
[src/ai/tool-orchestrator.js](../../src/ai/tool-orchestrator.js).

## Recommended integration boundary

Keep WhatsApp normalization, routing, media, and delivery unchanged. Add an
application-owned assistant composition boundary between `message-service`
and the model pipeline. It should build the DTO from trusted runtime data,
invoke the orchestrator with a separate trusted authorization context, map
successful result text back to the existing string response, persist history
only once, and explicitly map structured failures to safe user responses.
Do not pass provider arguments, call IDs, sender text, or DTO metadata as
authorization grants.

The first rollout should be **private, text-only conversations** using a
small, explicitly registered set of read-only tools. Keep group messages on
the existing assistant path; keep image messages, transcribed voice, generated
images, stickers, video downloads, and voice replies on their current paths.
This keeps the first tool-enabled path narrow and avoids simultaneously
changing multimodal request construction or any media side effect. Expand
only after separate compatibility and privacy verification.

## Trusted identity, session, and memory boundaries

- The message service derives private session IDs from the WhatsApp sender ID
  and group session IDs from the WhatsApp chat ID. It passes both session
  identifiers separately to `askFriday()`. Group history uses the shared
  group session; private history uses the sender's private session.
- Group sender display name is supplied separately and prefixed to the group
  prompt. It is context, not an authorization identity.
- Existing runtime logic chooses group/private context from the
  application-supplied `sharedGroupSession`, and sets group memory to an empty
  list. `createAssistantRequest()` and `assertAssistantRequest()` reject
  non-empty memory context when `conversationType` is `group`.
- The DTO has no session ID or tool-grant field in its model input. The
  orchestrator accepts `trustedContext` separately from the input sent to the
  generator, and the executor checks `authorizedTools` against each
  registered tool. Only `read_only` tools are currently allowed by policy;
  action/approval categories are denied.
- These protections rely on the composition root deriving
  `conversationType`, session scope, memory, and `authorizedTools` from the
  normalized WhatsApp event and application policy. A model-provided argument
  or sender display name must never be used to construct those trusted values.
- Message processing is queued per WhatsApp chat. The service's separate
  active-session guard is keyed by the sender's private session, even for
  group requests. This does not currently replace the per-chat queue; preserve
  the queue key and make any new session locking explicit rather than using a
  model-controlled key.

**Assessment:** Current code keeps group memory separate from private memory,
and the DTO rejects group memory when correctly marked. The future tool
composition must retain this boundary and make the authorization decision
outside model input. No current runtime request supplies tool authorization,
because no runtime tool execution is wired.

## Existing feature compatibility matrix

| Existing behavior | Current path | First tool pilot |
|---|---|---|
| Private text chat | `askFriday()` → legacy Gemini generation → string reply | Candidate, after blockers are resolved |
| Group text chat | Prefix-gated, shared group history, sender name in prompt | Keep on existing path initially |
| Image question | WhatsApp media download → inline image in legacy Gemini contents | Keep unchanged; do not include in pilot |
| Voice note | Download/transcribe → assistant text → TTS voice reply | Keep unchanged; do not include in pilot |
| Sticker request | Dedicated image-sticker generation and WhatsApp sticker delivery | Keep unchanged |
| TikTok/Instagram download | Explicit-download intent → video downloader → WhatsApp video delivery | Keep unchanged; never expose as a tool in initial pilot |
| Image generation | Intent router → image generation → WhatsApp image delivery | Keep unchanged; never expose as a tool in initial pilot |
| Message ordering/deduplication | Per-chat queue, message-ID deduplicator, bounded pending queue | Preserve unchanged |
| Conversation history | Runtime loads 10 turns and saves the final user/model text | Preserve one-save-per-turn semantics; do not persist internal tool protocol as plain chat turns |

Existing focused tests include `message-service.test.js`,
`message-adapter.test.js`, `message-queue.test.js`, image/sticker tests,
voice-note tests, video tests, and lifecycle tests. These cover current paths
with fakes; they do not prove that the new orchestrator can be integrated
without changing their runtime behavior.

## Retry and provider-selection requirements

`generateWithRetry()` retries temporary Gemini errors up to two attempts, and
`generateWithModelFallback()` can move through configured models. That is
currently within one text-only generation and occurs before any tool execution.
Neither wrapper understands orchestrator progress.

The tool adapter catches provider exceptions and normalizes them to
`GEMINI_GENERATION_FAILED`; the orchestrator further represents generator
errors as `GENERATOR_FAILED` with `kind: 'provider'`. The existing fallback
predicate examines provider status/code/message and cannot be assumed to
classify these normalized errors correctly. More importantly, wrapping the
whole orchestration in the existing retry/fallback loop would not be safe:
after a handler starts, a repeated orchestration can dispatch a call again,
including under a new provider call ID.

Required application behavior:

- Provider selection/fallback may be considered only before any tool has
  started. Provider and adapter errors must remain distinguishable enough for
  the caller's policy.
- Once the first tool starts, do not restart the orchestration, run generation
  retries that could elicit and dispatch another function call, or switch
  provider/model. Return or report the structured outcome.
- Use `retrySafety` as structured data, not error-message parsing. `true`
  means no handler dispatch has started in this orchestration; it does not
  mean every failure should be retried.
- On a later provider failure, preserve successful function responses and
  progress for diagnosis and safe user messaging. Do not lose the completed
  result behind a generic exception or imply that the tool did not run.
- A timeout is uncertain: the executor aborts its signal, but a handler may
  continue after timeout. Do not automatically replay it.

No retry or fallback controller should be added until this state-aware policy
is implemented and tested at the runtime boundary.

## Dependency and lifecycle findings

- Runtime composition currently creates one module-scoped application,
  database reference, message service, and message queue. Database opening,
  WhatsApp client construction, handler registration, initialization, message
  draining, client destruction, and database close are owned by the
  application lifecycle. The isolated pipeline modules are not included in
  this composition.
- The executor's `isBoundTo(registry)` check ensures the ordinary executor
  instance uses the registry from which declarations are obtained. The
  orchestrator snapshots declarations at construction; register all tools
  before constructing it. Arbitrary injected executor implementations remain
  trusted and could lie about `isBoundTo`.
- The adapter disables SDK automatic function execution and keeps the model
  call manual. The runtime has no tool adapter, orchestrator, registry, or
  executor instance today; no duplicate runtime tool pair was found.
- `src/ai/gemini.js` constructs a singleton `GoogleGenAI` at module import and
  throws if `GEMINI_API_KEY` is absent. `src/index.js` delays importing the
  runtime until startup, but importing the runtime still evaluates this
  provider module and creates the client object. This is not a live request.
  Keep new tool composition free of import-time database/WhatsApp/network
  effects and follow the existing lifecycle for resource cleanup.
- Existing shutdown stops accepting messages, drains the queue, destroys the
  WhatsApp client, and closes the database. Tool handlers must remain bounded,
  honor the signal when possible, and not treat shutdown cancellation as
  proof of non-execution.

## Failure handling recommendations

| Failure | Runtime requirement |
|---|---|
| Invalid DTO | Report input/composition failure distinctly; no provider call or tool dispatch; do not present it as a provider outage. |
| Provider failure before execution | Use provider policy only when the structured progress confirms no handler started; keep any retry bounded. |
| Malformed provider response | Fail closed before dispatch, surface a safe generic response, retain protocol diagnostics, and do not send malformed history. |
| Unknown tool / invalid arguments | No unauthorized handler invocation; record the validation/tool error and do not retry the same invalid call indefinitely. |
| Permission denial | Do not invoke the handler; report a safe denial without exposing private authorization details. |
| Handler failure | Mark execution started; do not replay automatically, even if the handler reports failure. |
| Handler timeout | Treat outcome as unknown; do not retry or fall back; tell the user the outcome could not be confirmed and avoid suggesting a blind repeat for an action. |
| Provider failure after a successful tool | Preserve result/progress; do not rerun; provide a truthful partial-completion response when safe, otherwise ask the user before repeating. |
| Oversized/incomplete function history | Stop before the next provider request; do not truncate or reconstruct partial batches into valid-looking history. |
| Duplicate provider call ID | Reject before dispatching that batch; no cross-request idempotency is implied. |

These are recommendations only; this audit does not implement any runtime
responses.

## Live Gemini API readiness

The installed `@google/genai` package is version 2.30.0. Its local type
declarations include function-call/response and automatic function-calling
configuration types. The adapter maps SDK `functionCalls`, `args`, response
IDs/names, `contents` parts (`text`, `inlineData`, `functionCall`, and
`functionResponse`), `toolConfig`, and
`automaticFunctionCalling: { disable: true }`.

The adapter contract and tests are internally consistent with the currently
installed SDK shape. They do **not** prove that the remote API accepts the
exact request shape for every configured model, returns IDs in the assumed
form, supports the configured multimodal/tool combination, or behaves
identically across supported models. No live call was made, and no claim of
live Gemini compatibility is made. Verify a non-production, read-only tool
with an approved test account and a deliberately harmless handler before
enabling a production rollout.

## Findings

### BLOCKER — No runtime tool-pipeline composition or registered tools

**Evidence:** The production composition in `src/friday-runtime.js` supplies
legacy `askFriday()` as `assistant.ask`. Registry, executor, orchestrator,
and Gemini adapter construction occurs only in isolated modules/tests; there
are no production `registry.register(...)` calls.

**Impact:** There is no runtime tool allowlist, executor pair, or trusted
authorization context. No tool request can currently be run through Friday's
WhatsApp path.

**Recommended action:** Build a dedicated, injected composition boundary;
register only reviewed read-only tools, grant them from trusted application
policy, and test the boundary before enabling it.

### BLOCKER — Existing assistant response contract cannot preserve tool state

**Evidence:** `askFriday()` returns a string and persists text itself;
`message-service` assumes that string for formatting/TTS. The orchestrator
returns a structured success object and throws structured errors containing
progress and partial responses.

**Impact:** Direct substitution would break the message path or discard retry
safety and successful tool results after partial failure. Duplicate database
history writes are also possible if both the wrapper and legacy function save
the same turn.

**Recommended action:** Add an application wrapper that preserves the
existing string response to `message-service`, persists one final turn, and
handles structured success and error paths explicitly. Do not change
WhatsApp-facing behavior unintentionally.

### BLOCKER — Runtime retry/fallback is not progress-aware

**Evidence:** Legacy generation retries and falls back by provider error,
while the adapter/orchestrator normalize errors and expose execution progress
separately. The current retry/fallback functions do not inspect that progress.

**Impact:** Applying the legacy wrapper around the full orchestration could
replay tool calls after dispatch, including after a successful or uncertain
execution. Current normalized errors may also bypass existing provider
classification.

**Recommended action:** Define a state-aware generator/provider selection
contract; allow fallback only before the first dispatch, pin the selected
provider for later rounds, and stop on any started/unknown execution.

### BLOCKER — No runtime policy for tool grants or group eligibility

**Evidence:** The executor requires explicit `authorizedTools` in a trusted
context; no runtime call currently supplies such context. Group/private
separation is in the legacy assistant path, not in an orchestrator invocation.

**Impact:** The tool pipeline cannot authorize even a read-only call safely.
Passing model input, group sender name, or a call argument as a grant would
cross the trusted boundary.

**Recommended action:** Derive scope and grants from normalized event data
and application policy. Keep the first rollout private-only and ensure group
requests cannot receive private memory or grants.

### HIGH — Structured failures need user-safe partial-completion handling

**Evidence:** `message-service` currently converts thrown assistant errors
into a generic AI failure reply. It has no branch for `ToolOrchestrationError`
or a result with successful tool responses followed by provider failure.

**Impact:** Users could be told only that the AI failed after a tool already
completed, encouraging an unsafe repeat or hiding a partial completion.

**Recommended action:** Map error `kind`, progress, and completed responses
to safe, truthful messaging. Never infer execution status from error strings.

### HIGH — Normalized provider errors do not preserve fallback classification

**Evidence:** The Gemini adapter wraps provider errors as
`GEMINI_GENERATION_FAILED`; the orchestrator wraps generator exceptions as
`GENERATOR_FAILED`. The existing fallback classifier checks status/code and
provider-like message text, not structured causes in these normalized
errors.

**Impact:** Pre-execution fallback may not occur when intended, while broad
retry wrappers would be unsafe after execution.

**Recommended action:** Preserve a typed provider cause/status separately from
tool/protocol errors, and gate fallback on both that type and progress.

### MEDIUM — Live SDK and model behavior are unverified

**Evidence:** Tests use injected fake generators. SDK version 2.30.0 and local
types can confirm compile-time names/shapes only.

**Impact:** Remote function-calling, response correlation, or image-plus-tool
behavior may differ from test assumptions.

**Recommended action:** Perform separately approved, non-production
compatibility tests before rollout; keep the first pilot text-only.

### LOW — Provider module has import-time construction/configuration

**Evidence:** `src/ai/gemini.js` reads the API key and constructs the SDK
singleton at module evaluation; runtime import fails without the key.

**Impact:** Isolated imports of runtime composition are environment-sensitive,
though no Gemini API request is made just by constructing the SDK client.

**Recommended action:** Keep new modules dependency-injected and free of
external side effects; optionally consider provider construction lifecycle
changes in a separate, scoped task.

## Minimal staged integration plan

1. **Composition and contract:** Add the assistant wrapper, create/register
   the trusted registry/executor/orchestrator pair at startup, and preserve
   the existing string-return contract and one-time persistence.
2. **Private text-only path:** Gate only eligible private text messages to the
   new wrapper. Keep groups and all media/special routes on current behavior.
3. **Retry and failures:** Implement the structured progress-aware provider
   policy and safe user-facing failure mapping. Prove no retry/fallback after
   any dispatch or uncertain result.
4. **Verification:** Add runtime composition tests for identity, authorization,
   persistence, queue ordering, provider failures, handler timeout, and
   partial success; run the existing WhatsApp/media/lifecycle regression
   tests.
5. **Compatibility gate:** Run approved live Gemini tests against a harmless
   read-only tool before rollout. Expand to groups or multimodal requests only
   in later scoped work.

## Exact files expected to change in Sprint 4.8

This is a forecast, not an authorization to change these files in this audit.

**Expected modifications:**

- `src/friday-runtime.js` — construct/inject a single tool pipeline and add
  trusted DTO/context composition while preserving current lifecycle.
- `src/application/message-service.js` — only if the existing assistant
  dependency needs a narrowly scoped gate for eligible private text messages;
  keep media/special routing unchanged.
- `package.json` — add any new runtime source file to the existing syntax
  check only if required by the repository's check script.

**Expected additions:**

- `src/application/tool-assistant.js` (or equivalently named application
  wrapper) — convert trusted request data to DTO, invoke the orchestrator,
  return text on success, and expose structured outcomes to the runtime
  failure mapper.
- `test/tool-assistant-runtime.test.js` — fake-generator/handler composition,
  identity and grant boundaries, string contract, persistence, and
  no-replay assertions.
- `test/friday-runtime-tool-integration.test.js` (or focused additions to
  existing composition tests) — private text route and regression behavior.

Avoid changing `src/ai/assistant-request.js`, the Gemini adapter, orchestrator,
database schema, migrations, WhatsApp normalization, media handlers, or
existing model fallback unless a newly discovered, tested compatibility
defect requires a separate scoped change.

## Remaining blockers and guarantees

Before any runtime tool rollout, resolve all four BLOCKER findings, add and
test a state-aware failure/retry boundary, and complete approved live
compatibility testing. The isolated orchestrator's current per-request
duplicate call-ID protection and progress model do not provide cross-request
idempotency or exactly-once execution. A timeout does not prove cancellation.
No automatic retry, model fallback after execution, or runtime tool integration
is provided by this audit.
