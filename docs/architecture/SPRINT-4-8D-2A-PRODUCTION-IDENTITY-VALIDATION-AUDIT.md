# Sprint 4.8D.2A — Production Identity Validation Audit

## 1. Objective and scope

This is a read-only audit of the production WhatsApp sender-identity path and
its relationship to the isolated authorization and trusted-runtime-projection
modules. The question is whether source code and the installed WhatsApp
dependency establish enough of a sender-ID contract to implement a production
validator without inventing accepted formats.

No WhatsApp connection or external network request was used. No application
source, tests, configuration, package files, database schema, or runtime
behavior was changed. No tool execution was activated.

The verdict is **NOT READY**. The app derives identity from an incoming
WhatsApp event, but does not validate its canonical format. The installed
dependency types identify `from` and `author` as strings and describe their
roles; they do not define a complete, validated set of accepted private sender
ID formats. The application also has no production `isValidSenderId`
implementation.

## 2. Files and dependency versions inspected

### Application source

- `src/whatsapp/message-adapter.js` — `normalizeWhatsAppMessage()`,
  `createWhatsAppAdapters()`, and `registerQueuedMessageHandler()`.
- `src/whatsapp/message-queue.js` — `isQueueableMessage()`,
  `getMessageDeduplicationKey()`, and queue behavior.
- `src/friday-runtime.js` — WhatsApp client setup/event lifecycle and
  application composition.
- `src/application/message-service.js` — message processing, identity/session
  resolution, routing, and assistant boundary.
- `src/database/history.js` — session resolver re-exports.
- `src/database/sqlite.js` — `privateSessionId()` and `groupSessionId()`.
- `src/application/tool-authorization-policy.js` — injected identity
  validation, session checks, grants, and authorization result.
- `src/application/trusted-runtime-context.js` — injected validator,
  canonical session derivation, and projection behavior.
- `src/ai/tools/tool-permission-policy.js` and
  `src/ai/tools/tool-executor.js` — executor permission enforcement and
  handler-context boundary.

### Dependency source and types

- `package.json` declares `whatsapp-web.js: ^1.34.7`.
- `package-lock.json` resolves `whatsapp-web.js` to **1.34.7**.
- The installed `node_modules/whatsapp-web.js/package.json` also reports
  **1.34.7**.
- Inspected the installed `node_modules/whatsapp-web.js/src/Client.js`,
  `src/structures/Message.js`, and `index.d.ts`.

The installed declaration types define `Message.from: string`,
`Message.author?: string`, `Message.fromMe: boolean`, and `MessageId.remote:
string`. The comments describe `from` as the chat ID (except on messages sent
by the current user), `author` as the user who sent a group message, and
`fromMe` as whether the current user sent the message. The type example shows
an ID ending in `@c.us`; it is an example, not a normative accepted-format
contract.

### Related tests and architecture documents

- `test/message-adapter.test.js`
- `test/message-queue.test.js`
- `test/message-service.test.js`
- `test/sqlite.test.js`
- `test/tool-authorization-policy.test.js`
- `test/trusted-runtime-context.test.js`
- `docs/architecture/SPRINT-4-7-1-FINAL-READINESS-AUDIT.md`
- `docs/architecture/SPRINT-4-8C-TRUSTED-RUNTIME-AUTHORIZATION.md`
- `docs/architecture/SPRINT-4-8D-1-TRUSTED-RUNTIME-PROJECTION.md`

Repository-wide searches for `senderId`, `message.from`, `message.author`,
`chatId`, `chatType`, `privateSessionId`, `groupSessionId`,
`isValidSenderId`, and `getPrivateSessionId` found the active paths above,
their tests and documentation, plus archived files under `src/backups/`.
Those backup snapshots are not part of the current runtime composition.
There is no production `isValidSenderId` implementation; occurrences outside
the application dependency parameters are test fakes and documentation.

## 3. Complete sender identity data flow

