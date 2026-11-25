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
const TOPIC_SWITCH_PATTERN = /\b(?:sekarang|now|ganti|switch|pindah|beralih|bahas|membahas|discuss|let['’]?s\s+(?:discuss|talk)|let's)\b/i;
const HISTORICAL_RECALL_PATTERN = /\b(?:sebelumnya|sebelum|tadi|barusan|yang\s+(?:aku|saya)\s+(?:bilang|ceritakan|minta)|apa\s+yang\s+(?:aku|saya)|previous(?:ly)?|earlier|before|what\s+did\s+i)\b/i;

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

export function isExplicitTopicSwitch(question) {
  const text = String(question || '').trim();
  if (/^(?:apa|siapa|bagaimana|what|who|how)\b/i.test(text)) return false;
  return TOPIC_SWITCH_PATTERN.test(text);
}

export function isHistoricalRecallQuestion(question) {
  return HISTORICAL_RECALL_PATTERN.test(String(question || ''));
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
  if (isExplicitTopicSwitch(question)) {
    return Object.freeze({
      history: Object.freeze([]),
      recentCount: 0,
      relevantEarlierCount: 0,
      excludedEarlierCount: entries.length,
      topicSwitch: true,
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

  const latestTopicSwitch = entries.reduce(
    (latest, message, index) => message?.role === 'user' &&
      isExplicitTopicSwitch(messageText(message)) ? index : latest,
    -1,
  );
  if (latestTopicSwitch >= 0 && !isHistoricalRecallQuestion(question)) {
    const activeTopicHistory = entries.slice(latestTopicSwitch);
    return Object.freeze({
      history: Object.freeze(activeTopicHistory.slice(-recentLimit)),
      recentCount: Math.min(activeTopicHistory.length, recentLimit),
      relevantEarlierCount: 0,
      excludedEarlierCount: entries.length - Math.min(activeTopicHistory.length, recentLimit),
      topicSwitch: true,
    });
  }

  return Object.freeze({
    history: Object.freeze([...selectedEarlier, ...recent]),
    recentCount: recent.length,
    relevantEarlierCount: selectedEarlier.length,
    excludedEarlierCount: earlier.length - selectedEarlier.length,
    topicSwitch: false,
  });
}
