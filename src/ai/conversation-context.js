import {
  ASSISTANT_REQUEST_LIMITS,
  AssistantRequestError,
  createAssistantRequest,
} from './assistant-request.js';

export const MAX_ASSISTANT_RESPONSE_BYTES = 32 * 1024;

export function normalizeConversationHistory(history) {
  if (
    !Array.isArray(history) ||
    history.length > ASSISTANT_REQUEST_LIMITS.maxHistoryMessages
  ) {
    throw new AssistantRequestError(
      'INVALID_ASSISTANT_REQUEST',
      `History must contain at most ${ASSISTANT_REQUEST_LIMITS.maxHistoryMessages} messages.`,
    );
  }
  const normalizedHistory = history.flatMap((message) =>
    createAssistantRequest({
      question: 'Validate conversation history.',
      history: [message],
      systemInstruction: 'Conversation history validation.',
    }).modelInput.history,
  );
  const nonEmptyHistory = normalizedHistory.filter((message) =>
    message.parts.some((part) => part.text.trim().length > 0));
  let totalBytes = 0;
  let firstIncludedIndex = nonEmptyHistory.length;
  for (let index = nonEmptyHistory.length - 1; index >= 0; index -= 1) {
    const entryBytes = nonEmptyHistory[index].parts.reduce(
      (sum, part) => sum + Buffer.byteLength(part.text, 'utf8'),
      0,
    );
    if (entryBytes > ASSISTANT_REQUEST_LIMITS.maxHistoryTextBytes) {
      if (firstIncludedIndex === nonEmptyHistory.length) {
        throw new AssistantRequestError(
          'ASSISTANT_REQUEST_TOO_LARGE',
          'The newest history entry exceeds the application size limit.',
        );
      }
      break;
    }
    if (totalBytes + entryBytes > ASSISTANT_REQUEST_LIMITS.maxHistoryTextBytes) {
      break;
    }
    totalBytes += entryBytes;
    firstIncludedIndex = index;
  }
  const usableHistory = nonEmptyHistory.slice(firstIncludedIndex);

  return Object.freeze({
    history: Object.freeze(usableHistory),
    removedEmptyEntries: normalizedHistory.length - nonEmptyHistory.length,
    excludedOlderEntries: nonEmptyHistory.length - usableHistory.length,
  });
}

function toGeminiPart(part) {
  if (part.type === 'text') return { text: part.text };
  return {
    inlineData: {
      mimeType: part.mimeType,
      data: part.data,
    },
  };
}

/** Validates and converts legacy conversation input without token estimation. */
export function buildConversationContents({
  question,
  history,
  image = null,
  systemInstruction,
  conversationType = 'private',
  senderName = 'Pengguna',
} = {}) {
  if (
    typeof question === 'string' &&
    Buffer.byteLength(question, 'utf8') > ASSISTANT_REQUEST_LIMITS.maxQuestionBytes
  ) {
    throw new AssistantRequestError(
      'ASSISTANT_REQUEST_TOO_LARGE',
      'Current conversation message exceeded the application size limit.',
    );
  }

  const normalized = normalizeConversationHistory(history);
  const request = createAssistantRequest({
    question,
    history: normalized.history,
    image,
    systemInstruction,
    conversationStyle: '',
    memoryContext: [],
    conversationType,
    senderName,
  });
  const { modelInput } = request;
  const historyContents = modelInput.history.map(({ role, parts }) => ({
    role: role === 'assistant' ? 'model' : 'user',
    parts: parts.map(toGeminiPart),
  }));
  const currentContent = {
    role: 'user',
    parts: modelInput.currentMessage.parts.map(toGeminiPart),
  };

  return Object.freeze({
    contents: Object.freeze([...historyContents, currentContent]),
    history: normalized.history,
    currentUserText: modelInput.currentMessage.parts[0].text,
    removedEmptyEntries: normalized.removedEmptyEntries,
  });
}

export function readAssistantResponse(response) {
  if (!response || typeof response !== 'object' || typeof response.text !== 'string') {
    throw new AssistantRequestError(
      'INVALID_AI_RESPONSE',
      'Gemini returned a response without text content.',
    );
  }

  const text = response.text.trim();
  if (!text) {
    throw new AssistantRequestError(
      'EMPTY_AI_RESPONSE',
      'Gemini returned empty text content.',
    );
  }
  return assertAssistantResponseSize(text);
}

export function assertAssistantResponseSize(text) {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > MAX_ASSISTANT_RESPONSE_BYTES
  ) {
    throw new AssistantRequestError(
      'AI_RESPONSE_TOO_LARGE',
      'Gemini response exceeded the application response size limit.',
    );
  }
  return text;
}
