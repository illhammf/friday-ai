import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVoiceNoteFailureMessage,
  isVoiceNoteQuotaError,
} from '../src/audio/voice-note-failure.js';

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
