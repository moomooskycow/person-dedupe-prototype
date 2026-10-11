// Orchestrates the detection pipeline: blocking -> scoring -> adjudication ->
// persistence. This is what the batch "Scan now" endpoint and the seed
// script both call, and what the synchronous create-person check reuses.

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Person, Booking, Signal, LlmAdjudication, Tier, BlockingRule } from './types';
import { generateCandidatePairs, pairKey, canonicalPair, type PersonPair } from './candidates';
import { scorePair } from './score';
import { effectiveConfidence, deriveBucket } from './score';
import { adjudicateBatch, type AdjudicationInput } from './adjudicate';

export interface ScanResult {
  activePeople: number;
  candidatePairsSeen: number;
  newCandidates: number;
  dropped: number;
  llmCalls: number;
  /** Previously-pending pairs (llm=null) whose adjudication completed this run. */
  rescored: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function bookingsLoader(db: Database.Database) {
  const cache = new Map<string, Booking[]>();
  return (personId: string): Booking[] => {
    let rows = cache.get(personId);
    if (!rows) {
      rows = db.prepare('SELECT * FROM bookings WHERE person_id = ?').all(personId) as Booking[];
      cache.set(personId, rows);
    }
    return rows;
  };
}

/**
 * `certain` pairs skip adjudication (confidence = 95+). `ambiguous` pairs
 * that come back LLM-confirmed as a duplicate at reasonable confidence get
 * relabeled `likely` — deterministic scoring alone wasn't enough to call it,
 * but the model closed the gap. Everything else (unclear / distinct_people /
 * low-confidence) stays `ambiguous`.
 */
function deriveTierPostAdjudication(llm: LlmAdjudication | null): Tier {
  if (!llm) return 'ambiguous';
  if (llm.verdict === 'duplicate' && llm.confidence >= 60) return 'likely';
  return 'ambiguous';
}

function bucketFor(tier: Tier, det_score: number, llm: LlmAdjudication | null): string {
  return deriveBucket(effectiveConfidence({ tier, det_score, llm }));
}

export async function runScan(db: Database.Database): Promise<ScanResult> {
  const people = db.prepare("SELECT * FROM people WHERE status = 'active'").all() as Person[];
  const peopleById = new Map(people.map((p) => [p.id, p]));

  const candidatePairs = generateCandidatePairs(people);

  const existingRows = db
    .prepare('SELECT person_a_id, person_b_id FROM duplicate_candidates')
    .all() as { person_a_id: string; person_b_id: string }[];
  const existingKeys = new Set(existingRows.map((r) => `${r.person_a_id}::${r.person_b_id}`));

  const newPairs = candidatePairs.filter((p) => !existingKeys.has(pairKey(p.pair)));
  const getBookings = bookingsLoader(db);

  const scored = newPairs.map(({ pair, rules }) => {
    const a = peopleById.get(pair[0])!;
    const b = peopleById.get(pair[1])!;
    const result = scorePair(a, b, getBookings(a.id), getBookings(b.id));
    return { pair, rules, a, b, result };
  });

  const dropped = scored.filter((s) => s.result.tier === 'weak');
  const certain = scored.filter((s) => s.result.tier === 'certain');
  const ambiguous = scored.filter((s) => s.result.tier === 'ambiguous');

  // Pending pairs from earlier scans (persisted with llm=null because
  // adjudication failed or had no fixture) get re-sent alongside the new
  // batch — "unscored-pending" means pending, not forgotten.
  const pendingRows = db
    .prepare(
      "SELECT id, person_a_id, person_b_id, signals, det_score FROM duplicate_candidates WHERE status = 'open' AND tier = 'ambiguous' AND llm IS NULL",
    )
    .all() as { id: string; person_a_id: string; person_b_id: string; signals: string; det_score: number }[];
  const pending = pendingRows
    .filter((r) => peopleById.has(r.person_a_id) && peopleById.has(r.person_b_id))
    .map((r) => ({
      row: r,
      input: {
        pair: canonicalPair(r.person_a_id, r.person_b_id),
        personA: peopleById.get(r.person_a_id)!,
        personB: peopleById.get(r.person_b_id)!,
        signals: JSON.parse(r.signals) as Signal[],
      } satisfies AdjudicationInput,
    }));

  const adjudicationInputs: AdjudicationInput[] = [
    ...ambiguous.map((s) => ({ pair: s.pair, personA: s.a, personB: s.b, signals: s.result.signals })),
    ...pending.map((p) => p.input),
  ];
  const adjudications = await adjudicateBatch(adjudicationInputs);

  const insert = db.prepare(
    `INSERT INTO duplicate_candidates
      (id, person_a_id, person_b_id, blocking_rules, signals, det_score, tier, llm, bucket, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  );

  const now = nowIso();
  let newCandidates = 0;

  for (const s of certain) {
    insert.run(
      uuidv4(),
      s.pair[0],
      s.pair[1],
      JSON.stringify(s.rules),
      JSON.stringify(s.result.signals),
      s.result.det_score,
      'certain',
      null,
      bucketFor('certain', s.result.det_score, null),
      now,
      now,
    );
    newCandidates++;
  }

  for (const s of ambiguous) {
    const llm = adjudications.get(pairKey(s.pair)) ?? null;
    const tier = deriveTierPostAdjudication(llm);
    insert.run(
      uuidv4(),
      s.pair[0],
      s.pair[1],
      JSON.stringify(s.rules),
      JSON.stringify(s.result.signals),
      s.result.det_score,
      tier,
      llm ? JSON.stringify(llm) : null,
      bucketFor(tier, s.result.det_score, llm),
      now,
      now,
    );
    newCandidates++;
  }

  let rescored = 0;
  const updatePending = db.prepare(
    'UPDATE duplicate_candidates SET llm = ?, tier = ?, bucket = ?, updated_at = ? WHERE id = ?',
  );
  for (const p of pending) {
    const llm = adjudications.get(pairKey(p.input.pair));
    if (!llm) continue; // still pending — next scan tries again
    const tier = deriveTierPostAdjudication(llm);
    updatePending.run(JSON.stringify(llm), tier, bucketFor(tier, p.row.det_score, llm), now, p.row.id);
    rescored++;
  }

  return {
    activePeople: people.length,
    candidatePairsSeen: candidatePairs.length,
    newCandidates,
    dropped: dropped.length,
    llmCalls: adjudicationInputs.length,
    rescored,
  };
}

const SIGNAL_LABELS: Record<string, string> = {
  email: 'email matches',
  phone: 'phone matches',
  license_plate: 'license plate matches',
  full_name: 'name',
  address_line: 'address matches',
  date_of_birth: 'date of birth',
  first_name: 'first name differs',
  bookings: 'overlapping stay at a different site',
};

/** Human-readable one-liner for the create-person warning panel, e.g. "email matches, name 92% similar". */
export function describeSignals(signals: Signal[]): string {
  const parts = signals
    .filter((s) => s.kind !== 'conflict')
    .map((s) => {
      const label = SIGNAL_LABELS[s.field] ?? s.field;
      if (s.kind === 'fuzzy') return `${label} ${Math.round(s.similarity * 100)}% similar`;
      if (s.field === 'date_of_birth') return 'date of birth matches';
      return label;
    });
  return parts.join(', ');
}

export interface SingleCheckMatch {
  person: Person;
  det_score: number;
  tier: Tier;
  signals: Signal[];
  description: string;
}

export type PersonDraft = Pick<
  Person,
  | 'first_name'
  | 'last_name'
  | 'email'
  | 'phone'
  | 'date_of_birth'
  | 'address_line'
  | 'city'
  | 'region'
  | 'postal_code'
  | 'license_plate'
>;

const DRAFT_ID = '__draft__';

/**
 * Synchronous single-record duplicate check for the create-person flow.
 * Runs the same normalize -> block -> score path against active people,
 * without persisting anything.
 */
export function checkSingleRecord(db: Database.Database, draft: PersonDraft): SingleCheckMatch[] {
  const people = db.prepare("SELECT * FROM people WHERE status = 'active'").all() as Person[];
  const draftPerson: Person = {
    id: DRAFT_ID,
    first_name: draft.first_name,
    last_name: draft.last_name,
    email: draft.email,
    phone: draft.phone,
    date_of_birth: draft.date_of_birth ?? null,
    address_line: draft.address_line,
    city: draft.city,
    region: draft.region,
    postal_code: draft.postal_code,
    license_plate: draft.license_plate,
    notes: null,
    status: 'active',
    merged_into: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const candidatePairs = generateCandidatePairs([...people, draftPerson], DRAFT_ID);
  const getBookings = bookingsLoader(db);
  const peopleById = new Map(people.map((p) => [p.id, p]));

  const matches: SingleCheckMatch[] = [];
  for (const { pair } of candidatePairs) {
    const otherId = pair[0] === DRAFT_ID ? pair[1] : pair[0];
    const other = peopleById.get(otherId)!;
    const result = scorePair(draftPerson, other, [], getBookings(other.id));
    if (result.tier === 'weak') continue;
    matches.push({
      person: other,
      det_score: result.det_score,
      tier: result.tier,
      signals: result.signals,
      description: describeSignals(result.signals),
    });
  }

  return matches.sort((a, b) => b.det_score - a.det_score);
}
