const fs = require('fs/promises');
const path = require('path');

const MIGRATION_LOCK_ID = 82410611;

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadMigrationFiles(migrationsDir) {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function runMigrations({ pool, migrationsDir, logger }) {
  const resolvedDir = path.resolve(migrationsDir);
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await ensureMigrationsTable(client);

    const files = await loadMigrationFiles(resolvedDir);
    const appliedRows = await client.query('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(appliedRows.rows.map((row) => row.filename));

    let appliedCount = 0;
    for (const filename of files) {
      if (appliedSet.has(filename)) {
        continue;
      }

      const filePath = path.join(resolvedDir, filename);
      const sql = await fs.readFile(filePath, 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [filename]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }

      appliedCount += 1;
      if (logger) {
        logger.info('migration_applied', { filename });
      }
    }

    return {
      migrationsFound: files.length,
      appliedCount
    };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } catch (unlockError) {
      if (logger) {
        logger.warn('migration_unlock_failed', { error: unlockError });
      }
    }

    client.release();
  }
}

module.exports = {
  runMigrations
};
