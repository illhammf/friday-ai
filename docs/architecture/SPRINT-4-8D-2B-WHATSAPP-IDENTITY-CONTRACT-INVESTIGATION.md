# Sprint 4.8D.2B — WhatsApp Identity Contract Investigation

## 1. Objective and scope

This read-only investigation examines the exact installed
`whatsapp-web.js@1.34.7` package to determine what it establishes about
message sender IDs, group participant IDs, chat IDs, ID serialization, and
canonicalization. It also checks the consequences for Friday's existing
normalization, sessions, and isolated authorization projection.

No dependency was updated, no network request or WhatsApp connection was
made, and no account identifiers were used. No validator or runtime change
was implemented. Only this audit document was created.

**Verdict: NOT READY.** The dependency distinguishes several identity roles
and contains runtime helpers that attempt to associate LID and phone IDs, but
the inspected version does not expose a documented, complete accepted-ID
format or a stable public canonicalization/validation API. Friday's
`@g.us`-suffix classification is not established as exhaustive.

## 2. Exact dependency version and evidence boundary

The repository declares `whatsapp-web.js: ^1.34.7` in `package.json`;
`package-lock.json` resolves it to `1.34.7`; and
`node_modules/whatsapp-web.js/package.json` reports `1.34.7`. The findings
below refer to that exact installed package, not a newer release.

The package README is present locally at
`node_modules/whatsapp-web.js/README.md`. It links to the project's external
guide and documentation but does not embed those API references. No local
versioned documentation beyond the installed README, source, and
`index.d.ts` was found or consulted. No external documentation was fetched;
therefore claims not established by these local sources are marked
unresolved.

## 3. Installed files and APIs inspected

### Package source

- `node_modules/whatsapp-web.js/src/Client.js`
  - Incoming event creation and emission (around lines 650–665).
  - `isRegisteredUser()`, `getNumberId()`, `getFormattedNumber()`, and
    `getContactLidAndPhone()` (around lines 2210–2265 and 3300–3320).
  - `getChatById()` and `getContactById()` (around lines 1690–1745).
- `node_modules/whatsapp-web.js/src/structures/Message.js`
  - `Message._patch()` maps underlying data to public fields (around lines
    24–156).
  - `_getChatId()`, `getChat()`, and `getContact()` (around lines 352–402).
- `node_modules/whatsapp-web.js/src/structures/Chat.js`
  - `Chat._patch()` preserves chat ID and `isGroup` metadata.
- `node_modules/whatsapp-web.js/src/structures/GroupChat.js`
  - Group participant representation and participant operations, including
    LID/phone handling (around lines 17–40, 90–180, and 270–360).
- `node_modules/whatsapp-web.js/src/structures/Contact.js`
  - Contact ID storage, number/name properties, and contact accessors.
- `node_modules/whatsapp-web.js/src/structures/Channel.js` and
  `Broadcast.js`
  - Separate channel and status/story structures.
- `node_modules/whatsapp-web.js/src/factories/ChatFactory.js`
  - Chat class selection from `isGroup` and `isChannel`.
- `node_modules/whatsapp-web.js/src/util/Injected/Utils.js`
  - `getChatModel()`, `getContactModel()`, and the internal
    `enforceLidAndPnRetrieval()` helper (around lines 925–975, 1000–1075,
    and 1696–1724).
- `node_modules/whatsapp-web.js/index.d.ts`
  - `Message`, `MessageId`, `ChatId`, `ContactId`, `GroupParticipant`,
    `Broadcast`, and `Client` method declarations.

### Friday source, tests, and prior audit

- `src/whatsapp/message-adapter.js`
- `src/whatsapp/message-queue.js`
- `src/application/message-service.js`
- `src/database/sqlite.js`
- `src/application/trusted-runtime-context.js`
- `src/application/tool-authorization-policy.js`
- `src/ai/tools/tool-executor.js`
- `test/message-adapter.test.js`
- `test/message-queue.test.js`
- `test/tool-authorization-policy.test.js`
- `test/trusted-runtime-context.test.js`
- `docs/architecture/SPRINT-4-8D-2A-PRODUCTION-IDENTITY-VALIDATION-AUDIT.md`

