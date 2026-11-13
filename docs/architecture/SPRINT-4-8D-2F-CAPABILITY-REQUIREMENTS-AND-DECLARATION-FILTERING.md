# Sprint 4.8D.2F — Capability Requirements and Declaration Filtering

## 1. Scope and production boundary

This sprint adds isolated mechanics for per-tool capability requirements,
all-of authorization, and authorization-aware model declarations. It does not
connect the tool pipeline to `friday-runtime.js`, register production tools,
add grants, or change WhatsApp behavior.

Identity fixtures in tests are controlled fakes and do not establish that
Friday has a valid production WhatsApp identity contract. Identity validation
remains unavailable/deny-all for privileged operations. Production tool
execution remains disabled.

## 2. Files inspected and changed

### Inspected

- `src/ai/tools/tool-registry.js`
- `src/ai/tools/tool-validator.js`
- `src/ai/tools/tool-permission-policy.js`
- `src/ai/tools/tool-executor.js`
- `src/ai/tool-orchestrator.js`
- `src/ai/gemini-tool-adapter.js`
- `src/application/tool-authorization-policy.js`
- `src/application/trusted-runtime-context.js`
- `src/application/tool-assistant.js`
- Related tests: `test/ai-tools.test.js`,
  `test/tool-orchestrator.test.js`, `test/gemini-tool-adapter.test.js`,
  `test/tool-pipeline.test.js`,
  `test/application-tool-assistant.test.js`,
  `test/tool-provider-policy.test.js`,
  `test/tool-authorization-policy.test.js`, and
  `test/trusted-runtime-context.test.js`.
- The Sprint 4.8D.2E design and related Sprint 4.8A–4.8D.1 architecture
  documents.

### Modified

- `src/ai/tools/tool-registry.js`
- `src/ai/tools/tool-permission-policy.js`
- `src/ai/tools/tool-executor.js`
- `src/ai/tool-orchestrator.js`
- `src/application/tool-authorization-policy.js`
- `src/application/trusted-runtime-context.js`
- Focused tool, orchestration, policy, projection, and assistant tests listed
  above.

### Created

- `docs/architecture/SPRINT-4-8D-2F-CAPABILITY-REQUIREMENTS-AND-DECLARATION-FILTERING.md`

`src/friday-runtime.js`, WhatsApp adapters, message normalization,
database schemas, package manifests, dependencies, and legacy routing were
not modified.

## 3. Capability requirement representation

`createToolRegistry()` now requires every tool definition to include a
non-empty `requiredCapabilities` array. The registry rejects missing,
malformed, duplicate, or invalid capability names. The existing identifier
format is preserved: lowercase ASCII letter followed by up to 63 lowercase
letters, digits, or underscores. Dotted identifiers are not introduced.

Requirements are copied and frozen in the registered tool metadata. The
registry exposes a frozen authorization-metadata view through
`getAuthorizationMetadata(name)`. Public model declarations continue to
contain only the tool name, description, and argument schema; capability
requirements, permission categories, and handlers are not sent to the model.

The application authorization policy receives `knownCapabilities` from
application configuration and validates registered requirements against
that set. Unknown capability requirements fail policy construction. A
registered tool with missing requirements is rejected at registration;
there is no implicit public-tool behavior.

## 4. All-of authorization semantics

`hasRequiredCapabilities()` in
`src/ai/tools/tool-permission-policy.js` is the shared all-of check used by
application authorization, declaration filtering, and executor permission
enforcement.

For a tool requiring `['project_read', 'private_context_read']`, both names
must be present in the trusted `grantedCapabilities` set for the tool to be
eligible. One or neither capability is insufficient. Empty requirements
are invalid, unknown names are rejected, and malformed or duplicate grant
names fail closed.

The policy no longer treats a capability-to-tools union as if it represented
per-tool all-of requirements. The application authorization policy matches
each allowlisted tool's registered requirements against the
application-constructed `grantedCapabilities` context. It places only
eligible tool names, plus the grants used for that decision, in the
executor-facing authorization context. The trusted runtime projector still
fixes its application capabilities at construction; model, message, and
assistant request properties are not accepted as projection input.

## 5. Declaration filtering architecture

`createToolOrchestrator()` still snapshots public registry declarations at
construction, but it filters them for each `run()` using the separately
supplied trusted context. A declaration is visible only when:

1. `authorizedTools` is a valid list of unique names;
2. each name is currently registered; and
3. the trusted `grantedCapabilities` satisfy all registered requirements
   for that tool.

Missing or malformed authorization context yields an empty declaration
list. Model request input is never consulted to build the authorized tool
list or grants. Unknown tools cannot appear because declarations originate
from the registry.

