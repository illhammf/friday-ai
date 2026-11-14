import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyConversationError,
  createConversationCorrelationId,
  getSafeProviderErrorMetadata,
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

test('extracts bounded Gemini diagnostics without error text, credentials, or payloads', () => {
  const error = Object.assign(new Error('secret API key and private prompt'), {
    status: 503,
    code: 'UNAVAILABLE',
    response: { headers: { authorization: 'Bearer secret' }, data: 'private response' },
  });
  const metadata = getSafeProviderErrorMetadata(error, {
    providerId: 'google-gemini',
    modelId: 'gemini-3.5-flash-lite',
    handlerExecutionStarted: false,
  });

  assert.deepEqual(metadata, {
    providerId: 'google-gemini',
    handlerExecutionStarted: false,
    errorName: 'Error',
    modelId: 'gemini-3.5-flash-lite',
    httpStatus: 503,
    retryable: true,
    providerErrorCode: 'UNAVAILABLE',
  });
  const serialized = JSON.stringify(metadata);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('private'), false);
});

test('does not guess provider retryability or retain unsafe provider codes', () => {
  const metadata = getSafeProviderErrorMetadata({
    name: 'ProviderError',
    code: 'unsafe code containing secret',
    message: 'sensitive detail',
  }, { modelId: 'bad model with spaces' });

  assert.equal(metadata.errorName, 'ProviderError');
  assert.equal(metadata.retryable, undefined);
  assert.equal(metadata.providerErrorCode, undefined);
  assert.equal(metadata.modelId, undefined);
});
