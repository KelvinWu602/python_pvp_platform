// Renders a small score histogram inside a rounded rectangle container.
//
// Args:
//   histogram : Array<{score, count}> sorted asc.
//   myScore   : number|null — the caller's score. The bar whose score equals
//               this value gets `.mine`, which paints it in the accent color
//               with an animated "shine sweep" (see .hist-bar.mine in app.css).
//               Pass null (or undefined) to render without highlighting.
//
// Gaps between scores are filled with 0-count bars for a continuous x-axis.
export function renderHistogram(histogram, myScore = null) {
    const container = document.createElement('div');
    container.className = 'hist-container';
    container.innerHTML = `<div class="hist-title">分數分佈</div>`;

    const el = document.createElement('div');
    el.className = 'hist';
    container.appendChild(el);

    if (!histogram || histogram.length === 0) {
        el.innerHTML = '<span style="color:#94a3b8;font-size:0.85rem;">尚無資料</span>';
        return container;
    }
    // Fill gaps between min and max scores.
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
        bar.className = 'hist-bar' + (row.score === myScore ? ' mine' : '');
        const heightPct = Math.max(6, (row.count / maxCount) * 100);
        bar.style.height = `${heightPct}%`;
        bar.title = `分數 ${row.score}：${row.count} 人`;
        el.appendChild(bar);
    }
    return container;
}
