# Sprint 4.8D.3B — Private Conversation Classification Evidence Audit

## 1. Executive summary

This is a read-only, source-based investigation of whether the currently
installed WhatsApp integration has reliable positive evidence for classifying
an incoming message as a direct private conversation at message-event time.
No application code, tests, dependencies, or runtime behavior were changed;
no WhatsApp client was started.

The exact installed dependency is `whatsapp-web.js@1.34.7`. The raw
`Message` exposes useful fields for direction, status/broadcast signals, and
group participant identity. It does **not** expose an explicit private-chat
category field. `Message.getChat()` asynchronously resolves a chat through
the active WhatsApp Web page, but the resolved structure still does not
provide positive private evidence: `ChatFactory` returns `PrivateChat` when
both `data.isGroup` and `data.isChannel` are falsy, while
`PrivateChat` itself adds no positive marker. The internal chat-model builder
also initializes `isGroup` to `false` before selectively marking group or
channel state. These are fallback/negative states, not proof of a private
conversation.

Chat resolution can help identify some groups and channels, and the raw
message can positively mark some status/broadcast events. It does not close
the private-classification gap. The lookup is asynchronous, relies on
WhatsApp Web internals, may return `undefined` or reject, and does not
application-check that the returned chat ID matches the request.

**Overall verdict: NOT READY.** Keep trusted private classification
unavailable (`unknown`) and privileged eligibility deny-all until an
authoritative positive private signal and identity contract are established.

## 2. Exact installed dependency version

**Observed:**

- `node_modules/whatsapp-web.js/package.json` reports version `1.34.7`.
- `package-lock.json` resolves `node_modules/whatsapp-web.js` to `1.34.7`.
- The application manifest requests `^1.34.7`; the installed version is
  determined by the lockfile, not the range alone.

All implementation conclusions below refer to the current installed package
source. Type declarations are noted separately and are not treated as runtime
proof.

## 3. Files and methods inspected

### Installed dependency

- `node_modules/whatsapp-web.js/package.json`
- `node_modules/whatsapp-web.js/index.d.ts`
- `node_modules/whatsapp-web.js/src/Client.js`
  - Incoming `message` event emission
  - `getChatById()`
- `node_modules/whatsapp-web.js/src/structures/Message.js`
  - `_patch()`, `rawData`, `_getChatId()`, `getChat()`, `getContact()`
- `node_modules/whatsapp-web.js/src/structures/Chat.js`
  - `_patch()`
- `node_modules/whatsapp-web.js/src/structures/PrivateChat.js`
- `node_modules/whatsapp-web.js/src/structures/GroupChat.js`
- `node_modules/whatsapp-web.js/src/structures/Channel.js`
- `node_modules/whatsapp-web.js/src/factories/ChatFactory.js`
- `node_modules/whatsapp-web.js/src/structures/Base.js`
- `node_modules/whatsapp-web.js/src/util/Injected/Utils.js`
  - `WWebJS.getChat()`, `getChatModel()`, `getChannels()`

### Friday integration

- `src/friday-runtime.js`
- `src/whatsapp/client.js` (empty in the current checkout)
- `src/whatsapp/message-adapter.js`
- `src/whatsapp/message-queue.js`
- `src/application/message-service.js`
- `src/database/sqlite.js`
- `src/application/trusted-runtime-context.js`
- `src/application/tool-authorization-policy.js`

No live WhatsApp connection or account data was used.

## 4. Raw message field inventory

`Message._patch(data)` stores the passed data reference in `_data` and copies
or derives public properties. It does not validate the identity fields or
their categories. `rawData` returns the backing data object. The JavaScript
implementation and the declaration file describe different levels of
guarantee: declared primitive types do not ensure that the runtime source
provided a well-formed value.

