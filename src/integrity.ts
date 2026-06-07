import { op } from 'weave';
import type { GroundedProfile, GroundedComponent, GroundedSubfield } from './schemas.js';
import type { Logger } from './logger.js';

// The Layer-1 repair re-prompt. Given the structural failure reason, returns a
// fresh raw extraction string. Implemented by subagent.ts (an LLM call); injected
// so integrity.ts stays free of SDK concerns and is unit-testable.
export type RepairFn = (failureReason: string) => Promise<string>;

const MAX_REPAIR_ATTEMPTS = 4;
const BACKOFF_MS = [3000, 6000, 9000, 12000];

// ── Deterministic helpers (not Weave ops — pure, fast, no SDK) ──────────────

function sanitize(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    // strip control chars that break JSON.parse
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // strip trailing commas before } or ]
    .replace(/,(\s*[}\]])/g, '$1')
    .trim();
}

type StructuralResult =
  | { valid: true; parsed: Record<string, unknown> }
  | { valid: false; reason: string };

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function nonEmptyStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.trim().length > 0);
}

function checkStructural(raw: string): StructuralResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitize(raw));
  } catch (err) {
    return { valid: false, reason: `not parseable JSON: ${String(err)}` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, reason: 'top-level value is not an object' };
  }

  const obj = parsed as Record<string, unknown>;
  const components = obj.research_components;
  const subfields = obj.research_subfield_preferences;

  if (!Array.isArray(components) || components.length === 0) {
    return { valid: false, reason: 'research_components must be a non-empty array' };
  }
  if (!Array.isArray(subfields) || subfields.length === 0) {
    return { valid: false, reason: 'research_subfield_preferences must be a non-empty array' };
  }

  for (const [i, c] of components.entries()) {
    if (c === null || typeof c !== 'object') {
      return { valid: false, reason: `research_components[${i}] is not an object` };
    }
    const comp = c as Record<string, unknown>;
    if (!nonEmptyString(comp.name)) return { valid: false, reason: `research_components[${i}].name missing/empty` };
    if (!nonEmptyString(comp.description)) return { valid: false, reason: `research_components[${i}].description missing/empty` };
    if (!nonEmptyStringArray(comp.source_paper_ids)) return { valid: false, reason: `research_components[${i}].source_paper_ids missing/empty` };
    if (!nonEmptyString(comp.explanation)) return { valid: false, reason: `research_components[${i}].explanation missing/empty` };
  }

  for (const [i, s] of subfields.entries()) {
    if (s === null || typeof s !== 'object') {
      return { valid: false, reason: `research_subfield_preferences[${i}] is not an object` };
    }
    const sub = s as Record<string, unknown>;
    if (!nonEmptyString(sub.name)) return { valid: false, reason: `research_subfield_preferences[${i}].name missing/empty` };
    if (!nonEmptyString(sub.description)) return { valid: false, reason: `research_subfield_preferences[${i}].description missing/empty` };
    if (!nonEmptyStringArray(sub.source_paper_ids)) return { valid: false, reason: `research_subfield_preferences[${i}].source_paper_ids missing/empty` };
    if (!nonEmptyString(sub.explanation)) return { valid: false, reason: `research_subfield_preferences[${i}].explanation missing/empty` };
  }

  return { valid: true, parsed: obj };
}

type GateResult = {
  components: GroundedComponent[];
  subfields: GroundedSubfield[];
  rejectedComponents: string[];
  rejectedSubfields: string[];
};

// Layer 2 — referential integrity gate. Every source_paper_id must resolve to a
// real publication in this researcher's corpus. Any component/subfield citing a
// non-existent id is hard-rejected deterministically — never repaired.
function applyReferentialGate(parsed: Record<string, unknown>, publicationIds: Set<string>): GateResult {
  const rawComponents = (parsed.research_components as Record<string, unknown>[]) ?? [];
  const rawSubfields = (parsed.research_subfield_preferences as Record<string, unknown>[]) ?? [];

  const components: GroundedComponent[] = [];
  const subfields: GroundedSubfield[] = [];
  const rejectedComponents: string[] = [];
  const rejectedSubfields: string[] = [];

  for (const c of rawComponents) {
    const ids = (c.source_paper_ids as string[]) ?? [];
    const allResolve = ids.length > 0 && ids.every(id => publicationIds.has(id));
    if (allResolve) {
      components.push({
        name: String(c.name),
        description: String(c.description),
        source_paper_ids: ids,
        explanation: String(c.explanation),
        aptness_flags: [],
      });
    } else {
      rejectedComponents.push(String(c.name));
    }
  }

  for (const s of rawSubfields) {
    const ids = (s.source_paper_ids as string[]) ?? [];
    const allResolve = ids.length > 0 && ids.every(id => publicationIds.has(id));
    if (allResolve) {
      subfields.push({
        name: String(s.name),
        description: String(s.description),
        source_paper_ids: ids,
        explanation: String(s.explanation),
        aptness_flags: [],
      });
    } else {
      rejectedSubfields.push(String(s.name));
    }
  }

  return { components, subfields, rejectedComponents, rejectedSubfields };
}

