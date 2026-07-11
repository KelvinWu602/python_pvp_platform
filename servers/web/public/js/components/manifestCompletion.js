// Build a CodeMirror 6 completion source from a game manifest.json.
//
// The manifest declares:
//   - `import`   : helper module name (e.g. "helper")
//   - `exports`  : list of {name, signature, description} helper functions
//   - `game_states` : shape of the state object passed to update(state) — each
//                     top-level key has {type, description?, properties?, items?}
//   - `update_return` : {type, description}
//
// Completion behaviour (import-aware, mirrors Python name binding):
//
//   1. State-parameter completion (import-independent):
//        `def update(<param>):` → typing `<param>.` offers manifest top-level
//        keys; `<param>.<key>.` offers nested props when the key is an object.
//        `<param>` is auto-detected from the user's `def update(...)`; if none
//        is found we fall back to the manifest's convention name (`game_states`).
//
//   2. Helper module completion (`import helper` / `import helper as h`):
//        - `help`/`h` → completes to the module identifier.
//        - `helper.` / `h.` → offers all helper functions.
//
//   3. Bare helper completion (`from helper import clamp[, lerp as l]`):
//        - `cla` → `clamp` (inserts `clamp(`), etc.
//        - Only names actually imported are offered.
//
//   4. Star-import (`from helper import *`):
//        - All helpers offered as bare names.
//        - `helper.` NOT offered (star-import does not bind the module name in
//          Python).
//
// Without any of these imports we offer nothing (empty file → typing `cla`
// does NOT suggest `clamp`).
//
// Multi-line `from helper import (\n  a,\n  b,\n)` is intentionally
// unsupported (single-line only) — the manifest exports 4 symbols, so the
// realistic use case is a single-line import. Revisit if a user hits this.

const STATE_PARAM_NAME = 'game_states';

export function parseManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return null;

    const helpers = Array.isArray(manifest.exports)
        ? manifest.exports.filter(x => x && typeof x.name === 'string')
        : [];

    const topLevelKeys = manifest.game_states && typeof manifest.game_states === 'object'
        ? Object.keys(manifest.game_states)
        : [];

    // Map: key -> array of {label, info}
    const nested = {};
    if (manifest.game_states) {
        for (const [k, v] of Object.entries(manifest.game_states)) {
            if (v && v.type === 'object' && v.properties && typeof v.properties === 'object') {
                nested[k] = Object.entries(v.properties).map(([name, desc]) => ({
                    label: name,
                    info: typeof desc === 'string' ? desc : JSON.stringify(desc),
                }));
            }
        }
    }

    // Info string for each top-level key
    const topLevelInfo = {};
    if (manifest.game_states) {
        for (const [k, v] of Object.entries(manifest.game_states)) {
            if (!v) continue;
            let s = '';
            if (v.type) s += `type: ${v.type}`;
            if (v.description) s += (s ? '\n' : '') + v.description;
            if (Array.isArray(v.items)) s += (s ? '\n' : '') + `items: ${JSON.stringify(v.items)}`;
            topLevelInfo[k] = s || undefined;
        }
    }

    return {
        importModule: manifest.import || 'helper',
        helpers,
        topLevelKeys,
        topLevelInfo,
        nested,
        stateParamName: STATE_PARAM_NAME,
    };
}

