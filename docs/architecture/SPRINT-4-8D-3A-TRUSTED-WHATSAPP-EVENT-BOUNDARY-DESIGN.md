# Sprint 4.8D.3A — Trusted WhatsApp Event Boundary Design

## 1. Executive summary

This is a design-only audit of the current WhatsApp event path and a proposal
for a separate, future application-trusted event boundary. No source code,
tests, runtime routes, or WhatsApp behavior were changed.

The current legacy adapter converts a raw `whatsapp-web.js` message into a
normalized message inside the per-chat queue task. It classifies a message as
`group` only when `from` ends in `@g.us`, and classifies every other non-empty
`from` as `private`. For groups it uses `author || from` as `senderId`, so a
missing participant identity becomes the group chat ID. It omits direction
and category evidence such as `fromMe`, `isStatus`, and `broadcast`.

The installed `whatsapp-web.js@1.34.7` source exposes useful positive signals
for some categories, but does not establish a complete, stable private-chat
classification or identity-canonicalization contract. A resolved
`PrivateChat` alone is not sufficient evidence: `ChatFactory` returns
`PrivateChat` as its default when neither `isGroup` nor `isChannel` is set.
Therefore an unknown or unsupported event must remain `unknown`; it must not
be promoted to private by absence of another signal.

**Sprint verdict: CONDITIONALLY READY for boundary design only.** A
production trusted identity boundary, private pilot, and production tool
execution remain **NOT READY**. Existing legacy behavior remains unchanged
and outside the proposed trusted path.

## 2. Scope and evidence labels

This report distinguishes:

- **Observed:** behavior read from the current checkout or installed
  dependency source.
- **Proposed:** a future contract, not implemented in this sprint.
- **Unresolved:** a behavior or identity guarantee that the inspected
  sources do not establish.

The design is intentionally separate from `friday-runtime.js`, the legacy
message service, the Gemini adapter, the tool orchestrator, and the executor.
No live WhatsApp client was started.

## 3. Existing raw-to-normalized message flow

### 3.1 Event registration and queue

**Observed:** `friday-runtime.js` creates the WhatsApp client and calls
`registerQueuedMessageHandler()` from `configureClient()`. That function
registers a listener for the `message` event, not `message_create`.

In the installed `whatsapp-web.js@1.34.7` `Client.js`, the client constructs a
`Message`, emits `message_create`, returns when `msg.id.fromMe` is truthy,
and otherwise emits `message`. Friday's queue helper also rejects a truthy
`message.fromMe`, missing/falsy `from`, unsupported empty-content types, and
group text without the configured Friday prefix. It does not require
`fromMe === false`.

After admission, the handler claims a deduplication key and enqueues by the
raw `message.from` value. The queued task calls the adapter normalizer on the
original SDK message, then passes that result and a reply closure bound to
the original message to `message-service`.

### 3.2 Exact normalization point and data handling

**Observed:** the raw-to-normalized transition occurs inside the queued task
in `registerQueuedMessageHandler()`:

```text
client "message" event
  -> queue admission and deduplication
  -> per-chat queue keyed by raw message.from
  -> normalize(raw SDK Message)
  -> message-service.handle(normalizedMessage, replyTransport)
```

The legacy normalizer currently behaves as follows:

| Raw field or source | Legacy normalized result | Transformation, omission, or inference |
|---|---|---|
| `message.from` | `chatId` | Copied as-is after requiring a non-empty string. Not validated or canonicalized. |
| `message.from` and suffix | `chatType` | `@g.us` means `group`; every other non-empty string means `private`. This is a local heuristic, not exhaustive classification evidence. |
| `message.from`, `message.author` | `senderId` | Private uses `from`; group uses `author || from`. Empty/missing group author therefore falls back to the group chat ID. |
| `message.id` | `messageId` | Uses string ID, `_serialized`, `$1`, or a locally composed fallback. This is message/deduplication data, not sender identity. |
| `message.body` | `text`, sometimes `caption` | String body is trimmed; caption is copied only for image messages. |
| `message.timestamp` | `timestamp` | Number is copied; non-empty string is converted with `Number()`; other values become `NaN`. |
| `message.type` | `messageType` | String copied; otherwise `'unknown'`. |
| `message._data.notifyName` | `group.senderName` | Used only as display metadata; missing values become `'Anggota grup'`. |
| `hasMedia`, `type`, selected `_data` fields | `media` | Exposes a download closure over the original SDK message and a restricted diagnostics object. The raw message is not copied as a public property. |
| `message.fromMe`, `id.fromMe` | Not preserved | Direction is not part of the normalized message. Queue admission checks only truthiness of `message.fromMe`; the SDK event path separately filters `id.fromMe`. |
| `message.isStatus`, `message.broadcast`, chat category flags | Not preserved | The legacy normalized object cannot distinguish these categories downstream. |
| `message.author` | Not preserved separately | It is collapsed into `senderId`, including the group-ID fallback. |

