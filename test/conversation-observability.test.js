import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyConversationError,
  createConversationCorrelationId,
  isConversationErrorCategory,
} from '../src/application/conversation-observability.js';

test('creates opaque correlation identifiers without message-derived content', () => {
  const first = createConversationCorrelationId();
  const second = createConversationCorrelationId();
  assert.match(first, /^[0-9a-f-]{36}$/i);
  assert.notEqual(first, second);
});

test('classifies provider, transport, persistence, media, validation, and unknown errors deterministically', () => {
  assert.equal(classifyConversationError({ status: 429 }, 'ai_request'), 'provider_rate_limit');
  assert.equal(classifyConversationError({ status: 503 }, 'ai_request'), 'provider_unavailable');
  assert.equal(classifyConversationError(new Error('broken'), 'ai_request'), 'provider_error');
  assert.equal(classifyConversationError(new Error('broken'), 'reply_submission'), 'transport_uncertain');
  assert.equal(classifyConversationError(new Error('broken'), 'outbound_transport'), 'transport_uncertain');
  assert.equal(classifyConversationError(new Error('broken'), 'history_persistence'), 'persistence_error');
  assert.equal(classifyConversationError(new Error('broken'), 'media_download'), 'media_error');
  assert.equal(classifyConversationError({ code: 'INVALID_AI_RESPONSE' }, 'validation'), 'validation_error');
  assert.equal(classifyConversationError(new Error('broken'), 'unexpected'), 'internal_error');
  assert.equal(isConversationErrorCategory('transport_uncertain'), true);
  assert.equal(isConversationErrorCategory('success'), false);
});
