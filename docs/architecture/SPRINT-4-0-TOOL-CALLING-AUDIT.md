# Sprint 4.0 — Tool Calling Architecture Audit

## 1. Existing Architecture Findings

### Gemini request and response path

- `src/ai/gemini.js` imports dotenv, reads `GEMINI_API_KEY`, throws during module evaluation if it is missing, and constructs the `GoogleGenAI` client. This is the provider/client boundary, but it is not currently dependency-injected.
- Conversational requests are built in `askFriday()` inside `src/friday-runtime.js`. It selects the active conversation history, builds a user content part (and optional inline image), and supplies `systemInstruction` combining the core prompt, conversation style, and relevant memory context.
- `generateWithRetry()` in `src/friday-runtime.js` calls `ai.models.generateContent({ model, contents, config })`. It retries some temporary errors once, but does not retry quota errors.
- `generateWithModelFallback()` in `src/ai/model-fallback.js` tries configured model names in order for recognized service, quota, or model-not-found errors. This helper is also used by image generation; tool support should be limited to the conversational path so image-generation modality behavior remains unchanged.
- The runtime extracts `response.text?.trim()`. A missing or empty answer throws. Successful text is persisted to the active chat history before the message service delivers it. `src/application/message-service.js` catches assistant errors and uses its existing user-facing failure response.

The current request config contains no `tools`, `toolConfig`, or `automaticFunctionCalling` field. Friday currently has no tool declarations, tool-call dispatch, or function-response handling.

### Installed SDK capability

The installed `@google/genai` package is version `2.30.0`. Its checked-in Node declarations expose:

- `GenerateContentConfig.tools` and `toolConfig`.
- `FunctionDeclaration` with parameter schemas.
- `FunctionCallingConfig` modes including `AUTO`, `ANY`, `NONE`, and `VALIDATED`.
- `GenerateContentResponse.functionCalls`, which returns calls from the first candidate when present.
- `Part.functionCall` and `Part.functionResponse` for the manual request/response turn.
- `automaticFunctionCalling` configuration and callable-tool abstractions.

Thus, the installed SDK can carry function declarations and function-call responses. That does not mean Friday already supports tool calling, that every configured model supports every declaration, or that a live provider request was tested. The safer first design is application-managed/manual dispatch rather than SDK automatic execution, so Friday can enforce its own registry, validation, permission, timeout, and output policies.

The normal response path can be distinguished from a tool request by checking `response.functionCalls` (or function-call parts in the candidate content) before reading `response.text`. A normal response continues through `response.text`; a function-call response requires validated execution and a subsequent `functionResponse` turn before expecting final text. Code must handle missing calls, missing names/arguments, empty text, and provider responses containing neither usable text nor supported calls explicitly.

### Existing request flow

```text
whatsapp-web.js message event
  -> registerQueuedMessageHandler() in src/whatsapp/message-adapter.js
  -> per-chat queue and duplicate-event guard in src/whatsapp/message-queue.js
  -> normalizeWhatsAppMessage()
  -> createMessageService().handle(normalized DTO, reply transport)
  -> injected assistant.ask()
  -> askFriday() in src/friday-runtime.js
  -> Gemini model fallback / generateContent / retry
  -> response.text parsing and history persistence
  -> message-service text or voice response path
  -> WhatsApp reply/delivery adapter
```

The message service consumes a normalized contract and an injected reply transport; it has no direct WhatsApp SDK dependency. Tool orchestration belongs in the AI/assistant boundary called by `assistant.ask()`, not in the WhatsApp adapter or message queue. Tool definitions and executors should receive explicit application dependencies and session context, not a WhatsApp `Message`, client, or chat transport.

## 2. Current Gemini Function-Calling Compatibility

**Current application support: none. Installed SDK support: present.**

The SDK’s `functionCalls` accessor and `functionResponse` content parts provide the pieces for a controlled manual loop:

1. Send current conversation contents and a filtered set of registered function declarations.
2. If a response contains function calls, enforce call/round limits and validate each call.
3. Execute only names present in Friday’s registry and allowed for the current request context.
4. Append the model call content and corresponding function response content to the next Gemini turn.
5. Continue until normal text is returned or a hard limit/error is reached.

The runtime’s existing text extraction cannot be used unchanged for a call-only response because `response.text` can be absent. Preserve the existing no-tools path exactly for ordinary requests and image requests. Keep existing retry/model fallback behavior for failures before tool execution. Avoid transparently switching models after a tool has executed: repeating a generation can cause duplicate work, and a future action tool could have side effects. Initial tools should therefore be read-only; any future action tool should have an explicit idempotency/approval design.

## 3. Smart Memory Integration