| Property | Population in installed implementation | Availability / malformed behavior | Private-classification value |
|---|---|---|---|
| `from` | Copies `data.from`; if it is an object, copies `data.from._serialized`. | May be missing, non-string, or serialize to an unusable value if source data is incomplete. No identity validation. | Documented as the chat ID, not as evidence that the chat is private. |
| `to` | Copies `data.to`, serializing object values similarly. | Direction-dependent role; may be absent or malformed in incomplete data. | For incoming messages it is documented as the current user's ID; for self-authored messages it is the destination chat. Not a generic sender or private marker. |
| `author` | Copies `data.author`, serializing object values. | Optional; no validation or canonicalization. | Documented as the sender when sent to a group. A non-empty value supports a group-participant role; absence does not prove private. |
| `fromMe` | Copies `data.id.fromMe`. | No runtime boolean check. The constructor directly reads `data.id.fromMe`; absent/malformed `id` can cause construction failure or a malformed field. | Direction evidence only, not conversation category. |
| `id` | Copies `data.id`, adding `_serialized` from `$1` in one case. | Expected to have fields used directly by `_patch()`; no complete runtime schema validation. | Message-key structure, not an identity validator. |
| `id.fromMe` | Preserved inside `id`; also copied to `Message.fromMe`. | Usually comes from the same raw source as `fromMe`, but the implementation does not verify consistency after construction or later mutation. | Direction evidence only. |
| `id.remote` | Preserved inside the message ID. | May be absent or malformed in raw data; `_patch()` reads it when deriving `isStatus`. | Used for one status comparison; not a general sender or private-chat signal. |
| `isStatus` | Derived as `data.isStatusV3 || data.id.remote === 'status@broadcast'`. | `isStatusV3` is not required to be a boolean by runtime code; missing or truthy non-boolean values can affect the result. | A positive status signal when true; false/absent does not imply private. |
| `broadcast` | Copies `data.broadcast`. | Direct copy, no boolean validation; may be missing despite the declaration's `boolean` type. | A positive broadcast signal when true; false/absent does not imply private. |
| `type` | Copies `data.type`. | Copied without runtime category validation. | Message content type, not conversation category. |
| `_data` / `rawData` | `_data` retains the raw source reference; `rawData` exposes it. | Raw/internal object can be mutable or incomplete and is not a stable application DTO. | No direct positive private evidence; internal fields must not be trusted as a public contract. |
| `getChat()` | Calls `client.getChatById(this._getChatId())`. | Returns asynchronous client work; can resolve `undefined` or reject. | May retrieve category metadata, but the current fallback does not positively establish private. |
| `getContact()` | Calls `client.getContactById(this.author || this.from)`. | Lookup uses a fallback and may require active-client work. | Not a chat-category validator; must not be used to infer private identity. |

`Message._patch()` also derives fields such as `hasMedia`, `body`,
`timestamp`, `isForwarded`, and `deviceType`. Those are not positive private
conversation signals. `body`, captions, contact names, and display metadata
must not be treated as identity evidence.

## 5. Message-event evidence analysis

**Observed event path:** `Client.js` constructs a `Message`, emits
`message_create`, returns when the underlying `msg.id.fromMe` is truthy, and
otherwise emits `message`. This code filters self-authored events from the
`message` event, but does not classify the remaining event as private,
group, channel, or status.

For the `message` listener, `fromMe` is normally false in the installed
event path. That is direction evidence, not proof that `from` identifies a
private conversation. The code shown does not establish that the `message`
event exclusively contains direct private messages after the self filter.

Relevant raw signals:

- `author` is optional and its documented role is a sender in a group. Its
  presence can support a group interpretation; its absence is inconclusive.
- `isStatus` and `broadcast` can positively identify some status/broadcast
  messages when the runtime values are true. Their false or absent values do
  not establish private.
- `from` is a remote/chat field. The `@g.us` suffix heuristic used by Friday
  is not an exhaustive category contract. No unrecognized ID may be inferred
  to be private.
- `type` describes content and does not distinguish conversation categories.
- The raw event does not expose a documented `isPrivate` or equivalent
  positive private-chat field.

The event constructor is passed internal WhatsApp Web message data, and
`Message._patch()` copies selected fields. Data availability and field
population are implementation-dependent; the public declarations do not
guarantee that every optional category signal is present or consistent.

## 6. Chat resolution analysis

### 6.1 Public wrapper path