| Transition | Actual behavior and fields | Trust, validation, transformation, fallback |
|---|---|---|
| WhatsApp Web event to library event | In installed `whatsapp-web.js` 1.34.7, `Client.js` constructs a `Message`, emits `message_create`, returns when `msg.id.fromMe` is true, and otherwise emits `message`. The app subscribes to `message`, not `message_create`. | The event is supplied by the WhatsApp Web client/library, not by the model or message text. This path excludes ordinary self-authored messages before the app listener. The library's event contract does not prove that every field has a supported canonical identity format. |
| Library event to queue admission | `registerQueuedMessageHandler()` checks `canAccept`, then `isQueueableMessage()`, derives a deduplication key, and enqueues by raw `message.from`. The queue task normalizes the original event and passes the normalized object to `message-service`. | `isQueueableMessage()` rejects truthy `fromMe`, missing/falsy `from`, unsupported empty-content types, and unaddressed groups. It does not require `fromMe === false`, validate the sender's format, or validate `author`. Group classification uses `from.endsWith('@g.us')`. |
| Library `Message` to normalized message | `normalizeWhatsAppMessage()` requires a truthy string `message.from`; it sets `chatId = from`, sets `chatType` to `group` only when `from.endsWith('@g.us')`, and sets `senderId` to `from` for private messages or `message.author || from` for groups. | It does not validate a private sender ID, group participant ID, or group chat ID. It does not trim or canonicalize `from` or `author`. A missing/empty `from` returns `null`; other non-empty strings, including whitespace, pass the initial check. A missing/falsy group `author` falls back to the group `from` value. |
| Library object ID to serialized string | Installed `Message._patch()` converts object-valued `from`, `to`, and `author` to their `_serialized` values. | This is a dependency transformation, not an application identity validation step. The app adapter then copies the resulting values without canonicalization. |
| Normalized message to message service | `createMessageService().handle()` checks `message.chatType === 'group'`; all other values take the private behavior branch. It reads `message.senderId` and calls the injected session functions. | The service relies on the adapter's normalized contract and does not revalidate `chatType`, `senderId`, or `chatId`. It does not derive sender identity from the display name. |
| Message service to sessions | For every accepted normalized message, the service calls `privateSessionId(senderId)`. If `chatType` is group, it additionally calls `groupSessionId(message.chatId)`. | The private session is therefore also computed for group messages, using the group participant ID or the adapter's fallback group chat ID. The service passes the group session separately to the legacy assistant. Its active-session lock is keyed by the computed private session. |
| Session resolvers | `privateSessionId(userId)` returns ``private:${userId}``; `groupSessionId(groupId)` returns ``group:${groupId}``. `src/database/history.js` re-exports them from SQLite. | These functions perform string prefixing only. They do not validate, normalize, or reject missing/malformed IDs. |
| Trusted projection | `createTrustedRuntimeContextProjector().project()` accepts a plain object with `chatType`, `senderId`, `privateSessionId`, and `conversationSessionId`. It validates the sender via injected `isValidSenderId`, recomputes the private session with injected `getPrivateSessionId`, and requires both session values to equal that result. | Unexpected keys and malformed/missing values fail closed. The module does not establish that its plain-object input originated in the WhatsApp adapter. It is not connected to the production runtime. |
| Authorization policy | `createToolAuthorizationPolicy().authorize()` accepts a strict key set including the identity/session fields and `requestedCapabilities`, rejects groups and unknown types, requires a non-empty trimmed sender and injected validator result exactly `true`, and checks the private session against the injected resolver and active conversation scope. | Authorization logic is fail-closed for its own input contract. No production validator, tool grants, or runtime call currently supplies the policy. |
| Executor context | The policy returns executor context containing `conversationType` and `authorizedTools`; identity and session evidence are returned separately. `tool-executor.js` checks the allowlist through the permission policy and omits `authorizedTools` when it builds handler context. | The current policy/executor contract does not automatically pass sender or session IDs to handlers. Neither component is connected to WhatsApp message processing. |

### Private versus group identity

- **Private:** normalized `senderId` is the library's `message.from`, and
  `chatId` is the same value.
