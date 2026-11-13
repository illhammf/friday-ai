# Sprint 4.8D.2D — Identity Validation Evidence and Strategy

## 1. Objective and scope

This read-only investigation assesses whether the installed
`whatsapp-web.js` dependency provides sufficient, supported evidence for
validating WhatsApp sender identities, resolving LID/phone-number pairs, and
selecting a canonical identity for private sessions.

The audit inspects the installed package implementation and declarations,
Friday's earlier identity findings, and the 4.8D.2C boundary design. It does
not implement a validator, connect to WhatsApp, query an account, access
external resources, or change runtime behavior. No real account identifiers
were used.

## 2. Installed dependency version

- `package.json` declares `whatsapp-web.js: ^1.34.7`.
- `package-lock.json` resolves the package to `1.34.7`.
- `node_modules/whatsapp-web.js/package.json` reports `1.34.7`.

The source paths below refer to that installed version. Implementation
details must not be presumed stable across releases.

## 3. Verified API and implementation evidence

### Message identity fields

`Message._patch()` in
`node_modules/whatsapp-web.js/src/structures/Message.js` assigns:

- `from` from `data.from`, serializing object values via `_serialized`;
- `to` from `data.to`, also serializing object values via `_serialized`;
- optional `author` from `data.author`, likewise serializing object values.

Its source comments describe `from` as the chat ID and `author` as the user
who sent a group message. Neither field is validated or canonicalized there.
`Message.id` is a separate message key; its `remote` and composite
`_serialized` fields are not declared to be a sender identity.

The corresponding `Message` declaration in
`node_modules/whatsapp-web.js/index.d.ts` types `from` as `string`,
`author` as optional `string`, `fromMe` as `boolean`, and `isStatus` and
`broadcast` as booleans. These types specify shapes and field roles, not an
exhaustive accepted identifier format.

### Chat and participant identity fields

`ChatId` and `ContactId` in `index.d.ts` expose `server`, `user`, and
`_serialized` as strings. Their comments and examples illustrate serialized
IDs, including phone-number-looking examples. These examples do not define
all valid server values, user values, identity categories, or supported
account modes.

`GroupParticipant.id` is typed as `ContactId`. In `GroupChat.js`, group
participant operations call the internal LID/phone retrieval helper before
looking up participants by either returned serialized value. This
demonstrates implementation-level support for more than one representation
in group operations; it does not establish a general identity equivalence
contract.

`Contact._patch()` in `src/structures/Contact.js` stores `data.id` as the
contact ID and separately stores `data.userid` as `number`. It also exposes
flags including `isMe`, `isUser`, and `isGroup`. These are contact data
fields; they do not prove that an arbitrary `Message.from` or `author`
string has been validated as that contact's canonical identity.

### Public lookup and formatting methods

The package exposes these relevant `Client` methods:

| API | Declaration/source | What it establishes | What it does not establish |
|---|---|---|---|
| `getContactById(contactId)` | `index.d.ts`; `src/Client.js`, `Client.getContactById()` | Queries the active WhatsApp Web client for a contact and returns a `Contact` structure. | No documented offline validation, exhaustive accepted format, role distinction for arbitrary input, or stable canonical identity. |
| `getNumberId(number)` | `index.d.ts`; `src/Client.js`, `Client.getNumberId()` | Appends `@c.us` when that suffix is absent, constructs a Wid, queries existence, and may return `null` when no `wid` is returned. | Not a validator for all private identities or group participants; it is phone-number-oriented, changes input, depends on the active page, and does not define LID equivalence. |
| `isRegisteredUser(id)` | `index.d.ts`; `src/Client.js`, `Client.isRegisteredUser()` | Converts the result of `getNumberId()` to a boolean. | Inherits `getNumberId()` limitations; does not validate all identity categories or canonicalize IDs. |
| `getContactLidAndPhone(userIds)` | `index.d.ts`; `src/Client.js`, `Client.getContactLidAndPhone()` | Calls an injected helper for each input and serializes available `lid` and `phone` results. | Does not guarantee both results, stable equivalence, conflict handling, or canonical choice; it is not an offline validator. |
| `getFormattedNumber(number)` | `index.d.ts`; `src/Client.js`, `Client.getFormattedNumber()` | Rewrites some number-like inputs toward a phone-number server form, then calls WhatsApp Web phone formatting. | Formatting output is not documented as a universal identity canonical form; does not cover LID, group, channel, or all account modes. |
| `getCountryCode(number)` | `index.d.ts`; `src/Client.js`, `Client.getCountryCode()` | Removes selected characters/suffix text and queries phone country-code logic. | Does not validate the input identity or establish canonical equivalence. |

