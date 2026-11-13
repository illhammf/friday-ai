# Sprint 4.8D.2C — Message Classification and Identity Boundary Design

## 1. Objective and scope

This read-only design defines separate application boundaries for WhatsApp
message classification, sender identity extraction and validation, session
scope resolution, and trusted runtime projection eligibility. It does not
change runtime behavior or implement any of these boundaries.

The design uses evidence from Friday's current source and tests, plus the
installed `whatsapp-web.js@1.34.7` package. The package does not document an
exhaustive identity format or a stable general-purpose identity
canonicalizer. Accordingly, no ID suffix list, regular expression, or
canonicalization rule is proposed.

## 2. Existing architecture and source evidence

### WhatsApp event and queue

The installed dependency's `Client.js` constructs a `Message`, emits
`message_create`, returns when the underlying `msg.id.fromMe` is true, and
otherwise emits `message` (`node_modules/whatsapp-web.js/src/Client.js`,
around lines 650–665). Friday registers `registerQueuedMessageHandler()` in
`src/friday-runtime.js`; it listens to `message` via
`src/whatsapp/message-adapter.js`.

The handler checks queue admission, deduplicates using `message.from` and the
serialized message key, enqueues by raw `message.from`, and then normalizes
the original SDK message. `isQueueableMessage()` rejects truthy `fromMe`,
missing `from`, and unsupported empty-content message types. It accepts all
non-group `from` values and accepts group text only when it has Friday's
configured prefix (`src/whatsapp/message-queue.js`).

### Normalization and service

`normalizeWhatsAppMessage()` in `src/whatsapp/message-adapter.js` rejects a
missing, empty, or non-string `from`. It treats a message as a group only
when `from.endsWith('@g.us')`; otherwise it sets `chatType: 'private'`.
Private `senderId` is copied from `from`. Group `senderId` is
`author || from`, so absent or empty group author becomes the group chat ID.
The adapter exposes `messageId`, `chatId`, `senderId`, `chatType`,
`messageType`, text/caption, timestamp, group display metadata, and a media
download closure. It does not preserve `fromMe`, `isStatus`, `broadcast`, or
chat-object category evidence.

`createMessageService().handle()` in
`src/application/message-service.js` treats only `chatType === 'group'` as
group; other values take the private behavior branch. Groups require a Friday
text prefix, then use a group session for shared assistant/history behavior.
The service also computes `privateSessionId(senderId)` for each accepted
message, including groups. Existing group-prefix routing is therefore an
ordinary message-service rule, not evidence that a sender is private.

### Sessions and authorization boundary

`privateSessionId()` and `groupSessionId()` in `src/database/sqlite.js`
simply return `private:${userId}` and `group:${groupId}`. They do not validate
or canonicalize values.

`createTrustedRuntimeContextProjector()` in
`src/application/trusted-runtime-context.js` checks a strict input shape,
calls an injected sender validator and private-session resolver, compares
session values, and delegates to `createToolAuthorizationPolicy()`. The
policy in `src/application/tool-authorization-policy.js` denies groups and
unknown chat types and returns an executor-facing context containing only
`conversationType` and authorized tool names. These modules are not composed
with the production WhatsApp event path. Their input-shape checks alone do
not prove provenance.

### Dependency evidence relevant to classification

In the installed dependency:

- `Message` exposes `from`, optional `author`, `fromMe`, `isStatus`, and
  `broadcast` (`node_modules/whatsapp-web.js/src/structures/Message.js` and
  `node_modules/whatsapp-web.js/index.d.ts`).
- `_patch()` serializes object-valued `from` and `author` through
  `_serialized`; it does not validate or canonicalize them.
- `Message.isStatus` is set from `isStatusV3` or the status remote marker.
  `broadcast` is copied from message data.
- `ChatFactory.create()` returns `GroupChat` for `data.isGroup`, `Channel`
  for `data.isChannel`, and otherwise `PrivateChat`
  (`node_modules/whatsapp-web.js/src/factories/ChatFactory.js`).
