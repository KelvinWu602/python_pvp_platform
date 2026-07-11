import { t, fmtDateTime } from '../i18n.js';
import { api, videoUrl } from '../api.js';
import { getToken } from '../auth.js';
import { renderHeader } from '../components/header.js';

export async function renderTestResult(testId) {
    const app = document.getElementById('app');
    app.appendChild(renderHeader());

    const container = document.createElement('div');
    container.className = 'two-col';
    container.innerHTML = `
        <div class="pvp-panel">
            <div class="pvp-panel-header">
                <button class="back-btn" title="返回">⬅</button>
                <span data-code-name>${t.test}</span>
            </div>
            <div class="pvp-panel-body" data-info>
                <div style="color:#94a3b8; text-align:center; padding:2rem;">載入中...</div>
            </div>
        </div>
        <div class="pvp-panel">
            <div class="pvp-panel-header">${t.testResult}</div>
            <div class="pvp-panel-body" data-video>
                <div class="video-container"><div class="spinner"></div></div>
            </div>
        </div>
    `;
    app.appendChild(container);

    container.querySelector('.back-btn').addEventListener('click', () => {
        history.length > 1 ? history.back() : (location.hash = '#/dashboard');
    });

    const infoBox = container.querySelector('[data-info]');
    const videoBox = container.querySelector('[data-video]');

    let stop = false;
    window.addEventListener('hashchange', () => { stop = true; }, { once: true });

    async function poll() {
        while (!stop) {
            let test;
            try { test = await api.getTest(testId); }
            catch (err) {
                infoBox.innerHTML = `<div style="color:#e63946;">${t.loadFailed}</div>`;
                return;
            }
            renderInfo(test);
            renderVideo(test);
            if (test.infra_ok !== null) return; // done
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    poll();

    function renderInfo(test) {
        // Header: identify which snapshot
        const isDone = test.infra_ok !== null;
        const success = test.infra_ok === true && test.input_ok === true;
        const failed = test.infra_ok === false || test.input_ok === false;

        let resultBadge = '';
        if (isDone) {
            if (success) {
                if (test.draw) resultBadge = `<span class="badge-draw">${t.draw}</span>`;
                else if (test.winner_user_id === test.a_user_id) resultBadge = `<span class="badge-win">${t.win}</span>`;
                else resultBadge = `<span class="badge-lose">${t.lose}</span>`;
            } else {
                resultBadge = `<span class="badge-lose">${t.fail}</span>`;
            }
        } else {
            resultBadge = `<span style="color:#64748b;">${t.inProgress}</span>`;
        }

        infoBox.innerHTML = `
            <div class="pvp-card-sub" style="text-align:center; padding: 0.5rem 0 1rem;">
                ${t.updated}：${fmtDateTime(test.updated_at_utc || test.created_at_utc)}
            </div>
            <div class="pvp-card" style="flex-direction:column; align-items:flex-start; cursor:default;">
                <div style="width:100%; display:flex; justify-content:space-between; padding:0.25rem 0;">
                    <span>${t.testStatus}：</span>
                    ${isDone
                        ? (success
                            ? `<span class="badge-success">${t.success}</span>`
                            : `<span class="badge-lose">${t.fail}</span>`)
                        : `<span style="color:#64748b;">${t.inProgress}</span>`}
                </div>
                <div style="width:100%; display:flex; justify-content:space-between; padding:0.25rem 0;">
                    <span>${t.battleResult}：</span>
                    ${resultBadge}
                </div>
            </div>
            <div class="pvp-card" style="flex-direction:column; align-items:flex-start; cursor:default;">
                <div style="font-weight:600; margin-bottom:0.5rem;">${t.output}</div>
                <pre style="width:100%; margin:0; white-space:pre-wrap; word-break:break-all; font-family:'JetBrains Mono',monospace; font-size:0.85rem; color:#334155;">${escapeHtml(test.a_stdout_log || '')}</pre>
            </div>
            <div class="pvp-card" style="flex-direction:column; align-items:flex-start; cursor:default;">
                <div style="font-weight:600; margin-bottom:0.5rem;">${t.errorMessage}</div>
                <pre style="width:100%; margin:0; white-space:pre-wrap; word-break:break-all; font-family:'JetBrains Mono',monospace; font-size:0.85rem; color:#e63946;">${escapeHtml(test.a_stderr_log || '')}</pre>
            </div>
        `;
    }

    function renderVideo(test) {
        videoBox.innerHTML = '';
        const isDone = test.infra_ok !== null;
        if (!isDone) {
            videoBox.innerHTML = `<div class="video-container"><div class="spinner"></div></div>`;
            return;
        }
        const url = videoUrl(test.video_reference);
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

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
