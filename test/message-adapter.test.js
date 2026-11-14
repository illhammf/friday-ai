import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createWhatsAppAdapters,
  normalizeWhatsAppMessage,
  registerQueuedMessageHandler,
} from '../src/whatsapp/message-adapter.js';
import {
  createMessageDeduplicator,
  createMessageQueue,
  getMessageDeduplicationKey,
  isQueueableMessage,
} from '../src/whatsapp/message-queue.js';
import { createMessageService } from '../src/application/message-service.js';

function createRawMessage(overrides = {}) {
  return {
    id: { _serialized: 'false_100@c.us_message-1' },
    from: '100@c.us',
    author: undefined,
    type: 'chat',
    body: '  Hello Friday  ',
    timestamp: 123,
    hasMedia: false,
    _data: {},
    reply: async (text) => text,
    ...overrides,
  };
}

test('normalizes private and group text messages and preserves IDs and sender metadata', () => {
  const downloadMedia = async () => null;
  const privateMessage = normalizeWhatsAppMessage(
    createRawMessage(),
    downloadMedia,
  );
  assert.deepEqual(privateMessage, {
    messageId: 'false_100@c.us_message-1',
    chatId: '100@c.us',
    senderId: '100@c.us',
    chatType: 'private',
    messageType: 'chat',
    text: 'Hello Friday',
    caption: '',
    timestamp: 123,
    group: null,
    media: null,
  });

  const groupMessage = normalizeWhatsAppMessage(
    createRawMessage({
      from: 'room@g.us',
      author: 'member@c.us',
      body: 'Friday, help',
      _data: { notifyName: 'Member Name' },
    }),
    downloadMedia,
  );
  assert.equal(groupMessage.chatId, 'room@g.us');
  assert.equal(groupMessage.senderId, 'member@c.us');
  assert.equal(groupMessage.chatType, 'group');
  assert.deepEqual(groupMessage.group, { senderName: 'Member Name' });
});

test('normalizes images with captions, voice notes, and videos', () => {
  const downloadMedia = async () => null;
  const image = normalizeWhatsAppMessage(
    createRawMessage({
      type: 'image',
      body: '  Caption text  ',
      hasMedia: true,
      _data: { mimetype: 'image/jpeg', size: 12 },
    }),
    downloadMedia,
  );
  assert.equal(image.messageType, 'image');
  assert.equal(image.text, 'Caption text');
  assert.equal(image.caption, 'Caption text');
  assert.equal(image.media.diagnostics.mimetype, 'image/jpeg');

  const voice = normalizeWhatsAppMessage(
    createRawMessage({ type: 'ptt', body: '', hasMedia: true }),
    downloadMedia,
  );
  assert.equal(voice.messageType, 'ptt');
  assert.equal(voice.text, '');
  assert.equal(typeof voice.media.download, 'function');

  const video = normalizeWhatsAppMessage(
    createRawMessage({ type: 'video', body: 'video caption', hasMedia: true }),
    downloadMedia,
  );
  assert.equal(video.messageType, 'video');
  assert.equal(video.caption, '');
  assert.equal(typeof video.media.download, 'function');
});

test('handles missing optional metadata, invalid IDs, and invalid messages safely', () => {
  const missing = normalizeWhatsAppMessage(
    createRawMessage({
      id: undefined,
      timestamp: undefined,
      from: 'room@g.us',
      author: undefined,
      _data: undefined,
    }),
    async () => null,
  );
  assert.equal(missing.messageId, null);
  assert.equal(Number.isNaN(missing.timestamp), true);
  assert.deepEqual(missing.group, { senderName: 'Anggota grup' });
  assert.equal(missing.media, null);

  assert.equal(normalizeWhatsAppMessage(null, async () => null), null);
  assert.equal(normalizeWhatsAppMessage({}, async () => null), null);
  const invalidFields = normalizeWhatsAppMessage(
    createRawMessage({
      id: { fromMe: false, remote: '100@c.us', id: 'legacy-id' },
      body: 42,
      timestamp: Symbol('invalid'),
      type: undefined,
    }),
    async () => null,
  );
  assert.equal(invalidFields.messageId, 'false_100@c.us_legacy-id');
  assert.equal(invalidFields.text, '');
  assert.equal(invalidFields.messageType, 'unknown');
  assert.equal(Number.isNaN(invalidFields.timestamp), true);
});

