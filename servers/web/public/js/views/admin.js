// Admin view — a two-column layout with:
//   Left panel: section switcher (five buttons)
//   Right panel: the currently-selected section's form/table
//
// Per-section form state is preserved in-memory (module scope) so switching
// tabs and coming back keeps whatever the admin typed. State is lost on
// hard reload — acceptable for an admin session.
//
// All operations hit /admin/* endpoints which require urole='root'. The API
// is the source of truth for authorization; this view merely improves UX
// by hiding admin controls from non-admins (via the header menu gate) and
// providing form scaffolding.
import { t, fmtDateTime } from '../i18n.js';
import { api } from '../api.js';
import { isAdmin } from '../auth.js';
import { renderHeader } from '../components/header.js';
import { toast } from '../components/toast.js';
import { createSearchPicker } from '../components/searchPicker.js';

// ── Section state (survives view unmount within the same tab/session) ────
const SECTIONS = ['createUser', 'editUser', 'createComp', 'editComp', 'enrolls', 'approve'];
let activeSection = 'createUser';
const state = {
    createUser: { username: '', full_name: '', password: '' },
    editUser:   { selectedUser: null, full_name: '', password: '' },
    createComp: {
        display_name: '', description: '',
        start_time_utc: '', end_time_utc: '',
        game_reference: '', helper_reference: '', manifest_reference: '',
        npc: null,   // { id, username, full_name }
    },
    editComp:   { selectedComp: null, form: null },   // form: null until loaded
    enrolls:    { selectedComp: null, list: null },
    approve:    { selectedComp: null, list: null },
};

export async function renderAdmin() {
    const app = document.getElementById('app');
    app.appendChild(renderHeader());

    if (!isAdmin()) {
        // Frontend gate; server also enforces. Keep the UX honest.
        const err = document.createElement('div');
        err.style.padding = '2rem';
        err.style.textAlign = 'center';
        err.style.color = '#e63946';
        err.textContent = 'Access denied';
        app.appendChild(err);
        return;
    }

    const container = document.createElement('div');
    container.className = 'two-col';
    container.innerHTML = `
        <div class="pvp-panel">
            <div class="pvp-panel-header">
                <button class="back-btn" title="返回">⬅</button>
                <span>${t.adminTitle}</span>
            </div>
            <div class="pvp-panel-body" data-section-list></div>
        </div>
        <div class="pvp-panel">
            <div class="pvp-panel-header" data-section-title>${t.adminTitle}</div>
            <div class="pvp-panel-body" data-section-body></div>
        </div>
    `;
    app.appendChild(container);

    container.querySelector('.back-btn').addEventListener('click', () => {
        history.length > 1 ? history.back() : (location.hash = '#/dashboard');
    });

    const sectionListEl = container.querySelector('[data-section-list]');
    const sectionTitleEl = container.querySelector('[data-section-title]');
    const sectionBodyEl = container.querySelector('[data-section-body]');

    const sectionMeta = {
        createUser: { title: t.adminSectionCreateUser, render: renderCreateUser },
        editUser:   { title: t.adminSectionEditUser,   render: renderEditUser },
        createComp: { title: t.adminSectionCreateCompetition, render: renderCreateComp },
        editComp:   { title: t.adminSectionEditCompetition, render: renderEditComp },
        enrolls:    { title: t.adminSectionManageEnrolls, render: renderEnrolls },
        approve:    { title: t.adminSectionApproveCode, render: renderApprove },
    };

    function renderSectionList() {
        sectionListEl.innerHTML = '';
        const list = document.createElement('div');
        list.className = 'admin-section-list';
        for (const key of SECTIONS) {
            const btn = document.createElement('button');
            btn.className = 'admin-section-btn' + (key === activeSection ? ' active' : '');
            btn.textContent = sectionMeta[key].title;
            btn.addEventListener('click', () => {
                activeSection = key;
                renderSectionList();
                mountSection();
            });
            list.appendChild(btn);
        }
        sectionListEl.appendChild(list);
    }

    function mountSection() {
        sectionTitleEl.textContent = sectionMeta[activeSection].title;
        sectionBodyEl.innerHTML = '';
        sectionMeta[activeSection].render(sectionBodyEl);
    }

    renderSectionList();
    mountSection();
}

