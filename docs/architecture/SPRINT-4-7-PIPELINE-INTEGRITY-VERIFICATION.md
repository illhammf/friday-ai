# Sprint 4.7 — Tool Pipeline Integrity Verification

## Scope and status

This sprint verifies the isolated pipeline using the real DTO, registry,
validator, permission policy, executor, orchestrator, and Gemini adapter with
fake generation functions. It does not connect the pipeline to `askFriday()`,
WhatsApp, a database, the live Gemini API, or automatic fallback/retry.

Verification found that a count limit and per-record size limits did not
detect incomplete multi-call rounds or bound the aggregate serialized history.
Narrow hardening adds round batch metadata, strict history validation,
configurable downward aggregate bounds, and an executor/registry identity
contract.

## Pipeline architecture and data flow

1. `createAssistantRequest()` validates request fields, roles, ordered text
   and image parts, memory policy, and the 8 MiB aggregate DTO limit.
2. The registry supplies immutable public declarations. Handler functions,
   categories, and permissions are not included in the declarations.
3. `createGeminiToolGenerator()` validates declarations and DTOs, maps the
   application roles and parts to SDK content, and disables SDK automatic
   function execution.
4. The injected provider call returns either normalized text or function
   calls. The adapter preserves provider call IDs (or generates a local
   adapter ID when the SDK omits one) and normalizes arguments.
5. The orchestrator validates the complete provider call batch and unique IDs
   before dispatch. It looks up tools in its registry and calls only the
   executor instance bound to that exact registry.
6. The executor validates argument schemas, trusted authorization, category,
   timeout, and bounded output before returning a result or normalized
   execution error.
7. The orchestrator records the round, one-based call index, expected batch
   count, IDs, names, bounded call arguments, result/error, and execution
   progress. It supplies accumulated responses to the next generator round.
8. The adapter rebuilds the Gemini model function-call turn followed by the
   corresponding user function-response turn. It rejects missing, reordered,
   duplicate, or inconsistent batch records before making a provider request.

The end-to-end fake test composes these real modules and follows a DTO request
through two tool-call rounds (two calls followed by one call) to final text.
It asserts original history and image mapping, call-ID/name/argument
association, response order, and round order.

## Function-call history invariants

- Each function response carries `round`, `roundCallIndex` (one-based),
  `roundCallCount`, `call: { id, name, arguments }`, matching top-level `id`
  and `name`, and exactly one of `result` or `error`.
- The adapter requires each round to be contiguous, each index to appear in
  order exactly once, a consistent count for the round, and exactly that
  number of records. A missing response from a two-call batch is rejected.
- Calls and responses are emitted as corresponding ordered `model` and `user`
  content parts. The adapter validates call identity/name agreement and
  rejects duplicate IDs.
- It does not sort malformed out-of-order input into a valid-looking history.
  It rejects instead.
- The orchestrator returns no successful final text if its own accumulated
  history exceeds the aggregate limit; completed records remain attached to
  the structured error.
- A provider failure after successful tool calls retains the completed
  function responses and progress in `ToolOrchestrationError`; no tool is
  replayed automatically.

Provider call IDs are correlation metadata only. The orchestrator generates
separate trusted application request IDs. Duplicate call IDs are prevented
only within one orchestration request; this is not cross-request idempotency.

## Resource limits

| Boundary | Limit |
|---|---:|
| DTO history messages | 10 |
| DTO aggregate history text | 64 KiB |
| DTO aggregate serialized request | 8 MiB |
| DTO image | 5 MiB decoded; JPEG, PNG, WebP |
| Gemini declarations | 512 |
| Gemini aggregate declarations | 64 KiB |
| Gemini individual schema | 16 KiB |
| Gemini function calls per response/round | 3 |
| Orchestrator total calls | 6 across at most 2 rounds |
| Function-call arguments | 4 KiB per call |
| Individual tool result | 8 KiB |
| Gemini text response | 32 KiB |
| Orchestrator accumulated function-response records | 64 KiB serialized |
| Gemini reconstructed function-history contents | 64 KiB serialized |
| Executor timeout | 3 seconds maximum |

Both function-history bounds can be configured downward, not upward. They
reject complete history before another provider request; they never truncate
calls or responses. A serialized history record may exceed the adapter's
provider-history byte count because it includes application-only metadata, so
the orchestrator's 64 KiB check can be more restrictive. Per-result caps do
not override either aggregate cap.

