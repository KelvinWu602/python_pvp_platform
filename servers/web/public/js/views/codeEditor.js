import { t, fmtDateTime } from '../i18n.js';
import { api, fetchManifest } from '../api.js';
import { renderHeader } from '../components/header.js';
import { toast } from '../components/toast.js';
import { parseManifest, makePythonCompletionSource } from '../components/manifestCompletion.js';

// Code editor view.
//
// Page load fires four parallel requests:
//   GET /code/:cid                — metadata (name, enroll_id, ...)
//   GET /code/:cid/text           — latest snapshot text (may be null)
//   GET /code/:cid/snapshot       — snapshot list with test status
//   GET /competition/:cid/manifest — S3 reference for autocomplete data
//
// The API resolves `enroll_id` server-side for us, so we don't need to
// fetch the enroll list separately. The test button is enabled when the
// user is enrolled (code.enroll_id != null) and the latest snapshot is
// retestable (test_status null or 'infra_error').
export async function renderCodeEditor(codeId) {
    const app = document.getElementById('app');
    app.appendChild(renderHeader());

    const container = document.createElement('div');
    container.className = 'two-col';
    container.innerHTML = `
        <div class="pvp-panel">
            <div class="pvp-panel-header">
                <button class="back-btn" title="返回">⬅</button>
                <span data-code-name>代碼</span>
                <button class="refresh-btn" data-refresh title="${t.refresh}">↻</button>
            </div>
            <div class="pvp-panel-body" data-snap-list>
                <div style="color:#94a3b8; text-align:center; padding:2rem;">載入中...</div>
            </div>
        </div>
        <div class="pvp-panel">
            <div class="pvp-panel-header">
                ${t.editCode}
                <button class="save-btn" data-save>${t.save}</button>
            </div>
            <div class="pvp-panel-body" style="padding:0.5rem;" data-editor-body>
                <div class="cm-wrapper" data-cm></div>
            </div>
        </div>
    `;
    app.appendChild(container);

    container.querySelector('.back-btn').addEventListener('click', () => {
        history.length > 1 ? history.back() : (location.hash = '#/dashboard');
    });

    // Three independent requests in parallel. The manifest requires
    // competition_id (only known after getCode resolves), so it's chained
    // after this first batch.
    let code, codeText, snapshots;
    try {
        [code, { text: codeText }, snapshots] = await Promise.all([
            api.getCode(codeId),
            api.getCodeText(codeId),
            api.listSnapshots(codeId),
        ]);
    } catch (err) {
        container.querySelector('[data-snap-list]').innerHTML =
            `<div style="color:#e63946;">${t.generalError}</div>`;
        return;
    }

    container.querySelector('[data-code-name]').textContent = code.name;

    // Manifest fetch. Failure is non-fatal — editor still works, autocomplete
    // just falls back to no completion.
    let manifestResp = null;
    try {
        manifestResp = await api.getCompetitionManifest(code.competition_id);
    } catch { /* non-fatal */ }

    // Fetch manifest.json from S3 (public bucket, direct browser fetch).
    // Manifest drives autocomplete. Failure here is non-fatal — editor still
    // works, just without autocomplete.
    let manifest = null;
    if (manifestResp && manifestResp.reference) {
        manifest = await fetchManifest(manifestResp.reference);
    }
    const manifestData = manifest ? parseManifest(manifest) : null;
    const completionSource = manifestData ? makePythonCompletionSource(manifestData) : null;

    // Mount CodeMirror
    const cmHost = container.querySelector('[data-cm]');
    let view;
    try {
        // Explicit extension imports — avoids the meta-package `codemirror`'s
        // basicSetup which sometimes ships an inconsistent
        // @codemirror/language runtime and breaks syntax highlighting.
        const { EditorState } = await import('@codemirror/state');
        const {
            EditorView, keymap, lineNumbers, highlightActiveLine,
            highlightActiveLineGutter, highlightSpecialChars, drawSelection,
            dropCursor, rectangularSelection, crosshairCursor,
        } = await import('@codemirror/view');
        const {
            defaultHighlightStyle, syntaxHighlighting, indentOnInput,
            bracketMatching, foldGutter, foldKeymap, indentUnit,
        } = await import('@codemirror/language');
        const {
            defaultKeymap, history, historyKeymap, indentWithTab,
        } = await import('@codemirror/commands');
        const {
            autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
        } = await import('@codemirror/autocomplete');
        const { python } = await import('@codemirror/lang-python');
        const { oneDark } = await import('@codemirror/theme-one-dark');

        const extensions = [
            // Editor UX
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            foldGutter(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            // 4-space indentation. `indentUnit` drives indentMore/indentLess
            // (bound to Tab via indentWithTab below) and indentOnInput's
            // auto-indent after `:`. `tabSize` only affects the visual width
            // of any hard tab characters that end up in the doc.
            indentUnit.of('    '),
            EditorState.tabSize.of(4),
            indentOnInput(),
            // Syntax
            python(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            bracketMatching(),
            closeBrackets(),
            // Autocomplete
            autocompletion({
                override: completionSource ? [completionSource] : undefined,
                activateOnTyping: true,
                closeOnBlur: true,
                maxRenderedOptions: 20,
            }),
            rectangularSelection(),
            crosshairCursor(),
            highlightActiveLine(),
            // Keymaps
            keymap.of([
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...historyKeymap,
                ...foldKeymap,
                ...completionKeymap,
                indentWithTab,
            ]),
            // Theme
            oneDark,
            EditorView.theme({
                '&': { height: '100%' },
                '.cm-scroller': {
                    fontFamily: 'JetBrains Mono, Consolas, monospace',
                    fontSize: '14px',
                },
            }),
        ];

        view = new EditorView({
            parent: cmHost,
            state: EditorState.create({
                // codeText can be null when the code has no snapshot yet
                // (fresh from POST /enroll/:eid/code). Start with empty doc.
                doc: codeText ?? '',
                extensions,
            }),
        });

        if (!completionSource) {
            console.info('CodeEditor: no manifest available — autocomplete disabled.');
        } else {
            console.info(
                `CodeEditor: autocomplete active (${manifestData.helpers.length} helpers, ${manifestData.topLevelKeys.length} game_states keys).`
            );
        }
    } catch (err) {
        console.error('CodeMirror failed to load, falling back to textarea:', err);
        cmHost.innerHTML = '';
        const ta = document.createElement('textarea');
        ta.style.width = '100%';
        ta.style.height = '100%';
        ta.style.minHeight = '400px';
        ta.style.background = '#282c34';
        ta.style.color = '#abb2bf';
        ta.style.fontFamily = 'JetBrains Mono, Consolas, monospace';
        ta.style.padding = '1rem';
        ta.style.border = 'none';
        ta.value = codeText ?? '';
        cmHost.appendChild(ta);
        view = {
            state: { doc: { toString: () => ta.value } },
            dispatch: () => {},
        };
    }

    // Save handler — creates a new snapshot.
    const saveBtn = container.querySelector('[data-save]');
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = '...';
        try {
            const newCode = view.state.doc.toString();
            await api.createSnapshot(codeId, newCode);
            toast('已儲存', 'success');
            await refreshSnapshots();
        } catch (err) {
            toast(err.body?.error || t.generalError, 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = t.save;
        }
    });

    const snapList = container.querySelector('[data-snap-list]');
    const refreshBtn = container.querySelector('[data-refresh]');

    // ── Refresh + polling ────────────────────────────────────────────────
    //
    // Users need to see snapshot state flip from `pending` → success/failed
    // without a full page reload. Strategy:
    //   * Manual `↻` button: always re-fetches the whole list.
    //   * Auto-poll every 10s while ANY snapshot has test_status='pending'.
    //     Per-snapshot fetches (GET /code/:cid/snapshot/:sid) rather than
    //     re-listing everything — the list rarely changes; only pending
    //     rows do. Stops as soon as none are pending. Also cleaned up on
    //     hashchange so leaving the page doesn't keep firing requests.
    //
    // Silent errors: background polls swallow network errors (a transient
    // failure shouldn't blast a toast every 10s).
    let pollTimer = null;
    function schedulePollIfNeeded() {
        const anyPending = snapshots.some(s => s.test_status === 'pending');
        if (anyPending && !pollTimer) {
            pollTimer = setInterval(pollPending, 10000);
        } else if (!anyPending && pollTimer) {
            clearInterval(pollTimer); pollTimer = null;
        }
    }
    async function pollPending() {
        const pendingIds = snapshots
            .filter(s => s.test_status === 'pending')
            .map(s => s.id);
        if (pendingIds.length === 0) {
            clearInterval(pollTimer); pollTimer = null;
            return;
        }
        try {
            const updates = await Promise.all(
                pendingIds.map(id => api.getSnapshot(codeId, id).catch(() => null))
            );
            let changed = false;
            for (const u of updates) {
                if (!u) continue;
                const idx = snapshots.findIndex(s => s.id === u.id);
                if (idx >= 0) {
                    snapshots[idx] = u;
                    changed = true;
                }
            }
            if (changed) renderSnapshots();
            schedulePollIfNeeded();
        } catch { /* silent */ }
    }
    async function refreshSnapshots({ silent = false } = {}) {
        if (!silent) {
            refreshBtn.disabled = true;
            refreshBtn.classList.add('spinning');
        }
        try {
            snapshots = await api.listSnapshots(codeId);
            renderSnapshots();
            schedulePollIfNeeded();
        } catch (err) {
            if (!silent) toast(err.body?.error || t.generalError, 'error');
        } finally {
            if (!silent) {
                refreshBtn.disabled = false;
                refreshBtn.classList.remove('spinning');
            }
        }
    }
    refreshBtn.addEventListener('click', () => refreshSnapshots());
    window.addEventListener('hashchange', () => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }, { once: true });

    renderSnapshots();
    schedulePollIfNeeded();

    // ── Render ───────────────────────────────────────────────────────────
    function renderSnapshots() {
        snapList.innerHTML = '';
        if (snapshots.length === 0) {
            snapList.innerHTML = `<div style="color:#94a3b8; text-align:center; padding:2rem;">尚無 snapshot</div>`;
            return;
        }
        snapshots.forEach((s, i) => {
            const card = document.createElement('div');
            card.className = 'pvp-card';
            card.style.cursor = s.test_id ? 'pointer' : 'default';
            const isLatest = i === 0;

            // Derive retestable client-side: null (never tested) or
            // infra_error (platform-side failure) → retestable. success /
            // pending / user_error all block retesting.
            const retestable = s.test_status === null || s.test_status === 'infra_error';

            const left = document.createElement('div');
            left.style.flex = '1';
            left.innerHTML = `
                <div class="pvp-card-sub" style="font-size:1rem; color:var(--color-text);">
                    ${t.updated}：${fmtDateTime(s.created_at_utc)}
                </div>
            `;
            card.appendChild(left);

            const right = document.createElement('div');
            right.style.display = 'flex';
            right.style.alignItems = 'center';
            right.style.gap = '0.75rem';

            // Status badge — exactly one, based on test_status.
            switch (s.test_status) {
                case 'success': {
                    const pill = document.createElement('span');
                    pill.className = 'pill pill-success';
                    pill.textContent = t.testSuccess;
                    right.appendChild(pill);
                    break;
                }
                case 'pending': {
                    const pill = document.createElement('span');
                    pill.className = 'pill pill-testing';
                    pill.textContent = t.testing;
                    right.appendChild(pill);
                    break;
                }
                case 'user_error': {
                    const pill = document.createElement('span');
                    pill.className = 'pill pill-user-error';
                    pill.textContent = t.userError;
                    right.appendChild(pill);
                    break;
                }
                case 'infra_error': {
                    const pill = document.createElement('span');
                    pill.className = 'pill pill-infra-error';
                    pill.textContent = t.infraError;
                    right.appendChild(pill);
                    break;
                }
                default:
                    // null → never tested; no badge.
                    break;
            }

            // 測試 button: only on the latest snapshot, only when this
            // snapshot is retestable, and only when the caller is enrolled
            // in the code's competition (code.enroll_id is truthy — the
            // server derived it from the caller's session).
            if (isLatest && code.enroll_id && retestable) {
                const testBtn = document.createElement('button');
                testBtn.className = 'test-btn';
                testBtn.textContent = t.test;
                testBtn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    testBtn.disabled = true;
                    testBtn.textContent = '...';
                    try {
                        const res = await api.createTest(codeId);
                        location.hash = `#/test/${res.id}`;
                    } catch (err) {
                        // 409 = server-side race we lost (someone else just
                        // pushed a test in). Show the specific i18n message
                        // and refresh so the UI reflects the new state.
                        if (err.status === 409) {
                            toast(t.retestBlocked, 'error');
                            refreshSnapshots({ silent: true });
                        } else {
                            toast(err.body?.error || t.generalError, 'error');
                        }
                        testBtn.disabled = false;
                        testBtn.textContent = t.test;
                    }
                });
                right.appendChild(testBtn);
            }

            card.appendChild(right);

            // Any test_id (any status) → clicking the card opens the test
            // detail page. That page already polls for pending → done.
            if (s.test_id) {
                card.addEventListener('click', () => {
                    location.hash = `#/test/${s.test_id}`;
                });
            }

            snapList.appendChild(card);
        });
    }
}
