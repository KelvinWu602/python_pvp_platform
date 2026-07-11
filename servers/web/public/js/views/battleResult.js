import { t } from '../i18n.js';
import { api, videoUrl } from '../api.js';
import { renderHeader } from '../components/header.js';

export async function renderBattleResult(battleId) {
    const app = document.getElementById('app');
    app.appendChild(renderHeader());

    const container = document.createElement('div');
    container.className = 'two-col';
    container.innerHTML = `
        <div class="pvp-panel">
            <div class="pvp-panel-header">
                <button class="back-btn" title="返回">⬅</button>
                <span data-comp-name>${t.battle}</span>
            </div>
            <div class="pvp-panel-body" data-info>
                <div style="color:#94a3b8; text-align:center; padding:2rem;">載入中...</div>
            </div>
        </div>
        <div class="pvp-panel">
            <div class="pvp-panel-header">${t.battleVideo}</div>
            <div class="pvp-panel-body" data-video>
                <div class="video-container"><div class="spinner"></div></div>
            </div>
        </div>
    `;
    app.appendChild(container);

    let backEnrollId = null;
    container.querySelector('.back-btn').addEventListener('click', () => {
        if (backEnrollId) location.hash = `#/competition/${backEnrollId}`;
        else history.length > 1 ? history.back() : (location.hash = '#/dashboard');
    });

    const infoBox = container.querySelector('[data-info]');
    const videoBox = container.querySelector('[data-video]');

    let stop = false;
    window.addEventListener('hashchange', () => { stop = true; }, { once: true });

    // Fetch competition name once
    let compName = '';
    let selfEnrollId = null;
    let opponentEnroll = null;
    let selfEnroll = null;

    let battle;
    try {
        battle = await api.getBattle(battleId);
    } catch (err) {
        infoBox.innerHTML = `<div style="color:#e63946;">${t.loadFailed}</div>`;
        return;
    }

    try {
        const comp = await api.getCompetition(battle.competition_id);
        compName = comp.display_name;
        container.querySelector('[data-comp-name]').textContent = compName;
    } catch { /* best effort */ }

    // Determine my side + opponent id via listEnrolls
    try {
        const enrolls = await api.listEnrolls();
        // The API only returns your own enrolls; find the one for this competition
        selfEnroll = enrolls.find(e => e.competition_id === battle.competition_id);
        if (selfEnroll) {
            selfEnrollId = selfEnroll.id;
            backEnrollId = selfEnroll.id;
        }
    } catch { /* fall through */ }

    // Get opponent's enroll stats (not directly available — inferred via battle list is heavy).
    // Skip for now (design's opponent score is a nice-to-have; without user-listing endpoint we can't fetch).
    // Fall back to showing "N/A" for opponent score.

    async function poll() {
        while (!stop) {
            try { battle = await api.getBattle(battleId); }
            catch (err) {
                infoBox.innerHTML = `<div style="color:#e63946;">${t.loadFailed}</div>`;
                return;
            }
            renderInfo();
            renderVideo();
            if (battle.infra_ok !== null) return;
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    // Re-fetch selfEnroll to have latest counts
    async function pollWithCounts() {
        while (!stop) {
            try {
                battle = await api.getBattle(battleId);
                if (selfEnroll) {
                    try { selfEnroll = await api.getEnroll(selfEnroll.id); } catch {}
                }
            } catch (err) {
                infoBox.innerHTML = `<div style="color:#e63946;">${t.loadFailed}</div>`;
                return;
            }
            renderInfo();
            renderVideo();
            if (battle.infra_ok !== null) return;
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    pollWithCounts();

    function renderInfo() {
        const isDone = battle.infra_ok !== null;
        const success = battle.infra_ok === true && battle.input_ok === true;
        const failed = battle.infra_ok === false || battle.input_ok === false;

        // Determine which side is "me"
        const iAmA = selfEnroll && battle.a_user_id === selfEnroll.user_id;
        const iAmB = selfEnroll && battle.b_user_id === selfEnroll.user_id;

        let banner = '';
        if (isDone) {
            if (failed) {
                banner = `
                    <div style="text-align:center; padding: 2rem 0;">
                        <div style="color:var(--color-accent); font-size:1.5rem; font-weight:700;">
                            ${t.errorOccurred}<br>${t.returnForNext}
                        </div>
                    </div>
                `;
            } else if (battle.draw) {
                banner = `<div style="text-align:center; padding: 1rem 0; color:var(--color-accent); font-size:2rem; font-weight:700;">${t.drawBanner}</div>`;
            } else {
                const iWon = (iAmA && battle.winner_user_id === battle.a_user_id) ||
                             (iAmB && battle.winner_user_id === battle.b_user_id);
                banner = `<div style="text-align:center; padding: 1rem 0; color:${iWon?'var(--color-accent)':'var(--color-lose)'}; font-size:2rem; font-weight:700;">
                    ${iWon ? t.winBanner : t.loseBanner}
                </div>`;
            }
        }

        const myScore = selfEnroll
            ? `${t.win_short}：<strong>${selfEnroll.win_count}</strong>&nbsp;&nbsp;
               ${t.lose_short}：<strong>${selfEnroll.lose_count}</strong>&nbsp;&nbsp;
               ${t.tie_short}：<strong>${selfEnroll.tie_count}</strong>`
            : '';

        infoBox.innerHTML = `
            ${banner}
            <div style="margin: 1rem 0;">
                <div style="margin-bottom: 0.75rem; font-size:1.05rem;">
                    <span style="color:#64748b; margin-right: 1rem;">${t.yourScore}</span>
                    ${myScore}
                </div>
                ${!isDone ? `
                    <div style="text-align:center; margin-top:2rem;">
                        <button class="battle-btn" disabled>${t.inProgress}</button>
                    </div>
                ` : `
                    <div style="text-align:center; margin-top:2rem;">
                        <button class="battle-btn" data-again>${t.battle}</button>
                    </div>
                `}
            </div>
        `;

        const again = infoBox.querySelector('[data-again]');
        if (again) {
            again.addEventListener('click', async () => {
                if (!selfEnrollId) return;
                again.disabled = true;
                again.textContent = '...';
                try {
                    const res = await api.createBattle(selfEnrollId);
                    location.hash = `#/battle/${res.id}`;
                } catch (err) {
                    again.disabled = false;
                    again.textContent = t.battle;
                }
            });
        }
    }

    function renderVideo() {
        videoBox.innerHTML = '';
        const isDone = battle.infra_ok !== null;
        const failed = battle.infra_ok === false || battle.input_ok === false;
        if (!isDone) {
            videoBox.innerHTML = `<div class="video-container"><div class="spinner"></div></div>`;
            return;
        }
        if (failed) {
            videoBox.innerHTML = `<div class="video-container"><div style="color:#94a3b8;">${t.loadFailed}</div></div>`;
            return;
        }
        const url = videoUrl(battle.video_reference);
        if (!url) {
            videoBox.innerHTML = `<div class="video-container"><div style="color:#94a3b8;">${t.loadFailed}</div></div>`;
            return;
        }
        const vc = document.createElement('div');
        vc.className = 'video-container';
        vc.innerHTML = `<video src="${url}" controls autoplay muted loop></video>`;
        videoBox.appendChild(vc);
    }
}