## 4. Identity field semantics

### `Message.from`

**Documented contract:** `index.d.ts` describes `Message.from` as the ID of
the chat a message was sent to, except when sent by the current user. The
type is only `string` (`Message` interface, lines 1181–1201).

**Observed implementation:** `Message._patch()` copies a string
`data.from`, or maps an object `data.from` to `data.from._serialized`
(`src/structures/Message.js`, lines 80–84). It does not validate the string's
format. `_getChatId()` selects `to` for `fromMe` messages and `from` otherwise
(`Message.js`, around line 352).

**Does not prove:** that every `from` value is a private user ID, that every
non-group `from` is a private chat, or that a particular suffix set is
complete.

### `Message.author`

**Documented contract:** `author` is optional and its comment says that for a
group message it contains the user who sent the message
(`index.d.ts`, `Message` around lines 1181–1186).

**Observed implementation:** `_patch()` maps an object author to its
`_serialized` property or copies it unchanged (`Message.js`, around lines
101–105). `Message.getContact()` resolves `author || from` and passes it to
`getContactById()` (`Message.js`, around lines 396–401).

**Does not prove:** that author is always present, that its serialized string
is canonical, or that it has one universal suffix/format across WhatsApp
account modes.

### `Message.fromMe`

**Documented contract:** the type comment says it indicates whether the
message was sent by the current user (`index.d.ts`, around lines 1199–1202).

**Observed implementation:** `_patch()` copies `data.id.fromMe`
(`Message.js`, around line 154). `Client.js` emits `message_create` and then
returns when `msg.id.fromMe` is true; only other events are emitted as
`message` (around lines 650–665). Friday subscribes to the `message` event in
`src/whatsapp/message-adapter.js`. Friday's queue helper also drops a
truthy `message.fromMe` if that field exists (`src/whatsapp/message-queue.js`,
around lines 101–108).

This is evidence for the installed inbound event's self-message filter. It
does not validate the sender ID, nor does the Friday normalizer preserve the
`fromMe` field for downstream code.

### `Message.id` and `Message.id.remote`

**Documented contract:** `Message.id` is a `MessageId`, whose fields are
`fromMe: boolean`, `remote: string`, `id: string`, and `_serialized: string`
(`index.d.ts`, lines 1383–1388). The type example combines these into a
message-key serialization (`index.d.ts`, around lines 1150–1178).

**Observed implementation:** `_patch()` uses `data.id` as the message ID and
may fill `_serialized` from `$1` (`Message.js`, lines 33–42). `remote` is a
component of the *message key*, not a separate validated sender identity.
`Message.isStatus` is calculated from `data.isStatusV3` or
`data.id.remote === 'status@broadcast'` (`Message.js`, around lines
130–140).

**Does not prove:** that message-ID serialization is an identity
canonicalizer, or that `remote` is the sender rather than the chat/message
remote in every direction. `Message.id._serialized` is not interchangeable
with `Message.from` or `author`.

## 5. Identity categories and classification

### Categories visible in the dependency

- **Private chat:** `PrivateChat` is a `Chat` subclass. `ChatFactory.create()`
  returns `GroupChat` when `data.isGroup`, then `Channel` when
  `data.isChannel`, otherwise `PrivateChat`
  (`src/factories/ChatFactory.js`, lines 7–19).
- **Group chat:** `GroupChat` inherits `Chat`; `Chat._patch()` exposes the
  `data.isGroup` flag. Its participants have IDs, and
  `index.d.ts` models `GroupParticipant.id` as a `ContactId`
  (`src/structures/GroupChat.js`; `index.d.ts`, around lines 2101–2105).
- **Contact:** `Contact._patch()` stores `data.id` as the contact ID, with
  fields including `number`, `isMe`, `isUser`, and `isGroup`
  (`src/structures/Contact.js`, around lines 20–100). The type's
  `ContactId` contains `server`, `user`, and `_serialized` strings
  (`index.d.ts`, around lines 1763–1768).
