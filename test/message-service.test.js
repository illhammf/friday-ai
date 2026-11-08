import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageService } from '../src/application/message-service.js';
import {
  parseMemoryCommand,
  handleMemoryCommand,
} from '../src/ai/user-memory.js';
import {
  getSocialVideoUrls,
} from '../src/video/download-social-video.js';
import { isSocialVideoDownloadRequest } from '../src/video/video-download-request.js';

function createHarness(overrides = {}) {
  const calls = [];
  const memories = new Map();
  const dependencies = {
    botName: 'Friday',
    getReadyAt: () => 100,
    sessions: {
      privateSessionId: (id) => `private:${id}`,
      groupSessionId: (id) => `group:${id}`,
    },
    memory: {
      parseCommand: parseMemoryCommand,
      handleCommand: (text, sessionId) => handleMemoryCommand(text, sessionId, {
        add: (id, content) => {
          const items = memories.get(id) || [];
          items.push({ id: items.length + 1, content });
          memories.set(id, items);
          return { added: true, limitReached: false };
        },
        list: (id) => [...(memories.get(id) || [])],
        delete: (id, memoryId) => {
          memories.set(id, (memories.get(id) || []).filter((item) => item.id !== memoryId));
        },
        clear: (id) => {
          const count = (memories.get(id) || []).length;
          memories.set(id, []);
          return count;
        },
      }),
    },
    video: {
      getUrls: getSocialVideoUrls,
      isDownloadRequest: isSocialVideoDownloadRequest,
      download: async (url) => {
        calls.push(['downloadVideo', url]);
        return { path: '/tmp/video.mp4', cleanup: async () => calls.push(['cleanupVideo']) };
      },
      getFailureMessage: () => 'Video gagal.',
    },
    media: {
      transcribeVoiceNote: async () => 'hasil transkripsi',
    },
    sticker: {
      isRequest: (text) => /stiker/i.test(text),
      parseOptions: () => ({}),
      create: async () => ({
        path: '/tmp/sticker.webp',
        mimetype: 'image/webp',
        size: 12,
        cleanup: async () => calls.push(['cleanupSticker']),
      }),
      getFailureMessage: () => 'Stiker gagal.',
    },
    image: {
      isGenerationRequest: (text) => /buat gambar/i.test(text),
      generate: async () => ({
        mimeType: 'image/png',
        data: 'generated-image',
        text: 'Gambar selesai',
      }),
      isQuotaError: () => false,
      getQuotaDiagnostic: () => ({}),
      getFailureMessage: () => 'Gambar gagal.',
    },
    assistant: {
      ask: async (input) => {
        calls.push(['ask', input]);
        calls.push(['save', input.sharedGroupSession || input.privateSession, 'user']);
        calls.push(['save', input.sharedGroupSession || input.privateSession, 'model']);
        return 'Jawaban AI';
      },
      getFailureMessage: () => 'AI sedang bermasalah.',
    },
    audio: {
      transcribe: async () => 'hasil transkripsi',
      generate: async () => ({
        path: '/tmp/reply.ogg',
        cleanup: async () => calls.push(['cleanupVoice']),
      }),
      isQuotaError: () => false,
      getFailureMessage: (_error, answer) => answer,
    },
    history: {
      save: (...args) => calls.push(['save', ...args]),
    },
    formatMessage: (text) => text,
    deliver: {
      sendVideo: async (...args) => calls.push(['sendVideo', ...args]),
      sendSticker: async (...args) => calls.push(['sendSticker', ...args]),
      sendImage: async (...args) => calls.push(['sendImage', ...args]),
      sendVoice: async (...args) => calls.push(['sendVoice', ...args]),
    },
    logger: {
      event: (...args) => calls.push(['event', ...args]),
      error: (...args) => calls.push(['error', ...args]),
    },
  };

  for (const [key, value] of Object.entries(overrides)) {
    dependencies[key] = { ...dependencies[key], ...value };
  }

  return {
    calls,
    memories,
    service: createMessageService(dependencies),
  };
}

function createMessage(overrides = {}) {
  return {
    messageId: 'message-1',
    chatId: 'user-1@c.us',
    senderId: 'user-1@c.us',
    chatType: 'private',
    messageType: 'chat',
    text: 'Halo Friday',
    caption: '',
    timestamp: 101,
    group: null,
    media: null,
    ...overrides,
  };
}

