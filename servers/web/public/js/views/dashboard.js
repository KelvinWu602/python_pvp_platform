import { t, fmtDateTime } from '../i18n.js';
import { api } from '../api.js';
import { renderHeader } from '../components/header.js';
import { openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';

export async function renderDashboard() {
    const app = document.getElementById('app');
    app.appendChild(renderHeader());

    const container = document.createElement('div');
    container.className = 'two-col';
    container.innerHTML = `
        <div class="pvp-panel">
            <div class="pvp-panel-header">${t.yourCompetitions}</div>
            <div class="pvp-panel-body" data-enroll-list>
                <div style="color:#94a3b8; text-align:center; padding:2rem;">載入中...</div>
            </div>
        </div>
        <div class="pvp-panel">
            <div class="pvp-panel-header">${t.contestCode}</div>
            <div class="pvp-panel-body" data-code-list>
                <div style="color:#94a3b8; text-align:center; padding:2rem;">${t.selectCompetition}</div>
            </div>
        </div>
    `;
    app.appendChild(container);

    const enrollBody = container.querySelector('[data-enroll-list]');
    const codeBody = container.querySelector('[data-code-list]');

    let enrolls = [];
    let codes = [];
    let selectedEnroll = null;
    let selectedCodeId = null; // code_id linked to the selected enrollment

    try {
        [enrolls, codes] = await Promise.all([
            api.listEnrolls(),
            api.listCodes(),
        ]);
    } catch (err) {
        enrollBody.innerHTML = `<div style="color:#e63946;">${t.generalError}</div>`;
        return;
    }

    renderEnrolls();

    // Auto-select first ongoing competition; else the first one.
    if (enrolls.length > 0) {
        const now = Date.now();
        const ongoing = enrolls.find(e => {
            const s = new Date(e.start_time_utc).getTime();
            const en = new Date(e.end_time_utc).getTime();
            return s <= now && now <= en;
        });
        selectEnroll(ongoing || enrolls[0]);
    } else {
        enrollBody.innerHTML = `<div style="color:#94a3b8; text-align:center; padding:2rem;">${t.noEnrollment}</div>`;
    }

    function renderEnrolls() {
        enrollBody.innerHTML = '';
        const now = Date.now();
        for (const e of enrolls) {
            const startTs = new Date(e.start_time_utc).getTime();
            const endTs = new Date(e.end_time_utc).getTime();
            const ongoing = startTs <= now && now <= endTs;
            const card = document.createElement('div');
            card.className = 'pvp-card';
            if (selectedEnroll && selectedEnroll.id === e.id) card.classList.add('selected');
            else if (!ongoing) card.classList.add('dimmed');

            card.innerHTML = `
                <div style="flex:1;">
                    <div class="pvp-card-title">${escapeHtml(e.competition_display_name || 'Competition')}</div>
                    <div class="pvp-card-sub">${fmtDateTime(e.start_time_utc)} 至 ${fmtDateTime(e.end_time_utc)}</div>
                </div>
                ${ongoing ? '<div class="pvp-card-arrow">➜</div>' : ''}
            `;
            card.addEventListener('click', (ev) => {
                if (ev.detail === 2 || ongoing) {
                    // double-click OR ongoing → go into competition
                    location.hash = `#/competition/${e.id}`;
                } else {
                    // single click → select on this panel
                    selectEnroll(e);
                }
            });
            // Explicit go-in via arrow
            const arrow = card.querySelector('.pvp-card-arrow');
            if (arrow) {
                arrow.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    location.hash = `#/competition/${e.id}`;
                });
            }
            enrollBody.appendChild(card);
        }
    }

    async function selectEnroll(e) {
        selectedEnroll = e;
        renderEnrolls();
        codeBody.innerHTML = `<div style="color:#94a3b8; text-align:center; padding:2rem;">載入中...</div>`;
        try {
            const linked = await api.getLinkedCode(e.id);
            selectedCodeId = linked ? linked.id : null;
        } catch (err) {
            selectedCodeId = null;
        }
        renderCodes();
    }

    function renderCodes() {
        codeBody.innerHTML = '';
        if (!selectedEnroll) return;
        const scoped = codes.filter(c => c.competition_id === selectedEnroll.competition_id);
        if (scoped.length === 0) {
            codeBody.innerHTML = `<div style="color:#94a3b8; text-align:center; padding:1rem;">${t.noCodeYet}</div>`;
        }
        for (const c of scoped) {
            const card = document.createElement('div');
            card.className = 'pvp-card';
            const updated = c.updated_at_utc ? `${t.lastUpdated}：${fmtDateTime(c.updated_at_utc)}` : '';
            const isStarred = c.id === selectedCodeId;
            card.innerHTML = `
                <div style="flex:1;">
                    <div class="pvp-card-title">${escapeHtml(c.name)}</div>
                    <div class="pvp-card-sub">${updated}</div>
                </div>
                <div class="${isStarred ? 'star' : 'star-empty'}" title="${isStarred ? '目前選定' : '選定為比賽代碼'}">★</div>
            `;
            const star = card.querySelector('.star, .star-empty');
            star.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                if (isStarred) return; // already selected
                try {
                    await api.linkCode(selectedEnroll.id, c.id);
                    selectedCodeId = c.id;
                    renderCodes();
                    toast('已選定為比賽代碼', 'success');
                } catch (err) {
                    toast(err.body?.error || t.generalError, 'error');
                }
            });
            card.addEventListener('click', () => {
                location.hash = `#/code/${c.id}`;
            });
            codeBody.appendChild(card);
        }
        // Add-tile
        const add = document.createElement('div');
        add.className = 'pvp-add-tile';
        add.innerHTML = '+';
        add.title = t.createCode;
        add.addEventListener('click', () => openCreateCodeModal());
        codeBody.appendChild(add);
    }

    function openCreateCodeModal() {
        if (!selectedEnroll) {
            toast(t.selectCompetition, 'error');
            return;
        }
        openModal({
            title: t.createCode,
            bodyHtml: `
                <label style="display:block; margin-bottom:0.5rem; font-weight:500;">${t.codeName}</label>
                <input type="text" name="code-name" class="login-input" style="margin-bottom:0;" maxlength="50" required>
                <div class="modal-err" style="color:#e63946; margin-top:0.5rem; min-height:1em;"></div>
            `,
            confirmLabel: t.create,
            onConfirm: async (modal) => {
                const nameInput = modal.querySelector('input[name=code-name]');
                const err = modal.querySelector('.modal-err');
                const name = nameInput.value.trim();
                if (!name) {
                    err.textContent = '請輸入名稱';
                    return false;
                }
                try {
                    const res = await api.createCode({
                        name,
                        code: '',
                        competition_id: selectedEnroll.competition_id,
                    });
                    location.hash = `#/code/${res.id}`;
                    return true;
                } catch (e) {
                    err.textContent = e.body?.error || t.generalError;
                    return false;
                }
            },
        });
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
