import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyUnsupportedAction,
  getUnsupportedActionResponse,
  isVoiceResponseRequest,
} from '../src/ai/action-intent.js';

test('recognizes voice response requests without confusing explanations with progress', () => {
  assert.equal(isVoiceResponseRequest('Jelaskan apa itu Git Clone pakai VN yaa'), true);
  assert.equal(isVoiceResponseRequest('Apa itu voice note?'), true);
  assert.equal(isVoiceResponseRequest('Jelaskan Git Clone'), false);
});

test('classifies unsupported actions but leaves how-to questions for the assistant', () => {
  assert.equal(classifyUnsupportedAction('Friday leave aja dari grup'), 'leave_group');
  assert.equal(classifyUnsupportedAction('Friday hapus file itu'), 'delete_file');
  assert.equal(classifyUnsupportedAction('Friday kirim pesan ke dia'), 'send_message');
  assert.equal(classifyUnsupportedAction('Bagaimana cara leave grup?'), null);
});

test('returns honest, non-executing action responses', () => {
  const response = getUnsupportedActionResponse('leave_group', { playful: true });
  assert.match(response, /nggak bisa leave grup/i);
  assert.match(response, /kamu/i);
});
