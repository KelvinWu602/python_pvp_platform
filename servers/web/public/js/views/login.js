import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { setAuth, isLoggedIn } from '../auth.js';
import { renderHeader } from '../components/header.js';
import { toast } from '../components/toast.js';

export function renderLogin() {
    if (isLoggedIn()) {
        location.hash = '#/dashboard';
        return;
    }
    const app = document.getElementById('app');
    app.appendChild(renderHeader({ variant: 'login' }));

    const wrap = document.createElement('div');
    wrap.style.padding = '2rem';
    wrap.style.display = 'grid';
    wrap.style.gridTemplateColumns = '2fr 1fr';
    wrap.style.gap = '2rem';
    wrap.style.maxWidth = '1200px';
    wrap.style.margin = '0 auto';

    wrap.innerHTML = `
        <div class="login-hero">
            <img src="/assets/hero.svg" alt="扣叮大師">
        </div>
        <form class="login-form" autocomplete="on">
            <h1>${t.login}</h1>
            <input class="login-input" name="username" type="text" placeholder="${t.username}" autocomplete="username" required>
            <input class="login-input" name="password" type="password" placeholder="${t.password}" autocomplete="current-password" required>
            <div style="text-align:center; margin-top:1rem;">
                <button type="submit" class="confirm-btn">${t.confirm}</button>
            </div>
            <div class="err-msg" style="color:#e63946; text-align:center; margin-top:1rem; min-height:1.2em;"></div>
        </form>
    `;
    app.appendChild(wrap);

    const form = wrap.querySelector('form');
    const errBox = wrap.querySelector('.err-msg');
    const btn = wrap.querySelector('button[type=submit]');

    // Responsive: single column on small screens.
    if (window.matchMedia('(max-width: 900px)').matches) {
        wrap.style.gridTemplateColumns = '1fr';
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errBox.textContent = '';
        btn.disabled = true;
        const username = form.username.value.trim();
        const password = form.password.value;
        try {
            const res = await api.login(username, password);
            setAuth(res.auth_token, username, res.urole);
            location.hash = '#/dashboard';
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                errBox.textContent = t.invalidCredentials;
            } else {
                errBox.textContent = t.generalError;
                console.error(err);
            }
        } finally {
            btn.disabled = false;
        }
    });
}