function createMessenger(calls) {
  return {
    reply: async (text) => calls.push(['reply', text]),
  };
}

test('routes a private chat to AI with the private session and replies with formatted text', async () => {
  const { calls, service } = createHarness();

  await service.handle(createMessage(), createMessenger(calls));

  const aiCall = calls.find(([type]) => type === 'ask');
  assert.equal(aiCall[1].question, 'Halo Friday');
  assert.equal(aiCall[1].privateSession, 'private:user-1@c.us');
  assert.deepEqual(calls.find(([type]) => type === 'reply'), [
    'reply',
    'Jawaban AI',
  ]);
});

test('requires the bot prefix in groups and handles prefixed greetings', async () => {
  const { calls, service } = createHarness();

  await service.handle(createMessage({
    chatId: 'group-1@g.us',
    senderId: 'member-1@c.us',
    chatType: 'group',
    text: 'Halo semuanya',
    group: { senderName: 'Anggota grup' },
  }), createMessenger(calls));
  assert.equal(calls.some(([type]) => type === 'ask'), false);
  assert.equal(calls.some(([type]) => type === 'reply'), false);

  await service.handle(createMessage({
    messageId: 'message-2',
    chatId: 'group-1@g.us',
    senderId: 'member-1@c.us',
    chatType: 'group',
    text: 'Friday,',
    group: { senderName: 'Anggota grup' },
  }), createMessenger(calls));
  assert.deepEqual(calls.at(-1), ['reply', 'Halo! Aku Friday. Ada yang bisa kubantu?']);

  await service.handle(createMessage({
    messageId: 'message-3',
    chatId: 'group-1@g.us',
    senderId: 'member-1@c.us',
    chatType: 'group',
    text: 'Friday, bantu dong',
    group: { senderName: 'Ilham' },
  }), createMessenger(calls));
  const aiCall = calls.filter(([type]) => type === 'ask').at(-1);
  assert.equal(aiCall[1].question, 'bantu dong');
  assert.equal(aiCall[1].sharedGroupSession, 'group:group-1@g.us');
  assert.equal(aiCall[1].senderName, 'Ilham');
});

test('keeps memory commands private and scopes them to the sender private session', async () => {
  const { calls, memories, service } = createHarness();

  await service.handle(createMessage({
    chatId: 'group-1@g.us',
    senderId: 'member-1@c.us',
    chatType: 'group',
    text: 'Friday, ingat ya aku suka teh',
    group: { senderName: 'Anggota grup' },
  }), createMessenger(calls));
  assert.deepEqual(calls.at(-1), [
    'reply',
    'Memori Friday hanya tersedia di chat pribadi dan tidak disimpan dari grup. Kirim perintah memori langsung ke chat pribadi Friday, ya.',
  ]);
  assert.equal(calls.some(([type]) => type === 'ask'), false);

  await service.handle(createMessage({
    messageId: 'message-2',
    text: 'Friday, ingat ya aku suka teh',
  }), createMessenger(calls));
  assert.equal(
    calls.some(([type, text]) => type === 'reply' && /hanya dipakai di chat pribadimu/.test(text)),
    true,
  );
  assert.match(calls.filter(([type]) => type === 'reply').at(-1)[1], /aku suka teh/);
  assert.deepEqual(memories.get('private:user-1@c.us'), [
    { id: 1, content: 'aku suka teh' },
  ]);
  assert.equal(memories.has('private:member-1@c.us'), false);
});

test('downloads social videos only when the text explicitly asks for a download', async () => {
  const { calls, service } = createHarness();
  const url = 'https://www.tiktok.com/@user/video/123';

  await service.handle(createMessage({
    text: `Apa isi video ini ${url}`,
  }), createMessenger(calls));
  assert.equal(calls.some(([type]) => type === 'downloadVideo'), false);
  assert.equal(calls.some(([type]) => type === 'ask'), true);

  calls.length = 0;
  await service.handle(createMessage({
    text: `Tolong download video ini ${url}`,
  }), createMessenger(calls));
  assert.deepEqual(calls.find(([type]) => type === 'downloadVideo'), ['downloadVideo', url]);
  assert.equal(calls.some(([type]) => type === 'sendVideo'), true);
  assert.equal(calls.some(([type]) => type === 'ask'), false);
  assert.equal(calls.at(-1)[0], 'cleanupVideo');
});

