import { describe, it, expect, vi } from 'vitest';
import { generateCandidatePairs, canonicalPair, pairKey } from '@/lib/dedupe/candidates';
import { PEOPLE } from '@/lib/dedupe/seedData';
import type { Person } from '@/lib/dedupe/types';

const people = PEOPLE as unknown as Person[];

describe('generateCandidatePairs (blocking)', () => {
  const candidates = generateCandidatePairs(people);
  const keys = new Set(candidates.map((c) => pairKey(c.pair)));
  const byKey = new Map(candidates.map((c) => [pairKey(c.pair), c]));

  const expectedPairs: [string, string][] = [
    ['case1-a', 'case1-b'],
    ['case2-a', 'case2-b'],
    ['case3-a', 'case3-b'],
    ['case4-a', 'case4-b'],
    ['case5-a', 'case5-b'],
    ['case6-a', 'case6-b'],
    ['case7-a', 'case7-b'],
    ['case8-a', 'case8-b'],
    ['case8-b', 'case8-c'],
  ];

  it('generates exactly the 9 expected candidate pairs from the seed dataset', () => {
    expect(keys.size).toBe(expectedPairs.length);
    for (const [a, b] of expectedPairs) {
      expect(keys.has(pairKey(canonicalPair(a, b)))).toBe(true);
    }
  });

  it('does NOT pair case8-a with case8-c directly (three-way cluster has exactly two edges)', () => {
    expect(keys.has(pairKey(canonicalPair('case8-a', 'case8-c')))).toBe(false);
  });

  it('never pairs filler records with anything', () => {
    for (const c of candidates) {
      expect(c.pair[0].startsWith('filler-')).toBe(false);
      expect(c.pair[1].startsWith('filler-')).toBe(false);
    }
  });

  it('canonically orders pairs regardless of input order', () => {
    const reversed = generateCandidatePairs([...people].reverse());
    const reversedKeys = new Set(reversed.map((c) => pairKey(c.pair)));
    expect(reversedKeys).toEqual(keys);
  });

  it('records which blocking rules fired per pair', () => {
    // spouse pair surfaces via the shared household email
    expect(byKey.get(pairKey(canonicalPair('case4-a', 'case4-b')))!.rules).toContain('email');
    // same name + same DOB fires the name_dob key (alias emails do NOT match on the email key)
    const case7 = byKey.get(pairKey(canonicalPair('case7-a', 'case7-b')))!;
    expect(case7.rules).toContain('name_dob');
    expect(case7.rules).toContain('full_name');
    expect(case7.rules).not.toContain('email');
    // nickname pair blocks on phone digits, not name
    expect(byKey.get(pairKey(canonicalPair('case3-a', 'case3-b')))!.rules).toContain('phone');
  });
});

describe('generateCandidatePairs (single-person scope)', () => {
  for (const focus of people) {
    it(`preserves the batch pairs and rule order for ${focus.id}`, () => {
      const expected = generateCandidatePairs(people).filter((c) => c.pair.includes(focus.id));
      expect(generateCandidatePairs(people, focus.id)).toEqual(expected);
    });
  }

  it('returns no pairs for a missing person or an empty population', () => {
    expect(generateCandidatePairs(people, 'missing')).toEqual([]);
    expect(generateCandidatePairs([], 'missing')).toEqual([]);
  });

  it('does not construct pairs between existing members of a common block', () => {
    const existing = Array.from({ length: 200 }, (_, i) => ({ ...people[0], id: `existing-${i}` }));
    const draft = { ...people[0], id: '__draft__' };
    const candidates = generateCandidatePairs([...existing, draft], draft.id);
    expect(candidates).toHaveLength(existing.length);
    expect(new Set(candidates.map((c) => pairKey(c.pair))).size).toBe(existing.length);
    for (const c of candidates) {
      expect(c.pair).toContain(draft.id);
      expect(c.rules).toEqual(generateCandidatePairs([existing[0], draft])[0].rules);
    }
  });

  it('skips large unrelated blocks when the draft shares no key', () => {
    const existing = Array.from({ length: 200 }, (_, i) => ({ ...people[0], id: `existing-${i}` }));
    const draft = people.find((p) => p.id.startsWith('filler-'))!;
    expect(generateCandidatePairs([...existing, draft], draft.id)).toEqual([]);
  });

  it('treats an empty ID as a scope and never pairs a repeated ID with itself', () => {
    const focus = { ...people[0], id: '' };
    const other = { ...people[0], id: 'other' };
    expect(generateCandidatePairs([focus, focus, other], focus.id)).toEqual(
      generateCandidatePairs([focus, other]),
    );
  });

  it('preserves rule unions when repeated IDs carry different blocking keys', () => {
    const rows = [
      { ...people[0], id: 'focus' },
      { ...people[1], id: 'other' },
      { ...people[2], id: 'focus' },
      { ...people[3], id: 'other' },
      { ...people[0], id: 'third' },
    ];
    expect(generateCandidatePairs(rows, 'focus')).toEqual(
      generateCandidatePairs(rows).filter((c) => c.pair.includes('focus')),
    );
  });

  it('bounds pair-storage work linearly rather than generating and filtering all pairs', () => {
    const existing = Array.from({ length: 200 }, (_, i) => ({ ...people[0], id: `existing-${i}` }));
    const draft = { ...people[0], id: '__draft__' };
    // Count synchronous Map writes instead of setting a machine-dependent
    // timing threshold. An all-pairs-then-filter implementation exceeds 20k.
    const writes = vi.spyOn(Map.prototype, 'set');
    let count: number;
    try {
      generateCandidatePairs([...existing, draft], draft.id);
      count = writes.mock.calls.length;
    } finally {
      writes.mockRestore();
    }
    expect(count).toBeLessThan(existing.length * 10);
  });
});
