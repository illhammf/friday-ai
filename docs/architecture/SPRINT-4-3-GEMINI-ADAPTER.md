# Sprint 4.3 — Gemini Function Calling Adapter Foundation

## Scope and SDK

This sprint adds `src/ai/gemini-tool-adapter.js`, an adapter between the
provider-independent Sprint 4.2 generator contract and the installed
`@google/genai` SDK. The installed package version is **2.30.0**.

The adapter injects a `generateContent` function and model name. It does not
import or construct `GoogleGenAI`, read environment variables, make network
requests by itself, or wire into `src/friday-runtime.js`. Tests use only fake
generation functions.

## SDK Interfaces Verified

The installed `node_modules/@google/genai/dist/node/node.d.ts` declares:

- `GenerateContentParameters` with `model`, `contents`, and `config`.
- `GenerateContentConfig.tools` and `toolConfig`.
- `FunctionDeclaration.parametersJsonSchema`.
- `GenerateContentResponse.functionCalls` and `.text` accessors.
- `FunctionCall` fields `id?`, `name?`, and `args?`.
- `Part.functionCall` and `Part.functionResponse`.
- `FunctionResponse` fields `id?`, `name?`, and `response?`.
- `Content` with `role` and `parts`; function response history is sent as
  model/user content parts.
- `AutomaticFunctionCallingConfig.disable`.

The adapter uses the SDK's `functionDeclarations` tool shape and JSON Schema
field directly. It sets function-calling mode to `AUTO`, while explicitly
setting `automaticFunctionCalling: { disable: true }`; the application
orchestrator remains responsible for executing calls.

## Application Input and Declaration Mapping

The generator keeps the Sprint 4.2 shape:

```js
async function generator({ input, tools, functionResponses }) {
  // Returns { text } or { functionCalls }.
}
```

`input` is either a string or a list of `{ role: 'user' | 'assistant', text }`
messages. The adapter maps these to Gemini `Content` records, translating
`assistant` to the SDK's `model` role. This initial adapter's default mapping
is text-only; it does not yet adapt image/audio parts.

Public declarations are translated as:

```js
{
  name,
  description,
  parametersJsonSchema
}
```

Only those three registry fields are accepted. Names, descriptions, supported
Sprint 4.1 JSON Schema keywords/types, declaration count, and serialized schema
sizes are validated. The adapter never forwards handlers, categories,
permissions, or trusted execution context. It rejects unsupported schemas and
duplicate declaration names.

## Response Mapping

- Normal SDK `response.text` becomes trimmed `{ text }`.
- SDK `response.functionCalls` become
  `{ functionCalls: [{ id, name, arguments }] }`.
- A provider call ID is preserved. If the installed SDK response omits it, the
  adapter creates a local `gemini-call-N` ID so the application contract can
  maintain response correlation.
- Missing `args` maps to `{}`; malformed names/arguments, duplicate IDs,
  mixed text-and-call responses, empty responses, and oversized responses are
  rejected with stable adapter errors.

The adapter does not invoke functions. Function-call arguments are bounded
JSON data and remain subject to the orchestrator and executor validation and
permission checks.

## Function Response and History Mapping

The SDK requires conversation history to include the model's function-call
content and the matching user function-response content. The adapter maps
each round to:

```js
{
  role: 'model',
  parts: [{ functionCall: { id, name, args } }]
}
{
  role: 'user',
  parts: [{
    functionResponse: {
      id,
      name,
      response: { output: result }
    }
  }]
}
```

Normalized tool errors become
`response: { error: { code, message } }`; messages are selected from a fixed
allowlist, never copied from arbitrary exceptions. Successful JSON results are
bounded to 8 KiB. Call IDs, names, original bounded arguments, and round order
are used to reconstruct history.

To support correct SDK history reconstruction, Sprint 4.2 function response
records were extended with `round` and `call: { id, name, arguments }`. Existing
`id`, `name`, and `result`/`error` fields remain. This is the one related
contract change required by the provider history format.

## Limits, Errors, and Security

- At most 512 declarations and 64 KiB of total serialized declarations.
- At most 3 calls per SDK response; each argument object is at most 4 KiB.
- Function-response history is capped at 6 calls, each successful result at
  8 KiB, and at most 2 contiguous rounds.
- Text responses are capped at 32 KiB.
- SDK exceptions are normalized to `GEMINI_GENERATION_FAILED`; raw provider
  messages and stacks are not propagated.
- Malformed declarations, responses, inputs, and histories return stable
  `GeminiToolAdapterError` codes without returning SDK response objects.
- The adapter does not log prompts, arguments, or tool results, grant
  permissions, derive session identity, or make its own external requests.

The adapter reconstructs model `functionCall` and user `functionResponse`
history in SDK-compatible roles and retains call IDs. It does not implement
model fallback or retry. Runtime integration must avoid retrying a request
after a tool has executed.

## Tests and Validation

`test/gemini-tool-adapter.test.js` covers declaration/schema conversion, text
and function-call translation, IDs, multiple calls, successful and normalized
error history, multi-round ordering, malformed/oversized content, unsupported
schemas, provider error normalization, disabled automatic function calling,
registry declaration isolation, and import safety. Tests require no API key or
live Gemini/WhatsApp/database/network service.

On Node.js `v24.22.1`, `npm run check` passed, `npm test` passed all 182 tests
with 0 failures and 0 skipped, and `git diff --check` passed.

## Not Yet Implemented

This adapter is not used by Friday's runtime. Multimodal input mapping, provider
fallback policy, real tool registration, and production Gemini integration are
future work. No existing Gemini response, fallback, WhatsApp, database, or
memory behavior was changed.
