import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectConversationStyle,
  getStyleInstruction,
} from '../src/ai/conversation-style.js';

test('follows explicit playful, romantic, and assertive style requests', () => {
  assert.equal(detectConversationStyle('Coba bercanda dong'), 'playful');
  assert.equal(detectConversationStyle('Kirim emote lucu ya'), 'playful');
  assert.equal(detectConversationStyle('Bisa romantisin aku?'), 'romantic');
  assert.equal(detectConversationStyle('Gombalin aku dong'), 'romantic');
  assert.equal(detectConversationStyle('Marahin aku dong'), 'assertive');
  assert.equal(detectConversationStyle('Jawab lebih tegas ya'), 'assertive');
});

test('does not interpret a request not to use a style as permission to use it', () => {
  assert.equal(detectConversationStyle('Jangan bercanda dulu'), 'natural');
  assert.equal(detectConversationStyle('Jangan romantis, serius aja'), 'natural');
  assert.equal(detectConversationStyle('Jangan marah ya'), 'natural');
});

test('explicit style requests take precedence over technical keywords', () => {
  assert.equal(
    detectConversationStyle('Jelasin error ini pakai jokes ya'),
    'playful',
  );
  assert.equal(
    detectConversationStyle('Bikin penjelasan database ini romantis dong'),
    'romantic',
  );
  assert.equal(
    detectConversationStyle('Aku sedih, coba hibur pakai humor ringan'),
    'playful',
  );
});

test('adapts to casual language and the latest user tone in conversation history', () => {
  assert.equal(detectConversationStyle('wkwk terus gimana nih'), 'excited');
  assert.equal(detectConversationStyle('boleh bantu jelasin ini gak'), 'casual');
  assert.equal(
    detectConversationStyle('terus gimana?', [
      { role: 'user', parts: [{ text: 'wkwk santai aja Friday' }] },
      { role: 'model', parts: [{ text: 'Siap.' }] },
    ]),
    'casual',
  );
});

test('keeps serious, supportive, and technical messages appropriately grounded', () => {
  assert.equal(detectConversationStyle('Aku sedih dan takut banget'), 'supportive');
  assert.equal(detectConversationStyle('Bagaimana cara kerja SQL database?'), 'technical');
  assert.equal(detectConversationStyle('Bisa jelaskan ini?'), 'natural');
  assert.equal(detectConversationStyle('aku lagi marah karena masalah'), 'natural');
});

test('provides clear style-specific instructions with honest boundaries', () => {
  assert.match(getStyleInstruction('playful'), /jangan merendahkan/);
  assert.match(getStyleInstruction('romantic'), /bukan klaim hubungan nyata/);
  assert.match(getStyleInstruction('assertive'), /Jangan menghina/);
  assert.match(getStyleInstruction('casual'), /bahasa percakapan/);
  assert.match(getStyleInstruction('unknown'), /NATURAL DAN ADAPTIF/);
});
