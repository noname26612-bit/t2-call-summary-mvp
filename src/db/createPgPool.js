const { Pool } = require('pg');

function createPgPool(databaseConfig) {
  return new Pool(databaseConfig);
}

module.exports = {
  createPgPool
};
