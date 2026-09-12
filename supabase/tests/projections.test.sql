-- projections.test.sql
--
-- Regression suite for the ingest + projection + reporting layer.
-- Run against a database with the migrations applied. Every statement is
-- self-cleaning; a failed ASSERT aborts and rolls the whole thing back.
--
--   psql "$DATABASE_URL" -f supabase/tests/projections.test.sql
--
-- These are the behaviours that are expensive to get wrong: dedupe semantics,
-- out-of-order status guards, test/live isolation, and the reconciliation views.

begin;

delete from public.kashier_events_raw where body_sha256 like 'hash-%';
delete from public.ukkera_events_raw  where body_sha256 like 'uhash%';
delete from public.payments      where transaction_id like 'TST-%';
delete from public.payouts       where transfer_id like 'TR-%';
delete from public.subscriptions where order_id like 'tst-%';
delete from public.packages      where name like 'TSTPKG%';
delete from public.students      where name like 'TSTSTU%';
delete from public.courses       where name like 'TSTCRS%';

do $$
declare r jsonb; v_status public.txn_status; v_cnt int; v_dup int; v numeric; v_method text;
begin
  ---------------------------------------------------------------- Kashier
  -- K1: a first delivery projects into payments
  r := app.ingest_kashier_event(
    jsonb_build_object('platform','kashier','event','pay','data', jsonb_build_object(
      'transactionId','TST-TX-1','merchantOrderId','tst-order-1','kashierOrderId','k-1',
      'status','PENDING','amount',500,'currency','EGP','creationDate','2026-09-01T10:00:00Z',
      'apikeyname','يوكيرا','method','card',
      'sourceOfFunds', jsonb_build_object('cardInfo', jsonb_build_object(
        'cardBrand','VISA','maskedCard','450875******1019','cardHolderName','John Doe')),
      'settlementInfo', jsonb_build_object('settledAmount',480,'vat',4.56,'totalSellingFees',20))),
    'hash-1', true, 'test');
  assert r->>'processing' = 'processed', 'K1: ' || r::text;

  -- K2: a byte-identical retry dedupes and bumps the counter
  r := app.ingest_kashier_event(jsonb_build_object('x','ignored'), 'hash-1', true, 'test');
  assert r->>'status' = 'duplicate', 'K2: ' || r::text;
  select duplicate_count into v_dup from public.kashier_events_raw where body_sha256='hash-1';
  assert v_dup = 1, 'K2b duplicate_count=' || v_dup;

  -- K3: same transaction + same event + different status is a REAL transition,
  --     not a duplicate. This is why dedupe hashes the body.
  r := app.ingest_kashier_event(
    jsonb_build_object('platform','kashier','event','pay','data', jsonb_build_object(
      'transactionId','TST-TX-1','merchantOrderId','tst-order-1','status','SUCCESS',
      'amount',500,'currency','EGP','creationDate','2026-09-01T10:05:00Z')),'hash-2', true, 'test');
  select status into v_status from public.payments where transaction_id='TST-TX-1' and mode='test';
  assert v_status = 'SUCCESS', 'K3 status=' || v_status;

  -- K4: a stale PENDING arriving after SUCCESS must NOT downgrade it
  r := app.ingest_kashier_event(
    jsonb_build_object('platform','kashier','event','pay','data', jsonb_build_object(
      'transactionId','TST-TX-1','merchantOrderId','tst-order-1','status','PENDING',
      'amount',500,'currency','EGP','creationDate','2026-09-01T10:01:00Z')),'hash-3', true, 'test');
  select status into v_status from public.payments where transaction_id='TST-TX-1' and mode='test';
  assert v_status = 'SUCCESS', 'K4 REGRESSION: downgraded to ' || v_status;

  -- K5: three deliveries, still one payment row
  select count(*) into v_cnt from public.payments where transaction_id='TST-TX-1';
  assert v_cnt = 1, 'K5 rows=' || v_cnt;

  -- K6: nested extraction survives later deliveries that omit those fields
  perform 1 from public.payments where transaction_id='TST-TX-1' and card_brand='VISA'
    and masked_card='450875******1019' and settled_amount=480 and apikey_name='يوكيرا';
  assert found, 'K6 nested extraction / coalesce-preserve failed';

  -- K7/K8: permanently unprocessable payloads are ignored, never retried
  r := app.ingest_kashier_event(
    jsonb_build_object('event','not_a_real_event','data',jsonb_build_object('transactionId','TST-TX-2')),
    'hash-4',true,'test');
  assert r->>'processing' = 'ignored', 'K7: ' || r::text;

  r := app.ingest_kashier_event(
    jsonb_build_object('event','pay','data',jsonb_build_object('status','SUCCESS')),'hash-5',true,'test');
  assert r->>'processing' = 'ignored', 'K8: ' || r::text;

  -- K9: an unrecognised transfer shape fails RETRYABLY, so it can be recovered
  --     once the real payload shape is known
  r := app.ingest_kashier_event(
    jsonb_build_object('event','TRANSFERRED','data',jsonb_build_object('mysteryKey','x')),
    'hash-6',true,'test','transfer');
  assert r->>'processing' = 'failed', 'K9 expected retryable failed: ' || r::text;

  -- K10: a recognisable transfer projects
  r := app.ingest_kashier_event(
    jsonb_build_object('event','TRANSFERRED','data',jsonb_build_object(
      'transferId','TR-1','amount',1000,'currency','EGP','transferDate','2026-09-02T12:00:00Z')),
    'hash-7',true,'test','transfer');
  assert r->>'processing' = 'processed', 'K10: ' || r::text;

  -- K11: the same transaction id in live mode is a separate row
  r := app.ingest_kashier_event(
    jsonb_build_object('event','pay','data',jsonb_build_object(
      'transactionId','TST-TX-1','status','SUCCESS','amount',500)),'hash-8',true,'live');
  select count(*) into v_cnt from public.payments where transaction_id='TST-TX-1';
  assert v_cnt = 2, 'K11 test/live isolation broken, rows=' || v_cnt;

  ---------------------------------------------------------------- ukkera
  r := app.ingest_ukkera_event(jsonb_build_object(
    'student_name','TSTSTU أحمد محمد','phone','+20 101 234 5678','course','TSTCRS Organic',
    'amount',500,'order_id','tst-order-1','payment_date','2026-09-01'), 'uhash-1');
  assert r->>'processing' = 'processed', 'U1: ' || r::text;

  -- U2/U3: the same student via a differently formatted phone must be reused
  r := app.ingest_ukkera_event(jsonb_build_object(
    'student_name','TSTSTU أحمد محمد','phone','01012345678','course','TSTCRS Organic',
    'amount',300,'order_id','tst-order-2','payment_date','2026-09-03'), 'uhash-2');
  assert r->>'processing' = 'processed', 'U2: ' || r::text;
  select count(*) into v_cnt from public.students where name like 'TSTSTU%';
  assert v_cnt = 1, 'U3 phone-normalised dedupe failed, students=' || v_cnt;

  select count(*) into v_cnt from public.courses where name like 'TSTCRS%';
  assert v_cnt = 1, 'U4 course dedupe failed, courses=' || v_cnt;

  select count(*) into v_cnt from public.subscriptions where order_id like 'tst-%';
  assert v_cnt = 2, 'U5 subs=' || v_cnt;

  r := app.ingest_ukkera_event(jsonb_build_object('student_name','x'), 'uhash-3');
  assert r->>'processing' = 'ignored', 'U6 missing order_id: ' || r::text;

  -- U7: ukkera renames a course. Its number is the identity, so the second
  --     spelling must land on the same row. It used to try to insert a rival
  --     carrying the same number, and courses_ukkera_id_uniq turned that into a
  --     failed event that stranded a paid enrolment with no course at all.
  r := app.ingest_ukkera_event(jsonb_build_object(
    'event','transfer.success','transfer_id','tst-u7',
    'student_name','TSTSTU أحمد محمد','student_phone','01012345678',
    'course_id','9001','course_name','TSTCRS Foundation',
    'package_name','TSTPKG full','amount',100,'date','2026-09-04T10:00:00Z'), 'uhash-4');
  assert r->>'processing' = 'processed', 'U7a: ' || r::text;

  r := app.ingest_ukkera_event(jsonb_build_object(
    'event','transfer.success','transfer_id','tst-u8',
    'student_name','TSTSTU سارة','student_phone','01099999999',
    'course_id','9001','course_name','TSTCRS Foundation renamed',
    'package_name','TSTPKG full','amount',100,'date','2026-09-05T10:00:00Z'), 'uhash-5');
  assert r->>'processing' = 'processed', 'U7b RENAME REGRESSION: ' || r::text;

  select count(*) into v_cnt from public.courses where ukkera_course_id = '9001';
  assert v_cnt = 1, 'U8 the rename created a second course, courses=' || v_cnt;

  -- U9: the name we hold is not overwritten — reports group by it and the
  --     level was parsed out of it — but the new spelling is on the record.
  perform 1 from public.courses
   where ukkera_course_id = '9001' and name = 'TSTCRS Foundation'
     and ukkera_course_name = 'TSTCRS Foundation renamed';
  assert found, 'U9 stored name changed, or the new spelling was not recorded';

  -- U10: a package from the payloads that carried no course is the same
  --      package. The course arriving later adopts it rather than shelving a
  --      second copy and splitting one package across two rows.
  insert into public.packages (name) values ('TSTPKG orphan');
  r := app.ingest_ukkera_event(jsonb_build_object(
    'event','transfer.success','transfer_id','tst-u10',
    'student_name','TSTSTU أحمد محمد','student_phone','01012345678',
    'course_id','9001','course_name','TSTCRS Foundation',
    'package_name','TSTPKG orphan','amount',100,'date','2026-09-06T10:00:00Z'), 'uhash-6');
  assert r->>'processing' = 'processed', 'U10a: ' || r::text;
  select count(*) into v_cnt from public.packages where name = 'TSTPKG orphan';
  assert v_cnt = 1, 'U10b orphan package duplicated, rows=' || v_cnt;
  perform 1 from public.packages p join public.courses c on c.id = p.course_id
   where p.name = 'TSTPKG orphan' and c.ukkera_course_id = '9001';
  assert found, 'U10c orphan package was not adopted by its course';

  -- U11: the older payload shape names a package and no course. One package,
  --      one course, so the enrolment still knows what was bought.
  r := app.ingest_ukkera_event(jsonb_build_object(
    'event','transfer.success','transfer_id','tst-u11',
    'student_name','TSTSTU سارة','student_phone','01099999999',
    'package_name','TSTPKG orphan','amount',100,'date','2026-09-07T10:00:00Z'), 'uhash-7');
  assert r->>'processing' = 'processed', 'U11a: ' || r::text;
  perform 1 from public.subscriptions s join public.courses c on c.id = s.course_id
   where s.ukkera_transfer_id = 'tst-u11' and c.ukkera_course_id = '9001';
  assert found, 'U11b course not inferred from an unambiguous package';

  -- U12: two courses selling the same package name. Now the name identifies
  --      nothing, and guessing would enrol the student on somebody else's
  --      course — so the course is left empty and stays answerable.
  r := app.ingest_ukkera_event(jsonb_build_object(
    'event','transfer.success','transfer_id','tst-u12a',
    'student_name','TSTSTU سارة','student_phone','01099999999',
    'course_id','9002','course_name','TSTCRS Second',
    'package_name','TSTPKG orphan','amount',150,'date','2026-09-08T10:00:00Z'), 'uhash-8');
  assert r->>'processing' = 'processed', 'U12a: ' || r::text;

  r := app.ingest_ukkera_event(jsonb_build_object(
    'event','transfer.success','transfer_id','tst-u12b',
    'student_name','TSTSTU سارة','student_phone','01099999999',
    'package_name','TSTPKG orphan','amount',175,'date','2026-09-09T10:00:00Z'), 'uhash-9');
  assert r->>'processing' = 'processed', 'U12b: ' || r::text;
  perform 1 from public.subscriptions
   where ukkera_transfer_id = 'tst-u12b' and course_id is null;
  assert found, 'U12c a shared package name was allowed to pick a course';

  ------------------------------------------------------- course titles
  -- P1: a qualifier in front of the subject. Anchoring the level pattern at
  --     the start of the token lost the level AND handed the whole token to
  --     the university slot — one course became a university called
  --     "العامة ORGANIC 3" while Asyut, standing right beside it, was dropped.
  assert (app.parse_course_name('العامة ORGANIC 3 - Asyut  - 2027 - Clinical'))
         @> '{"level":3,"university":"Asyut","track":"Clinical","class_year":2027}'::jsonb,
    'P1 qualified title: ' || app.parse_course_name('العامة ORGANIC 3 - Asyut  - 2027 - Clinical')::text;

  -- P2: and the ordinary shape is untouched. This is the assertion that says
  --     the fix cost nothing.
  assert (app.parse_course_name('ORGANIC 3 - Azhar Cairo - Girls - 2027 - Ph-D'))
         @> '{"level":3,"university":"Azhar Cairo","section":"Girls","track":"Pharm D"}'::jsonb,
    'P2 plain title REGRESSION: ' || app.parse_course_name('ORGANIC 3 - Azhar Cairo - Girls - 2027 - Ph-D')::text;

  -- P3: the subject must start its own word. "BIOORGANIC" is not Organic with
  --     a qualifier of "BIO", and a greedy prefix would have made it one.
  assert (app.parse_course_name('BIOORGANIC 3 - Cairo - 2027')) -> 'level' is null,
    'P3 BIOORGANIC read as a level: ' || app.parse_course_name('BIOORGANIC 3 - Cairo - 2027')::text;

  -- P4: the qualifier stands in as the university only when the title carries
  --     no other leftover — behind every real one, never in front.
  assert (app.parse_course_name('العامة ORGANIC 3')) @> '{"university":"العامة"}'::jsonb,
    'P4 lone qualifier: ' || app.parse_course_name('العامة ORGANIC 3')::text;

  -- P5: a string with no course structure still yields no university, so a
  --     package name in the course field cannot anchor a reporting group.
  assert (app.parse_course_name('اشتراك في Introduction course - الكورس التأسيسي')) -> 'university' is null,
    'P5 structureless title invented a university';

  ---------------------------------------------------------------- views
  r := app.ingest_kashier_event(jsonb_build_object('event','refund','data',jsonb_build_object(
    'transactionId','TST-TX-RF','merchantOrderId','tst-order-1','status','SUCCESS',
    'amount',100,'currency','EGP','creationDate','2026-09-04T10:00:00Z')),'hash-rf',true,'test');
  r := app.ingest_kashier_event(jsonb_build_object('event','pay','data',jsonb_build_object(
    'transactionId','TST-TX-ORPHAN','merchantOrderId','tst-no-such-order','status','SUCCESS',
    'amount',750,'currency','EGP','creationDate','2026-09-05T10:00:00Z')),'hash-orph',true,'test');
  r := app.ingest_kashier_event(jsonb_build_object('event','pay','data',jsonb_build_object(
    'transactionId','TST-TX-FAIL','merchantOrderId','tst-order-2','status','FAILURE',
    'amount',300,'currency','EGP','creationDate','2026-09-06T10:00:00Z')),'hash-fail',true,'test');

  select match_method into v_method from public.v_payments_enriched
   where transaction_id='TST-TX-1' and mode='test';
  assert v_method = 'auto_order_key', 'V1 match_method=' || v_method;

  perform 1 from public.v_payments_enriched where transaction_id='TST-TX-1' and mode='test'
    and student_name like 'TSTSTU%' and course_name like 'TSTCRS%';
  assert found, 'V2 enrichment did not reach student/course';

  -- V4: net of a 500 payment and a 100 refund on the same order
  select sum(signed_amount) into v from public.v_payments_enriched
   where mode='test' and subscription_order_id='tst-order-1';
  assert v = 400, 'V4 net should be 400, got ' || v;

  -- V5: a FAILURE contributes nothing to revenue
  select signed_amount into v from public.v_payments_enriched where transaction_id='TST-TX-FAIL';
  assert v = 0, 'V5 failed payment counted ' || v;

  select count(*) into v_cnt from public.v_unmatched_payments where transaction_id='TST-TX-ORPHAN';
  assert v_cnt = 1, 'V6 orphan missing from v_unmatched_payments';

  select count(*) into v_cnt from public.v_unmatched_payments
   where transaction_id='TST-TX-1' and mode='test';
  assert v_cnt = 0, 'V7 matched payment leaked into unmatched';

  -- V8: an order with only a FAILED payment is still unpaid
  select count(*) into v_cnt from public.v_unpaid_subscriptions where order_id='tst-order-2';
  assert v_cnt = 1, 'V8 order-2 should be unpaid';

  select count(*) into v_cnt from public.v_unpaid_subscriptions where order_id='tst-order-1';
  assert v_cnt = 0, 'V9 order-1 is paid but showed as unpaid';

  raise notice 'ALL PROJECTION AND VIEW TESTS PASSED';
end $$;

rollback;