// ─── Helpers ────────────────────────────────────────────────────────────

function labeledInput(label, name, value = '', type = 'text', extra = '') {
    return `
        <label class="admin-field">
            <span>${label}</span>
            <input class="admin-input" name="${name}" type="${type}" value="${escapeAttr(value)}" ${extra}>
        </label>
    `;
}
function labeledTextarea(label, name, value = '') {
    return `
        <label class="admin-field">
            <span>${label}</span>
            <textarea class="admin-input admin-textarea" name="${name}">${escapeHtml(value)}</textarea>
        </label>
    `;
}
function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
function escapeAttr(s) { return escapeHtml(s); }

// Convert an ISO timestamp to the value format expected by
// <input type="datetime-local"> (YYYY-MM-DDTHH:MM, local time, no seconds).
function toLocalDatetimeInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Convert a datetime-local input's value (local time) to an ISO string.
function fromLocalDatetimeInputValue(v) {
    if (!v) return null;
    const d = new Date(v);
    if (isNaN(d)) return null;
    return d.toISOString();
}

// ─── Section: Create user ───────────────────────────────────────────────

function renderCreateUser(root) {
    const s = state.createUser;
    root.innerHTML = `
        <form class="admin-form" data-form>
            ${labeledInput(t.username, 'username', s.username, 'text', 'required')}
            ${labeledInput(t.fullName, 'full_name', s.full_name, 'text', 'required')}
            ${labeledInput(t.passwordLabel, 'password', s.password, 'password', 'required')}
            <div class="admin-actions">
                <button type="submit" class="confirm-btn">${t.create}</button>
            </div>
        </form>
    `;
    const form = root.querySelector('[data-form]');
    // Persist typed values as user types, so switching tabs preserves state.
    form.addEventListener('input', () => {
        s.username = form.username.value;
        s.full_name = form.full_name.value;
        s.password = form.password.value;
    });
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            await api.adminCreateUser({
                username: s.username.trim(),
                full_name: s.full_name.trim(),
                password: s.password,
            });
            toast('已建立', 'success');
            // Reset form on success.
            s.username = ''; s.full_name = ''; s.password = '';
            renderCreateUser(root);
        } catch (err) {
            toast(err.body?.error || t.generalError, 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

// ─── Section: Edit user ─────────────────────────────────────────────────

function renderEditUser(root) {
    const s = state.editUser;
    root.innerHTML = `
        <div class="admin-picker-wrap"></div>
        <div class="admin-form" data-form-slot></div>
    `;
    const pickerWrap = root.querySelector('.admin-picker-wrap');
    const formSlot = root.querySelector('[data-form-slot]');

    const picker = createSearchPicker({
        placeholder: `${t.search}：${t.username} / ${t.fullName}`,
        fetchResults: (q) => api.adminListUsers(q),
        renderRow: (u) => `<strong>${escapeHtml(u.username)}</strong> — ${escapeHtml(u.full_name)}`,
        onPick: (u) => {
            s.selectedUser = u;
            s.full_name = u.full_name;
            s.password = '';
            drawForm();
        },
        initialValue: s.selectedUser ? s.selectedUser.username : '',
    });
    pickerWrap.appendChild(picker.el);
    drawForm();

    function drawForm() {
        if (!s.selectedUser) {
            formSlot.innerHTML = `<div style="color:#94a3b8; padding:1rem; text-align:center;">${t.selectCompetition.replace('比賽', '使用者')}</div>`;
            return;
        }
        formSlot.innerHTML = `
            <form class="admin-form" data-form>
                <div class="admin-readonly">
                    <span>${t.username}：</span>
                    <strong>${escapeHtml(s.selectedUser.username)}</strong>
                </div>
                ${labeledInput(t.fullName, 'full_name', s.full_name, 'text', 'required')}
                ${labeledInput(
                    `${t.passwordLabel} ${t.passwordUnchanged}`,
                    'password', s.password, 'password'
                )}
                <div class="admin-actions">
                    <button type="submit" class="confirm-btn">${t.save}</button>
                </div>
            </form>
        `;
        const form = formSlot.querySelector('[data-form]');
        form.addEventListener('input', () => {
            s.full_name = form.full_name.value;
            s.password = form.password.value;
        });
        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const btn = form.querySelector('button[type=submit]');
            btn.disabled = true;
            const payload = { full_name: s.full_name.trim() };
            if (s.password) payload.password = s.password;
            try {
                const updated = await api.adminUpdateUser(s.selectedUser.id, payload);
                s.selectedUser = updated;
                s.password = '';
                toast('已儲存', 'success');
                drawForm();
            } catch (err) {
                toast(err.body?.error || t.generalError, 'error');
            } finally {
                btn.disabled = false;
            }
        });
    }
}

