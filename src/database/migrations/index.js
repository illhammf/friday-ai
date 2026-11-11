import { initializeExistingSchemaMigration } from './001-initialize-existing-schema.js';
import { structureUserMemoriesMigration } from './002-structure-user-memories.js';

export const databaseMigrations = [
  initializeExistingSchemaMigration,
  structureUserMemoriesMigration,
];
