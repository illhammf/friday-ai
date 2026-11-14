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

const RETRYABLE_PROVIDER_STATUSES = new Set([429, 500, 502, 503, 504]);
const SAFE_PROVIDER_ERROR_CODES = new Set([
  'ABORTED',
  'CANCELLED',
  'DATA_LOSS',
  'DEADLINE_EXCEEDED',
  'FAILED_PRECONDITION',
  'INTERNAL',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'OUT_OF_RANGE',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'UNAUTHENTICATED',
  'UNAVAILABLE',
  'UNIMPLEMENTED',
  'UNKNOWN',
]);

/** Returns only bounded, allowlisted provider diagnostics; never returns error text. */
export function getSafeProviderErrorMetadata(error, {
  providerId = 'google-gemini',
  modelId,
  handlerExecutionStarted = false,
} = {}) {
  const rawCode = error?.code ?? error?.error?.code;
  const statusValue = error?.status ?? error?.response?.status ??
    error?.error?.status ??
    (Number.isInteger(rawCode) && rawCode >= 100 && rawCode <= 599 ? rawCode : undefined);
  const status = Number.isInteger(statusValue)
    ? statusValue
    : typeof statusValue === 'string' && /^\d{3}$/.test(statusValue)
      ? Number(statusValue)
      : null;
  const normalizedCode = typeof rawCode === 'string' ? rawCode.toUpperCase() : null;
  const code = typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode >= 100 && rawCode <= 599
    ? String(rawCode)
    : SAFE_PROVIDER_ERROR_CODES.has(normalizedCode)
      ? normalizedCode
      : null;
  const rawName = error?.name;
  const errorName = typeof rawName === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName)
    ? rawName
    : 'Error';
  const metadata = {
    providerId: providerId === 'google-gemini' ? providerId : 'unknown',
    handlerExecutionStarted: handlerExecutionStarted === true,
    errorName,
  };

  if (typeof modelId === 'string' && /^[A-Za-z0-9._/-]{1,100}$/.test(modelId)) {
    metadata.modelId = modelId;
  }
  if (status !== null) {
    metadata.httpStatus = status;
    metadata.retryable = RETRYABLE_PROVIDER_STATUSES.has(status);
  }
  if (code !== null) metadata.providerErrorCode = code;
  return Object.freeze(metadata);
}

export function isConversationErrorCategory(value) {
  return ERROR_CATEGORIES.has(value);
}
