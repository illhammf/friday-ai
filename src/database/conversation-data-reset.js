import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export const DEFAULT_CONVERSATION_DATABASE_PATH = resolve('data', 'friday.sqlite');
export const RESET_CONFIRMATION = 'RESET ALL FRIDAY CONVERSATION DATA';
export const CONVERSATION_TABLES = Object.freeze(['messages', 'user_memories']);
export const PROTECTED_TABLES = Object.freeze(['schema_migrations']);

function assertSafeDatabasePath(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new TypeError('A database path is required.');
  }
  const absolutePath = resolve(dbPath);
  if (!isAbsolute(absolutePath) || !existsSync(absolutePath)) {
    throw new Error('The configured conversation database does not exist. Reset refused.');
  }
  return absolutePath;
}

function inspectTables(db) {
  const rows = db.prepare(`
    SELECT type, name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  const names = new Set(rows.map(({ name }) => name));
  for (const table of CONVERSATION_TABLES) {
    if (!names.has(table)) {
      throw new Error(`Required conversation table is missing: ${table}`);
    }
  }
  return rows.map(({ name }) => name);
}

function counts(db) {
  return Object.fromEntries(CONVERSATION_TABLES.map((table) => [
    table,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count),
  ]));
}

function backupDatabase(db, dbPath, backupDirectory) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = resolve(backupDirectory || resolve(dirname(dbPath), 'backups'));
  mkdirSync(directory, { recursive: true });
  const backupPath = resolve(directory, `friday-conversation-reset-${timestamp}.sqlite`);
  // DatabaseSync.serialize() is a consistent SQLite snapshot while the handle is open.
  writeFileSync(backupPath, Buffer.from(db.serialize()), { flag: 'wx', mode: 0o600 });
  return backupPath;
}

export function inspectConversationData({ dbPath = DEFAULT_CONVERSATION_DATABASE_PATH } = {}) {
  const absolutePath = assertSafeDatabasePath(dbPath);
  const db = new DatabaseSync(absolutePath);
  try {
    const tables = inspectTables(db);
    return {
      dbPath: absolutePath,
      tables,
      protectedTables: PROTECTED_TABLES.filter((table) => tables.includes(table)),
      counts: counts(db),
    };
  } finally {
    db.close();
  }
}

export function resetConversationData({
  dbPath = DEFAULT_CONVERSATION_DATABASE_PATH,
  backupDirectory,
} = {}) {
  const absolutePath = assertSafeDatabasePath(dbPath);
  const db = new DatabaseSync(absolutePath);
  let transactionStarted = false;
  try {
    const tables = inspectTables(db);
    const before = counts(db);
    const backupPath = backupDatabase(db, absolutePath, backupDirectory);
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      db.exec('DELETE FROM user_memories');
      db.exec('DELETE FROM messages');
      db.exec('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      }
      throw error;
    }
    const after = counts(db);
    if (after.messages !== 0 || after.user_memories !== 0) {
      throw new Error('Conversation reset verification failed: approved tables are not empty.');
    }
    return {
      dbPath: absolutePath,
      tables,
      protectedTables: PROTECTED_TABLES.filter((table) => tables.includes(table)),
      before,
      removed: {
        messages: before.messages - after.messages,
        user_memories: before.user_memories - after.user_memories,
      },
      after,
      backupPath,
    };
  } finally {
    db.close();
  }
}

export async function runInteractiveConversationReset({
  input = process.stdin,
  output = process.stdout,
  dbPath = DEFAULT_CONVERSATION_DATABASE_PATH,
  backupDirectory,
} = {}) {
  const details = inspectConversationData({ dbPath });
  output.write(`Database: ${details.dbPath}\n`);
  output.write(`Affected tables: ${CONVERSATION_TABLES.map((table) => `${table} (${details.counts[table]} rows)`).join(', ')}\n`);
  output.write(`Protected tables: ${details.protectedTables.join(', ') || '(none discovered)'}\n`);
  output.write(`Type exactly: ${RESET_CONFIRMATION}\n`);

  let answer = '';
  for await (const line of input) {
    answer = String(line).trim();
    break;
  }
  if (answer !== RESET_CONFIRMATION) {
    output.write('Reset cancelled. No database changes were made.\n');
    return { cancelled: true, details };
  }
  const result = resetConversationData({ dbPath, backupDirectory });
  output.write(`Reset complete. Removed messages=${result.removed.messages}, user_memories=${result.removed.user_memories}.\n`);
  output.write(`Backup: ${result.backupPath}\n`);
  output.write('Protected tables and WhatsApp authentication data were left untouched.\n');
  return { cancelled: false, result };
}

export function readBackupBytes(backupPath) {
  return readFileSync(backupPath);
}