// ─── Section: Create competition ────────────────────────────────────────

function renderCreateComp(root) {
    const s = state.createComp;
    root.innerHTML = `
        <form class="admin-form" data-form>
            ${labeledInput(t.displayName, 'display_name', s.display_name, 'text', 'required maxlength=20')}
            ${labeledTextarea(t.descriptionLabel, 'description', s.description)}
            ${labeledInput(t.startTime, 'start_time_utc', s.start_time_utc, 'datetime-local', 'required')}
            ${labeledInput(t.endTime, 'end_time_utc', s.end_time_utc, 'datetime-local', 'required')}
            ${labeledInput(t.gameRef, 'game_reference', s.game_reference, 'text', 'required')}
            ${labeledInput(t.helperRef, 'helper_reference', s.helper_reference, 'text', 'required')}
            ${labeledInput(t.manifestRef, 'manifest_reference', s.manifest_reference, 'text', 'required')}
            <div class="admin-field">
                <span>${t.npc}</span>
                <div data-npc-picker></div>
                <div class="admin-selected" data-npc-selected></div>
            </div>
            <div class="admin-actions">
                <button type="submit" class="confirm-btn">${t.create}</button>
            </div>
        </form>
    `;
    const form = root.querySelector('[data-form]');
    const npcSlot = root.querySelector('[data-npc-picker]');
    const npcSelected = root.querySelector('[data-npc-selected]');

    function drawNpcSelected() {
        if (s.npc) {
            npcSelected.innerHTML = `
                <span class="pill pill-success">
                    ${escapeHtml(s.npc.username)} — ${escapeHtml(s.npc.full_name)}
                </span>
                <button type="button" class="link-btn" data-clear>${t.cancel}</button>
            `;
            npcSelected.querySelector('[data-clear]').addEventListener('click', () => {
                s.npc = null;
                drawNpcSelected();
            });
        } else {
            npcSelected.innerHTML = '';
        }
    }
    const npcPicker = createSearchPicker({
        placeholder: `${t.search}：${t.username} / ${t.fullName}`,
        fetchResults: (q) => api.adminListUsers(q),
        renderRow: (u) => `<strong>${escapeHtml(u.username)}</strong> — ${escapeHtml(u.full_name)}`,
        onPick: (u) => {
            s.npc = { id: u.id, username: u.username, full_name: u.full_name };
            drawNpcSelected();
            npcPicker.clear();
        },
    });
    npcSlot.appendChild(npcPicker.el);
    drawNpcSelected();

    form.addEventListener('input', () => {
        s.display_name = form.display_name.value;
        s.description = form.description.value;
        s.start_time_utc = form.start_time_utc.value;
        s.end_time_utc = form.end_time_utc.value;
        s.game_reference = form.game_reference.value;
        s.helper_reference = form.helper_reference.value;
        s.manifest_reference = form.manifest_reference.value;
    });
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!s.npc) {
            toast(`${t.npc}：${t.selectCompetition.replace('比賽', t.username)}`, 'error');
            return;
        }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            await api.adminCreateCompetition({
                npc_user_id: s.npc.id,
                display_name: s.display_name.trim(),
                description: s.description,
                start_time_utc: fromLocalDatetimeInputValue(s.start_time_utc),
                end_time_utc: fromLocalDatetimeInputValue(s.end_time_utc),
                game_reference: s.game_reference.trim(),
                helper_reference: s.helper_reference.trim(),
                manifest_reference: s.manifest_reference.trim(),
            });
            toast('已建立', 'success');
            // Reset the form.
            Object.assign(s, {
                display_name: '', description: '',
                start_time_utc: '', end_time_utc: '',
                game_reference: '', helper_reference: '', manifest_reference: '',
                npc: null,
            });
            renderCreateComp(root);
        } catch (err) {
            toast(err.body?.error || t.generalError, 'error');
        } finally {
            btn.disabled = false;
        }
    });
}