- **Group participant:** normalized `senderId` is `message.author` when
  truthy.
- **Group fallback:** if `author` is missing or otherwise falsy, normalized
  `senderId` becomes `message.from`, which represents the group chat on the
  incoming message path.
- **Group chat:** `chatId` remains `message.from`; the service derives the
  shared group session from that value.
- **Display name:** `message._data.notifyName` is stored separately as
  `group.senderName`. It is not used by the adapter to produce `senderId`.
  The service uses it for group prompt presentation and history labels.

The group fallback means `senderId` is not guaranteed to represent a group
participant for every normalized group message. A downstream consumer must
not interpret `senderId` alone as proof that the identity is a private user.

## 4. Actual identity contract established by source

### Verified facts

1. The application listens to the `message` event. In installed dependency
   source, that event is emitted only after the client checks
   `msg.id.fromMe`; self-authored messages are not emitted as `message`.
2. The dependency types declare `from` and `author` as string values and
   distinguish their documented roles. `author` is optional.
3. The dependency's message patching code may convert object IDs to their
   `_serialized` string form.
4. The application treats an incoming `from` ending in `@g.us` as a group
   and every other non-empty string as private.
5. In a group, `author || from` is used as sender; the group chat `from` is a
   fallback when author is absent/falsy.
6. There is no production identity canonicalizer or validator in active
   application source.

### Not established

- A complete set of currently valid private sender identifier forms.
- Whether a private sender may arrive with `@c.us`, `@s.whatsapp.net`,
  `@lid`, another suffix, or an account/version-specific value.
- Whether all supported accounts expose a stable canonical representation
  across linked-device, contact, and privacy configurations.
- A normalization API or contract that guarantees equality between a
  validated identity and the identity used as the session key.
- A formal guarantee that every non-group `from` is a private user rather
  than a broadcast, status, or other chat category.

The installed library's type declarations do not provide a format validator
or schema for `Message.from`/`Message.author`. The comments and examples
establish field roles and examples only; they do not establish accepted
formats. Existing code checks the `@g.us` suffix, but the dependency type
contract does not itself state that this is a complete classification
algorithm for every possible chat kind.

The regular expression in the helper inside
`test/tool-authorization-policy.test.js` accepts example-like `c.us`, `lid`,
and `s.whatsapp.net` suffixes. It is test-only fake policy input and is not
evidence that those formats are complete, canonical, or valid in production.
It must not be copied as a production validator based on this audit.

## 5. Existing validation and session behavior

### Adapter and message service

- `normalizeWhatsAppMessage()` rejects a null message, a non-string `from`,
  and a falsy `from`. It does not reject whitespace-only strings, unfamiliar
  suffixes, malformed non-empty IDs, absent group authors, or malformed
  truthy authors.
- It does not inspect `fromMe`; the event registration boundary and queue
  admission perform the existing self-message protections.
- The queue checks `fromMe` by truthiness, but the active library `message`
  event already excludes `msg.id.fromMe === true` in the installed version.
- `createMessageService()` does not validate the normalized identity or
  session resolver results. Direct callers can bypass adapter guarantees;
  the type annotations are JSDoc and are not runtime validation.

### Projection and policy

- Both the projection and authorization policy require injected validator
  functions. The current Friday composition does not construct either module
  and supplies no validator.
- The projection recomputes the private session from the sender and checks
  both provided scope values against it. The policy independently performs
  its own session derivation and match.
- Tests use fake resolvers and validators, including a test-helper regex.
  Those tests prove behavior conditional on the supplied fake, not the
  correctness of any production WhatsApp identity format.
- The projection and policy receive plain JavaScript objects. They reject
  extra fields but cannot prove object provenance or prevent a trusted caller
  from constructing an object with a different valid identity.

### Session consistency

Session equality protects against a mismatch only if the sender identity and
the injected resolver are themselves trusted and canonical. The resolver is
currently a prefix function; it will consistently map an arbitrary input
string, but consistency is not identity validation. The app's normalizer and
session functions do not enforce that a private session was derived from a
private-only sender category.

