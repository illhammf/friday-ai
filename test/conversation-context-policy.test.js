import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isShortNonSubstantiveMessage,
  selectConversationContext,
} from '../src/ai/conversation-context-policy.js';
import { buildConversationContents } from '../src/ai/conversation-context.js';

const entry = (role, text) => ({ role, parts: [{ text }] });

test('keeps recent Dart facts and excludes unrelated older sticker/voice context', () => {
  const history = [
    entry('user', 'Tolong buatkan stiker dari foto ini.'),
    entry('model', 'Baik, aku bantu membuat stiker.'),
    entry('user', 'Balas voice note dengan gaya santai.'),
    entry('model', 'Baik.'),
    entry('user', 'Hari ini aku sedang belajar Dart dan ingin memahami konsep variabel.'),
    entry('model', 'Dart memiliki variabel dengan tipe yang dapat diinferensikan.'),
    entry('user', 'Menurutmu, apa topik yang sedang aku pelajari?'),
    entry('model', 'Kamu sedang belajar Dart dan variabel.'),
  ];
  const selected = selectConversationContext(history, 'Sebutkan kembali dua hal yang aku ceritakan sebelumnya.');
  assert.deepEqual(selected.history, history.slice(-4));
  const request = buildConversationContents({
    systemInstruction: 'grounding',
    question: 'Sebutkan kembali dua hal yang aku ceritakan sebelumnya.',
    history: selected.history,
  });
  const serialized = JSON.stringify(request.contents);
  assert.match(serialized, /Dart/);
  assert.doesNotMatch(serialized, /stiker|voice note/i);
});

test('preserves chronological order and current message appears once', () => {
  const selected = selectConversationContext([
    entry('user', 'Fakta lama tentang Dart.'),
    entry('user', 'Aku belajar Dart.'),
    entry('user', 'Aku ingin memahami variabel.'),
  ], 'Apa dua hal yang aku ceritakan?');
  const request = buildConversationContents({
    systemInstruction: 'grounding',
    question: 'Apa dua hal yang aku ceritakan?',
    history: selected.history,
  });
  assert.deepEqual(request.contents.at(-1).parts.map((part) => part.text), [
    'Fakta lama tentang Dart.',
    'Aku belajar Dart.',
    'Aku ingin memahami variabel.',
    'Apa dua hal yang aku ceritakan?',
  ]);
  const allText = JSON.stringify(request.contents);
  assert.equal((allText.match(/Apa dua hal yang aku ceritakan/g) || []).length, 1);
});

test('does not select unrelated earlier entries when the recent window is sufficient', () => {
  const selected = selectConversationContext([
    entry('user', 'stiker foto'),
    entry('model', 'voice note'),
    entry('user', 'Aku belajar Dart.'),
    entry('model', 'Kamu belajar Dart.'),
  ], 'Apa yang aku pelajari?');
  assert.equal(selected.relevantEarlierCount, 0);
  assert.equal(selected.excludedEarlierCount, 0);
});

test('short acknowledgments do not inherit old context or retrieved-memory cues', () => {
  assert.equal(isShortNonSubstantiveMessage('Tes'), true);
  assert.equal(isShortNonSubstantiveMessage('Halo'), true);
  assert.equal(isShortNonSubstantiveMessage('Tolong jelaskan Dart'), false);
  const selected = selectConversationContext([
    entry('user', 'Aku sedang belajar Dart.'),
    entry('model', 'Penjelasan lama.'),
  ], 'Tes');
  assert.deepEqual(selected.history, []);
  assert.equal(selected.excludedEarlierCount, 2);
});

test('generic recall wording does not select an old exchange by generic overlap alone', () => {
  const selected = selectConversationContext([
    entry('user', 'Aku sedang meminta bantuan umum.'),
    entry('model', 'Baik, aku bantu.'),
    entry('user', 'Percakapan lama yang tidak terkait.'),
    entry('model', 'Baik.'),
    entry('user', 'Aku belajar Dart dan variabel.'),
    entry('model', 'Dart dan variabel.'),
  ], 'Sebutkan kembali dua hal yang aku ceritakan sebelumnya.');
  assert.deepEqual(selected.history, [
    entry('user', 'Percakapan lama yang tidak terkait.'),
    entry('model', 'Baik.'),
    entry('user', 'Aku belajar Dart dan variabel.'),
    entry('model', 'Dart dan variabel.'),
  ]);
  assert.equal(selected.relevantEarlierCount, 0);
});
