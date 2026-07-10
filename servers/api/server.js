require('dotenv').config();

const express = require('express');
const cors = require('cors');
const userRoutes = require('./routes/user');
const rootRoutes = require('./routes/root');
const publicRoutes = require('./routes/public');
const pool = require('./utils/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow cross-origin requests. Set CORS_ORIGIN env var (e.g.
// https://coding-master.kelvin-test.xyz) in production. Default * for dev.
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
};
app.use(cors(corsOptions));

// Middleware for JSON parsing (common to all routes)
app.use(express.json({ limit: '1mb' }));

// Mount the route modules with base paths
app.use('/admin', rootRoutes);
app.use('/public', publicRoutes);
app.use('/', userRoutes);

// Basic error handler (optional but recommended)
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong' });
});

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown handlers
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  server.close(async () => {
    try {
      await pool.end();
      console.log('Database pool closed');
    } catch (err) {
      console.error('Error closing database pool:', err);
    }
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);