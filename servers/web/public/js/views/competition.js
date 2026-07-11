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
        <div class="pvp-panel">
            <div class="pvp-panel-header">${t.yourCode}</div>
            <div class="pvp-panel-body" data-code-body>
                <div style="color:#94a3b8; text-align:center; padding:2rem;">載入中...</div>
            </div>
        </div>
    `;
    app.appendChild(container);

    container.querySelector('.back-btn').addEventListener('click', () => {
        location.hash = '#/dashboard';
    });

    let enroll, hist, linkedCode;
    try {
        enroll = await api.getEnroll(enrollId);
        [hist, linkedCode] = await Promise.all([
            api.getCompetitionHistogram(enroll.competition_id),
            api.getLinkedCode(enrollId).catch(() => null),
        ]);
    } catch (err) {
        container.querySelector('[data-comp-body]').innerHTML =
            `<div style="color:#e63946;">${t.generalError}</div>`;
        return;
    }

    container.querySelector('[data-comp-name]').textContent = enroll.competition_display_name || '';

    const compBody = container.querySelector('[data-comp-body]');
    renderCompBody();

    const codeBody = container.querySelector('[data-code-body]');
    renderCodeBody();

    // Countdown ticker
    const timer = setInterval(updateCountdown, 30_000);

    // Auto-cleanup on route change
    window.addEventListener('hashchange', () => clearInterval(timer), { once: true });

    function renderCompBody() {
        compBody.innerHTML = '';

        const scoreRow = document.createElement('div');
        scoreRow.style.display = 'flex';
        scoreRow.style.justifyContent = 'space-around';
        scoreRow.style.padding = '1rem 0 1.5rem';
        scoreRow.style.fontSize = '1.15rem';
        scoreRow.innerHTML = `
            <div><span style="color:#64748b;">${t.win_short}：</span><strong>${enroll.win_count}</strong></div>
            <div><span style="color:#64748b;">${t.lose_short}：</span><strong>${enroll.lose_count}</strong></div>
            <div><span style="color:#64748b;">${t.tie_short}：</span><strong>${enroll.tie_count}</strong></div>
        `;
        compBody.appendChild(scoreRow);

        // Histogram
        const histWrap = document.createElement('div');
        histWrap.style.margin = '1rem 0';
        histWrap.appendChild(renderHistogram(hist));
        compBody.appendChild(histWrap);

        // Countdown
        const countdown = document.createElement('div');
        countdown.className = 'countdown';
        countdown.style.textAlign = 'center';
        countdown.style.margin = '1rem 0';
        countdown.style.fontSize = '1.05rem';
        compBody.appendChild(countdown);

        // Battle button
        const btnWrap = document.createElement('div');
        btnWrap.style.textAlign = 'center';
        btnWrap.style.marginTop = '1.5rem';
        const btn = document.createElement('button');
        btn.className = 'battle-btn';
        btn.textContent = t.battle;
        btn.addEventListener('click', onBattle);
        btnWrap.appendChild(btn);
        compBody.appendChild(btnWrap);

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
        if (!linkedCode) {
            codeBody.innerHTML = `<div style="color:#94a3b8; text-align:center; padding:2rem;">${t.noLinkedCode}</div>`;
            return;
        }
        const card = document.createElement('div');
        card.className = 'pvp-card';
        // find last-tested via /code snapshot (fast: just use tested flag we have)
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
    }
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
