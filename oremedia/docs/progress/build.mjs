// Renders docs/progress/progress.json into docs/progress/index.html (the published progress artefact).
// Run: node docs/progress/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(path.join(here, 'progress.json'), 'utf8'));

const STATUS = {
  complete: { label: 'Complete', glyph: '✓' },
  in_progress: { label: 'In progress', glyph: '◐' },
  open: { label: 'Open', glyph: '○' },
  blocked: { label: 'Blocked', glyph: '⊘' },
  not_applicable: { label: 'Not applicable', glyph: '—' },
};
const TIER = { critical: 'Critical', production: 'Production', internal: 'Internal' };
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const item = ([id, title, tier, spec, status, evidence]) => ({ id, title, tier, spec, status, evidence });
const gate = ([id, text, status, evidence]) => ({ id, text, status, evidence });

const phases = data.phases.map((p) => ({ ...p, items: p.items.map(item), gate: p.gate.map(gate) }));
const cross = data.crossCutting.map((c) => ({ ...c, items: c.items.map(item), gate: [] }));
const sections = [...phases, ...cross];

const counts = (items) => {
  const c = { complete: 0, in_progress: 0, open: 0, blocked: 0, not_applicable: 0 };
  for (const i of items) c[i.status]++;
  return c;
};
const total = counts(sections.flatMap((s) => s.items));
const totalN = sections.reduce((n, s) => n + s.items.length, 0);
const gateTotal = counts(phases.flatMap((p) => p.gate));

const chip = (status) =>
  `<span class="chip chip-${status}"><span class="glyph" aria-hidden="true">${STATUS[status].glyph}</span>${STATUS[status].label}</span>`;

const meter = (c, n, label) => {
  const seg = (k) =>
    c[k] ? `<span class="seg seg-${k}" style="flex:${c[k]}" title="${STATUS[k].label}: ${c[k]}"></span>` : '';
  return `<div class="meter" role="img" aria-label="${esc(label)}: ${c.complete} complete, ${c.in_progress} in progress, ${c.open} open, ${c.blocked} blocked, ${c.not_applicable} not applicable of ${n}">${seg('complete')}${seg('in_progress')}${seg('blocked')}${seg('not_applicable')}${seg('open')}</div>`;
};

const summaryRows = sections
  .map((s) => {
    const c = counts(s.items);
    const pct = s.items.length ? Math.round((c.complete / s.items.length) * 100) : 0;
    return `<tr><td class="mono"><a href="#s-${esc(s.id)}">${esc(s.id)}</a></td><td>${esc(s.title)}</td><td class="num">${s.items.length}</td><td class="num">${c.complete}</td><td class="num">${c.in_progress}</td><td class="num">${c.open}</td><td class="num">${c.blocked}</td><td class="num">${c.not_applicable}</td><td class="meter-cell">${meter(c, s.items.length, s.title)}<span class="pct">${pct}%</span></td></tr>`;
  })
  .join('');

const gateList = (g) =>
  g.length
    ? `<div class="gate"><h3>Acceptance gate</h3><ul class="gate-list">${g
        .map(
          (x) =>
            `<li data-status="${x.status}"><div class="gate-row">${chip(x.status)}<span class="gate-text">${esc(x.text)}</span></div>${x.evidence ? `<p class="evidence">${esc(x.evidence)}</p>` : ''}</li>`,
        )
        .join('')}</ul></div>`
    : '';

const itemRows = (items) =>
  items
    .map(
      (i) =>
        `<tr data-status="${i.status}" data-tier="${i.tier}"><td class="mono id">${esc(i.id)}</td><td class="title">${esc(i.title)}${i.evidence ? `<div class="evidence">${esc(i.evidence)}</div>` : ''}</td><td><span class="tier tier-${i.tier}">${TIER[i.tier] ?? esc(i.tier)}</span></td><td class="mono spec">§${esc(i.spec)}</td><td class="status">${chip(i.status)}</td></tr>`,
    )
    .join('');

const sectionHtml = (s, kind) => {
  const c = counts(s.items);
  return `<section class="phase" id="s-${esc(s.id)}" aria-labelledby="h-${esc(s.id)}">
  <header class="phase-head">
    <div class="phase-title"><span class="phase-id mono">${kind === 'phase' ? 'Phase ' : ''}${esc(s.id)}</span><h2 id="h-${esc(s.id)}">${esc(s.title)}</h2><span class="spec-ref mono">spec §${esc(s.spec)}</span></div>
    <div class="phase-meter">${meter(c, s.items.length, s.title)}<span class="phase-counts">${c.complete} of ${s.items.length} complete</span></div>
  </header>
  ${gateList(s.gate)}
  <div class="table-wrap"><table class="items"><thead><tr><th scope="col">ID</th><th scope="col">Work package</th><th scope="col">Tier</th><th scope="col">Spec</th><th scope="col">Status</th></tr></thead><tbody>${itemRows(s.items)}</tbody></table></div>
  <p class="empty" hidden>No items match the current filter in this section.</p>
</section>`;
};