## 6. Security threat assessment

| Case | Existing behavior | Assessment |
|---|---|---|
| Display name attempts to influence identity | `notifyName` is placed in the separate `group.senderName` field. Normalization derives `senderId` from `from` or `author`, not the display name. The tool policy/projector reject unexpected display-name fields. | **Adequately separated in the inspected code paths**, but this does not authenticate the raw SDK fields. There is no production tool route to exercise the policy today. |
| Message text injects sender/session identifiers | Message content is normalized as `text`/`caption`; session IDs are derived separately in the message service. The tool projection accepts no text field, and the policy rejects unknown keys. | **Protected against direct model/message-field injection at the isolated API boundary.** This does not guarantee provenance for an arbitrary caller that can construct projection input. |
| Group participant mistaken for private sender | Group identity comes from `author` when truthy; `chatType` is set from `from` suffix. However the message service still computes a `privateSessionId(senderId)` for groups, and a missing author falls back to the group chat ID. The authorization policy rejects `chatType: 'group'`. | **Policy correctly denies a correctly classified group.** Current production has no tool integration. There is no validator at adapter/service level, and the fallback is not a participant identity. |
| Group chat ID mistaken for sender identity | A group `from` ending in `@g.us` produces `chatType: 'group'`; if author is absent/falsy, it is also used as `senderId`. The group session is independently derived from `chatId`. | **Risk contained only while group type is preserved and checked.** A generic sender validator must not treat the fallback as a private identity; suffix classification alone is not a verified full chat-type contract. |
| Missing sender identity | Missing/falsy or non-string `from` causes adapter normalization to return `null`. Missing group `author` is not rejected; it falls back to group `from`. Service itself does not validate `senderId`. The projector/policy deny missing identity. | **Partially protected.** Inbound `from` is required at adapter, but malformed non-empty values pass. Group participant identity may be absent without rejection. |
| Inconsistent session values | Projection and policy recompute the expected private session and require both private and active session values to match exactly. | **Protected within those isolated functions**, if the injected identity and resolver are trusted. They are not currently wired to the WhatsApp runtime. |
| Self-generated messages enter processing | Installed `Client.js` emits `message_create`, then returns before emitting `message` when `msg.id.fromMe` is true. Friday listens to `message`; the queue also rejects truthy `fromMe`. | **Protected for the current installed event path.** The adapter does not preserve `fromMe`, and direct calls to normalizer/service are outside that event guarantee. A future integration should retain this boundary or explicitly require the incoming-event contract. |
| Caller-supplied identity bypasses normalized adapter | Projector accepts a plain object with the expected fields; policy accepts a plain object and injected validator. Neither can prove that the object came from `normalizeWhatsAppMessage()`. There is no runtime composition currently invoking them. | **Not protected by these APIs alone.** A future composition must own construction from the normalized event and not expose an authorization-context setter or accept caller/model DTO identity fields. |

## 7. Test coverage assessment

- `test/message-adapter.test.js` proves expected field mapping for representative
  private and group examples, separate display-name handling, null/missing
  message behavior, and some malformed *non-identity* fields. It does not test
  an accepted production sender-ID format, canonicalization, whitespace
  `from`, malformed `author`, broadcast/status identity, or `fromMe` mapping.
- `test/message-queue.test.js` proves a truthy `fromMe` message is not
  queueable, supported message admission, group prefix gating, per-chat
  deduplication, and queue behavior. It does not validate sender formats.
- `test/message-service.test.js` proves session routing for ordinary private
  and group test fixtures and legacy assistant routing. The fixture injects
  simple prefix-based session functions; no production identity validation
  is exercised.
- `test/sqlite.test.js` checks session behavior, but the production resolver
  functions themselves only prefix their arguments.
- `test/tool-authorization-policy.test.js` proves rejection behavior when an
  injected fake validator rejects and when sender/session fields are missing
  or inconsistent. Its default validator regex is a test helper.
