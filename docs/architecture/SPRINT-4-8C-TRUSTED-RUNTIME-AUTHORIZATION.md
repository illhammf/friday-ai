# Sprint 4.8C — Trusted Runtime Authorization Foundation

## Status and scope

This sprint adds a standalone, application-owned authorization policy for
future tool orchestration. It derives an immutable authorization decision from
a narrow normalized runtime-context projection, an explicit fixed tool
allowlist, explicit application capability grants, and registry inspection.

The policy is not connected to `friday-runtime.js`, `message-service`, the
WhatsApp queue, or `tool-assistant`. No production tools or grants are added.
There are no database, persistence, provider, or message-routing changes.

## Verified normalized identity contract

`normalizeWhatsAppMessage()` currently returns:

- `chatType`: `private` or `group`, inferred from `message.from` ending in
  `@g.us`.
- `chatId`: the source `message.from`.
- `senderId`: `message.from` for private messages; `message.author ||
  message.from` for group messages.
- Group `senderName` in the separate `group` field, derived from display
  metadata or the fallback label `"Anggota grup"`.

The message service separately derives:

- `privateSession` from `sessions.privateSessionId(senderId)`.
- `sharedGroupSession` from `sessions.groupSessionId(chatId)` for groups.
- `senderName` from group display metadata (or a generic private label).

The normalized message itself does **not** contain either session ID,
application capabilities, an authorization grant, or an account-level
authorization decision. Display name is presentation-only and must not be
used to identify or authorize the sender. The current WhatsApp adapter and
message service were not changed.

## Authorization input contract

`createToolAuthorizationPolicy()` receives dependencies from a trusted
application composition root:

- A registry with `get`, `has`, and `getPublicDeclarations`.
- A fixed `allowedTools` array (defaults to empty).
- An explicit `capabilityToolGrants` map (defaults to empty).
- `getPrivateSessionId(senderId)`, supplied by application code.
- `isValidSenderId(senderId)`, supplied by application code for the actual
  identity format used by the integration.

The policy accepts only this narrow normalized projection:

```js
{
  chatType: 'private',
  senderId: 'trusted-adapter-identity',
  privateSessionId: 'private:trusted-adapter-identity',
  conversationSessionId: 'private:trusted-adapter-identity',
  requestedCapabilities: ['application_capability'],
}
```

The request object is treated as application-owned input. It is not the
assistant DTO, model input, Gemini arguments, or conversation text. Unknown
properties (including `authorizedTools`, `senderName`, `displayName`,
`sessionId`, or model fields) are rejected rather than ignored.

The current runtime does not produce `requestedCapabilities`; a future
composition root must obtain this value from trusted application policy or
explicitly controlled application configuration. It must not derive it from a
user request, sender name, model response, function call, or DTO metadata.

## Identity and session-scope rules

- Unknown, missing, malformed, or unsupported conversation types are denied.
- Groups are denied before any capability grant is considered.
- Sender identity must be a non-empty canonical string and must pass the
  injected `isValidSenderId` predicate. This avoids baking a guessed WhatsApp
  identity syntax into the policy.
- Private session scope must be present and exactly match the ID returned by
  the injected `getPrivateSessionId(senderId)` resolver.
- The active conversation session must equal the private session for private
  requests. A mismatch or group/shared session is denied.
- The output decision separates `identity` and `sessionScope` from `context`.
  The executor-facing `context` currently contains only
  `conversationType` and `authorizedTools`, so sender IDs and session IDs are
  not automatically passed to tool handlers.
- A future tool that truly needs user/session scope must receive the narrow
  scope explicitly through a reviewed per-tool projection; do not pass all
  identity details to every handler.

## Tool allowlist and grant construction

The policy first validates every name in the fixed allowlist and in every
configured capability grant:

1. A grant must be an explicitly configured application capability.
2. Its tool names must be valid, unique, included in the fixed allowlist, and
   already registered.
3. Only tools registered with the `read_only` category may be allowlisted.
4. At authorization time, requested application capabilities are validated
   and intersected with these configured grants and the fixed allowlist.
5. Unknown capabilities, malformed or duplicate requested capabilities,
   missing capabilities, or an empty intersection produce denial.

The policy never enumerates the registry to create grants. A tool being
registered is not sufficient authorization. With an empty allowlist and empty
capability map, authorization is denied by default.

An allowed decision is immutable and distinguishes:

```js
{
  authorized: true,
  reason: 'explicit_application_capability_grant',
  context: {
    conversationType: 'private',
    authorizedTools: ['explicit_tool_name'],
  },
  identity: { senderId: 'trusted-identity' },
  sessionScope: {
    privateSessionId: 'private:trusted-identity',
    conversationSessionId: 'private:trusted-identity',
  },
}
```

Only `context` is suitable as the executor trusted context under the present
handler contract. The identity and scope are retained as application-level
authorization evidence, not automatically exposed to handlers.

## Failure-closed behavior

The policy returns an immutable `{ authorized: false, reason, context: null }`
decision for runtime identity, type, scope, capability, or grant denials.
Invalid static configuration fails construction with
`ToolAuthorizationPolicyError`; it is not silently filtered. Unknown,
unregistered, non-read-only, or non-allowlisted tools cannot be granted.

No denial path mutates the registry or executor. The policy does not create
tool handlers, select a provider, build a DTO, perform persistence, or execute
an orchestration.

## Known limitations and requirements for Sprint 4.8D

- No application-owned WhatsApp composition currently supplies the policy's
  required session projection, capability requests, or grant configuration.
- Identity syntax is deliberately delegated to `isValidSenderId`; the runtime
  integration must use an adapter-appropriate validator and preserve support
  for the actual account identifier formats.
- Current `message-service` builds session IDs after message normalization.
  Sprint 4.8D must construct the policy input from those trusted values without
  accepting authorization fields on the incoming message or DTO.
- No production tool is registered or granted. Before any route is enabled,
  define a reviewed least-privilege allowlist and capability-to-tool mapping.
- Handler context is intentionally minimal. Any future scoped data access
  needs an explicit per-tool context contract and tests.
- Group execution remains denied. Multimodal execution, persistence, retry
  integration, and live Gemini compatibility are unchanged and unverified.

Sprint 4.8D may integrate this policy only after the runtime composition root
owns and tests identity derivation, private session matching, capability
issuance, grant policy, and structured failure handling. This sprint does not
begin that runtime integration.