## Failure matrix

| Scenario | Expected handling | Handler dispatch | Retry metadata |
|---|---|---:|---|
| Invalid DTO | Adapter rejects before provider call; orchestrator reports generator failure with no execution progress | No | Safe to consider only because no execution started |
| Provider failure before a call | Normalized provider error with empty progress | No | `safeToRetry: true` |
| Malformed/duplicate provider call response | Adapter rejects; no executor invocation | No | `safeToRetry: true` |
| Unknown tool | Normalized `TOOL_NOT_FOUND` response; generator may continue | No | Safe to consider; no handler started |
| Invalid arguments | Executor rejects schema; normalized function error | No | Safe to consider; `executionStarted: false` |
| Permission denial | Executor denies; handler not invoked | No | Safe to consider; `executionStarted: false` |
| Handler failure | Normalized tool failure, progress records started handler | Yes | `safeToRetry: false` |
| Handler timeout | `TOOL_OUTCOME_UNKNOWN`; generation stops, progress state `unknown` | Yes | `safeToRetry: false` |
| Provider failure after a successful tool | Structured partial-progress error retains success result | Yes | `safeToRetry: false` |
| Aggregate function history too large | Structured error retains completed progress; no next provider call | May have | Unsafe if any dispatch started |
| Incomplete/reordered history | Adapter rejects before provider call | No new dispatch | Existing progress determines safety |

Failure tests assert that no unauthorized handler is called, progress matches
the dispatch stage, results survive later provider failure, and no provider
generation is repeated after timeout/uncertain execution.

## Dependency consistency

`createToolExecutor()` now exposes `isBoundTo(candidateRegistry)`, backed by
its closed-over registry identity. `createToolOrchestrator()` requires that
contract and fails construction if the executor is not bound to the exact
registry supplying public declarations. The end-to-end test uses the real
registry and executor, and a mismatch test proves a real executor built from a
different registry is rejected.

Custom executor implementations are trusted dependency-injection inputs and
must implement `isBoundTo()` correctly. The orchestrator cannot prove the
honesty of arbitrary injected code; composition remains an application trust
boundary. No global mutable state was added.

## Test coverage by module

| Boundary | Existing and new coverage |
|---|---|
| Assistant request DTO | `assistant-request.test.js`: request validation, roles, history/image bounds and privacy boundaries |
| Tool registry and validator | `ai-tools.test.js`: registered public declarations, schema validation and bounded arguments |
| Permission policy and executor | `ai-tools.test.js`: trusted authorization, denied categories, pre-dispatch failures, handler failure and timeout |
| Gemini adapter | `gemini-tool-adapter.test.js`: legacy text behavior, SDK mapping, IDs, function responses, malformed/incomplete batches, aggregate limit, no automatic execution |
| Orchestrator | `tool-orchestrator.test.js`: progress, call limits, failure boundaries, duplicate IDs, registry binding, aggregate cap, no replay |
| Complete pipeline | `tool-pipeline.test.js`: fake end-to-end multi-call/multi-round flow, DTO-to-Gemini mapping, executor/permission behavior, and integrated failure scenarios |
| WhatsApp, voice, sticker, image generation | Existing `message-service`, `message-adapter`, voice, sticker, and image-generation tests; runtime code was not changed |

## Explicit guarantees and non-guarantees

The isolated pipeline tests establish that valid response history preserves
call identity and order, incomplete batch history is rejected, limits fail
closed rather than truncate, a real executor cannot be paired with another
registry, and no automatic Gemini function execution is enabled.

This does not guarantee live Gemini protocol compatibility, exactly-once
execution, cross-request idempotency, durable progress across a process crash,
or safe automatic retry/fallback. A handler can continue after timeout despite
an aborted signal. A future runtime controller must select/fallback providers
before the first tool dispatch and must not replay the orchestration after
execution has started. The module remains unintegrated into `askFriday()`;
WhatsApp routing, delivery, voice transcription, sticker routing, and image
generation remain unchanged.

## Validation

Validation was run with Node.js **v24.22.1**:

- `npm run check` — passed.
- `node --test test/tool-pipeline.test.js test/tool-orchestrator.test.js test/gemini-tool-adapter.test.js`
  — passed, 44 tests.
- `npm test` — passed, 209 tests.
- `git diff --check` — passed.