`message-service` treats only `chatType === 'group'` as a group; other values
take its private branch. It derives `privateSessionId(senderId)` for every
accepted message, including group messages. For groups it also derives a
shared group session from `chatId`. The legacy active-session lock uses the
private session value. The session helpers only add `private:` or `group:`
prefixes; they do not validate or canonicalize identities.

The service's group prefix behavior, memory restrictions, and specialized
image, voice, sticker, video, image-generation, and history paths remain
legacy behavior. This design does not change or re-route them.

## 4. Proposed explicit conversation classification

### 4.1 Classification values

**Proposed:** every event receives exactly one category:

```text
private | group | broadcast_status | channel | unknown
```

Classification describes conversation type only. It does not establish
sender identity, direction, canonicalization, provenance, or authorization.

### 4.2 Positive evidence required

| Category | Proposed evidence required | Insufficient evidence |
|---|---|---|
| `group` | An explicit trusted chat-category signal such as a resolved chat with `isGroup === true`, or a non-empty raw `author` field consistent with the dependency's documented group-sender role. Conflicting evidence yields `unknown`. | `from` ending in `@g.us` alone is not a complete classification contract. |
| `channel` | An explicit trusted chat-category signal such as a resolved chat with `isChannel === true`. | Any unrecognized `from` string, or the absence of `@g.us`. |
| `broadcast_status` | A positive message signal such as `isStatus === true` or `broadcast === true`, with no conflicting positive category signal. | A status/broadcast flag being absent or false does not imply private. |
| `private` | A positive, version-supported direct-private category result whose semantics are established for the exact event path. It must not be a default/fallback classification. | `from` not ending in `@g.us`; `author` being absent; false/absent group or channel flags; a `PrivateChat` instance produced by `ChatFactory` fallback. |
| `unknown` | Default when required evidence is absent, malformed, unsupported, or ambiguous. | Must never be converted to private merely to keep the event flowing. |

**Observed dependency limitation:** `Message` exposes `isStatus` and
`broadcast`; `Message.getChat()` resolves a chat through the client. The
installed `ChatFactory` selects `GroupChat` when `data.isGroup` is truthy,
`Channel` when `data.isChannel` is truthy, and otherwise returns
`PrivateChat`. That default means the returned class alone does not establish
positive private evidence. The exact reliable event-time signal for private
classification remains unresolved.

If multiple positive signals conflict (for example, both group and channel,
or status and group), the result is `unknown`. False, missing, or malformed
flags do not become positive evidence for another category. This policy
keeps unsupported cases explicit instead of relying on suffix guessing.

## 5. Proposed message direction contract

The separate trusted event records:

```text
incoming | self | unknown
```

**Proposed rules:**

- `self` is recorded when the available direction signals consistently say
  `true`.
- `incoming` requires an explicit boolean `false` direction signal from the
  raw event (`message.fromMe` and/or `message.id.fromMe`) and no conflicting
  boolean signal.
- Missing, non-boolean, or conflicting direction values produce `unknown`.
- Only `incoming` can be considered for future privileged eligibility.
- Direction remains independent from conversation category. For example, a
  self-authored event can be known to target a private chat, but it is still
  ineligible.

The current SDK `message` event filters ordinary self-authored events using
`id.fromMe`; the legacy queue also rejects truthy `message.fromMe`. Neither
guarantee replaces preserving direction in a new boundary. Existing queue
behavior must not be changed by this design.

## 6. Chat and sender identity separation

**Proposed:** use role-specific fields rather than a generic identity string:

- `chat.rawId`: raw remote/chat identifier from the event, if structurally
  available. It remains unverified.