**Observed:** `Message.getChat()` calls `_getChatId()` and delegates to
`Client.getChatById()`.

`_getChatId()` returns `to` when `this.fromMe` is truthy and `from`
otherwise. For an ordinary incoming event this selects `from`. If direction
is missing or malformed, JavaScript truthiness still selects a field; there
is no fail-closed direction check in `_getChatId()`.

`Client.getChatById(chatId)` is asynchronous. It evaluates
`window.WWebJS.getChat(chatId)` in the active Puppeteer page and, if a value
is returned, constructs a structure through `ChatFactory`. The wrapper
returns `undefined` for a falsey page result. Its JSDoc describes
`Chat|Channel`, while the TypeScript declaration says `Promise<Chat>` and
does not express the runtime `undefined` case.

The lookup uses the requested ID, but the wrapper does not compare the
returned structure's ID with that request. It therefore supplies no
application-level identity binding or consistency check of its own.

### 6.2 Underlying WhatsApp Web lookup

**Observed installed implementation detail:** `WWebJS.getChat()`:

1. Tests the requested ID with `/@\w*newsletter\b/` to choose a channel path.
2. Constructs a Wid using internal `WAWebWidFactory`.
3. For the channel path, looks in `WAWebNewsletterCollection`; if absent, it
   attempts to load a newsletter preview and find the chat. Errors in that
   path are caught and converted to `null`.
4. For other IDs, looks in the internal `Chat` collection or calls internal
   `findOrCreateLatestChat()`.
5. Serializes the result through `getChatModel()`.

`getChatModel()` initializes `model.isGroup = false`. When the serialized
chat has `groupMetadata`, it changes `isGroup` to true and performs an
internal metadata update. On the channel path it derives `isChannel` with an
internal newsletter getter. The helper also updates newsletter metadata and
may update group metadata and participant IDs.

Consequences:

- Resolution requires an active client page and asynchronous Puppeteer and
  WhatsApp Web work. It is not a synchronous property of the raw event.
- Channel resolution can return no result after an internally caught error;
  other lookup/page errors can reject.
- A returned object may have incomplete category data, depending on the
  internal lookup and serialization.
- `findOrCreateLatestChat()` is not merely a local, immutable read of the
  original event. The returned model is a point-in-time serialization with no
  event-version binding. The package does not promise that it cannot become
  stale relative to later WhatsApp state.
- No local application check asserts that the returned ID equals the
  requested event chat ID.
- A successful lookup can improve group/channel recognition, but it does not
  resolve the private-positive-evidence gap.

These are source observations, not guarantees about all account modes or
future WhatsApp Web internals.

## 7. ChatFactory and PrivateChat fallback

`ChatFactory.create(client, data)` uses this order:

```text
if (data.isGroup)   -> GroupChat
else if (data.isChannel) -> Channel
else                -> PrivateChat
```

The checks are truthiness checks, not strict boolean checks. If both category
flags are truthy, `GroupChat` wins. `ChatFactory` itself does not validate
the metadata, confirm that flags are complete, or reject contradictory
values.

`PrivateChat` is an empty subclass of `Chat`; it does not set an `isPrivate`
flag or perform additional validation. `Chat._patch()` copies
`data.isGroup`, but does not set a private-category field or retain the
complete input object. In the `getChatModel()` path, `isGroup` is initialized
to false before group metadata can set it to true. The normal chat path does
not produce an explicit positive private marker.

The returned `PrivateChat` therefore means only that the factory did not
take its group or channel branch. It does **not** prove that the chat was
positively established as a direct private conversation. Missing,
incomplete, falsey, or unsupported category metadata can all reach this
fallback.

Contradictory flags can also be lost: if both `isGroup` and `isChannel` are
truthy, the factory chooses `GroupChat`. The generic `Chat` structure does
not copy `isChannel`, so a consumer of the constructed instance may not be
able to detect that conflict.

## 8. Positive private evidence assessment

