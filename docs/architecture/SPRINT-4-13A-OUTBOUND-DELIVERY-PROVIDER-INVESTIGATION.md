# Sprint 4.13A — Outbound Delivery & Provider Failure Investigation

## Audit Findings (recorded before corrections)

### Outbound result chain

The reply chain is intact: `messageService.submitReply()` awaits the transport callback; `registerQueuedMessageHandler()` passes `reply(message)` to the service; `createWhatsAppAdapters().reply(message)` returns `message.reply(text)`; and installed `whatsapp-web.js@1.34.7` `Message.reply()` returns `this.client.sendMessage(...)`. The adapter does not discard the return value.

Installed `Client.sendMessage()` returns a `Message` when WhatsApp Web returns a message model. It can return `null` for explicitly unsupported channel/status message combinations, and `undefined` when the evaluated send produces no truthy message model. The SDK does not document either as evidence of successful recipient delivery. A resolved `Message` establishes a local SDK submission result, not a delivered/read acknowledgment. A thrown send can also have an unknown side effect.

Friday logs `submitted` only for a non-null result; it logs `uncertain` for null/undefined and for thrown transport errors. Thus the reported visible reply plus `transport_uncertain` is consistent with the SDK producing no message result despite a visible side effect, or with a different log being correlated incorrectly. The callback chain contains no confirmed return-value loss. There is insufficient evidence to safely promote null/undefined to submitted or delivered. Keep uncertainty and duplicate-send protections.

The normal reply path covers deterministic commands, AI text, and text fallbacks through `message.reply()`. Media sends use `client.sendMessage()` through the media adapters and have analogous null-result uncertainty handling. Queue-full notices also use `message.reply()` and classify missing results as uncertain. No automatic resend is warranted.

### Gemini provider path

The legacy request path uses `generateWithRetry()` and `generateWithModelFallback()`. A provider attempt can complete and a later independent WhatsApp request can fail; existing logs capture attempt outcomes but omit provider/model/error metadata. A fallback failure ultimately reaches the Indonesian generic user response when its reason cannot be mapped safely. Nothing inspected proves that a prior successful request caused the later failure. Possible causes remain hypotheses until a safe provider status/code is captured for the failing attempt.

The observability layer currently emits a coarse `provider_error` for general AI-stage errors and deliberately omits provider diagnostics. The tool adapter has richer provider metadata, but production legacy conversation requests do not use that adapter. The production legacy Gemini request path does not dispatch handlers or tools; this report does not change that boundary or retry policy.

## Minimal Corrections

- Keep outbound classification unchanged: non-null SDK result means `submitted` (local submission result only); null/undefined and thrown send outcomes remain `uncertain`. This preserves the no-duplicate fallback safeguard.
- Add an adapter regression test that asserts identity preservation of the actual resolved result, and a registered-handler/service-chain test that verifies that same result reaches `submitReply` classification.
- Add allowlisted Gemini attempt diagnostics: fixed provider identifier, configured model identifier, sanitized error class, integer HTTP status, bounded safe error code, retryability only when determined from known statuses, and `handlerExecutionStarted: false` for this legacy no-tool path. Do not log error messages, stacks, headers, request/response bodies, or conversation content.
- Preserve the existing bounded retry and fallback behavior. No retries are added.

## Confirmed Findings vs. Hypotheses

| Observation | Finding | Confidence |
| --- | --- | --- |
| `reply_submission` is uncertain although the user sees a reply | The SDK promise resolved without a non-null `Message` result, or the logger entry was not correlated with that visible message. The SDK explicitly permits null/undefined branches. | Return chain and SDK behavior confirmed; which branch occurred in the live incident is unverified. |
| A prior Gemini request succeeded, then a later one failed as `provider_error` | Each request has independent provider attempts. A successful earlier request does not establish why a later attempt failed. Existing logs discarded useful safe status/model details. | Missing diagnostics confirmed; particular provider failure cause is unknown. |
| Generic fallback was sent | It is the current safe response when failure metadata does not match a more specific user-safe category. | Confirmed in current error mapping; no fallback policy change made. |

## Changes Implemented

- `getSafeProviderErrorMetadata()` extracts fixed provider ID, allowlisted model ID, error class, HTTP status, an allowlisted provider code, retryability only for known HTTP statuses, and the legacy path's `handlerExecutionStarted: false` fact. It never copies exception messages, stacks, response bodies, headers, credentials, or request data.
- Gemini attempt start/completion/failure, bounded retry, and model-fallback stages now carry these safe fields. Unknown values are omitted rather than guessed. Retry and fallback behavior is unchanged.
- The WhatsApp adapter and service callback return-value paths are covered with fake resolved message objects. A resolved result is still logged only as locally `submitted`, never as delivered/read. Null/undefined and rejected sends remain `uncertain`; existing tests confirm uncertain sends do not trigger a second fallback.
- No fix was made to outbound classification because inspection found it was already conservative and the result chain was not dropping the value. No real-world evidence supports treating an empty SDK result as success.

## Verification

- Node.js: `v24.22.1`; npm: `11.19.1`.
- Focused regression tests: 43 passed, 0 failed.
- `npm run check`: passed.
- `npm test`: 337 passed, 0 failed, 0 skipped, 0 cancelled. Two new diagnostics tests were added; existing conversation tests cover successful AI stage completion, provider failure, null/throwing transport results, and no duplicate fallback after uncertainty.
- `git diff --check`: passed.
- No dependencies, lockfiles, or database schema changed in this sprint.
- Files changed in this sprint: `src/application/conversation-observability.js`, `src/application/message-service.js`, `src/friday-runtime.js`, `test/conversation-observability.test.js`, `test/message-adapter.test.js`, and `docs/architecture/SPRINT-4-13A-OUTBOUND-DELIVERY-PROVIDER-INVESTIGATION.md`.
- Final Git status contains those five modified tracked files and the new untracked report. Previously completed WhatsApp duplicate-binding hotfix files are not modified by this sprint.
- Live WhatsApp and Gemini behavior are not verified by fake tests. The hotfix from the previous sprint remains as-is; no WhatsApp dependency patch or `node_modules` file was changed in this sprint.
