import { t, fmtDateTime } from '../i18n.js';
import { api, fetchManifest } from '../api.js';
import { renderHeader } from '../components/header.js';
import { toast } from '../components/toast.js';
import { parseManifest, makePythonCompletionSource } from '../components/manifestCompletion.js';

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

    let code, snapshots, enrollForCompetition;
    try {
        [code, snapshots] = await Promise.all([
            api.getCode(codeId),
            api.listSnapshots(codeId),
        ]);
    } catch (err) {
        container.querySelector('[data-snap-list]').innerHTML =
            `<div style="color:#e63946;">${t.generalError}</div>`;
        return;
    }
    container.querySelector('[data-code-name]').textContent = code.name;

    // Find user's enrollment matching this code's competition (to enable 測試 button)
    // + fetch competition (for manifest_reference) in parallel.
    let competition = null;
    try {
        const [enrolls, comp] = await Promise.all([
            api.listEnrolls(),
            api.getCompetition(code.competition_id).catch(() => null),
        ]);
        enrollForCompetition = enrolls.find(e => e.competition_id === code.competition_id);
        competition = comp;
    } catch { enrollForCompetition = null; }

    // Fetch manifest.json from S3 (public bucket, direct browser fetch).
    // Manifest drives autocomplete. Failure here is non-fatal — editor still
    // works, just without autocomplete.
    let manifest = null;
    if (competition && competition.manifest_reference) {
        manifest = await fetchManifest(competition.manifest_reference);
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
                doc: code.code || '',
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
        ta.value = code.code || '';
        cmHost.appendChild(ta);
        view = {
            state: { doc: { toString: () => ta.value } },
            dispatch: () => {},
        };
    }

    // Save handler
    const saveBtn = container.querySelector('[data-save]');
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = '...';
        try {
            const newCode = view.state.doc.toString();
            await api.updateCode(codeId, newCode);
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
    //   * Manual `↻` button: always re-fetches on click.
    //   * Auto-poll every 10s while ANY snapshot has test_status='pending'.
    //     Stops as soon as none are pending. Also cleaned up on hashchange
    //     so leaving the page doesn't keep firing requests.
    //
    // Silent errors: background polls swallow network errors (a transient
    // failure shouldn't blast a toast every 10s).
    let pollTimer = null;
    function schedulePollIfNeeded() {
        const anyPending = snapshots.some(s => s.test_status === 'pending');
        if (anyPending && !pollTimer) {
            pollTimer = setInterval(() => { refreshSnapshots({ silent: true }); }, 10000);
        } else if (!anyPending && pollTimer) {
            clearInterval(pollTimer); pollTimer = null;
        }
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
                    const star = document.createElement('div');
                    star.className = 'star';
                    star.textContent = '★';
                    star.title = '此 snapshot 已測試';
                    right.appendChild(star);
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
            // snapshot is retestable (never tested, or previous run was
            // infra_error), and the user is enrolled in the competition.
            if (isLatest && enrollForCompetition && s.retestable) {
                const testBtn = document.createElement('button');
                testBtn.className = 'test-btn';
                testBtn.textContent = t.test;
                testBtn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    testBtn.disabled = true;
                    testBtn.textContent = '...';
                    try {
                        const res = await api.createTest(enrollForCompetition.id);
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
