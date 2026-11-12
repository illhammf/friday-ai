# Sprint 4.6 — Tool Execution Progress and Retry Safety

## Status and scope

The provider-independent orchestrator now returns execution progress on
success and attaches the same structured progress to normalized failures. The
executor signals the exact point immediately before invoking a registered
handler. This establishes retry/fallback information for future application
code; it does not add a retry controller or integrate tools into Friday's
runtime.

No automatic provider retry, model fallback, WhatsApp/database change, or
write/action tool was introduced.

## Execution progress model

Each orchestration request receives an application-generated `requestId`
(Node's `randomUUID()` by default; a trusted `createRequestId` dependency may
be injected). It is never derived from model input or provider call IDs.
Provider call IDs are retained separately as `providerCallId` and are checked
for duplicates within this single request.

The progress snapshot contains:

```js
{
  requestId: 'trusted-application-id',
  state: 'succeeded',
  hasExecutionStarted: true,
  hasUncertainOutcome: false,
  calls: [{
    sequence: 1,
    round: 1,
    providerCallId: 'provider-call-1',
    toolName: 'lookup_data',
    state: 'succeeded',
    executionStarted: true,
    functionResponseIndex: 0,
  }],
  retrySafety: {
    safeToRetry: false,
    reason: 'tool_execution_started',
  },
}
```

Progress records intentionally exclude arguments and successful result data.
Those are retained in `functionResponses` for the provider history and are
returned separately with the final result or structured orchestration error.
Results are not duplicated into diagnostic progress.

Supported progress states (request-level snapshots expose `not_started` when
there are no call records; individual calls enter the records at `validated`):

| State | Meaning |
|---|---|
| `not_started` | No valid tool call has been dispatched. Used by the request-level snapshot when it contains no call records. |
| `validated` | The normalized call passed the orchestrator's structural checks; executor dispatch has not begun. |
| `running` | The executor completed schema/permission checks and signaled immediately before invoking the handler. |
| `succeeded` | The handler returned and its result was accepted and bounded by the executor/orchestrator. |
| `failed` | The call failed with a known outcome. `executionStarted` separately identifies failures before versus after handler dispatch. |
| `unknown` | A handler started, but completion cannot be confirmed, notably after timeout. |

`executionStarted` is retained independently from the state. For example, a
failed schema or permission check is `failed` with `executionStarted: false`;
a handler failure is `failed` with `executionStarted: true`. `unknown` always
has `executionStarted: true`.

## State transitions

1. The application creates the request ID.
2. The generator returns a batch. All call IDs, names, and JSON arguments are
   validated before any call in the batch is dispatched.
3. Each accepted call is recorded as `validated`. Invalid batches are rejected
   without invoking the executor.
4. The executor checks registration, argument schema, trusted context, and
   permission. These checks occur before handler dispatch.
5. The executor invokes `onStarted` immediately before scheduling the handler;
   the orchestrator changes the call to `running` and sets
   `executionStarted: true`.
6. A valid bounded result changes the record to `succeeded`; a known error
   changes it to `failed`; timeout or an unclassified post-dispatch exception
   changes it to `unknown`.
7. Final generator output returns a structured success result. A provider,
   protocol, validation, limit, or uncertain tool failure throws
   `ToolOrchestrationError` with immutable progress, accumulated function
   responses, a stable error `kind`/`code`, and retry safety.

The executor keeps its existing `execute(name, args, trustedContext)` usage.
An optional fourth lifecycle argument, `{ onStarted }`, is additive. Normal
executor validation and permission errors expose `executionStarted: false`;
handler and timeout failures expose their dispatch status. If a custom
executor does not report lifecycle metadata, the orchestrator treats an
unclassified rejected dispatch conservatively as started/unknown.

## Result and error contracts

Success now returns:

```js
{
  status: 'succeeded',
  text: 'Found the value.',
  executionProgress: { /* request and per-call state */ },
  functionResponses: [{
    round: 1,
    call: { id: 'provider-call-1', name: 'lookup_data', arguments: {} },
    id: 'provider-call-1',
    name: 'lookup_data',
    result: { value: 'ok' },
  }],
  retrySafety: {
    safeToRetry: false,
    reason: 'tool_execution_started',
  },
}
```

If the next provider generation fails after that tool succeeded, the
orchestrator throws a structured `ToolOrchestrationError` with
`kind: 'provider'`, `code: 'GENERATOR_FAILED'`, and the successful
`functionResponses` and progress record still attached. The caller can see the
partial result and must not automatically restart the request.