const nav = sections
  .map((s) => `<li><a href="#s-${esc(s.id)}"><span class="mono">${esc(s.id)}</span> ${esc(s.title)}</a></li>`)
  .join('');
const updated = new Date(data.updatedAt);
const updatedText = `${String(updated.getUTCDate()).padStart(2, '0')} ${updated.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${updated.getUTCFullYear()}, ${String(updated.getUTCHours()).padStart(2, '0')}:${String(updated.getUTCMinutes()).padStart(2, '0')} UTC`;

const html = `<title>Oremedia Build Ledger</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --bg:#f4f6f3;--surface:#ffffff;--surface-2:#eaeeea;--fg:#172120;--muted:#5d6966;--border:#d3dad5;--accent:#0f6e63;--accent-soft:#dcebe7;--ring:#0f6e63;
  --st-complete:#1e7a4c;--st-complete-soft:#dcefe3;--st-in_progress:#a56a00;--st-in_progress-soft:#f6e9cf;--st-open:#7b8683;--st-open-soft:#e7ebe9;--st-blocked:#b2271f;--st-blocked-soft:#f6dedc;--st-not_applicable:#4b5a76;--st-not_applicable-soft:#e1e5ee;
  --tier-critical:#7a1f1a;--tier-critical-soft:#f6e3e1;--tier-production:#2f4a7a;--tier-production-soft:#e2e8f3;--tier-internal:#5d6966;--tier-internal-soft:#e7ebe9;
  --radius:6px;--sans:'IBM Plex Sans',system-ui,-apple-system,'Segoe UI',sans-serif;--serif:'IBM Plex Serif',Georgia,'Times New Roman',serif;--mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;
  --bg:#111514;--surface:#191f1d;--surface-2:#222a27;--fg:#e6eae7;--muted:#9ba6a2;--border:#2c3532;--accent:#5fc3b1;--accent-soft:#1c332f;--ring:#5fc3b1;
  --st-complete:#5cbb86;--st-complete-soft:#173226;--st-in_progress:#e2a53d;--st-in_progress-soft:#332a14;--st-open:#94a09c;--st-open-soft:#242b29;--st-blocked:#ea7169;--st-blocked-soft:#3a1f1d;--st-not_applicable:#93a3c6;--st-not_applicable-soft:#232a38;
  --tier-critical:#f0928b;--tier-critical-soft:#3a1f1d;--tier-production:#9db4e0;--tier-production-soft:#1f2a3d;--tier-internal:#9ba6a2;--tier-internal-soft:#242b29;}}
:root[data-theme="dark"]{color-scheme:dark;
  --bg:#111514;--surface:#191f1d;--surface-2:#222a27;--fg:#e6eae7;--muted:#9ba6a2;--border:#2c3532;--accent:#5fc3b1;--accent-soft:#1c332f;--ring:#5fc3b1;
  --st-complete:#5cbb86;--st-complete-soft:#173226;--st-in_progress:#e2a53d;--st-in_progress-soft:#332a14;--st-open:#94a09c;--st-open-soft:#242b29;--st-blocked:#ea7169;--st-blocked-soft:#3a1f1d;--st-not_applicable:#93a3c6;--st-not_applicable-soft:#232a38;
  --tier-critical:#f0928b;--tier-critical-soft:#3a1f1d;--tier-production:#9db4e0;--tier-production-soft:#1f2a3d;--tier-internal:#9ba6a2;--tier-internal-soft:#242b29;}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:15px;line-height:1.5;margin:0;padding-inline:16px;padding-block:0 48px}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.mono{font-family:var(--mono);font-size:.86em}
.num{text-align:right;font-variant-numeric:tabular-nums}
h1,h2,h3{font-family:var(--serif);font-weight:600;text-wrap:balance;margin:0}
h1{font-size:1.75rem;letter-spacing:-.01em}
h2{font-size:1.3rem}
h3{font-size:1rem;font-family:var(--sans);font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.topbar{position:sticky;top:env(safe-area-inset-top,0px);z-index:5;background:var(--bg);border-bottom:1px solid var(--border);margin-inline:-16px;padding:12px 16px;display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between}
.brand{display:flex;flex-direction:column;gap:2px}
.brand .sub{color:var(--muted);font-size:.85rem}
.filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.filters button{font:inherit;font-size:.82rem;padding:5px 10px;border:1px solid var(--border);background:var(--surface);color:var(--fg);border-radius:999px;cursor:pointer}
.filters button[aria-pressed="true"]{background:var(--accent-soft);border-color:var(--accent);color:var(--fg)}
.layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:32px;max-width:1240px;margin:24px auto 0}
@media (max-width:900px){.layout{grid-template-columns:minmax(0,1fr)}.sidenav{display:none}}
.sidenav{position:sticky;top:calc(env(safe-area-inset-top,0px) + 72px);align-self:start;font-size:.85rem}
.sidenav ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.sidenav a{display:block;padding:4px 8px;border-radius:var(--radius);color:var(--fg);text-decoration:none}
.sidenav a:hover{background:var(--surface-2)}
.sidenav .mono{color:var(--muted);margin-right:4px}
main{min-width:0;display:flex;flex-direction:column;gap:40px}
.intro{max-width:68ch;color:var(--muted)}
.summary{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
.summary-head{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between;align-items:baseline;margin-bottom:12px}
.hero-meter{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
.meter{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--st-open-soft);gap:2px;min-width:80px}
.seg{display:block;height:100%}
.seg-complete{background:var(--st-complete)}.seg-in_progress{background:var(--st-in_progress)}.seg-open{background:var(--st-open)}.seg-blocked{background:var(--st-blocked)}
.seg-not_applicable{background:repeating-linear-gradient(135deg,var(--st-not_applicable) 0 3px,transparent 3px 6px)}
.legend{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:.82rem;color:var(--muted)}
.legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;background:var(--sw)}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th{text-align:left;font-weight:600;color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:top}
tr:last-child td{border-bottom:0}
.meter-cell{min-width:180px}.meter-cell .meter{display:inline-flex;width:120px;vertical-align:middle;margin-right:8px}.pct{font-variant-numeric:tabular-nums;color:var(--muted);font-size:.82rem}
.phase{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 16px 4px;scroll-margin-top:96px}
.phase-head{display:flex;flex-wrap:wrap;gap:12px 24px;justify-content:space-between;align-items:flex-end;padding-bottom:12px;border-bottom:1px solid var(--border);margin-bottom:12px}
.phase-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px}
.phase-id{color:var(--muted)}
.spec-ref{color:var(--muted)}
.phase-meter{display:flex;align-items:center;gap:10px;min-width:220px}.phase-meter .meter{width:140px}.phase-counts{font-size:.82rem;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.gate{margin-bottom:12px;padding:12px;background:var(--surface-2);border-radius:var(--radius)}
.gate h3{margin-bottom:8px}
.gate-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.gate-row{display:flex;gap:10px;align-items:flex-start}
.gate-text{flex:1}
.evidence{color:var(--muted);font-size:.84rem;margin:4px 0 0}
td.title .evidence{margin-top:3px}
.chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:.78rem;font-weight:500;white-space:nowrap;border:1px solid transparent;flex-shrink:0}
.chip .glyph{font-size:.9em}
.chip-complete{color:var(--st-complete);background:var(--st-complete-soft);border-color:color-mix(in srgb,var(--st-complete) 35%,transparent)}
.chip-in_progress{color:var(--st-in_progress);background:var(--st-in_progress-soft);border-color:color-mix(in srgb,var(--st-in_progress) 35%,transparent)}
.chip-open{color:var(--st-open);background:var(--st-open-soft);border-color:color-mix(in srgb,var(--st-open) 35%,transparent)}
.chip-blocked{color:var(--st-blocked);background:var(--st-blocked-soft);border-color:color-mix(in srgb,var(--st-blocked) 35%,transparent)}
.chip-not_applicable{color:var(--st-not_applicable);background:var(--st-not_applicable-soft);border-color:color-mix(in srgb,var(--st-not_applicable) 35%,transparent)}
.tier{display:inline-block;padding:1px 7px;border-radius:4px;font-size:.74rem;font-weight:500;white-space:nowrap}
.tier-critical{color:var(--tier-critical);background:var(--tier-critical-soft)}.tier-production{color:var(--tier-production);background:var(--tier-production-soft)}.tier-internal{color:var(--tier-internal);background:var(--tier-internal-soft)}
td.id{white-space:nowrap;color:var(--muted)}td.spec{white-space:nowrap;color:var(--muted)}td.status{white-space:nowrap}
.legend-block{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px 24px;font-size:.86rem;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}
.legend-block div{display:flex;gap:8px;align-items:flex-start}
.legend-block p{margin:0;color:var(--muted)}
.empty{color:var(--muted);font-size:.9rem;padding:8px 0 12px}
footer{max-width:1240px;margin:32px auto 0;color:var(--muted);font-size:.82rem}
@media (prefers-reduced-motion:no-preference){.chip,.filters button{transition:background-color .15s}}
</style>
<div class="topbar">
  <div class="brand"><h1>Oremedia Build Ledger</h1><span class="sub">Programme progress against the build specification · updated ${esc(updatedText)}</span></div>
  <div class="filters" role="group" aria-label="Filter work packages by status">
    <button type="button" id="f-all" data-filter="all" aria-pressed="true">All</button>
    <button type="button" id="f-complete" data-filter="complete" aria-pressed="false">Complete</button>
    <button type="button" id="f-in_progress" data-filter="in_progress" aria-pressed="false">In progress</button>
    <button type="button" id="f-open" data-filter="open" aria-pressed="false">Open</button>
    <button type="button" id="f-blocked" data-filter="blocked" aria-pressed="false">Blocked</button>
    <button type="button" id="f-not_applicable" data-filter="not_applicable" aria-pressed="false">Not applicable</button>
  </div>
</div>
<div class="layout">
  <nav class="sidenav" aria-label="Sections"><ul>${nav}</ul></nav>
  <main>
    <p class="intro">Every phase and work package from <span class="mono">${esc(data.specification)}</span>, with its acceptance gate. A package is marked complete only when it is genuinely finished and verified; “it should work” is not a status. Source of truth: <span class="mono">docs/progress/progress.json</span> in ${esc(data.repository)}.</p>
    <section class="summary" aria-labelledby="h-summary">
      <div class="summary-head"><h2 id="h-summary">Programme summary</h2><span class="phase-counts">${total.complete} of ${totalN} work packages complete · ${gateTotal.complete} of ${phases.flatMap((p) => p.gate).length} gate criteria verified</span></div>
      <div class="hero-meter">${meter(total, totalN, 'All work packages')}
        <div class="legend"><span style="--sw:var(--st-complete)">Complete ${total.complete}</span><span style="--sw:var(--st-in_progress)">In progress ${total.in_progress}</span><span style="--sw:var(--st-blocked)">Blocked ${total.blocked}</span><span style="--sw:var(--st-not_applicable)">Not applicable ${total.not_applicable}</span><span style="--sw:var(--st-open)">Open ${total.open}</span></div>
      </div>
      <div class="table-wrap"><table class="summary-table"><thead><tr><th scope="col">ID</th><th scope="col">Section</th><th scope="col" class="num">Items</th><th scope="col" class="num">Complete</th><th scope="col" class="num">In progress</th><th scope="col" class="num">Open</th><th scope="col" class="num">Blocked</th><th scope="col" class="num">N/A</th><th scope="col">Progress</th></tr></thead><tbody>${summaryRows}</tbody></table></div>
      <div class="legend-block">${Object.entries(data.statusLegend)
        .map(([k, v]) => `<div>${chip(k)}<p>${esc(v)}</p></div>`)
        .join('')}</div>
    </section>
    ${phases.map((p) => sectionHtml(p, 'phase')).join('\n')}
    ${cross.map((c) => sectionHtml(c, 'cross')).join('\n')}
  </main>
</div>
<footer>Statuses follow the specification’s verification language: verified (how), open (risk), not applicable (why). Blocked items name the human decision, credential or account they wait on.</footer>
<script>
(function(){
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.filters button'));
  var rows = Array.prototype.slice.call(document.querySelectorAll('tr[data-status], li[data-status]'));
  function apply(f){
    buttons.forEach(function(b){ b.setAttribute('aria-pressed', String(b.dataset.filter === f)); });
    rows.forEach(function(r){ r.hidden = !(f === 'all' || r.dataset.status === f); });
    Array.prototype.forEach.call(document.querySelectorAll('.phase'), function(s){
      var visible = s.querySelectorAll('tbody tr:not([hidden])').length;
      var empty = s.querySelector('.empty'); if (empty) empty.hidden = visible > 0;
    });
    try { localStorage.setItem('oremedia-ledger-filter', f); } catch (e) {}
  }
  buttons.forEach(function(b){ b.addEventListener('click', function(){ apply(b.dataset.filter); }); });
  var saved = 'all'; try { saved = localStorage.getItem('oremedia-ledger-filter') || 'all'; } catch (e) {}
  if (saved !== 'all') apply(saved);
})();
</script>
`;
writeFileSync(path.join(here, 'index.html'), html);
console.error(`rendered ${sections.length} sections, ${totalN} items → docs/progress/index.html`);
