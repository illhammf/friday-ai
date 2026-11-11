import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../src/database/sqlite.js';
import { runMigrations } from '../src/database/migration-runner.js';

const legacySchema = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'model')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages (session_id, id);

  CREATE TABLE IF NOT EXISTS user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, content)
  );

  CREATE INDEX IF NOT EXISTS idx_user_memories_session
  ON user_memories (session_id, id);
`;

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-migrations-test-'));

  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function readApplicationSchema(db) {
  return db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
      AND name != 'schema_migrations'
    ORDER BY type, name
  `).all();
}

function readMigrationRows(db) {
  return db.prepare(`
    SELECT version, name, applied_at
    FROM schema_migrations
    ORDER BY version
  `).all();
}

test('fresh database runs the baseline migration and initializes the existing schema', async () => {
  await withTemporaryDirectory(async (directory) => {
    const database = createDatabase({
      dbPath: join(directory, 'fresh.sqlite'),
    });
    const inspection = new DatabaseSync(join(directory, 'fresh.sqlite'));

    try {
      assert.deepEqual(readMigrationRows(inspection).map(
        ({ version, name }) => ({ version, name }),
      ), [
        { version: '001', name: 'initialize-existing-schema' },
        { version: '002', name: 'structure-user-memories' },
      ]);
      database.saveMessage('private:user', 'user', 'fresh history');
      assert.deepEqual(database.loadHistory('private:user'), [
        { role: 'user', parts: [{ text: 'fresh history' }] },
      ]);
    } finally {
      inspection.close();
      database.close();
    }
  });
});

test('existing database with the exact legacy schema is adopted then upgraded additively', async () => {
  await withTemporaryDirectory(async (directory) => {
    const dbPath = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(legacySchema);
    const before = readApplicationSchema(legacy);
    legacy.close();

    const database = createDatabase({ dbPath });
    database.close();

    const migrated = new DatabaseSync(dbPath);
    try {
      const after = readApplicationSchema(migrated);
      assert.deepEqual(
        after.filter(({ name }) => name !== 'user_memories'),
        before.filter(({ name }) => name !== 'user_memories'),
      );
      const memoryTable = after.find(
        ({ type, name }) => type === 'table' && name === 'user_memories',
      );
      assert.match(memoryTable.sql, /category TEXT NOT NULL DEFAULT 'fact'/);
      assert.match(memoryTable.sql, /source TEXT NOT NULL DEFAULT 'legacy'/);
      assert.match(memoryTable.sql, /updated_at TEXT NOT NULL DEFAULT ''/);
      assert.deepEqual(readMigrationRows(migrated).map(
        ({ version, name }) => ({ version, name }),
      ), [
        { version: '001', name: 'initialize-existing-schema' },
        { version: '002', name: 'structure-user-memories' },
      ]);
    } finally {
      migrated.close();
    }
  });
});

