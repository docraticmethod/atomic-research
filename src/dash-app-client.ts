// TypeScript source for the dashboard client.
// The compiled/equivalent output is public/dash-app-client.js, served statically.
// This file is the authoritative typed source; public/dash-app-client.js mirrors it.

import type { ResearcherFeed, FeedItem, CouncilDeliberation, MatchedComponent } from './schemas.js';

declare const document: Document;
declare const fetch: typeof globalThis.fetch;

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

function decisionBadge(decision: boolean, status: string): string {
  if (status !== 'ok') {
    return `<span class="decision-badge badge-unavailable">Decision ${status}</span>`;
  }
  return decision
    ? `<span class="decision-badge badge-accept">Council Accept</span>`
    : `<span class="decision-badge badge-reject">Council Reject</span>`;
}

function deliberationHtml(delib: CouncilDeliberation, status: string): string {
  if (status !== 'ok' || !delib) {
    return `<p class="placeholder-text">Deliberation unavailable — retry the pipeline.</p>`;
  }
  const voiceRows = (delib.voices ?? []).map(v => {
    const lean = v.leaning === 'for' ? 'leaning-for' : 'leaning-against';
    return `<div class="voice-row">
      <span class="voice-role">${escHtml(v.role)}</span>
      <span class="voice-leaning ${lean}">${escHtml(v.leaning)}</span>
      <p class="voice-argument">${escHtml(v.argument)}</p>
    </div>`;
  }).join('');

  return `
    <div class="deliberation-block">
      <div class="deliberation-section-label">Voices</div>
      <div class="voices-list">${voiceRows}</div>
      <div class="deliberation-section-label">Substantive vs superficial</div>
      <p>${escHtml(delib.substantive_vs_superficial ?? '')}</p>
      <div class="deliberation-section-label">Resolution</div>
      <p>${escHtml(delib.resolution ?? '')}</p>
    </div>`;
}

function matchedComponentsHtml(components: MatchedComponent[], status: string): string {
  if (status !== 'ok' || !components?.length) {
    return `<p class="placeholder-text">No matched components.</p>`;
  }
  const rows = components.map(mc => `
    <div class="matched-component">
      <div class="mc-name">${escHtml(mc.component)}</div>
      <div class="mc-source">Source papers: ${escHtml(mc.source_paper_ids.join(', '))}</div>
      <p class="mc-explanation">${escHtml(mc.match_explanation)}</p>
    </div>`).join('');
  return `<div class="matched-components-list">${rows}</div>`;
}

function subfieldsHtml(subfields: string[]): string {
  if (!subfields?.length) return `<p class="placeholder-text">No matched subfields.</p>`;
  const tags = subfields.map(s => `<span class="subfield-tag">${escHtml(s)}</span>`).join('');
  return `<div class="subfield-tags">${tags}</div>`;
}

function renderFeedSummary(rf: ResearcherFeed): void {
  const container = document.getElementById('feed-summary-content')!;
  if (rf.feed_summary.summary_status !== 'ok' || !rf.feed_summary.text) {
    container.innerHTML = `<div class="feed-summary-placeholder">Summary unavailable — retry the pipeline to regenerate.</div>`;
    return;
  }
  container.innerHTML = `<p class="feed-summary-text">${escHtml(rf.feed_summary.text)}</p>`;
}

