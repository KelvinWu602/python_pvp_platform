import { t, fmtDateTime } from '../i18n.js';
import { api } from '../api.js';
import { renderHeader } from '../components/header.js';
import { openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';

// Dashboard: two-column layout.
//   Left panel  = my enrollments (from GET /enroll)
//   Right panel = the codes I authored for the selected enrollment's
//                 competition (from GET /enroll/:eid/code)
//
// Codes are loaded per-enrollment on selection, cached in a module-scoped
// Map keyed by enroll.id. The cache is invalidated whenever the user
// mutates the code list for an enrollment (create, select) so subsequent
// selections re-fetch.
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
    let codes = [];          // codes for the currently-selected enrollment
    let selectedEnroll = null;
    let selectedCodeId = null;

    // Cache: enroll.id → codes array. Populated on first selection, evicted
    // on any mutation for that enroll.
    const codeCache = new Map();

    try {
        enrolls = await api.listEnrolls();
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
            // Card body: always just selects (updates right-panel code list).
            card.addEventListener('click', () => selectEnroll(e));

            // Arrow (only rendered for ongoing competitions) navigates to detail page.
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
            // Code list: cached per-enroll. Selected code: always live (cheap +
            // changes independently of the code list).
            const codesPromise = codeCache.has(e.id)
                ? Promise.resolve(codeCache.get(e.id))
                : api.listEnrollCodes(e.id).then(list => {
                    codeCache.set(e.id, list);
                    return list;
                });
            const [freshCodes, selected] = await Promise.all([
                codesPromise,
                api.getSelectedCode(e.id).catch(() => null),
            ]);
            codes = freshCodes;
            selectedCodeId = selected ? selected.id : null;
        } catch (err) {
            codes = [];
            selectedCodeId = null;
        }
        renderCodes();
    }

    function renderCodes() {
        codeBody.innerHTML = '';
        if (!selectedEnroll) return;
        if (codes.length === 0) {
            codeBody.innerHTML = `<div style="color:#94a3b8; text-align:center; padding:1rem;">${t.noCodeYet}</div>`;
        }
        for (const c of codes) {
            const card = document.createElement('div');
            card.className = 'pvp-card';
            const isSelected = c.id === selectedCodeId;
            if (isSelected) card.classList.add('selected');
            const updated = c.updated_at_utc ? `${t.lastUpdated}：${fmtDateTime(c.updated_at_utc)}` : '';
            // Unified UX with the enrollment cards on the left panel:
            //   - card body click → selects this code as the enrollment's code
            //     (orange ring via `.pvp-card.selected` marks the current pick)
            //   - orange arrow (➜) → navigates to the code editor
            card.innerHTML = `
                <div style="flex:1;">
                    <div class="pvp-card-title">${escapeHtml(c.name)}</div>
                    <div class="pvp-card-sub">${updated}</div>
                </div>
                <div class="pvp-card-arrow" title="${t.editCode}">➜</div>
            `;
            card.addEventListener('click', async () => {
                if (c.id === selectedCodeId) return; // already selected → no-op
                try {
                    await api.selectCode(selectedEnroll.id, c.id);
                    selectedCodeId = c.id;
                    renderCodes();
                    toast('已選定為比賽代碼', 'success');
                } catch (err) {
                    toast(err.body?.error || t.generalError, 'error');
                }
            });
            card.querySelector('.pvp-card-arrow').addEventListener('click', (ev) => {
                ev.stopPropagation();
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
                    const res = await api.createCode(selectedEnroll.id, name);
                    // Invalidate this enroll's cache so the new code appears
                    // if the user comes back to the dashboard.
                    codeCache.delete(selectedEnroll.id);
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
