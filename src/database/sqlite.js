import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { databaseMigrations } from './migrations/index.js';
import { runMigrations } from './migration-runner.js';

let defaultDatabase;

export function createDatabase({
  dbPath,
  migrations = databaseMigrations,
}) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new TypeError('dbPath must be a non-empty string.');
  }

  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);

  try {
    runMigrations(db, migrations);

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
      INSERT OR IGNORE INTO user_memories
        (session_id, category, content, source, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const getMemories = db.prepare(`
      SELECT id, category, content, source, created_at, updated_at
      FROM user_memories
      WHERE session_id = ?
      ORDER BY id ASC
    `);

    function searchUserMemories(sessionId, terms, limit) {
      ensureOpen();
      const uniqueTerms = [...new Set(
        (Array.isArray(terms) ? terms : [])
          .filter((term) => typeof term === 'string' && term.trim())
          .map((term) => term.trim()),
      )];
      if (uniqueTerms.length === 0 || !Number.isInteger(limit) || limit <= 0) {
        return [];
      }

      const conditions = uniqueTerms
        .map(() => '(content LIKE ? ESCAPE \'\\\' OR category LIKE ? ESCAPE \'\\\')')
        .join(' OR ');
      const statement = db.prepare(`
        SELECT id, category, content, source, created_at, updated_at
        FROM user_memories
        WHERE session_id = ? AND (${conditions})
        ORDER BY id ASC
        LIMIT ?
      `);
      const parameters = [sessionId];
      for (const term of uniqueTerms) {
        const escaped = term.replace(/[\\%_]/g, '\\$&');
        parameters.push(`%${escaped}%`, `%${escaped}%`);
      }
      parameters.push(limit);
      return statement.all(...parameters);
    }

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
      saveUserMemory(sessionId, content, maxEntries, metadata = {}) {
        ensureOpen();
        metadata ||= {};
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

        const category = metadata.category || 'fact';
        const source = metadata.source || 'explicit';
        const result = insertMemory.run(
          sessionId,
          category,
          content,
          source,
        );
        return {
          added: result.changes > 0,
          limitReached: false,
        };
      },
      loadUserMemories(sessionId) {
        ensureOpen();
        return getMemories.all(sessionId);
      },
      searchUserMemories(sessionId, terms, limit) {
        return searchUserMemories(sessionId, terms, limit);
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
    try {
      db.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Database initialization failed and the connection could not be closed.',
        { cause: error },
      );
    }
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
