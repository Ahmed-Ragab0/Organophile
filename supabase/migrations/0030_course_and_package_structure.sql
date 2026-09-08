-- "ORGANIC 1 - Azhar Cairo - Girls - 2027 - Clinical" is five facts wearing a
-- single text field: subject and level, university, section, graduating year,
-- and track. Grouping revenue by university means reading them out.
--
-- Tokens are classified by what they LOOK like, not by where they sit. Not
-- every course carries all five, and a positional parser turns a missing
-- section into a university called "2027" — wrong data that looks like data.
-- Anything unrecognised falls through to the university slot, which is the one
-- part with no fixed vocabulary.

alter table public.courses
  add column if not exists subject           text,
  add column if not exists level             int,
  add column if not exists section           text,
  add column if not exists class_year        int,
  add column if not exists track             text,
  add column if not exists university_label  text;

comment on column public.courses.university_label is
  'The university exactly as ukkera spelled it, kept beside the resolved '
  'university_id so a bad resolution stays visible instead of silent.';

create or replace function app.text_key(p text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select nullif(upper(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))), '')
$$;

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
      m := regexp_match(t,
        '^(?:ORGANIC CHEMISTRY|ORGANIC|ORG|أورجانيك|اورجانيك|كيمياء عضوية|عضوية)\s*([0-9]+|I{1,3})$');
      if m is not null then
        v_subject := 'ORGANIC';
        v_level   := case m[1] when 'I' then 1 when 'II' then 2 when 'III' then 3
                               else m[1]::int end;
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
      elsif t ~ 'PHARM\s*-?\s*D' or t like '%PHARMD%' then
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
           -- decide which token is the university.
           else (select r from unnest(rest) r order by length(r) desc limit 1)
      end,
    'recognised', (v_level is not null or v_year is not null
                   or v_track is not null or v_section is not null)
  ));
end;
$function$;

comment on function app.parse_course_name is
  'Reads subject/level, university, section, class year and track out of a '
  'course title. Classifies each token by shape, so a missing part leaves a '
  'null rather than shifting every later field onto the wrong column.';

-- ---------------------------------------------------------------------------
-- One university, many spellings. ukkera writes "Azhar Cairo"; the universities
-- entered by hand are Arabic. Left alone, every spelling becomes its own row
-- and revenue-by-university splits into near-duplicates.
--
-- The alias table is the single place a spelling is bound to a name, and it
-- learns: an unseen spelling is recorded pointing at itself, so renaming the
-- university later keeps every past spelling attached to it.
-- ---------------------------------------------------------------------------
create table if not exists public.university_aliases (
  alias_key    text primary key,
  display_name text not null,
  created_at   timestamptz not null default now()
);

alter table public.university_aliases enable row level security;
grant select on public.university_aliases to authenticated;
grant all on public.university_aliases to service_role;

drop policy if exists university_aliases_read on public.university_aliases;
create policy university_aliases_read on public.university_aliases
  for select to authenticated using (app.is_admin());
drop policy if exists university_aliases_write on public.university_aliases;
create policy university_aliases_write on public.university_aliases
  for all to authenticated using (app.is_admin()) with check (app.is_admin());

insert into public.university_aliases (alias_key, display_name) values
  ('AZHAR CAIRO', 'الأزهر – القاهرة'), ('AL-AZHAR CAIRO', 'الأزهر – القاهرة'),
  ('AL AZHAR CAIRO', 'الأزهر – القاهرة'),
  ('AZHAR ASSIUT', 'الأزهر – أسيوط'), ('AL-AZHAR ASSIUT', 'الأزهر – أسيوط'),
  ('AZHAR ASYUT', 'الأزهر – أسيوط'),
  ('AZHAR', 'الأزهر'), ('AL-AZHAR', 'الأزهر'), ('AL AZHAR', 'الأزهر'),
  ('CAIRO', 'القاهرة'),
  ('AIN SHAMS', 'عين شمس'), ('AINSHAMS', 'عين شمس'),
  ('ALEXANDRIA', 'الإسكندرية'), ('ALEX', 'الإسكندرية'),
  ('MANSOURA', 'المنصورة'), ('TANTA', 'طنطا'), ('ZAGAZIG', 'الزقازيق'),
  ('ASSIUT', 'أسيوط'), ('ASYUT', 'أسيوط'),
  ('HELWAN', 'حلوان'),
  ('BENI SUEF', 'بني سويف'), ('BENI-SUEF', 'بني سويف'), ('BANI SUEF', 'بني سويف'),
  ('MINIA', 'المنيا'), ('MINYA', 'المنيا'), ('EL MINIA', 'المنيا'),
  ('FAYOUM', 'الفيوم'), ('FAYUM', 'الفيوم'),
  ('SUEZ CANAL', 'قناة السويس'), ('SUEZ', 'السويس'),
  ('DAMANHOUR', 'دمنهور'),
  ('MENOUFIA', 'المنوفية'), ('MENOFIA', 'المنوفية'), ('MONOUFIA', 'المنوفية'),
  ('KAFR EL SHEIKH', 'كفر الشيخ'), ('KAFR EL-SHEIKH', 'كفر الشيخ'),
  ('KAFRELSHEIKH', 'كفر الشيخ'),
  ('SOHAG', 'سوهاج'), ('ASWAN', 'أسوان'), ('SOUTH VALLEY', 'جنوب الوادي'),
  ('PORT SAID', 'بورسعيد'), ('DAMIETTA', 'دمياط'),
  ('BENHA', 'بنها'), ('BANHA', 'بنها'), ('NEW VALLEY', 'الوادي الجديد'),
  ('OCTOBER 6', '٦ أكتوبر'), ('O6U', '٦ أكتوبر'),
  ('FUTURE', 'المستقبل'), ('FUE', 'المستقبل'),
  ('AHRAM CANADIAN', 'الأهرام الكندية'), ('ACU', 'الأهرام الكندية'),
  ('BADR', 'بدر'), ('BUC', 'بدر'),
  ('SINAI', 'سيناء'), ('DELTA', 'الدلتا'), ('HORUS', 'حورس'),
  ('DERAYA', 'دراية'), ('NAHDA', 'النهضة'), ('HELIOPOLIS', 'هليوبوليس'),
  ('BUE', 'البريطانية'), ('MSA', 'MSA'), ('MTI', 'MTI'), ('MUST', 'MUST')