// Escape a string for literal use inside a RegExp. `importModule` comes from
// the manifest (`"helper"` today) but we treat it as arbitrary input.
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse the user's doc for helper-module imports. Single-line forms only.
//
// Returns:
//   moduleAlias : string | null
//     Set by `import <mod>` (= <mod>) or `import <mod> as X` (= X).
//     NOT set by `from <mod> import *` — Python's star-import does NOT bind
//     the module name in the local namespace.
//
//   starImported: boolean
//     Set by `from <mod> import *`.
//
//   directNames : Map<effectiveName, sourceName>
//     Set by `from <mod> import a, b as c`. `effectiveName` is what the user
//     types (`a` or `c`); `sourceName` is the manifest entry (`a` or `b`) used
//     to look up signature/description.
function parseHelperImports(docText, importModule) {
    const mod = escapeRe(importModule);
    const result = { moduleAlias: null, starImported: false, directNames: new Map() };

    // `import helper` / `import helper as h`. Trailing comment tolerated.
    // We iterate to catch the last occurrence (an unusual doc might have both).
    const importRe = new RegExp(
        `^\\s*import\\s+${mod}(?:\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*))?\\s*(?:#.*)?$`,
        'gm'
    );
    let m;
    while ((m = importRe.exec(docText)) !== null) {
        result.moduleAlias = m[1] || importModule;
    }

    // `from helper import *`.
    const starRe = new RegExp(
        `^\\s*from\\s+${mod}\\s+import\\s+\\*\\s*(?:#.*)?$`, 'gm'
    );
    if (starRe.test(docText)) result.starImported = true;

    // `from helper import a, b as c, d`. First char after `import ` must be an
    // identifier char (not `*`), so star-import isn't matched here.
    const fromRe = new RegExp(
        `^\\s*from\\s+${mod}\\s+import\\s+([A-Za-z_][^\\n#]*?)\\s*(?:#.*)?$`, 'gm'
    );
    while ((m = fromRe.exec(docText)) !== null) {
        for (const part of m[1].split(',')) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const asMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(trimmed);
            if (!asMatch) continue;
            const source = asMatch[1];
            const effective = asMatch[2] || asMatch[1];
            result.directNames.set(effective, source);
        }
    }
    return result;
}

