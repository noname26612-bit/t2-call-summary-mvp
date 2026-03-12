const { createPgPool } = require('../db/createPgPool');
const { buildPostgresStorage } = require('./postgresStorage');

function createStorage({ databaseConfig, logger }) {
  const pool = createPgPool(databaseConfig);

  return buildPostgresStorage({
    pool,
    logger: logger.child({ component: 'storage' })
  });
}

module.exports = {
  createStorage
};