If a model nevertheless requests an unregistered tool, the orchestrator
returns the existing safe `TOOL_NOT_FOUND` response without executor
dispatch. A registered tool that was not authorized/declared receives a
safe `TOOL_PERMISSION_DENIED` response without handler invocation.

The Gemini adapter remains a translator: it translates the already-filtered
declarations and parses function calls, but contains no grant logic.
Declaration filtering limits model-visible information; it does not replace
the executor check.

## 6. Executor-side final enforcement

`createToolExecutor()` still looks up the registered tool, validates
arguments, snapshots trusted context, and calls `assertToolPermission()`
before the handler starts. Permission enforcement now requires all of:

- registered tool category is `read_only`;
- the tool appears in `authorizedTools`;
- all registered `requiredCapabilities` appear in the trusted
  `grantedCapabilities`.

The permission check is independent of declaration visibility. Direct
executor calls and stale/mutated trusted grant contexts cannot bypass the
registered requirements. A failed check is normalized to the existing
`TOOL_PERMISSION_DENIED` error before the handler runs.

The executor strips both `authorizedTools` and `grantedCapabilities` from
handler context. It still provides only the remaining trusted context and
abort signal. `action` and `approval_required` continue to be denied.

## 7. Fail-closed behavior

- Missing/malformed requirements: registry registration fails.
- Duplicate or malformed capability identifiers: registry or policy
  configuration fails.
- Unknown requirements: authorization policy construction fails.
- Unknown/malformed runtime grant names: authorization is denied.
- Empty grants or no tools meeting all requirements: denial with
  `no_explicit_tool_grants`.
- Missing/invalid tool authorization context: no declarations and executor
  denial.
- Unknown tool: never declared; a model request is rejected before executor
  dispatch.
- Registered but unauthorized tool: not declared and denied if requested.
- Failed or missing context after declaration generation: the executor
  independently denies.
- Non-read-only category: remains disabled by the executor and application
  policy.

No raw identity, session, or grant detail is added to model-visible
permission errors.

## 8. Test coverage and results

Focused tests cover:

- Required metadata is mandatory, unique, syntactically valid, immutable,
  and absent from public model declarations.
- One- and multiple-capability requirements use all-of semantics.
- Partial grants omit tools that still require another capability.
- Unknown requirement configuration is rejected.
- Only authorized registered tools are declared.
- Missing/malformed context yields no declarations.
- Model input fields cannot add declarations.
- A model call for an excluded registered tool is denied.
- A capability removed after declaration generation is rejected by the
  executor before the handler starts.
- Direct executor calls require both tool authorization and all registered
  capabilities.
- `action` and `approval_required` denial and existing schema/executor
  behavior remain covered.

Focused command:

```text
node --test test/ai-tools.test.js test/tool-orchestrator.test.js \
  test/gemini-tool-adapter.test.js test/tool-pipeline.test.js \
  test/application-tool-assistant.test.js test/tool-provider-policy.test.js \
  test/tool-authorization-policy.test.js test/trusted-runtime-context.test.js
```

Result: **125 tests passed, 0 failed**. The full repository suite also
completed with **274 tests passed, 0 failed** on Node.js 24.22.1. Syntax
checks and `git diff --check` passed.

## 9. Compatibility assessment

The changes are confined to the isolated tool foundation and tests. No
production runtime imports or constructs this policy path. Legacy Friday
private/group messaging, group prefix handling, history, memory, image,
voice, sticker, video, image generation, queueing, deduplication, and
provider fallback remain unchanged.

Existing tool registry test fixtures were updated with explicit fake
capability requirements. These fixtures verify mechanics only and do not
grant production capabilities or establish WhatsApp identity validity.

## 10. Expiry/revocation and identity limitations

This sprint does not add expiry, a persistent grant store, or dynamic
revocation. The orchestrator computes declaration eligibility per `run()`,
and the executor rechecks the supplied trusted context immediately before
dispatch. This supports fail-closed behavior when the context's grant data
changes between declaration and dispatch, but does not provide an external
revocation source or revoke immutable contexts already held elsewhere.

Production WhatsApp identity validation/canonicalization remains blocked by
the findings in Sprint 4.8D.2A–2D. No production context can currently
supply verified identity/session evidence for private tool authorization.
The isolated policy must not be interpreted as a production authorization
path.

## 11. Production status

No production tool registrations or grants were added. The new capability
foundation is not connected to `friday-runtime.js`, WhatsApp messages,
Gemini production requests, or the legacy assistant. **Production tool
execution remains disabled.**