- `Message.from` is documented as the chat ID, not as proof that the chat is
  private. `Message.author` is documented as the group message sender, but
  may be absent.

These are field roles and implementation behavior, not an exhaustive
classification or accepted-identity contract. In particular, the factory's
fallback to `PrivateChat` does not prove that an arbitrary `from` string is
a private sender or establish a canonical sender ID.

## 3. Current classification behavior

| Input/evidence | Current Friday result | Limitation |
|---|---|---|
| `from` ends with `@g.us` | `chatType: 'group'` | Heuristic suffix classification; not a complete dependency contract. |
| Any other non-empty string `from` | `chatType: 'private'` | Conflates private chats with channels, broadcasts/statuses, unknown, and unsupported categories. |
| Missing, empty, or non-string `from` | Normalizer returns `null`; queue also rejects missing/falsy `from` | Does not distinguish invalid from unavailable identity. |
| `fromMe` truthy | Queue rejects; installed `message` event also suppresses ordinary self-authored messages | The normalized record does not preserve this evidence. Queue checks truthiness, not an explicit `false` requirement. |
| Group `author` missing or empty | `senderId` becomes `from` | Group chat ID is incorrectly reused as a sender value. |
| `isStatus`, `broadcast`, channel/chat flags | Not retained by the normalized record | These categories cannot be reliably rejected downstream. |

`test/message-adapter.test.js` verifies representative private/group
normalization, group author mapping, media metadata, and missing `from`
handling. `test/message-queue.test.js` verifies the suffix-based private/group
admission examples, group prefix admission, and self-message rejection.
These tests establish current behavior; they do not prove the heuristic is
complete or establish a valid ID format.

## 4. Proposed message classification contract

Classification is independent of identity validity. It must describe the
kind and direction of the message without asserting that any identity string
is valid.

Proposed classification result:

```js
{
  category:
    'private' |
    'group' |
    'channel' |
    'broadcast_status' |
    'unknown',
  direction: 'incoming' | 'self' | 'unknown',
  evidence: 'explicit_adapter_signal' | 'unverified' | 'none'
}
```

`evidence` is audit metadata, not authorization. A future adapter may emit
`category: 'private'` only when it has a positively established category
signal for the exact supported dependency/API path. It must not infer
`private` from the absence of a group suffix, `author`, `isStatus`, or
`broadcast`. If only `from` is available, or resolving the chat category
fails, classification is `unknown`. A dependency chat-object lookup may be
evaluated in a later implementation, but its exact event-time semantics and
failure behavior must first be verified; the `ChatFactory` default branch
alone is insufficient evidence.

Group, channel, and broadcast/status are separate categories. An unknown
category remains unknown rather than being coerced into private. Self-origin
is tracked independently: only a positively established incoming direction
is eligible for any future private tool route. Missing or ambiguous direction
is ineligible.

This classification boundary does not change ordinary production routing in
this sprint.

## 5. Proposed identity data model

Keep the chat/message remote, sender identity, and display metadata in
separate fields. The following is a conceptual model; it is not an accepted
runtime DTO or an identity format:

```js
{
  classification: { category, direction, evidence },
  remote: { rawId: message.from },
  sender:
    | { kind: 'private_candidate', rawId }
    | { kind: 'group_participant_candidate', rawId }
    | null,
  display: { name: untrustedDisplayNameOrNull },
  message: { id: messageKeyOrNull, text, caption }
}
```

Extraction rules for a future boundary:

- For a positively classified private incoming message, `from` may be
  extracted as a *private identity candidate*. It remains unvalidated until
  the dedicated validator accepts it.
- For a positively classified group message, only `author` may be extracted
  as a group-participant candidate. If it is missing, empty, or not a string,
  participant identity is absent. Never replace it with `from`.
- `from` remains the remote/chat identity in a group; it is never promoted to
  a private sender candidate.
- Channel, broadcast/status, unknown, or self-authored messages do not yield
  a private sender candidate.
- Display name remains untrusted presentation metadata. It cannot fill or
  validate any identity field.
