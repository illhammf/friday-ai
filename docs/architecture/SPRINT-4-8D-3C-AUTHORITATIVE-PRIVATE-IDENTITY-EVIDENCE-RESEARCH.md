# Sprint 4.8D.3C — Authoritative Private Identity Evidence Research

## 1. Executive summary

This is a read-only source audit of the exact installed `whatsapp-web.js@1.34.7` implementation and Friday AI's current authorization architecture. No WhatsApp client was started, no account data was used, and no network research was performed.

The dependency exposes message routing IDs (`from`, `to`, optional group `author`), contact IDs, and lookup helpers. It also exposes `Client.getContactLidAndPhone()`, which delegates to the WhatsApp Web page's internal `WWebJS.enforceLidAndPnRetrieval()`. That helper is a best-effort asynchronous mapping interface: its returned LID and phone values may be missing, it is not a signed or application-verifiable assertion, and the library does not document freshness, uniqueness, account ownership, or a stable cross-format canonicalization contract. `getNumberId()` checks a phone-like ID against WhatsApp Web's existence query; it does not prove that a supplied LID belongs to that number. Formatting and country-code methods transform or interpret a phone-form ID and do not validate a principal.

No positive private-conversation marker was found. A `PrivateChat` is created when the internal factory sees neither positive group nor channel flags. That fallback remains insufficient. Contact metadata and a successfully resolved chat do not add an authoritative positive private assertion. Message IDs and identifiers alone cannot establish private chat classification or sender trust.

**Final overall verdict: NOT READY.** Current implementation evidence cannot safely establish all of private conversation, verified sender, canonical LID/phone principal, and principal-to-private-session binding. Keep trusted private classification unavailable, privileged eligibility deny-all, and production tool execution disabled.

## 2. Scope and investigation method

Read-only inspection of installed JavaScript and declarations, the Friday modules listed in section 11, and prior Sprint 4.8D.3A/3B reports. No runtime, tests, dependencies, schema, or account were exercised. Conclusions labeled **Observed** describe source behavior. Conclusions labeled **Assessment** are security judgments drawn from that behavior. Declarations and JSDoc are treated as library API descriptions, not proof that runtime data is complete or authentic.

## 3. Installed dependency version

**Observed:** `node_modules/whatsapp-web.js/package.json` reports `1.34.7`; `index.d.ts` is the package type entry. This report is pinned to the installed files. WhatsApp Web objects and modules accessed through `window.WWebJS` and `window.require(...)` are implementation details and may change independently of this package version.

## 4. WhatsApp identity field analysis

Paths below are relative to the repository root.

| Field/API | Implementation and behavior | Security meaning |
|---|---|---|
| `Message.from`, `to`, `author` | `node_modules/whatsapp-web.js/src/structures/Message.js`, `_patch()`: values are copied, and object IDs are reduced to `._serialized`. `author` is optional and described as the sender in a group. | Routing/role hints, not verified identity. `from` is the chat/remote ID; it must not be promoted to sender principal in all chat types. Never substitute group `from` for missing `author`. |
| `Message.id`, `id.fromMe`, `fromMe` | `_patch()` retains message key and copies direction from `data.id.fromMe`. No complete runtime validation of key or consistency. | Direction and message correlation only. Not sender authentication or private classification. |
| `Message.isStatus`, `broadcast` | `isStatus` is derived from `data.isStatusV3 || data.id.remote === 'status@broadcast'`; `broadcast` is copied. | Positive status/broadcast evidence when asserted true. False, absent, or malformed values do not establish private. |
| `Message.getChat()` | Public structure method, synchronous method returning the client's asynchronous `getChatById(_getChatId())` promise. | Resolves chat metadata through the page. May resolve `undefined` or reject; no identity proof. |
| `Message.getContact()` | Public structure method returning `getContactById(author || from)`. | A fallback lookup, not a verification boundary. In group messages a missing `author` can therefore direct lookup to the group ID. Do not use this as a sender identity rule. |
| `Client.getChatById(chatId)` | Public async wrapper in `src/Client.js`; calls `window.WWebJS.getChat(chatId)`, then `ChatFactory.create`; returns `undefined` when the page returns no chat. | Metadata lookup through WhatsApp Web internals. No application-enforced returned-ID match. |
| `Chat.id`, `Chat.isGroup`, channel flags | `src/structures/Chat.js` copies internal model data. `ChatFactory.js` returns `GroupChat` for truthy `isGroup`, `Channel` for truthy `isChannel`, else `PrivateChat`. | Truthy group/channel flags are useful positive exclusion evidence. Falsy flags select a fallback class; not positive private evidence. |
| `Contact.id`, `number`, `isUser`, `isGroup`, `isWAContact`, names | `src/structures/Contact.js` copies data, including display names and flags, without an application identity proof. | Useful metadata, subject to page/cache completeness and staleness. Names are never identities; `isWAContact` or a contact object does not prove event-sender ownership. |
| Serialized IDs | `_serialized` is copied from WhatsApp Web Wid objects or message IDs. Methods often pass the string back into page internals. | A serialization format, not a cryptographic or canonical principal. Suffix parsing is not a complete identity contract. |

