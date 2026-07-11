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

    // Track <details> open state across polls. On the first render (both
    // null) we start closed, then auto-open the stderr card if there is
    // any stderr content. Subsequent polls preserve whatever the user set.
    let outputOpen = null;
    let errorOpen = null;

    function renderInfo(test) {
        const isDone = test.infra_ok !== null;
        const success = test.infra_ok === true && test.input_ok === true;

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

        // Capture prior open state before we blow away the DOM.
        const priorOutputEl = infoBox.querySelector('[data-output-details]');
        const priorErrorEl = infoBox.querySelector('[data-error-details]');
        if (priorOutputEl) outputOpen = priorOutputEl.open;
        if (priorErrorEl) errorOpen = priorErrorEl.open;

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
                <details class="log-details" data-output-details>
                    <summary>
                        <span class="log-title">${t.output}</span>
                        <span class="log-meta" data-output-meta></span>
                    </summary>
                    <div class="log-viewer" data-output-viewer></div>
                </details>
            </div>
            <div class="pvp-card" style="flex-direction:column; align-items:flex-start; cursor:default;">
                <details class="log-details" data-error-details>
                    <summary>
                        <span class="log-title log-title-error">${t.errorMessage}</span>
                        <span class="log-meta" data-error-meta></span>
                    </summary>
                    <div class="log-viewer log-viewer-error" data-error-viewer></div>
                </details>
            </div>
        `;

        fillLogViewer(
            infoBox.querySelector('[data-output-viewer]'),
            infoBox.querySelector('[data-output-meta]'),
            test.a_stdout_log
        );
        fillLogViewer(
            infoBox.querySelector('[data-error-viewer]'),
            infoBox.querySelector('[data-error-meta]'),
            test.a_stderr_log
        );

        // Restore prior open state; on the first render, default-open the
        // error card iff there's any stderr (errors are what users want
        // to see first).
        const outputDetails = infoBox.querySelector('[data-output-details]');
        const errorDetails = infoBox.querySelector('[data-error-details]');
        outputDetails.open = outputOpen === null ? false : outputOpen;
        if (errorOpen === null) {
            errorDetails.open = (test.a_stderr_log || '').length > 0;
        } else {
            errorDetails.open = errorOpen;
        }
    }

    // Populate a log viewer div with numbered rows. `text` may be null/undefined
    // (still loading) or empty string (test produced no output).
    function fillLogViewer(viewer, meta, text) {
        const str = text || '';
        if (!str) {
            viewer.innerHTML = `<div class="log-empty">${t.noOutput}</div>`;
            meta.textContent = '';
            return;
        }
        // Strip a single trailing newline so we don't render an empty last row.
        const trimmed = str.endsWith('\n') ? str.slice(0, -1) : str;
        const lines = trimmed.split('\n');
        meta.textContent = `(${lines.length} ${t.lines})`;
        // Right-align line numbers to the widest line-number width.
        const digits = String(lines.length).length;
        // Build with an array + join for speed with thousands of lines.
        const rows = new Array(lines.length);
        for (let i = 0; i < lines.length; i++) {
            const num = String(i + 1).padStart(digits, ' ');
            const body = escapeHtml(lines[i]) || '&nbsp;';
            rows[i] = `<div class="log-row"><span class="log-lineno">${num}</span><span class="log-line">${body}</span></div>`;
        }
        viewer.innerHTML = rows.join('');
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
