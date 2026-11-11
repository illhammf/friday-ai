import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryService } from '../src/application/memory-service.js';
import { createMemoryRepository } from '../src/database/memory-repository.js';
import { createDatabase } from '../src/database/sqlite.js';
import {
  MEMORY_CATEGORIES,
  normalizeMemoryCategory,
  normalizeMemoryContent,
} from '../src/ai/memory-policy.js';
import { retrieveRelevantMemories } from '../src/ai/memory-retriever.js';
import { handleMemoryCommand } from '../src/ai/user-memory.js';

async function withTemporaryDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-smart-memory-'));
  const database = createDatabase({
    dbPath: join(directory, 'memory.sqlite'),
  });

  try {
    await run(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('memory policy validates supported categories and normalizes content', () => {
  assert.deepEqual(MEMORY_CATEGORIES, [
    'preference',
    'personal_context',
    'project',
    'fact',
    'instruction',
  ]);
  assert.equal(normalizeMemoryCategory('project'), 'project');
  assert.throws(() => normalizeMemoryCategory('credential'), /Unsupported/);
  assert.deepEqual(normalizeMemoryContent('  I\n like tea  '), {
    valid: true,
    content: 'I like tea',
  });
  assert.equal(normalizeMemoryContent('   ').reason, 'empty');
  assert.equal(normalizeMemoryContent('x'.repeat(501)).reason, 'oversized');
  assert.equal(normalizeMemoryContent('password: dont-save-this').reason, 'sensitive');
  assert.equal(normalizeMemoryContent('Bearer abc.def.ghi').reason, 'sensitive');
  assert.equal(normalizeMemoryContent('ghp_12345678901234567890').reason, 'sensitive');
  assert.equal(normalizeMemoryContent(null).reason, 'invalid');
});

test('structured memory service uses injected repository and isolates sessions', async () => {
  await withTemporaryDatabase(async (database) => {
    const repository = createMemoryRepository(database);
    const memory = createMemoryService({ repository });

    assert.deepEqual(memory.add(
      'private:user-a',
      'Friday uses concise Indonesian',
      30,
      { category: 'preference', source: 'explicit' },
    ), { added: true, limitReached: false });
    assert.deepEqual(memory.add(
      'private:user-a',
      'friday uses concise indonesian',
      30,
      { category: 'preference', source: 'explicit' },
    ), { added: false, limitReached: false });
    assert.deepEqual(memory.add(
      'private:user-b',
      'Project Atlas is active',
      30,
      { category: 'project', source: 'explicit' },
    ), { added: true, limitReached: false });

    const [saved] = memory.list('private:user-a');
    assert.equal(saved.category, 'preference');
    assert.equal(saved.source, 'explicit');
    assert.match(saved.created_at, /^\d{4}-\d{2}-\d{2} /);
    assert.match(saved.updated_at, /^\d{4}-\d{2}-\d{2} /);
    assert.equal(memory.list('private:user-b')[0].category, 'project');
    assert.equal(memory.list('private:user-c').length, 0);

    assert.deepEqual(memory.add(
      'private:user-a',
      'password: private-value',
    ), {
      added: false,
      limitReached: false,
      rejected: 'sensitive',
    });
    assert.throws(
      () => memory.add('private:user-a', 'regular fact', 30, {
        category: 'invalid',
      }),
      /Unsupported memory category/,
    );

    assert.equal(memory.delete('private:user-a', saved.id), true);
    assert.equal(memory.list('private:user-a').length, 0);
    assert.equal(memory.clear('private:user-b'), 1);
    assert.equal(memory.clear('private:user-b'), 0);
  });
});

test('retrieves only deterministic keyword matches within the requested limit', () => {
  const memories = [
    { id: 1, category: 'preference', content: 'likes concise answers' },
    { id: 2, category: 'project', content: 'Project Atlas uses SQLite' },
    { id: 3, category: 'fact', content: 'Lives near the coast' },
    { id: 4, category: 'project', content: 'Atlas release is next month' },
    { id: 5, category: 'fact', content: 'Works with Node.js' },
  ];

  assert.deepEqual(
    retrieveRelevantMemories(memories, 'Tell me about Atlas SQLite', 1)
      .map(({ id }) => id),
    [2],
  );
  assert.deepEqual(
    retrieveRelevantMemories(memories, 'Atlas release timing', 5)
      .map(({ id }) => id),
    [4, 2],
  );
  assert.deepEqual(retrieveRelevantMemories(memories, 'weather today'), []);
});

test('repository-backed retrieval searches only matching records and caps results', async () => {
  await withTemporaryDatabase(async (database) => {
    const memory = createMemoryService({
      repository: createMemoryRepository(database),
    });
    for (let index = 0; index < 12; index += 1) {
      memory.add('private:user', `Project Orion detail ${index}`, 30, {
        category: 'project',
      });
    }
    memory.add('private:user', 'Prefers short replies', 30, {
      category: 'preference',
    });
    memory.add('private:other', 'Project Orion secret project', 30, {
      category: 'project',
    });

    assert.deepEqual(
      memory.retrieve('private:user', 'Project Orion', 3)
        .map(({ content }) => content),
      [
        'Project Orion detail 0',
        'Project Orion detail 1',
        'Project Orion detail 2',
      ],
    );
    assert.deepEqual(memory.retrieve('private:user', 'weather', 5), []);
  });
});

test('existing explicit memory commands work through the structured service', async () => {
  await withTemporaryDatabase(async (database) => {
    const memory = createMemoryService({
      repository: createMemoryRepository(database),
    });
    const store = {
      add: (...args) => memory.add(...args),
      list: (...args) => memory.list(...args),
      delete: (...args) => memory.delete(...args),
      clear: (...args) => memory.clear(...args),
    };

    const saved = await handleMemoryCommand(
      'Friday, ingat ya aku suka teh',
      'private:user',
      store,
    );
    assert.match(saved, /simpan/);
    assert.equal(memory.list('private:user')[0].category, 'fact');
    assert.equal(memory.list('private:user')[0].source, 'explicit');

    const listed = await handleMemoryCommand(
      'apa yang kamu ingat tentang aku?',
      'private:user',
      store,
    );
    assert.match(listed, /aku suka teh/);
    await handleMemoryCommand(
      'Friday, simpan preferensi aku suka kopi',
      'private:user',
      store,
    );
    assert.equal(memory.list('private:user')[1].category, 'preference');
    const deleted = await handleMemoryCommand(
      'hapus memori 1',
      'private:user',
      store,
    );
    assert.match(deleted, /Sudah kuhapus/);
    assert.equal(memory.list('private:user').length, 1);
    assert.equal(memory.clear('private:user'), 1);
    assert.equal(memory.list('private:user').length, 0);
  });
});