test('routes sticker requests before vision AI or image generation', async () => {
  const { calls, service } = createHarness();
  const media = {
    mimetype: 'image/jpeg',
    data: 'input-image',
  };
  const message = createMessage({
    messageType: 'image',
    text: 'Friday buat gambar jadi stiker',
    media: { download: async () => media },
  });

  await service.handle(message, createMessenger(calls));

  assert.equal(calls.some(([type]) => type === 'sendSticker'), true);
  assert.equal(calls.some(([type]) => type === 'sendImage'), false);
  assert.equal(calls.some(([type]) => type === 'ask'), false);
  assert.equal(
    calls.some(([type, , role]) => type === 'save' && role === 'user'),
    true,
  );
});

test('passes ordinary incoming images to vision AI instead of image generation', async () => {
  const { calls, service } = createHarness();

  await service.handle(createMessage({
    messageType: 'image',
    text: 'Apa yang ada di foto ini?',
    media: {
      download: async () => ({
        mimetype: 'image/jpeg',
        data: 'photo-bytes',
      }),
    },
  }), createMessenger(calls));

  const aiCall = calls.find(([type]) => type === 'ask');
  assert.deepEqual(aiCall[1].image, {
    mimetype: 'image/jpeg',
    data: 'photo-bytes',
  });
  assert.equal(calls.some(([type]) => type === 'sendImage'), false);
});

test('transcribes incoming voice notes and uses the voice reply delivery path', async () => {
  const { calls, service } = createHarness();

  await service.handle(createMessage({
    messageType: 'ptt',
    text: '',
    media: { download: async () => ({ mimetype: 'audio/ogg', data: 'voice' }) },
  }), createMessenger(calls));

  const aiCall = calls.find(([type]) => type === 'ask');
  assert.equal(aiCall[1].question, 'hasil transkripsi');
  assert.equal(calls.some(([type]) => type === 'sendVoice'), true);
  assert.equal(calls.some(([type]) => type === 'reply'), false);
});

test('keeps successful AI persistence before outbound reply delivery', async () => {
  const { calls, service } = createHarness();

  await service.handle(createMessage(), createMessenger(calls));

  const userSaveIndex = calls.findIndex(([type, , role]) => type === 'save' && role === 'user');
  const modelSaveIndex = calls.findIndex(([type, , role]) => type === 'save' && role === 'model');
  const replyIndex = calls.findIndex(([type]) => type === 'reply');
  assert.ok(userSaveIndex >= 0);
  assert.ok(modelSaveIndex > userSaveIndex);
  assert.ok(replyIndex > modelSaveIndex);
});

test('saves generated-image history only after sending the image', async () => {
  const { calls, service } = createHarness();

  await service.handle(createMessage({
    text: 'Buat gambar seekor kucing',
  }), createMessenger(calls));

  const sendIndex = calls.findIndex(([type]) => type === 'sendImage');
  const saveIndex = calls.findIndex(([type]) => type === 'save');
  assert.ok(sendIndex >= 0);
  assert.ok(saveIndex > sendIndex);
  assert.equal(calls.some(([type]) => type === 'ask'), false);
});

test('uses the safe AI failure response when processing fails', async () => {
  const { calls, service } = createHarness({
    assistant: {
      ask: async () => {
        throw new Error('provider detail');
      },
    },
  });

  await service.handle(createMessage(), createMessenger(calls));

  assert.equal(calls.some(([type]) => type === 'error'), true);
  assert.deepEqual(calls.filter(([type]) => type === 'reply').at(-1), [
    'reply',
    'AI sedang bermasalah.',
  ]);
});

test('does not process messages with invalid or pre-ready timestamps', async () => {
  const { calls, service } = createHarness();

  await service.handle(createMessage({ timestamp: 0 }), createMessenger(calls));
  await service.handle(createMessage({ messageId: 'old', timestamp: 99 }), createMessenger(calls));

  assert.equal(calls.some(([type]) => type === 'ask'), false);
  assert.equal(calls.some(([type]) => type === 'reply'), false);
});