These are public package methods in the inspected version. Their source
delegates to the active WhatsApp Web page and internal modules. Their
existence is not a public contract for complete identity validation.

## 4. Identity representation comparison

| Value | Role established by source/types | Validation/canonicalization evidence |
|---|---|---|
| `Message.from` | Chat remote/destination context, with direction caveat in the source comments | String serialization only; no format validation. |
| `Message.author` | Optional group-message sender/participant | String serialization only; absence is allowed by the type. |
| `Chat.id` / `ChatId` | Chat identity | Shape fields and examples; no general parser/canonicalizer contract. |
| `GroupParticipant.id` | Contact identity for a group participant | Contact ID structure; group operations internally attempt LID/phone matching. |
| `Contact.id` / `ContactId` | Contact identity | Structure fields; not proof that arbitrary event input is valid or canonical. |
| `Contact.number` | Contact phone-number field | Separate from `Contact.id`; no guarantee it exists or is equivalent for all identity modes. |
| LID value | Recognized internally when a Wid has `server === 'lid'` | Runtime helper attempts counterpart lookup; accepted format and stable mapping contract are not documented. |
| Phone-number identity | Used in phone lookup/formatting methods and internal mapping | Public methods are phone-oriented and network/client-state dependent; not a universal sender validator. |
| `Message.id.remote` | Component of a message key | Not declared as a sender ID. |
| `Message.id._serialized` | Composite message key serialization | Message deduplication data, not sender identity or canonical identity. |

The values above must not be treated as interchangeable. In particular,
group chat identity and group participant identity have distinct source
fields, and neither is implicitly a private sender identity.

## 5. LID and phone-number investigation

### Public API and observed implementation

`Client.getContactLidAndPhone()` in
`node_modules/whatsapp-web.js/src/Client.js` takes one or more user IDs,
calls `window.WWebJS.enforceLidAndPnRetrieval(userId)` for each, and returns
serialized `lid` and `pn` values using optional access. The declaration in
`index.d.ts` describes an array of `{ lid: string; pn: string }`, but the
implementation can produce `undefined` values when either lookup is
unavailable. The implementation uses `Promise.all`; errors from the page
evaluation or internal helper are not converted into a verified identity
result by this method.

The injected helper in
`node_modules/whatsapp-web.js/src/util/Injected/Utils.js`,
`enforceLidAndPnRetrieval()`, constructs a Wid using internal
`WAWebWidFactory`, checks `wid.server === 'lid'`, and calls internal
`WAWebApiContact.getCurrentLid()` or `getPhoneNumber()`. When the
counterpart is missing, it queries `WAWebQueryExistsJob`; if no `wid` is
returned it returns `{}`. Otherwise it retries the corresponding mapping
lookup and returns `{ lid, phone }`. This is a runtime observation of
WhatsApp Web internals, not a pure, offline validator or documented
canonicalization API.

`GroupChat.js` invokes the same helper in participant operations and checks
participant collections against either the LID or phone serialized value.
`Utils.js` also contains code that calls internal `WAWebLidMigrationUtils`
conversion routines when preparing chat models. This demonstrates that the
installed package has implementation paths accounting for multiple identity
representations. It does not specify when each form is issued, whether the
mapping is stable, or which representation should be a permanent Friday
session key.

### Assessment

- LID is recognized by internal code through the Wid server field comparison.
- A public runtime helper can attempt to return LID/phone counterparts.
- A lookup may return missing counterpart values or an empty result.
- Dependency/page errors can propagate; no signed, verified, or conflict-
  checked mapping result is specified by the public declaration.
- No local version-specific contract establishes identity stability across
  linked devices, migrations, account modes, or changes in WhatsApp Web.
- No evidence says LID and phone identities are interchangeable for Friday's
  history, authorization, or private session purposes.
- No real account or account identifier was used to test these behaviors.

Therefore the mapping API cannot currently be used as a canonical identity
authority for private sessions or tool authorization.