| Candidate | Positive evidence | Negative / fallback behavior | Assessment |
|---|---|---|---|
| Raw `Message.from` | Identifies the chat field in the dependency's documented role. | No private category tag or format validator; the field can represent unsupported categories. | Not positive private evidence. |
| Missing `author` | None. | `author` is optional; absence can occur for non-group messages and does not prove private. | Unavailable/inconclusive. |
| `fromMe === false` | Supports incoming direction. | Does not identify conversation category. | Direction only. |
| `broadcast === false` / `isStatus === false` | May rule out only the corresponding positive flag if values are trustworthy. | Neither flag is a complete category discriminator; other unsupported types remain. | Negative/incomplete evidence, not positive private evidence. |
| `Chat.isGroup === false` | May be a negative group observation if the field is populated and trustworthy. | `getChatModel()` explicitly initializes it false; missing metadata and non-group categories share that value. | Insufficient. |
| `Chat.isChannel === false` or absent | None for private. | Channel field is path-dependent; it may be absent. | Insufficient. |
| `PrivateChat` instance | Factory's chosen class. | It is the default branch whenever `isGroup` and `isChannel` are falsey; the class adds no positive marker. | Explicitly not sufficient. |
| Non-`@g.us` identifier | None established by the public API. | Friday currently treats it as private, but the dependency exposes other categories and no exhaustive suffix contract. | Heuristic only; must not be used by a trusted boundary. |
| Resolved chat without group/channel metadata | A chat lookup succeeded. | Factory still falls through to `PrivateChat`; no explicit direct-chat assertion exists. | Not positive private evidence. |

No inspected public API or installed implementation establishes the statement
"this remote conversation is positively a direct private conversation" with
a complete, fail-closed result for all supported event shapes.

## 9. Other conversation-category evidence

| Category | Raw message evidence | Resolved-chat evidence | Confidence and limitations |
|---|---|---|---|
| Group | `author` is documented as the sender if the message was sent to a group; `from` may look group-like but suffix alone is not exhaustive. | `getChatModel()` sets `isGroup` true when `groupMetadata` exists; `ChatFactory` selects `GroupChat` for truthy `isGroup`. | Can be positively recognized in some cases. `author` may be absent; metadata depends on internal runtime lookup. |
| Channel | No dedicated channel flag is populated on `Message` in the inspected `_patch()`. | Internal `getChat()` checks a newsletter-like ID regex; newsletter lookup and `getChatModel()` can set `isChannel`; `ChatFactory` selects `Channel` when truthy. | Can be recognized through the installed internal path, but the ID regex/internal helpers are not a stable public category contract. |
| Broadcast | `broadcast` is copied from raw data. | Broadcast structures and client methods exist, but `Message.getChat()` does not itself establish a private-vs-broadcast result. | Positive only when a reliable runtime boolean is true; absent/false does not prove private. |
| Status | `isStatus` is derived from `isStatusV3` or the internal status remote marker. | `getChat()` routes status IDs through its non-channel lookup branch unless another signal intervenes. | Positive when `isStatus` is true; false/absent or lookup fallback does not prove private. |
| Unknown/unsupported | No complete category field on `Message`. | The factory maps falsey/missing group/channel flags to `PrivateChat`. | Must remain `unknown` in a trusted boundary; current factory fallback is not a safe unknown discriminator. |

The installed event handler's self-message filter is not evidence that the
remaining `message` events contain only private messages. Source inspection
does not establish complete category delivery behavior for every broadcast,
status, channel, or unsupported message subtype.

## 10. Event-time availability matrix

