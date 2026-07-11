// Static file server for the Python PvP web frontend.
// Serves ./public on 127.0.0.1:3001. Nginx terminates TLS and proxies to this.
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Basic security headers.
app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
});

// Serve static assets with sensible cache headers.
app.use(express.static(PUBLIC_DIR, {
    etag: true,
    lastModified: true,
    maxAge: '5m',
    setHeaders: (res, filePath) => {
        // Never cache HTML — always fetch fresh so SPA updates take effect.
        if (filePath.endsWith('.html')) {
            res.set('Cache-Control', 'no-store, must-revalidate');
        }
    },
}));

// SPA fallback: any unknown path (non-file) → index.html.
// The client-side hash router (#/dashboard etc.) handles routing after that.
app.get(/.*/, (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
        if (err) next(err);
    });
});

const server = app.listen(PORT, HOST, () => {
    console.log(`Web server running on http://${HOST}:${PORT}`);
});

const shutdown = () => {
    console.log('Shutting down web server...');
    server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
