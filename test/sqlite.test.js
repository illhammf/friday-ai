import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = process.cwd();
let sqliteModule;
let sqliteImportError;
const importDirectory = await mkdtemp(join(tmpdir(), 'friday-import-test-'));
const originalDirectory = process.cwd();

try {
  process.chdir(importDirectory);
  sqliteModule = await import('../src/database/sqlite.js');
  await assert.rejects(access(join(importDirectory, 'data')), {
    code: 'ENOENT',
  });
} catch (error) {
  if (error?.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') {
    throw error;
  }
  sqliteImportError = error;
} finally {
  process.chdir(originalDirectory);
  await rm(importDirectory, { recursive: true, force: true });
}

const skipSQLiteTests = sqliteImportError
  ? `node:sqlite unavailable: ${sqliteImportError.code}`
  : false;

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'));

  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await assert.rejects(access(directory), { code: 'ENOENT' });
  }
}

test('database factory initializes existing tables and indexes without import side effects', { skip: skipSQLiteTests }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const dbPath = join(directory, 'nested', 'friday.sqlite');
    const database = sqliteModule.createDatabase({ dbPath });

    try {
      const { DatabaseSync } = await import('node:sqlite');
      const inspection = new DatabaseSync(dbPath);
      try {
        const objects = inspection.prepare(`
          SELECT type, name FROM sqlite_master
          WHERE type IN ('table', 'index')
          ORDER BY type, name
        `).all();

        assert.ok(objects.some(({ type, name }) => type === 'table' && name === 'messages'));
        assert.ok(objects.some(({ type, name }) => type === 'table' && name === 'user_memories'));
        assert.ok(objects.some(({ type, name }) => type === 'index' && name === 'idx_messages_session'));
        assert.ok(objects.some(({ type, name }) => type === 'index' && name === 'idx_user_memories_session'));
      } finally {
        inspection.close();
      }
    } finally {
      database.close();
    }

    assert.throws(() => database.loadHistory('private:user'), /connection is closed/i);
    assert.doesNotThrow(() => database.close());
  });
});

test('database factory preserves history limits, ordering, and shape', { skip: skipSQLiteTests }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const database = sqliteModule.createDatabase({
      dbPath: join(directory, 'history.sqlite'),
    });

    try {
      for (let index = 1; index <= 22; index++) {
        database.saveMessage('private:user', 'user', `message-${index}`);
      }

      assert.deepEqual(database.loadHistory('private:user', 3), [
        { role: 'user', parts: [{ text: 'message-20' }] },
        { role: 'user', parts: [{ text: 'message-21' }] },
        { role: 'user', parts: [{ text: 'message-22' }] },
      ]);
      assert.equal(database.loadHistory('private:user', 30).length, 20);
    } finally {
      database.close();
    }
  });
});

test('database factory preserves memory operations and session isolation', { skip: skipSQLiteTests }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const database = sqliteModule.createDatabase({
      dbPath: join(directory, 'memory.sqlite'),
    });

    try {
      assert.deepEqual(database.saveUserMemory('private:a', 'Suka teh', 2), {
        added: true,
        limitReached: false,
      });
      assert.deepEqual(database.saveUserMemory('private:a', 'suka teh', 2), {
        added: false,
        limitReached: false,
      });
      assert.deepEqual(database.saveUserMemory('private:a', 'Suka kopi', 2), {
        added: true,
        limitReached: false,
      });
      assert.deepEqual(database.saveUserMemory('private:a', 'Suka air', 2), {
        added: false,
        limitReached: true,
      });
      assert.equal(database.loadUserMemories('private:b').length, 0);

      const memories = database.loadUserMemories('private:a');
      assert.deepEqual(memories.map(({ content }) => content), [
        'Suka teh',
        'Suka kopi',
      ]);
      assert.equal(database.deleteUserMemory('private:a', memories[0].id), true);
      assert.equal(database.clearUserMemories('private:a'), 1);
      assert.equal(database.clearUserMemories('private:a'), 0);
    } finally {
      database.close();
    }
  });
});

test('separate database instances remain isolated when one closes', { skip: skipSQLiteTests }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = sqliteModule.createDatabase({
      dbPath: join(directory, 'first.sqlite'),
    });
    const second = sqliteModule.createDatabase({
      dbPath: join(directory, 'second.sqlite'),
    });

    try {
      first.saveMessage('private:user', 'user', 'only in first');
      assert.equal(second.loadHistory('private:user').length, 0);
      first.close();
      second.saveMessage('private:user', 'user', 'second still open');
      assert.equal(second.loadHistory('private:user').length, 1);
    } finally {
      first.close();
      second.close();
    }
  });
});

test('database factory preserves data after close and reopen', { skip: skipSQLiteTests }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const dbPath = join(directory, 'persistent.sqlite');
    const first = sqliteModule.createDatabase({ dbPath });
    first.saveMessage('group:one', 'model', 'persisted');
    first.close();

    const reopened = sqliteModule.createDatabase({ dbPath });
    try {
      assert.deepEqual(reopened.loadHistory('group:one'), [
        { role: 'model', parts: [{ text: 'persisted' }] },
      ]);
    } finally {
      reopened.close();
    }
  });
});

test('importing the executable entry point does not create database or integration resources', async () => {
  await withTemporaryDirectory(async (directory) => {
    const entryPoint = pathToFileURL(
      join(repositoryRoot, 'src', 'index.js'),
    ).href;
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', 'await import(process.argv[1])', entryPoint],
      {
        cwd: directory,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    await assert.rejects(access(join(directory, 'data')), { code: 'ENOENT' });
    await assert.rejects(access(join(directory, '.wwebjs_auth')), {
      code: 'ENOENT',
    });
  });
});