function renderFeedList(
  rf: ResearcherFeed,
  selectedPaperId: string,
  onSelect: (paperId: string) => void,
): void {
  const list = document.getElementById('feed-list')!;
  list.innerHTML = '';

  for (const fi of rf.feed) {
    const item = document.createElement('div');
    item.className = `feed-item${fi.paper_id === selectedPaperId ? ' selected' : ''}${fi.relevance_decision ? '' : ' rejected'}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(fi.paper_id === selectedPaperId));
    item.dataset.paperId = fi.paper_id;

    const decisionLabel = fi.decision_status !== 'ok'
      ? `<span class="fi-status-chip">Decision ${fi.decision_status}</span>`
      : fi.relevance_decision
        ? `<span class="fi-decision accept">Accept</span>`
        : `<span class="fi-decision reject">Reject</span>`;

    const topComponent = fi.matched_components?.[0]?.component ?? '—';

    item.innerHTML = `
      <div class="fi-header">
        <span class="fi-position">${fi.position}</span>
        <span class="fi-score">${fi.relevance_score.toFixed(2)}</span>
        ${decisionLabel}
      </div>
      <div class="fi-title">${escHtml(fi.title)}</div>
      <div class="fi-meta">
        <span class="fi-date">${fi.publication_date}</span>
        <span class="fi-component">${escHtml(topComponent)}</span>
      </div>`;

    item.addEventListener('click', () => onSelect(fi.paper_id));
    list.appendChild(item);
  }
}

function renderDetail(fi: FeedItem, researcherSubfields: string[]): void {
  const container = document.getElementById('detail-content')!;

  const header = document.createElement('div');
  header.className = 'detail-header';
  header.innerHTML = `
    <h2 class="detail-title">${escHtml(fi.title)}</h2>
    <div class="detail-meta-row">
      ${decisionBadge(fi.relevance_decision, fi.decision_status)}
      <span class="detail-position">Position ${fi.position} / 10</span>
      <span class="detail-score">Score ${fi.relevance_score.toFixed(2)}</span>
      <span class="detail-confidence">Confidence ${fi.council_confidence}</span>
      <span class="detail-date">${fi.publication_date}</span>
    </div>`;

  const sections = document.createElement('div');
  sections.className = 'detail-sections';

  sections.appendChild(makeSection('Relevance Reason',
    fi.decision_status === 'ok' && fi.relevance_reason
      ? `<p>${escHtml(fi.relevance_reason)}</p>`
      : `<p class="placeholder-text">Unavailable — retry the pipeline.</p>`,
  ));

  sections.appendChild(makeSection('Council Deliberation',
    deliberationHtml(fi.council_deliberation, fi.decision_status),
  ));

  sections.appendChild(makeSection('Matched Components',
    matchedComponentsHtml(fi.matched_components, fi.decision_status),
  ));

  sections.appendChild(makeSection('Matched Subfields',
    subfieldsHtml(fi.matched_subfields),
  ));

  sections.appendChild(makeSection('Researcher Profile — Selected Subfields',
    subfields => {
      if (!subfields.length) return `<p class="placeholder-text">No subfields on profile.</p>`;
      const tags = subfields.map(s => `<span class="subfield-tag profile-subfield">${escHtml(s)}</span>`).join('');
      return `<div class="subfield-tags">${tags}</div>`;
    })(researcherSubfields),
  ));

  container.innerHTML = '';
  container.appendChild(header);
  container.appendChild(sections);
}

function renderResearcherSelector(
  feeds: ResearcherFeed[],
  selectedId: string,
  onSelect: (id: string) => void,
): void {
  const container = document.getElementById('researcher-selector')!;
  container.innerHTML = '';
  for (const rf of feeds) {
    const btn = document.createElement('button');
    btn.className = `researcher-tab${rf.researcher_id === selectedId ? ' active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(rf.researcher_id === selectedId));
    btn.textContent = rf.researcher_name;
    btn.addEventListener('click', () => onSelect(rf.researcher_id));
    container.appendChild(btn);
  }
}

async function main(): Promise<void> {
  const resp = await fetch('/api/artifact');
  if (!resp.ok) {
    document.getElementById('detail-content')!.innerHTML =
      `<p class="placeholder-text">Failed to load artifact — is the pipeline output ready?</p>`;
    return;
  }
  const feeds = (await resp.json()) as ResearcherFeed[];
  if (!feeds.length) return;

  let selectedResearcherId = feeds[0].researcher_id;
  let selectedPaperId: string = feeds[0].feed[0]?.paper_id ?? '';

  function getSubfieldsForResearcher(rf: ResearcherFeed): string[] {
    return [...new Set(rf.feed.flatMap(fi => fi.matched_subfields))];
  }

  function renderAll(): void {
    const rf = feeds.find(r => r.researcher_id === selectedResearcherId)!;
    const fi = rf.feed.find(f => f.paper_id === selectedPaperId) ?? rf.feed[0];

    renderResearcherSelector(feeds, selectedResearcherId, (id) => {
      selectedResearcherId = id;
      const newRf = feeds.find(r => r.researcher_id === id)!;
      selectedPaperId = newRf.feed[0]?.paper_id ?? '';
      renderAll();
    });

    renderFeedSummary(rf);

    renderFeedList(rf, fi.paper_id, (paperId) => {
      selectedPaperId = paperId;
      renderAll();
    });

    if (fi) {
      renderDetail(fi, getSubfieldsForResearcher(rf));
    }
  }

  renderAll();
}

main().catch(err => {
  document.getElementById('detail-content')!.innerHTML =
    `<p class="placeholder-text">Client error: ${String(err)}</p>`;
});
