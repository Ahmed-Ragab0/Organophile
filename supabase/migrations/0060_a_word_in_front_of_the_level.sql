-- ===========================================================================
-- 0060 — a word in front of the level
-- ===========================================================================
-- "العامة ORGANIC 3 - Asyut  - 2027 - Clinical" splits into four tokens, and
-- the first one is `العامة ORGANIC 3`. The level pattern was anchored at the
-- start of the token, so a qualifier in front of the subject made it match
-- nothing — and the token then did what every unrecognised token does: it fell
-- through to the university slot. The result was a university literally called
-- "العامة ORGANIC 3", the real one (Asyut) dropped as the shorter leftover,
-- and no level on the course or on anybody taking it.
--
-- Three separate wrongs out of one missing space in a regex, and none of them
-- raised anything. This is the same silent shape as the Ph-D spelling in 0048:
-- the tell is an empty filter, never an error.
--
-- The fix is to let the subject sit at the END of its token rather than at the
-- start, and to keep what came before it OUT of the university slot — a word
-- sharing a token with the subject is a qualifier on the course, not a field
-- of its own. It is offered as a university only when the title has no other
-- leftover at all, so nothing that used to resolve stops resolving.
--
-- The repair below is deliberately narrow. It re-derives every course, then
-- cleans up ONLY what this migration itself orphaned: a university that exists
-- because the old parser handed a course title over as a name, that no course
-- points at any more. Anything an admin typed is untouched, and a student whose
-- classification was set by hand is never re-read — `classify_student` has
-- refused that since 0036 and still does.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The parser
-- ---------------------------------------------------------------------------
create or replace function app.parse_course_name(p_name text)
returns jsonb
language plpgsql immutable parallel safe set search_path = '' as $function$
declare
  parts     text[];
  tok       text;
  t         text;
  m         text[];
  v_subject text;
  v_level   int;
  v_section text;
  v_year    int;
  v_track   text;
  v_qual    text;
  rest      text[] := '{}';
begin
  if p_name is null or btrim(p_name) = '' then return '{}'::jsonb; end if;

  -- Spaces around the dash are required: Pharm-D, Beni-Suef and Kafr El-Sheikh
  -- are single tokens that a bare hyphen would tear in half.
  parts := regexp_split_to_array(btrim(p_name), '\s+[-–—]\s+');

  foreach tok in array parts loop
    tok := btrim(tok);
    continue when tok = '';
    t := app.text_key(tok);

    if v_level is null then
      -- `(?:(.*)\s+)?` — an optional qualifier, and the whitespace is part of
      -- it on purpose: the subject must start its own word. Without that,
      -- "BIOORGANIC 3" would read as Organic 3 with a qualifier of "BIO".
      m := regexp_match(t,
        '^(?:(.*)\s+)?(?:ORGANIC CHEMISTRY|ORGANIC|ORG|أورجانيك|اورجانيك|كيمياء عضوية|عضوية)\s*([0-9]+|I{1,3})$');
      if m is not null then
        v_subject := 'ORGANIC';
        v_level   := case m[2] when 'I' then 1 when 'II' then 2 when 'III' then 3
                               else m[2]::int end;
        -- Kept, not discarded, and kept apart from `rest`: see the university
        -- rule at the bottom.
        v_qual    := coalesce(v_qual, nullif(btrim(coalesce(m[1], '')), ''));
        continue;
      end if;
    end if;

    if v_year is null and t ~ '^(19|20)[0-9]{2}$' then
      v_year := t::int;
      continue;
    end if;

    if v_section is null then
      if    t in ('GIRLS', 'GIRL', 'بنات', 'طالبات') then v_section := 'Girls';  continue;
      elsif t in ('BOYS', 'BOY', 'بنين', 'أولاد', 'اولاد', 'طلاب') then v_section := 'Boys'; continue;
      elsif t in ('MIXED', 'MIX', 'مختلط') then v_section := 'Mixed'; continue;
      end if;
    end if;

    if v_track is null then
      if t like '%CLINICAL%' or t like '%اكلينيك%' or t like '%إكلينيك%' then
        v_track := 'Clinical'; continue;
      -- `^PH-?\s?D$` is anchored, unlike the PHARM patterns beside it: PHD as a
      -- substring of a longer word is not a track, but a token that is exactly
      -- Ph-D / PhD / PH D is the only thing it can be.
      elsif t ~ '^PH\s*-?\s*D$' or t ~ 'PHARM\s*-?\s*D' or t like '%PHARMD%'
            or t like '%فارم دي%' or t like '%فارماسي دي%' then
        v_track := 'Pharm D'; continue;
      elsif t like '%INDUSTRIAL%' or t like '%صناعية%' then
        v_track := 'Industrial'; continue;
      elsif t like '%BIOTECH%' or t like '%حيوية%' then
        v_track := 'Biotechnology'; continue;
      end if;
    end if;

    rest := rest || tok;
  end loop;

  return jsonb_strip_nulls(jsonb_build_object(
    'subject',    v_subject,
    'level',      v_level,
    'section',    v_section,
    'class_year', v_year,
    'track',      v_track,
    'qualifier',  v_qual,
    -- A leftover token is only a university if the name proved it was a course
    -- title at all. Without this guard a name with no structure — a package
    -- name that landed in the course field, say — produced a "university" that
    -- was the entire string, and one bad row would anchor a reporting group.
    -- Recognising nothing must produce nothing.
    'university',
      case when v_level is null and v_year is null
                and v_track is null and v_section is null
           then null
           -- The longest leftover, not the first: field order should not
           -- decide which token is the university. A qualifier that shared a
           -- token with the subject is the LAST resort, behind every real
           -- leftover — "العامة" is not a university while "Asyut" is standing
           -- right there, and this ordering is the whole fix.
           else coalesce(
                  (select r from unnest(rest) r order by length(r) desc limit 1),
                  v_qual)
      end,
    'recognised', (v_level is not null or v_year is not null
                   or v_track is not null or v_section is not null)
  ));