- `src/application/memory-service.js` retrieves keyword-overlap matches through `retrieveRelevantMemories()`. The default maximum is five, chosen deterministically by overlap score and original list order. SQLite first searches by query terms within the supplied session and caps candidates at 30.
- `askFriday()` uses memory retrieval only for private requests and passes an empty list for group requests. `getMemoryInstruction()` puts selected category/content pairs in JSON under a prompt section that explicitly labels them as untrusted user-written notes.
- The message service rejects memory commands in groups before dispatching to the memory store. Private sessions are built as `private:${senderId}`; group history uses `group:${chatId}`.
- A `get_saved_memory_summary` tool could reuse the injected memory service’s `retrieve(sessionId, query)` operation. It must receive an explicit private session scope from the trusted application context; the model must not be allowed to choose another session ID. It must never return private memory to a group request.

No memory behavior should be changed as part of the tool-calling foundation.

## 4. Recommended Module Boundaries

These are proposed modules, not existing code:

- `src/ai/tools/tool-registry.js`: stores immutable definitions and executor references; rejects duplicate names; exposes only public name/description/schema declarations to Gemini.
- `src/ai/tools/tool-validator.js`: validates JSON arguments against a small supported schema subset and policy limits before execution.
- `src/ai/tools/tool-permission-policy.js`: classifies `read_only`, `action`, and `approval_required`; denies unknown categories and any tool not granted by the application context.
- `src/ai/tools/tool-executor.js`: resolves a registered tool, validates/authorizes it, applies timeout and output limits, and normalizes errors. It never evaluates model-provided JavaScript or shell commands.
- `src/ai/tool-orchestrator.js`: performs bounded Gemini/tool/function-response rounds and returns a normal text result through the current assistant response contract.

Inject the Gemini `generateContent` function, registry, permission context, clock, and executor dependencies into the orchestrator. Avoid importing the WhatsApp SDK in these modules. Keep `src/application/message-service.js` as the transport-neutral caller; `src/friday-runtime.js` can initially compose the orchestrator at the existing `assistant.ask()` boundary. A later extraction of `askFriday()` into a provider-independent assistant service may be useful, but is not required for the first read-only tool.

## 5. Proposed Request and Tool Execution Flow

```text
WhatsApp event -> adapter -> queue -> normalized message service
  -> assistant.ask(message context)
  -> AI tool orchestrator
  -> Gemini with allowlisted declarations
     -> normal response: existing text/result path
     -> function calls:
          registry lookup
          strict argument validation
          permission check (default deny)
          bounded executor
          bounded, normalized, untrusted function response
          next Gemini round
  -> existing message service delivery and history behavior
```

Only the application supplies trusted context such as chat type, private session ID, and the set of permitted tools. Do not accept those values from Gemini arguments. Tool outputs are data, not instructions: return compact, schema-shaped results and explicitly describe them as untrusted context in the follow-up prompt.

## 6. Initial Read-Only Tool Candidates

| Candidate | Inputs and output | Permission | Privacy/risk | First implementation? |
|---|---|---|---|---|
| `get_current_datetime` | No model-controlled inputs; return a bounded ISO timestamp and configured timezone label. | Read-only, low risk. | Reveals local time/timezone only. Use injected clock/timezone; do not expose environment variables. | **Yes.** Best first vertical slice; deterministic and does not touch files, network, or user data. |
| `get_project_status` | No arbitrary path input; return a small allowlisted status summary from an injected provider. | Read-only. | Could disclose repository names, branch, dirty filenames, or task metadata. Current repository code does not expose a status service; do not shell out to git. | **Defer.** Add only after defining the exact safe status fields and provider. |
| `list_project_files` | Prefer no input initially, or a small enum of approved roots; return bounded relative paths. | Read-only but sensitive. | File names can reveal secrets/projects; traversal, symlinks, hidden files, and large trees are concerns. No unrestricted filesystem root. | **Defer.** Requires an explicit directory allowlist, denylist, depth/count limits, and symlink policy first. |
| `get_saved_memory_summary` | Query text only; use the trusted current private-session ID; return a few relevant category/content items. | Read-only personal data. | High privacy sensitivity. Must be private-chat only and scoped by application context, never a model-supplied session ID. Avoid logging output. | **Defer until after the first tool.** Memory retrieval exists, but an explicit privacy/consent boundary and group-deny tests are required. |

No tool in the first implementation should access the filesystem, environment, shell, or network. Do not expose a generic “run command”, “read file”, or “fetch URL” tool.

## 7. Security Considerations

