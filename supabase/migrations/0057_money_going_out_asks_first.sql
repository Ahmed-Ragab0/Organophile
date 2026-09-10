-- Money going out asks first, unless you are the one who says yes.
--
-- Until now anybody holding `money.write` could spend, and anybody holding
-- `payroll.write` could pay a salary, and the owner found out afterwards by
-- reading the ledger. That was right while the owner was the only person in
-- the system. With an accountant and a salesperson in it, "who agreed to this"
-- has to be answerable BEFORE the money leaves, not after.
--
-- The shape follows the one this system already uses for the same class of
-- question. It is not a switch on a screen and it is not a rule the front end
-- remembers to apply:
--
--   * The DATABASE decides. `add_expense` and `pay_payslip` look at who is
--     calling. If they may authorise spending, the money moves exactly as it
--     did before. If not, the same call becomes a REQUEST and nothing moves.
--     A client cannot opt out of that, because a client never wrote to
--     `ledger_entries` in the first place (rule 8).
--   * Approving PERFORMS the spend, in the same transaction as the decision.
--     There is no window in which a request says approved and no money moved,
--     and no second button somebody has to remember to press.
--   * A request is a document. Its amount, wallet and description cannot be
--     edited after it is raised, because the thing the approver agreed to has
--     to be the thing that happens. Wrong request: cancel it and raise another.
--
-- What is deliberately NOT in this: transfers between the business's own
-- wallets. `transfer_between_wallets` is P&L neutral and both ends are inside
-- this system — moving cash from the safe to the bank is not a disbursement,
-- and putting it behind an approval would train everybody to click through
-- approvals for things that are not spending. Say so out loud rather than
-- leaving it as an oversight.

-- ---------------------------------------------------------------------------
-- Who may say yes
-- ---------------------------------------------------------------------------
-- A domain of its own rather than a third action on `money`, because the
-- two-action rule from 0046 is what keeps the permission catalogue readable.
-- `approvals.write` means BOTH "may decide other people's requests" and "does
-- not have to raise one" — they are the same authority and splitting them
-- would let somebody approve spending they are not trusted to do themselves.
insert into public.permissions (code, domain, action, name, name_en, sort_order) values
  ('approvals.read',  'approvals', 'read',  'يشوف أذون الصرف',      'View spend requests', 52),
  ('approvals.write', 'approvals', 'write', 'يوافق على الصرف',      'Authorise spending',  53)
on conflict (code) do update
  set domain = excluded.domain, action = excluded.action,
      name = excluded.name, name_en = excluded.name_en,
      sort_order = excluded.sort_order;