- `sender.rawId`: a role-specific candidate, or `null`.
- `sender.role`: `private_sender_candidate` or
  `group_participant_candidate`.
- `display.name`: optional, untrusted presentation metadata only.

Rules:

1. For a positively classified incoming private message, chat and sender
   candidates may originate from the same raw `from` value, but they remain
   separately labeled fields and are not yet canonical or verified.
2. For a group, `chat.rawId` is the group conversation ID. A participant
   candidate can come only from an explicitly available `author`.
3. Missing, empty, non-string, or malformed group `author` means no sender
   candidate. Never substitute the group ID.
4. `from`, `author`, `id.remote`, and `id._serialized` are not interchangeable.
5. Display names, phone-like text, message body/caption, model output, and
   tool arguments are never identity sources.
6. The installed package does not establish an exhaustive accepted ID format
   or stable LID/phone canonicalization contract. Raw candidates therefore
   cannot be promoted to a canonical principal in this sprint.

The proposed role-specific names prevent accidental field confusion in
application code; they do not validate the underlying strings by themselves.

## 7. Provenance and trust model

### 7.1 Trust stages

| Stage | Meaning | Does not establish |
|---|---|---|
| Raw external event | The SDK `Message` object received by the client event listener. All fields are external values. | Valid categories, valid/canonical identity, or authorization. |
| Adapter-derived event | A separate adapter has extracted fields and recorded the evidence used for classification/direction. | Identity validity or trusted provenance merely because fields look well-formed. |
| Structurally validated event | Primitive shapes and required fields pass strict checks; ambiguity remains explicit. | That an identifier is valid, canonical, or bound to the right account/person. |
| Application-boundary event | An event was created by the application-owned boundary handling the captured WhatsApp client event. | WhatsApp identity proof, canonicalization, a grant, or tool permission. |

### 7.2 Proposed non-plain-object provenance mechanism

**Proposed:** keep provenance out of user-controlled fields. The future
boundary should:

1. Be owned by the application composition root and close over the actual
   client instance it creates.
2. Keep the event constructor/issuer private to the boundary module; do not
   export a public `createTrustedEvent(plainObject)` function.
3. Copy only explicitly supported primitive fields into a new immutable
   record; do not expose the SDK object, its prototype, or mutable nested
   structures.
4. Associate the immutable record with provenance using a module-private
   `WeakMap`/`WeakSet` (or an equivalent closure-held capability), rather
   than a forgeable string property or exported symbol.
5. Require provenance membership at the future trusted-context builder.
   Cloning, serialization, or reconstructing the object loses the mark and
   must fail closed.

This mechanism can distinguish events created by the owned boundary from
plain objects supplied through message content, request DTOs, or unrelated
callers. It is not a sandbox against malicious code already executing in the
same Node.js process, compromise of the composition root, or an attacker able
to control the client/boundary callback. Provenance is not identity
validation.

## 8. Proposed trusted application event schema

This is a conceptual schema only. The provenance mark is held out-of-band
and is not a JSON field.

```text
{
  version: 1,
  classification: {
    category: 'private' | 'group' | 'broadcast_status' | 'channel' | 'unknown',
    direction: 'incoming' | 'self' | 'unknown',
    evidence: ['explicit_private_category' /* enumerated internal evidence */],
  },
  chat: {
    category: 'private' | 'group' | 'broadcast_status' | 'channel' | 'unknown',
    rawId: 'unverified raw value or null',
  },
  sender:
    | { role: 'private_sender_candidate', rawId: 'unverified raw value' }
    | { role: 'group_participant_candidate', rawId: 'unverified raw value' }
    | null,
  display: { name: 'untrusted display name or null' },
  message: {
    id: 'message/deduplication value or null',
    type: 'string or unknown',
    text: 'string',
    caption: 'string',
    timestamp: 'finite number or null',
  },
}
```

The schema deliberately has no generic `principalId`, `sessionId`,
`grantedCapabilities`, or `authorizedTools` field. A raw candidate is not a
verified identity. When a future evidence-backed identity validator exists,
it must return a distinct typed result; it must not mutate a candidate into a
trusted principal in place.

The event must not contain the raw SDK `Message`. Media/reply operations that
need SDK objects remain on the existing legacy path and are not exposed as a
privileged tool authorization input.

