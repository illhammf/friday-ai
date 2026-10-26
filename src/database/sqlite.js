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

export function saveMessage(sessionId, role, content) {
  insertMessage.run(sessionId, role, content);
  trimHistory.run(sessionId, sessionId);
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
