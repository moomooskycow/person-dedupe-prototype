// Blocking + candidate pair generation. Never O(n^2) pairwise — a pair only
// becomes a candidate if it shares at least one blocking key. Records which
// rule(s) fired per pair (`blocking_rules`) for the audit trail.

import type { BlockingRule, Person } from './types';
import {
  normalizeEmail,
  normalizePhone,
  normalizeLicensePlate,
  normalizePostalCode,
  normalizeName,
  normalizeFullName,
  normalizeDob,
} from './normalize';

export type PersonPair = readonly [string, string];

export interface CandidatePair {
  pair: PersonPair;
  rules: BlockingRule[];
}

/** Canonically orders a pair of person ids so (a,b) and (b,a) collapse to one key. */
export function canonicalPair(aId: string, bId: string): PersonPair {
  return aId < bId ? [aId, bId] : [bId, aId];
}

export function pairKey(pair: PersonPair): string {
  return `${pair[0]}::${pair[1]}`;
}

function blockingKeys(p: Person): { rule: BlockingRule; key: string }[] {
  const keys: { rule: BlockingRule; key: string }[] = [];

  const email = normalizeEmail(p.email);
  if (email) keys.push({ rule: 'email', key: `email:${email}` });

  const phone = normalizePhone(p.phone);
  if (phone) keys.push({ rule: 'phone', key: `phone:${phone}` });

  const plate = normalizeLicensePlate(p.license_plate);
  if (plate) keys.push({ rule: 'plate', key: `plate:${plate}` });

  const lastName = normalizeName(p.last_name);
  const postal = normalizePostalCode(p.postal_code);
  if (lastName && postal) keys.push({ rule: 'name_zip', key: `namezip:${lastName}|${postal}` });

  const fullName = normalizeFullName(p.first_name, p.last_name);
  const dob = normalizeDob(p.date_of_birth);
  if (fullName && dob) keys.push({ rule: 'name_dob', key: `namedob:${fullName}|${dob}` });

  if (fullName) keys.push({ rule: 'full_name', key: `fullname:${fullName}` });

  return keys;
}

/**
 * Generates deduped, canonically-ordered candidate pairs from a set of
 * people via blocking-key union, along with which rule(s) matched each pair.
 * Callers are responsible for filtering out pairs that are already known
 * (merged/dismissed/open) — this function is a pure function over the
 * people it's given.
 * When focusId is provided, emit only pairs involving that person. This
 * keeps candidate generation linear even when an existing block is large.
 */
export function generateCandidatePairs(people: Person[], focusId?: string): CandidatePair[] {
  const blocks = new Map<string, { rule: BlockingRule; ids: Set<string> }>();

  for (const p of people) {
    for (const { rule, key } of blockingKeys(p)) {
      let bucket = blocks.get(key);
      if (!bucket) {
        bucket = { rule, ids: new Set() };
        blocks.set(key, bucket);
      }
      bucket.ids.add(p.id);
    }
  }

  const pairs = new Map<string, { pair: PersonPair; rules: Set<BlockingRule> }>();
  function addPair(aId: string, bId: string, rule: BlockingRule) {
    const pair = canonicalPair(aId, bId);
    const key = pairKey(pair);
    let entry = pairs.get(key);
    if (!entry) {
      entry = { pair, rules: new Set() };
      pairs.set(key, entry);
    }
    entry.rules.add(rule);
  }

  for (const { rule, ids } of blocks.values()) {
    if (ids.size < 2) continue;
    if (focusId !== undefined) {
      if (!ids.has(focusId)) continue;
      for (const id of ids) {
        if (id !== focusId) addPair(id, focusId, rule);
      }
      continue;
    }

    const arr = [...ids];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        addPair(arr[i], arr[j], rule);
      }
    }
  }

  return [...pairs.values()].map(({ pair, rules }) => ({ pair, rules: [...rules] }));
}