## 6. Validation and canonicalization capability matrix

| Capability | Evidence classification | Finding |
|---|---|---|
| Validate private sender ID offline | Unsupported/unavailable | No public parser or validator with an exhaustive accepted format was found. |
| Validate group participant ID offline | Unsupported/unavailable | `GroupParticipant.id` gives a type shape, not an accepted-format validator. |
| Resolve LID to phone number | Verified public runtime API plus internal implementation; incomplete contract | `getContactLidAndPhone()` attempts it against the active client, but missing results and unsupported stability semantics remain. |
| Resolve phone number to LID | Verified public runtime API plus internal implementation; incomplete contract | Same method/helper attempts it but does not guarantee a counterpart or specify complete input acceptance. |
| Establish stable identity equivalence | Unsupported/incomplete | No stable equivalence or lifetime guarantee is documented in the inspected package. |
| Select a canonical identity for session derivation | Unsupported/unavailable | No documented canonical preference or all-mode rule exists. |
| Validate group/private category of arbitrary string | Unsupported/unavailable | String fields and internal Wid use do not provide a public universal category validator. |
| Format phone-number-like ID | Verified public helper; incomplete for identity use | `getFormattedNumber()` performs phone formatting and input rewrites; formatted phone output is not a general canonical sender key. |
| Look up registered phone number | Verified public runtime API; limited | `getNumberId()` queries existence after appending a phone-oriented suffix; it does not validate LID/group IDs or prove sender provenance. |
| Compare identities safely across representations | Unsupported/unavailable | Internal group operations compare both lookup results; no general public comparison API/contract was found. |

No sample identifier, example in a type declaration, or internal factory call
is used here as an accepted-format rule.

## 7. Failure and ambiguity analysis

| Condition | Evidence/concern | Required future behavior |
|---|---|---|
| Missing identity | `Message.author` is optional; mapping results may omit `lid` or `pn`. | Return explicit unavailable; derive no private identity/session and deny private tool eligibility. |
| Malformed identity | Package fields are strings; serialization does not validate. Internal Wid construction may throw, but that is not a documented validator result. | Do not coerce or infer validity from non-empty string; fail closed without guessed patterns. |
| LID resolution fails | Helper may return `{}` when existence lookup has no `wid`; page evaluation may reject. | Preserve resolution failure as failure; do not silently use the input or another field as canonical identity. |
| Phone-number resolution fails | Counterpart may be absent or query may fail. | Return unavailable; do not substitute a different identity representation. |
| Multiple forms available | API may return both `lid` and `pn`; no canonical preference is documented. | Treat as ambiguous until an approved policy selects one based on verified evidence. |
| Mapping results conflict | No conflict/equivalence contract or consistency validation is documented. | Reject as ambiguous; do not merge sessions or authorize either value. |
| Account mode unknown | Local README feature claims and source internals do not establish which forms are used in each mode. | Mark identity strategy unavailable for that mode; do not extrapolate. |
| Unexpected API result | Declaration promises strings while optional source values can serialize as undefined; runtime/page errors can propagate. | Validate result shape explicitly; report operational failure and deny. No success-shaped fallback. |
| Contact lookup returns absent/unexpected data | `getContactById()` returns a ContactFactory result from the active page; no completeness contract for all candidate IDs was found. | Treat as unresolved, not as proof that an identity is invalid or canonical. |
| Group participant ID confused with group chat ID | `author` is participant role; `from` is chat remote. Current Friday adapter falls back from `author` to `from`. | Keep roles separate; absent author remains absent, and no private session is derived from group chat ID. |

## 8. Proposed validator interface

The following is a design shape only, not implemented code or an assertion
that a validator is currently possible:

```js
/**
 * An application-owned strategy. Inputs must be extracted by the trusted
 * adapter/composition boundary; this interface does not itself prove
 * provenance.
 */
{
  validatePrivateSender(candidate) -> Promise<
    | {
        status: 'verified',
        role: 'private_sender',
        canonicalIdentity: string,
        evidenceId: string
      }
    | {
        status: 'unavailable' | 'invalid' | 'ambiguous',
        reason: string
      }
  >,

  validateGroupParticipant(candidate) -> Promise<
    | {
        status: 'verified',
        role: 'group_participant',
        canonicalIdentity: string,
        evidenceId: string
      }
    | {
        status: 'unavailable' | 'invalid' | 'ambiguous',
        reason: string
      }
  >
}
```