- **Channel:** `Channel` is a separate structure with `isChannel` and
  `isGroup` fields (`src/structures/Channel.js`, around lines 17–60).
- **Broadcast/status:** `Broadcast` is documented as a Status/Story
  structure (`src/structures/Broadcast.js`, lines 7–28); `Message` also
  exposes `broadcast` and `isStatus` booleans. These are additional category
  signals, not sender-ID format rules.

The dependency therefore has multiple category concepts, including private
chats, groups, channels, and statuses/broadcasts. `ChatFactory` distinguishes
group and channel using data flags; it does not define a universal
classification algorithm for arbitrary message `from` strings.

### Friday classification is not complete

Friday's `normalizeWhatsAppMessage()` classifies a message as group only if
`message.from.endsWith('@g.us')`; every other non-empty string is classified
as private (`src/whatsapp/message-adapter.js`, lines 7–13, 27–35). It does
not preserve or check the dependency's `isStatus`, `broadcast`, `isChannel`,
or chat-object flags. Thus it can establish only Friday's current local
heuristic, not that every non-group value is a private-user identity.

The installed dependency's `Message.isStatus` logic explicitly recognizes a
status remote marker, and separate `Broadcast` and `Channel` structures
exist. This is evidence that non-group/non-private categories exist; it does
not by itself show exactly which such messages are emitted on the `message`
event in all cases. Friday does not consume these category fields for
classification.

## 6. Serialization, parsing, and canonicalization

### Serialized identifiers

The types for `ChatId` and `ContactId` expose `server`, `user`, and
`_serialized` string fields. Their examples show a phone-number-like
`c.us` representation (`index.d.ts`, around lines 1660–1680 and 2070–2098).
Those examples illustrate the shape; they do not specify all valid servers,
all valid user components, or accepted account modes.

`Message._patch()` unwraps object IDs to `_serialized` for `from`, `to`, and
`author`. That makes these public properties strings, but the code performs
no category check or normalization. Message-key `_serialized` is a distinct
composite serialization.

No standalone exported ID parser, validator, equality comparator, or
canonical serializer was found in the inspected package source/types. Calls
to `WAWebWidFactory.createWid()` and related methods occur inside browser-page
code; the `WAWebWidFactory` implementation itself is part of WhatsApp Web's
internal page modules, not this npm package's public API. The package source
does not document a stable contract for accepted inputs or normalization
semantics of that internal factory.

### Number lookup helpers are not general identity validators

`Client.getNumberId(number)` documents a phone number and automatically
appends `@c.us` if that suffix is absent. It builds a Wid and queries whether
it exists (`src/Client.js`, around lines 2215–2238). This is a runtime
registration lookup for a phone-number input, not a local validator for all
private sender identities. Its implementation can rewrite input, is dependent
on the active WhatsApp Web page, and does not establish LID or group identity
semantics.

`Client.getContactLidAndPhone(userIds)` is declared in `index.d.ts` around
lines 325–330 and implemented in `src/Client.js` around lines 3300–3320. It
delegates to the injected helper `enforceLidAndPnRetrieval()` in
`src/util/Injected/Utils.js` around lines 1696–1724. That helper examines
whether `wid.server === 'lid'`, attempts to obtain a LID or phone counterpart,
and may query WhatsApp Web; it can return an empty object when a lookup fails.
The public method returns serialized `lid` and `pn` values.

This is concrete evidence that the installed version recognizes LID and
phone-number identifiers and has a runtime mapping helper. It does **not**
establish a complete accepted-format specification, an offline canonical
representation, a guarantee that every identifier maps to both forms, or
stability/equivalence rules across all account modes. Its implementation
uses WhatsApp Web internal modules and requires a running client page, so it
cannot serve as a deterministic pure validator at Friday's current
normalization boundary. The type declaration says the values are strings,
but the source uses optional values and can return undefined for missing
entries.

