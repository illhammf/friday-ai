export const structureUserMemoriesMigration = {
  version: '002',
  name: 'structure-user-memories',
  up(db) {
    db.exec(`
      ALTER TABLE user_memories
      ADD COLUMN category TEXT NOT NULL DEFAULT 'fact'
      CHECK (category IN (
        'preference',
        'personal_context',
        'project',
        'fact',
        'instruction'
      ));

      ALTER TABLE user_memories
      ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';

      ALTER TABLE user_memories
      ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

      UPDATE user_memories
      SET updated_at = created_at
      WHERE updated_at = '';
    `);
  },
};