test('partial or unknown legacy schemas are rejected without adding migration metadata', async () => {
  await withTemporaryDirectory(async (directory) => {
    const dbPath = join(directory, 'partial.sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT)');
    legacy.prepare('INSERT INTO messages (content) VALUES (?)').run('preserve');
    const before = readApplicationSchema(legacy);
    legacy.close();

    assert.throws(
      () => createDatabase({ dbPath }),
      (error) => error.cause?.message.includes('Cannot adopt existing database'),
    );

    const unchanged = new DatabaseSync(dbPath);
    try {
      assert.deepEqual(readApplicationSchema(unchanged), before);
      assert.equal(
        unchanged.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE name = 'schema_migrations'
        `).get().count,
        0,
      );
      assert.equal(
        unchanged.prepare('SELECT content FROM messages').get().content,
        'preserve',
      );
    } finally {
      unchanged.close();
    }
  });
});

test('migration runner executes each migration only once', () => {
  const db = new DatabaseSync(':memory:');
  let executions = 0;
  const migrations = [{
    version: '001',
    name: 'count-migration-runs',
    up(database) {
      executions += 1;
      database.exec('CREATE TABLE migration_runs (value INTEGER NOT NULL)');
    },
  }];

  try {
    runMigrations(db, migrations);
    runMigrations(db, migrations);
    assert.equal(executions, 1);
    assert.equal(readMigrationRows(db).length, 1);
  } finally {
    db.close();
  }
});

test('multiple pending migrations execute in ascending version order', () => {
  const db = new DatabaseSync(':memory:');
  const migrations = [
    {
      version: '002',
      name: 'record-second',
      up(database) {
        database.prepare('INSERT INTO migration_order (value) VALUES (2)').run();
      },
    },
    {
      version: '001',
      name: 'record-first',
      up(database) {
        database.exec(`
          CREATE TABLE migration_order (value INTEGER NOT NULL);
          INSERT INTO migration_order (value) VALUES (1)
        `);
      },
    },
  ];

  try {
    runMigrations(db, migrations);
    assert.deepEqual(
      db.prepare('SELECT value FROM migration_order ORDER BY rowid')
        .all()
        .map(({ value }) => value),
      [1, 2],
    );
    assert.deepEqual(readMigrationRows(db).map(({ version }) => version), [
      '001',
      '002',
    ]);
  } finally {
    db.close();
  }
});

test('migration tracking stores the stable version, name, and application timestamp', async () => {
  await withTemporaryDirectory(async (directory) => {
    const dbPath = join(directory, 'metadata.sqlite');
    const database = createDatabase({ dbPath });
    database.close();

    const db = new DatabaseSync(dbPath);
    try {
      const [row] = readMigrationRows(db);
      assert.equal(row.version, '001');
      assert.equal(row.name, 'initialize-existing-schema');
      assert.match(row.applied_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.equal(Number.isNaN(Date.parse(`${row.applied_at.replace(' ', 'T')}Z`)), false);
    } finally {
      db.close();
    }
  });
});

test('duplicate migration versions are rejected before migration execution', () => {
  const db = new DatabaseSync(':memory:');
  let executed = false;
  const migrations = [
    { version: '001', name: 'first-migration', up() { executed = true; } },
    { version: '001', name: 'second-migration', up() { executed = true; } },
  ];

  try {
    assert.throws(() => runMigrations(db, migrations), /Duplicate.*version/);
    assert.equal(executed, false);
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE name = 'schema_migrations'
      `).get().count,
      0,
    );
  } finally {
    db.close();
  }
});

test('inconsistent applied migration metadata is rejected', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES ('001', 'unexpected-name', '2024-01-02 03:04:05')
  `);

  try {
    assert.throws(
      () => runMigrations(db, [{
        version: '001',
        name: 'expected-name',
        up() {},
      }]),
      /Inconsistent database migration metadata/,
    );
  } finally {
    db.close();
  }
});

test('failed migration rolls back schema changes and is not recorded as applied', () => {
  const db = new DatabaseSync(':memory:');
  const migrations = [{
    version: '001',
    name: 'fail-after-ddl',
    up(database) {
      database.exec('CREATE TABLE should_rollback (value TEXT)');
      throw new Error('injected migration failure');
    },
  }];

  try {
    assert.throws(
      () => runMigrations(db, migrations),
      (error) => error.message.includes('Migration 001') &&
        error.cause?.message === 'injected migration failure',
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE name IN ('schema_migrations', 'should_rollback')
      `).get().count,
      0,
    );
  } finally {
    db.close();
  }
});

test('database factory closes its connection when a migration fails', async () => {
  await withTemporaryDirectory(async (directory) => {
    let migrationConnection;
    const migrations = [{
      version: '001',
      name: 'capture-failed-connection',
      up(db) {
        migrationConnection = db;
        throw new Error('injected factory migration failure');
      },
    }];

    assert.throws(
      () => createDatabase({
        dbPath: join(directory, 'failure.sqlite'),
        migrations,
      }),
      /Migration 001.*failed/,
    );
    assert.throws(
      () => migrationConnection.prepare('SELECT 1'),
      /closed|not open/i,
    );
  });
});

