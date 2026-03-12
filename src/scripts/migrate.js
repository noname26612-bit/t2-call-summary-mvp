#!/usr/bin/env node
const path = require('path');
const dotenv = require('dotenv');
const { loadConfig } = require('../config/env');
const { createLogger } = require('../services/logger');
const { createPgPool } = require('../db/createPgPool');
const { runMigrations } = require('../db/migrations');

dotenv.config();

async function main() {
  const config = loadConfig({ validateRuntimeSecrets: false });
  const logger = createLogger({ level: config.logLevel, service: 'ats-call-summary-migrate' });
  const pool = createPgPool(config.database);

  try {
    const result = await runMigrations({
      pool,
      migrationsDir: path.resolve(__dirname, '../../migrations'),
      logger
    });

    logger.info('migrations_finished', result);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