// Layer 3 — advisory aptness flags. Attaches Call-2 semantic concerns to the
// matching component/subfield. NEVER rejects anything; only annotates.
function applyAptnessFlags(
  components: GroundedComponent[],
  subfields: GroundedSubfield[],
  call2Raw: string | null,
  logger: Logger,
): number {
  if (call2Raw === null) {
    logger.warn('aptness validation unavailable — Call 2 returned null; proceeding with no advisory flags');
    return 0;
  }

  let flagsRaised = 0;
  try {
    const parsed = JSON.parse(sanitize(call2Raw)) as Record<string, unknown>;
    const flags = (parsed.aptness_flags as Array<Record<string, unknown>>) ?? [];
    for (const f of flags) {
      const target = String(f.target ?? '').trim();
      const flag = String(f.flag ?? '').trim();
      if (!target || !flag) continue;
      const comp = components.find(c => c.name === target);
      if (comp) {
        comp.aptness_flags.push(flag);
        flagsRaised++;
        continue;
      }
      const sub = subfields.find(s => s.name === target);
      if (sub) {
        sub.aptness_flags.push(flag);
        flagsRaised++;
      }
    }
  } catch (err) {
    logger.warn('aptness validation parse failed — advisory only, ignoring', { error: String(err) });
  }
  return flagsRaised;
}

// ── The integrity model: sanitize → Layer 1 (+repair) → Layer 2 → Layer 3 ──
//
// Returns a validated GroundedProfile, or null for the degraded state. NEVER
// returns a partial profile. The three prohibitions are enforced structurally:
//   1. Layer 3 (aptness) only annotates aptness_flags — it cannot reject.
//   2. The repair loop is driven solely by checkStructural (Layer 1) failures —
//      a Layer 2 referential failure is never fed back to repairFn.
//   3. On any failure path the function returns null, not a trimmed profile.
export const runIntegrityModel = op(async function runIntegrityModel(
  call1Raw: string,
  call2Raw: string | null,
  researcherId: string,
  publicationIds: Set<string>,
  logger: Logger,
  repairFn: RepairFn,
): Promise<GroundedProfile | null> {
  // ── Layer 1: structural validity + repair loop ──
  let currentRaw = call1Raw;
  let structural = checkStructural(currentRaw);
  let repairAttempts = 0;

  while (!structural.valid && repairAttempts < MAX_REPAIR_ATTEMPTS) {
    const reason = structural.reason;
    logger.warn('grounding structurally invalid — repairing', {
      researcher_id: researcherId,
      attempt: repairAttempts + 1,
      reason,
    });
    await new Promise<void>(resolve => setTimeout(resolve, BACKOFF_MS[repairAttempts]));
    try {
      currentRaw = await repairFn(reason);
      structural = checkStructural(currentRaw);
    } catch (err) {
      logger.error('repair re-prompt failed', { researcher_id: researcherId, attempt: repairAttempts + 1, error: String(err) });
    }
    repairAttempts++;
  }

  if (!structural.valid) {
    logger.error('grounding degraded — structurally invalid after repair loop', {
      researcher_id: researcherId,
      repair_attempts: repairAttempts,
      reason: structural.reason,
    });
    return null;
  }

  // ── Layer 2: referential integrity gate (deterministic, never repaired) ──
  const gate = applyReferentialGate(structural.parsed, publicationIds);

  if (gate.rejectedComponents.length > 0 || gate.rejectedSubfields.length > 0) {
    logger.warn('referential gate rejected entries citing non-existent publications', {
      researcher_id: researcherId,
      rejected_components: gate.rejectedComponents,
      rejected_subfields: gate.rejectedSubfields,
    });
  }

  if (gate.components.length === 0) {
    logger.error('grounding degraded — no component survived the referential gate', {
      researcher_id: researcherId,
      rejected_components: gate.rejectedComponents,
    });
    return null;
  }

  // A profile needs at least one grounded subfield too (output schema requires it).
  if (gate.subfields.length === 0) {
    logger.error('grounding degraded — no subfield survived the referential gate', {
      researcher_id: researcherId,
      rejected_subfields: gate.rejectedSubfields,
    });
    return null;
  }

  // ── Layer 3: advisory aptness flags (never rejects) ──
  const aptnessFlagsRaised = applyAptnessFlags(gate.components, gate.subfields, call2Raw, logger);

  logger.info('grounding validated', {
    researcher_id: researcherId,
    components: gate.components.length,
    subfields: gate.subfields.length,
    repair_attempts: repairAttempts,
    referential_rejections: gate.rejectedComponents.length + gate.rejectedSubfields.length,
    aptness_flags_raised: aptnessFlagsRaised,
  });

  return {
    researcher_id: researcherId,
    grounding_status: 'ok',
    research_components: gate.components,
    research_subfield_preferences: gate.subfields,
  };
});