- **Path traversal / filesystem:** Prefer no filesystem tool initially. For a future file-list tool, accept only enums/IDs mapped to fixed roots; canonicalize resolved paths, verify containment after resolution, reject traversal and symlink escapes, exclude hidden/sensitive directories, and cap depth, entry count, and output bytes. Never accept arbitrary absolute paths.
- **Sensitive files and environment:** No tool receives `process.env`, arbitrary paths, or raw database handles. Explicitly deny `.env*`, credentials, auth/session directories, private keys, SQLite databases, and backups. Never return environment variables.
- **Credential leakage:** Apply the existing memory policy to memory-derived text; redact secret-like strings in tool outputs and errors. Do not log arguments or outputs that may contain private content.
- **Prompt injection in tool output:** Treat every result as untrusted. Return structured, bounded data; include a stable instruction that tool results are evidence/data, not instructions. Do not let output alter the tool registry or permissions.
- **Excessive calls / loops:** Enforce both per-turn call count and total round count, reject repeated identical calls where appropriate, and stop with a safe normal response/error when capped. Suggested initial limits: at most 3 calls in a round and 2 tool rounds.
- **Input/result size:** Enforce schema limits before executor invocation and a serialized-byte limit on each result and total tool context. Suggested starting caps: 4 KiB arguments and 8 KiB total result payload per turn.
- **Timeouts:** Give each tool an independent abortable timeout (suggested initial ceiling: 3 seconds for local read-only tools); executor must reject late results and clear timers. Do not permit a tool to extend its own deadline.
- **Permissions:** Default deny if a tool, scope, category, or permission is missing. Read-only classification does not itself grant access to personal data. Action tools require a future approval flow and are out of scope.
- **Group/private isolation:** Derive session scope from the normalized message and application, never model arguments. For groups, provide no private memory capability or private session identifier. Test that group prompts cannot select a private memory scope.
- **Fallback and duplicate work:** Do not rerun an already executed tool when switching models. Keep tool execution idempotent where possible; no action tools until approval and deduplication semantics are designed.

## 8. Testing Strategy

Use injected fake Gemini generators, fake registry entries, and fake clocks. No live WhatsApp or Gemini services are needed.

- Registry accepts a unique definition and rejects duplicate names.
- Declarations sent to Gemini contain only public tool metadata and schemas.
- Validator accepts valid arguments and rejects missing fields, wrong types, unknown properties, invalid enums, oversized strings/arrays, and oversized JSON.
- Executor rejects unknown tools and permission-denied tools without calling their handlers.
- Timeout tests confirm rejection and timer cleanup; tool failures become bounded normalized errors without stack traces or secrets.
- Orchestrator returns regular model text unchanged when there are no function calls.
- Function calls are validated and executed; multiple calls in a round produce matching function responses.
- Malformed function-call fields and unknown names are rejected safely.
- Round/call limits stop loops and do not execute calls beyond the cap.
- Tool results are size-limited and carried back as untrusted data.
- Fallback tests distinguish request failures before execution from failures after a tool ran; no executed tool is repeated.
- Memory tool tests verify only relevant records are returned, never all memories, and enforce private session scope/group denial.
- Import-safety tests import registry/validator/executor/orchestrator without constructing Gemini, WhatsApp, database, or filesystem resources.

Existing model-fallback and memory tests provide useful base coverage. Add focused tests for the new pure modules rather than changing the WhatsApp adapters.

## 9. Incremental Implementation Plan

1. Introduce pure registry, validator, permission policy, and executor modules with fake-only unit tests; no Gemini or WhatsApp changes.
2. Add a manually controlled orchestrator with strict round/call/size/time limits and fake-generator tests for normal text and function-response turns.
3. Wire the orchestrator only at the conversational assistant boundary. Keep image generation, voice transcription/generation, and the existing no-tools text path unchanged.
4. Add only `get_current_datetime` as the first read-only tool, backed by an injected clock/timezone.
5. After privacy review, consider `get_saved_memory_summary` using the existing memory service and trusted private-session context. Defer filesystem and project-status tools pending explicit providers and allowlists.
6. Run unit/integration-fake tests and static checks. Test live provider compatibility separately, only with approval and a controlled environment.

## 10. Known Limitations and Audit Verification

- The Gemini client is created at module import and requires an API key; future tests should inject a generator instead of importing the client into tool modules.
- Model fallback capability for function calling is not established by local declarations alone. Different configured models may support different schemas or behaviors.
- Memory retrieval is lexical exact-token overlap; relevant paraphrases may be missed.
- The runtime’s current `askFriday()` function combines provider orchestration, prompt assembly, logging, and persistence, so the first integration point is not a fully isolated AI service.
- This audit did not connect to Gemini or WhatsApp, execute a tool, run Friday, or run database migrations.
- `npm run check` passed under Node.js `v24.22.1` and npm `11.19.1`.
- 76 selected fake-based, non-database tests passed; 0 failed and 0 skipped. Database and migration test files were intentionally not run because this audit prohibits running migrations. No full `npm test` result is claimed.

No application source, package manifest, database, or dependency was changed. The only created file is this report.
