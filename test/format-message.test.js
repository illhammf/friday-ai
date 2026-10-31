import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWhatsAppMessage } from '../src/whatsapp/format-message.js';

test('removes Markdown headings, blockquotes, and decorative separators', () => {
  const formatted = formatWhatsAppMessage(
    '### Yang bisa Friday lakukan\n\n> Aku bisa bantu banyak hal.\n\n---',
  );

  assert.equal(formatted, 'Yang bisa Friday lakukan\n\nAku bisa bantu banyak hal.');
  assert.doesNotMatch(formatted, /^#+|^>/m);
});

test('normalizes Markdown emphasis to WhatsApp formatting without excess markers', () => {
  const formatted = formatWhatsAppMessage(
    '**Bold** dan __strong__, *italic*, ~~hapus~~, serta <u>garis bawah</u>.',
  );

  assert.equal(formatted, '*Bold* dan *strong*, _italic_, ~hapus~, serta garis bawah.');
});

test('cleans up lists and turns Markdown tables into mobile-friendly bullets', () => {
  const formatted = formatWhatsAppMessage(
    '- Pertanyaan\n* Gambar\n\n| Fitur | Status |\n| --- | --- |\n| Foto | Bisa |\n| Video | Bisa |',
  );

  assert.equal(
    formatted,
    '• Pertanyaan\n• Gambar\n\n• Fitur: Foto · Status: Bisa\n• Fitur: Video · Status: Bisa',
  );
});

test('keeps fenced and inline code readable and preserves normal paragraphs', () => {
  const formatted = formatWhatsAppMessage(
    'Pakai `npm run check`.\n\n```js\nconst friday = true;\n```\n\nSelesai.',
  );

  assert.equal(
    formatted,
    'Pakai `npm run check`.\n\n```\nconst friday = true;\n```\n\nSelesai.',
  );
});

test('normalizes whitespace, Markdown links, and empty values', () => {
  assert.equal(
    formatWhatsAppMessage('Cek [dokumentasi](https://example.com).\n\n\nSelesai.'),
    'Cek dokumentasi (https://example.com).\n\nSelesai.',
  );
  assert.equal(formatWhatsAppMessage(null), '');
});