| Availability stage | Evidence | Source boundary | Reliability for private classification |
|---|---|---|---|
| Immediately on raw `message` event | `from`, `to`, `author`, `fromMe`, `id`, `type`, `isStatus`, `broadcast`, `_data`/`rawData` | Public `Message` shape backed by `_patch()` from internal event data | No positive private marker. Useful direction/status/group-role signals remain partial and unvalidated. |
| Through `message.getChat()` | Chat lookup based on `_getChatId()`; `isGroup`, possible `isChannel`, group/channel metadata | Public method, but asynchronous `Client.getChatById()` and internal `WWebJS.getChat()` | Can improve group/channel evidence. Private remains a factory fallback, not positive. |
| Other client methods | `getChats()`, `getChannels()`, contact lookups and other client queries | Public wrappers around active-page lookups | May provide current objects but are not event-bound, can be incomplete or absent, and do not establish canonical sender identity. |
| Internal WhatsApp Web structures | Collections, Wid creation, `findOrCreateLatestChat`, newsletter/group metadata and getters | Internal page modules in `Utils.js` | Version-fragile; not a stable public contract. The private fallback remains. |
| Not reliably available | Exhaustive positive private marker, complete category contract, canonical sender identity, event-bound immutable chat metadata | Not established by inspected source | Treat as unavailable; classify unknown and deny privileged eligibility. |

The queue could technically await an async resolver if its task were changed,
but this sprint does not modify it. Adding resolution would add latency,
depend on client-page availability, and require explicit failure handling.
The resolver's current output still does not satisfy private classification.
If resolution fails, returns undefined/incomplete metadata, or yields
contradictory evidence, a future trusted path must classify `unknown` and
deny; it must not fall through to private.

## 11. Public API versus implementation boundary

| Evidence | Classification | What can be relied on | What cannot be claimed |
|---|---|---|---|
| `Message.from`, `author`, `fromMe`, `isStatus`, `broadcast`, `Message.getChat()` declarations | Public TypeScript declarations | Intended field roles and API shape for the installed version. | Runtime presence, strict boolean validity, complete category semantics, or ID canonicalization. |
| `Message._patch()`, `getChat()`, `_getChatId()` | Installed package implementation | Exact current field-copy and lookup behavior. | Stable semantics across future package/WhatsApp Web versions or malformed source data. |
| `Client.getChatById()` | Public wrapper plus implementation | Asynchronous page lookup and current `ChatFactory` construction path. | Complete metadata, guaranteed non-undefined result (source can return undefined), or application-level ID equality. |
| `ChatFactory`, `PrivateChat`, `Chat`, `Channel` | Installed package implementation | Current truthiness-based class selection and fallback; class fields copied today. | That `PrivateChat` fallback is a positive category assertion. |
| `WWebJS.getChat()` and `getChatModel()` | Internal WhatsApp Web integration | Current internal collection, regex, metadata, and fallback mechanics. | A stable public contract; internals may change without a Friday-compatible guarantee. |
| Account-specific delivery or identity behavior | Not inspected live | Nothing beyond local source behavior. | That all private, group, channel, status, and broadcast messages arrive with the same fields across accounts. |

No web research or real-account inspection was performed. No fake test or
type declaration is treated as proof of live WhatsApp behavior.

## 12. Security evidence matrix

“Future privileged path” refers to the proposed boundary only. It is
currently disconnected and must deny all cases until the private evidence
and identity contracts are established.

