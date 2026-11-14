import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../src/application/application-lifecycle.js';
import { createMessageService } from '../src/application/message-service.js';

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

test('saves an assistant conversation turn atomically and rolls back partial writes', { skip: skipSQLiteTests }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const database = sqliteModule.createDatabase({
      dbPath: join(directory, 'conversation-turn.sqlite'),
    });

    try {
      database.saveConversationTurn('private:user', 'question', 'answer');
      assert.deepEqual(database.loadHistory('private:user'), [
        { role: 'user', parts: [{ text: 'question' }] },
        { role: 'model', parts: [{ text: 'answer' }] },
      ]);

      assert.throws(() => database.saveConversationTurn(
        'private:user',
        'must rollback',
        null,
      ));
      assert.deepEqual(database.loadHistory('private:user'), [
        { role: 'user', parts: [{ text: 'question' }] },
        { role: 'model', parts: [{ text: 'answer' }] },
      ]);
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

test('database, application lifecycle, and message service share only injected temporary state', { skip: skipSQLiteTests }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const firstPath = join(directory, 'first-app.sqlite');
    const secondPath = join(directory, 'second-app.sqlite');
    const logger = { log() {}, error() {} };
    const createTestApp = (dbPath) => {
      let database;
      const application = createApplication({
        openDatabase: () => {
          database = sqliteModule.createDatabase({ dbPath });
          return database;
        },
        createClient: async () => ({ destroy: async () => {} }),
        initializeClient: async () => {},
        stopAccepting: () => {},
        drainMessages: async () => {},
        logger,
      });

      const service = createMessageService({
        botName: 'Friday',
        getReadyAt: () => 1,
        sessions: {
          privateSessionId: (senderId) => `private:${senderId}`,
          groupSessionId: (chatId) => `group:${chatId}`,
        },
        memory: {
          parseCommand: () => null,
          handleCommand: async () => null,
        },
        video: {
          getUrls: () => [],
          isDownloadRequest: () => false,
          download: async () => null,
          getFailureMessage: () => '',
        },
        sticker: {
          isRequest: () => false,
          parseOptions: () => ({}),
          create: async () => null,
          getFailureMessage: () => '',
        },
        image: {
          isGenerationRequest: () => false,
          generate: async () => null,
          isQuotaError: () => false,
          getQuotaDiagnostic: () => '',
          getFailureMessage: () => '',
        },
        assistant: {
          ask: async ({ privateSession, question }) => {
            return 'temporary reply';
          },
          getFailureMessage: () => 'error',
        },
        audio: {
          transcribe: async () => '',
          generate: async () => null,
          isQuotaError: () => false,
          getFailureMessage: (_error, text) => text,
        },
        history: {
          save: (...args) => database.saveMessage(...args),
          saveConversationTurn: (...args) =>
            database.saveConversationTurn(...args),
        },
        formatMessage: (text) => text,
        deliver: {
          sendVideo: async () => {},
          sendSticker: async () => {},
          sendImage: async () => {},
          sendVoice: async () => {},
        },
        logger: { event() {}, error() {} },
      });

      return { application, service, getDatabase: () => database };
    };

    const first = createTestApp(firstPath);
    const second = createTestApp(secondPath);
    assert.equal(first.application.state, 'idle');
    assert.equal(first.getDatabase(), undefined);

    await first.application.start();
    await second.application.start();

    const incoming = {
      messageId: 'message-1',
      chatId: 'user@c.us',
      senderId: 'user@c.us',
      chatType: 'private',
      messageType: 'chat',
      text: 'hello',
      caption: '',
      timestamp: 2,
      group: null,
      media: null,
    };
    const replies = [];
    await first.service.handle(incoming, {
      reply: async (text) => replies.push(text),
    });

    assert.deepEqual(replies, ['temporary reply']);
    assert.equal(first.getDatabase().loadHistory('private:user@c.us').length, 2);
    assert.equal(second.getDatabase().loadHistory('private:user@c.us').length, 0);

    await Promise.all([
      first.application.shutdown('TEST'),
      second.application.shutdown('TEST'),
    ]);

    const reopened = sqliteModule.createDatabase({ dbPath: firstPath });
    try {
      assert.deepEqual(reopened.loadHistory('private:user@c.us'), [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'temporary reply' }] },
      ]);
    } finally {
      reopened.close();
    }
  });
});

test('application startup failure closes the injected temporary database', { skip: skipSQLiteTests }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const dbPath = join(directory, 'startup-failure.sqlite');
    let database;
    const application = createApplication({
      openDatabase: () => {
        database = sqliteModule.createDatabase({ dbPath });
        return database;
      },
      createClient: async () => ({
        destroy: async () => {},
      }),
      initializeClient: async () => {
        throw new Error('injected initialization failure');
      },
      stopAccepting: () => {},
      drainMessages: async () => {},
      logger: { log() {}, error() {} },
    });

    await assert.rejects(application.start(), /injected initialization failure/);
    assert.equal(application.state, 'stopped');
    assert.throws(() => database.loadHistory('private:user'), /connection is closed/i);

    const reopened = sqliteModule.createDatabase({ dbPath });
    reopened.close();
  });
});

test('importing entry point and application modules starts no external integration or database', async () => {
  await withTemporaryDirectory(async (directory) => {
    const entryPoint = pathToFileURL(join(repositoryRoot, 'src', 'index.js')).href;
    const lifecycleModule = pathToFileURL(
      join(repositoryRoot, 'src', 'application', 'application-lifecycle.js'),
    ).href;
    const messageServiceModule = pathToFileURL(
      join(repositoryRoot, 'src', 'application', 'message-service.js'),
    ).href;
    const memoryModules = [
      'application/memory-service.js',
      'database/memory-repository.js',
      'database/migrations/index.js',
      'ai/memory-policy.js',
      'ai/memory-retriever.js',
      'ai/user-memory.js',
    ].map((modulePath) => pathToFileURL(
      join(repositoryRoot, 'src', modulePath),
    ).href);
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'await Promise.all(process.argv.slice(1).map((specifier) => import(specifier)))',
        entryPoint,
        lifecycleModule,
        messageServiceModule,
        ...memoryModules,
      ],
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
