# Sprint 4.8B — State-Aware Provider Policy

## Status and scope

This sprint adds an application-level, decision-only provider policy for
isolated tool orchestration. It selects a provider/model and pins one generator
per selection. It can explicitly authorize constructing the next pinned
provider selection only when the caller provides a recognized retryable
provider-generation failure, a valid request, and structured progress proving
no handler has started and no outcome is uncertain.

The policy never invokes an orchestrator, automatically retries generation,
or runs a fallback. It is not connected to `friday-runtime.js`; legacy text
generation, WhatsApp routing, tools, grants, persistence, and media behavior
are unchanged. Tests use fake providers/handlers only.

## Provider-selection contract

The application injects an ordered list of provider/model candidates:

```js
const policy = createToolProviderPolicy({
  providers: [
    {
      providerId: 'google-gemini',
      modelId: 'model-primary',
      createGenerator: () => createPinnedGenerator(),
    },
    {
      providerId: 'google-gemini',
      modelId: 'model-backup',
      createGenerator: () => createBackupGenerator(),
    },
  ],
  maxProviderAttempts: 2,
});

const session = policy.createSession();
const selection = session.selectInitial();
// The caller passes selection.generator to exactly one orchestrator.
```

Provider IDs and model IDs must be non-empty and unique as a pair.
`createGenerator()` is called once when a candidate is selected. The returned
selection contains provider/model IDs, one-based attempt number, and one
immutable pinned generator function. Every call to that generator forwards to
the same captured generator. The policy does not choose a different model
between function-calling rounds.

The caller owns one orchestration lifecycle. On an error, the caller may ask
`session.assessNext({ failure, executionProgress, requestValid: true })` for
an eligibility decision. If eligible, the caller explicitly invokes
`session.selectNext(...)` with the current structured evidence. The method
re-evaluates all guards before creating the next generator. It returns a
selection only; the caller must not interpret this as an instruction to retry
every error or to ignore partial execution history.

Each orchestration must use a new policy session. A switch is a new
pre-execution orchestration attempt, not a way to resume or re-run an
orchestration that has already dispatched a handler.

## Retry and provider-switch eligibility

The decision is eligible only when all conditions hold:

1. An initial provider is selected, and an alternate candidate and attempt
   budget remain.
2. The caller passes `requestValid: true`. Unknown or invalid request status
   is denied.
3. Structured progress exists and contains boolean
   `hasExecutionStarted`/`hasUncertainOutcome` values and a call-record array.
4. No call record indicates `executionStarted` or `state: 'unknown'`;
   no call record is in the `failed` state (including unknown-tool,
   validation, or permission failures);
   progress does not report any started or uncertain work; and, when present,
   `retrySafety.safeToRetry` is not false.
5. The failure is structured as provider generation failure
   (`kind: 'provider', code: 'GENERATOR_FAILED'`, or typed adapter code
   `GEMINI_GENERATION_FAILED`) and carries provider metadata with
   `retryable: true`.
6. Provider/model identity in the failure matches the currently selected
   provider/model.

`retrySafety.safeToRetry` by itself is insufficient. A provider-like message
or status text is also insufficient. Permission denial, input/schema
validation, unknown tools, malformed provider output/history, and any
non-provider error are denied even when nothing started. A recognized
retryable provider error also does not qualify if the same orchestration has
already recorded a failed tool call. An invalid request,
unknown progress, mismatched provider identity, exhausted budget, or missing
alternate candidate is denied.

The only currently recognized retryable numeric provider statuses are 429,
500, 502, 503, and 504. The adapter does not infer a status from provider
message text or enum-like strings; absent/unknown status is not retryable.
This is conservative metadata for policy decisions, not a live-service
guarantee that retrying is useful.

## Pinning, dispatch, and partial execution

- The selected generator object is fixed for all rounds in one orchestration.
- A new provider/model can be selected only after `assessNext` confirms
  pre-dispatch failure and `selectNext` rechecks the supplied evidence.
- The policy has no orchestrator dependency and never calls `run()`.
- After any handler starts, the caller must stop. No full orchestration replay
  or provider/model switch is permitted.
- If an earlier tool completed and a later generation fails, successful
  function responses and progress remain on the structured failure. That
  progress denies provider switching.
- If a handler times out or execution is unknown, the decision is denied and
  retry safety remains false.
- No cross-request idempotency or exactly-once execution is provided.

The caller must validate input before setting `requestValid: true`, retain
partial results, and honor the denial reason. This module does not automatically
repeat generation and cannot independently prove that arbitrary caller-supplied
progress is truthful.

## Structured provider errors

`GeminiToolAdapterError` now has a typed `kind`. A transport/generation error
is `kind: 'provider'`, retains the original exception as `cause`, and carries
bounded structured `providerFailure` metadata:

```js
{
  providerId: 'google-gemini',
  modelId: 'model-primary',
  status: 503,
  code: 'UNAVAILABLE',
  retryable: true,
}
```

Malformed Gemini responses and invalid adapter input remain protocol failures
and have no retryable provider metadata. `ToolOrchestrationError` preserves
the generator cause and provider-failure metadata while continuing to expose
the existing progress and function responses. `ToolAssistantError` carries
that structured provider metadata and retains the orchestration error as its
cause. Provider diagnostics do not replace the safe, generic error messages.

Generic injected generators that throw without typed provider metadata remain
provider-kind orchestration failures but are not eligible for switching.
This avoids guessing whether a failure is transient.

## Why legacy retry/fallback remains outside

`src/friday-runtime.js` uses `generateWithRetry()` and
`generateWithModelFallback()` for its existing text-only assistant path.
Those functions do not consume orchestration progress, and the Gemini tool
adapter/orchestrator has a distinct structured error contract. Wrapping the
whole tool orchestration in those legacy loops could restart tool calls after
dispatch. They remain unchanged and outside the tool pipeline. Sprint 4.8B
does not modify `askFriday()` or call the legacy retry functions.

## Known limitations and Sprint 4.8C prerequisites

- The decision relies on the application caller supplying truthful structured
  progress and request-validity state. No runtime composition currently
  supplies this policy.
- Selecting an alternate generator does not itself rerun orchestration; the
  future caller must explicitly own pre-execution retry limits and lifecycle.
- Only numeric provider status metadata is classified; provider-specific
  structured error shapes not captured by the adapter are conservatively
  denied.
- Live Gemini compatibility has not been tested or claimed.
- Group and multimodal orchestration remain out of scope.

Before Sprint 4.8C can route any WhatsApp request, define and test the runtime
owner of policy sessions, validated-request state, selection decisions,
structured partial-failure handling, and one-time persistence. Add no tool
grants or runtime routes until that boundary has tests proving it cannot retry
or switch after dispatch or uncertain execution.

Sprint 4.8B stops here; it does not begin runtime integration.
