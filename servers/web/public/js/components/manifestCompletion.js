// Build a CodeMirror 6 completion source from a game manifest.json.
//
// The manifest declares:
//   - `import`   : helper module name (e.g. "helper")
//   - `exports`  : list of {name, signature, description} helper functions
//   - `game_states` : shape of the state object passed to update(state) — each
//                     top-level key has {type, description?, properties?, items?}
//   - `update_return` : {type, description}
//
// We produce three kinds of completions:
//   1. helper function names   → offered as bare identifiers
//   2. game_states top-level   → offered after `game_states.`
//   3. game_states nested props → offered after `game_states.<key>.` when the
//                                 key has type: 'object' and 'properties' map
//
// The identifier `game_states` is a *convention* — the manifest doesn't name
// the parameter. We use this name because handler/design docs refer to it as
// `game_states`. If a user names the parameter differently in their `update`,
// they lose the nested-key completions but still get helper completions.

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

// Build a CompletionSource function bound to the parsed manifest data.
export function makePythonCompletionSource(data) {
    if (!data) return null;

    // Helper completions insert the qualified name `helper.clamp(` so they
    // work with the boilerplate `import helper` on line 1. `label` stays as
    // the bare name so the user's typed prefix (`cla`) still filters correctly.
    // `displayLabel` (supported since @codemirror/autocomplete 6.11) shows the
    // qualified name in the popup row; older builds fall back to `label`.
    const helperOptions = data.helpers.map(fn => ({
        label: fn.name,
        displayLabel: `${data.importModule}.${fn.name}`,
        type: 'function',
        detail: fn.signature || '',
        info: fn.description || '',
        apply: `${data.importModule}.${fn.name}(`,
        boost: 5,
    }));

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
    // We inspect what's before the cursor.
    const memberChainRe = /([A-Za-z_][A-Za-z0-9_]*)(\.[A-Za-z_][A-Za-z0-9_]*)*\.?$/;
    const identifierRe = /[A-Za-z_][A-Za-z0-9_]*$/;
    // Detect the user's own `def update(<name>)` so nested completion fires on
    // whatever they named the parameter (e.g. `game_state`, `state`, `s`).
    // Tolerates additional args after the first, and default values / type
    // annotations are unlikely but not blocked. If no match, fall back to the
    // convention name in the manifest (`game_states`).
    const updateDefRe = /^\s*def\s+update\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/m;

    return function pythonManifestCompletions(ctx) {
        // Resolve the state-param name from the current doc each call. Cheap:
        // one anchored linear regex over a small doc, and only runs when the
        // completion source is invoked (identifier/dot triggers), not on every
        // keystroke.
        const docText = ctx.state.doc.toString();
        const paramMatch = updateDefRe.exec(docText);
        const stateParamName = paramMatch ? paramMatch[1] : data.stateParamName;

        // Check for member-access first (higher priority).
        const chainMatch = ctx.matchBefore(memberChainRe);
        if (chainMatch && chainMatch.text.includes('.')) {
            const raw = chainMatch.text;
            const endsWithDot = raw.endsWith('.');
            const parts = raw.replace(/\.$/, '').split('.');

            // For "<param>." (endsWithDot=true, parts=['<param>'])
            if (parts[0] === stateParamName) {
                if (endsWithDot) {
                    if (parts.length === 1) {
                        // "<param>." → top-level keys
                        return {
                            from: ctx.pos,
                            options: topLevelOptions,
                            validFor: /^[A-Za-z0-9_]*$/,
                        };
                    }
                    if (parts.length === 2 && nestedOptionsByKey[parts[1]]) {
                        // "<param>.telemetry." → nested props
                        return {
                            from: ctx.pos,
                            options: nestedOptionsByKey[parts[1]],
                            validFor: /^[A-Za-z0-9_]*$/,
                        };
                    }
                } else {
                    // Partial identifier after last dot: filter in-flight
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
            }
            // Not a state chain we recognize → don't offer anything (let other sources try)
            return null;
        }

        // Bare identifier: helper functions.
        const idMatch = ctx.matchBefore(identifierRe);
        if (idMatch && (idMatch.from !== idMatch.to || ctx.explicit)) {
            if (helperOptions.length === 0) return null;
            return {
                from: idMatch.from,
                options: helperOptions,
                validFor: /^[A-Za-z0-9_]*$/,
            };
        }
        return null;
    };
}
