// TypeScript source for the dashboard client.
// The compiled/equivalent output is public/dash-app-client.js, served statically.
// This file is the authoritative typed source; public/dash-app-client.js mirrors it.

import type { ResearcherFeed, FeedItem, CouncilDeliberation, MatchedComponent, GroundedProfile } from './schemas.js';

declare const document: Document;

function escHtml(str: string): string {
  return String(str)
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
    return `<span class="decision-badge badge-unavailable">Decision ${escHtml(status)}</span>`;
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
      <div class="deliberation-section-label">Subfield weighing</div>
      <p>${escHtml(delib.subfield_weighing ?? '')}</p>
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
      <div class="mc-source">Source publications: ${escHtml((mc.source_paper_ids ?? []).join(', '))}</div>
      <p class="mc-explanation">${escHtml(mc.match_explanation)}</p>
    </div>`).join('');
  return `<div class="matched-components-list">${rows}</div>`;
}

function subfieldsHtml(subfields: string[]): string {
  if (!subfields?.length) return `<p class="placeholder-text">No matched subfields.</p>`;
  const tags = subfields.map(s => `<span class="subfield-tag">${escHtml(s)}</span>`).join('');
  return `<div class="subfield-tags">${tags}</div>`;
}

// Renders the grounded research components + subfields for the researcher,
// each traceable to its source publications.
function groundedProfileHtml(profile: GroundedProfile | null): string {
  if (!profile) {
    return `<p class="placeholder-text">Profile grounding unavailable for this researcher.</p>`;
  }
  const components = profile.research_components.map(c => {
    const flags = c.aptness_flags?.length
      ? `<div class="aptness-flags">${c.aptness_flags.map(f => `<span class="aptness-flag">⚑ ${escHtml(f)}</span>`).join('')}</div>`
      : '';
    return `<div class="grounded-component">
      <div class="gc-name">${escHtml(c.name)}</div>
      <p class="gc-description">${escHtml(c.description)}</p>
      <div class="gc-source">Source publications: ${escHtml(c.source_paper_ids.join(', '))}</div>
      ${flags}
    </div>`;
  }).join('');

  const subfields = profile.research_subfield_preferences.map(s => `
    <div class="grounded-subfield">
      <div class="gs-name">${escHtml(s.name)}</div>
      <div class="gs-source">Source publications: ${escHtml(s.source_paper_ids.join(', '))}</div>
    </div>`).join('');

  return `
    <div class="researcher-profile-panel">
      <div class="profile-block-label">Grounded Research Components</div>
      <div class="grounded-components-list">${components}</div>
      <div class="profile-block-label">Grounded Subfields</div>
      <div class="grounded-subfields-list">${subfields}</div>
    </div>`;
}

function renderFeedSummary(rf: ResearcherFeed): void {
  const container = document.getElementById('feed-summary-content')!;
  if (rf.grounding_status !== 'ok') {
    container.innerHTML = `<div class="feed-summary-placeholder">Profile grounding unavailable for ${escHtml(rf.researcher_name)}.</div>`;
    return;
  }
  if (rf.feed_summary.summary_status !== 'ok' || !rf.feed_summary.text) {
    container.innerHTML = `<div class="feed-summary-placeholder">Summary unavailable — retry the pipeline to regenerate.</div>`;
    return;
  }
  container.innerHTML = `<p class="feed-summary-text">${escHtml(rf.feed_summary.text)}</p>`;
}

function renderGroundingDegraded(rf: ResearcherFeed): void {
  const list = document.getElementById('feed-list')!;
  list.innerHTML = `<div class="grounding-unavailable-state">
    <div class="gus-title">Profile grounding unavailable</div>
    <p class="gus-body">Grounding did not produce a validated profile for ${escHtml(rf.researcher_name)}, so the council did not run. No partial profile is shown.</p>
    <div class="gus-retry">Retry the pipeline to regenerate this researcher's profile.</div>
  </div>`;

  const detail = document.getElementById('detail-content')!;
  detail.innerHTML = `<div class="grounding-unavailable-state detail">
    <div class="gus-title">Profile grounding unavailable</div>
    <p class="gus-body">This researcher entered the grounding degraded state. The relevance council is unreachable without a validated profile.</p>
  </div>`;
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
    const isSelected = fi.paper_id === selectedPaperId;
    item.className = `feed-item${isSelected ? ' selected' : ''}${fi.relevance_decision ? '' : ' rejected'}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(isSelected));
    item.dataset.paperId = fi.paper_id;

    let decisionHtml: string;
    if (fi.decision_status !== 'ok') {
      decisionHtml = `<span class="fi-status-chip">Decision ${escHtml(fi.decision_status)}</span>`;
    } else if (fi.relevance_decision) {
      decisionHtml = `<span class="fi-decision accept">Accept</span>`;
    } else {
      decisionHtml = `<span class="fi-decision reject">Reject</span>`;
    }

    const topComponent = fi.matched_components?.[0]?.component ?? '—';

    item.innerHTML = `
      <div class="fi-header">
        <span class="fi-position">${fi.position}</span>
        <span class="fi-score">${fi.relevance_score.toFixed(2)}</span>
        ${decisionHtml}
      </div>
      <div class="fi-title">${escHtml(fi.title)}</div>
      <div class="fi-meta">
        <span class="fi-date">${escHtml(fi.publication_date)}</span>
        <span class="fi-component">${escHtml(topComponent)}</span>
      </div>`;

    item.addEventListener('click', () => onSelect(fi.paper_id));
    list.appendChild(item);
  }
}