// ─── Section: Edit competition ──────────────────────────────────────────

function renderEditComp(root) {
    const s = state.editComp;
    root.innerHTML = `
        <div class="admin-picker-wrap"></div>
        <div class="admin-form" data-form-slot></div>
    `;
    const pickerWrap = root.querySelector('.admin-picker-wrap');
    const formSlot = root.querySelector('[data-form-slot]');

    const picker = createSearchPicker({
        placeholder: `${t.search}：${t.displayName}`,
        fetchResults: (q) => api.adminListCompetitions(q),
        renderRow: (c) => `<strong>${escapeHtml(c.display_name)}</strong>`,
        onPick: async (c) => {
            s.selectedComp = c;
            s.form = {
                display_name: c.display_name,
                description: c.description || '',
                start_time_utc: toLocalDatetimeInputValue(c.start_time_utc),
                end_time_utc: toLocalDatetimeInputValue(c.end_time_utc),
                game_reference: c.game_reference,
                helper_reference: c.helper_reference,
                manifest_reference: c.manifest_reference,
            };
            drawForm();
        },
        initialValue: s.selectedComp ? s.selectedComp.display_name : '',
    });
    pickerWrap.appendChild(picker.el);
    drawForm();

    function drawForm() {
        if (!s.selectedComp || !s.form) {
            formSlot.innerHTML = `<div style="color:#94a3b8; padding:1rem; text-align:center;">${t.selectCompetition}</div>`;
            return;
        }
        const f = s.form;
        formSlot.innerHTML = `
            <form class="admin-form" data-form>
                ${labeledInput(t.displayName, 'display_name', f.display_name, 'text', 'required maxlength=20')}
                ${labeledTextarea(t.descriptionLabel, 'description', f.description)}
                ${labeledInput(t.startTime, 'start_time_utc', f.start_time_utc, 'datetime-local', 'required')}
                ${labeledInput(t.endTime, 'end_time_utc', f.end_time_utc, 'datetime-local', 'required')}
                ${labeledInput(t.gameRef, 'game_reference', f.game_reference, 'text', 'required')}
                ${labeledInput(t.helperRef, 'helper_reference', f.helper_reference, 'text', 'required')}
                ${labeledInput(t.manifestRef, 'manifest_reference', f.manifest_reference, 'text', 'required')}
                <div class="admin-actions">
                    <button type="submit" class="confirm-btn">${t.save}</button>
                </div>
            </form>
        `;
        const form = formSlot.querySelector('[data-form]');
        form.addEventListener('input', () => {
            f.display_name = form.display_name.value;
            f.description = form.description.value;
            f.start_time_utc = form.start_time_utc.value;
            f.end_time_utc = form.end_time_utc.value;
            f.game_reference = form.game_reference.value;
            f.helper_reference = form.helper_reference.value;
            f.manifest_reference = form.manifest_reference.value;
        });
        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const btn = form.querySelector('button[type=submit]');
            btn.disabled = true;
            try {
                const updated = await api.adminUpdateCompetition(s.selectedComp.id, {
                    display_name: f.display_name.trim(),
                    description: f.description,
                    start_time_utc: fromLocalDatetimeInputValue(f.start_time_utc),
                    end_time_utc: fromLocalDatetimeInputValue(f.end_time_utc),
                    game_reference: f.game_reference.trim(),
                    helper_reference: f.helper_reference.trim(),
                    manifest_reference: f.manifest_reference.trim(),
                });
                s.selectedComp = updated;
                toast('已儲存', 'success');
            } catch (err) {
                toast(err.body?.error || t.generalError, 'error');
            } finally {
                btn.disabled = false;
            }
        });
    }
}

