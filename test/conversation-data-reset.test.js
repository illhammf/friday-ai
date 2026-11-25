import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../src/database/sqlite.js';
import {
  RESET_CONFIRMATION,
  inspectConversationData,
  resetConversationData,
  runInteractiveConversationReset,
} from '../src/database/conversation-data-reset.js';

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-reset-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('reset reports scope and cancellation never changes data', async () => {
  await withDirectory(async (directory) => {
    const dbPath = join(directory, 'friday.sqlite');
    const database = createDatabase({ dbPath });
    database.saveMessage('private:test', 'user', 'temporary history');
    database.saveUserMemory('private:test', 'temporary memory', 10);
    database.close();
    const output = { value: '', write(chunk) { this.value += chunk; } };
    const result = await runInteractiveConversationReset({
      dbPath,
      backupDirectory: join(directory, 'backups'),
      input: (async function* () { yield 'NO'; }()),
      output,
    });
    assert.equal(result.cancelled, true);
    assert.match(output.value, /messages \(1 rows\)/);
    const inspection = inspectConversationData({ dbPath });
    assert.deepEqual(inspection.counts, { messages: 1, user_memories: 1 });
  });
});

test('reset creates a snapshot, clears only approved tables, and preserves migrations', async () => {
  await withDirectory(async (directory) => {
    const dbPath = join(directory, 'friday.sqlite');
    const database = createDatabase({ dbPath });
    database.saveMessage('private:test', 'user', 'temporary history');
    database.saveUserMemory('private:test', 'temporary memory', 10);
    database.close();
    const result = resetConversationData({
      dbPath,
      backupDirectory: join(directory, 'backups'),
    });
    assert.deepEqual(result.removed, { messages: 1, user_memories: 1 });
    assert.deepEqual(result.after, { messages: 0, user_memories: 0 });
    assert.deepEqual(result.protectedTables, ['schema_migrations']);
    assert.ok((await readFile(result.backupPath)).length > 0);
    const db = new DatabaseSync(dbPath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_memories').get().count, 0);
    } finally { db.close(); }
  });
});

test('interactive reset requires the exact confirmation phrase', async () => {
  assert.equal(RESET_CONFIRMATION, 'RESET ALL FRIDAY CONVERSATION DATA');
});
