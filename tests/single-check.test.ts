import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '@/lib/dedupe/db';
import * as candidates from '@/lib/dedupe/candidates';
import { checkSingleRecord, describeSignals, type PersonDraft } from '@/lib/dedupe/pipeline';
import { scorePair } from '@/lib/dedupe/score';
import { PEOPLE, BOOKINGS } from '@/lib/dedupe/seedData';
import type { Booking, Person } from '@/lib/dedupe/types';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  const insert = db.prepare(`INSERT INTO people
    (id, first_name, last_name, email, phone, date_of_birth, address_line, city,
     region, postal_code, license_plate, notes)
    VALUES (@id, @first_name, @last_name, @email, @phone, @date_of_birth,
            @address_line, @city, @region, @postal_code, @license_plate, @notes)`);
  for (const p of PEOPLE) insert.run(p);
  const booking = db.prepare(`INSERT INTO bookings
    (id, person_id, site, start_date, end_date, total_cents, status)
    VALUES (@id, @person_id, @site, @start_date, @end_date, @total_cents, @status)`);
  for (const b of BOOKINGS) booking.run(b);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The previous batch-then-filter path, retained here as an equivalence oracle. */
function batchCheck(draft: PersonDraft) {
  const people = db.prepare("SELECT * FROM people WHERE status = 'active'").all() as Person[];
  const draftPerson: Person = {
    ...draft,
    id: '__draft__',
    date_of_birth: draft.date_of_birth ?? null,
    notes: null,
    status: 'active',
    merged_into: null,
    created_at: '',
    updated_at: '',
  };
  const byId = new Map(people.map((p) => [p.id, p]));
  return candidates.generateCandidatePairs([...people, draftPerson])
    .filter((c) => c.pair.includes(draftPerson.id))
    .map(({ pair }) => {
      const id = pair[0] === draftPerson.id ? pair[1] : pair[0];
      const person = byId.get(id)!;
      const bookings = db.prepare('SELECT * FROM bookings WHERE person_id = ?').all(id) as Booking[];
      const result = scorePair(draftPerson, person, [], bookings);
      return {
        person,
        det_score: result.det_score,
        tier: result.tier,
        signals: result.signals,
        description: describeSignals(result.signals),
      };
    })
    .filter((m) => m.tier !== 'weak')
    .sort((a, b) => b.det_score - a.det_score);
}

describe('checkSingleRecord', () => {
  it('preserves complete scored matches and tie ordering for every seed record', () => {
    for (const draft of PEOPLE) {
      expect(checkSingleRecord(db, draft)).toEqual(batchCheck(draft));
    }
  });

  it('recomputes edited drafts and repeated checks without persisting data', () => {
    const before = db.serialize();
    const original = PEOPLE[0];
    const edits = [
      original,
      { ...original, first_name: 'Unrelated', last_name: 'Name', email: null, phone: null },
      { ...original, email: '  SARAH.JIMENEZ@example.com  ', phone: '+1 (555) 201-1000' },
      { ...original, date_of_birth: null, license_plate: null, postal_code: null },
      original,
    ];
    for (const draft of edits) expect(checkSingleRecord(db, draft)).toEqual(batchCheck(draft));
    expect(db.serialize()).toEqual(before);
  });

  it('excludes merged people and forwards the draft scope to candidate generation', () => {
    db.prepare("UPDATE people SET status = 'merged', merged_into = 'case1-a' WHERE id = 'case1-b'").run();
    const expected = batchCheck(PEOPLE[0]);
    const generate = vi.spyOn(candidates, 'generateCandidatePairs');
    const matches = checkSingleRecord(db, PEOPLE[0]);
    expect(matches).toEqual(expected);
    expect(matches.some((m) => m.person.id === 'case1-b')).toBe(false);
    expect(generate).toHaveBeenCalledExactlyOnceWith(expect.any(Array), '__draft__');
    expect(generate.mock.results[0].value.every((c: candidates.CandidatePair) => c.pair.includes('__draft__'))).toBe(true);
  });
});
