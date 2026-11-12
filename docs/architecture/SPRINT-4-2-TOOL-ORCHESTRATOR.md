# Sprint 4.2 — Tool Orchestrator Foundation

## Architecture and Scope

`src/ai/tool-orchestrator.js` coordinates an injected generator with the Sprint
4.1 registry and executor. It has no Gemini SDK, WhatsApp, database,
filesystem, network, or environment dependencies. This sprint does not wire the
orchestrator into Friday's runtime and does not add real tools.

The orchestration layer only sees public declarations from
`registry.getPublicDeclarations()`. It checks that each requested name is
registered before calling `executor.execute()`. The executor remains
responsible for argument schema validation, trusted permission checks, handler
timeouts, and result size limits.

## Generator Contract

`createToolOrchestrator({ generator, executor, registry, ...limits })` returns
an object with `run(input, trustedContext)`. Since Sprint 4.6, successful
`run()` calls return `{ status, text, executionProgress, functionResponses,
retrySafety }`, and normalized failures throw `ToolOrchestrationError` with
the same progress, accumulated responses, and retry-safety metadata. Consumers
must use this detailed result rather than assuming `run()` returns a string.
The generator is an injected async function:

```js
async function generator({ input, tools, functionResponses }) {
  // Return { text } or { functionCalls }.
}
```

`input` is the application's provider-independent conversation/model input.
`tools` is the immutable declaration list from the registry, with only `name`,
`description`, and `parametersJsonSchema`. `functionResponses` contains the
accumulated results from all completed tool calls in this orchestration request.

The generator returns one of these normalized shapes:

```js
{ text: 'Final answer' }
{ functionCalls: [{ id: 'call-1', name: 'lookup_data', arguments: {} }] }
```

Function call IDs are required, non-empty strings of at most 128 characters
and must be unique for the request. Tool names must follow the registry naming
convention; arguments must be plain objects. Unsupported fields, accessors,
mixed non-empty text and tool calls, or an empty response are rejected.

Function responses sent back to the generator preserve call IDs and names:

```js
{
  round: 1,
  roundCallIndex: 1,
  roundCallCount: 1,
  call: { id: 'call-1', name: 'lookup_data', arguments: {} },
  id: 'call-1',
  name: 'lookup_data',
  result: { value: 'ok' }
}
{
  round: 1,
  call: { id: 'call-2', name: 'lookup_data', arguments: {} },
  id: 'call-2',
  name: 'lookup_data',
  error: {
  code: 'TOOL_TIMEOUT',
  message: 'Tool execution timed out.'
  }
}
```

Tool execution errors are converted to stable, bounded codes and messages.
Internal exception messages and stacks are never forwarded. Unknown registered
names receive a `TOOL_NOT_FOUND` response without invoking the executor.
Each response also carries its one-based round and the original normalized call
(`id`, `name`, and bounded JSON `arguments`). This allows provider adapters to
reconstruct the model function-call turn before returning the corresponding
function response in the provider's required conversation history.

## Orchestration Flow

1. Invoke the generator with input, registry declarations, and accumulated
   function responses.
2. Return a structured success result with trimmed final text and execution
   progress when the generator returns a valid text-only response.
3. Validate a complete batch of function calls, including IDs, names, and
   argument object shape.
4. Check round and call limits before executing any call in the batch. Each
   response records its one-based index and the expected batch size so the
   adapter can reject an incomplete or reordered multi-call round.
5. Execute registered calls sequentially through the injected executor,
   passing only the trusted context supplied to `run`.
6. Append normalized results or errors, then invoke the generator again.

No tool is executed from generated JavaScript or code. Tool definitions,
categories, permissions, and declarations cannot be changed by the generator.
The orchestrator does not automatically retry generator requests or switch
models/providers. This avoids repeating a tool after execution; provider
fallback policy remains a future integration concern.

## Execution Limits

Defaults and hard maxima are:

| Limit | Default | Hard maximum |
|---|---:|---:|
| Tool-call rounds | 2 | 2 |
| Calls per round | 3 | 3 |
| Calls per request | 6 | 6 |

Callers may lower limits, including setting a limit to zero, but cannot raise
them. A batch that exceeds a limit is rejected before that batch executes. If
the generator asks for more tool rounds after the round limit is reached, the
orchestrator stops with `TOOL_ROUND_LIMIT`. Per-round and total call overages
stop with `TOOL_CALL_LIMIT`.

The existing executor continues to enforce its own 4 KiB argument, 8 KiB
result, and 3-second timeout limits. Sequential dispatch keeps execution
bounded and deterministic. A timed-out handler may continue if it ignores its
abort signal, as documented in Sprint 4.1.

## Failure Handling and Security Boundaries

Generator failures become `GENERATOR_FAILED`; malformed responses and calls
become `INVALID_GENERATOR_RESPONSE` or `INVALID_FUNCTION_CALL`. Duplicate call
IDs become `DUPLICATE_FUNCTION_CALL_ID`. Tool-level failures with known
outcomes are returned as normalized function responses so the generator may
produce a final answer. A timeout or otherwise uncertain execution outcome
stops the request rather than issuing another generation. Round/call limit
failures stop the request with a normalized orchestration error. No automatic
orchestration retry occurs.

Sprint 4.6 adds progress-state and retry-safety metadata to successful results
and errors. See
[`SPRINT-4-6-EXECUTION-PROGRESS-AND-RETRY-SAFETY.md`](./SPRINT-4-6-EXECUTION-PROGRESS-AND-RETRY-SAFETY.md)
for the state model and limitations. These per-request records do not provide
cross-request idempotency or exactly-once execution.

The orchestrator requires the registry and executor interfaces but does not
reimplement their security checks. The registry prevents unregistered names
from reaching execution. The executor checks explicit trusted permissions and
never derives identity, scope, or permissions from model arguments. Neither
this module nor its tests log arguments or results.

The executor must expose `isBoundTo(registry)` and return true only for the
registry instance used to construct it. The orchestrator enforces this
identity before accepting declarations, preventing an accidentally mismatched
registry/executor pair. Custom injected executors must implement the same
trusted composition contract.

The orchestrator and Gemini adapter each reject accumulated function history
over 64 KiB; neither truncates history. The byte totals are measured over
their respective serialized application records and provider-history parts.

Tool results remain untrusted data even when valid JSON. Size limits do not
detect prompt injection or redact secrets; future integrations must preserve
that boundary in their prompts and tool implementations. No shell, arbitrary
filesystem, network, database, or external provider access is introduced.

## Known Limitations and Future Integration

- The generator contract is deliberately application-level and has no SDK
  types. Provider adapters translate provider calls/responses without exposing
  SDK-specific types to this module.
- Function responses accumulate across rounds; provider conversation-history
  formatting belongs in the adapter.
- Sequential execution and fixed hard caps limit throughput by design.
- The tool-output JSON size limit comes from the existing executor and applies
  per result, not to the total accumulated response history.
- Friday runtime, Gemini model fallback, WhatsApp, memory, approval, and real
  tool integrations are unchanged and remain future work.

## Tests and Validation

`test/tool-orchestrator.test.js` uses fake generators and executors to cover
normal text, successful and multiple calls, multiple rounds, unknown tools,
malformed responses, permission/timeout/argument/executor failures, limits,
call ID validation, unregistered tool isolation, and import safety. No live
Gemini, WhatsApp, database, or network access is required.

On Node.js `v24.22.1`, `npm run check` passed, `npm test` passed all 169 tests
with 0 failures and 0 skipped, and `git diff --check` passed.
