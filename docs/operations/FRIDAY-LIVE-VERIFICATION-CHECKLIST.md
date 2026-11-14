# Friday Live Verification Checklist

This is a manual checklist for the project owner. **No live WhatsApp or Gemini tests have been performed as part of this sprint.** Update a result only after personally running the test and recording safe evidence. Never include credentials, QR codes, phone numbers, session IDs, message bodies, or private memory in evidence.

## Verification status

- **Automated tests:** 331 passed under Node `v24.22.1` in the recorded automated run; this verifies fakes/local behavior only.
- **Manual tests awaiting owner:** all test IDs below are `AWAITING OWNER`.
- **Manual tests completed by owner:** none recorded by this report.

For evidence, record a generic observation such as “terminal showed ready” or “one reply appeared”; do not paste raw logs or private chat content. Use `PASS`, `FAIL`, or `BLOCKED/DEFERRED`; include date/time and a brief redacted note. Do not mark a test passed based only on automated tests.

| Test ID | Preconditions | Owner action | Expected behavior | Observable evidence to record | Result | Notes |
|---|---|---|---|---|---|---|
| LIVE-01 Connection and ready | Node 24+, `npm run doctor` has no required errors, `.env` configured locally, trusted phone and terminal available | Run `npm start`; if requested, scan the QR using WhatsApp Linked devices | WhatsApp authenticates and Friday displays its ready/online state; no secret is printed | Ready message observed; do not save/share QR or raw logs | AWAITING OWNER |  |
| LIVE-02 `/help` | LIVE-01 ready; private test chat | Send `/help` | Concise Indonesian help response; no Gemini dependency | One help response appears; no AI conversation turn expected | AWAITING OWNER |  |
| LIVE-03 `/ping` and `/about` | LIVE-01 ready; private test chat | Send `/ping`, then `/about` | Deterministic responses; `/ping` responds without Gemini | One response for each command | AWAITING OWNER |  |
| LIVE-04 Normal text | LIVE-01 ready; Gemini key/model access checked; private test chat | Ask a simple non-sensitive question | Friday returns a safe conversational answer | Answer appears; terminal shows AI/reply stages without content | AWAITING OWNER |  |
| LIVE-05 Sequential continuity | LIVE-04 succeeded | Send a follow-up that relies on the previous turn, then another ordinary question | Turns are processed sequentially and recent context is usable | Replies appear in order; no duplicate answer | AWAITING OWNER |  |
| LIVE-06 Explicit private memory | Private test chat; do not use sensitive facts | Explicitly ask Friday to remember a harmless preference, then ask it to recall saved memory | Memory is saved/recalled only through explicit private command behavior | Confirmation and recall observed; evidence must not include the preference itself | AWAITING OWNER | Clear the test memory afterward if desired and verify removal without recording its content | 
| LIVE-07 Private/group isolation | A test group whose members understand the test; LIVE-06 completed with harmless value | Ask a prefixed group question related to memory; then send a normal private question | Group receives no private memory; private session remains separate | Group answer does not reveal the saved private value; private chat still works | AWAITING OWNER | Do not use real confidential memory as the test value | 
| LIVE-08 Group command prefix | LIVE-01 ready; authorized test group | Send `/ping` without prefix, then `Friday, /ping` (or configured `BOT_NAME`) | Unprefixed group command is ignored; prefixed command responds once | No reply to first message; one ping reply to prefixed message | AWAITING OWNER |  |
| LIVE-09 Image input | LIVE-01 ready; image model access checked; non-sensitive image | Send a test image with a simple question | Friday processes image through existing assistant route | One answer appears; no private image content in evidence/log excerpt | AWAITING OWNER |  |
| LIVE-10 Voice Note input/reply | `ffmpeg` available; voice/Gemini access available; harmless short test | Send a short voice note and request a voice reply if desired | Friday transcribes and responds; a text fallback may be used if voice generation fails before sending | One response route observed; do not retry if a send outcome is uncertain | AWAITING OWNER |  |
| LIVE-11 Supported media | Relevant `ffmpeg`/`yt-dlp` prerequisites installed; authorized non-sensitive image or public test video | Try one sticker request and, separately, an explicitly requested accessible public video download | Supported feature completes; unsupported media produces a safe failure response | Result observed for each attempted feature | AWAITING OWNER | Do not use private/login-restricted media or content without permission | 
| LIVE-12 Gemini provider failure | Only during an owner-approved, isolated test configuration or a naturally occurring outage; never modify/share the production key for this test | Observe a controlled provider failure, if safely available; do not repeatedly submit requests | Friday returns a concise safe Indonesian failure after existing bounded fallback behavior; no key/stack/provider details appear in WhatsApp | Safe failure response and redacted provider category observed | AWAITING OWNER | If no safe controlled setup exists, mark BLOCKED/DEFERRED; do not induce failure by corrupting the normal `.env` | 
| LIVE-13 WhatsApp transport failure/uncertain send | Only if a natural or owner-approved controlled failure occurs; no bulk or unsolicited messages | Observe one affected send; check destination chat before considering any resend | Friday does not send a second full fallback for an uncertain result; no delivery/read guarantee is inferred | At most one apparent response; sanitized uncertain transport stage if available | AWAITING OWNER | Do not deliberately disrupt the network just to force ambiguity; never resend until checked | 
| LIVE-14 Graceful shutdown and restart | No test message currently processing; terminal running Friday | Press Ctrl+C once; wait for shutdown completion; then start Friday once more | Queue drains, client closes, DB closes, process exits; restart reuses auth or requests local QR if needed | Safe shutdown message/process exit, then new ready state | AWAITING OWNER | If shutdown reports a queue timeout, follow the runbook; do not start another instance while process remains alive | 

## Owner completion record

Fill this section after manual work. Keep it redacted.

- Date/time window:
- Node version:
- Tests passed (IDs):
- Tests failed (IDs):
- Tests blocked/deferred (IDs and reason):
- Sanitized operational notes:
- Confirmed no secrets, QR data, personal identifiers, or private message content are included: YES / NO

## Stop conditions

Stop the manual run and follow the runbook if authentication state is unexpected, the application requests removal/recreation of local data, shutdown remains stuck, a response may have been sent but its status is uncertain, or a group response exposes private data. Do not enable tools or change identity/authorization settings to complete this checklist.
