// API kompatibilitas untuk operasi database default yang dibuka secara lazy.
export {
  saveMessage,
  loadHistory,
  saveUserMemory,
  loadUserMemories,
  deleteUserMemory,
  clearUserMemories,
  privateSessionId,
  groupSessionId,
  initializeDefaultDatabase,
  closeDatabase,
} from './sqlite.js';