`getFormattedNumber()` and `getCountryCode()` likewise format/extract phone
information; their implementation rewrites strings toward phone-number
server forms. Neither documents nor implements general private/group ID
validation.

## 7. Account-mode and compatibility evidence

The local README lists “Multi Device” as a supported feature. This is a
package-level feature statement, not an identity serialization contract.

The inspected `enforceLidAndPnRetrieval()` implementation explicitly branches
for `server === 'lid'` and tries to resolve a phone counterpart (or LID
counterpart for a phone ID). Group participant operations also look up
participants using either LID or phone IDs in `GroupChat.js` (for example,
around lines 270–320). `getChatModel()` updates group metadata and uses
`WAWebLidMigrationUtils.toPn()` on serialized participant data
(`src/util/Injected/Utils.js`, around lines 943–975).

These are observed implementation details of this package version, and
demonstrate that identity forms can include both LID and phone-number
representations in its runtime code. They do not prove:

- which account/device conditions produce one form or the other;
- that values remain stable over time or migration;
- that every supported ID maps to an equivalent counterpart;
- that one representation is the correct permanent key for Friday's
  per-sender history;
- that mapping behavior is part of a stable public API across package
  releases; or
- that the library's “Multi Device” README entry specifies LID semantics.

No real account, linked device, or real identifier was used. Account-specific
identity compatibility remains unverified. To establish it, Friday needs
version-specific authoritative documentation or an approved controlled
compatibility investigation using non-production/test accounts, without
assuming mapping from synthetic examples.

## 8. Friday-specific security implications

1. **`author || from` fallback:** Friday's adapter uses a group chat ID as
   normalized `senderId` if group author is absent/falsy. The dependency
   documents `author` as the group sender, but does not guarantee its presence
   in the inspected declaration. Group sender and group chat identity must
   remain distinct; this fallback cannot be used for private authorization.
2. **`@g.us` classification:** Friday's suffix check is not backed by a
   complete dependency contract. The dependency itself exposes `isGroup`,
   `isChannel`, `isStatus`, and `broadcast` information in separate
   structures/fields. A future private-only tool route must use an
   authoritative message/chat category signal and fail closed for unknown or
   non-private categories, rather than treating every non-group `from` as a
   private user.
3. **Prefix-only session resolvers:** `privateSessionId(userId)` and
   `groupSessionId(groupId)` only prepend prefixes. They do not validate or
   canonicalize their arguments. Different identity representations can
   consequently create different private session IDs unless a trusted,
   verified canonicalization policy is selected first.
4. **No production validator:** `isValidSenderId` is injected into the
   isolated policy/projector and exists only as a dependency contract; Friday
   does not provide a production implementation.
5. **Projection provenance:** the projection verifies object shape, calls an
   injected validator/resolver, checks session equality, and delegates
   authorization. It cannot prove its input originated from the normalized
   WhatsApp event. Only an application-owned composition boundary can enforce
   that source relationship.
6. **Tool executor boundary:** when properly supplied an authorized policy
   context, the executor checks tool permission and omits `authorizedTools`
   from handler context. This isolates grants from handlers but does not
   authenticate the sender or repair incorrect identity provenance.

No existing production tool execution is connected to these modules.

## 9. Verified facts versus assumptions

### Verified from exact installed source/types

- Installed package is `whatsapp-web.js@1.34.7`.
- `Message.from` and optional `Message.author` are declared strings, with
  comments distinguishing chat ID and group sender roles.
- `Message.fromMe` is a boolean, and the incoming `message` event path
  suppresses events whose underlying `msg.id.fromMe` is true.
- Message patching unwraps object ID values through `_serialized`; it does
  not validate or canonicalize those strings.
- Message IDs have separate `remote`, `id`, and composite `_serialized`
  fields.
- The package has separate group, channel, contact, and broadcast/status
  concepts.
- Internal code recognizes LID (`server === 'lid'`) and attempts runtime
  LID/phone mapping.
