import { t } from '../i18n.js';

export function openModal({ title, bodyHtml, onConfirm, confirmLabel }) {
    const root = document.getElementById('modal-root');
    root.innerHTML = '';

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <h2>${title}</h2>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-actions">
            <button class="cancel" type="button">${t.cancel}</button>
            <button class="confirm" type="button">${confirmLabel || t.confirm}</button>
        </div>
    `;
    backdrop.appendChild(modal);
    root.appendChild(backdrop);

    const close = () => { root.innerHTML = ''; };
    modal.querySelector('.cancel').addEventListener('click', close);
    modal.querySelector('.confirm').addEventListener('click', async () => {
        try {
            const shouldClose = await onConfirm(modal);
            if (shouldClose !== false) close();
        } catch (err) {
            console.error(err);
        }
    });
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    return { close, modal };
}
