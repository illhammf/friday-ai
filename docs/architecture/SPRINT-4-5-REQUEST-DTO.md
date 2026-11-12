# Sprint 4.5 — Request DTO and Multimodal Contract

## Status and scope

This sprint adds a provider-independent, validated request DTO and updates the
isolated Gemini tool adapter to translate it. It does **not** connect the DTO
or adapter to `askFriday()`, WhatsApp, database history, memory retrieval, or
the live Gemini client. Voice transcription, sticker routing, image
generation, retry behavior, and message delivery are unchanged.

## DTO structure

`createAssistantRequest()` in
[`assistant-request.js`](../../src/ai/assistant-request.js) returns an
immutable, versioned value:

```js
{
  version: 1,
  modelInput: {
    systemInstruction: '...',
    conversationStyle: '...',
    memoryContext: [{ category: 'preference', content: '...' }],
    history: [
      { role: 'user', parts: [{ type: 'text', text: '...' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '...' }] },
    ],
    currentMessage: {
      role: 'user',
      parts: [
        { type: 'text', text: '...' },
        { type: 'image', mimeType: 'image/jpeg', data: '<base64>' },
      ],
    },
  },
  metadata: { conversationType: 'private' },
}
```

Only the limited `conversationType` (`private` or `group`) is represented in
application metadata. Session IDs, sender identity as trusted context, and
tool permissions are not accepted as DTO fields. Unknown top-level input
fields are rejected. A group request containing any private memory entries is
rejected. For a group, the untrusted display name is prepended to the visible
question (`senderName: question`); the name is not sent as trusted metadata.

## Runtime and history mapping

The factory accepts the current runtime's request components separately:
question, optional `{ mimetype, data }` image, database history, current
system instruction, style instruction, memory records, and a conversation
kind. A future runtime integration can derive `conversationType` from the
trusted `sharedGroupSession` decision, use only that session's history, and
pass memory records only for a private session. This mapping is not wired in
this sprint.

Database history records `{ role, parts: [{ text }] }` are normalized
explicitly and kept in order: `user` remains `user`; database `model` and
application `assistant` become `assistant`. Each message may have up to eight
text parts. Unknown roles, non-text history parts, empty/malformed part lists,
and over-limit histories are rejected rather than silently discarded.
History is capped at ten messages, matching the current `loadHistory(..., 10)`
use. Voice remains compatible through its existing transcription-to-question
path; audio DTO parts are not supported.

The question is the first current-message part. If present, an image is the
next part, retaining text-before-image order. An image-only request receives
the existing fallback prompt, “Tolong jelaskan gambar ini.”

## Limits and validation

| Input | Limit |
|---|---:|
| History messages | 10 |
| Parts per history message | 8 |
| Aggregate history text | 64 KiB |
| Current question | 16 KiB |
| System instruction | 48 KiB |
| Conversation style instruction | 8 KiB |
| Memory entries | 5 |
| Each memory content | 500 characters |
| Encoded image | 5 MiB decoded |
| Aggregate serialized DTO | 8 MiB |

Supported image MIME types are `image/jpeg`, `image/png`, and `image/webp`.
Data must be canonical base64 and within the decoded byte limit. The factory
checks the complete serialized request size after applying field limits.
Image bytes and memory text are never logged by this module or adapter.

## Memory and privacy

Memory records are reduced to `{ category, content }`; storage IDs, source, and
timestamps are intentionally omitted. Categories are validated against the
existing application categories and content is revalidated by the existing
memory policy (including its sensitive-value filter). The Gemini adapter adds memory only to the
request's per-call system instruction with an explicit untrusted-data warning;
it is never placed in user conversation history. The `conversationType`
metadata is used to enforce the group-memory boundary and is not sent to
Gemini. Retrieved memory is still untrusted user-written context and is not
authority to change system rules.

The DTO does not establish trusted identity or authorization. Runtime
integration must retain those values in application-owned state and must not
derive them from model input or model output.

## Gemini mapping

`createGeminiToolGenerator()` accepts a version-1 DTO in its existing `input`
argument. It maps:

- DTO `user` history to Gemini `user`, and `assistant` history to Gemini
  `model`, preserving order and text parts.
- DTO text parts to `{ text }` and image parts to
  `{ inlineData: { mimeType, data } }`.
- The request's system instruction, style, and explicitly labeled untrusted
  memory to a per-generation `config.systemInstruction`. This is composed per
  call; the generator does not capture request-specific values.
- Existing function-call/function-response history after the conversation
  and current user message, preserving the existing round reconstruction.

Legacy string and `{ role, text }` inputs remain supported for existing
text-only tool-adapter callers. Function calling still uses declarations
provided for each generator call and SDK automatic function execution remains
disabled. The orchestrator remains provider-independent.

## Security boundaries and limitations

- DTO validation rejects unsupported roles/parts, malformed images, unsafe
  accessor properties, unexpected DTO keys, oversized fields, and group
  requests with private memory.
- The adapter revalidates the DTO before provider translation; DTO metadata is
  not copied into Gemini content.
- The request factory and adapter do not log image data, memory content, tool
  arguments, or tool results.
- This is a contract foundation, not a proof of image-model/provider
  compatibility. Tests use an injected fake generation function; no provider
  request was sent.
- Runtime history currently stores text only. Historic multimodal items and
  reconstructed tool-call history are not represented in this DTO history
  mapper. The adapter's existing separate function-response reconstruction is
  retained.
- No retries/fallback safety changes are included. In particular, safe
  fallback after a tool has executed remains a later integration concern.
- Audio input, image generation, WhatsApp media download/delivery, and live
  runtime assembly are outside this sprint.

## Tests and validation

Focused tests are in
[`assistant-request.test.js`](../../test/assistant-request.test.js), alongside
the existing Gemini adapter tests. They cover DTO immutability, database
role/order mapping, multimodal ordering and MIME/data validation, limits,
group/private memory boundaries, dynamic system instruction changes, memory
labeling, Gemini image-part conversion, disabled automatic function execution,
and import safety. Existing adapter tests continue to exercise text-only
generation and tool-call history.

Validation was run with Node.js **v24.22.1**:

- `npm run check` — passed.
- `node --test test/assistant-request.test.js test/gemini-tool-adapter.test.js`
  — passed, 21 tests.
- `npm test` — passed, 190 tests.
- `git diff --check` — passed.
