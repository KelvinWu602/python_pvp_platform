require('dotenv').config();

const express = require('express');
const cors = require('cors');
const userAPI = require('./routes/userAPI');
const battleRoutes = require('./routes/battleAPI');
const codeAPI = require('./routes/codeAPI');
const competitionAPI = require('./routes/competitionAPI');
const internalAPI = require('./routes/internalAPI');
const pool = require('./utils/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow cross-origin requests (debug page is opened from file:// or another port)
app.use(cors());

// Middleware for JSON parsing (common to all routes)
app.use(express.json());

// Mount the route modules with base paths
app.use('/api/battle', battleRoutes);     
app.use('/api/code', codeAPI); 
app.use('/api/competition', competitionAPI);   
app.use('/api/internal', internalAPI);
app.use('/api/user', userAPI);

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