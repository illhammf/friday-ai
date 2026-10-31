import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync('data', { recursive: true });

const db = new DatabaseSync(join('data', 'friday.sqlite'));

db.exec(`
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
`);

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

export function saveMessage(sessionId, role, content) {
  insertMessage.run(sessionId, role, content);
  trimHistory.run(sessionId, sessionId);
}

export function saveUserMemory(sessionId, content, maxEntries) {
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
}

export function loadUserMemories(sessionId) {
  return getMemories.all(sessionId);
}

export function deleteUserMemory(sessionId, memoryId) {
  return deleteMemoryById.run(sessionId, memoryId).changes > 0;
}

export function clearUserMemories(sessionId) {
  return deleteAllMemories.run(sessionId).changes;
}

export function privateSessionId(userId) {
  return `private:${userId}`;
}

export function groupSessionId(groupId) {
  return `group:${groupId}`;
}

export function loadHistory(sessionId, limit = 10) {
  return getHistory.all(sessionId)
    .reverse()
    .slice(-limit)
    .map(({ role, content }) => ({
      role,
      parts: [{ text: content }],
    }));
}

export function closeDatabase() {
  db.close();
}