// ─── Section: Manage enrollments ────────────────────────────────────────

function renderEnrolls(root) {
    const s = state.enrolls;
    root.innerHTML = `
        <div class="admin-picker-wrap"></div>
        <div data-enroll-body></div>
    `;
    const pickerWrap = root.querySelector('.admin-picker-wrap');
    const body = root.querySelector('[data-enroll-body]');

    const compPicker = createSearchPicker({
        placeholder: `${t.search}：${t.displayName}`,
        fetchResults: (q) => api.adminListCompetitions(q),
        renderRow: (c) => `<strong>${escapeHtml(c.display_name)}</strong>`,
        onPick: async (c) => {
            s.selectedComp = c;
            await reloadList();
        },
        initialValue: s.selectedComp ? s.selectedComp.display_name : '',
    });
    pickerWrap.appendChild(compPicker.el);
    if (s.selectedComp) reloadList(); else drawList();

    async function reloadList() {
        s.list = null;
        drawList();
        try {
            s.list = await api.adminListCompetitionEnrolls(s.selectedComp.id);
        } catch (err) {
            s.list = [];
            toast(err.body?.error || t.generalError, 'error');
        }
        drawList();
    }

    function drawList() {
        if (!s.selectedComp) {
            body.innerHTML = `<div style="color:#94a3b8; padding:1rem; text-align:center;">${t.selectCompetition}</div>`;
            return;
        }
        body.innerHTML = `
            <div class="admin-subtitle">${escapeHtml(s.selectedComp.display_name)}</div>
            <div class="admin-add-user">
                <span>${t.add} ${t.username}：</span>
                <div data-user-picker></div>
            </div>
            <div class="admin-enroll-list" data-enroll-list></div>
        `;

        const userPicker = createSearchPicker({
            placeholder: `${t.search}：${t.username} / ${t.fullName}`,
            fetchResults: (q) => api.adminListUsers(q),
            renderRow: (u) => `<strong>${escapeHtml(u.username)}</strong> — ${escapeHtml(u.full_name)}`,
            onPick: async (u) => {
                try {
                    await api.adminCreateEnroll(s.selectedComp.id, u.id);
                    toast(`已加入 ${u.username}`, 'success');
                    userPicker.clear();
                    await reloadList();
                } catch (err) {
                    toast(err.body?.error || t.generalError, 'error');
                }
            },
        });
        body.querySelector('[data-user-picker]').appendChild(userPicker.el);

        const listEl = body.querySelector('[data-enroll-list]');
        if (s.list === null) {
            listEl.innerHTML = `<div style="color:#94a3b8; padding:1rem; text-align:center;">…</div>`;
            return;
        }
        if (s.list.length === 0) {
            listEl.innerHTML = `<div style="color:#94a3b8; padding:1rem; text-align:center;">${t.noResult}</div>`;
            return;
        }
        listEl.innerHTML = s.list.map(row => `
            <div class="admin-enroll-row">
                <div class="admin-enroll-user">
                    <strong>${escapeHtml(row.username)}</strong>
                    <span style="color:#64748b;">${escapeHtml(row.full_name)}</span>
                </div>
                <div class="admin-enroll-stats">
                    ${t.win_short} ${row.win_count} /
                    ${t.lose_short} ${row.lose_count} /
                    ${t.tie_short} ${row.tie_count}
                </div>
                <div class="admin-enroll-status">
                    ${row.code_tested
                        ? `<span class="pill pill-success">${t.codeTested}</span>`
                        : (row.has_code
                            ? `<span class="pill pill-testing">${t.codeNotTested}</span>`
                            : `<span class="pill pill-infra-error">${t.noLinkedCodeShort}</span>`)}
                </div>
                <button class="link-btn danger" data-enroll="${row.enroll_id}" data-uname="${escapeAttr(row.username)}">${t.remove}</button>
            </div>
        `).join('');
        listEl.querySelectorAll('button[data-enroll]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm(`${t.remove} ${btn.dataset.uname}?`)) return;
                btn.disabled = true;
                try {
                    await api.adminDeleteEnroll(btn.dataset.enroll);
                    toast('已移除', 'success');
                    await reloadList();
                } catch (err) {
                    toast(err.body?.error || t.generalError, 'error');
                    btn.disabled = false;
                }
            });
        });
    }
}

