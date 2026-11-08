import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const SCHEMA = `
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

let defaultDatabase;

export function createDatabase({ dbPath }) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new TypeError('dbPath must be a non-empty string.');
  }

  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(SCHEMA);

    const insertMessage = db.prepare(`
      INSERT INTO messages (session_id, role, content)
      VALUES (?, ?, ?)
    `);

    const getHistory = db.prepare(`
      SELECT role, content
      FROM messages
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT 20
    `);

    const trimHistory = db.prepare(`
      DELETE FROM messages
      WHERE session_id = ?
      AND id NOT IN (
        SELECT id FROM messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT 20
      )
    `);

    const insertMemory = db.prepare(`
      INSERT OR IGNORE INTO user_memories (session_id, content)
      VALUES (?, ?)
    `);

    const getMemories = db.prepare(`
      SELECT id, content, created_at
      FROM user_memories
      WHERE session_id = ?
      ORDER BY id ASC
    `);

    const deleteMemoryById = db.prepare(`
      DELETE FROM user_memories
      WHERE session_id = ? AND id = ?
    `);

    const deleteAllMemories = db.prepare(`
      DELETE FROM user_memories
      WHERE session_id = ?
    `);

    const getMemoryCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM user_memories
      WHERE session_id = ?
    `);

    let closed = false;

    function ensureOpen() {
      if (closed) {
        throw new Error('Database connection is closed.');
      }
    }

    return {
      saveMessage(sessionId, role, content) {
        ensureOpen();
        insertMessage.run(sessionId, role, content);
        trimHistory.run(sessionId, sessionId);
      },
      loadHistory(sessionId, limit = 10) {
        ensureOpen();
        return getHistory.all(sessionId)
          .reverse()
          .slice(-limit)
          .map(({ role, content }) => ({
            role,
            parts: [{ text: content }],
          }));
      },
      saveUserMemory(sessionId, content, maxEntries) {
        ensureOpen();
        const existing = getMemories.all(sessionId);

        if (
          existing.some(
            (memory) => memory.content.toLowerCase() === content.toLowerCase(),
          )
        ) {
          return { added: false, limitReached: false };
        }

        if (getMemoryCount.get(sessionId).count >= maxEntries) {
          return { added: false, limitReached: true };
        }

        const result = insertMemory.run(sessionId, content);
        return {
          added: result.changes > 0,
          limitReached: false,
        };
      },
      loadUserMemories(sessionId) {
        ensureOpen();
        return getMemories.all(sessionId);
      },
      deleteUserMemory(sessionId, memoryId) {
        ensureOpen();
        return deleteMemoryById.run(sessionId, memoryId).changes > 0;
      },
      clearUserMemories(sessionId) {
        ensureOpen();
        return deleteAllMemories.run(sessionId).changes;
      },
      close() {
        if (closed) return;
        closed = true;
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function initializeDefaultDatabase() {
  if (!defaultDatabase) {
    defaultDatabase = createDatabase({
      dbPath: join('data', 'friday.sqlite'),
    });
  }

  return defaultDatabase;
}

function getDefaultDatabase() {
  return defaultDatabase || initializeDefaultDatabase();
}

export function saveMessage(...args) {
  return getDefaultDatabase().saveMessage(...args);
}

export function loadHistory(...args) {
  return getDefaultDatabase().loadHistory(...args);
}

export function saveUserMemory(...args) {
  return getDefaultDatabase().saveUserMemory(...args);
}

export function loadUserMemories(...args) {
  return getDefaultDatabase().loadUserMemories(...args);
}

export function deleteUserMemory(...args) {
  return getDefaultDatabase().deleteUserMemory(...args);
}

export function clearUserMemories(...args) {
  return getDefaultDatabase().clearUserMemories(...args);
}

export function privateSessionId(userId) {
  return `private:${userId}`;
}

export function groupSessionId(groupId) {
  return `group:${groupId}`;
}

export function closeDatabase() {
  defaultDatabase?.close();
  defaultDatabase = undefined;
}
