const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'model')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages (session_id, id)`,
  `CREATE TABLE IF NOT EXISTS user_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, content)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_memories_session
  ON user_memories (session_id, id)`,
];

const expectedObjects = [
  {
    type: 'table',
    name: 'messages',
    sql: schemaStatements[0],
  },
  {
    type: 'index',
    name: 'idx_messages_session',
    sql: schemaStatements[1],
  },
  {
    type: 'table',
    name: 'user_memories',
    sql: schemaStatements[2],
  },
  {
    type: 'index',
    name: 'idx_user_memories_session',
    sql: schemaStatements[3],
  },
];

function normalizeSql(sql) {
  return sql
    .trim()
    .replace(/;\s*$/, '')
    .replace(/\bif not exists\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .toLowerCase();
}

function compareObjects(left, right) {
  return left.type.localeCompare(right.type) ||
    left.name.localeCompare(right.name);
}

function adoptExistingSchema(db) {
  const actualObjects = db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
      AND name != 'schema_migrations'
    ORDER BY type, name
  `).all();

  if (actualObjects.length === 0) {
    return false;
  }

  const actual = actualObjects
    .map(({ type, name, sql }) => ({ type, name, sql: normalizeSql(sql) }))
    .sort(compareObjects);
  const expected = expectedObjects
    .map(({ type, name, sql }) => ({ type, name, sql: normalizeSql(sql) }))
    .sort(compareObjects);

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      'Cannot adopt existing database: its schema does not exactly match the known Friday baseline.',
    );
  }

  return true;
}

export const initializeExistingSchemaMigration = {
  version: '001',
  name: 'initialize-existing-schema',
  up(db) {
    for (const statement of schemaStatements) {
      db.exec(statement);
    }
  },
  adoptExistingSchema,
};