For a timeout, the orchestrator returns no success-shaped response and throws
`TOOL_OUTCOME_UNKNOWN` with `kind: 'tool_execution'`. Its partial function
responses include the bounded `TOOL_TIMEOUT` response; progress sets the call
to `unknown`, `hasUncertainOutcome: true`, and retry safety to false. It does
not make another generator request after this uncertain result.

Provider errors remain distinguishable from protocol/validation/orchestration
and tool execution outcomes through `kind`. Provider exception details are
not exposed. Tool function-response errors continue using bounded normalized
codes/messages.

## Retry and fallback boundaries

`retrySafety.safeToRetry` means only that replaying the **whole request cannot
duplicate a handler dispatch known to this orchestration**. It is not a
recommendation to retry every error:

- Provider generation fails before execution: `safeToRetry: true`; a future
  caller may consider retry/fallback, subject to provider-specific policy.
- A call or executor validation fails before handler dispatch:
  `safeToRetry: true`, with a `failed` record and
  `executionStarted: false`.
- Any handler starts: `safeToRetry: false`, even if it later reports failure.
- A timeout or unclassified execution outcome: `safeToRetry: false`, with
  `unknown`.
- A provider generation fails after a tool returns: the success result and
  call record remain available; retry/fallback must not rerun the tool.

This sprint implements no retries and does not choose another provider/model.
Future runtime composition must choose/fallback providers before the first
tool dispatch, pin the selected provider for later rounds, and stop rather
than replay the whole orchestration after `hasExecutionStarted` is true.

## Timeout and cancellation

The executor aborts its `AbortSignal` when its timer fires, but handlers may
ignore the signal and continue. A timeout therefore does not imply that work
was cancelled or that no side effect occurred. The orchestrator records the
outcome as `unknown`, preserves that uncertainty, and stops before another
generation round. The handler promise remains observed to avoid an unhandled
rejection if it settles after timeout.

## Duplicate call IDs and request identity

The orchestrator validates unique provider call IDs within a whole
orchestration request, including across rounds. Duplicate or malformed IDs
are rejected before dispatching their batch. A repeated ID after an earlier
successful call cannot execute again within that same request.

The request ID is generated by trusted application code and is distinct from
all provider-controlled IDs. It is diagnostic identity only: no persistent
execution ledger, cross-request deduplication, argument-based deduplication,
or idempotency key is added. Identical read-only calls under distinct
provider IDs remain distinct calls.

## Guarantees and non-guarantees

The orchestrator guarantees that it does not retry the whole orchestration
internally, rejects repeated provider call IDs within one request, reports
known executor lifecycle progress, preserves completed function responses,
and stops on uncertain timeout outcomes. It never trusts provider IDs as
application request identity or model data as permission context.

It does **not** guarantee exactly-once execution, cross-request idempotency,
or crash recovery. A process termination after handler dispatch can occur
before a result is returned or persisted. An injected custom executor must
implement the optional `onStarted` lifecycle signal (or return trustworthy
execution metadata) for precise transitions; otherwise the orchestrator
chooses the conservative unknown/unsafe classification.

## Remaining blockers before runtime integration

- The runtime is not wired to the orchestrator or DTO.
- No application retry/fallback controller consumes `retrySafety`; its policy
  must be implemented before runtime integration.
- No durable request/progress journal exists, so progress is lost on process
  termination.
- Cross-request idempotency is not implemented and must not be inferred from
  per-request ID checks.
- Gemini calls and multimodal behavior remain fake-client tested only; no
  live API compatibility test was performed.

## Tests and validation

`test/tool-orchestrator.test.js` now checks provider failure before and after
execution, schema validation failure, started handler failure, timeout
uncertainty, duplicate IDs across rounds, preservation of successful results,
separate per-call progress, retry-safety metadata, and the absence of an
automatic subsequent generation after timeout. `test/ai-tools.test.js` checks
the executor lifecycle signal, pre-dispatch validation metadata, and timeout
uncertainty. Existing text-only Gemini adapter tests remain unchanged.

Validation was run with Node.js **v24.22.1**:

- `npm run check` — passed.
- `node --test test/tool-orchestrator.test.js test/ai-tools.test.js`
  — passed, 36 tests.
- `npm test` — passed, 198 tests.
- `git diff --check` — passed.
