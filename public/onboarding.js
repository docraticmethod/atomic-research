// Onboarding router for the dashboard. Decides between three surfaces:
//   1. author search → "is this you?" → confirm link  (the sole human decision)
//   2. "Finding papers for you…" while the pipeline runs
//   3. the ranked feed (delegated to dash-app-client.js once output exists)
// Plain ES module — no build step (mirrors the dash-app-client.js convention).

const $ = (id) => document.getElementById(id);

function show(el, on) { el.hidden = !on; }

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function getStatus() {
  const r = await fetch('/api/status');
  return r.json();
}

let feedLoaded = false;
async function showFeed() {
  show($('onboarding-panel'), false);
  show($('app-root'), true);
  if (!feedLoaded) {
    feedLoaded = true;
    await import('/dash-app-client.js'); // runs its main(), renders the feed
  }
}

function showOnboarding() {
  show($('app-root'), false);
  show($('onboarding-panel'), true);
  show($('onboarding-search-region'), true);
  show($('onboarding-confirm-region'), false);
  show($('onboarding-scanning-region'), false);
}

function showScanning(sub) {
  show($('app-root'), false);
  show($('onboarding-panel'), true);
  show($('onboarding-search-region'), false);
  show($('onboarding-confirm-region'), false);
  show($('onboarding-scanning-region'), true);
  if (sub) $('scanning-sub').textContent = sub;
}

function showError(msg) {
  const el = $('onboarding-error');
  el.textContent = msg;
  show(el, Boolean(msg));
}

// ── Author search (debounced) ──
let searchTimer = null;
function wireSearch() {
  const input = $('author-search');
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (q.length < 2) { $('author-results').innerHTML = ''; return; }
    searchTimer = setTimeout(() => runSearch(q), 350);
  });
}

async function runSearch(q) {
  try {
    const r = await fetch(`/api/authors?search=${encodeURIComponent(q)}`);
    const { results } = await r.json();
    renderResults(results || []);
  } catch (err) {
    showError(`Search failed: ${String(err)}`);
  }
}

function renderResults(results) {
  const box = $('author-results');
  if (results.length === 0) { box.innerHTML = '<p class="author-empty">No matches — try a fuller name.</p>'; return; }
  box.innerHTML = '';
  for (const a of results) {
    const row = document.createElement('button');
    row.className = 'author-result';
    row.innerHTML =
      `<span class="author-name">${escHtml(a.name)}</span>` +
      `<span class="author-affil">${escHtml(a.affiliation || 'No current affiliation')}</span>` +
      `<span class="author-stats">${a.paperCount} papers · ${a.citationCount} citations</span>`;
    row.addEventListener('click', () => renderConfirm(a));
    box.appendChild(row);
  }
}

function renderConfirm(a) {
  show($('onboarding-search-region'), false);
  const region = $('onboarding-confirm-region');
  show(region, true);
  region.innerHTML =
    `<div class="confirm-card">` +
      `<p class="confirm-q">Is this you?</p>` +
      `<p class="confirm-name">${escHtml(a.name)}</p>` +
      `<p class="confirm-affil">${escHtml(a.affiliation || 'No current affiliation')}</p>` +
      `<p class="confirm-stats">${a.paperCount} papers · ${a.citationCount} citations</p>` +
      `<div class="confirm-actions">` +
        `<button class="confirm-yes" id="confirm-yes">That's me →</button>` +
        `<button class="confirm-back" id="confirm-back">Back</button>` +
      `</div>` +
    `</div>`;
  $('confirm-back').addEventListener('click', showOnboarding);
  $('confirm-yes').addEventListener('click', () => link(a.authorId));
}

async function link(authorId) {
  showError('');
  showScanning('Linking your profile and pulling candidate papers…');
  try {
    const r = await fetch('/api/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author_id: authorId }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || `link failed (${r.status})`);
    }
    pollUntilDone();
  } catch (err) {
    showOnboarding();
    showError(String(err));
  }
}

function pollUntilDone() {
  const tick = async () => {
    const s = await getStatus();
    // Output presence is the source of truth — it appears precisely when this
    // run finishes (the server clears prior output at link time). Don't wait on
    // the child-exit flag, which can lag if the pipeline process stays alive.
    if (s.has_output) { location.reload(); return; }
    if (s.pipeline === 'error') { showOnboarding(); showError(s.pipeline_error || 'Pipeline failed — try again.'); return; }
    setTimeout(tick, 2500);
  };
  tick();
}

// ── Boot ──
async function main() {
  wireSearch();
  const s = await getStatus();
  if (s.has_output) { await showFeed(); return; }      // output exists → show the feed
  if (s.pipeline === 'running') { showScanning(); pollUntilDone(); return; }
  showOnboarding();
}

main().catch(err => { showOnboarding(); showError(`Client error: ${String(err)}`); });
