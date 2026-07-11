// Bootstrap: hash-router, route matching, mount views.
import { isLoggedIn } from './auth.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderCompetition } from './views/competition.js';
import { renderCodeEditor } from './views/codeEditor.js';
import { renderTestResult } from './views/testResult.js';
import { renderBattleResult } from './views/battleResult.js';
import { renderExpired } from './views/expired.js';

const routes = [
    { pattern: /^#?\/?$/,                            handler: () => defaultRoute() },
    { pattern: /^#\/login$/,                         handler: renderLogin },
    { pattern: /^#\/expired$/,                       handler: renderExpired },
    { pattern: /^#\/dashboard$/,                     handler: renderDashboard, auth: true },
    { pattern: /^#\/competition\/([^/]+)$/,          handler: (m) => renderCompetition(m[1]), auth: true },
    { pattern: /^#\/code\/([^/]+)$/,                 handler: (m) => renderCodeEditor(m[1]), auth: true },
    { pattern: /^#\/test\/([^/]+)$/,                 handler: (m) => renderTestResult(m[1]), auth: true },
    { pattern: /^#\/battle\/([^/]+)$/,               handler: (m) => renderBattleResult(m[1]), auth: true },
];

function defaultRoute() {
    location.hash = isLoggedIn() ? '#/dashboard' : '#/login';
}

function route() {
    const hash = location.hash || '#/';
    for (const r of routes) {
        const m = hash.match(r.pattern);
        if (m) {
            if (r.auth && !isLoggedIn()) {
                location.hash = '#/login';
                return;
            }
            document.getElementById('app').innerHTML = '';
            document.getElementById('modal-root').innerHTML = '';
            try {
                r.handler(m);
            } catch (err) {
                console.error('View render error:', err);
            }
            return;
        }
    }
    // Unknown route → default
    defaultRoute();
}

window.addEventListener('hashchange', route);
window.addEventListener('load', route);
