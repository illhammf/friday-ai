const STOP_WORDS = new Set([
  'aku', 'apa', 'atau', 'dan', 'dengan', 'dari', 'di', 'ini', 'itu', 'ke',
  'kamu', 'yang', 'untuk', 'the', 'and', 'for', 'with', 'this', 'that',
  'you', 'your', 'what', 'how', 'about',
]);

export const DEFAULT_MEMORY_RETRIEVAL_LIMIT = 5;
export const MAX_MEMORY_RETRIEVAL_CANDIDATES = 30;

export function getMemoryTerms(text) {
  return new Set(
    String(text || '')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 3 && !STOP_WORDS.has(term)) || [],
  );
}

export function retrieveRelevantMemories(
  memories,
  query,
  limit = DEFAULT_MEMORY_RETRIEVAL_LIMIT,
) {
  if (!Array.isArray(memories) || !Number.isInteger(limit) || limit <= 0) {
    return [];
  }

  const queryTerms = getMemoryTerms(query);
  if (queryTerms.size === 0) return [];

  return memories
    .map((memory, index) => {
      const memoryTerms = getMemoryTerms(memory.content);
      const score = [...queryTerms].reduce(
        (total, term) => total + Number(memoryTerms.has(term)),
        0,
      );
      return { memory, index, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ memory }) => memory);
}
