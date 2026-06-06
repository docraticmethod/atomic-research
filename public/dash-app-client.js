// Consumes /api/papers and /api/feed-summary — never reads output_data.json directly.

const feedSummaryContent = document.getElementById('feed-summary-content');
const feedList           = document.getElementById('feed-list');
const detailContent      = document.getElementById('detail-content');

let allPapers = [];
let selectedId = null;

function badgeClass(action) {
  if (action === 'Read now') return 'badge-read';
  if (action === 'Save')     return 'badge-save';
  return 'badge-skip';
}

function simBarWidth(sim) {
  return Math.round(sim * 80);
}

function createFeedItem(paper) {
  const item = document.createElement('div');
  item.className = 'feed-item';
  item.setAttribute('role', 'option');
  item.setAttribute('data-paper-id', paper.paper_id);
  item.setAttribute('aria-selected', 'false');
  item.tabIndex = 0;

  item.innerHTML = `
    <div class="feed-item-top">
      <span class="rank-num">${paper.rank}</span>
      <span class="action-badge ${badgeClass(paper.recommended_action)}">${paper.recommended_action}</span>
    </div>
    <div class="feed-item-title">${escHtml(paper.title)}</div>
    <div class="feed-item-meta">
      <span>sim ${paper.max_component_similarity.toFixed(2)}</span>
      <span>${paper.date}</span>
    </div>
  `;

  item.addEventListener('click',   () => selectPaper(paper.paper_id));
  item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') selectPaper(paper.paper_id); });
  return item;
}

function selectPaper(paperId) {
  selectedId = paperId;

  document.querySelectorAll('.feed-item').forEach(el => {
    const selected = el.getAttribute('data-paper-id') === paperId;
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-selected', String(selected));
  });

  const paper = allPapers.find(p => p.paper_id === paperId);
  if (paper) renderDetail(paper);
}

function makeSection(label, bodyHtml) {
  const det = document.createElement('details');
  det.className = 'detail-section';

  const sum = document.createElement('summary');
  sum.textContent = label;
  det.appendChild(sum);

  const body = document.createElement('div');
  body.className = 'section-body';
  body.innerHTML = bodyHtml;
  det.appendChild(body);

  return det;
}

function rationaleBody(text, status) {
  if (status !== 'ok' || !text) {
    const chipClass = status === 'malformed' ? 'chip-malformed' : 'chip-unavailable';
    const msg = status === 'malformed'
      ? 'Response could not be parsed.'
      : 'Rationale unavailable — retry the pipeline to regenerate.';
    return `<div class="rationale-placeholder">
      <span class="status-chip ${chipClass}">${escHtml(status)}</span>
      <span class="placeholder-text">${escHtml(msg)}</span>
    </div>`;
  }
  return `<p>${escHtml(text)}</p>`;
}

function componentsTable(components, status) {
  const rows = components.map(c => {
    const simClass = c.cleared ? 'comp-sim-cleared' : 'comp-sim-below';
    const barClass = c.cleared ? 'cleared' : '';
    const width = simBarWidth(c.component_similarity);
    const explanation = (status === 'ok' && c.match_explanation)
      ? `<div class="comp-explanation">${escHtml(c.match_explanation)}</div>`
      : '';
    return `<tr>
      <td class="comp-name">${escHtml(c.component)}</td>
      <td>
        <div class="sim-bar-wrap">
          <span class="comp-sim ${simClass}">${c.component_similarity.toFixed(2)}</span>
          <span class="sim-bar ${barClass}" style="width:${width}px"></span>
        </div>
      </td>
      <td>${explanation}</td>
    </tr>`;
  }).join('');

  return `<table class="comp-table">
    <thead><tr>
      <th>Component</th><th>Similarity</th><th>Match explanation</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderDetail(paper) {
  const tangentialHtml = paper.tangential_flag
    ? `<span class="tangential-badge">Tangential match</span>`
    : '';

  const header = document.createElement('div');
  header.className = 'detail-header';
  header.innerHTML = `
    <h2 class="detail-title">${escHtml(paper.title)}</h2>
    <div class="detail-meta-row">
      <span class="action-badge ${badgeClass(paper.recommended_action)}">${paper.recommended_action}</span>
      <span class="detail-rank">Rank ${paper.rank} / 10</span>
      ${tangentialHtml}
      <span class="detail-date">${paper.date}</span>
    </div>
  `;

  const sections = document.createElement('div');
  sections.className = 'detail-sections';
  sections.appendChild(makeSection('Component Matches & Similarities', componentsTable(paper.components, paper.rationale_status)));
  sections.appendChild(makeSection('Relevance Rationale', rationaleBody(paper.relevance_rationale, paper.rationale_status)));
  sections.appendChild(makeSection('Recommended Action', `<p><strong>${escHtml(paper.recommended_action)}</strong> — max similarity ${paper.max_component_similarity.toFixed(2)}, ${paper.components_cleared_count} component(s) cleared.</p>`));
  sections.appendChild(makeSection('Missing Information', `<p>${escHtml(paper.missing_information || 'nothing material missing')}</p>`));
  sections.appendChild(makeSection('Position Rationale', rationaleBody(paper.position_rationale, paper.rationale_status)));

  detailContent.innerHTML = '';
  detailContent.appendChild(header);
  detailContent.appendChild(sections);
}

function renderFeedSummary(summary) {
  if (!summary || summary.summary_status !== 'ok' || !summary.text) {
    feedSummaryContent.innerHTML = `
      <div class="feed-summary-unavailable">
        <span class="status-chip chip-unavailable">summary unavailable</span>
        <span class="placeholder-text">— retry the pipeline to regenerate.</span>
      </div>`;
    return;
  }
  feedSummaryContent.innerHTML = `
    <div class="feed-summary-label">Feed Summary</div>
    <p class="feed-summary-text">${escHtml(summary.text)}</p>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function init() {
  try {
    const [papersRes, summaryRes] = await Promise.all([
      fetch('/api/papers'),
      fetch('/api/feed-summary'),
    ]);

    if (!papersRes.ok) throw new Error(`/api/papers returned ${papersRes.status}`);
    allPapers = await papersRes.json();

    const summary = summaryRes.ok ? await summaryRes.json() : null;
    renderFeedSummary(summary);

    feedList.innerHTML = '';
    for (const paper of allPapers) {
      feedList.appendChild(createFeedItem(paper));
    }

    // Select position 1 by default
    const first = allPapers.find(p => p.rank === 1);
    if (first) selectPaper(first.paper_id);
  } catch (err) {
    detailContent.innerHTML = `<p class="detail-empty">Failed to load papers: ${escHtml(String(err))}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