on conflict (alias_key) do nothing;

create or replace function app.resolve_university(p_label text)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_key     text := app.text_key(p_label);
  v_display text;
  v_id      uuid;
begin
  if v_key is null then return null; end if;

  select display_name into v_display
    from public.university_aliases where alias_key = v_key;

  if v_display is null then
    -- Unknown spelling: keep it exactly as written and remember it, so the
    -- next delivery with the same spelling lands on the same row.
    v_display := btrim(p_label);
    insert into public.university_aliases (alias_key, display_name)
    values (v_key, v_display) on conflict (alias_key) do nothing;
  end if;

  select id into v_id from public.universities
   where name_key = app.text_key(v_display) limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.universities (name) values (v_display)
  on conflict (name_key) do update set updated_at = now()
  returning id into v_id;
  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- packages: what was actually bought
-- ---------------------------------------------------------------------------
alter table public.packages
  add column if not exists kind              text not null default 'other',
  add column if not exists installment_count int  not null default 1,
  add column if not exists installment_seq   int,
  add column if not exists total_price       numeric(14,2),
  add column if not exists chapter_name      text;

comment on column public.packages.price is
  'What the student is charged for THIS package — for an instalment package '
  'that is one instalment, not the course.';
comment on column public.packages.total_price is
  'What the whole course costs when paid through this package. For an '
  'instalment package this is the figure the instalments add up to.';

alter table public.packages drop constraint if exists packages_kind_check;
alter table public.packages add constraint packages_kind_check
  check (kind in ('full', 'chapter', 'installment', 'other'));

create or replace function app.parse_package_name(p_name text)
returns jsonb language plpgsql immutable parallel safe set search_path = '' as $function$
declare
  t       text := app.text_key(p_name);
  v_kind  text := 'other';
  v_seq   int;
  v_chap  text;
  m       text[];
begin
  if t is null then return '{}'::jsonb; end if;

  -- Instalment is checked first on purpose: "الكورس كامل بالقسط" is an
  -- instalment package that also says "full", and how it is PAID is the fact
  -- that changes what the student still owes.
  if t ~ 'قسط|أقساط|اقساط|تقسيط|دفعة|دفعات|INSTALL?MENT' then
    v_kind := 'installment';
  elsif t ~ 'شابتر|CHAPTER|فصل|باب' then
    v_kind := 'chapter';
  elsif t ~ 'كامل|كاملة|FULL|COMPLETE' then
    v_kind := 'full';
  end if;

  if v_kind = 'installment' then
    if    t ~ 'الأولى|الاولى|الأول|الاول|FIRST|1ST|(^|[^0-9])1([^0-9]|$)' then v_seq := 1;
    elsif t ~ 'الثانية|الثاني|SECOND|2ND|(^|[^0-9])2([^0-9]|$)'          then v_seq := 2;
    elsif t ~ 'الثالثة|الثالث|THIRD|3RD|(^|[^0-9])3([^0-9]|$)'           then v_seq := 3;
    end if;
  end if;

  if v_kind = 'chapter' then
    m := regexp_match(btrim(p_name), '(?:شابتر|[Cc]hapter)\s+(.+)$');
    if m is not null then v_chap := btrim(m[1]); end if;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'kind', v_kind, 'installment_seq', v_seq, 'chapter', v_chap));
end;
$function$;

comment on function app.parse_package_name is
  'Classifies an ukkera package title as a full course, a single chapter, or '
  'one instalment of a plan — the distinction that decides whether a payment '
  'settles the subscription or only part of it.';
