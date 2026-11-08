import { databaseMigrations } from './migrations/index.js';

const trackingTableSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const trackingColumns = [
  { name: 'version', type: 'TEXT', primaryKey: 1 },
  { name: 'name', type: 'TEXT', notNull: 1 },
  {
    name: 'applied_at',
    type: 'TEXT',
    notNull: 1,
    defaultValue: 'CURRENT_TIMESTAMP',
  },
];

function compareVersions(left, right) {
  const leftVersion = BigInt(left.version);
  const rightVersion = BigInt(right.version);
  return leftVersion < rightVersion ? -1 : leftVersion > rightVersion ? 1 : 0;
}

function validateMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new TypeError('At least one database migration is required.');
  }

  const versions = new Set();
  const names = new Set();

  for (const migration of migrations) {
    if (
      !migration ||
      typeof migration.version !== 'string' ||
      !/^\d{3,}$/.test(migration.version) ||
      migration.version !== BigInt(migration.version).toString().padStart(3, '0') ||
      typeof migration.name !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(migration.name) ||
      typeof migration.up !== 'function'
    ) {
      throw new TypeError(
        'Each migration must have a numeric version, kebab-case name, and up function.',
      );
    }

    if (versions.has(migration.version)) {
      throw new Error(`Duplicate database migration version: ${migration.version}.`);
    }
    if (names.has(migration.name)) {
      throw new Error(`Duplicate database migration name: ${migration.name}.`);
    }

    versions.add(migration.version);
    names.add(migration.name);
  }

  return [...migrations].sort(compareVersions);
}

function hasTrackingTable(db) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get());
}

function validateTrackingTable(db) {
  const columns = db.prepare('PRAGMA table_info(schema_migrations)').all();
  const valid = columns.length === trackingColumns.length &&
    trackingColumns.every((expected, index) => {
      const actual = columns[index];
      return actual.name === expected.name &&
        actual.type.toUpperCase() === expected.type &&
        (expected.primaryKey === undefined || actual.pk === expected.primaryKey) &&
        (expected.notNull === undefined || actual.notnull === expected.notNull) &&
        (expected.defaultValue === undefined ||
          actual.dflt_value === expected.defaultValue);
    });

  if (!valid) {
    throw new Error(
      'The schema_migrations table has an unsupported or inconsistent schema.',
    );
  }
}

function readAppliedMigrations(db, migrations) {
  const knownMigrations = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );
  const rows = db.prepare(`
    SELECT version, name, applied_at
    FROM schema_migrations
    ORDER BY version
  `).all();
  const applied = new Set();

  for (const row of rows) {
    const migration = knownMigrations.get(row.version);
    if (!migration || migration.name !== row.name) {
      throw new Error(
        `Inconsistent database migration metadata for version ${row.version}.`,
      );
    }
    const appliedAt = typeof row.applied_at === 'string' &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.applied_at)
      ? new Date(`${row.applied_at.replace(' ', 'T')}Z`)
      : null;
    if (
      !appliedAt ||
      Number.isNaN(appliedAt.getTime()) ||
      appliedAt.toISOString().slice(0, 19).replace('T', ' ') !== row.applied_at
    ) {
      throw new Error(
        `Invalid application timestamp for database migration ${row.version}.`,
      );
    }
    applied.add(row.version);
  }

  const firstUnappliedIndex = migrations.findIndex(
    (migration) => !applied.has(migration.version),
  );
  if (
    firstUnappliedIndex !== -1 &&
    migrations.slice(firstUnappliedIndex + 1)
      .some((migration) => applied.has(migration.version))
  ) {
    throw new Error('Applied database migrations are not a contiguous prefix.');
  }

  return applied;
}

function applyMigration(db, migration, { adoptBaseline = false } = {}) {
  db.exec('BEGIN IMMEDIATE');

  try {
    const adopted = adoptBaseline &&
      typeof migration.adoptExistingSchema === 'function' &&
      migration.adoptExistingSchema(db);

    db.exec(trackingTableSql);
    validateTrackingTable(db);

    if (!adopted) {
      migration.up(db);
    }

    db.prepare(`
      INSERT INTO schema_migrations (version, name)
      VALUES (?, ?)
    `).run(migration.version, migration.name);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Migration ${migration.version} failed and its transaction could not be rolled back.`,
        { cause: error },
      );
    }

    throw new Error(
      `Migration ${migration.version} (${migration.name}) failed.`,
      { cause: error },
    );
  }
}

export function runMigrations(db, pendingMigrations = databaseMigrations) {
  const migrations = validateMigrations(pendingMigrations);
  const trackingExists = hasTrackingTable(db);

  if (trackingExists) {
    validateTrackingTable(db);
  }

  const applied = trackingExists
    ? readAppliedMigrations(db, migrations)
    : new Set();

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    applyMigration(db, migration, {
      adoptBaseline: applied.size === 0 &&
        migration.version === migrations[0].version,
    });
    applied.add(migration.version);
  }

  return migrations.map((migration) => ({
    ...migration,
    applied: applied.has(migration.version),
  }));
}
