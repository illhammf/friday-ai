export function createMemoryRepository(database) {
  if (!database) {
    throw new TypeError('Database operations are required.');
  }

  return {
    add(sessionId, content, maxEntries, metadata) {
      return database.saveUserMemory(
        sessionId,
        content,
        maxEntries,
        metadata,
      );
    },
    list(sessionId) {
      return database.loadUserMemories(sessionId);
    },
    search(sessionId, terms, limit) {
      return database.searchUserMemories
        ? database.searchUserMemories(sessionId, terms, limit)
        : database.loadUserMemories(sessionId);
    },
    delete(sessionId, memoryId) {
      return database.deleteUserMemory(sessionId, memoryId);
    },
    clear(sessionId) {
      return database.clearUserMemories(sessionId);
    },
  };
}
