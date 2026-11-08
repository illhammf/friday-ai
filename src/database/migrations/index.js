import { initializeExistingSchemaMigration } from './001-initialize-existing-schema.js';

export const databaseMigrations = [
  initializeExistingSchemaMigration,
];
