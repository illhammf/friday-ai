export const MEMORY_CATEGORIES = Object.freeze([
  'preference',
  'personal_context',
  'project',
  'fact',
  'instruction',
]);

export const MAX_MEMORY_ENTRIES = 30;
export const MAX_MEMORY_LENGTH = 500;

const SENSITIVE_MEMORY_PATTERN =
  /\b(?:password|passwd|passcode|kata sandi|otp|one[- ]time password|api[\s_-]?key|access token|refresh token|secret|pin|private key|bearer token|recovery code|kode pemulihan)\b|(?:\bBearer\s+\S+|\bAIza[0-9A-Za-z_-]{20,}\b|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_]{12,}\b)/i;

export function normalizeMemoryContent(value) {
  if (typeof value !== 'string') {
    return { valid: false, reason: 'invalid' };
  }

  const content = value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!content) {
    return { valid: false, reason: 'empty' };
  }
  if (content.length > MAX_MEMORY_LENGTH) {
    return { valid: false, reason: 'oversized' };
  }
  if (SENSITIVE_MEMORY_PATTERN.test(content)) {
    return { valid: false, reason: 'sensitive' };
  }

  return { valid: true, content };
}

export function normalizeMemoryCategory(category = 'fact') {
  if (!MEMORY_CATEGORIES.includes(category)) {
    throw new TypeError(`Unsupported memory category: ${category}`);
  }
  return category;
}

export function normalizeMemoryMetadata(metadata = {}) {
  metadata ||= {};
  const category = normalizeMemoryCategory(metadata.category);
  const source = metadata.source ?? 'explicit';
  if (typeof source !== 'string' || !source.trim()) {
    throw new TypeError('Memory source must be a non-empty string.');
  }

  return { category, source: source.trim() };
}