- Friday's adapter discards category flags and classifies non-`@g.us` values
  as private.
- Friday's session functions prefix values without validation.

### Examples, not accepted-format rules

- `@c.us` appears in `Message`, `ChatId`, and `ContactId` examples and in
  phone lookup methods.
- Message-key examples show composite strings built from direction, remote,
  and message ID.
- Group examples show a group ID example in one type comment.

None of these examples proves an exhaustive accepted format.

### Assumptions not made

- No assumption that `@c.us`, `@s.whatsapp.net`, `@lid`, or any other suffix
  set is complete.
- No assumption that LID and phone IDs are interchangeable or stable.
- No assumption that every non-`@g.us` message is a private direct message.
- No assumption that a non-empty string returned in an ID field is valid.

## 10. Unresolved blockers

1. No authoritative, version-specific accepted-format specification for
   private sender IDs, group participants, or group chat IDs is available in
   the inspected local package documentation.
2. There is no documented stable public API that validates identifier
   category and canonicalizes every supported identity offline.
3. LID/phone mapping is implemented through WhatsApp Web internals and its
   behavior across account modes, migrations, and missing mappings is not
   contractually specified by the inspected local docs.
4. Friday's message adapter does not preserve the dependency's `fromMe`,
   `isStatus`, `broadcast`, or chat-object category flags.
5. Friday classifies every string not ending in `@g.us` as private, although
   the dependency exposes additional chat/message categories.
6. Group author absence is replaced by the group chat ID in normalized
   `senderId`.
7. There is no production `isValidSenderId`; existing policy tests use a
   fake validator and representative examples.
8. The projection API cannot guarantee provenance by itself; future runtime
   composition must own construction from verified incoming event data.

## 11. Recommended future validator and architecture contract

Before implementation, obtain version-specific authoritative evidence for
the accepted identifier categories and the canonical identity policy Friday
intends to use. Do not derive a regex from examples or from the internal
`WAWebWidFactory` calls.

The minimum future design should:

1. Preserve an explicit message category and incoming/self-origin state from
   the adapter boundary. Admit only positively identified private direct
   messages for private tool authorization; reject groups, channels,
   broadcasts/statuses, unknown categories, and self-authored messages.
2. Keep `privateSenderId`, `groupParticipantId`, and `groupChatId` as
   distinct values. For groups, missing `author` must be represented as
   missing participant identity, not replaced with the group chat ID.
3. Define a validator/canonicalizer from the authoritative accepted-format
   contract. It must return a typed identity category and one canonical
   value, or fail closed. No coercion, display-name fallback, or suffix
   heuristic may silently convert one category into another.
4. Use exactly the canonical private identity for both identity validation
   and `privateSessionId()` derivation. The same resolver and validator
   dependencies must be used by the projection and authorization policy.
5. Construct trusted projection input only inside the application-owned
   composition boundary from the normalized incoming adapter event and
   application-owned session resolution. Do not expose a public route for
   arbitrary caller-supplied identity/session/capability values.
6. Keep application capabilities separately configured, default-deny, and
   independent from model input. Keep executor context free of raw sender
   IDs unless a separately reviewed tool contract requires scoped identity.
7. Add fake-based tests covering each documented supported identity form,
   all category confusion cases, missing/malformed IDs, LID/phone mapping
   behavior where applicable, self messages, session matching, and trusted
   projection construction. Validate any account-mode assumptions through a
   separately approved, non-production compatibility process.

## 12. Final readiness verdict

## NOT READY

The installed dependency gives useful field-role information, self-message
event behavior, category objects/flags, and an implementation-level LID/phone
mapping helper. It does not provide a locally documented exhaustive identity
format, a stable public general-purpose parser/validator/canonicalizer, or
verified account-mode equivalence guarantees. Friday also discards category
signals and falls back from missing group author to group chat ID.

The available evidence is insufficient to implement a production validator
without guessing formats or canonicalization semantics. No validator,
runtime integration, or tool execution was activated in this investigation.
