import {
  MAX_MEMORY_LENGTH,
  normalizeMemoryContent,
  normalizeMemoryCategory,
} from './memory-policy.js';

const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_PARTS = 8;
const MAX_HISTORY_TEXT_BYTES = 64 * 1024;
const MAX_QUESTION_BYTES = 16 * 1024;
const MAX_SYSTEM_INSTRUCTION_BYTES = 48 * 1024;
const MAX_STYLE_CONTEXT_BYTES = 8 * 1024;
const MAX_MEMORY_ENTRIES = 5;
const MAX_MEMORY_CONTENT_LENGTH = MAX_MEMORY_LENGTH;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AGGREGATE_REQUEST_BYTES = 8 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export class AssistantRequestError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'AssistantRequestError';
    this.code = code;
  }
}

function assertPlainRecord(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      `${label} must be a plain object.`,
    );
  }
}

function readDataRecord(value, allowedKeys, label) {
  assertPlainRecord(value, label);
  const record = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === 'string'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (
      typeof key !== 'string' ||
      !allowedKeys.includes(key) ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new AssistantRequestError(
        'INVALID_ASSISTANT_REQUEST',
        `${label} contains unsupported or unsafe fields.`,
      );
    }
    Object.defineProperty(record, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return record;
}

function assertBoundedString(value, label, maxBytes, { allowEmpty = false } = {}) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value.trim()) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      `${label} must be a ${allowEmpty ? 'string' : 'non-empty string'} within its size limit.`,
    );
  }
  return value;
}

function normalizeTextPart(part, label) {
  const record = readDataRecord(part, ['type', 'text'], label);
  if (
    (record.type !== undefined && record.type !== 'text') ||
    typeof record.text !== 'string'
  ) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      `${label} must be a text content part.`,
    );
  }
  return Object.freeze({ type: 'text', text: record.text });
}

function normalizeHistory(history) {
  if (!Array.isArray(history) || history.length > MAX_HISTORY_MESSAGES) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      `History must contain at most ${MAX_HISTORY_MESSAGES} messages.`,
    );
  }

  let totalTextBytes = 0;
  return Object.freeze(history.map((message, messageIndex) => {
    const record = readDataRecord(
      message,
      ['role', 'parts'],
      `History message ${messageIndex + 1}`,
    );
    const role = record.role === 'model' || record.role === 'assistant'
      ? 'assistant'
      : record.role;
    if (role !== 'user' && role !== 'assistant') {
      throw new AssistantRequestError(
        'INVALID_ASSISTANT_REQUEST',
        `History message ${messageIndex + 1} has an unsupported role.`,
      );
    }
    if (
      !Array.isArray(record.parts) ||
      record.parts.length === 0 ||
      record.parts.length > MAX_HISTORY_PARTS
    ) {
      throw new AssistantRequestError(
        'INVALID_ASSISTANT_REQUEST',
        `History message ${messageIndex + 1} has invalid content parts.`,
      );
    }

    const parts = record.parts.map((part, partIndex) => {
      const normalized = normalizeTextPart(
        part,
        `History message ${messageIndex + 1}, part ${partIndex + 1}`,
      );
      totalTextBytes += Buffer.byteLength(normalized.text, 'utf8');
      return normalized;
    });
    if (totalTextBytes > MAX_HISTORY_TEXT_BYTES) {
      throw new AssistantRequestError(
        'ASSISTANT_REQUEST_TOO_LARGE',
        'History text exceeded the allowed size.',
      );
    }

    return Object.freeze({ role, parts: Object.freeze(parts) });
  }));
}

function isCanonicalBase64(value) {
  if (!value || value.length % 4 !== 0) return false;
  const paddingStart = value.endsWith('==')
    ? value.length - 2
    : value.endsWith('=')
      ? value.length - 1
      : value.length;
  for (let index = 0; index < paddingStart; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    ) {
      return false;
    }
  }
  return paddingStart === value.length || paddingStart >= value.length - 2;
}