// Build a CompletionSource function bound to the parsed manifest data.
export function makePythonCompletionSource(data) {
    if (!data) return null;

    const helperByName = new Map(data.helpers.map(fn => [fn.name, fn]));

    // Build a completion option for a helper, given the visible name (which
    // may be an alias) and the source manifest entry.
    function makeHelperOption(visibleName, fn) {
        return {
            label: visibleName,
            type: 'function',
            detail: fn.signature || '',
            info: fn.description || '',
            apply: visibleName + '(',
            boost: 5,
        };
    }

    const topLevelOptions = data.topLevelKeys.map(k => ({
        label: k,
        type: 'property',
        info: data.topLevelInfo[k],
    }));

    const nestedOptionsByKey = {};
    for (const [k, items] of Object.entries(data.nested)) {
        nestedOptionsByKey[k] = items.map(item => ({
            label: item.label,
            type: 'property',
            info: item.info,
        }));
    }

    // Regex: match member-access chain like "foo.bar.baz" ending optionally with "."
    const memberChainRe = /([A-Za-z_][A-Za-z0-9_]*)(\.[A-Za-z_][A-Za-z0-9_]*)*\.?$/;
    const identifierRe = /[A-Za-z_][A-Za-z0-9_]*$/;
    // Detect the user's own `def update(<name>)` so nested completion fires on
    // whatever they named the parameter (e.g. `game_state`, `state`, `s`).
    // Tolerates additional args after the first. If no match, fall back to
    // the convention name in the manifest (`game_states`).
    const updateDefRe = /^\s*def\s+update\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/m;

    return function pythonManifestCompletions(ctx) {
        // One doc read per completion call. Cheap: doc is small, and this
        // runs only when the completion source is invoked (identifier/dot
        // triggers), not on every keystroke.
        const docText = ctx.state.doc.toString();
        const paramMatch = updateDefRe.exec(docText);
        const stateParamName = paramMatch ? paramMatch[1] : data.stateParamName;
        const imports = parseHelperImports(docText, data.importModule);

        // ── Member access (`x.` or `x.y` or `x.y.`) ──────────────────────
        const chainMatch = ctx.matchBefore(memberChainRe);
        if (chainMatch && chainMatch.text.includes('.')) {
            const raw = chainMatch.text;
            const endsWithDot = raw.endsWith('.');
            const parts = raw.replace(/\.$/, '').split('.');

            // State-parameter branch: `<param>.` and `<param>.<key>.`
            if (parts[0] === stateParamName) {
                if (endsWithDot) {
                    if (parts.length === 1) {
                        return {
                            from: ctx.pos,
                            options: topLevelOptions,
                            validFor: /^[A-Za-z0-9_]*$/,
                        };
                    }
                    if (parts.length === 2 && nestedOptionsByKey[parts[1]]) {
                        return {
                            from: ctx.pos,
                            options: nestedOptionsByKey[parts[1]],
                            validFor: /^[A-Za-z0-9_]*$/,
                        };
                    }
                } else {
                    const lastDot = raw.lastIndexOf('.');
                    const prefixParts = raw.slice(0, lastDot).split('.');
                    const partial = raw.slice(lastDot + 1);
                    if (prefixParts.length === 1 && prefixParts[0] === stateParamName) {
                        return {
                            from: ctx.pos - partial.length,
                            options: topLevelOptions,
                            validFor: /^[A-Za-z0-9_]*$/,
                        };
                    }
                    if (
                        prefixParts.length === 2 &&
                        prefixParts[0] === stateParamName &&
                        nestedOptionsByKey[prefixParts[1]]
                    ) {
                        return {
                            from: ctx.pos - partial.length,
                            options: nestedOptionsByKey[prefixParts[1]],
                            validFor: /^[A-Za-z0-9_]*$/,
                        };
                    }
                }
                return null;
            }

            // Module-alias branch: `helper.` / `h.` after `import helper [as h]`.
            // Star-import intentionally excluded here (does not bind the module
            // name in Python).
            if (imports.moduleAlias && parts[0] === imports.moduleAlias) {
                const moduleMemberOptions = data.helpers.map(fn =>
                    makeHelperOption(fn.name, fn)
                );
                if (endsWithDot && parts.length === 1) {
                    return {
                        from: ctx.pos,
                        options: moduleMemberOptions,
                        validFor: /^[A-Za-z0-9_]*$/,
                    };
                }
                if (!endsWithDot) {
                    const lastDot = raw.lastIndexOf('.');
                    const prefixParts = raw.slice(0, lastDot).split('.');
                    const partial = raw.slice(lastDot + 1);
                    if (prefixParts.length === 1 && prefixParts[0] === imports.moduleAlias) {
                        return {
                            from: ctx.pos - partial.length,
                            options: moduleMemberOptions,
                            validFor: /^[A-Za-z0-9_]*$/,
                        };
                    }
                }
                return null;
            }

            // Not a chain we recognise.
            return null;
        }

        // ── Bare identifier ──────────────────────────────────────────────
        const idMatch = ctx.matchBefore(identifierRe);
        if (idMatch && (idMatch.from !== idMatch.to || ctx.explicit)) {
            const options = [];
            // De-duplicate labels in case both `from x import *` and
            // `from x import name` appear (rare, but a mixed doc could).
            const seen = new Set();
            const addOption = (opt) => {
                if (seen.has(opt.label)) return;
                seen.add(opt.label);
                options.push(opt);
            };

            // (a) Star-import: all helpers as bare names.
            if (imports.starImported) {
                for (const fn of data.helpers) {
                    addOption(makeHelperOption(fn.name, fn));
                }
            }

            // (b) Explicitly-named imports: only those names.
            for (const [effective, source] of imports.directNames) {
                const fn = helperByName.get(source);
                if (fn) addOption(makeHelperOption(effective, fn));
            }

            // (c) Module alias itself so `help` completes to `helper`.
            if (imports.moduleAlias) {
                addOption({
                    label: imports.moduleAlias,
                    type: 'namespace',
                    info: `${data.importModule} module`,
                    apply: imports.moduleAlias,   // no paren — it's a namespace
                    boost: 3,
                });
            }

            if (options.length === 0) return null;
            return {
                from: idMatch.from,
                options,
                validFor: /^[A-Za-z0-9_]*$/,
            };
        }
        return null;
    };
}
