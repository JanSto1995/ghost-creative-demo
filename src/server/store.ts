import 'server-only';
import {
  decisionSchema,
  fixtures,
  keySchema,
  type Decision,
  type QueueItem,
  type Snapshot,
} from '@/lib/contracts';

export class DomainError extends Error {
  constructor(public readonly code: 'conflict' | 'insufficient' | 'not_found' | 'stale') {
    super(code);
  }
}
export type Lease = { resource: string; owner: string; token: number; until: number };
export type OutboxEvent = { id: number; amount: number; balance: number; delivered: boolean };
type Receipt = { fingerprint: string };
type State = {
  balance: number;
  revision: number;
  sequence: number;
  items: QueueItem[];
  receipts: Map<string, Receipt>;
  events: OutboxEvent[];
  leases: Map<string, Lease>;
  completed: Map<string, number>;
};

/** Single-process transaction model: clone, validate, then swap; no await inside a transaction. */
export class MemoryStore {
  private state: State;
  private readonly initial: { balance: number; items: QueueItem[] };
  constructor(
    balance = 12,
    items: QueueItem[] = fixtures,
    private readonly now = Date.now,
  ) {
    if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('Invalid balance');
    this.initial = { balance, items: structuredClone(items) };
    this.state = {
      balance,
      revision: 0,
      sequence: 0,
      items: structuredClone(items),
      receipts: new Map(),
      events: [],
      leases: new Map(),
      completed: new Map(),
    };
  }
  private transaction<T>(run: (draft: State) => T): T {
    const draft = structuredClone(this.state);
    const result = run(draft);
    this.state = draft;
    return structuredClone(result);
  }
  snapshot(): Snapshot {
    return structuredClone({
      items: this.state.items,
      balance: this.state.balance,
      revision: this.state.revision,
    });
  }
  reset(): Snapshot {
    this.transaction((draft) => {
      draft.balance = this.initial.balance;
      draft.items = structuredClone(this.initial.items);
      draft.receipts.clear();
      draft.events = [];
      draft.leases.clear();
      draft.completed.clear();
      // Keep revisions and fence sequence increasing across resets.
      draft.revision++;
    });
    return this.snapshot();
  }
  outbox(): OutboxEvent[] {
    return structuredClone(this.state.events);
  }
  private debit(draft: State, amount: number) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid amount');
    if (draft.balance < amount) throw new DomainError('insufficient');
    draft.balance -= amount;
    draft.events.push({ id: ++draft.sequence, amount, balance: draft.balance, delivered: false });
  }
  decide(raw: Decision, rawKey: string): { snapshot: Snapshot; replayed: boolean } {
    const decision = decisionSchema.parse(raw);
    const key = keySchema.parse(rawKey);
    return this.transaction((draft) => {
      const fingerprint = `${decision.id}:${decision.action}`;
      const receipt = draft.receipts.get(`decision:${key}`);
      if (receipt && receipt.fingerprint !== fingerprint) throw new DomainError('conflict');
      if (receipt)
        return {
          snapshot: { items: draft.items, balance: draft.balance, revision: draft.revision },
          replayed: true,
        };
      const item = draft.items.find((entry) => entry.id === decision.id);
      if (!item) throw new DomainError('not_found');
      if (item.status !== 'pending') throw new DomainError('conflict');
      if (decision.action === 'approve') this.debit(draft, 1);
      item.status = decision.action === 'approve' ? 'approved' : 'rejected';
      draft.receipts.set(`decision:${key}`, { fingerprint });
      draft.revision++;
      return {
        snapshot: { items: draft.items, balance: draft.balance, revision: draft.revision },
        replayed: false,
      };
    });
  }
  /** Fenced worker debit; callers must hold a current credits lease, even on a retry. */
  book(key: string, amount: number, lease: Lease): boolean {
    const normalizedKey = keySchema.parse(key);
    return this.transaction((draft) => {
      this.assertLease(draft, lease, 'credits');
      const fingerprint = String(amount);
      const prior = draft.receipts.get(`credit:${normalizedKey}`);
      if (prior && prior.fingerprint !== fingerprint) throw new DomainError('conflict');
      if (prior) return false;
      this.debit(draft, amount);
      draft.receipts.set(`credit:${normalizedKey}`, { fingerprint });
      draft.revision++;
      return true;
    });
  }
  claim(resource: string, owner: string, ttlMs: number): Lease | undefined {
    if (!resource || !owner || !Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      throw new Error('Invalid lease');
    return this.transaction((draft) => this.acquire(draft, resource, owner, ttlMs));
  }
  private acquire(draft: State, resource: string, owner: string, ttlMs: number): Lease | undefined {
    if ((draft.leases.get(resource)?.until ?? 0) > this.now()) return undefined;
    const lease = { resource, owner, token: ++draft.sequence, until: this.now() + ttlMs };
    draft.leases.set(resource, lease);
    return lease;
  }
  private assertLease(draft: State, lease: Lease, resource = lease.resource): Lease {
    const current = draft.leases.get(resource);
    if (
      lease.resource !== resource ||
      !current ||
      current.owner !== lease.owner ||
      current.token !== lease.token ||
      current.until <= this.now()
    )
      throw new DomainError('stale');
    return current;
  }
  heartbeat(lease: Lease, ttlMs: number): Lease {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Invalid lease');
    return this.transaction((draft) => {
      const current = this.assertLease(draft, lease);
      current.until = this.now() + ttlMs;
      return current;
    });
  }
  release(lease: Lease): void {
    this.transaction((draft) => {
      this.assertLease(draft, lease);
      draft.leases.delete(lease.resource);
    });
  }
  claimEvent(owner: string, ttlMs: number): { event: OutboxEvent; lease: Lease } | undefined {
    if (!owner || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Invalid lease');
    return this.transaction((draft) => {
      for (const event of draft.events) {
        if (event.delivered) continue;
        const lease = this.acquire(draft, `event:${event.id}`, owner, ttlMs);
        if (lease) return { event, lease };
      }
      return undefined;
    });
  }
  acknowledge(eventId: number, lease: Lease): void {
    this.transaction((draft) => {
      this.assertLease(draft, lease, `event:${eventId}`);
      const event = draft.events.find((entry) => entry.id === eventId);
      if (!event || event.delivered) throw new DomainError('conflict');
      event.delivered = true;
      draft.leases.delete(lease.resource);
    });
  }
  claimJob(name: string, owner: string, interval: number, ttl: number): Lease | undefined {
    return this.transaction((draft) => {
      const last = draft.completed.get(name);
      if (last !== undefined && this.now() - last < interval) return undefined;
      return this.acquire(draft, `job:${name}`, owner, ttl);
    });
  }
  completeJob(name: string, lease: Lease): void {
    this.transaction((draft) => {
      this.assertLease(draft, lease, `job:${name}`);
      draft.completed.set(name, this.now());
      draft.leases.delete(lease.resource);
    });
  }
}