function normalizeImage(image) {
  if (image == null) return null;

  const record = readDataRecord(image, ['mimetype', 'data'], 'Image');
  if (
    typeof record.mimetype !== 'string' ||
    !SUPPORTED_IMAGE_MIME_TYPES.has(record.mimetype)
  ) {
    throw new AssistantRequestError(
      'UNSUPPORTED_IMAGE_TYPE',
      'Image MIME type is not supported.',
    );
  }
  if (
    typeof record.data !== 'string' ||
    !record.data ||
    record.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    !isCanonicalBase64(record.data)
  ) {
    throw new AssistantRequestError(
      'INVALID_IMAGE_DATA',
      'Image data must be valid base64.',
    );
  }

  const imageBytes = Buffer.from(record.data, 'base64');
  if (
    imageBytes.length === 0 ||
    imageBytes.length > MAX_IMAGE_BYTES ||
    imageBytes.toString('base64') !== record.data
  ) {
    throw new AssistantRequestError(
      'ASSISTANT_REQUEST_TOO_LARGE',
      'Image data is empty, malformed, or exceeds the 5 MiB limit.',
    );
  }
  return Object.freeze({
    type: 'image',
    mimeType: record.mimetype,
    data: record.data,
  });
}

function normalizeMemoryContext(memoryContext, conversationType) {
  if (!Array.isArray(memoryContext) || memoryContext.length > MAX_MEMORY_ENTRIES) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      `Memory context must contain at most ${MAX_MEMORY_ENTRIES} entries.`,
    );
  }
  if (conversationType === 'group' && memoryContext.length > 0) {
    throw new AssistantRequestError(
      'GROUP_MEMORY_DENIED',
      'Private memory context cannot be included in a group request.',
    );
  }

  return Object.freeze(memoryContext.map((memory, index) => {
    const record = readDataRecord(
      memory,
      ['category', 'content', 'id', 'source', 'created_at', 'updated_at'],
      `Memory context entry ${index + 1}`,
    );
    let category;
    try {
      category = normalizeMemoryCategory(record.category || 'fact');
    } catch {
      category = null;
    }
    const normalizedContent = normalizeMemoryContent(record.content);
    if (!category || !normalizedContent.valid) {
      throw new AssistantRequestError(
        'INVALID_ASSISTANT_REQUEST',
        `Memory context entry ${index + 1} is invalid.`,
      );
    }
    return Object.freeze({
      category,
      content: normalizedContent.content,
    });
  }));
}

function freezeParts(parts) {
  return Object.freeze(parts.map((part) => Object.freeze(part)));
}

function freezeRequest(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) {
      freezeRequest(nested);
    }
  }
  return Object.freeze(value);
}

export function createAssistantRequest(options = {}) {
  const input = readDataRecord(
    options,
    [
      'question',
      'history',
      'image',
      'systemInstruction',
      'conversationStyle',
      'memoryContext',
      'conversationType',
      'senderName',
    ],
    'Assistant request input',
  );
  const {
    question = '',
    history = [],
    image = null,
    systemInstruction,
    conversationStyle = '',
    memoryContext = [],
    conversationType = 'private',
    senderName = 'Pengguna',
  } = input;
  if (!['private', 'group'].includes(conversationType)) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      'conversationType must be private or group.',
    );
  }
  assertBoundedString(
    systemInstruction,
    'System instruction',
    MAX_SYSTEM_INSTRUCTION_BYTES,
  );
  assertBoundedString(
    conversationStyle,
    'Conversation style',
    MAX_STYLE_CONTEXT_BYTES,
    { allowEmpty: true },
  );
  assertBoundedString(
    senderName,
    'Sender name',
    256,
  );

  const normalizedHistory = normalizeHistory(history);
  const normalizedMemories = normalizeMemoryContext(memoryContext, conversationType);
  const normalizedImage = normalizeImage(image);
  const prompt = assertBoundedString(
    question,
    'Question',
    MAX_QUESTION_BYTES,
    { allowEmpty: normalizedImage !== null },
  );
  const currentText = conversationType === 'group'
    ? `${senderName}: ${prompt || 'Tolong jelaskan gambar ini.'}`
    : prompt || 'Tolong jelaskan gambar ini.';
  const currentParts = [
    Object.freeze({ type: 'text', text: currentText }),
  ];
  if (normalizedImage) currentParts.push(normalizedImage);

  const request = {
    version: 1,
    modelInput: {
      systemInstruction,
      conversationStyle,
      memoryContext: normalizedMemories,
      history: normalizedHistory,
      currentMessage: Object.freeze({
        role: 'user',
        parts: freezeParts(currentParts),
      }),
    },
    metadata: Object.freeze({ conversationType }),
  };

  let serialized;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      'Assistant request could not be serialized.',
    );
  }
  if (
    Buffer.byteLength(serialized, 'utf8') > MAX_AGGREGATE_REQUEST_BYTES
  ) {
    throw new AssistantRequestError(
      'ASSISTANT_REQUEST_TOO_LARGE',
      'Aggregate assistant request exceeded the 8 MiB limit.',
    );
  }

  return freezeRequest(request);
}

