import { t, fmt, fmtDateTime } from '../i18n.js';
import { api } from '../api.js';
import { renderHeader } from '../components/header.js';
import { renderHistogram } from '../components/histogram.js';
import { toast } from '../components/toast.js';

export async function renderCompetition(enrollId) {
    const app = document.getElementById('app');
    app.appendChild(renderHeader());

    const container = document.createElement('div');
    container.className = 'two-col';
    container.innerHTML = `
        <div class="pvp-panel">
            <div class="pvp-panel-header">
                <button class="back-btn" title="返回">⬅</button>
                <span data-comp-name>比賽</span>
            </div>
            <div class="pvp-panel-body" data-comp-body>
                <div style="color:#94a3b8; text-align:center; padding:2rem;">載入中...</div>
            </div>
        </div>
        <div class="two-col-right">
            <div class="pvp-panel">
                <div class="pvp-panel-header">${t.battleCode}</div>
                <div class="pvp-panel-body" data-code-body>
                    <div style="color:#94a3b8; text-align:center; padding:2rem;">載入中...</div>
                </div>
            </div>
            <div class="pvp-panel">
                <div class="pvp-panel-header">${t.battleHistory}</div>
                <div class="pvp-panel-body" data-history-body>
                    <div style="color:#94a3b8; text-align:center; padding:2rem;">載入中...</div>
                </div>
            </div>
        </div>
    `;
    app.appendChild(container);

    container.querySelector('.back-btn').addEventListener('click', () => {
        location.hash = '#/dashboard';
    });

    let enroll, hist, linkedCode, battles;
    try {
        enroll = await api.getEnroll(enrollId);
        [hist, linkedCode, battles] = await Promise.all([
            api.getCompetitionHistogram(enroll.competition_id),
            api.getLinkedCode(enrollId).catch(() => null),
            api.listBattles(enrollId).catch(() => []),
        ]);
    } catch (err) {
        container.querySelector('[data-comp-body]').innerHTML =
            `<div style="color:#e63946;">${t.generalError}</div>`;
        return;
    }

    // Only completed, successful battles show in history — infra_error /
    // user_error entries are hidden client-side.
    const shownBattles = (battles || []).filter(
        b => b.infra_ok === true && b.input_ok === true
    );
    // How many rows are currently visible. "顯示更多" bumps by 10.
    let historyVisibleCount = 10;

    container.querySelector('[data-comp-name]').textContent = enroll.competition_display_name || '';

    const compBody = container.querySelector('[data-comp-body]');
    renderCompBody();

    const codeBody = container.querySelector('[data-code-body]');
    const historyBody = container.querySelector('[data-history-body]');
    renderCodeBody();
    renderHistoryBody();

    // Countdown ticker
    const timer = setInterval(updateCountdown, 30_000);

    // Auto-cleanup on route change
    window.addEventListener('hashchange', () => clearInterval(timer), { once: true });

    function renderCompBody() {
        compBody.innerHTML = '';
        // Vertically center the summary cluster so we don't have a big empty
        // chunk at the bottom of the panel.
        compBody.classList.add('comp-body-center');

        const wrap = document.createElement('div');
        wrap.className = 'comp-summary';
        compBody.appendChild(wrap);

        // ── Stats pills (win / lose / draw) with animated emojis ──────────
        const stats = document.createElement('div');
        stats.className = 'stats-row';
        stats.innerHTML = `
            <div class="stat-pill stat-win">
                <span class="stat-emoji">🏆</span>
                <div>
                    <div class="stat-label">${t.win_short}</div>
                    <div class="stat-value">${enroll.win_count}</div>
                </div>
            </div>
            <div class="stat-pill stat-lose">
                <span class="stat-emoji">😢</span>
                <div>
                    <div class="stat-label">${t.lose_short}</div>
                    <div class="stat-value">${enroll.lose_count}</div>
                </div>
            </div>
            <div class="stat-pill stat-draw">
                <span class="stat-emoji">🤝</span>
                <div>
                    <div class="stat-label">${t.tie_short}</div>
                    <div class="stat-value">${enroll.tie_count}</div>
                </div>
            </div>
        `;
        wrap.appendChild(stats);

        // ── Histogram (returns its own rounded container) ─────────────────
        wrap.appendChild(renderHistogram(hist));

        // ── Countdown ─────────────────────────────────────────────────────
        const countdown = document.createElement('div');
        countdown.className = 'countdown';
        countdown.style.textAlign = 'center';
        countdown.style.fontSize = '1.05rem';
        wrap.appendChild(countdown);

        // ── Battle button ─────────────────────────────────────────────────
        const btnWrap = document.createElement('div');
        btnWrap.style.textAlign = 'center';
        const btn = document.createElement('button');
        btn.className = 'battle-btn';
        btn.textContent = t.battle;
        btn.addEventListener('click', onBattle);
        btnWrap.appendChild(btn);
        wrap.appendChild(btnWrap);

        updateCountdown();
    }

    function updateCountdown() {
        const el = compBody.querySelector('.countdown');
        if (!el) return;
        const now = Date.now();
        const start = new Date(enroll.start_time_utc).getTime();
        const end = new Date(enroll.end_time_utc).getTime();
        let msg, cls = '';
        if (now < start) {
            msg = t.notStarted;
            cls = 'color:#64748b;';
        } else if (now > end) {
            msg = t.ended;
            cls = 'color:#e63946;';
        } else {
            const remainingMs = end - now;
            const days = Math.floor(remainingMs / (24 * 3600_000));
            const hours = Math.floor(remainingMs / 3600_000);
            const mins = Math.floor(remainingMs / 60_000);
            if (days >= 2) msg = fmt(t.daysLeft, { n: days });
            else if (hours >= 2) msg = fmt(t.hoursLeft, { n: hours });
            else msg = fmt(t.minutesLeft, { n: Math.max(1, mins) });
            cls = 'color:var(--color-text);';
        }
        el.innerHTML = `<span style="${cls}">${escapeHtml(msg)}</span>`;

        // Disable battle button if not in window
        const btn = compBody.querySelector('.battle-btn');
        if (btn) {
            const inWindow = now >= start && now <= end;
            btn.disabled = !inWindow || !linkedCode;
        }
    }

    async function onBattle() {
        const btn = compBody.querySelector('.battle-btn');
        btn.disabled = true;
        btn.textContent = '正在建立...';
        try {
            const res = await api.createBattle(enrollId);
            location.hash = `#/battle/${res.id}`;
        } catch (err) {
            btn.disabled = false;
            btn.textContent = t.battle;
            toast(err.body?.error || t.noOpponent, 'error');
        }
    }

    function renderCodeBody() {
        codeBody.innerHTML = '';
        if (linkedCode) {
            const card = document.createElement('div');
            card.className = 'pvp-card';
            const lastLine = linkedCode.tested
                ? `${t.lastTested}：${fmtDateTime(linkedCode.updated_at_utc || linkedCode.created_at_utc)}`
                : '尚未測試';
            card.innerHTML = `
                <div style="flex:1;">
                    <div class="pvp-card-title">${escapeHtml(linkedCode.name)}</div>
                    <div class="pvp-card-sub">${lastLine}</div>
                </div>
            `;
            card.addEventListener('click', () => {
                location.hash = `#/code/${linkedCode.id}`;
            });
            codeBody.appendChild(card);
        } else {
            const empty = document.createElement('div');
            empty.style.color = '#94a3b8';
            empty.style.textAlign = 'center';
            empty.style.padding = '2rem';
            empty.textContent = t.noLinkedCode;
            codeBody.appendChild(empty);
        }
    }

    // Renders the battle history list into the second right-column panel.
    // The panel already carries its own orange 對戰紀錄 header (see the
    // top-level template), so this function only paints the body: rows,
    // empty-state placeholder, and the 顯示更多 button.
    function renderHistoryBody() {
        historyBody.innerHTML = '';
        renderHistoryList(historyBody);
    }

    // Render the visible slice of shownBattles into `listEl`. Called on first
    // render and again when the user clicks 顯示更多 to bump the count.
    function renderHistoryList(listEl) {
        listEl.innerHTML = '';
        if (shownBattles.length === 0) {
            listEl.innerHTML = `<div style="color:#94a3b8; padding:1rem; text-align:center;">${t.noBattleHistory}</div>`;
            return;
        }
        const me = enroll.user_id;
        const slice = shownBattles.slice(0, historyVisibleCount);
        for (const b of slice) {
            let outcome, label;
            if (b.draw) { outcome = 'draw'; label = t.draw; }
            else if (b.winner_user_id === me) { outcome = 'win'; label = t.win; }
            else { outcome = 'lose'; label = t.lose; }

            const opponentName = b.opponent_full_name || b.opponent_username || '';
            const row = document.createElement('div');
            row.className = 'pvp-card';
            row.style.cursor = 'pointer';
            row.innerHTML = `
                <div style="flex:1;">
                    <div class="pvp-card-title">vs ${escapeHtml(opponentName)}</div>
                    <div class="pvp-card-sub">${fmtDateTime(b.created_at_utc)}</div>
                </div>
                <span class="badge-${outcome}">${label}</span>
            `;
            row.addEventListener('click', () => {
                location.hash = `#/battle/${b.id}`;
            });
            listEl.appendChild(row);
        }
        // 顯示更多 button when more rows exist beyond the current window.
        if (shownBattles.length > historyVisibleCount) {
            const moreWrap = document.createElement('div');
            moreWrap.style.textAlign = 'center';
            moreWrap.style.marginTop = '0.5rem';
            const moreBtn = document.createElement('button');
            moreBtn.className = 'link-btn';
            moreBtn.textContent = t.loadMore;
            moreBtn.addEventListener('click', () => {
                historyVisibleCount += 10;
                renderHistoryList(listEl);
            });
            moreWrap.appendChild(moreBtn);
            listEl.appendChild(moreWrap);
        }
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
