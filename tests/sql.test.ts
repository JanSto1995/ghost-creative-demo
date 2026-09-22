import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '@/server/store';

let db: PGlite;
const key = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const secondKey = '00000000-0000-4000-8000-000000000032';
beforeEach(async () => {
  db = new PGlite();
  await db.exec(await readFile(new URL('../sql/001_credits_outbox.sql', import.meta.url), 'utf8'));
});
afterEach(async () => {
  await db.close();
});

describe('PostgreSQL reference contract (PGlite, no external database)', () => {
  it('matches in-memory atomicity, retry and fencing semantics', async () => {
    let now = 1000;
    const memory = new MemoryStore(12, [], () => now);
    const memLease = memory.claim('credits', 'a', 1000)!;
    const sqlLease = (
      await db.query<{ token: number }>("select token from demo_claim('credits', 'a', 60000)")
    ).rows[0]!;
    const book = (requestKey: string, amount: number, owner = 'a', token = sqlLease.token) =>
      db.query<{ demo_book: boolean }>('select demo_book($1, $2, $3, $4)', [
        requestKey,
        amount,
        owner,
        token,
      ]);
    expect((await book(key, 2)).rows[0]?.demo_book).toBe(memory.book(key, 2, memLease));
    expect((await book(key.toUpperCase(), 2)).rows[0]?.demo_book).toBe(
      memory.book(key.toUpperCase(), 2, memLease),
    );
    await expect(book(key, 3)).rejects.toThrow('conflict');
    expect(() => memory.book(key, 3, memLease)).toThrow('conflict');
    await expect(book(secondKey, 99)).rejects.toThrow('insufficient');
    expect(() => memory.book(secondKey, 99, memLease)).toThrow('insufficient');
    const events = await db.query<{ amount: number; balance: number }>(
      'select amount, balance from demo_outbox order by id',
    );
    expect(events.rows).toEqual(
      memory.outbox().map(({ amount, balance }) => ({ amount, balance })),
    );
    expect(
      (await db.query<{ balance: number }>('select balance from demo_wallet')).rows[0]?.balance,
    ).toBe(memory.snapshot().balance);
    expect((await db.query("select * from demo_claim('credits', 'b', 60000)")).rows).toHaveLength(
      0,
    );
    await db.exec("update demo_lease set expires_at = clock_timestamp() - interval '1 second'");
    now += 1000;
    const memNew = memory.claim('credits', 'b', 1000)!;
    const sqlNew = (
      await db.query<{ token: number }>("select token from demo_claim('credits', 'b', 60000)")
    ).rows[0]!;
    expect(sqlNew.token).toBeGreaterThan(sqlLease.token);
    expect(memNew.token).toBeGreaterThan(memLease.token);
    await expect(book(secondKey, 1)).rejects.toThrow('stale');
    expect(() => memory.book(secondKey, 1, memLease)).toThrow('stale');
    expect((await book(secondKey, 1, 'b', sqlNew.token)).rows[0]?.demo_book).toBe(
      memory.book(secondKey, 1, memNew),
    );
    expect(
      (await db.query<{ balance: number }>('select balance from demo_wallet')).rows[0]?.balance,
    ).toBe(memory.snapshot().balance);
  });
  it('rolls back a debit and receipt when outbox insertion fails', async () => {
    await db.exec(
      "create function demo_fail_insert() returns trigger language plpgsql as $$ begin raise exception 'injected outbox failure'; end $$; create trigger demo_failure before insert on demo_outbox for each row execute function demo_fail_insert();",
    );
    const before = (await db.query<{ balance: number }>('select balance from demo_wallet')).rows[0]
      ?.balance;
    const lease = (
      await db.query<{ token: number }>("select token from demo_claim('credits', 'b', 60000)")
    ).rows[0]!;
    await expect(
      db.query('select demo_book($1, 1, $2, $3)', [
        '00000000-0000-4000-8000-000000000033',
        'b',
        lease.token,
      ]),
    ).rejects.toThrow('injected outbox failure');
    expect(
      (await db.query<{ balance: number }>('select balance from demo_wallet')).rows[0]?.balance,
    ).toBe(before);
    expect(
      (
        await db.query(
          "select * from demo_receipt where request_key = '00000000-0000-4000-8000-000000000033'",
        )
      ).rows,
    ).toHaveLength(0);
    await db.exec('drop trigger demo_failure on demo_outbox; drop function demo_fail_insert();');
  });
  it('redelivers an expired outbox event with a newer fence', async () => {
    const lease = (
      await db.query<{ token: number }>("select token from demo_claim('credits', 'a', 60000)")
    ).rows[0]!;
    await db.query('select demo_book($1, 2, $2, $3)', [key, 'a', lease.token]);
    const first = (
      await db.query<{ id: number; token: number }>(
        "select id, token from demo_claim_event('a', 60000)",
      )
    ).rows[0]!;
    await db.query(
      "update demo_outbox set expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [first.id],
    );
    const next = (
      await db.query<{ id: number; token: number }>(
        "select id, token from demo_claim_event('b', 60000)",
      )
    ).rows[0]!;
    expect(next.id).toBe(first.id);
    expect(next.token).toBeGreaterThan(first.token);
    await expect(
      db.query('select demo_acknowledge($1, $2, $3)', [first.id, 'a', first.token]),
    ).rejects.toThrow('stale');
    await db.query('select demo_acknowledge($1, $2, $3)', [next.id, 'b', next.token]);
    expect(
      (
        await db.query<{ delivered: boolean }>('select delivered from demo_outbox where id = $1', [
          next.id,
        ])
      ).rows[0]?.delivered,
    ).toBe(true);
  });
  it('assigns each later successful claim a higher fence, including values consumed by conflicts', async () => {
    const tokens: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = (await db.query<{ last_value: number }>('select last_value from demo_fence'))
        .rows[0]!.last_value;
      const lease = (
        await db.query<{ token: number }>("select token from demo_claim('credits', $1, 60000)", [
          String(i),
        ])
      ).rows[0]!;
      expect(tokens.every((token) => lease.token > token)).toBe(true);
      if (i > 0) expect(lease.token).toBe(before + 2); // discarded insert candidate + fresh update
      tokens.push(lease.token);
      expect(
        (await db.query("select * from demo_claim('credits', 'blocked', 60000)")).rows,
      ).toHaveLength(0);
      await db.exec("update demo_lease set expires_at = clock_timestamp() - interval '1 second'");
    }
  });
  it('refreshes the fence and TTL after an insert candidate is delayed and overtaken', async () => {
    await db.query("select * from demo_claim('credits', 'first', 60000)");
    await db.exec("update demo_lease set expires_at = clock_timestamp() - interval '1 second'");
    // A trigger deterministically interleaves a successful claim for another resource.
    // This is one connection; it does not reproduce a real row-lock wait.
    await db.exec(`
      create table observed_claim (token bigint, ready_at timestamptz);
      create function delay_candidate() returns trigger language plpgsql as $$
      declare overtaking_token bigint;
      begin
        if new.resource <> 'credits' then return new; end if;
        perform pg_sleep(0.04);
        select token into overtaking_token from demo_claim('other', 'overtaking', 60000);
        insert into observed_claim values (overtaking_token, clock_timestamp());
        return new;
      end $$;
      create trigger delay_candidate before insert on demo_lease for each row execute function delay_candidate();
    `);
    const later = (
      await db.query<{ token: number; expires_at: Date }>(
        "select token, expires_at from demo_claim('credits', 'later', 20)",
      )
    ).rows[0]!;
    const earlier = (
      await db.query<{ token: number; ready_at: Date }>('select * from observed_claim')
    ).rows[0]!;
    expect(later.token).toBeGreaterThan(earlier.token);
    expect(
      new Date(later.expires_at).getTime() - new Date(earlier.ready_at).getTime(),
    ).toBeGreaterThanOrEqual(19);
  });
});