The incoming `message` event's self-message filtering is not a private-chat assertion. `Message.author` is group-oriented and optional. Friday's adapter currently infers group from `message.from.endsWith('@g.us')`, then sets a missing group sender to `message.from`; this is unsafe for authorization and contradicts the intended invariant. This audit does not change that flow; the current flow must remain excluded from trusted authorization.

## 5. LID and phone identity mapping analysis

| API | Visibility / async behavior / result | What it establishes | What it does not establish |
|---|---|---|---|
| `Client.getContactLidAndPhone(userIds)` | Publicly declared and implemented async (`Client.js`, near `getContactLidAndPhone`). Calls internal `window.WWebJS.enforceLidAndPnRetrieval(userId)` per ID; returns array entries `{ lid: string\|undefined, pn: string\|undefined }`. Evaluation or internal call may reject; individual side may be absent. | A page-provided mapping attempt for an ID. | No documented freshness, provenance, collision handling, completeness, signed binding, or guarantee the two returned IDs are equivalent for authorization. Do not call its result verified equivalence. |
| Internal `WWebJS.enforceLidAndPnRetrieval()` | WhatsApp Web injected helper accessed through `window.WWebJS`; not a stable public whatsapp-web.js contract. | May enforce/retrieve corresponding LID and phone WIDs in the current Web session. | No package-level contract or independently verifiable assertion; it can change or fail with WhatsApp Web updates. |
| `Client.getNumberId(number)` | Public async wrapper. Appends `@c.us` if missing, constructs a Wid with internal `WAWebWidFactory`, then calls `WAWebQueryExistsJob.queryWidExists()`. Returns a Wid-like result or `null`; malformed input, page failures, or internal errors can reject. | Existence/registration lookup for a phone-form identifier. | Does not map a LID to a phone, prove the event sender controls the number, or establish a stable principal. |
| `Client.getContactById(contactId)` | Public async wrapper around `window.WWebJS.getContact`; returns `ContactFactory.create(...)`. Page lookup may reject or return incomplete data; no freshness guarantee. | Retrieves current page contact metadata for an ID. | Not an authenticated mapping or canonicalization operation. |
| `Contact.getFormattedNumber()` / `Client.getFormattedNumber(number)` | Public async formatting operation. Client rewrites some domains to `@s.whatsapp.net` and calls internal `WAWebPhoneUtils.formattedPhoneNumber`. Returns string; page/internal errors may reject. | Presentation normalization. | Not identity validation; LID input or incomplete data is not a proof of number equivalence. |
| `Contact.getCountryCode()` / `Client.getCountryCode(number)` | Public async lookup that strips a limited set of characters/domain and calls internal `WAPhoneFindCC.findCC`. Returns a string; no robust input contract. | Country-code interpretation. | Not account verification or canonicalization. |
| `Contact.id` and `Contact.number` | Contact model fields copied from page model (`id`, `userid`). | Contact identifier / phone-like metadata if present. | No guaranteed one-to-one, current, or authoritative association between phone and LID. |

**Assessment:** the installed library has identity lookup and partial mapping capabilities, but no reliable identity validation, no documented cross-format equivalence proof, and no suitable canonical-principal function for authorization. `getNumberId()` success is not proof that a sender event and a mapped LID are one account. Duplicated representations must remain ambiguous unless an application-owned authoritative resolver can validate the mapping under an explicit contract.

## 6. Private conversation evidence analysis

| Evidence class | Installed signals | Verdict for trusted classification |
|---|---|---|
| Positive private | No explicit `isPrivate`/private-origin assertion found on `Message`, `Chat`, or `Contact`. `PrivateChat` adds no marker. | **Unavailable.** |
| Positive group | Chat model/factory `isGroup` and group structure; common `@g.us` forms and optional `Message.author` are useful indicators. | Can deny private where positively present, but not sufficient as a complete inverse rule. |
| Positive channel | Chat factory/model `isChannel`, channel structure and channel-oriented client APIs. | Deny private where positively present. Missing flag is inconclusive. |
| Positive broadcast/status | `Message.broadcast`, `Message.isStatus` (including `status@broadcast` comparison). | Deny private when positively asserted; absence is inconclusive. |
| Unknown/unavailable | Missing or malformed fields, lookup failure, unrecognized IDs, false group/channel flags, `PrivateChat` factory fallback. | Must remain `unknown`; deny privileged eligibility. |

