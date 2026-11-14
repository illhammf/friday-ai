import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_REQUEST_LIMITS,
} from '../src/ai/assistant-request.js';
import {
  MAX_ASSISTANT_RESPONSE_BYTES,
  buildConversationContents,
  normalizeConversationHistory,
  readAssistantResponse,
} from '../src/ai/conversation-context.js';

const base = {
  systemInstruction: 'System instruction.',
  question: 'Current question.',
};

test('preserves database history order and duplicate user messages', () => {
  const result = buildConversationContents({
    ...base,
    history: [
      { role: 'user', parts: [{ text: 'Repeat.' }] },
      { role: 'model', parts: [{ text: 'First reply.' }] },
      { role: 'user', parts: [{ text: 'Repeat.' }] },
    ],
  });

  assert.deepEqual(result.contents.map(({ role }) => role), [
    'user', 'model', 'user', 'user',
  ]);
  assert.deepEqual(
    result.contents.slice(0, 3).map(({ parts }) => parts[0].text),
    ['Repeat.', 'First reply.', 'Repeat.'],
  );
  assert.equal(result.contents.at(-1).parts[0].text, 'Current question.');
});

test('drops only empty history entries and reports how many were removed', () => {
  const result = normalizeConversationHistory([
    { role: 'user', parts: [{ text: 'Earlier.' }] },
    { role: 'model', parts: [{ text: '  ' }] },
    { role: 'user', parts: [{ text: 'Latest.' }] },
  ]);
  assert.equal(result.removedEmptyEntries, 1);
  assert.deepEqual(result.history.map(({ parts }) => parts[0].text), [
    'Earlier.', 'Latest.',
  ]);
});

test('keeps the newest complete history suffix within the text-byte window', () => {
  const result = normalizeConversationHistory([
    { role: 'user', parts: [{ text: 'o'.repeat(40 * 1024) }] },
    { role: 'model', parts: [{ text: 'n'.repeat(40 * 1024) }] },
  ]);
  assert.equal(result.excludedOlderEntries, 1);
  assert.deepEqual(result.history.map(({ parts }) => parts[0].text), [
    'n'.repeat(40 * 1024),
  ]);
});

test('accepts the exact history byte boundary and the configured message-count boundary', () => {
  const byteBoundary = normalizeConversationHistory([{
    role: 'user',
    parts: [{ text: 'x'.repeat(ASSISTANT_REQUEST_LIMITS.maxHistoryTextBytes) }],
  }]);
  assert.equal(byteBoundary.history[0].parts[0].text.length,
    ASSISTANT_REQUEST_LIMITS.maxHistoryTextBytes);

  const countBoundary = normalizeConversationHistory(Array.from(
    { length: ASSISTANT_REQUEST_LIMITS.maxHistoryMessages },
    (_, index) => ({ role: 'user', parts: [{ text: `entry-${index}` }] }),
  ));
  assert.equal(countBoundary.history.length, ASSISTANT_REQUEST_LIMITS.maxHistoryMessages);
});

test('rejects malformed roles, parts, excessive message count, and oversized history', () => {
  for (const history of [
    [{ role: 'system', parts: [{ text: 'not allowed' }] }],
    [{ role: 'user', parts: [] }],
    Array.from(
      { length: ASSISTANT_REQUEST_LIMITS.maxHistoryMessages + 1 },
      () => ({ role: 'user', parts: [{ text: 'entry' }] }),
    ),
    [{ role: 'user', parts: [{ text: 'x'.repeat(ASSISTANT_REQUEST_LIMITS.maxHistoryTextBytes + 1) }] }],
  ]) {
    assert.throws(() => buildConversationContents({ ...base, history }));
  }
});

test('rejects an oversized current message without truncating it and accepts the byte boundary', () => {
  const boundary = 'x'.repeat(ASSISTANT_REQUEST_LIMITS.maxQuestionBytes);
  const accepted = buildConversationContents({
    ...base,
    question: boundary,
    history: [],
  });
  assert.equal(accepted.contents.at(-1).parts[0].text, boundary);

  assert.throws(() => buildConversationContents({
    ...base,
    question: `${boundary}x`,
    history: [],
  }), { code: 'ASSISTANT_REQUEST_TOO_LARGE' });
});

test('does not silently remove older history beyond the configured message window', () => {
  const history = Array.from(
    { length: ASSISTANT_REQUEST_LIMITS.maxHistoryMessages + 1 },
    (_, index) => ({ role: 'user', parts: [{ text: `entry-${index}` }] }),
  );
  assert.throws(() => normalizeConversationHistory(history), {
    code: 'INVALID_ASSISTANT_REQUEST',
  });
});

test('keeps group sender prefix and current text separate from previous turns', () => {
  const result = buildConversationContents({
    ...base,
    question: 'Hi group',
    conversationType: 'group',
    senderName: 'Ari',
    history: [],
  });
  assert.equal(result.contents.at(-1).parts[0].text, 'Ari: Hi group');
});

test('validates provider response structure, empty text, and output byte limit', () => {
  assert.equal(readAssistantResponse({ text: '  Answer.  ' }), 'Answer.');
  for (const response of [undefined, null, {}, { text: 42 }, { text: '  ' }]) {
    assert.throws(() => readAssistantResponse(response));
  }
  assert.throws(() => readAssistantResponse({
    text: 'x'.repeat(MAX_ASSISTANT_RESPONSE_BYTES + 1),
  }), { code: 'AI_RESPONSE_TOO_LARGE' });
});
