# Sprint 3 — Smart Memory Foundation

## Existing Memory Behavior

Before Sprint 3, `user_memories` stored `id`, `session_id`, `content`, and `created_at`; `(session_id, content)` is unique. The database operations support add, list, delete-by-ID, and clear-by-session. Adds are case-insensitive duplicate checked and respect the caller's maximum count. Explicit WhatsApp memory commands cap entries at 30 and content at 500 characters, reject common credential labels, and support list/delete/clear.

Private session IDs are `private:${senderId}`. The message service rejects memory commands in groups before dispatching them to the memory store. `askFriday()` does not retrieve private memories for a group conversation.

Previously, all memories for the private session were passed into `getMemoryInstruction()` as system-instruction context. The prompt explicitly described them as untrusted user-written data.

## Structured Memory Design

The existing table is extended additively. New fields:

| Field | Default for legacy records | Purpose |
|---|---|---|
| `category` | `fact` | `preference`, `personal_context`, `project`, `fact`, or `instruction` |
| `source` | `legacy` | Provenance, such as `legacy` or `explicit` |
| `updated_at` | Existing `created_at` value | Timestamp for later update support |

Migration `002-structure-user-memories` adds the columns with `ALTER TABLE` and updates only the new `updated_at` field on existing rows. It does not rebuild or delete records. Existing IDs, sessions, contents, and `created_at` values remain unchanged. Migration `001` is unchanged.

New explicit saves default to category `fact` and source `explicit`; the existing “simpan preferensi” command is stored as category `preference`. Other supported categories may be supplied through the memory service. Existing command syntax and replies are retained.

## Module Responsibilities

- `src/ai/memory-policy.js`: canonical categories, content normalization, length/capacity constants, and rejection of credential-like content.
- `src/database/memory-repository.js`: adapts existing database operations; it receives the application database instance and does not open a connection.
- `src/application/memory-service.js`: validates adds, delegates persistence, and exposes list/delete/clear/retrieve operations through an injected repository.
- `src/ai/memory-retriever.js`: tokenizes Indonesian/English query text, ignores a small stop-word list, scores exact token overlap, and returns a bounded deterministic result.
- `src/database/migrations/002-structure-user-memories.js`: performs the additive schema change through the existing migration runner.

## Retrieval, Privacy, and Prompt Context

For private chats, SQLite searches only the current private session for query-term matches and caps candidates at 30. The retriever returns at most five exact-token-overlap matches by default, ordered by score and then existing memory order. A query with no useful terms or no matches returns no memory context. There are no embeddings or external services.

The selected structured `category` and `content` are passed to Gemini as JSON under an explicit untrusted-memory system-instruction section. Sensitive legacy or new content is filtered from model context by the same policy used for saves. The memory context is never logged. Group chats pass an empty memory list and never query the private memory repository.

Memory creation remains opt-in: only the existing explicit memory command path saves entries. No conversation is automatically persisted as memory.

## Compatibility and Limitations

- Existing add/list/delete/clear APIs and command behavior remain available.
- Existing records are preserved and become visible with the metadata defaults above.
- Legacy entries are classified neutrally as `fact`; their original intent is not guessed.
- New command saves also default to `fact`; category-aware creation is currently an application API, not a new WhatsApp command.
- `updated_at` is initialized and set on creation; update-in-place commands are not introduced in this sprint.
- Keyword matching is deterministic but lexical; synonyms and inflections may not match.
- Credential detection is heuristic and cannot guarantee identification of every possible secret.

No schema outside `user_memories` changed. No dependencies were added. No WhatsApp or Gemini live integration was exercised, and no production migration was run.

## Verification

Validation was performed with Node.js `v24.22.1` and npm `11.19.1`.

- `npm run check`: PASS
- `npm test`: 141 passed, 0 failed, 0 skipped.

Migration and repository tests use temporary or in-memory SQLite databases. Tests cover legacy ID/content/timestamp preservation, metadata defaults, category and content validation, credential rejection, duplicate behavior, session isolation, explicit command compatibility, deterministic bounded retrieval, deletion, and clearing.