test('delegates media download within the adapter without passing raw SDK data to consumers', async () => {
  const raw = createRawMessage({
    type: 'image',
    hasMedia: true,
    _data: { mimetype: 'image/png', secretSdkField: 'not copied' },
  });
  let downloadedMessage;
  const adapters = createWhatsAppAdapters({
    client: { sendMessage: async () => {} },
    MessageMedia: class {},
    downloadMedia: async (message) => {
      downloadedMessage = message;
      return { mimetype: 'image/png', data: 'bytes' };
    },
    readStickerData: async () => Buffer.from('sticker'),
  });

  const normalized = adapters.normalize(raw);
  assert.equal(normalized.raw, undefined);
  assert.equal(normalized.secretSdkField, undefined);
  assert.equal(normalized.media.diagnostics.secretSdkField, undefined);
  assert.deepEqual(await normalized.media.download(), {
    mimetype: 'image/png',
    data: 'bytes',
  });
  assert.equal(downloadedMessage, raw);
});

test('adapts replies and all currently implemented outbound media types', async () => {
  const calls = [];
  class FakeMessageMedia {
    constructor(mimetype, data, filename, filesize) {
      Object.assign(this, { mimetype, data, filename, filesize });
    }

    static fromFilePath(path) {
      return { path };
    }
  }
  const client = {
    sendMessage: async (...args) => {
      calls.push(args);
      return { sent: true };
    },
  };
  const adapters = createWhatsAppAdapters({
    client,
    MessageMedia: FakeMessageMedia,
    downloadMedia: async () => null,
    readStickerData: async (path) => Buffer.from(path),
  });

  const replyCall = [];
  const reply = adapters.reply({
    reply: async (text) => {
      replyCall.push(text);
      return 'reply-sent';
    },
  });
  assert.equal(await reply('Hello'), 'reply-sent');
  assert.deepEqual(replyCall, ['Hello']);

  await adapters.deliver.sendVideo(
    'chat@c.us',
    { path: '/tmp/video.mp4' },
    'video caption',
  );
  await adapters.deliver.sendImage(
    'chat@c.us',
    { mimeType: 'image/jpeg', data: 'image-bytes' },
    'image caption',
  );
  await adapters.deliver.sendSticker(
    'chat@c.us',
    { path: '/tmp/sticker.webp', mimetype: 'image/webp', size: 7 },
    'Friday',
  );
  await adapters.deliver.sendVoice('chat@c.us', '/tmp/voice.ogg');

  assert.deepEqual(calls, [
    ['chat@c.us', { path: '/tmp/video.mp4' }, { caption: 'video caption' }],
    [
      'chat@c.us',
      new FakeMessageMedia('image/jpeg', 'image-bytes', 'friday-generated.jpg'),
      { caption: 'image caption' },
    ],
    [
      'chat@c.us',
      new FakeMessageMedia(
        'image/webp',
        Buffer.from('/tmp/sticker.webp'),
        'friday-sticker.webp',
        7,
      ),
      {
        sendMediaAsSticker: true,
        stickerName: 'Friday',
        stickerAuthor: 'Friday AI',
      },
    ],
    [
      'chat@c.us',
      { path: '/tmp/voice.ogg' },
      { sendAudioAsVoice: true },
    ],
  ]);
});

test('propagates outbound WhatsApp client failures to the application caller', async () => {
  const deliveryError = new Error('WhatsApp send failed');
  const adapters = createWhatsAppAdapters({
    client: { sendMessage: async () => { throw deliveryError; } },
    MessageMedia: class {
      static fromFilePath(path) {
        return { path };
      }
    },
    downloadMedia: async () => null,
    readStickerData: async () => Buffer.alloc(0),
  });

  await assert.rejects(
    adapters.deliver.sendVoice('chat@c.us', '/tmp/voice.ogg'),
    (error) => error === deliveryError,
  );
});

