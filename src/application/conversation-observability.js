import { randomUUID } from 'node:crypto';

const ERROR_CATEGORIES = new Set([
  'validation_error',
  'provider_error',
  'provider_rate_limit',
  'provider_unavailable',
  'transport_error',
  'transport_uncertain',
  'persistence_error',
  'media_error',
  'internal_error',
]);

export function createConversationCorrelationId() {
  return randomUUID();
}

/** Classifies an error without returning its message, stack, or provider details. */
export function classifyConversationError(error, stage = '') {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || error?.code);
  const stageName = String(stage).toLowerCase();

  if (stageName.includes('persist') || code.includes('SQLITE')) {
    return 'persistence_error';
  }
  if (stageName.includes('submission') || stageName.includes('transport') || stageName.includes('reply') || stageName.includes('outbound')) {
    return 'transport_uncertain';
  }
  if (stageName.includes('media') || stageName.includes('voice') || stageName.includes('video') || stageName.includes('sticker') || stageName.includes('image')) {
    return 'media_error';
  }
  if (
    ['ASSISTANT_REQUEST_TOO_LARGE', 'INVALID_ASSISTANT_REQUEST', 'INVALID_AI_RESPONSE', 'EMPTY_AI_RESPONSE', 'AI_RESPONSE_TOO_LARGE'].includes(code) ||
    stageName.includes('validat')
  ) {
    return 'validation_error';
  }
  if (status === 429 || code.includes('QUOTA') || code.includes('RATE_LIMIT') || /rate.?limit|quota/i.test(String(error?.message || ''))) {
    return 'provider_rate_limit';
  }
  if ([500, 502, 503, 504].includes(status) || code.includes('UNAVAILABLE')) {
    return 'provider_unavailable';
  }
  if (stageName.includes('ai') || stageName.includes('provider') || status === 401 || status === 403) {
    return 'provider_error';
  }
  if (stageName.includes('queue')) return 'internal_error';
  return ERROR_CATEGORIES.has(code.toLowerCase())
    ? code.toLowerCase()
    : 'internal_error';
}

export function isConversationErrorCategory(value) {
  return ERROR_CATEGORIES.has(value);
}
