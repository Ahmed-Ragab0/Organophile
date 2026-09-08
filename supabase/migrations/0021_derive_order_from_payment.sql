-- 0021_derive_order_from_payment.sql
--
-- A safety net for when ukkera's webhook does not arrive.
--
-- The first real payment proved ukkera never called this system at all: zero
-- rows in `ukkera_events_raw`, and no rejected attempt logged either. The
-- webhook simply is not registered on ukkera's side. That is a setting only
-- the account owner can change, and until it changes every payment would land
-- with no student and no order — money on the books belonging to nobody.
--
-- But the Kashier payload already carries everything needed: ukkera's
-- transfer_id, and the payer's name, email and phone. So a payment can
-- describe its own order.
--
-- The rule this must never break: ukkera is the system of record whenever it
-- speaks. This only ever creates what is missing, and stops the moment an
-- order exists.

alter table public.subscriptions drop constraint if exists subscriptions_source_check;
alter table public.subscriptions add constraint subscriptions_source_check
  check (source = any (array['ukkera_webhook', 'import', 'manual', 'kashier_metadata']));

create or replace function app.derive_order_from_payment(p_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  p         public.payments;
  v_student uuid;
  v_sub     uuid;
begin
  select * into p from public.payments where id = p_payment_id;
  if not found then return null; end if;

  -- Only a settled purchase describes an order. A refund or a failed attempt
  -- must never bring a student into existence.
  if p.status <> 'SUCCESS' then return null; end if;
  if p.event not in ('pay', 'capture') then return null; end if;
  if p.ukkera_transfer_id is null then return null; end if;

  -- If the order already exists — from ukkera, or from an earlier derivation —
  -- leave it entirely alone.
  select id into v_sub
    from public.subscriptions
   where order_key = p.ukkera_transfer_key;
  if found then return v_sub; end if;

  -- Same matching rule as the ukkera projection: normalised phone, the only
  -- identifier that survives +2010… / 010… / spacing.
  if p.payer_phone_normalized is not null then
    select id into v_student
      from public.students
     where phone_normalized = p.payer_phone_normalized
     order by created_at
     limit 1;
  end if;

  if v_student is null and btrim(coalesce(p.payer_name, '')) <> '' then
    insert into public.students (name, phone, email)
    values (btrim(p.payer_name), p.payer_phone, p.payer_email)
    returning id into v_student;
  end if;

  -- No course and no package: the gateway does not know what was bought, and
  -- guessing would be worse than leaving it blank for the pricing page to
  -- flag. `amount` is what was actually charged.
  insert into public.subscriptions (
    student_id, order_id, amount, payment_date, source
  ) values (
    v_student,
    p.ukkera_transfer_id,
    p.amount,
    (p.transaction_date at time zone 'Africa/Cairo')::date,
    'kashier_metadata'
  )
  on conflict (order_key) do update set
    student_id = coalesce(public.subscriptions.student_id, excluded.student_id),
    updated_at = now()
  returning id into v_sub;

  return v_sub;
end;
$$;

comment on function app.derive_order_from_payment(uuid) is
  'Builds the student and subscription from ukkera''s metaData when ukkera''s '
  'own webhook has not delivered the order. Never overwrites an existing '
  'order — ukkera stays the system of record whenever it speaks.';
