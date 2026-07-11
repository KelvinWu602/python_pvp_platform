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
            bracketMatching, foldGutter, foldKeymap,
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
            // Reload snapshots
            snapshots = await api.listSnapshots(codeId);
            renderSnapshots();
        } catch (err) {
            toast(err.body?.error || t.generalError, 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = t.save;
        }
    });

    const snapList = container.querySelector('[data-snap-list]');
    renderSnapshots();

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

            if (s.tested) {
                const star = document.createElement('div');
                star.className = 'star';
                star.textContent = '★';
                star.title = '此 snapshot 已測試';
                right.appendChild(star);
            }
            if (isLatest && enrollForCompetition) {
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
                        toast(err.body?.error || t.generalError, 'error');
                        testBtn.disabled = false;
                        testBtn.textContent = t.test;
                    }
                });
                right.appendChild(testBtn);
            }

            card.appendChild(right);

            if (s.test_id) {
                card.addEventListener('click', () => {
                    location.hash = `#/test/${s.test_id}`;
                });
            }

            snapList.appendChild(card);
        });
    }
}