- Message text, captions, model output, and tool arguments are not identity
  sources.
- `message.id`, `message.id.remote`, and its `_serialized` message-key form
  remain message/deduplication data. They are never substituted for sender
  identity.

Malformed candidate IDs remain rejected/missing at validation. No fallback,
coercion, trimming-based canonicalization, replacement ID, or guessed
format is introduced.

## 6. Validation and canonicalization boundaries

The future application design should treat these as separate operations:

1. **Structural validation:** verify that the adapter supplied the expected
   primitive field shape without coercion. This only establishes a usable
   candidate value, not that it is a valid WhatsApp identity.
2. **Category validation:** check that the candidate's declared role matches
   the positively classified category (private sender versus group
   participant versus chat remote). Unknown and mismatched roles fail closed.
3. **Provenance validation:** ensure the candidate was extracted by the
   application-owned adapter/composition boundary, not supplied by a caller,
   display name, message body, assistant request, model output, or tool
   arguments. Plain-object shape checks cannot establish this property.
4. **Canonicalization:** only a future, evidence-backed identity component
   may map an accepted candidate to a canonical value. No such complete,
   stable public API or accepted format is established by the inspected
   `whatsapp-web.js@1.34.7` package. Until one is approved and verified,
   private tool eligibility remains unavailable; do not invent a regex or
   treat a non-empty string as valid.
5. **Session resolution:** only after validation/canonicalization may the
   application derive private scope from that canonical identity.

For private identity, validation and `privateSessionId()` must consume the
same canonical value. A validator/canonicalizer failure, absent value, or
category mismatch yields no private session and no tool eligibility.
Existing prefix-only resolvers are insufficient as validators and must not
be reinterpreted as such.

Group session resolution remains a separate legacy concern based on the
group chat identity. A group participant is not substituted into private
scope. Changes to group session semantics require a separate compatibility
review.

## 7. Session resolution design

The future application-owned flow is:

```text
raw SDK event
  -> classify category and direction
  -> extract role-specific identity candidate
  -> validate provenance and identity category
  -> canonical private identity (private path only)
  -> private session resolver
  -> verify active conversation scope equals resolved scope
```

For group messages, ordinary legacy processing may continue to use a group
session derived from the group chat ID. It must not resolve or use a
participant's private session for group tool authorization. A missing group
author must remain missing as participant identity while existing group
message behavior is preserved until separately changed.

Session mismatch, missing resolver output, or resolver failure denies private
runtime projection. Session strings are not accepted from message content,
model output, or caller-provided authorization context.

## 8. Trusted runtime projection integration design

Future composition should occur inside an application-owned boundary, not in
`message-service` based on a caller-constructed object:

```text
normalized event with preserved classification evidence
  -> private-only eligibility gate
  -> role-specific candidate extraction
  -> injected validator/canonicalizer
  -> canonical private session resolution
  -> conversation-scope equality check
  -> trusted runtime projection
  -> existing authorization policy
  -> executor
```

Only positively classified, incoming, supported private conversations with
validated canonical identity and matching session scope can be considered
for private tool authorization. Groups, channels, broadcast/status,
self-authored, unknown, malformed, or unsupported messages fail closed for
tool access. Group messages can continue through ordinary legacy processing
but never through private authorization.

The projector and policy remain responsible for their existing authorization
checks; identity/session validation is not duplicated as tool-grant logic.
Capability requests must come only from explicit application configuration
or policy, defaulting to empty. Neither model input nor the user can supply
capabilities or grants. Executor handlers receive only policy-approved
executor context; raw sender IDs and session IDs are not exposed by default.

The current projector/policy objects accept inputs through public JS methods.
Their shape checks do not authenticate the caller. A future composition
boundary must keep construction and invocation application-owned and avoid
exposing a caller-controlled path to submit identity, session, or capability
evidence. The authorization policy must continue to be the single grant
decision point.

No current production tool execution is connected to this flow.

## 9. Compatibility and legacy routing requirements

No route changes are made here. A later implementation must preserve the
existing `message-service` path unless a separately approved sprint changes
it. In particular:

- **Private text:** remains on the current legacy assistant/memory route.
  Only ordinary incoming private text, after explicit exclusion of legacy
  command/specialized routes, could be evaluated for a future text-only tool
  pilot.
- **Group text:** keep Friday-prefix admission and group session/history
  behavior on the legacy route. Never silently reroute a group into private
  tool authorization.
- **Images:** image download, sticker-priority handling, and vision
  assistant behavior stay on their existing paths.
- **Voice notes:** transcription and voice reply remain on the existing audio
  path.
- **Stickers:** sticker generation from incoming images remains on the
  existing sticker path.
- **Video:** social-link download detection and video delivery remain on the
  existing path. A text request that triggers video download is not eligible
  for a private text-only tool pilot.
- **Image generation:** generation requests remain on the existing image
  path, even though their prompt is text.
- **Queueing/deduplication:** preserve current queue order, capacity,
  deduplication, and group-prefix behavior. Classification work must not
  change queue keys or silently discard existing supported messages.
- **Conversation history and memory:** preserve existing private/group
  scoping and memory-command behavior. A future tool pilot must not move
  these commands or history to a different session.

Potential future pilot eligibility is narrow: positively classified,
incoming, validated private plain-text messages that are not media-bearing
and are not consumed by memory, video-download, image-generation, voice, or
other legacy special handling. This is a future selection rule, not current
behavior or authorization.

## 10. Security scenario matrix

“Legacy session” describes existing message-service behavior where
applicable. “Private tool eligibility” describes the proposed future
boundary, not current production behavior.

| Scenario | Proposed classification | Identity result | Session eligibility | Private tool authorization |
|---|---|---|---|---|
| 1. Valid positively classified private message | Private, incoming, only on verified positive evidence | `from` is a private candidate; validator must accept and canonicalize it | Canonical private resolver may run; active scope must match | Eligible for consideration only after all checks and app-configured grants; not automatically granted |
| 2. Group with valid participant `author` | Group, incoming | Preserve `author` only as group-participant candidate; `from` remains group remote | Existing group session may continue from group chat ID; no private session for authorization | Denied |
| 3. Group without `author` | Group, incoming | Participant identity absent; never fall back to `from` | Existing group session may continue; no participant-private session | Denied |
| 4. Group chat ID presented as sender identity | Group classification takes precedence | Category-role mismatch; reject as private identity | No private session; group session only if legacy route allows it | Denied |
| 5. Channel message | Channel if positively established; otherwise unknown | No private sender candidate | No private session; ordinary legacy handling only if separately supported | Denied |
| 6. Broadcast/status message | Broadcast/status if positively established; otherwise unknown | No private sender candidate | No private session | Denied |
| 7. Unknown message category | Unknown | Do not coerce candidate to private; preserve only as untrusted remote if needed | No private session; legacy behavior only as explicitly approved | Denied |
| 8. Missing `from` | Unknown / unusable event | No remote or sender candidate; current normalizer drops it | No session | Denied |
| 9. Empty group `author` | Group | Participant identity absent; no fallback | Existing group session may continue; no private session | Denied |
| 10. Self-authored message | Self direction; category may remain separately known | No incoming sender candidate | No private session for tools | Denied; current library event path and queue already reject ordinary self messages |
| 11. Display-name injection | Determined only by independent message evidence | Display value remains untrusted; cannot create identity | No new session from display data | Denied unless independent trusted identity passes all checks |
| 12. Message-text identity injection | Determined only by independent message evidence | Text/caption is never an identity source | No new session from text | Denied unless independent trusted identity passes all checks |
| 13. Inconsistent session values | Category may be private | Candidate may validate, but scope is inconsistent | Resolver result and conversation scope mismatch | Denied by projection/policy |
| 14. Caller-supplied trusted context | Not trusted solely because fields look valid | Provenance unestablished; reject outside application-owned construction | No trusted session scope | Denied |
| 15. Unsupported LID/phone canonicalization assumption | Category may be private but identity contract unresolved | Do not map, normalize, or guess equivalence; validation unavailable | Do not derive private tool session until canonical policy is established | Denied |