- `test/trusted-runtime-context.test.js` proves injected-validator and
  injected-resolver behavior, group/type rejection, and context isolation.
  It does not test identity provenance from a live adapter or validate real
  production ID formats.

The tests cover policy mechanics and representative normalization, not
production identity authentication or a complete WhatsApp ID contract.

## 8. Validator readiness verdict

## NOT READY

Identity provenance is partially established for the current inbound event:
Friday binds to the installed library's incoming `message` event, and the
library suppresses self-authored events there. The application then copies
library `from`/`author` fields and uses them as session inputs.

But the accepted identity format and canonicalization rules are not
established by the application source or the installed `whatsapp-web.js`
types/source inspected here. There is no production validator, no explicit
account-ID normalization contract, and no integration-level test showing
which identifiers are valid for Friday's supported WhatsApp account modes.
Implementing a validator now would require guessing or adopting the
test-helper regex, both explicitly unsupported by this audit.

## 9. Exact unresolved blockers

1. **Accepted format:** no authoritative local contract identifies every
   supported private sender and group participant identity form.
2. **Canonical representation:** no verified rule or dependency API is wired
   to convert supported identity values to a canonical value before
   authorization and session derivation.
3. **Chat classification:** application code infers group solely from
   `from.endsWith('@g.us')`; it maps every other string to private and does
   not use `broadcast` or `isStatus`. Completeness of this classification is
   unverified.
4. **Group author requirement:** absent/falsy author silently falls back to
   group chat ID as `senderId`; no field distinguishes that fallback from a
   participant identity downstream.
5. **Application boundary validation:** adapter only requires truthy string
   `from`, and message service trusts its caller. No production sender
   validator is supplied to the tool policy/projector.
6. **Projection provenance:** the projection API checks shape and values but
   cannot establish that its input came from the current WhatsApp adapter.
7. **Production evidence:** no live WhatsApp connection or account-specific
   identity samples were used or requested, and no offline dependency contract
   resolves the supported-format questions.

## 10. Recommended future validator contract

Do not implement a regex based on examples or on the test helper. Before
implementation, obtain and document an authoritative supported-ID contract
for the exact WhatsApp integration and account modes Friday supports. If the
installed dependency exposes an identity parser/canonicalizer with documented
semantics, verify it in the installed version and use that documented API;
the inspected `Message` types and source do not currently establish such a
validator.

A future validator and composition boundary should satisfy all of the
following:

1. Accept only the sender value from an incoming normalized adapter message
   whose conversation type is explicitly `private`; never accept a group
   participant or group chat ID for private authorization.
2. Reject missing, non-string, empty, whitespace-padded, unsupported, or
   noncanonical values without coercion or fallback. Do not silently convert
   a group `from` into a participant identity.
3. Treat identity type and conversation type as a pair: private sender
   identity is distinct from group participant identity and group chat
   identity.
4. Preserve the existing self-message boundary: only incoming events are
   eligible; do not authorize `message_create`/self-authored events.
5. Use the same verified canonical sender value for `isValidSenderId()` and
   `privateSessionId()`. The validator, projection, and authorization policy
   must share the same session resolver and validation policy.
6. Construct projection input inside the application composition/message
   boundary from the normalized event and application-owned session
   resolution. Do not accept identity, sessions, capabilities, or grants from
   the DTO, model, message text, display metadata, or arbitrary request
   callers.
7. Keep group authorization denied and capabilities empty unless an
   independently reviewed application policy explicitly configures grants.
8. Add fake-based tests for every supported documented identity variant,
   malformed and missing identities, private/group confusion, group author
   absence, display-name and message-text spoofing, self messages, session
   mismatch, and projection provenance. Do not use a real WhatsApp connection
   in automated tests.

The format contract and canonicalization evidence are prerequisites, not
choices for the validator implementation to infer.

## 11. Runtime and tool-execution status

`src/friday-runtime.js` currently supplies only the legacy `askFriday()` to
`message-service`. It does not construct the authorization policy or trusted
runtime projector. No production tool registration, sender validator, or
capability grant is present. This audit changed no runtime behavior and
activated no tool execution.
