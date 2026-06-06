// TypeScript source for the dashboard client.
// The compiled/equivalent output is public/dash-app-client.js, served statically.
// This file is the authoritative typed source; public/dash-app-client.js mirrors it.

import type { OutputPaper } from './schemas.js';

declare const document: Document;

type SelectFn = (paperId: string) => void;

function badgeClass(action: string): string {
  if (action === 'Read now') return 'badge-read';
  if (action === 'Save')     return 'badge-save';
  return 'badge-skip';
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeSection(label: string, bodyHtml: string): HTMLElement {
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

function rationaleBody(text: string, status: string): string {
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

function componentsTable(paper: OutputPaper): string {
  const rows = paper.components.map(c => {
    const simClass = c.cleared ? 'comp-sim-cleared' : 'comp-sim-below';
    const barClass = c.cleared ? 'cleared' : '';
    const width = Math.round(c.component_similarity * 80);
    const explanation = (paper.rationale_status === 'ok' && c.match_explanation)
      ? `<div class="comp-explanation">${escHtml(c.match_explanation)}</div>`
      : '';
    return `<tr>
      <td class="comp-name">${escHtml(c.component)}</td>
      <td><div class="sim-bar-wrap">
        <span class="comp-sim ${simClass}">${c.component_similarity.toFixed(2)}</span>
        <span class="sim-bar ${barClass}" style="width:${width}px"></span>
      </div></td>
      <td>${explanation}</td>
    </tr>`;
  }).join('');
  return `<table class="comp-table">
    <thead><tr><th>Component</th><th>Similarity</th><th>Match explanation</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function renderDetail(paper: OutputPaper, container: HTMLElement): void {
  const tangentialHtml = paper.tangential_flag
    ? `<span class="tangential-badge">Tangential match</span>` : '';

  const header = document.createElement('div');
  header.className = 'detail-header';
  header.innerHTML = `
    <h2 class="detail-title">${escHtml(paper.title)}</h2>
    <div class="detail-meta-row">
      <span class="action-badge ${badgeClass(paper.recommended_action)}">${escHtml(paper.recommended_action)}</span>
      <span class="detail-rank">Rank ${paper.rank} / 10</span>
      ${tangentialHtml}
      <span class="detail-date">${paper.date}</span>
    </div>`;

  const sections = document.createElement('div');
  sections.className = 'detail-sections';
  sections.appendChild(makeSection('Component Matches & Similarities', componentsTable(paper)));
  sections.appendChild(makeSection('Relevance Rationale', rationaleBody(paper.relevance_rationale, paper.rationale_status)));
  sections.appendChild(makeSection('Recommended Action',
    `<p><strong>${escHtml(paper.recommended_action)}</strong> — max similarity ${paper.max_component_similarity.toFixed(2)}, ${paper.components_cleared_count} component(s) cleared.</p>`));
  if (paper.missing_information) {
    sections.appendChild(makeSection('Missing Information', `<p>${escHtml(paper.missing_information)}</p>`));
  }
  sections.appendChild(makeSection('Position Rationale', rationaleBody(paper.position_rationale, paper.rationale_status)));

  container.innerHTML = '';
  container.appendChild(header);
  container.appendChild(sections);
}

export async function init(selectFn: SelectFn, papers: OutputPaper[]): Promise<void> {
  const first = papers.find(p => p.rank === 1);
  if (first) selectFn(first.paper_id);
}