## 9. Future authorization integration points

No integration is made now. A later application-owned flow should be:

```text
owned WhatsApp client event
  -> boundary classification and direction
  -> provenance and structural checks
  -> private + incoming eligibility gate
  -> evidence-backed identity validation/canonicalization
  -> derive private principal and session from the same canonical value
  -> create trusted runtime context inside application composition
  -> current authorization policy and grant lifecycle
  -> tool assistant/orchestrator/executor
```

The following existing module boundaries matter:

- `trusted-runtime-context.js` accepts a plain object and validates its
  allowed fields, sender validator, and session relationship. It does not
  establish event provenance.
- `tool-authorization-policy.js` denies group/unknown types, checks identity
  and session dependencies, and calls `getTrustedPrincipalId()` without
  event input. That is not a per-event identity binding.
- `tool-grant-lifecycle.js` evaluates an application-supplied principal,
  scope, capabilities, revision, and clock. It does not validate WhatsApp
  events or establish principal provenance.
- `tool-assistant.js` receives an injected trusted-context factory. Its
  direct API does not prove that an arbitrary caller's `applicationContext`
  came from the WhatsApp boundary.

Before any future tool route, a private trusted-context builder must consume
only a provenance-marked event and application-owned identity-resolution
results. The exact same verified canonical identity must feed sender
validation, principal resolution, and private session derivation. The
builder must keep group, channel, broadcast/status, unknown, self, missing
identity, and failed/ambiguous validation ineligible.

This design does not create that validator, builder, grant source, production
tool registration, or route. Production tool execution remains disabled.

## 10. Legacy compatibility requirements

No existing behavior is changed in this sprint. Any later implementation
must preserve or separately approve regression coverage for:

- The existing `message` event listener, self-message filtering, group
  prefix handling, and per-chat queue key/capacity/order.
- Deduplication and retry after queue rejection.
- Private/group message handling, history, session isolation, and memory.
- Image analysis and generation, voice transcription/replies, sticker
  handling, and social-video download routing.
- Existing response formatting, reply transport, and failure handling.

The future trusted boundary must initially be separate from legacy
normalization and must not route legacy messages, media, groups, or
specialized requests into the tool assistant. Correcting legacy identity
fallback or category behavior would require an explicitly scoped migration
and compatibility review; this report does not silently prescribe such a
change.

## 11. Security scenario matrix

“Legacy impact” describes current behavior if the event reaches the legacy
listener. “Privileged eligibility” describes the proposed future path, not
an active production path. Every row is denied privileged eligibility under
the current evidence and integration state.

