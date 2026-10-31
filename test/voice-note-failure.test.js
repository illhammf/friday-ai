import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVoiceNoteFailureMessage,
  isVoiceNoteQuotaError,
} from '../src/audio/voice-note-failure.js';
import { getAiFailureMessage } from '../src/ai/ai-failure-message.js';

test('identifies voice-note quota errors', () => {
  assert.equal(isVoiceNoteQuotaError({ status: 429 }), true);
  assert.equal(
    isVoiceNoteQuotaError({
      message: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}',
    }),
    true,
  );
  assert.equal(isVoiceNoteQuotaError(new Error('Invalid API key')), false);
});

test('keeps provider quota details out of the WhatsApp fallback', () => {
  const error = new Error(
    'Free Tier limit is 0; retry after 16 hours at https://example.com/quota',
  );
  error.status = 429;

  const reply = getVoiceNoteFailureMessage(error, 'Ini jawaban teks.');

  assert.match(reply, /Voice Note sedang mencapai batas penggunaan/);
  assert.match(reply, /Ini jawaban teks\./);
  assert.doesNotMatch(reply, /Free Tier|16 hours|https?:\/\//);
});

test('provides a neutral WhatsApp message for non-quota voice errors', () => {
  const reply = getVoiceNoteFailureMessage(
    new Error('Temporary service error'),
    'Jawaban tetap tersedia.',
  );

  assert.match(reply, /Voice Note belum bisa dikirim saat ini/);
  assert.match(reply, /Jawaban tetap tersedia\./);
  assert.doesNotMatch(reply, /Temporary service error/);
});

test('maps chat AI service failures to clear WhatsApp-safe explanations', () => {
  assert.match(
    getAiFailureMessage({ status: 429, message: 'RESOURCE_EXHAUSTED private-detail' }),
    /AI sedang membatasi permintaan/,
  );
  assert.match(
    getAiFailureMessage({ status: 503, message: 'UNAVAILABLE private-detail' }),
    /AI sedang sibuk/,
  );
  assert.match(
    getAiFailureMessage({ status: 403, message: 'invalid API key private-detail' }),
    /Tim pengelola perlu memeriksa konfigurasi/,
  );
  for (const status of [429, 503, 403]) {
    assert.doesNotMatch(
      getAiFailureMessage({
        status,
        message: 'private-detail secret-token',
      }),
      /private-detail|secret-token|RESOURCE_EXHAUSTED|UNAVAILABLE|API key/i,
    );
  }
});