function renderDetail(fi: FeedItem, profile: GroundedProfile | null): void {
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
      <span class="detail-date">${escHtml(fi.publication_date)}</span>
    </div>`;

  const sections = document.createElement('div');
  sections.className = 'detail-sections';

  const reasonBody = (fi.decision_status === 'ok' && fi.relevance_reason)
    ? `<p>${escHtml(fi.relevance_reason)}</p>`
    : `<p class="placeholder-text">Unavailable — retry the pipeline.</p>`;

  sections.appendChild(makeSection('Relevance Reason', reasonBody));
  sections.appendChild(makeSection('Council Deliberation', deliberationHtml(fi.council_deliberation, fi.decision_status)));
  sections.appendChild(makeSection('Matched Components', matchedComponentsHtml(fi.matched_components, fi.decision_status)));
  sections.appendChild(makeSection('Matched Subfields', subfieldsHtml(fi.matched_subfields)));
  sections.appendChild(makeSection('Researcher Profile — Grounded', groundedProfileHtml(profile)));

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
    const degraded = rf.grounding_status !== 'ok' ? ' grounding-degraded' : '';
    btn.className = `researcher-tab${rf.researcher_id === selectedId ? ' active' : ''}${degraded}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(rf.researcher_id === selectedId));
    btn.textContent = rf.grounding_status !== 'ok'
      ? `${rf.researcher_name} (grounding unavailable)`
      : rf.researcher_name;
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

  function renderAll(): void {
    const rf = feeds.find(r => r.researcher_id === selectedResearcherId) ?? feeds[0];

    renderResearcherSelector(feeds, selectedResearcherId, (id) => {
      selectedResearcherId = id;
      const newRf = feeds.find(r => r.researcher_id === id) ?? feeds[0];
      selectedPaperId = newRf.feed[0]?.paper_id ?? '';
      renderAll();
    });

    renderFeedSummary(rf);

    if (rf.grounding_status !== 'ok' || rf.feed.length === 0) {
      renderGroundingDegraded(rf);
      return;
    }

    const fi = rf.feed.find(f => f.paper_id === selectedPaperId) ?? rf.feed[0];

    renderFeedList(rf, fi.paper_id, (paperId) => {
      selectedPaperId = paperId;
      renderAll();
    });

    renderDetail(fi, rf.grounded_profile);
  }

  renderAll();
}

main().catch(err => {
  document.getElementById('detail-content')!.innerHTML =
    `<p class="placeholder-text">Client error: ${String(err)}</p>`;
});
