import { t } from '../i18n.js';
import { clearAuth } from '../auth.js';
import { renderHeader } from '../components/header.js';

export function renderExpired() {
    clearAuth();
    const app = document.getElementById('app');
    app.appendChild(renderHeader({ variant: 'login' }));

    const wrap = document.createElement('div');
    wrap.style.minHeight = 'calc(100vh - 4.5rem)';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.justifyContent = 'center';
    wrap.innerHTML = `
        <div style="text-align:center; font-size:1.6rem; color:#64748b;">
            <div>${t.sessionExpired}</div>
            <div style="margin-top:0.5rem;">
                ${t.pleaseReLogin}<a href="#/login" style="color:var(--color-accent); font-weight:700; text-decoration:underline;">${t.login}</a>
            </div>
        </div>
    `;
    app.appendChild(wrap);
}
