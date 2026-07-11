// Header: logo + title + username + hamburger.
// Login page uses the login-header variant (contact-organizer link instead of username).
import { t } from '../i18n.js';
import { getUsername, clearAuth } from '../auth.js';
import { api, ORGANIZER_CONTACT } from '../api.js';

export function renderHeader({ variant = 'user' } = {}) {
    const el = document.createElement('header');
    el.className = 'pvp-header';

    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.innerHTML = `
        <div class="brand-logo"><img src="/assets/logo.svg" alt="logo"></div>
        <div class="brand-title">${t.siteTitle}</div>
    `;
    el.appendChild(brand);

    const actions = document.createElement('div');
    actions.className = 'actions';

    if (variant === 'login') {
        const link = document.createElement('a');
        link.href = ORGANIZER_CONTACT;
        link.textContent = t.contactOrganizer;
        link.style.color = 'white';
        link.style.textDecoration = 'none';
        actions.appendChild(link);
    } else {
        const uname = document.createElement('span');
        uname.textContent = getUsername();
        actions.appendChild(uname);

        const btn = document.createElement('button');
        btn.className = 'hamburger';
        btn.setAttribute('aria-label', 'menu');
        btn.innerHTML = '&#9776;';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMenu();
        });
        actions.appendChild(btn);
    }

    el.appendChild(actions);
    return el;
}

let menuEl = null;

function toggleMenu() {
    if (menuEl) {
        closeMenu();
        return;
    }
    menuEl = document.createElement('div');
    menuEl.className = 'menu-dropdown';
    const logoutBtn = document.createElement('button');
    logoutBtn.textContent = t.logout;
    logoutBtn.addEventListener('click', async () => {
        closeMenu();
        try { await api.logout(); } catch { /* ignore */ }
        clearAuth();
        location.hash = '#/login';
    });
    menuEl.appendChild(logoutBtn);
    document.body.appendChild(menuEl);

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', closeMenu, { once: true });
    }, 0);
}

function closeMenu() {
    if (menuEl && menuEl.parentNode) {
        menuEl.parentNode.removeChild(menuEl);
    }
    menuEl = null;
}
