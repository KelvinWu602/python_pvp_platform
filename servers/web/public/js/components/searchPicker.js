// Generic search-picker input used by the admin views.
//
// createSearchPicker({ placeholder, fetchResults, renderRow, onPick })
//
// Returns { el, setValue, clear, focus } — a DOM element with a text input
// and a dropdown of results underneath. Results appear when the typed query
// has >= 2 non-whitespace characters (the API returns [] for shorter
// queries, so this is UI + server enforcement). The dropdown is positioned
// via CSS (.search-picker + .search-dropdown) as a normal block element so
// it flows in the form; if you need it floating over other content, wrap
// this element in a `position: relative` container.
//
//   placeholder    — <input>'s placeholder.
//   fetchResults   — async (q: string) => Array<row>. Called debounced.
//   renderRow      — (row) => string; return the visible label for one row.
//   onPick         — (row) => void; called when the user clicks a row.
//
// The dropdown auto-closes when the user picks a row or when the input
// loses focus (with a short delay so clicks on rows land first).
import { t } from '../i18n.js';

const DEBOUNCE_MS = 200;
const MIN_LEN = 2;

export function createSearchPicker({
    placeholder = t.search,
    fetchResults,
    renderRow,
    onPick,
    initialValue = '',
} = {}) {
    const el = document.createElement('div');
    el.className = 'search-picker';
    el.innerHTML = `
        <input class="search-input" type="search" placeholder="${placeholder}" autocomplete="off">
        <div class="search-dropdown" hidden></div>
    `;
    const input = el.querySelector('input');
    const dropdown = el.querySelector('.search-dropdown');
    if (initialValue) input.value = initialValue;

    let latestQuery = '';
    let debounceTimer = null;

    function setDropdownContent(html) {
        dropdown.innerHTML = html;
        dropdown.hidden = false;
    }
    function hideDropdown() { dropdown.hidden = true; }

    async function doSearch() {
        const q = input.value.trim();
        latestQuery = q;
        if (q.length < MIN_LEN) {
            setDropdownContent(`<div class="search-hint">${t.typeMore}</div>`);
            return;
        }
        setDropdownContent(`<div class="search-hint">…</div>`);
        let rows;
        try {
            rows = await fetchResults(q);
        } catch (err) {
            setDropdownContent(`<div class="search-hint" style="color:#e63946;">${t.generalError}</div>`);
            return;
        }
        // Race protection: user may have kept typing while the request was
        // in flight. Only render if the query is still the same.
        if (latestQuery !== q) return;
        if (!rows || rows.length === 0) {
            setDropdownContent(`<div class="search-hint">${t.noResult}</div>`);
            return;
        }
        const html = rows.map((row, i) =>
            `<div class="search-row" data-idx="${i}">${renderRow(row)}</div>`
        ).join('');
        setDropdownContent(html);
        dropdown.querySelectorAll('.search-row').forEach(rowEl => {
            rowEl.addEventListener('mousedown', (ev) => {
                // Use mousedown so we handle before blur closes the dropdown.
                ev.preventDefault();
                const row = rows[Number(rowEl.dataset.idx)];
                onPick(row);
                hideDropdown();
            });
        });
    }

    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(doSearch, DEBOUNCE_MS);
    });
    input.addEventListener('focus', () => {
        if (input.value.trim().length >= MIN_LEN) doSearch();
        else setDropdownContent(`<div class="search-hint">${t.typeMore}</div>`);
    });
    input.addEventListener('blur', () => {
        // Delay hiding so the mousedown handler on a row still fires.
        setTimeout(hideDropdown, 150);
    });

    return {
        el,
        setValue(v) { input.value = v || ''; hideDropdown(); },
        clear() { input.value = ''; hideDropdown(); },
        focus() { input.focus(); },
    };
}