| Scenario | Expected category / direction | Identity availability | Provenance | Legacy behavior impact | Future privileged eligibility |
|---|---|---|---|---|---|
| 1. Valid incoming private message | `private` only with positive, supported private-category evidence; `incoming` only with explicit non-conflicting `fromMe === false` evidence; otherwise `unknown` for the missing part | Raw private sender candidate may be `from`; no canonical identity is available | Boundary-marked only if received through the owned client listener | A non-`@g.us` `from` is currently treated as private and processed as before | Denied until category contract, identity validation, grant source, and runtime gates exist |
| 2. Incoming group message with participant `author` | `group` on positive group evidence; `incoming` only on explicit direction evidence | `author` is a group-participant candidate; `from` is the group chat ID | Boundary-marked only on the owned path | Usually queued only when Friday-prefixed; existing group path continues | Denied; groups are not eligible for private authorization |
| 3. Incoming group message with missing `author` | `group` only if positive group evidence; otherwise `unknown`; direction independent | Participant identity is absent; group chat ID remains chat-only | Boundary-marked only on the owned path | If `from` ends in `@g.us`, normalizer sets `senderId = from`, and service computes a private session from it; this legacy behavior is unchanged | Denied; never substitute group ID |
| 4. Self-authored private message | Category requires independent evidence; direction `self` | No incoming sender candidate | May be an owned `message_create` event, but not eligible | SDK does not emit it on `message` when `id.fromMe` is true; queue also rejects truthy `fromMe` | Denied |
| 5. Self-authored group message | Category requires independent evidence; direction `self` | No incoming participant candidate for authorization | May be an owned `message_create` event, but not eligible | Same SDK and queue self-message filters | Denied |
| 6. Missing `fromMe` direction evidence | Category may be independently known; direction `unknown` | Raw candidate may exist but cannot be treated as incoming identity | Can be boundary-marked; provenance does not repair missing direction | Queue rejects truthy `fromMe`, not missing values; direct/malformed events may be normalized and handled | Denied |
| 7. Missing `from` | `unknown` / unusable; direction may be independently known or unknown | No chat or sender candidate | Raw event only; no valid trusted application event | Queue rejects missing/falsy `from`; normalizer returns `null` | Denied |
| 8. Empty group sender (`author`) | `group` only with positive evidence; direction independent | Participant identity absent | Boundary-marked only on owned path | `author || from` falls back to group ID | Denied; no fallback |
| 9. Unknown remote identifier format | Category determined only by positive category evidence; format alone leaves it `unknown`; direction independent | Non-empty value is still an unverified raw candidate, not canonical | Boundary mark says only where the record came from | Any non-`@g.us` value currently becomes private; unfamiliar non-empty strings can pass normalization | Denied; no regex or suffix guess |
| 10. Broadcast/status event | `broadcast_status` only on positive status/broadcast evidence; conflict yields `unknown` | No private sender candidate | Boundary-marked only on owned path | Category flags are omitted by the legacy normalizer; a non-group `from` may follow the private path | Denied |
| 11. Channel event | `channel` only on positive trusted channel evidence; otherwise `unknown` | No private sender candidate | Boundary-marked only on owned path | No channel category is preserved; non-group `from` can follow the private path | Denied |
| 12. Unknown conversation category | `unknown`; direction independently classified | No private identity candidate | May be boundary-marked, but remains unknown | Legacy adapter maps non-`@g.us` values to private | Denied |
| 13. Conflicting category evidence | `unknown`; direction independently classified | No identity candidate is eligible | Boundary-marked only as an ambiguous event | Legacy suffix heuristic selects group/private without detecting conflict | Denied |
| 14. Malformed raw event | `unknown`; direction unknown unless independently well-formed | No validated candidate | Not application-trusted unless produced and accepted by the boundary; malformed records are rejected | Queue/normalizer reject some malformed values, but non-empty malformed strings may pass | Denied |
| 15. Display name supplied without sender identity | Category/direction require independent evidence | No sender candidate; display name is untrusted | Provenance does not make display data an identity | Group display name is presentation metadata; missing names use a fixed label | Denied; never infer identity from display name |
| 16. Forged normalized object outside boundary | Claimed category/direction are untrusted; treat as no trusted classification | Any supplied IDs are untrusted | No private WeakMap/closure mark; reject | Direct calls to message service can bypass adapter guarantees; legacy service has no provenance check | Denied before authorization |
| 17. Provenance-marked event, identity evidence unavailable | Category/direction may be known | Identity status remains unavailable; no principal/session | Application-boundary provenance is present | Legacy path remains unaffected | Denied |
| 18. Provenance-marked event, category `unknown` | `unknown`; direction may be known | No eligible private sender identity | Application-boundary provenance is present | Legacy path may still treat a non-group `from` as private | Denied |

## 12. Known limitations and unresolved questions

1. **Positive private classification:** the inspected dependency's
   `ChatFactory` defaults to `PrivateChat`; it does not prove that every
   fallback chat is a direct private conversation. A positive, supported
   event-time private signal is unresolved.
2. **Identifier contract:** the dependency does not establish exhaustive
   accepted sender formats or stable offline canonicalization, including
   LID/phone equivalence and account-mode behavior.
3. **Category availability on received events:** `Message` has
   `isStatus`/`broadcast`, while channel/group classification may require
   resolved chat information. Which messages reach the `message` event and
   which category fields are reliably populated must be established without
   treating missing fields as private.
4. **Direction policy:** the SDK suppresses self messages from `message`,
   but the legacy normalized DTO loses direction. A future boundary must
   preserve explicit raw evidence and treat absent/conflicting values as
   unknown.
5. **Provenance scope:** an in-process opaque mark protects against plain
   object forgery through ordinary API inputs, not malicious code already
   running in the process or a compromised composition root.
6. **Legacy identity behavior:** group author fallback and non-group-to-
   private inference remain present by design for compatibility. They are
   unsuitable as evidence for privileged authorization.
