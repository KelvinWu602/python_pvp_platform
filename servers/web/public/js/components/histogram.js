// Renders a small score histogram. `histogram` is [{score, count}, ...] sorted asc.
// Bar height ∝ count. Highlight the bar whose score equals my_score.
// If there are gaps in scores, fill them with 0-count bars for a continuous range.
export function renderHistogram({ histogram, my_score }) {
    const el = document.createElement('div');
    el.className = 'hist';
    if (!histogram || histogram.length === 0) {
        el.innerHTML = '<span style="color:#94a3b8;font-size:0.85rem;">尚無資料</span>';
        return el;
    }
    // Fill gaps between min and max scores
    const minS = histogram[0].score;
    const maxS = histogram[histogram.length - 1].score;
    const map = new Map(histogram.map(h => [h.score, h.count]));
    const rows = [];
    for (let s = minS; s <= maxS; s++) {
        rows.push({ score: s, count: map.get(s) || 0 });
    }
    const maxCount = Math.max(...rows.map(r => r.count), 1);
    for (const row of rows) {
        const bar = document.createElement('div');
        bar.className = 'hist-bar' + (row.score === my_score ? ' mine' : '');
        const heightPct = Math.max(6, (row.count / maxCount) * 100);
        bar.style.height = `${heightPct}%`;
        bar.title = `分數 ${row.score}：${row.count} 人`;
        el.appendChild(bar);
    }
    return el;
}