// ─── Section: Approve code ──────────────────────────────────────────────

function renderApprove(root) {
    const s = state.approve;
    root.innerHTML = `
        <div class="admin-picker-wrap"></div>
        <div data-approve-body></div>
    `;
    const pickerWrap = root.querySelector('.admin-picker-wrap');
    const body = root.querySelector('[data-approve-body]');

    const compPicker = createSearchPicker({
        placeholder: `${t.search}：${t.displayName}`,
        fetchResults: (q) => api.adminListCompetitions(q),
        renderRow: (c) => `<strong>${escapeHtml(c.display_name)}</strong>`,
        onPick: async (c) => {
            s.selectedComp = c;
            await reloadList();
        },
        initialValue: s.selectedComp ? s.selectedComp.display_name : '',
    });
    pickerWrap.appendChild(compPicker.el);
    if (s.selectedComp) reloadList(); else drawList();

    async function reloadList() {
        s.list = null;
        drawList();
        try {
            s.list = await api.adminListCompetitionEnrolls(s.selectedComp.id);
        } catch (err) {
            s.list = [];
            toast(err.body?.error || t.generalError, 'error');
        }
        drawList();
    }

    function drawList() {
        if (!s.selectedComp) {
            body.innerHTML = `<div style="color:#94a3b8; padding:1rem; text-align:center;">${t.selectCompetition}</div>`;
            return;
        }
        if (s.list === null) {
            body.innerHTML = `<div style="color:#94a3b8; padding:1rem; text-align:center;">…</div>`;
            return;
        }
        body.innerHTML = `
            <div class="admin-subtitle">${escapeHtml(s.selectedComp.display_name)}</div>
            <div class="admin-enroll-list" data-list></div>
        `;
        const listEl = body.querySelector('[data-list]');
        if (s.list.length === 0) {
            listEl.innerHTML = `<div style="color:#94a3b8; padding:1rem; text-align:center;">${t.noResult}</div>`;
            return;
        }
        listEl.innerHTML = s.list.map(row => `
            <div class="admin-enroll-row">
                <div class="admin-enroll-user">
                    <strong>${escapeHtml(row.username)}</strong>
                    <span style="color:#64748b;">${escapeHtml(row.full_name)}</span>
                </div>
                <div class="admin-enroll-status">
                    ${row.code_tested
                        ? `<span class="pill pill-success">${t.codeTested}</span>`
                        : (row.has_code
                            ? `<span class="pill pill-testing">${t.codeNotTested}</span>`
                            : `<span class="pill pill-infra-error">${t.noLinkedCodeShort}</span>`)}
                </div>
                ${row.has_code && !row.code_tested
                    ? `<button class="confirm-btn" data-uid="${row.user_id}">${t.approve}</button>`
                    : `<span></span>`}
            </div>
        `).join('');
        listEl.querySelectorAll('button[data-uid]').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    await api.adminApproveCode(s.selectedComp.id, btn.dataset.uid);
                    toast('已批准', 'success');
                    await reloadList();
                } catch (err) {
                    toast(err.body?.error || t.generalError, 'error');
                    btn.disabled = false;
                }
            });
        });
    }
}