function createService(calls) {
  return createMessageService({
    botName: 'Friday',
    getReadyAt: () => 100,
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
      getFailureMessage: () => 'Video failure',
    },
    sticker: {
      isRequest: (text) => /stik|sticker/i.test(text),
      parseOptions: () => ({}),
      create: async () => ({
        path: '/tmp/sticker.webp',
        mimetype: 'image/webp',
        size: 10,
        cleanup: async () => {},
      }),
      getFailureMessage: () => 'Sticker failure',
    },
    image: {
      isGenerationRequest: () => false,
      generate: async () => null,
      isQuotaError: () => false,
      getQuotaDiagnostic: () => '',
      getFailureMessage: () => 'Image failure',
    },
    assistant: {
      ask: async (input) => {
        calls.push(['assistant', input]);
        return 'assistant reply';
      },
      getFailureMessage: () => 'AI failure',
    },
    audio: {
      transcribe: async () => 'voice transcript',
      generate: async () => ({ path: '/tmp/voice.ogg', cleanup: async () => {} }),
      isQuotaError: () => false,
      getFailureMessage: (_error, answer) => answer,
    },
    history: {
      save: (_session, role) => calls.push(['persist', role]),
      saveConversationTurn: (_session, userText, assistantText) => {
        calls.push(['persist', 'user', userText]);
        calls.push(['persist', 'model', assistantText]);
      },
    },
    formatMessage: (text) => text,
    deliver: {
      sendVideo: async () => {},
      sendSticker: async (...args) => calls.push(['sendSticker', ...args]),
      sendImage: async () => {},
      sendVoice: async (...args) => calls.push(['sendVoice', ...args]),
    },
    logger: {
      event: () => {},
      error: (label, error) => calls.push(['error', label, error?.message]),
    },
  });
}

test('integrates event queue, deduplication, normalization, service, and reply adapter', async () => {
  const client = new EventEmitter();
  const queue = createMessageQueue();
  const deduplicator = createMessageDeduplicator();
  const calls = [];
  const stages = [];
  const service = createService(calls);
  let accepted = true;

  registerQueuedMessageHandler(client, {
    botName: 'Friday',
    canAccept: () => accepted,
    isQueueableMessage,
    getDeduplicationKey: getMessageDeduplicationKey,
    deduplicator,
    queue,
    normalize: (message) => normalizeWhatsAppMessage(
      message,
      async () => null,
    ),
    handle: (message, transport) => service.handle(message, transport),
    reply: (message) => (text) => {
      calls.push(['reply', text]);
      return message.reply(text);
    },
    logger: {
      log: () => {},
      error: (...args) => calls.push(['error', ...args]),
      stage: (stage, fields) => stages.push({ stage, ...fields }),
    },
  });

  const privateMessage = createRawMessage();
  client.emit('message', privateMessage);
  client.emit('message', privateMessage);

  const unaddressedGroup = createRawMessage({
    id: { _serialized: 'group-message-1' },
    from: 'room@g.us',
    author: 'member@c.us',
    body: 'Please help',
  });
  client.emit('message', unaddressedGroup);

  const addressedGroup = createRawMessage({
    id: { _serialized: 'group-message-2' },
    from: 'room@g.us',
    author: 'member@c.us',
    body: 'Friday, help',
    _data: { notifyName: 'Member' },
  });
  client.emit('message', addressedGroup);

  accepted = false;
  client.emit('message', createRawMessage({
    id: { _serialized: 'ignored-while-stopping' },
  }));
  accepted = true;

  await queue.drain();

  const assistantCalls = calls
    .filter(([kind]) => kind === 'assistant')
    .map(([, input]) => input);
  assert.equal(assistantCalls.length, 2);
  assert.ok(assistantCalls.some(({ question }) => question === 'Hello Friday'));
  const groupCall = assistantCalls.find(({ sharedGroupSession }) => sharedGroupSession);
  assert.equal(groupCall.question, 'help');
  assert.equal(groupCall.sharedGroupSession, 'group:room@g.us');
  assert.deepEqual(calls.filter(([kind]) => kind === 'persist'), [
    ['persist', 'user', 'Hello Friday'],
    ['persist', 'model', 'assistant reply'],
    ['persist', 'user', 'Member: help'],
    ['persist', 'model', 'assistant reply'],
  ], JSON.stringify(calls));
  assert.deepEqual(calls.filter(([kind]) => kind === 'reply'), [
    ['reply', 'assistant reply'],
    ['reply', 'assistant reply'],
  ]);
  const replyIndexes = calls
    .map(([kind], index) => kind === 'reply' ? index : -1)
    .filter((index) => index >= 0);
  const persistIndexes = calls
    .map(([kind], index) => kind === 'persist' ? index : -1)
    .filter((index) => index >= 0);
  assert.ok(replyIndexes[0] < persistIndexes[0]);
  assert.ok(replyIndexes[1] < persistIndexes[2]);
  const acceptedStages = stages.filter(({ stage, outcome }) =>
    stage === 'message_received' && outcome === 'accepted');
  assert.equal(acceptedStages.length, 2);
  const correlationIds = new Set(acceptedStages.map(({ correlationId }) => correlationId));
  assert.equal(correlationIds.size, 2);
  assert.ok(stages.some(({ stage, outcome, correlationId }) =>
    stage === 'message_processing_started' && outcome === 'started' && correlationIds.has(correlationId)));
  assert.equal(JSON.stringify(stages).includes('Hello Friday'), false);
});

