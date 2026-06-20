const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER || 'python_pvp_admin',
  password: process.env.DB_PASSWORD || 'temp',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'python_pvp',
  max: parseInt(process.env.DB_MAX_CONN) || 25,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // RDS requires SSL. Through the SSH tunnel the cert's hostname is the RDS
  // endpoint, not localhost, so disable hostname verification for local dev.
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

module.exports = pool;