test('baseline adoption preserves existing message history exactly', async () => {
  await withTemporaryDirectory(async (directory) => {
    const dbPath = join(directory, 'history.sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(legacySchema);
    legacy.prepare(`
      INSERT INTO messages (session_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run('private:user', 'user', 'existing question', '2024-01-02 03:04:05');
    legacy.prepare(`
      INSERT INTO messages (session_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `).run('private:user', 'model', 'existing answer', '2024-01-02 03:04:06');
    const before = legacy.prepare(`
      SELECT id, session_id, role, content, created_at
      FROM messages ORDER BY id
    `).all();
    legacy.close();

    const database = createDatabase({ dbPath });
    database.close();

    const migrated = new DatabaseSync(dbPath);
    try {
      assert.deepEqual(migrated.prepare(`
        SELECT id, session_id, role, content, created_at
        FROM messages ORDER BY id
      `).all(), before);
    } finally {
      migrated.close();
    }
  });
});

test('baseline adoption preserves existing user memories exactly', async () => {
  await withTemporaryDirectory(async (directory) => {
    const dbPath = join(directory, 'memories.sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(legacySchema);
    legacy.prepare(`
      INSERT INTO user_memories (session_id, content, created_at)
      VALUES (?, ?, ?)
    `).run('private:user', 'Prefers tea', '2024-02-03 04:05:06');
    const before = legacy.prepare(`
      SELECT id, session_id, content, created_at
      FROM user_memories ORDER BY id
    `).all();
    legacy.close();

    const database = createDatabase({ dbPath });
    database.close();

    const migrated = new DatabaseSync(dbPath);
    try {
      assert.deepEqual(migrated.prepare(`
        SELECT id, session_id, content, created_at
        FROM user_memories ORDER BY id
      `).all(), before);
      assert.deepEqual(
        migrated.prepare(`
          SELECT category, source, updated_at
          FROM user_memories ORDER BY id
        `).all().map(({ category, source, updated_at }) => ({
          category,
          source,
          updated_at,
        })),
        [{
          category: 'fact',
          source: 'legacy',
          updated_at: '2024-02-03 04:05:06',
        }],
      );
    } finally {
      migrated.close();
    }
  });
});

test('reopening a migrated database does not rerun or retimestamp migrations', async () => {
  await withTemporaryDirectory(async (directory) => {
    const dbPath = join(directory, 'reopen.sqlite');
    const first = createDatabase({ dbPath });
    first.close();
    const firstDb = new DatabaseSync(dbPath);
    const firstRows = readMigrationRows(firstDb);
    firstDb.close();

    const second = createDatabase({ dbPath });
    second.close();
    const secondDb = new DatabaseSync(dbPath);
    try {
      assert.deepEqual(readMigrationRows(secondDb), firstRows);
    } finally {
      secondDb.close();
    }
  });
});

test('separate database instances keep migration metadata and data isolated', async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = createDatabase({ dbPath: join(directory, 'first.sqlite') });
    const second = createDatabase({ dbPath: join(directory, 'second.sqlite') });

    try {
      first.saveMessage('private:user', 'user', 'only first');
      assert.equal(second.loadHistory('private:user').length, 0);
      first.close();
      second.saveMessage('private:user', 'user', 'second remains open');
      assert.equal(second.loadHistory('private:user').length, 1);
    } finally {
      first.close();
      second.close();
    }

    const firstDb = new DatabaseSync(join(directory, 'first.sqlite'));
    const secondDb = new DatabaseSync(join(directory, 'second.sqlite'));
    try {
      assert.equal(readMigrationRows(firstDb).length, 2);
      assert.equal(readMigrationRows(secondDb).length, 2);
      assert.deepEqual(
        firstDb.prepare('SELECT content FROM messages')
          .all()
          .map(({ content }) => content),
        ['only first'],
      );
      assert.deepEqual(
        secondDb.prepare('SELECT content FROM messages')
          .all()
          .map(({ content }) => content),
        ['second remains open'],
      );
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });
});
