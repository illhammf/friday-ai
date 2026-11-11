import {
  MAX_MEMORY_ENTRIES,
  normalizeMemoryContent,
  normalizeMemoryMetadata,
} from '../ai/memory-policy.js';
import {
  getMemoryTerms,
  MAX_MEMORY_RETRIEVAL_CANDIDATES,
  retrieveRelevantMemories,
} from '../ai/memory-retriever.js';

export function createMemoryService({ repository }) {
  if (!repository) {
    throw new TypeError('A memory repository is required.');
  }

  return {
    add(sessionId, content, maxEntries = MAX_MEMORY_ENTRIES, metadata = {}) {
      const normalized = normalizeMemoryContent(content);
      if (!normalized.valid) {
        return {
          added: false,
          limitReached: false,
          rejected: normalized.reason,
        };
      }

      const normalizedMetadata = normalizeMemoryMetadata(metadata);
      return repository.add(
        sessionId,
        normalized.content,
        maxEntries,
        normalizedMetadata,
      );
    },
    list(sessionId) {
      return repository.list(sessionId);
    },
    delete(sessionId, memoryId) {
      return repository.delete(sessionId, memoryId);
    },
    clear(sessionId) {
      return repository.clear(sessionId);
    },
    retrieve(sessionId, query, limit) {
      const terms = [...getMemoryTerms(query)];
      const candidates = repository.search
        ? repository.search(
            sessionId,
            terms,
            MAX_MEMORY_RETRIEVAL_CANDIDATES,
          )
        : repository.list(sessionId);
      return retrieveRelevantMemories(
        candidates,
        query,
        limit,
      );
    },
  };
}
