import { getMemoryTerms } from './memory-retriever.js';

export const RECENT_CONVERSATION_MESSAGES = 4;
export const RELEVANT_EARLIER_MESSAGES = 4;
const SHORT_NON_SUBSTANTIVE_MESSAGES = new Set([
  'tes', 'test', 'halo', 'hai', 'pagi', 'siang', 'sore', 'malam',
  'oke', 'ok', 'makasih', 'terima kasih', 'siap', 'hmm',
]);
const GENERIC_CONTEXT_TERMS = new Set([
  'baru', 'saja', 'sedang', 'ingin', 'memahami', 'topik', 'sebutkan',
  'kembali', 'ceritakan', 'sebelumnya', 'minta', 'hal', 'tadi', 'pernah',
]);

function messageText(message) {
  return (message?.parts || [])
    .map((part) => part?.text)
    .filter((text) => typeof text === 'string')
    .join(' ');
}

export function isShortNonSubstantiveMessage(question) {
  const normalized = String(question || '').trim().toLocaleLowerCase('id-ID');
  return SHORT_NON_SUBSTANTIVE_MESSAGES.has(normalized);
}

/**
 * Keeps the latest exchange evidence regardless of keywords, then adds only
 * earlier messages that overlap the current question. Order is never changed.
 */
export function selectConversationContext(history, question, {
  recentLimit = RECENT_CONVERSATION_MESSAGES,
  earlierLimit = RELEVANT_EARLIER_MESSAGES,
} = {}) {
  const entries = Array.isArray(history) ? history : [];
  if (isShortNonSubstantiveMessage(question)) {
    return Object.freeze({
      history: Object.freeze([]),
      recentCount: 0,
      relevantEarlierCount: 0,
      excludedEarlierCount: entries.length,
    });
  }
  const recent = entries.slice(-recentLimit);
  const earlier = entries.slice(0, Math.max(0, entries.length - recent.length));
  const terms = new Set(
    [...getMemoryTerms(question)].filter((term) => !GENERIC_CONTEXT_TERMS.has(term)),
  );
  const relevantIndexes = earlier
    .map((message, index) => ({
      index,
      score: [...terms].reduce(
        (total, term) => total + Number(getMemoryTerms(messageText(message)).has(term)),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, earlierLimit)
    .map(({ index }) => index)
    .sort((left, right) => left - right);
  const selectedEarlier = relevantIndexes.map((index) => earlier[index]);

  return Object.freeze({
    history: Object.freeze([...selectedEarlier, ...recent]),
    recentCount: recent.length,
    relevantEarlierCount: selectedEarlier.length,
    excludedEarlierCount: earlier.length - selectedEarlier.length,
  });
}