export function isAssistantRequest(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.version === 1,
  );
}

export function assertAssistantRequest(value) {
  const request = readDataRecord(
    value,
    ['version', 'modelInput', 'metadata'],
    'Assistant request',
  );
  if (request.version !== 1) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      'Unsupported assistant request version.',
    );
  }
  const metadata = readDataRecord(
    request.metadata,
    ['conversationType'],
    'Assistant request metadata',
  );
  if (!['private', 'group'].includes(metadata.conversationType)) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      'Assistant request metadata is invalid.',
    );
  }
  const modelInput = readDataRecord(
    request.modelInput,
    [
      'systemInstruction',
      'conversationStyle',
      'memoryContext',
      'history',
      'currentMessage',
    ],
    'Assistant model input',
  );
  assertBoundedString(
    modelInput.systemInstruction,
    'System instruction',
    MAX_SYSTEM_INSTRUCTION_BYTES,
  );
  assertBoundedString(
    modelInput.conversationStyle,
    'Conversation style',
    MAX_STYLE_CONTEXT_BYTES,
    { allowEmpty: true },
  );
  const history = normalizeHistory(modelInput.history);
  const memoryContext = normalizeMemoryContext(
    modelInput.memoryContext,
    metadata.conversationType,
  );
  const currentMessage = readDataRecord(
    modelInput.currentMessage,
    ['role', 'parts'],
    'Current message',
  );
  if (
    currentMessage.role !== 'user' ||
    !Array.isArray(currentMessage.parts) ||
    currentMessage.parts.length < 1 ||
    currentMessage.parts.length > 2
  ) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      'Current message is malformed.',
    );
  }
  const currentParts = currentMessage.parts.map((part, index) => {
    const record = readDataRecord(
      part,
      ['type', 'text', 'mimeType', 'data'],
      `Current message part ${index + 1}`,
    );
    if (record.type === 'text') {
      return normalizeTextPart(record, `Current message part ${index + 1}`);
    }
    if (record.type === 'image') {
      const image = normalizeImage({
        mimetype: record.mimeType,
        data: record.data,
      });
      return image;
    }
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      `Current message part ${index + 1} has an unsupported type.`,
    );
  });
  if (currentParts.filter(({ type }) => type === 'text').length !== 1) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      'Current message must contain exactly one text part.',
    );
  }
  const normalizedRequest = {
    version: 1,
    modelInput: {
      systemInstruction: modelInput.systemInstruction,
      conversationStyle: modelInput.conversationStyle,
      memoryContext,
      history,
      currentMessage: {
        role: 'user',
        parts: currentParts,
      },
    },
    metadata: { conversationType: metadata.conversationType },
  };
  if (
    Buffer.byteLength(JSON.stringify(normalizedRequest), 'utf8') >
    MAX_AGGREGATE_REQUEST_BYTES
  ) {
    throw new AssistantRequestError(
      'ASSISTANT_REQUEST_TOO_LARGE',
      'Aggregate assistant request exceeded the 8 MiB limit.',
    );
  }
  return freezeRequest(normalizedRequest);
}

export const ASSISTANT_REQUEST_LIMITS = Object.freeze({
  maxHistoryMessages: MAX_HISTORY_MESSAGES,
  maxHistoryParts: MAX_HISTORY_PARTS,
  maxHistoryTextBytes: MAX_HISTORY_TEXT_BYTES,
  maxQuestionBytes: MAX_QUESTION_BYTES,
  maxSystemInstructionBytes: MAX_SYSTEM_INSTRUCTION_BYTES,
  maxStyleContextBytes: MAX_STYLE_CONTEXT_BYTES,
  maxMemoryEntries: MAX_MEMORY_ENTRIES,
  maxMemoryContentLength: MAX_MEMORY_CONTENT_LENGTH,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxAggregateRequestBytes: MAX_AGGREGATE_REQUEST_BYTES,
});
