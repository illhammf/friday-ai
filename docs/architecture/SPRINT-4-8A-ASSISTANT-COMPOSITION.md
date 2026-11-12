# Sprint 4.8A — Assistant Composition Boundary

## Status and scope

This sprint adds an application-owned wrapper for the isolated assistant
request and tool orchestration pipeline. It does not construct the wrapper in
the Friday runtime, register production tools, route WhatsApp messages through
it, persist its results, or change the legacy assistant path.

The wrapper is a composition foundation, not a feature rollout. All tests use
fake generators and local handlers; no Gemini or WhatsApp request is made.

## Application boundary and dependency ownership

`createToolAssistant()` in `src/application/tool-assistant.js` receives:

- The already configured registry and its bound executor.
- A provider-independent generator.
- An application-owned trusted-context factory.
- Assistant request factory and validator (the real DTO functions by default).
- An orchestrator factory (the real factory by default).

The application must register any tools before creating this wrapper. The
wrapper checks `executor.isBoundTo(registry)` before constructing exactly one
orchestrator and passes that same registry/executor pair and generator to it.
It does not create, mutate, or globally cache registries or executors. The
composition root owns those instances and their lifecycle.

The wrapper owns no database, WhatsApp client, queue, SDK client, or other
resource requiring shutdown. Its dependencies are injected, and its `run()`
method does not create a new orchestrator per request.

## Request and trusted-context separation

Invocation shape:

```js
const result = await toolAssistant.run({
  request: {
    question,
    history,
    systemInstruction,
    conversationStyle,
    memoryContext,
    image,
  },
  applicationContext: trustedRuntimeContext,
});
```

The application-owned factory receives `applicationContext` and returns
trusted execution context. That result must declare `conversationType` as
`private` or `group`. The wrapper:

- Rejects group requests before calling the orchestrator. Group execution is
  unavailable in this sprint.
- Overrides DTO `conversationType` using the trusted context. Request input
  cannot choose the scope or provide a sender display name.
- Takes `senderName` for DTO presentation only from the trusted context.
- Passes the validated DTO only as orchestrator/model input, and passes
  trusted context separately as executor context.
- Does not derive identity, session, authorization, permission category, or
  request ID from model-generated arguments or output.
- Does not add an `authorizedTools` default. Missing grants reach the executor
  as missing and are denied by the existing permission policy. The application
  policy must grant only explicitly approved tools; the wrapper does not grant
  all registered tools.

The caller and trusted-context factory are application trust boundaries.
This module cannot prove that arbitrary injected application code constructs
trusted context correctly. Do not expose `applicationContext` as raw
user/model-controlled data.

## Structured result and error contract

On success, `run()` returns the orchestrator's result unchanged:

```js
{
  status: 'succeeded',
  text: 'The result is ready.',
  executionProgress: { /* request and per-call progress */ },
  functionResponses: [ /* completed tool results/errors */ ],
  retrySafety: {
    safeToRetry: false,
    reason: 'tool_execution_started',
  },
}
```

On orchestration failure, it throws `ToolAssistantError`. The wrapper
preserves the original stable code, kind, execution progress, completed
function responses, and retry-safety metadata, and retains the original error
as `cause`. `hasUncertainOutcome` is taken from structured progress; if an
unexpected orchestrator exception has no progress, the wrapper conservatively
marks the outcome uncertain and unsafe to retry.

Failures before orchestration (trusted-context creation, group-policy denial,
request creation/validation) carry an explicit `not_started` progress
snapshot, no function responses, and `safeToRetry: true` only as execution
replay metadata. That value is not a recommendation to retry invalid input or
authorization failures.

The wrapper does not parse error messages to infer whether a tool ran. It does
not retry or fall back, and it does not restart an orchestration. In
particular, successful function responses remain available when a later
provider generation fails, and timeout uncertainty is preserved.

## Provider-selection requirements for Sprint 4.8B

The legacy `generateWithRetry()` and `generateWithModelFallback()` remain
unchanged and continue to serve the old text-only path. They must not wrap the
whole tool orchestration. The Gemini adapter currently normalizes provider
errors and the orchestrator classifies generator failures as `kind: 'provider'`;
the legacy fallback classifier does not consume `retrySafety`.

Before any future tool dispatch, a provider-selection layer may choose a
provider/model and create one pinned generator. No automatic retry or fallback
is implemented here. Once the first handler starts, the caller must not
replay orchestration or switch provider/model. Provider-selection and fallback
policy must be separately designed and tested against structured progress in
Sprint 4.8B.

## Persistence ownership

The legacy `askFriday()` in `src/friday-runtime.js` currently loads history,
generates a text answer, and saves one user turn and one assistant turn itself.
This wrapper has no persistence dependency and does not move, duplicate, or
invoke that behavior. `askFriday()` is not replaced or called by the wrapper.

Future runtime integration must define one persistence owner and guarantee:

1. One user turn is saved for an accepted request.
2. One final assistant turn is saved only when a final answer is available.
3. Internal provider function-call and function-response protocol is not stored
   as ordinary user/assistant chat text.
4. Partial execution and provider failure after a tool succeeds are handled
   explicitly; successful results are not silently lost and the turn is not
   automatically replayed.
5. Unknown tool outcomes are not represented as a confirmed non-execution.

Since satisfying these rules requires changing runtime orchestration and
failure behavior, persistence integration is deferred rather than added here.

## Legacy compatibility

The existing WhatsApp assistant dependency still returns a string from
`askFriday()`. This sprint does not replace it or add a string-only adapter:
reducing the structured result to a primitive string would discard progress
and retry-safety metadata. The structured API remains separate, and the
legacy assistant string contract, retry/fallback behavior, persistence, and
message routing remain unchanged.

## Verification coverage

`test/application-tool-assistant.test.js` composes the wrapper with the real
DTO, registry, permission policy, executor, and orchestrator using fake
generators/handlers. It covers:

- One-time orchestrator construction with the exact registry/executor pair,
  and rejection of a mismatched pair.
- DTO creation/validation, request-scope spoof rejection, and trusted context
  remaining outside model input.
- Group execution denial and missing-grant handler denial.
- Structured success identity and metadata preservation.
- Provider failure after success, including accessible partial responses.
- Unknown timeout outcomes and unsafe retry metadata.
- No automatic retry/fallback and no wrapper-owned persistence.
- The legacy string-return path remains separate.

The normal check/test commands include this source module and test file. The
existing WhatsApp routing, media, lifecycle, database, and legacy behavior
tests remain in the full test suite.

## Remaining blockers before WhatsApp routing integration

- No production tools or runtime authorization policy are added. A future
  sprint must define and review a least-privilege tool allowlist.
- The wrapper is not constructed in `friday-runtime.js` and no WhatsApp path
  calls it.
- The legacy string response path cannot surface structured progress. Future
  integration needs a structured application-level failure mapper without
  changing current behavior unintentionally.
- Persistence ownership and partial-completion behavior need implementation
  and tests before switching any runtime path.
- Provider selection/fallback must be progress-aware; no retry or fallback
  controller exists for tool orchestration.
- Live Gemini compatibility has not been tested; no live request was made.
- Group and multimodal tool execution remain disabled/out of scope.

Sprint 4.8A stops at this composition boundary. It does not begin Sprint 4.8B
or enable tools for WhatsApp messages.
