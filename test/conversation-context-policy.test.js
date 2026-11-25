import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isConversationCorrection,
  isExplicitTopicSwitch,
  isIdentityQuestion,
  isPreviousTopicRecallQuestion,
  isOpenTopicQuestion,
  isRecentHistoryQuestion,
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

test('explicit topic switch starts a clean active-topic context', () => {
  assert.equal(isExplicitTopicSwitch('Sekarang kita bahas Java, aku belajar Inheritance'), true);
  const selected = selectConversationContext([
    entry('user', 'Aku sedang belajar Dart variables.'),
    entry('model', 'Penjelasan Dart.'),
    entry('user', 'Siapa nama dosen yang tadi aku berikan?'),
    entry('model', 'Informasi dosen belum tersedia.'),
  ], 'Sekarang kita bahas Java, aku sedang belajar Inheritance.');
  assert.deepEqual(selected.history, []);
  assert.equal(selected.topicSwitch, true);
  const request = buildConversationContents({
    systemInstruction: 'grounding',
    question: 'Sekarang kita bahas Java, aku sedang belajar Inheritance.',
    history: selected.history,
  });
  assert.deepEqual(request.contents.map(({ parts }) => parts[0].text), [
    'Sekarang kita bahas Java, aku sedang belajar Inheritance.',
  ]);
});

test('after a switch, active-topic questions keep Java context but not old Dart context', () => {
  const selected = selectConversationContext([
    entry('user', 'Aku sedang belajar Dart variables.'),
    entry('model', 'Penjelasan Dart.'),
    entry('user', 'Sekarang kita bahas Java, aku sedang belajar Inheritance.'),
    entry('model', 'Inheritance adalah pewarisan class di Java.'),
  ], 'Apa topik yang sedang kita bahas sekarang?');
  assert.deepEqual(selected.history, [
    entry('user', 'Sekarang kita bahas Java, aku sedang belajar Inheritance.'),
    entry('model', 'Inheritance adalah pewarisan class di Java.'),
  ]);
});

test('explicit historical recall can still retrieve the pre-switch topic', () => {
  const selected = selectConversationContext([
    entry('user', 'Aku sedang belajar Dart variables.'),
    entry('model', 'Penjelasan Dart.'),
    entry('user', 'Sekarang kita bahas Java Inheritance.'),
    entry('model', 'Baik, kita bahas Java.'),
  ], 'Apa yang aku pelajari sebelum Java?');
  assert.match(JSON.stringify(selected.history), /Dart/);
});

test('classifies identity, open-topic, recent-recall, and stretched short messages', () => {
  assert.equal(isShortNonSubstantiveMessage('Tess'), true);
  assert.equal(isShortNonSubstantiveMessage('Hehe'), true);
  assert.equal(isIdentityQuestion('Loh aku belum tanya, kamu siapa sih?'), true);
  assert.equal(isIdentityQuestion('Akuu mau bahas emm.., kamu aja deh hahaha'), true);
  assert.equal(isOpenTopicQuestion('Coba sekarang kita bahas apa'), true);
  assert.equal(isRecentHistoryQuestion('Tadi barusan kita bahas apa sih'), true);
});

test('open-topic question clears old active-topic context without deleting history', () => {
  const selected = selectConversationContext([
    entry('user', 'Sekarang kita bahas Java Inheritance.'),
    entry('model', 'Baik, kita bahas Java.'),
  ], 'Coba sekarang kita bahas apa');
  assert.deepEqual(selected.history, []);
  assert.equal(selected.intent, 'open_topic');
});

test('recent-history wording keeps recent exchanges even without topic keywords', () => {
  const selected = selectConversationContext([
    entry('user', 'Apa itu SQA?'),
    entry('model', 'SQA adalah Software Quality Assurance.'),
  ], 'Tadi barusan kita bahas apa sih?');
  assert.deepEqual(selected.history, [
    entry('user', 'Apa itu SQA?'),
    entry('model', 'SQA adalah Software Quality Assurance.'),
  ]);
  assert.equal(selected.intent, 'recent_recall');
});

test('previous-topic recall selects the proposal immediately before the Java switch', () => {
  const selected = selectConversationContext([
    entry('user', 'Topik lama SQA.'),
    entry('model', 'Penjelasan SQA lama.'),
    entry('user', 'Kita bahas Python yu, kebetulan dosen ku Pak Rahmat.'),
    entry('model', 'Boleh, kita bahas Python dan Pak Rahmat.'),
    entry('user', 'Atau pindah deh Java aja hehw.'),
    entry('model', 'Gas, pindah ke Java.'),
  ], 'Sebelum pindah ke Java tadi aku mau bahas apa?');
  assert.equal(isPreviousTopicRecallQuestion('Sebelum pindah ke Java tadi aku mau bahas apa?'), true);
  assert.deepEqual(selected.history, [
    entry('user', 'Kita bahas Python yu, kebetulan dosen ku Pak Rahmat.'),
    entry('model', 'Boleh, kita bahas Python dan Pak Rahmat.'),
  ]);
  assert.equal(selected.intent, 'previous_topic_recall');
});

test('conversation correction clears old topic and uses a correction intent', () => {
  assert.equal(isConversationCorrection('Kok halo nya masih ikut sih, harusnya gausa'), true);
  const selected = selectConversationContext([
    entry('user', 'Atau pindah deh Java aja.'),
    entry('model', 'Baik, Java.'),
  ], 'Kok halo nya masih ikut sih, harusnya gausa');
  assert.deepEqual(selected.history, []);
  assert.equal(selected.intent, 'correction');
});