| # / scenario | Available evidence and source | Assessment / expected classification | Future privileged path |
|---|---|---|---|
| 1. Genuine incoming private message with complete metadata | Raw `from`, `fromMe`, and possibly a resolved chat object; no explicit positive private field exists. | Incoming direction may be positive; category remains `unknown` unless a positive private signal is established. | Deny: no positive private proof or canonical identity. |
| 2. Non-group remote ID without explicit private metadata | `from` string; Friday suffix heuristic; category flags absent. | `unknown`; non-group is not equivalent to private. | Deny: heuristic only. |
| 3. `PrivateChat` from default `ChatFactory` fallback | Returned class after both `data.isGroup` and `data.isChannel` are falsey. | `unknown`; class is fallback, not positive private evidence. | Deny. |
| 4. Incoming group message with valid `author` | Raw `author` with documented group-sender role; potentially `from`; possibly resolved `isGroup`. | `group` when evidence is consistent; `author` remains group participant identity. | Deny: group is not private. |
| 5. Group message with missing `author` | Group metadata may establish group; `author` absent. | `group` if positive group metadata exists, otherwise `unknown`; participant identity unavailable. | Deny; never substitute `from`. |
| 6. Incoming channel message | Raw message has no dedicated channel flag; resolved object may expose `isChannel` through internal newsletter path. | `channel` only with positive resolved channel evidence; otherwise `unknown`. | Deny: not private; resolution is internal and asynchronous. |
| 7. Broadcast message | Raw `broadcast` may be true, false, absent, or malformed. | `broadcast_status` when a valid positive signal is true; otherwise category may remain unknown. | Deny unless a future separately approved category policy exists; never private by absence. |
| 8. Status message | Raw `isStatus`, derived using internal status flag/remote marker. | `broadcast_status` when `isStatus === true`; missing/false is inconclusive. | Deny. |
| 9. Missing `from` | Required by current normalizer and needed by `_getChatId()` lookup. | `unknown`; no chat identity. | Deny. |
| 10. Missing chat metadata | Raw event remains; `getChatById()` can return undefined. | `unknown` absent another positive raw category signal; no private fallback. | Deny. |
| 11. `getChat()` rejects | Page evaluation, internal lookup, or Wid creation can fail; non-channel errors can propagate. | `unknown`; preserve failure as unavailable metadata. | Deny; no success-shaped fallback. |
| 12. `getChat()` returns incomplete metadata | Chat may serialize without reliable group/channel flags; factory falls through. | `unknown`; a `PrivateChat` result does not repair missing evidence. | Deny. |
| 13. Conflicting group and channel signals | Raw author/group metadata may coexist with a channel flag; factory checks group first. | `unknown`; current factory may select `GroupChat` and hide channel evidence. | Deny; conflict cannot be safely resolved by precedence. |
| 14. Conflicting status and group signals | `isStatus`/`broadcast` plus group author or resolved group metadata. | `unknown` unless a verified precedence contract exists; none is established here. | Deny. |
| 15. Unknown remote identifier format | Raw string; no exhaustive parser/canonicalizer. | Category `unknown` unless independent positive evidence says otherwise. | Deny; do not infer private from string shape. |
| 16. Private-looking identifier with unsupported metadata | Example-like ID but missing/ambiguous category. | `unknown`; example/suffix is not accepted-format evidence. | Deny. |
| 17. Group-looking identifier with contradictory metadata | Suffix heuristic suggests group while other category signals conflict or are incomplete. | `unknown`; suffix does not resolve contradiction. | Deny. |
| 18. Self-authored message | `id.fromMe` used by Client event filter; `fromMe` copied to Message. | Direction `self`; category may still be independently known. | Deny: self-authored events are ineligible. |
| 19. Missing direction information | `fromMe`/`id.fromMe` absent or malformed in raw data; no strict runtime validation. | Direction `unknown`; category independently unknown or known. | Deny. |
| 20. Resolved chat category cannot be positively established | `Chat.isGroup` false/undefined, `isChannel` absent/false, factory fallback. | `unknown`, not private. | Deny. |

## 13. Safe classification strategy comparison

| Strategy | Security properties | Reliability / compatibility | Operational complexity and failure behavior | Suitability |
|---|---|---|---|---|
| **A — Raw Event Only** | Preserves explicit `fromMe`, `isStatus`, `broadcast`, and optional group `author`; does not infer private from missing group evidence. | Low complexity and no legacy change. Can positively identify some non-private cases, but cannot positively establish private. | Synchronous. Missing, malformed, or conflicting fields must yield `unknown`. | Not suitable to enable a trusted private path; safe only as a fail-closed classifier. |
| **B — Raw Event Plus Resolved Chat Metadata** | Can add positive group/channel signals when returned metadata is explicit. Still must reject PrivateChat fallback and conflicts. | More information, but lookup is async and relies on internal WhatsApp Web behavior. The result is not event-version-bound and the current factory can hide conflicts. Does not solve private proof. | Adds latency and page/client failures. Undefined, rejected, incomplete, mismatched, or conflicting lookup must yield `unknown`; never fall back to private. | Not currently sufficient for trusted private classification. Could be reconsidered only after a supported positive private contract is documented and tested. |
| **C — Explicit Deny-Until-Verified** | Defaults category to `unknown`; grants no private eligibility absent an approved positive signal. No string-shape guessing or fallback. | Preserves legacy behavior if kept separate; blocks new privileged use until evidence is available. | Operationally simple; unavailable evidence is an explicit denial. | Recommended interim policy. Safe for the future boundary, but does not make private classification available. |

