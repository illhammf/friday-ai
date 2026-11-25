import { getMemoryTerms } from './memory-retriever.js';

export const RECENT_CONVERSATION_MESSAGES = 4;
export const RELEVANT_EARLIER_MESSAGES = 4;

function messageText(message) {
  return (message?.parts || [])
    .map((part) => part?.text)
    .filter((text) => typeof text === 'string')
    .join(' ');
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
  const recent = entries.slice(-recentLimit);
  const earlier = entries.slice(0, Math.max(0, entries.length - recent.length));
  const terms = getMemoryTerms(question);
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