`ChatFactory.create()` uses the fallback path when both `data.isGroup` and `data.isChannel` are falsy. `PrivateChat.js` is an empty subclass. Therefore even a `PrivateChat` result is not positive evidence. A successful asynchronous `getChatById()` helps detect categories when their flags are set, but uses page internals, can return `undefined`/reject, and does not application-check returned chat ID against the requested event chat. Contact metadata contributes no independent authoritative private signal.

**Conclusion:** no reliable positive private-conversation signal is established by the installed dependency. Keep private privileged execution disabled.

## 7. Public API vs internal API assessment

Public wrappers and declared APIs include `Message.getChat()`, `Message.getContact()`, `Client.getChatById()`, `Client.getContactById()`, `Client.getNumberId()`, `Client.getContactLidAndPhone()`, `Client.getFormattedNumber()`, and `Client.getCountryCode()`. Their public status describes how application code calls them, not the trust level of their result.

The wrappers delegate to `window.WWebJS` and modules loaded with `window.require(...)` inside the active WhatsApp Web page. In particular, chat/contact retrieval, LID/phone enforcement, Wid construction, registration queries, formatting, and country-code discovery depend on WhatsApp Web internals. Puppeteer/page loss, API churn, missing cache/model data, and shape changes may yield absent values or rejected promises. Application code needs explicit timeout/error normalization and returned-ID consistency checks if these are ever used for non-privileged features. They are not a basis for silently authorizing a principal.

## 8. Identity verification strategy comparison

| Strategy | Guarantees | Limitations / failure modes | Internal dependency | Future production authorization |
|---|---|---|---|---|
| **A — Raw Event Validation** | Avoids asynchronous lookups and TOCTOU between event and later page state; can reject missing/conflicting fields and positive group/status signals. | Raw IDs are unverified; no positive private marker; unknown ID formats and missing `author` remain unresolved. | Event schema itself derives from Web internals. | **No.** Useful as an initial evidence collector only. |
| **B — Raw Event + Chat Metadata** | Can add positive group/channel metadata when consistently present; may verify requested chat ID equality in a future adapter. | No positive private marker; async lookup may return undefined, stale/incomplete data, reject, or race; false flags are not proof. | High: `WWebJS.getChat`, ChatFactory model shape. | **No.** Additional exclusion evidence only. |
| **C — Raw Event + Contact Identity Mapping** | Can obtain contact metadata and attempt LID/phone mapping; can detect some mismatches or ambiguity. | Lookup success is not authenticated equivalence, mapping may be partial/stale, and contact can be missing. Names/number formatting are not identity. | High: Contact models, `enforceLidAndPnRetrieval`, phone query/format modules. | **No, by itself.** Could be an input to a separately specified verified provider, not the authority. |
| **D — Strict Deny Until Verified** | No privilege on unavailable, invalid, ambiguous, inconsistent, stale, or failed identity evidence; default is deny. | Reduces availability; requires later authoritative source and explicit application principal binding. | Can operate independently of identity internals by denying when evidence cannot be validated. | **Yes as a safety policy, not as a grant of readiness.** This is the recommendation now. |

Recommended approach: use D for eligibility, with A/B/C only as evidence inputs for a future verifier. Do not interpret absence of a contradiction as verification.

## 9. Proposed identity verification contract

Conceptual only; not implemented. Keep identity verification separate from conversation classification.

```js
// Classification returns evidence about the conversation, not the sender.
classifyConversation({ event, chatLookup }) =>
  { status: 'private_verified' | 'group' | 'channel' | 'broadcast' | 'unknown', evidence: [...] }

// Verifier returns identity state; only verified contains an opaque app-owned principal.
verifySenderIdentity({ event, conversationEvidence, identityProvider }) =>
  | { status: 'verified', principalId, subjectKey, evidenceVersion }
  | { status: 'unavailable', reason }
  | { status: 'invalid', reason }
  | { status: 'ambiguous', reason, candidatesCount }
```

Contract requirements:

- The verifier accepts an immutable, allowlisted snapshot of the original event; it never chooses `author || from` generically. For a positively identified group, sender must come from an explicit participant field; absent participant is invalid/unavailable, never the group ID.
- Conversation classification produces its own result. Identity `verified` cannot upgrade `unknown` conversation evidence into private.
- `identityProvider` is dependency-injected and returns typed, provenance-bearing mapping evidence (source, observed-at/version, input ID, mapped IDs). A phone existence lookup alone cannot satisfy cross-format equivalence. In this installed package state, no provider meets the authoritative contract; adapter outcome must be `unavailable`.
- Conflicting IDs, unsupported formats, partial mapping, stale mapping, internal API error, unknown account mode, or inconsistent chat IDs return `ambiguous`, `invalid`, or `unavailable`; none return a principal.
- `principalId` is minted/resolved by application-owned storage only after verified evidence. Display names, phone formatting, raw serialized ID, model arguments, and event text are ineligible inputs for privilege.
- Downstream grant lookup is callable only with an opaque verified principal token/capability object, never with an arbitrary event identifier. Grant lifecycle checks principal, private-session scope, status, expiry, and policy revision. Failure at any stage denies.
- Requested model tool names/arguments cannot add capabilities or choose a principal/grant. Capability authority remains application-owned and is not derived from model output.
- Principal-to-session resolution is a separate application-owned binding operation; no phone/LID normalization heuristic may merge or rebind sessions.

## 10. Security scenario matrix

`Private session` means a trusted application session, not merely a WhatsApp chat ID. All scenarios default to no privilege. A possible principal only exists when verification is `verified`; none of the current package-only cases can reach that state.

| # | Scenario / available evidence | Outcome | Principal? | Private session? | Privileged tools? |
|---:|---|---|---|---|---|
| 1 | Valid-looking phone ID; raw event only | `unavailable` (format is not verification) | No | No | Deny |
| 2 | Valid-looking LID ID; raw event only | `unavailable` | No | No | Deny |
| 3 | Unknown serialized ID format | `invalid` or `unavailable` | No | No | Deny |
| 4 | Sender identifier missing | `invalid` | No | No | Deny |
| 5 | Group event with explicit valid-looking `author` | `unavailable` (group sender evidence still unverified) | No | No; group | Deny |
| 6 | Group event with missing `author` | `invalid` | No; never use group `from` | No; group | Deny |
| 7 | Conflicting sender IDs across event fields | `ambiguous` | No | No | Deny |
| 8 | Phone lookup succeeds; LID mapping unavailable | `unavailable` | No | No | Deny |
| 9 | LID lookup succeeds; phone mapping unavailable | `unavailable` | No | No | Deny |
| 10 | Mapping returns only one side / incomplete fields | `unavailable` | No | No | Deny |
| 11 | `getContactLidAndPhone()` or page evaluation throws | `unavailable` | No | No | Deny |
| 12 | Chat metadata lookup returns undefined | Conversation `unknown` | No | No | Deny |
| 13 | Chat lookup rejects / Puppeteer page unavailable | Conversation `unknown` | No | No | Deny |
| 14 | Chat metadata conflicts with raw group/channel/status signals | `ambiguous` | No | No | Deny |
| 15 | Positive channel flag / `Channel` structure | Conversation `channel` | No | No; channel | Deny |
| 16 | Positive broadcast flag | Conversation `broadcast` | No | No | Deny |
| 17 | `isStatus` true / `status@broadcast` | Conversation `broadcast`/status | No | No | Deny |
| 18 | Self-authored (`fromMe`) event enters unexpected path | `invalid` for inbound authorization | No | No | Deny |
| 19 | Stale contact metadata or old mapping cache | `unavailable` or `ambiguous` | No | No | Deny |
| 20 | Duplicate phone/LID representations without trusted equivalence | `ambiguous` | No; do not merge | No | Deny |
| 21 | Identity mapping changes between requests | `ambiguous`; require versioned revalidation | No new binding | No | Deny |
| 22 | WhatsApp internal API changes/shape mismatch | `unavailable` | No | No | Deny |
| 23 | PrivateChat returned, but only because group/channel flags are false | Conversation `unknown` | No | No | Deny |
| 24 | Contact lookup returns display name and `isWAContact` | `unavailable` | No | No | Deny |
| 25 | Returned chat ID differs from requested event chat ID | `invalid`/`ambiguous` | No | No | Deny |

## 11. Integration impact on Friday AI