7. **No production composition:** trusted context, authorization policy,
   grant lifecycle, and tool assistant are isolated modules and are not
   connected to the WhatsApp runtime.
8. **Operational evidence:** this sprint used local package/source and test
   inspection only. It did not connect a WhatsApp account or establish
   account-specific identity behavior.

## 13. Recommended next sprint

1. Resolve, with version-specific evidence, what positive signal can
   distinguish a direct private chat from channel, broadcast/status, and
   unsupported chat categories at message-event time. Until then, private
   classification in the trusted boundary must remain unavailable.
2. Implement the boundary as a separate, non-production module only after
   its evidence contract is fixed. Keep it disconnected from
   `friday-runtime.js`, the legacy normalizer/service, and tool dispatch.
3. Use fake SDK/client events to test all 18 scenarios, event provenance,
   immutable field projection, conflicting evidence, and unknown defaults.
   Include regression tests proving the untouched legacy handler remains
   byte-for-byte behaviorally equivalent for supported scenarios.
4. Do not implement identity canonicalization or enable grants in that
   boundary sprint. Keep the principal unavailable and every privileged
   decision deny-all until the identity and grant-source prerequisites are
   separately reviewed.
5. Plan runtime integration and a private text-only pilot only in a later,
   separately approved security sprint after trusted identity, grant
   authority, and runtime-level fake integration tests are ready.

## Files inspected

### Friday application and tests

- `src/index.js`
- `src/friday-runtime.js`
- `src/whatsapp/message-adapter.js`
- `src/whatsapp/message-queue.js`
- `src/whatsapp/client.js`
- `src/application/message-service.js`
- `src/application/trusted-runtime-context.js`
- `src/application/tool-authorization-policy.js`
- `src/application/tool-grant-lifecycle.js`
- `src/application/tool-assistant.js`
- `src/database/history.js`
- `src/database/sqlite.js`
- `test/message-adapter.test.js`
- `test/message-queue.test.js`
- `package.json` and `package-lock.json`

### Installed dependency source

- `node_modules/whatsapp-web.js/src/Client.js`
- `node_modules/whatsapp-web.js/src/structures/Message.js`
- `node_modules/whatsapp-web.js/src/structures/Chat.js`
- `node_modules/whatsapp-web.js/src/structures/PrivateChat.js`
- `node_modules/whatsapp-web.js/src/structures/Channel.js`
- `node_modules/whatsapp-web.js/src/factories/ChatFactory.js`
- `node_modules/whatsapp-web.js/index.d.ts`

### Prior architecture reports

- `docs/architecture/SPRINT-4-8D-2A-PRODUCTION-IDENTITY-VALIDATION-AUDIT.md`
- `docs/architecture/SPRINT-4-8D-2B-WHATSAPP-IDENTITY-CONTRACT-INVESTIGATION.md`
- `docs/architecture/SPRINT-4-8D-2C-MESSAGE-CLASSIFICATION-IDENTITY-BOUNDARY-DESIGN.md`
- `docs/architecture/SPRINT-4-8D-2D-IDENTITY-VALIDATION-EVIDENCE-AND-STRATEGY.md`
- `docs/architecture/SPRINT-4-8D-2E-TOOL-CAPABILITY-AUTHORIZATION-DESIGN.md`
- `docs/architecture/SPRINT-4-8D-2F-CAPABILITY-REQUIREMENTS-AND-DECLARATION-FILTERING.md`
- `docs/architecture/SPRINT-4-8D-2G-GRANT-LIFECYCLE-AND-REVOCATION.md`
- `docs/architecture/SPRINT-4-8D-2H-GRANT-LIFECYCLE-INTEGRATION-READINESS-AUDIT.md`

The supplied prompt names the 2D report with an additional `-AUDIT` suffix;
the checked-out report is named
`SPRINT-4-8D-2D-IDENTITY-VALIDATION-EVIDENCE-AND-STRATEGY.md`, and that
existing file was inspected.

## Verification and change boundary

- This was a design-only audit; tests were not run because no source or test
  behavior was changed.
- No production WhatsApp account was used, and no Gemini request was made.
- No source file, test, database schema, migration, grant, or runtime path
  was modified.
- Production identity validation and production tool execution remain
  disabled.
- The only intended addition is this architecture report.
