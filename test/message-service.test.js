import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageService } from '../src/application/message-service.js';
import { createCommandRouter } from '../src/application/command-router.js';
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
    commands: createCommandRouter({ version: '1.0.0' }),
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
      saveConversationTurn: (sessionId, userText, assistantText) => {
        calls.push(['save', sessionId, 'user', userText]);
        calls.push(['save', sessionId, 'model', assistantText]);
      },
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

test('emits correlated safe stage fields without logging message or answer content', async () => {
  const stages = [];
  const { calls, service } = createHarness({
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
  });
  const message = createMessage({
    correlationId: 'correlation-test-1',
    text: 'private message sentinel',
  });

  await service.handle(message, createMessenger(calls));

  assert.ok(stages.some(({ stage, outcome }) => stage === 'message_processing' && outcome === 'started'));
  assert.ok(stages.some(({ stage, outcome }) => stage === 'ai_request' && outcome === 'completed'));
  assert.ok(stages.some(({ stage, outcome }) => stage === 'ai_response_validation' && outcome === 'succeeded'));
  assert.ok(stages.some(({ stage, outcome }) => stage === 'reply_submission' && outcome === 'submitted'));
  assert.ok(stages.some(({ stage, outcome }) => stage === 'history_persistence' && outcome === 'succeeded'));
  assert.ok(stages.every(({ correlationId }) => correlationId === 'correlation-test-1'));
  const serializedStages = JSON.stringify(stages);
  assert.equal(serializedStages.includes('private message sentinel'), false);
  assert.equal(serializedStages.includes('Jawaban AI'), false);
});