end;
$function$;

comment on function app.parse_course_name is
  'Reads subject/level, university, section, class year and track out of a '
  'course title. Classifies each token by shape, so a missing part leaves a '
  'null rather than shifting every later field onto the wrong column. A word '
  'in front of the subject is a qualifier on the course, and only stands in as '
  'the university when the title carries no other leftover.';

-- ---------------------------------------------------------------------------
-- 2. Re-derive, and clean up only what the old parse invented
-- ---------------------------------------------------------------------------
-- One block, no temp table: the old labels are held in a variable, so this
-- behaves the same whether the migration runner wraps it in a transaction or
-- not. Anything that disappears from that set was produced by the old parser
-- and by nothing else.
do $$
declare
  v_before text[];
  r        record;
  v_uni    uuid;
  v_st     record;
begin
  select coalesce(array_agg(distinct university_label), '{}')
    into v_before
    from public.courses where university_label is not null;

  -- `courses_parse_name` is a BEFORE UPDATE OF name trigger, so touching the
  -- name re-runs the whole parse. `courses_classify_students` is an AFTER
  -- UPDATE OF university_id/track_id/level trigger and does NOT fire for this
  -- statement — the students are re-read explicitly in step 3, as 0048 did.
  update public.courses set name = name;

  for r in
    select distinct l as label
      from unnest(v_before) l
     where not exists (
       select 1 from public.courses c
        where c.university_label is not null
          and app.text_key(c.university_label) = app.text_key(l))
  loop
    -- Which row that label resolved to. This is how app.resolve_university
    -- found it, so it is how we find it back.
    select university_id into v_uni
      from public.university_aliases
     where alias_key = app.text_key(r.label);
    continue when v_uni is null;

    -- Still in use by a course? Then it was a real university that merely
    -- stopped being spelled this way, and nothing here is ours to remove.
    continue when exists (select 1 from public.courses where university_id = v_uni);

    -- Students the classifier put there. An admin's own answer is locked and
    -- is left exactly as it is; the flag keeps this write from locking the
    -- ones that are not.
    for v_st in
      select id from public.students
       where university_id = v_uni and not classification_locked
    loop
      perform set_config('app.autoclassify', 'on', true);
      update public.students set university_id = null where id = v_st.id;
      perform set_config('app.autoclassify', '', true);
    end loop;

    -- Only the alias this label created for itself. The seeded ones
    -- (ASYUT → أسيوط and the rest) carry a different display_name and stay.
    delete from public.university_aliases
     where alias_key = app.text_key(r.label)
       and app.text_key(display_name) = app.text_key(r.label);

    delete from public.universities u
     where u.id = v_uni
       and not exists (select 1 from public.courses  c where c.university_id = u.id)
       and not exists (select 1 from public.students s where s.university_id = u.id)
       and not exists (select 1 from public.university_aliases a where a.university_id = u.id);
  end loop;

  -- ------------------------------------------------------------------------
  -- 3. Read the corrected courses down onto the students
  -- ------------------------------------------------------------------------
  -- Fills blanks only, demands unanimity across a student's courses, and skips
  -- anybody classified by hand.
  for r in select id from public.students loop
    perform app.classify_student(r.id);
  end loop;
end $$;
