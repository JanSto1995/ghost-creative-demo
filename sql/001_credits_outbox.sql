-- Standalone demo schema. No connection to production names or data.
-- Apply once in a fresh PostgreSQL database. Call each function in a transaction.
-- The demo models one shared wallet. Real services need tenant-scoped authorization.
create sequence demo_fence as bigint;
create table demo_wallet (
  id text primary key check (id = 'sample'),
  balance bigint not null check (balance >= 0)
);
insert into demo_wallet values ('sample', 12);
create table demo_lease (
  resource text primary key,
  owner text not null,
  token bigint not null,
  expires_at timestamptz not null
);
create table demo_receipt (
  scope text not null,
  request_key uuid not null,
  fingerprint text not null,
  primary key (scope, request_key)
);
create table demo_outbox (
  id bigint primary key default nextval('demo_fence'),
  amount bigint not null check (amount > 0),
  balance bigint not null check (balance >= 0),
  delivered boolean not null default false,
  owner text,
  token bigint,
  expires_at timestamptz
);
create index demo_outbox_pending on demo_outbox (id) where not delivered;

create function demo_claim(p_resource text, p_owner text, p_ttl_ms integer)
returns setof demo_lease language plpgsql as $$
begin
  if p_resource is null or p_resource = '' or p_owner is null or p_owner = '' or p_ttl_ms is null or p_ttl_ms <= 0 then
    raise exception 'invalid lease';
  end if;
  return query
    insert into demo_lease as current (resource, owner, token, expires_at)
    values (p_resource, p_owner, nextval('demo_fence'), clock_timestamp() + p_ttl_ms * interval '1 millisecond')
    on conflict (resource) do update
      -- Evaluate after locking the conflict row, not before a possible lock wait.
      set owner = excluded.owner, token = nextval('demo_fence'),
          expires_at = clock_timestamp() + p_ttl_ms * interval '1 millisecond'
      where current.expires_at <= clock_timestamp()
    returning *;
  -- Conflicts still consume the insert candidate's sequence value; gaps are harmless because fences compare order, but regressions could let an old worker appear current.
end;
$$;

create function demo_heartbeat(p_resource text, p_owner text, p_token bigint, p_ttl_ms integer)
returns void language plpgsql as $$
begin
  if p_ttl_ms is null or p_ttl_ms <= 0 then raise exception 'invalid lease'; end if;
  update demo_lease set expires_at = clock_timestamp() + p_ttl_ms * interval '1 millisecond'
    where resource = p_resource and owner = p_owner and token = p_token and expires_at > clock_timestamp();
  if not found then raise exception 'stale'; end if;
end;
$$;

create function demo_book(p_key uuid, p_amount bigint, p_owner text, p_token bigint)
returns boolean language plpgsql as $$
declare
  v_receipt text;
  v_balance bigint;
begin
  if p_key is null or p_amount is null or p_amount <= 0 then raise exception 'invalid booking'; end if;
  -- Lock the current fence before mutating protected state. A successor cannot
  -- acquire the lease between this check and commit.
  perform 1 from demo_lease where resource = 'credits' and owner = p_owner
    and token = p_token and expires_at > clock_timestamp() for update;
  if not found then raise exception 'stale'; end if;
  select balance into strict v_balance from demo_wallet where id = 'sample' for update;
  select fingerprint into v_receipt from demo_receipt where scope = 'credit' and request_key = p_key;
  if found then
    if v_receipt <> p_amount::text then raise exception 'conflict'; end if;
    return false;
  end if;
  if v_balance < p_amount then raise exception 'insufficient'; end if;
  v_balance := v_balance - p_amount;
  update demo_wallet set balance = v_balance where id = 'sample';
  insert into demo_outbox (amount, balance) values (p_amount, v_balance);
  insert into demo_receipt values ('credit', p_key, p_amount::text);
  return true;
end;
$$;

create function demo_claim_event(p_owner text, p_ttl_ms integer)
returns setof demo_outbox language plpgsql as $$
declare v_id bigint;
begin
  if p_owner is null or p_owner = '' or p_ttl_ms is null or p_ttl_ms <= 0 then raise exception 'invalid lease'; end if;
  select id into v_id from demo_outbox
    where not delivered and (expires_at is null or expires_at <= clock_timestamp())
    order by id for update skip locked limit 1;
  if not found then return; end if;
  return query update demo_outbox
    set owner = p_owner, token = nextval('demo_fence'),
        expires_at = clock_timestamp() + p_ttl_ms * interval '1 millisecond'
    where id = v_id returning *;
end;
$$;

create function demo_heartbeat_event(p_id bigint, p_owner text, p_token bigint, p_ttl_ms integer)
returns void language plpgsql as $$
begin
  if p_ttl_ms is null or p_ttl_ms <= 0 then raise exception 'invalid lease'; end if;
  update demo_outbox set expires_at = clock_timestamp() + p_ttl_ms * interval '1 millisecond'
    where id = p_id and not delivered and owner = p_owner and token = p_token and expires_at > clock_timestamp();
  if not found then raise exception 'stale'; end if;
end;
$$;

create function demo_acknowledge(p_id bigint, p_owner text, p_token bigint)
returns void language plpgsql as $$
begin
  update demo_outbox set delivered = true, owner = null, expires_at = null
    where id = p_id and not delivered and owner = p_owner and token = p_token and expires_at > clock_timestamp();
  if not found then raise exception 'stale'; end if;
end;
$$;

-- Delivery protocol: claim in a short transaction; send outside the transaction;
-- acknowledge in a new transaction using the exact owner and fencing token.
-- Consumers must deduplicate by event id. A crash after send but before ack can
-- cause redelivery. Sequence gaps are intentional; tokens only promise monotonicity.
-- These are SECURITY INVOKER functions. Runtime database permissions, tenant
-- isolation, connection pooling and durable job scheduling are deployment concerns.