## 14. Recommended classification contract

**Proposed, not implemented:**

1. Define classification separately from identity validity and direction.
2. Permit `private` only from a documented, version-supported positive
   direct-chat signal. No such signal is established by this audit.
3. Recognize group, channel, broadcast/status only from positive,
   non-conflicting evidence; do not use absence of one category as evidence
   for another.
4. If any category signals conflict, are malformed, or cannot be obtained,
   return `unknown`.
5. Preserve raw direction evidence; classify `incoming` only from explicit
   non-conflicting false direction evidence, `self` from explicit self
   evidence, and otherwise `unknown`.
6. Treat `from` as raw chat identity; keep `author` as a separate optional
   group participant identity. Never use group `from` as participant or
   private identity.
7. Treat `PrivateChat`, `isGroup === false`, missing `author`, an
   unfamiliar/recognized suffix, or a display name as insufficient private
   evidence.
8. If asynchronous resolution is later introduced, await it only in a
   separate future path; require a bounded failure policy and preserve
   `unknown` on failure. Do not modify the existing queue as part of this
   audit.
9. Keep private trusted eligibility unavailable and privileged authorization
   deny-all until both classification and identity/canonicalization have
   separate evidence-backed contracts.

## 15. Unresolved questions

1. Is there a supported public API or documented runtime field that
   positively identifies a direct private chat rather than the
   `ChatFactory` fallback?
2. Does that signal remain available and semantically stable across
   supported WhatsApp account modes and linked-device states?
3. Which category flags are reliably populated on every relevant
   `message` event, and can group/channel/status signals conflict in real
   event data?
4. Is `Message.getChat()` guaranteed to resolve the event's original chat
   under all directions and event timings, and what consistency guarantee
   does the returned model have?
5. What is the supported policy for absent or malformed IDs, unsupported
   categories, and chat-resolution failures?
6. Is internal `WWebJS.getChat()` behavior acceptable for a security
   boundary, given its internal collections, ID regex, and mutable
   WhatsApp Web dependencies? No stable contract is established here.
7. Which version-pinned integration tests can be run without a real account
   to validate wrapper behavior, while recognizing that they cannot prove
   live account-specific semantics?

## 16. Final verdict and next sprint recommendation

| Area | Verdict | Basis |
|---|---|---|
| Raw-event-only classification | **NOT READY** | No positive private marker; raw fields provide only partial category/direction evidence. |
| Raw-event-plus-chat-resolution classification | **NOT READY** | Better group/channel signals, but private remains a fallback and resolution relies on async internal APIs. |
| Explicit deny-until-verified strategy | **READY as an interim safety policy** | `unknown` plus deny-all is fail-closed; it does not assert private classification. |
| Future trusted private boundary | **NOT READY** | No verified positive private classification or identity/canonicalization contract. |
| Private text-only tool pilot | **NOT READY** | No trusted private event boundary or production runtime composition. |
| Production tool execution | **NOT READY** | No production identity proof, grant authority, or runtime integration. |

**Overall sprint verdict: NOT READY.** No reliable positive private
classification contract is established by the inspected package. Keep
private classification unavailable and privileged eligibility deny-all.

Recommended next sprint: obtain authoritative, version-specific evidence
for a positive private signal and its account-mode behavior. If no such
signal exists, explicitly retain the deny-until-verified design rather than
adding suffix rules or treating `PrivateChat` fallback as proof. Any later
boundary implementation must remain isolated from legacy routing and
production tool execution until a separate security review.

## Verification and change boundary

- Installed dependency source and the current Friday integration were
  inspected directly.
- This was a read-only investigation. Tests were not run because no source
  or test behavior was changed.
- No real WhatsApp account was used, and no external research was performed.
- `git diff --check` and the final Git status were checked after adding this
  report.
- The only intended file addition is this audit report. Production identity
  validation and production tool execution remain disabled.
