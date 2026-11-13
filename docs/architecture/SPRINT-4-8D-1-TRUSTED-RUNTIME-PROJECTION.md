# Sprint 4.8D.1 — Trusted Runtime Projection

## Status and scope

This sprint adds an independently testable application-layer projection from
trusted normalized WhatsApp identity and application-owned session data into
the existing tool authorization policy. It does not connect the policy or
tool pipeline to production message handling.

`src/application/trusted-runtime-context.js` is the projection boundary.
Callers inject the existing authorization policy, private-session resolver,
sender-ID validator, and a fixed list of requested application capabilities.
No runtime composition or message routing was changed.

## Existing identity and session flow

`normalizeWhatsAppMessage()` in `src/whatsapp/message-adapter.js` emits
`chatType`, `chatId`, and `senderId`. For private messages, `senderId` is
`message.from`; group sender IDs come from `message.author` with a group
fallback. Group display metadata is separately represented as
`group.senderName`. The adapter does not produce session IDs or capabilities.

`src/application/message-service.js` calls the injected
`sessions.privateSessionId(senderId)` and, for groups, separately calls
`sessions.groupSessionId(chatId)`. `src/database/sqlite.js` defines these
session conventions as `private:${userId}` and `group:${groupId}`.

The projection accepts only the application-owned normalized fields needed at
this boundary:

```js
{
  chatType: 'private',
  senderId: 'adapter-derived-id',
  privateSessionId: 'private:adapter-derived-id',
  conversationSessionId: 'private:adapter-derived-id',
}
```

The private session is recomputed with the injected existing resolver. The
provided private and active conversation scopes must both match that canonical
value before the authorization policy is called. The injected identity
validator is applied before resolving a session; the policy applies its own
checks again when authorizing.

## Trusted and untrusted fields

Identity and session evidence must be assembled by application code from the
normalized adapter event and the existing session resolver. Message text,
captions, display names, AI responses, Gemini arguments, assistant DTOs, and
tool calls are not accepted as projection input. Unknown input keys—including
`displayName`, `requestedCapabilities`, and `authorizedTools`—fail closed.

The projector's `applicationCapabilities` configuration is fixed at
construction from trusted application configuration or policy. It is not
accepted per message. The default is an empty array, which leads to
authorization denial. This sprint adds no default capability grants and no
registered production tools.

## Authorization and context isolation

The projector delegates all tool authorization decisions to
`createToolAuthorizationPolicy()` in
`src/application/tool-authorization-policy.js`; it does not duplicate its
allowlist, registry, or grant logic. The policy remains responsible for
intersecting explicitly configured capabilities with its fixed allowlist and
registered read-only tools.

Only private conversations can proceed. Group and unknown conversation types
are denied. Missing or malformed sender identity, missing session data,
resolver/validator failure, and inconsistent session scopes are denied without
calling the policy with an authorization grant.

The authorization result keeps identity/session evidence separate from the
executor-facing context. That context contains only the policy-approved
`conversationType` and `authorizedTools`; sender IDs and session IDs are not
passed to handlers. Denied decisions have `context: null`.

## Tests and verification scope

`test/trusted-runtime-context.test.js` uses a fake registry and the real
authorization policy. It covers valid private identity and canonical scope,
invalid/missing identity, missing and mismatched sessions, groups, unknown
conversation types, unexpected fields, display-name and user-input injection,
empty-capability denial, executor-context isolation, registry immutability,
invalid trusted configuration, and validator/resolver failure.

No WhatsApp connection, Gemini request, or production database is used.

## Known limitations and Sprint 4.8D requirements

- The normalized adapter event does not include session IDs or capabilities;
  a future runtime composition must combine trusted adapter identity with the
  existing session resolver before invoking this projection.
- The runtime currently has no explicit capability configuration for this
  boundary. Until a reviewed application policy supplies capabilities and the
  existing authorization policy has matching grants, authorization remains
  denied.
- The projection and authorization policy must be constructed with the same
  session resolver and sender-ID validator.
- This projection does not prove that a caller's normalized event or supplied
  session values were obtained from the trusted adapter; that guarantee
  belongs to a future composition boundary and its tests.
- No production tools, grants, tool-assistant activation, Gemini function
  calling, persistence, multimodal handling, or WhatsApp routing were enabled.

Production tool execution remains disabled. A later sprint must separately
review and test the runtime composition's trusted input provenance, capability
issuance, session-scope wiring, and authorization lifecycle before connecting
any tool pipeline to message handling.