Reviewed current modules: `src/application/trusted-runtime-context.js`, `tool-authorization-policy.js`, `tool-grant-lifecycle.js`, `tool-assistant.js`, `src/ai/tools/tool-executor.js`, `src/ai/tool-orchestrator.js`, `src/friday-runtime.js`, `src/application/message-service.js`, `src/whatsapp/message-adapter.js`, `src/whatsapp/message-handler.js`, and prior 3A/3B reports.

Current flow and future boundary placement:

1. **Trusted WhatsApp event boundary:** adapter/transport should snapshot original event fields before legacy normalization. Current `normalizeWhatsAppMessage()` infers `private` from absence of `@g.us` and uses `message.from` as sender for private messages; for group, it falls back from missing `author` to group `from`. These are explicitly not trusted evidence.
2. **Identity verification:** a separately injected verifier evaluates sender evidence and returns one of four states. Current implementation has no authoritative input provider, so it returns unavailable.
3. **Canonical principal resolution:** only a verified identity result may be passed to application-owned principal resolution. Do not canonicalize by suffix, display name, formatted number, or `getNumberId()`.
4. **Private session resolution:** only after conversation is independently positively verified private and identity verified; bind through an application-owned principal/session store. The current message service's session derivation remains legacy behavior.
5. **Trusted runtime context:** `createTrustedRuntimeContextProjector()` validates shape, sender callback, and equality of private/conversation session IDs, but it trusts the caller-provided `chatType` and syntactically valid sender. It has no evidence-verification result input. Do not feed it current adapter output for privileged execution.
6. **Authorization policy:** policy validates sender/session and uses application-resolved principal and allowlisted tool/capability metadata; capability lists are supplied by application. Model tool arguments must remain outside grant authority.
7. **Grant lifecycle:** read-only evaluator checks application-owned grant structure, scope, revocation, expiry and policy revision. Any later caller must query only after a verified opaque principal exists; current identity cannot safely key that query.
8. **Tool assistant / executor:** tool orchestration and execution must remain unreachable from production WhatsApp messages until the trusted boundary is wired and a security review independently approves it. No runtime integration change is proposed here.

This flow is a design placement only; no source changes are made. In particular, a valid sender callback in current authorization helpers is not itself evidence that the underlying WhatsApp identity was verified.

## 12. Remaining security blockers

- No positive private-chat evidence in the installed public model or wrappers.
- No trusted sender assertion or application-verifiable identity provenance.
- LID/phone helper is internal-backed, partial-capable, and lacks a documented equivalence/freshness contract.
- No canonical principal policy for LID, phone, account-mode transitions, duplicate mappings, or identity changes.
- Existing message normalization promotes identifier shapes and may substitute a group ID for a missing group sender.
- Current trusted context accepts a caller-supplied `chatType`; no verifier result is required.
- No principal-to-private-session binding sourced from authoritative identity evidence.
- Production grant retrieval and WhatsApp tool execution cannot be safely connected until these blockers close.

## 13. Final readiness verdict

| Area | Verdict | Basis |
|---|---|---|
| Private conversation classification | **NOT READY** | No positive private marker; `PrivateChat`/false flags are fallback. |
| Sender identity verification | **NOT READY** | Message/contact IDs and lookups are not authoritative identity proof. |
| LID/phone canonicalization | **NOT READY** | Mapping helper is partial/internal-backed; no verified equivalence contract. |
| Principal-to-session binding | **NOT READY** | No verified canonical principal can key an application-owned binding. |
| Future trusted authorization integration | **CONDITIONALLY READY for design only** | Existing policy/grant modules provide downstream shape, but trusted evidence source and boundary are missing. |
| Private text-only tool pilot | **NOT READY** | No positive private classification or verified principal. |
| Production tool execution | **NOT READY** | Do not enable. |

**Overall: NOT READY.** No authoritative verification mechanism can be established from the inspected installed dependency interfaces. Identity verification remains unavailable and privileged tool execution must remain disabled. Strategy D (strict deny until verified) is the only justified eligibility policy.

## 14. Recommended next sprint

Keep runtime and tools disabled while investigating a genuinely authoritative source for private-chat and sender identity evidence, including explicit provenance, account mode, freshness, and change behavior. If no such source exists, retain `unknown` and deny-all as the product security boundary. Any future verifier must be independently tested against the scenario matrix and reviewed before integration; do not treat another lookup helper or identifier-shape heuristic as closure.

## Verification and change boundary

- Inspected installed package source and type declarations, current Friday modules, and prior architecture reports.
- No live client, WhatsApp account, private identity, or external source was used.
- No source code, tests, dependencies, schemas, or runtime behavior changed.
- Tests were not run; this sprint is read-only research and architecture documentation.
- The intended change is this report only.
