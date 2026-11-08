# Sprint 2 — Database Migration Foundation

## Summary

Friday now applies ordered SQLite migrations through the existing `createDatabase()` connection. A `schema_migrations` table stores each applied version, name, and SQLite application timestamp. Migration execution is transactional and forward-only.

The existing `messages` and `user_memories` definitions and their indexes are preserved. For an existing database without migration metadata, Friday adopts version `001` only after verifying that all non-internal schema objects exactly match the known baseline. Unknown, partial, or modified schemas cause startup to fail without rewriting them.

No WhatsApp or Gemini integration was started. All migration tests use temporary files or in-memory SQLite databases. The production `data/friday.sqlite` was inspected only through a read-only connection for schema definitions; no records were queried and no writes were performed.

## Architecture

```text
src/database/
  migration-runner.js
  migrations/
    index.js
    001-initialize-existing-schema.js
  sqlite.js
```

- `migrations/index.js` explicitly registers migrations in the runtime. Importing the modules does not open a database or access the filesystem.
- Each migration exports a stable numeric `version`, a kebab-case `name`, and an `up(db)` operation.
- `migration-runner.js` validates migration definitions and stored metadata, orders migrations by numeric version, and applies pending migrations through the database connection supplied by `createDatabase()`.
- `sqlite.js` runs migrations before preparing or exposing database operations. The named operation exports and lazy default-database behavior remain unchanged.

`createDatabase({ dbPath })` remains compatible. It accepts an optional `migrations` list for controlled runner/failure tests; application startup uses the built-in ordered migration list.

## Versioning and Adding a Migration

Use a unique, zero-padded numeric version with at least three digits, a unique kebab-case name, and an `up(db)` function. Versions are immutable once deployed and must be registered in `migrations/index.js`.

Example future migration:

```js
// src/database/migrations/002-add-example-field.js
export const addExampleFieldMigration = {
  version: '002',
  name: 'add-example-field',
  up(db) {
    db.exec('ALTER TABLE messages ADD COLUMN example_field TEXT');
  },
};
```

Then add it to the ordered registration:

```js
import { addExampleFieldMigration } from './002-add-example-field.js';
import { initializeExistingSchemaMigration } from './001-initialize-existing-schema.js';

export const databaseMigrations = [
  initializeExistingSchemaMigration,
  addExampleFieldMigration,
];
```

Keep migration operations synchronous, deterministic, and limited to database work. The runner owns the transaction; migration `up` functions must not start or commit their own transaction.

## Baseline Adoption

Version `001` creates the existing tables and indexes on a fresh database. If the migration tracker is empty or absent and the database already contains application schema objects, the baseline migration compares their names, types, and normalized SQLite definitions to the known Friday baseline.

- Exact match: record version `001` without rerunning DDL.
- No application schema objects: execute the baseline migration to initialize a fresh database.
- Partial, extra, or differing schema: fail explicitly and roll back. The runner does not guess, repair, drop, rename, or recreate objects.

The comparison ignores SQLite's insignificant formatting differences and its omission of `IF NOT EXISTS` in stored schema SQL. It does not ignore extra tables, indexes, views, or triggers. Internal SQLite objects and `schema_migrations` are excluded from the application-schema comparison.

## Transactions and Failure Handling

- Each migration's `up` operation and tracking insert run in one `BEGIN IMMEDIATE` transaction.
- A failed migration is rolled back and is not recorded as applied.
- A failed rollback is surfaced as an `AggregateError` containing both the migration and rollback errors.
- `createDatabase()` closes its connection if migration or later initialization fails; if close also fails, both errors are surfaced.
- Reapplying an already recorded migration is prevented. Stored version/name, timestamp, tracker schema, and contiguous version history are validated; unknown or inconsistent metadata fails closed.
- Automatic down migrations and rollback of successfully applied migrations are intentionally not implemented.

## Existing Database Compatibility

The application tables remain:

- `messages`
- `user_memories`

The existing indexes remain:

- `idx_messages_session`
- `idx_user_memories_session`

No existing table, column, index, session identifier, record, history query, or memory behavior is changed. The new `schema_migrations` table is the only schema addition in this sprint.

## Tests

The migration test suite uses Node.js built-in `node:sqlite` with temporary directories and in-memory databases. It covers:

- Fresh initialization and exact legacy-schema adoption.
- Single execution, deterministic ordering, metadata, and repeat-open behavior.
- Duplicate versions and inconsistent applied metadata.
- Transaction rollback and absence of failed migration records.
- Database factory connection closure after a failed migration.
- Preservation of message history and user memories during baseline adoption.
- Separate database instance isolation.

The full project checks and test suite were run with Node.js `v24.22.1` and npm `11.19.1`:

- `npm run check`: PASS
- `npm test`: 136 passed, 0 failed, 0 skipped

## Recovery Considerations and Limitations

Before deploying future migrations to a database with valuable data, make a verified backup. On failure, retain the database and startup error for diagnosis; this runner does not repair unknown schemas or roll back migrations that have already committed. Correct an unapplied migration only before it has been released to users; once a version has been applied, schema changes should use a new forward migration.

The migration registry is statically maintained rather than discovered from the filesystem, preventing nondeterministic file ordering. Concurrent multi-process migration execution is not a supported deployment mode; a second process may fail safely if it races to record the same migration. The production schema was inspected read-only and matches the expected baseline; no production migration was run or claimed as verified in this sprint.
