# Sprint 4.1 — Tool Registry and Validation Foundation

## Scope

This sprint adds an isolated tool foundation only. It does not integrate Gemini,
WhatsApp, Smart Memory, the database, filesystem access, or network access. No
real tools are registered by these modules.

## Module Responsibilities

- `src/ai/tools/tool-registry.js` registers trusted application definitions,
  rejects duplicates, and exposes tool lookup. Public declarations contain only
  `name`, `description`, and `parametersJsonSchema`; handler and permission
  metadata remain private.
- `src/ai/tools/tool-validator.js` validates schemas and JSON arguments against
  the supported subset. It clones plain JSON input before validation, rejects
  accessors and non-JSON values, and returns a safe copy only on success.
- `src/ai/tools/tool-permission-policy.js` denies unknown categories and
  non-read-only tools. A read-only tool still requires an explicit trusted
  application grant.
- `src/ai/tools/tool-executor.js` resolves registered tools, validates and
  authorizes arguments, freezes the safe arguments and handler context, invokes
  the registered handler, and bounds and normalizes results.

Definitions are registered by application code, never by model-provided data.
Names must match `^[a-z][a-z0-9_]{0,63}$`; descriptions must contain 1–1024
characters; input schemas must be object schemas; and handlers must be
functions.

## Supported Schema Subset

Supported types are `object`, `string`, `number`, `integer`, and `boolean`.
Supported keywords are:

- `required`, `properties`, and `additionalProperties` on objects.
- `enum` on supported scalar types.
- `minimum` and `maximum` on numbers and integers.
- `minLength` and `maxLength` on strings.

Nested objects are supported. Arrays and all other JSON Schema types or
keywords are rejected. Arguments are limited to 4 KiB of serialized UTF-8 data
by default, and unknown object properties are rejected when the schema sets
`additionalProperties: false`.

## Permission and Context Model

Permission categories are `read_only`, `action`, and `approval_required`.
Only `read_only` tools can execute in this sprint, and only when their name is
present in the trusted execution context's `authorizedTools` array or set.
Authorization is never inferred from model arguments. Action and
approval-required tools stay unavailable until a future approval system exists.

The executor snapshots and freezes plain trusted context, then omits
`authorizedTools` before passing context to the handler. The handler also
receives an `AbortSignal`; the signal is for cooperative cancellation, not a
permission mechanism. Session identity and scope must be supplied by trusted
application code, not selected by model input.

## Execution, Limits, and Errors

Default limits are a 3-second timeout, 4 KiB of serialized arguments, and 8 KiB
of serialized output. Callers may lower these limits but cannot raise them.
Outputs must be JSON-serializable and are round-tripped through JSON before
being returned.

Timeouts reject with a normalized `TOOL_TIMEOUT` error and abort the handler's
signal. JavaScript cannot forcibly stop a handler that ignores its signal, and
timers cannot preempt synchronous CPU-bound work on the event loop. Late handler
results are ignored; handlers should be bounded, non-blocking, and honor the
signal where possible.

Failures use stable error codes for unknown tools, invalid arguments, denied
permissions, timeouts, invalid/oversized output, and handler failures. Handler
messages and stack traces are not included in normalized execution errors. The
modules do not log arguments, results, or context.

## Security Limitations

The registry only treats registered application code as executable; it does
not make an unsafe handler safe. This sprint provides no shell, arbitrary
filesystem, network, or database tool. Future handlers must expose narrow
capabilities, apply explicit allowlists and privacy boundaries, treat returned
data as untrusted prompt content, and enforce their own resource limits.
Output bounding limits size but does not detect prompt injection or redact
secrets in data returned by a future tool.

Importing the new modules has no integration or I/O side effects. The focused
import-safety test imports them in a temporary working directory and checks
that it remains untouched.

## Tests and Validation

`test/ai-tools.test.js` covers registration and declaration isolation, schema
validation and bounds, permission denial/authorization, normalized executor
errors, output limits, timeout behavior, and import safety. Tests use fake
handlers and no live integrations.

Validation results are recorded after running `npm run check` and `npm test`.
On Node.js `v24.22.1`, `npm run check` passed and `npm test` passed all 156
tests with 0 failures and 0 skipped.