## 11. Verified facts versus proposed design

### Verified current facts

- Installed dependency version is `whatsapp-web.js@1.34.7`.
- The dependency's incoming `message` event suppresses messages whose
  underlying message key indicates `fromMe`.
- Friday also rejects truthy `message.fromMe` in queue admission.
- Friday classifies groups with an `@g.us` suffix and classifies every other
  non-empty `from` value as private.
- Friday's group sender fallback is `author || from`.
- `message-service` computes a private session for each accepted message and
  an additional group session for group messages.
- Current session functions only prefix values.
- A production sender validator is absent; the authorization and projection
  require injected validators and are not composed with production message
  handling.
- Existing tests cover representative normalization, queue admission,
  legacy routing, and fake-injected policy/projection behavior. They do not
  establish an authoritative identity format or classification contract.

### Proposed, not implemented

- A distinct classification result, direction signal, and `unknown` default.
- Role-specific identity candidates with no group-to-private fallback.
- A separate future validator/canonicalizer and session-resolution sequence.
- A private-only, fail-closed eligibility gate before trusted projection.
- Compatibility guardrails that keep media, group, and specialized legacy
  routes outside any future private text-only pilot.

## 12. Unresolved dependencies and blockers

1. No authoritative, exhaustive accepted format for private sender or group
   participant IDs is established by local dependency documentation.
2. The dependency does not establish a stable public general-purpose
   canonicalization/validation API, including supported LID/phone equivalence
   and account-mode behavior.
3. Friday's current message event normalization does not preserve all
   category and direction evidence needed for the proposed boundary.
4. The exact reliable event-time signal for positively identifying a
   `PrivateChat`, rather than merely falling through to `ChatFactory`'s
   default, remains to be verified before private classification is enabled.
5. Group author may be absent, and current fallback incorrectly conflates
   group chat remote with sender.
6. Projection/policy shape validation cannot establish adapter provenance
   unless future application composition controls construction and use.
7. There is no production capability configuration or tool-pipeline
   integration. Production tool execution must remain disabled.

## 13. Recommended implementation sequence

1. Obtain version-specific evidence for positive private/group/channel/status
   classification and identity categories, including LID/phone behavior for
   the account modes Friday supports. Do not infer formats from examples.
2. Define adapter-level classification and direction fields with an
   explicit `unknown` outcome. Preserve verified raw evidence separately;
   never treat heuristic evidence as positive private classification.
3. Split identity fields by role and remove group `author || from` fallback.
   Keep this change behind compatibility review and add regression tests for
   existing group/media behavior.
4. Implement a validator/canonicalizer only from the verified contract.
   Fail closed on absent, malformed, mismatched, or unsupported values.
5. Derive private session from the exact canonical identity, then assert
   that active conversation scope matches. Keep group sessions separate.
6. Compose projection and existing authorization policy inside an
   application-owned boundary. Keep capabilities statically configured and
   default-deny; keep sender/session evidence out of executor context.
7. Add fake-based tests for all rows in the scenario matrix and
   compatibility tests for private/group text, media, specialized routes,
   queueing, deduplication, history, and memory.
8. Only after separate review, consider a private plain-text pilot. Keep
   production tool registration/activation out of earlier steps.

## 14. Final readiness verdict

## CONDITIONALLY READY

The architecture can be designed safely because classification, identity
validation, session scope, provenance, projection, and authorization can be
separate boundaries with explicit fail-closed behavior. The missing
WhatsApp identity format and canonicalization contract can remain isolated
behind a validator interface; until evidence is obtained, it must return no
eligible private identity. Likewise, absent positive private-category
evidence must result in `unknown`, not private.

This verdict is readiness for a future isolated design implementation only.
It is not readiness to enable production sender validation, private tool
authorization, or tool execution. No code, tests, configuration, dependency,
database, or runtime behavior was changed in this sprint. Production tool
execution remains disabled.