-- The accountant raises requests and watches their own; they do not decide.
-- That is the entire point of the feature, so it is seeded that way.
insert into public.role_permissions (role_id, permission_code)
select r.id, 'approvals.read' from public.roles r where r.code = 'accountant'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Naming a person without reading their pay
-- ---------------------------------------------------------------------------
-- The requests screen has to say who asked and who decided. `staff` is gated
-- on `staff.read`, which somebody raising an expense has no reason to hold.
-- A name is not a secret; a wage is, and this returns no wage.
create or replace function app.staff_label(p_user_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when app.is_staff()
              then coalesce(nullif(btrim(coalesce(s.full_name, '')), ''), s.email)
         end
    from public.staff s where s.user_id = p_user_id
$$;

grant execute on function app.staff_label(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The request
-- ---------------------------------------------------------------------------
create table if not exists public.spend_requests (
  id uuid primary key default gen_random_uuid(),

  -- The code branches on every one of these, so they are a check and not a
  -- table somebody can add a fifth row to.
  kind   text not null check (kind in ('expense', 'payslip')),
  status text not null default 'pending'
         check (status in ('pending', 'approved', 'rejected', 'cancelled')),

  /**
   * What was asked for.
   *
   * Frozen once raised — see `app.guard_spend_request`. The approver has to be
   * agreeing to the thing that then happens, and a request whose amount can
   * move between the asking and the answering agrees to nothing.
   */
  amount      numeric(14,2) not null check (amount > 0),
  wallet_id   uuid not null references public.wallets(id) on delete restrict,
  occurred_at timestamptz not null default now(),
  description text not null check (btrim(description) <> ''),
  note        text,

  -- Set for `expense`; null for `payslip`.
  category_id uuid references public.expense_categories(id) on delete set null,
  -- Set for `payslip`; null for `expense`. RESTRICT because a payslip with a
  -- decided request against it is part of the financial record.
  payslip_id  uuid references public.payslips(id) on delete restrict,

  requested_by  uuid references auth.users(id) on delete set null,
  decided_by    uuid references auth.users(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,

  -- What approving it produced. The link that makes "approved" checkable
  -- against the books rather than merely stated.
  result_entry_id uuid unique references public.ledger_entries(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint spend_requests_kind_shape check (
    (kind = 'expense' and payslip_id is null)
    or (kind = 'payslip' and payslip_id is not null)),
  -- Decided means decided BY somebody, AT a time. Neither half without the other.
  constraint spend_requests_decision_shape check (
    (status in ('pending', 'cancelled')) = (decided_at is null)),
  -- Only an approval produces money.
  constraint spend_requests_result_shape check (
    result_entry_id is null or status = 'approved')
);

comment on table public.spend_requests is
  'Money somebody wants to send, waiting for somebody who may authorise it. '
  'Approving performs the spend in the same transaction as the decision.';

create index if not exists spend_requests_pending_idx
  on public.spend_requests (created_at desc) where status = 'pending';
create index if not exists spend_requests_mine_idx
  on public.spend_requests (requested_by, created_at desc);
create index if not exists spend_requests_payslip_idx
  on public.spend_requests (payslip_id) where payslip_id is not null;

-- At most one live request per payslip. Two people asking to pay one salary is
-- how it gets paid twice.
create unique index if not exists spend_requests_one_live_per_payslip
  on public.spend_requests (payslip_id) where status = 'pending' and payslip_id is not null;

drop trigger if exists spend_requests_touch_updated_at on public.spend_requests;
create trigger spend_requests_touch_updated_at
  before update on public.spend_requests
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The rails
-- ---------------------------------------------------------------------------
create or replace function app.spend_is_deciding()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('app.spend_deciding', true), '') = 'on'
$$;

/**
 * A request is written once and decided once, and neither by hand.
 *
 * The transaction-local flag is the same device `pay_payslip` uses: without
 * it, anybody who can see the table could mark their own request approved with
 * a plain UPDATE and no money would move — which is the failure this whole
 * feature exists to prevent, arriving through the back door.
 */
create or replace function app.guard_spend_request()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'cancelled' then
      raise exception 'a spend request is cancelled, not deleted'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if not app.spend_is_deciding() then
      raise exception 'a spend request is raised by add_expense or pay_payslip'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if not app.spend_is_deciding() then
    raise exception 'a spend request is decided through decide_spend_request'
      using errcode = 'restrict_violation';
  end if;

  -- What was asked for never changes, whoever is writing.
  if new.amount      is distinct from old.amount
     or new.wallet_id   is distinct from old.wallet_id
     or new.kind        is distinct from old.kind
     or new.payslip_id  is distinct from old.payslip_id
     or new.description is distinct from old.description
     or new.occurred_at is distinct from old.occurred_at then
    raise exception 'what a request asks for cannot change after it is raised'
      using errcode = 'restrict_violation';
  end if;

  if old.status <> 'pending' then
    raise exception 'this request has already been decided'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$function$;

drop trigger if exists spend_requests_guard on public.spend_requests;
create trigger spend_requests_guard
  before insert or update or delete on public.spend_requests
  for each row execute function app.guard_spend_request();

-- A payslip with somebody waiting on it must not move under them.
create or replace function app.payslip_has_live_request(p_payslip uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.spend_requests
                  where payslip_id = p_payslip and status = 'pending')
$$;

grant execute on function app.payslip_has_live_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
-- No client write policy at all, exactly like `ledger_entries`: every row here
-- is created and decided by a function. The absence of the policy is what
-- enforces that, rather than a rule written down somewhere.
alter table public.spend_requests enable row level security;
alter table public.spend_requests force  row level security;
revoke all on public.spend_requests from anon, authenticated;
grant select on public.spend_requests to authenticated;
grant all on public.spend_requests to service_role;
revoke truncate, references, trigger, maintain
  on public.spend_requests from anon, authenticated;

drop policy if exists spend_requests_read on public.spend_requests;
/*
 * Everybody's, or your own.
 *
 * Somebody who raises requests has to be able to watch what happened to
 * theirs — a request that vanishes the moment it is sent is worse than no
 * request at all. Everyone else's is for whoever decides them.
 */
create policy spend_requests_read on public.spend_requests
  for select to authenticated
  using (app.can('approvals.write')
         or app.can('approvals.read')
         or requested_by = auth.uid());

-- ---------------------------------------------------------------------------
-- The queue, as a screen reads it
-- ---------------------------------------------------------------------------
create or replace view public.v_spend_requests as
select r.id, r.kind, r.status, r.amount, r.occurred_at, r.description, r.note,
       r.wallet_id, w.name as wallet_name,
       r.category_id, ec.name as category_name,
       r.payslip_id,
       ps.employee_name, pp.period_month,
       r.requested_by, app.staff_label(r.requested_by) as requested_by_name,
       r.decided_by,   app.staff_label(r.decided_by)   as decided_by_name,
       r.decided_at, r.decision_note, r.result_entry_id,
       r.created_at, r.updated_at,
       -- Whether the reader is the one who asked. Decides which verbs a row
       -- offers, and nobody may decide their own.
       (r.requested_by = auth.uid()) as is_mine
  from public.spend_requests r
  join public.wallets w on w.id = r.wallet_id
  left join public.expense_categories ec on ec.id = r.category_id
  left join public.payslips ps on ps.id = r.payslip_id
  left join public.payroll_periods pp on pp.id = ps.period_id;

alter view public.v_spend_requests set (security_invoker = on);
revoke all on public.v_spend_requests from anon;
grant select on public.v_spend_requests to authenticated;

do $$ begin perform app.assert_guards_can_run(); end $$;