test('logs correlated queue task failures without message identifiers', async () => {
  const client = new EventEmitter();
  const queue = createMessageQueue();
  const stages = [];
  registerQueuedMessageHandler(client, {
    botName: 'Friday',
    isQueueableMessage,
    getDeduplicationKey: getMessageDeduplicationKey,
    deduplicator: createMessageDeduplicator(),
    queue,
    normalize: () => ({ chatId: 'private-id', text: 'secret body' }),
    handle: async () => { throw new Error('private diagnostic'); },
    reply: () => async () => ({ id: 'outgoing' }),
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
  });

  client.emit('message', createRawMessage());
  await queue.drain();

  const accepted = stages.find(({ stage, outcome }) =>
    stage === 'message_received' && outcome === 'accepted');
  const failed = stages.find(({ stage }) => stage === 'queue_processing');
  assert.ok(accepted);
  assert.equal(failed.correlationId, accepted.correlationId);
  assert.equal(failed.category, 'internal_error');
  assert.equal(JSON.stringify(stages).includes('secret body'), false);
  assert.equal(JSON.stringify(stages).includes('private-id'), false);
});

test('records queue-full notice transport uncertainty even when reply throws synchronously', async () => {
  const client = new EventEmitter();
  const stages = [];
  registerQueuedMessageHandler(client, {
    botName: 'Friday',
    isQueueableMessage,
    getDeduplicationKey: getMessageDeduplicationKey,
    deduplicator: createMessageDeduplicator(),
    queue: { enqueue: () => null },
    normalize: () => null,
    handle: async () => {},
    reply: () => () => { throw new Error('transport uncertain'); },
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
  });

  client.emit('message', createRawMessage());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(stages.some(({ stage, outcome, category }) =>
    stage === 'queue_full_notice_submission' && outcome === 'uncertain' && category === 'transport_uncertain'));
});

test('integrates incoming image vision, sticker priority, and voice-note delivery', async () => {
  const client = new EventEmitter();
  const queue = createMessageQueue();
  const deduplicator = createMessageDeduplicator();
  const calls = [];
  const service = createService(calls);
  const mediaCalls = [];
  const mediaByMessage = new Map([
    ['image-message', { mimetype: 'image/jpeg', data: 'photo-bytes' }],
    ['sticker-message', { mimetype: 'image/png', data: 'sticker-source' }],
    ['voice-message', { mimetype: 'audio/ogg', data: 'voice-bytes' }],
  ]);
  const adapters = createWhatsAppAdapters({
    client: { sendMessage: async () => {} },
    MessageMedia: class {},
    downloadMedia: async (message) => {
      mediaCalls.push(message.id._serialized);
      return mediaByMessage.get(message.id._serialized);
    },
    readStickerData: async () => Buffer.from('sticker-bytes'),
  });

  registerQueuedMessageHandler(client, {
    botName: 'Friday',
    isQueueableMessage,
    getDeduplicationKey: getMessageDeduplicationKey,
    deduplicator,
    queue,
    normalize: adapters.normalize,
    handle: (message, transport) => service.handle(message, transport),
    reply: adapters.reply,
    logger: { log: () => {}, error: (...args) => calls.push(['error', ...args]) },
  });

  const makeMediaMessage = (id, type, body) => createRawMessage({
    id: { _serialized: id },
    type,
    body,
    hasMedia: true,
  });

  client.emit(
    'message',
    makeMediaMessage('image-message', 'image', 'What is in this photo?'),
  );
  client.emit(
    'message',
    makeMediaMessage('sticker-message', 'image', 'Friday make a sticker'),
  );
  client.emit('message', makeMediaMessage('voice-message', 'ptt', ''));

  await queue.drain();

  const aiInputs = calls
    .filter(([kind]) => kind === 'assistant')
    .map(([, input]) => input);
  assert.equal(aiInputs.length, 2);
  assert.ok(aiInputs.some(({ image }) => image?.data === 'photo-bytes'));
  assert.ok(aiInputs.some(({ question }) => question === 'voice transcript'));
  assert.deepEqual(mediaCalls.sort(), [
    'image-message',
    'sticker-message',
    'voice-message',
  ]);
  assert.equal(calls.some(([kind]) => kind === 'sendSticker'), true);
  assert.equal(calls.some(([kind]) => kind === 'sendVoice'), true);
  assert.equal(
    calls.filter(([kind]) => kind === 'sendSticker').length,
    1,
  );
});