Contract requirements:

1. Inputs are role-tagged candidates extracted from application-owned
   message fields. Private and group-participant validation are distinct
   operations; a group chat ID cannot be submitted as a private sender.
2. Display names, message text/captions, assistant DTOs, model output, and
   tool arguments are never accepted as identity sources.
3. The implementation does not silently trim, rewrite, replace, or infer an
   identity. It returns explicit failure for missing, unsupported, or
   ambiguous evidence.
4. `canonicalIdentity` is returned only when a verified contract supports
   that identity and representation. Otherwise status is `unavailable`;
   callers must not resolve a private session.
5. Session resolution consumes precisely the verified canonical private
   identity returned by the validator. It must not independently choose
   between `from`, `author`, LID, phone, or message ID.
6. Provenance is enforced by keeping candidate construction and validator
   invocation within the application-owned composition boundary; a plain
   object or injected method alone cannot attest provenance.

### Current safe strategy

Until the missing contract is obtained, use an **unavailable/deny-all
private identity strategy** for privileged operations. It returns
`status: 'unavailable'` for private identity canonicalization, derives no
private tool session, and grants no private tool eligibility. This does not
mean ordinary legacy messages should be rejected or their existing session
behavior changed; it means no new privileged authorization is based on
unverified identity.

## 9. Security and compatibility implications

Any later identity work must preserve the separate boundaries defined in
`SPRINT-4-8D-2C-MESSAGE-CLASSIFICATION-IDENTITY-BOUNDARY-DESIGN.md`:

- Positive message classification precedes sender extraction. Unknown,
  channel, broadcast/status, group, and self-authored messages do not become
  private tool candidates.
- A group participant comes only from `author`; missing `author` remains
  missing. `from` remains the group chat remote.
- A canonical private identity must be established before private session
  resolution, and the same canonical value is used for validation and
  session derivation.
- No identity or capability is taken from display metadata, user text,
  model output, or tool arguments. Authorization remains default-deny.
- Existing private and group legacy behavior, group-prefix handling,
  group/session/history isolation, queue ordering/capacity, and message
  deduplication must remain unchanged unless a separately approved sprint
  deliberately changes them.
- Images, voice notes, stickers, video downloads, image generation, memory
  commands, and other specialized routes stay on the existing message
  service path. They must not be silently rerouted through a private
  text-only tool pilot.
- The identity validator strategy must not activate tools or grants.

No production tool execution is connected to the policy/projection modules.
This investigation does not change that boundary.

## 10. Unresolved dependencies

1. An authoritative, version-specific accepted identity contract for
   private senders and group participants, including role/category
   distinctions.
2. Documented LID/phone mapping semantics: when each representation is
   present, how missing mappings behave, how to resolve conflicts, and
   whether identity equivalence is stable.
3. A supported rule for selecting a canonical private identity across the
   account modes Friday intends to support, including linked-device and
   migration behavior.
4. Evidence that `getContactLidAndPhone()`'s internal WhatsApp Web
   dependencies are suitable and stable for authorization/session identity,
   or a separate authoritative API that provides the needed contract.
5. Explicit error/result semantics for missing or unexpected lookup values
   where the public declaration and implementation differ.
6. A production validator/canonicalizer and tests based on documented
   supported variants. Current fake-validator tests prove policy mechanics,
   not the identity contract.
7. An application-owned message classification and identity provenance
   boundary before any trusted runtime projection can be considered for
   production composition.

## 11. Final readiness verdict

## NOT READY

The installed `whatsapp-web.js@1.34.7` package exposes useful role fields,
phone-oriented lookups, and a public `getContactLidAndPhone()` method. Its
implementation relies on the active WhatsApp Web page and internal modules,
may return missing mappings, and does not define stable identity equivalence,
canonical selection, or exhaustive accepted formats. The contact and message
types expose strings and examples, not validation rules.

Consequently, a production validator that accepts or canonicalizes private
sender identities would require unsupported assumptions. Keep production
identity validation unavailable/deny-all for privileged operations until
the exact identity and account-mode contract is verified. No validator,
source code, tests, package configuration, database, or runtime behavior was
changed. Production tool execution remains disabled.
