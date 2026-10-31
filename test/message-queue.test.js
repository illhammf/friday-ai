import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMessageQueue,
  isQueueableMessage,
} from '../src/whatsapp/message-queue.js';

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('processes messages from the same chat in order', async () => {
  const queue = createMessageQueue();
  const gate = createDeferred();
  const calls = [];

  const first = queue.enqueue('chat-1', async () => {
    calls.push('first-start');
    await gate.promise;
    calls.push('first-end');
  });
  const second = queue.enqueue('chat-1', async () => {
    calls.push('second');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['first-start']);

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['first-start', 'first-end', 'second']);
});

test('limits queued messages and resumes after task failures', async () => {
  const queue = createMessageQueue({ maxPending: 1 });
  const gate = createDeferred();
  const first = queue.enqueue('chat-1', () => gate.promise);
  const second = queue.enqueue('chat-1', async () => 'second');

  assert.equal(queue.enqueue('chat-1', async () => 'overflow'), null);
  gate.resolve();
  await Promise.all([first, second]);

  const failed = queue.enqueue('chat-1', async () => {
    throw new Error('task failed');
  });
  const afterFailure = queue.enqueue('chat-1', async () => 'recovered');

  await assert.rejects(failed, /task failed/);
  assert.equal(await afterFailure, 'recovered');
});

test('processes separate chats independently', async () => {
  const queue = createMessageQueue();
  const gate = createDeferred();
  const first = queue.enqueue('chat-1', () => gate.promise);
  let secondRan = false;
  const second = queue.enqueue('chat-2', async () => {
    secondRan = true;
  });

  await second;
  assert.equal(secondRan, true);
  gate.resolve();
  await first;
});

test('only queues supported private messages and Friday-addressed group messages', () => {
  assert.equal(
    isQueueableMessage(
      { from: '123@c.us', type: 'chat', body: 'Halo' },
      'Friday',
    ),
    true,
  );
  assert.equal(
    isQueueableMessage(
      { from: '123@c.us', type: 'image', body: '' },
      'Friday',
    ),
    true,
  );
  assert.equal(
    isQueueableMessage(
      { from: '123@g.us', type: 'chat', body: 'Friday, bantu dong' },
      'Friday',
    ),
    true,
  );
  assert.equal(
    isQueueableMessage(
      { from: '123@g.us', type: 'chat', body: 'Halo semua' },
      'Friday',
    ),
    false,
  );
  assert.equal(
    isQueueableMessage(
      { from: '123@c.us', type: 'chat', body: 'Halo', fromMe: true },
      'Friday',
    ),
    false,
  );
  assert.equal(
    isQueueableMessage(
      { from: '123@c.us', type: 'video', body: '' },
      'Friday',
    ),
    false,
  );
});