test('records an uncertain null reply result and persists only the received user message', async () => {
  const stages = [];
  const { calls, service } = createHarness({
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
  });
  await service.handle(createMessage({ correlationId: 'uncertain-1' }), {
    reply: async () => null,
  });

  assert.deepEqual(calls.filter(([type]) => type === 'save'), [
    ['save', 'private:user-1@c.us', 'user', 'Halo Friday'],
  ]);
  assert.equal(calls.some(([type]) => type === 'reply'), false);
  assert.ok(stages.some(({ stage, outcome, category }) =>
    stage === 'reply_submission' && outcome === 'uncertain' && category === 'transport_uncertain'));
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

test('known commands bypass Gemini and conversation history', async () => {
  const { calls, service } = createHarness();
  await service.handle(createMessage({ text: '  /PING  ' }), createMessenger(calls));

  assert.deepEqual(calls.filter(([type]) => type === 'reply'), [
    ['reply', 'Pong! Friday siap menerima pesan.'],
  ]);
  assert.equal(calls.some(([type]) => type === 'ask'), false);
  assert.equal(calls.some(([type]) => type === 'save'), false);
});

test('normal text continues to the existing assistant and unknown commands stay deterministic', async () => {
  const { calls, service } = createHarness();
  await service.handle(createMessage({ text: 'tolong /help ya' }), createMessenger(calls));
  assert.equal(calls.some(([type]) => type === 'ask'), true);

  calls.length = 0;
  await service.handle(createMessage({ text: '/launch arbitrary text' }), createMessenger(calls));
  assert.match(calls.find(([type]) => type === 'reply')[1], /belum tersedia/);
  assert.equal(calls.some(([type]) => type === 'ask'), false);
});

test('group commands still require the existing bot prefix', async () => {
  const { calls, service } = createHarness();
  const group = {
    chatId: 'group-1@g.us',
    senderId: 'member-1@c.us',
    chatType: 'group',
    group: { senderName: 'Anggota grup' },
  };

  await service.handle(createMessage({ ...group, text: '/ping' }), createMessenger(calls));
  assert.equal(calls.some(([type]) => type === 'reply'), false);

  await service.handle(createMessage({ ...group, text: 'Friday: /ping' }), createMessenger(calls));
  assert.deepEqual(calls.find(([type]) => type === 'reply'), [
    'reply',
    'Pong! Friday siap menerima pesan.',
  ]);
  assert.equal(calls.some(([type]) => type === 'ask'), false);
  assert.equal(calls.some(([type]) => type === 'save'), false);
});

test('command router errors receive a safe response without invoking Gemini', async () => {
  const stages = [];
  const { calls, service } = createHarness({
    commands: { route: () => { throw new Error('private diagnostic'); } },
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
  });
  await service.handle(createMessage({ text: '/ping' }), createMessenger(calls));
  assert.equal(calls.some(([type]) => type === 'ask'), false);
  assert.match(calls.find(([type]) => type === 'reply')[1], /belum bisa diproses/);
  assert.ok(stages.some(({ stage, outcome, category }) =>
    stage === 'command_router' && outcome === 'failed' && category === 'internal_error'));
});

test('failed command delivery is not retried with a second fallback message', async () => {
  const { calls, service } = createHarness();
  const transport = {
    reply: async (text) => {
      calls.push(['reply', text]);
      throw new Error('delivery status unknown');
    },
  };
  await service.handle(createMessage({ text: '/ping' }), transport);
  assert.equal(calls.filter(([type]) => type === 'reply').length, 1);
  assert.equal(calls.some(([type]) => type === 'ask'), false);
});

test('ignores whitespace-only and unsupported text messages without calling Gemini', async () => {
  const { calls, service } = createHarness();
  await service.handle(createMessage({ text: '   \n  ' }), createMessenger(calls));
  await service.handle(createMessage({
    messageId: 'unsupported',
    messageType: 'sticker',
    text: '',
  }), createMessenger(calls));
  assert.equal(calls.some(([type]) => type === 'ask'), false);
  assert.equal(calls.some(([type]) => type === 'reply'), false);
});

test('does not send a fallback after an uncertain final WhatsApp reply failure', async () => {
  const stages = [];
  const { calls, service } = createHarness({
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
  });
  const transport = {
    reply: async (text) => {
      calls.push(['reply', text]);
      throw new Error('delivery acknowledgement lost');
    },
  };
  await service.handle(createMessage(), transport);
  assert.equal(calls.filter(([type]) => type === 'reply').length, 1);
  assert.equal(calls.some(([type]) => type === 'ask'), true);
  assert.ok(stages.some(({ stage, outcome, category }) =>
    stage === 'reply_submission' && outcome === 'uncertain' && category === 'transport_uncertain'));
  assert.deepEqual(calls.filter(([type]) => type === 'save'), [
    ['save', 'private:user-1@c.us', 'user', 'Halo Friday'],
  ]);
});

test('persists a received user message once when WhatsApp reply resolves undefined', async () => {
  const { calls, service } = createHarness();
  await service.handle(createMessage(), { reply: async () => undefined });

  assert.deepEqual(calls.filter(([type]) => type === 'save'), [
    ['save', 'private:user-1@c.us', 'user', 'Halo Friday'],
  ]);
  assert.equal(calls.some(([type, , role]) => type === 'save' && role === 'model'), false);
});

test('does not send a text fallback after uncertain video delivery', async () => {
  const { calls, service } = createHarness({
    video: {
      getUrls: () => ['https://video.example/item'],
      isDownloadRequest: () => true,
    },
    deliver: {
      sendVideo: async () => {
        calls.push(['sendVideo']);
        throw new Error('video send outcome unknown');
      },
    },
  });

  await service.handle(createMessage({ text: 'unduh video' }), createMessenger(calls));

  assert.equal(calls.some(([type]) => type === 'sendVideo'), true);
  assert.equal(calls.some(([type]) => type === 'reply'), false);
  assert.deepEqual(calls.filter(([type]) => type === 'save'), [
    ['save', 'private:user-1@c.us', 'user', 'unduh video'],
  ]);
});

test('does not send a fallback after uncertain sticker delivery', async () => {
  const { calls, service } = createHarness({
    deliver: {
      sendSticker: async () => {
        calls.push(['sendSticker']);
        throw new Error('sticker send outcome unknown');
      },
    },
  });
  const message = createMessage({
    messageType: 'image',
    text: 'stiker',
    media: { download: async () => ({ mimetype: 'image/jpeg', data: 'image' }) },
  });

  await service.handle(message, createMessenger(calls));

  assert.equal(calls.some(([type]) => type === 'sendSticker'), true);
  assert.equal(calls.some(([type]) => type === 'reply'), false);
  assert.deepEqual(calls.filter(([type]) => type === 'save'), [
    ['save', 'private:user-1@c.us', 'user', 'stiker'],
  ]);
});

test('does not resend an uncertain Voice Note answer as text', async () => {
  const { calls, service } = createHarness({
    deliver: {
      sendVoice: async () => {
        calls.push(['sendVoice']);
        throw new Error('voice send outcome unknown');
      },
    },
  });
  const message = createMessage({
    messageType: 'ptt',
    text: '',
    media: { download: async () => ({ mimetype: 'audio/ogg', data: 'voice' }) },
  });

  await service.handle(message, createMessenger(calls));

  assert.equal(calls.some(([type]) => type === 'sendVoice'), true);
  assert.equal(calls.some(([type]) => type === 'reply'), false);
  assert.deepEqual(calls.filter(([type]) => type === 'save'), [
    ['save', 'private:user-1@c.us', 'user', 'hasil transkripsi'],
  ]);
});

test('persists inbound text but not assistant text when WhatsApp resolves without a sent-message result', async () => {
  const stages = [];
  const { calls, service } = createHarness({
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
  });
  const transport = {
    reply: async (text) => {
      calls.push(['reply', text]);
      return undefined;
    },
  };
  await service.handle(createMessage(), transport);
  assert.equal(calls.filter(([type]) => type === 'reply').length, 1);
  assert.deepEqual(calls.filter(([type]) => type === 'save'), [
    ['save', 'private:user-1@c.us', 'user', 'Halo Friday'],
  ]);
  assert.ok(stages.some(({ stage, outcome, category }) =>
    stage === 'reply_submission' && outcome === 'uncertain' && category === 'transport_uncertain'));
});

test('does not retry a delivered answer when conversation history persistence fails', async () => {
  const stages = [];
  const { calls, service } = createHarness({
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
    history: {
      saveConversationTurn: () => {
        throw new Error('database write failed');
      },
    },
  });
  await service.handle(createMessage(), createMessenger(calls));
  assert.deepEqual(calls.filter(([type]) => type === 'reply'), [
    ['reply', 'Jawaban AI'],
  ]);
  assert.equal(calls.some(([type]) => type === 'ask'), true);
  assert.ok(stages.some(({ stage, outcome, category }) =>
    stage === 'history_persistence' && outcome === 'failed' && category === 'persistence_error'));
});

test('stores group turns only in the shared group conversation session', async () => {
  const { calls, service } = createHarness();
  await service.handle(createMessage({
    chatId: 'group-1@g.us',
    senderId: 'member-1@c.us',
    chatType: 'group',
    text: 'Friday, jelaskan ini',
    group: { senderName: 'Ari' },
  }), createMessenger(calls));

  const userSave = calls.find(([type, , role]) => type === 'save' && role === 'user');
  const modelSave = calls.find(([type, , role]) => type === 'save' && role === 'model');
  assert.deepEqual(userSave.slice(1), [
    'group:group-1@g.us', 'user', 'Ari: jelaskan ini',
  ]);
  assert.deepEqual(modelSave.slice(1), [
    'group:group-1@g.us', 'model', 'Jawaban AI',
  ]);
});

test('keeps a group request from blocking the same sender private conversation', async () => {
  let releaseGroupAnswer;
  const groupAnswer = new Promise((resolve) => { releaseGroupAnswer = resolve; });
  const aiCalls = [];
  const stages = [];
  const { calls, service } = createHarness({
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
    assistant: {
      ask: async (input) => {
        aiCalls.push(input);
        if (input.sharedGroupSession) await groupAnswer;
        return input.sharedGroupSession ? 'Jawaban grup' : 'Jawaban pribadi';
      },
    },
  });

  const groupProcessing = service.handle(createMessage({
    messageId: 'group-message',
    correlationId: 'group-correlation',
    chatId: 'group-1@g.us',
    senderId: 'member-1@c.us',
    chatType: 'group',
    text: 'Friday, pertanyaan grup',
    group: { senderName: 'Ari' },
  }), createMessenger(calls));

  // Let the first request acquire its session lock before starting the other.
  await new Promise((resolve) => setImmediate(resolve));
  await service.handle(createMessage({
    messageId: 'private-message',
    correlationId: 'private-correlation',
    text: 'pertanyaan pribadi',
  }), createMessenger(calls));

  assert.equal(aiCalls.length, 2);
  assert.equal(aiCalls[0].sharedGroupSession, 'group:group-1@g.us');
  assert.equal(aiCalls[1].sharedGroupSession, null);
  assert.ok(stages.filter(({ correlationId }) => correlationId === 'group-correlation').length > 0);
  assert.ok(stages.filter(({ correlationId }) => correlationId === 'private-correlation').length > 0);
  assert.ok(stages.every(({ correlationId }) =>
    correlationId === 'group-correlation' || correlationId === 'private-correlation'));
  assert.ok(calls.some(([type, text]) => type === 'reply' && text === 'Jawaban pribadi'));

  releaseGroupAnswer();
  await groupProcessing;
  assert.ok(calls.some(([type, text]) => type === 'reply' && text === 'Jawaban grup'));
});

test('rejects an oversized formatted assistant reply while preserving only the received input', async () => {
  const { calls, service } = createHarness({
    assistant: { ask: async () => 'x'.repeat(32 * 1024) },
    formatMessage: () => 'x'.repeat(32 * 1024 + 1),
  });
  await service.handle(createMessage(), createMessenger(calls));
  assert.deepEqual(calls.filter(([type]) => type === 'reply'), [
    ['reply', 'AI sedang bermasalah.'],
  ]);
  assert.deepEqual(calls.filter(([type]) => type === 'save'), [
    ['save', 'private:user-1@c.us', 'user', 'Halo Friday'],
  ]);
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

test('persists an assistant turn atomically after outbound reply delivery', async () => {
  const { calls, service } = createHarness();

  await service.handle(createMessage(), createMessenger(calls));

  const userSaveIndex = calls.findIndex(([type, , role]) => type === 'save' && role === 'user');
  const modelSaveIndex = calls.findIndex(([type, , role]) => type === 'save' && role === 'model');
  const replyIndex = calls.findIndex(([type]) => type === 'reply');
  assert.ok(replyIndex >= 0);
  assert.ok(userSaveIndex > replyIndex);
  assert.ok(modelSaveIndex > userSaveIndex);
  assert.deepEqual(calls[userSaveIndex].slice(1), [
    'private:user-1@c.us', 'user', 'Halo Friday',
  ]);
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

test('preserves only the generated-image request when WhatsApp returns no message result', async () => {
  const stages = [];
  const { calls, service } = createHarness({
    deliver: { sendImage: async () => undefined },
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
  });
  await service.handle(createMessage({ text: 'Buat gambar seekor kucing' }), createMessenger(calls));
  assert.equal(calls.some(([type]) => type === 'sendImage'), false);
  assert.deepEqual(calls.filter(([type]) => type === 'save'), [
    ['save', 'private:user-1@c.us', 'user', 'Buat gambar seekor kucing'],
  ]);
  assert.ok(stages.some(({ stage, outcome, category }) =>
    stage === 'image_submission' && outcome === 'uncertain' && category === 'transport_uncertain'));
});

test('uses the safe AI failure response when processing fails', async () => {
  const stages = [];
  const { calls, service } = createHarness({
    logger: { stage: (stage, fields) => stages.push({ stage, ...fields }) },
    assistant: {
      ask: async () => {
        throw new Error('provider detail');
      },
    },
  });

  await service.handle(createMessage(), createMessenger(calls));

  assert.ok(stages.some(({ stage, outcome, category }) =>
    stage === 'ai_request' && outcome === 'failed' && category === 'provider_error'));
  assert.deepEqual(calls.filter(([type]) => type === 'save'), [
    ['save', 'private:user-1@c.us', 'user', 'Halo Friday'],
  ]);
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
