-- Kashier's cut is not an expense, and 200 EGP of student payments is not
-- 200 EGP of revenue.
--
-- Both statements are the same correction seen from two sides. What the
-- student paid and what reaches us are different numbers, and the gap is
-- withheld by the gateway before we ever touch it. Calling that gap an
-- "expense" put it beside rent and salaries — things the business decided to
-- spend — and calling the gross figure "revenue" overstated income by the
-- amount of a bill we never see.
--
-- After this migration:
--   student payments  what the student was charged   (ledger 'revenue')
--   - gateway fees    Kashier's cut + VAT + bank fee (ledger 'gateway_fee')
--   = net revenue     what actually arrives          <- the income figure
--   - expenses        what the business chose to spend
--   = net profit
--
-- The bottom line does not move: net profit was already gross minus fees minus
-- expenses. Only the classification changes, which is the point — and it means
-- any month closed under the old shape still reports the same profit.

-- ---------------------------------------------------------------------------
-- classifiers
-- ---------------------------------------------------------------------------

create or replace function app.pnl_fee(t public.ledger_entry_type, amt numeric)
returns numeric language sql immutable parallel safe set search_path = '' as $$
  select case t when 'gateway_fee' then amt else 0 end
$$;

comment on function app.pnl_fee is
  'What the payment gateway withheld. Deducted from student payments to reach '
  'net revenue — never added to expenses.';

comment on function app.pnl_revenue is
  'GROSS student payments: what the student was charged. This is not income — '
  'subtract app.pnl_fee to get net revenue.';

comment on function app.pnl_expense is
  'Money the business chose to spend. Gateway fees are deliberately excluded; '
  'they are a deduction from the payment (app.pnl_fee), not a purchase.';

-- The money does leave the Kashier wallet, whatever we call it. Without this
-- arm wallet_delta returns NULL for a fee row and every balance built on it
-- becomes NULL — a silent hole, not an error.
create or replace function app.wallet_delta(t public.ledger_entry_type, amt numeric)
returns numeric language sql immutable parallel safe set search_path = '' as $$
  select case t
    when 'revenue'        then  amt
    when 'transfer_in'    then  amt
    when 'adjustment_in'  then  amt
    when 'expense'        then -amt
    when 'gateway_fee'    then -amt
    when 'transfer_out'   then -amt
    when 'refund'         then -amt
    when 'reversal'       then -amt
    when 'adjustment_out' then -amt
  end
$$;

-- ---------------------------------------------------------------------------
-- reclassify what is already recorded
-- ---------------------------------------------------------------------------

update public.ledger_entries
   set entry_type = 'gateway_fee', updated_at = now()
 where entry_type = 'expense'
   and payment_id is not null
   and (metadata ->> 'source') = 'kashier_fees';

-- NOTE: app.sync_payment_to_ledger writes the fee entry and is redefined in
-- 0029, where it also switches to matching on merchant_order_key. That later
-- definition is the one in force; it is not repeated here.
