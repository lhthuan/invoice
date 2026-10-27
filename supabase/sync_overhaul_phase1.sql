-- =============================================================================
-- sync_overhaul_phase1.sql  —  GIAI ĐOẠN 1 (chỉ BỔ SUNG, client cũ vẫn chạy)
-- =============================================================================
-- Cách chạy:
--   1. Supabase Dashboard → SQL Editor → dán TOÀN BỘ file này → Run.
--      File idempotent: chạy lại nhiều lần không lỗi, không mất dữ liệu.
--      Lần đầu có vài câu quét bảng stock_by_branch (tạo index, seed stock_meta)
--      nên có thể mất vài giây; nên chạy lúc không có ai đang upload tồn kho.
--   2. Đặt (hoặc đổi) MÃ UPLOAD — chạy RIÊNG, thay <MÃ_UPLOAD> bằng mã dài
--      (khuyên ≥ 16 ký tự). KHÔNG commit mã thật vào git:
--
--        SET search_path = public, extensions;
--        INSERT INTO private.app_secret (key, hash)
--        VALUES ('upload_code', crypt('<MÃ_UPLOAD>', gen_salt('bf')))
--        ON CONFLICT (key) DO UPDATE SET hash = EXCLUDED.hash;
--
--      Chưa đặt mã thì mọi RPC ghi đều trả lỗi 'bad_code' (an toàn mặc định).
--   3. Kiểm tra nhanh:
--        SELECT * FROM public.stock_meta;
--        SELECT public.upload_code_check('<MÃ_UPLOAD>');   -- phải ra true
--
-- Sau khi chạy file này: policy anon_all cũ vẫn giữ nguyên (client cũ ghi trực
-- tiếp vẫn được). Thu quyền ghi của anon ở sync_overhaul_phase2.sql.
--
-- Lỗi nghiệp vụ RPC (error.message): bad_code, upload_in_progress,
-- upload_mismatch, row_count_mismatch, empty_upload.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Extension + schema private + bảng bí mật
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS private.app_secret (
  key  text PRIMARY KEY,
  hash text NOT NULL
);
REVOKE ALL ON private.app_secret FROM PUBLIC;
REVOKE ALL ON private.app_secret FROM anon, authenticated;

-- Kiểm mã: true nếu khớp hash bcrypt. Không có dòng 'upload_code' → luôn false.
CREATE OR REPLACE FUNCTION private.upload_code_ok(p_code text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions
AS $fn$
BEGIN
  IF p_code IS NULL OR p_code = '' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM private.app_secret s
    WHERE s.key = 'upload_code'
      AND s.hash = crypt(p_code, s.hash)
  );
END
$fn$;

CREATE OR REPLACE FUNCTION private.require_upload_code(p_code text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions
AS $fn$
BEGIN
  IF NOT private.upload_code_ok(p_code) THEN
    RAISE EXCEPTION 'bad_code';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION private.upload_code_ok(text)      FROM PUBLIC;
REVOKE ALL ON FUNCTION private.require_upload_code(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.upload_code_ok(text)      FROM anon, authenticated;
REVOKE ALL ON FUNCTION private.require_upload_code(text) FROM anon, authenticated;


-- -----------------------------------------------------------------------------
-- 2. stock_by_branch (+ cột upload_id, seq) và stock_by_branch_staging
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_by_branch (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ma_hang    text NOT NULL,
  ten_hang   text DEFAULT '',
  chi_nhanh  text DEFAULT '',
  tinh_thanh text DEFAULT '',
  ma_kho     text DEFAULT '',
  dvt        text DEFAULT '',
  cuoi_ky    numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.stock_by_branch ADD COLUMN IF NOT EXISTS upload_id uuid;
ALTER TABLE public.stock_by_branch ADD COLUMN IF NOT EXISTS seq int;

-- Cùng cấu trúc với bảng chính (default, PK, index). LIKE không chép RLS/policy/grant
-- → cấu hình ở mục 3. Đổi tên bảng (RENAME) giữ policy/grant/index theo bảng,
-- nên 2 bảng phải được cấu hình giống hệt nhau.
CREATE TABLE IF NOT EXISTS public.stock_by_branch_staging
  (LIKE public.stock_by_branch INCLUDING ALL);
ALTER TABLE public.stock_by_branch_staging ADD COLUMN IF NOT EXISTS upload_id uuid;
ALTER TABLE public.stock_by_branch_staging ADD COLUMN IF NOT EXISTS seq int;

-- Index trên cả 2 bảng: (ma_hang), (id) cho keyset, (upload_id, seq) cho chunk
-- idempotent. Kiểm theo CỘT chứ không theo tên index, vì sau mỗi lần đổi tên
-- bảng các index mang tên cũ đi theo bảng.
DO $do$
DECLARE
  t    text;
  spec text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_by_branch', 'stock_by_branch_staging'] LOOP
    FOREACH spec IN ARRAY ARRAY['ma_hang', 'id', 'upload_id,seq'] LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        WHERE i.indrelid = format('public.%I', t)::regclass
          AND i.indpred IS NULL
          AND i.indexprs IS NULL
          AND (SELECT string_agg(a.attname::text, ',' ORDER BY k.ord)
                 FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a
                   ON a.attrelid = i.indrelid AND a.attnum = k.attnum) = spec
      ) THEN
        EXECUTE format(
          'CREATE INDEX ON public.%I (%s)',
          t,
          (SELECT string_agg(quote_ident(c), ', ')
             FROM unnest(string_to_array(spec, ',')) AS c)
        );
        RAISE NOTICE 'Đã tạo index %(%)', t, spec;
      END IF;
    END LOOP;
  END LOOP;
END
$do$;


-- -----------------------------------------------------------------------------
-- 3. RLS / policy / grant cho 2 bảng stock
--    - Nếu bảng chính đang mở cho anon (RLS tắt, hoặc có policy anon_all) thì
--      giữ nguyên hành vi đó trên CẢ 2 bảng bằng policy anon_all, để client cũ
--      ghi trực tiếp vẫn chạy kể cả sau khi bảng bị đổi tên. Phase 2 sẽ gỡ.
--    - Cả 2 bảng có anon_select (bảng nào cũng có thể thành bảng chính).
-- -----------------------------------------------------------------------------
DO $do$
DECLARE
  v_rls      boolean;
  v_has_all  boolean;
  v_need_all boolean;
  t          text;
BEGIN
  SELECT c.relrowsecurity INTO v_rls
  FROM pg_class c
  WHERE c.oid = 'public.stock_by_branch'::regclass;

  SELECT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = 'stock_by_branch'
      AND p.policyname = 'anon_all'
  ) INTO v_has_all;

  v_need_all := (NOT v_rls) OR v_has_all;

  FOREACH t IN ARRAY ARRAY['stock_by_branch', 'stock_by_branch_staging'] LOOP
    IF v_need_all AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = t AND p.policyname = 'anon_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY anon_all ON public.%I FOR ALL TO anon USING (true) WITH CHECK (true)', t);
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS anon_select ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY anon_select ON public.%I FOR SELECT TO anon USING (true)', t);

    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
    IF v_need_all THEN
      EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.%I TO anon, authenticated', t);
    END IF;
  END LOOP;
END
$do$;


-- -----------------------------------------------------------------------------
-- 4. stock_meta (đúng 1 dòng id = 1), anon chỉ SELECT
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_meta (
  id                int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version           uuid NOT NULL DEFAULT gen_random_uuid(),
  status            text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'uploading')),
  row_count         int NOT NULL DEFAULT 0,
  qty_sum           numeric NOT NULL DEFAULT 0,
  published_at      timestamptz,
  upload_id         uuid,
  upload_started_at timestamptz,
  uploader          text,
  file_name         text
);
ALTER TABLE public.stock_meta ADD COLUMN IF NOT EXISTS upload_started_at timestamptz;
ALTER TABLE public.stock_meta ADD COLUMN IF NOT EXISTS uploader text;
ALTER TABLE public.stock_meta ADD COLUMN IF NOT EXISTS file_name text;
-- Cột phụ (ngoài CONTRACT): tên file của lượt upload đang chạy, chuyển sang
-- file_name khi commit (vì stock_commit_upload không nhận tên file).
ALTER TABLE public.stock_meta ADD COLUMN IF NOT EXISTS upload_file_name text;

-- Seed 1 lần từ dữ liệu hiện có (quét bảng chính 1 lần, chỉ khi chưa có dòng).
DO $do$
DECLARE
  v_count bigint;
  v_sum   numeric;
  v_ts    timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.stock_meta WHERE id = 1) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'stock_by_branch'
        AND column_name = 'updated_at'
    ) THEN
      EXECUTE 'SELECT count(*), coalesce(sum(cuoi_ky), 0), max(updated_at) FROM public.stock_by_branch'
        INTO v_count, v_sum, v_ts;
    ELSE
      EXECUTE 'SELECT count(*), coalesce(sum(cuoi_ky), 0) FROM public.stock_by_branch'
        INTO v_count, v_sum;
    END IF;

    INSERT INTO public.stock_meta (id, version, status, row_count, qty_sum, published_at)
    VALUES (1, gen_random_uuid(), 'ready', v_count, v_sum, coalesce(v_ts, now()))
    ON CONFLICT (id) DO NOTHING;
  END IF;
END
$do$;

ALTER TABLE public.stock_meta ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anon_select ON public.stock_meta;
CREATE POLICY anon_select ON public.stock_meta FOR SELECT TO anon USING (true);
REVOKE ALL ON public.stock_meta FROM anon, authenticated;
GRANT SELECT ON public.stock_meta TO anon, authenticated;


-- -----------------------------------------------------------------------------
-- 5. branches
--    Nếu CHƯA có: tạo mới với chi_nhanh là khoá, RLS bật, anon chỉ đọc
--    (ghi qua RPC branches_upsert).
--    Nếu ĐÃ có: không đổi RLS/khoá (tránh làm hỏng upsert của client cũ);
--    chỉ thêm policy anon_select (vô hại nếu RLS đang tắt).
-- -----------------------------------------------------------------------------
DO $do$
BEGIN
  IF to_regclass('public.branches') IS NULL THEN
    CREATE TABLE public.branches (
      chi_nhanh  text PRIMARY KEY,
      tinh_thanh text DEFAULT '',
      updated_at timestamptz DEFAULT now()
    );
    ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON public.branches FROM anon, authenticated;
    GRANT SELECT ON public.branches TO anon, authenticated;
    RAISE NOTICE 'Đã tạo bảng branches mới';
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = 'public.branches'::regclass
        AND i.indisunique AND i.indnatts = 1
        AND i.indpred IS NULL AND i.indexprs IS NULL
        AND a.attname = 'chi_nhanh'
    ) THEN
      RAISE NOTICE 'branches đã tồn tại nhưng KHÔNG có unique trên chi_nhanh — '
                   'branches_upsert vẫn chạy (update rồi insert), nên kiểm tra dòng trùng.';
    END IF;
  END IF;
END
$do$;
ALTER TABLE public.branches ADD COLUMN IF NOT EXISTS tinh_thanh text DEFAULT '';
DROP POLICY IF EXISTS anon_select ON public.branches;
CREATE POLICY anon_select ON public.branches FOR SELECT TO anon USING (true);
GRANT SELECT ON public.branches TO anon, authenticated;


-- -----------------------------------------------------------------------------
-- 6. inventory: bổ sung các cột mà index.html (parseInvRows) ghi vào
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory (
  sku        text PRIMARY KEY,
  name       text NOT NULL,
  price      numeric DEFAULT 0,
  unit       text DEFAULT 'Sp',
  stock      integer DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS price             numeric DEFAULT 0;
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS unit              text DEFAULT 'Sp';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS stock             integer DEFAULT 0;
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS updated_at        timestamptz DEFAULT now();
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS barcode           text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS description       text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS active_ingredient text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS base_unit         text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS vat               numeric DEFAULT 0;
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS manufacturer      text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS country           text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS category          text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS product_type      text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS buy_price         numeric DEFAULT 0;
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS buy_unit          text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS registration_no   text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS importer          text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS brand_name        text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS brand_code        text DEFAULT '';
ALTER TABLE public.inventory ADD COLUMN IF NOT EXISTS status            text DEFAULT '';
-- Policy đọc (vô hại nếu RLS đang tắt); anon_all cũ giữ nguyên tới phase 2.
DROP POLICY IF EXISTS anon_select ON public.inventory;
CREATE POLICY anon_select ON public.inventory FOR SELECT TO anon USING (true);
GRANT SELECT ON public.inventory TO anon, authenticated;


-- -----------------------------------------------------------------------------
-- 7. RPC (SECURITY DEFINER, owner postgres, search_path cố định)
--    Ghi chú:
--    - Câu lệnh đụng 2 bảng stock dùng EXECUTE (SQL động) để luôn phân giải
--      tên bảng tại thời điểm chạy, không phụ thuộc plan cache sau khi đổi tên.
--    - SET statement_timeout trên hàm: PostgREST ≥ 12 áp dụng giá trị này cho
--      transaction của RPC (anon mặc định ~3s). Bản cũ hơn thì bỏ qua, vô hại.
-- -----------------------------------------------------------------------------

-- 7.1 upload_code_check(p_code) → boolean
CREATE OR REPLACE FUNCTION public.upload_code_check(p_code text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
BEGIN
  RETURN private.upload_code_ok(p_code);
END
$fn$;

-- 7.2 stock_begin_upload(...) → uuid
CREATE OR REPLACE FUNCTION public.stock_begin_upload(
  p_code          text,
  p_expected_rows int,
  p_uploader      text,
  p_file_name     text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_meta public.stock_meta%ROWTYPE;
  v_id   uuid := gen_random_uuid();
BEGIN
  PERFORM private.require_upload_code(p_code);

  IF p_expected_rows IS NULL OR p_expected_rows <= 0 THEN
    RAISE EXCEPTION 'empty_upload';
  END IF;

  PERFORM set_config('lock_timeout', '5s', true);

  SELECT * INTO v_meta FROM public.stock_meta WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.stock_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    SELECT * INTO v_meta FROM public.stock_meta WHERE id = 1 FOR UPDATE;
  END IF;

  IF v_meta.status = 'uploading'
     AND v_meta.upload_started_at > now() - interval '30 min' THEN
    RAISE EXCEPTION 'upload_in_progress'
      USING DETAIL = format('uploader=%s started_at=%s',
                            coalesce(v_meta.uploader, ''), v_meta.upload_started_at);
  END IF;

  EXECUTE 'TRUNCATE public.stock_by_branch_staging';

  UPDATE public.stock_meta
     SET status            = 'uploading',
         upload_id         = v_id,
         upload_started_at = now(),
         uploader          = left(btrim(coalesce(p_uploader, '')), 200),
         upload_file_name  = left(coalesce(p_file_name, ''), 500)
   WHERE id = 1;

  RETURN v_id;
END
$fn$;

-- 7.3 stock_upload_chunk(...) → int (số dòng đã ghi). Idempotent theo (upload_id, seq).
CREATE OR REPLACE FUNCTION public.stock_upload_chunk(
  p_code      text,
  p_upload_id uuid,
  p_seq       int,
  p_rows      jsonb
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_meta public.stock_meta%ROWTYPE;
  v_n    int;
BEGIN
  PERFORM private.require_upload_code(p_code);

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'empty_upload';
  END IF;

  -- FOR SHARE: chặn commit/abort/begin chen giữa lúc đang ghi chunk.
  SELECT * INTO v_meta FROM public.stock_meta WHERE id = 1 FOR SHARE;
  IF NOT FOUND
     OR v_meta.status <> 'uploading'
     OR v_meta.upload_id IS DISTINCT FROM p_upload_id
     OR p_upload_id IS NULL
     OR p_seq IS NULL THEN
    RAISE EXCEPTION 'upload_mismatch';
  END IF;

  -- Khoá theo (upload_id, seq): lần retry phải chờ lần gửi trước (có thể vẫn đang chạy
  -- trên server dù client đã mất kết nối) commit xong, rồi mới xoá-và-ghi lại → không trùng dòng.
  PERFORM pg_advisory_xact_lock(hashtext(p_upload_id::text), p_seq);

  EXECUTE 'DELETE FROM public.stock_by_branch_staging WHERE upload_id = $1 AND seq = $2'
    USING p_upload_id, p_seq;

  EXECUTE $q$
    INSERT INTO public.stock_by_branch_staging
      (ma_hang, ten_hang, chi_nhanh, tinh_thanh, ma_kho, dvt, cuoi_ky, upload_id, seq)
    SELECT upper(btrim(coalesce(e.j->>'ma_hang', ''))),
           coalesce(e.j->>'ten_hang', ''),
           coalesce(e.j->>'chi_nhanh', ''),
           coalesce(e.j->>'tinh_thanh', ''),
           coalesce(e.j->>'ma_kho', ''),
           coalesce(e.j->>'dvt', ''),
           coalesce(nullif(btrim(e.j->>'cuoi_ky'), '')::numeric, 0),
           $1,
           $2
    FROM jsonb_array_elements($3) AS e(j)
  $q$
  USING p_upload_id, p_seq, p_rows;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- 7.4 stock_commit_upload(...) → jsonb (dòng stock_meta mới)
CREATE OR REPLACE FUNCTION public.stock_commit_upload(
  p_code          text,
  p_upload_id     uuid,
  p_expected_rows int,
  p_qty_sum       numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_meta  public.stock_meta%ROWTYPE;
  v_total bigint;
  v_match bigint;
  v_sum   numeric;
BEGIN
  PERFORM private.require_upload_code(p_code);

  PERFORM set_config('lock_timeout', '2s', true);   -- = SET LOCAL lock_timeout = '2s'

  SELECT * INTO v_meta FROM public.stock_meta WHERE id = 1 FOR UPDATE;
  IF NOT FOUND
     OR v_meta.status <> 'uploading'
     OR p_upload_id IS NULL
     OR v_meta.upload_id IS DISTINCT FROM p_upload_id THEN
    RAISE EXCEPTION 'upload_mismatch';
  END IF;

  IF p_expected_rows IS NULL OR p_expected_rows <= 0 THEN
    RAISE EXCEPTION 'empty_upload';
  END IF;

  -- Một lần quét staging: tổng số dòng, số dòng thuộc lượt này, tổng tồn.
  EXECUTE $q$
    SELECT count(*),
           count(*) FILTER (WHERE upload_id = $1),
           coalesce(sum(cuoi_ky), 0)
    FROM public.stock_by_branch_staging
  $q$
  INTO v_total, v_match, v_sum
  USING p_upload_id;

  IF v_total = 0 THEN
    RAISE EXCEPTION 'empty_upload';
  END IF;
  IF v_total <> p_expected_rows OR v_match <> p_expected_rows THEN
    RAISE EXCEPTION 'row_count_mismatch'
      USING DETAIL = format('staging=%s matched=%s expected=%s',
                            v_total, v_match, p_expected_rows);
  END IF;
  -- p_qty_sum của client chỉ để tham khảo; meta lưu tổng do server tính.
  IF p_qty_sum IS NOT NULL AND abs(p_qty_sum - v_sum) > 0.01 THEN
    RAISE NOTICE 'qty_sum lệch: client=% server=%', p_qty_sum, v_sum;
  END IF;

  -- Đổi tên nguyên tử (O(1)); lock_timeout 2s nếu có truy vấn đọc dài đang giữ bảng.
  EXECUTE 'ALTER TABLE public.stock_by_branch RENAME TO stock_by_branch_old_tmp';
  EXECUTE 'ALTER TABLE public.stock_by_branch_staging RENAME TO stock_by_branch';
  EXECUTE 'ALTER TABLE public.stock_by_branch_old_tmp RENAME TO stock_by_branch_staging';
  EXECUTE 'TRUNCATE public.stock_by_branch_staging';

  UPDATE public.stock_meta
     SET version           = gen_random_uuid(),
         status            = 'ready',
         row_count         = v_total,
         qty_sum           = v_sum,
         published_at      = now(),
         upload_id         = NULL,
         file_name         = coalesce(nullif(upload_file_name, ''), file_name),
         upload_file_name  = NULL
   WHERE id = 1
  RETURNING * INTO v_meta;

  NOTIFY pgrst, 'reload schema';

  RETURN to_jsonb(v_meta);
END
$fn$;

-- 7.5 stock_abort_upload(...) → void
CREATE OR REPLACE FUNCTION public.stock_abort_upload(
  p_code      text,
  p_upload_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '60s'
AS $fn$
BEGIN
  PERFORM private.require_upload_code(p_code);

  IF p_upload_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('lock_timeout', '5s', true);

  PERFORM 1 FROM public.stock_meta
   WHERE id = 1 AND upload_id = p_upload_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;   -- không khớp (đã commit/abort/bị thay thế): không làm gì
  END IF;

  EXECUTE 'TRUNCATE public.stock_by_branch_staging';

  UPDATE public.stock_meta
     SET status           = 'ready',
         upload_id        = NULL,
         upload_file_name = NULL
   WHERE id = 1;
END
$fn$;

-- 7.6 inventory_replace(p_code, p_rows) → int
CREATE OR REPLACE FUNCTION public.inventory_replace(p_code text, p_rows jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_n int;
BEGIN
  PERFORM private.require_upload_code(p_code);

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'empty_upload';
  END IF;

  PERFORM set_config('lock_timeout', '5s', true);
  -- EXCLUSIVE: người đọc vẫn đọc bản cũ tới khi commit; chặn 2 lượt replace song song.
  LOCK TABLE public.inventory IN EXCLUSIVE MODE;

  DELETE FROM public.inventory;

  INSERT INTO public.inventory (
    sku, name, barcode, description, active_ingredient, base_unit, vat,
    manufacturer, country, category, product_type, price, buy_price, unit,
    buy_unit, registration_no, importer, brand_name, brand_code, status, updated_at
  )
  SELECT DISTINCT ON (btrim(e.j->>'sku'))
         btrim(e.j->>'sku'),
         coalesce(e.j->>'name', ''),
         coalesce(e.j->>'barcode', ''),
         coalesce(e.j->>'description', ''),
         coalesce(e.j->>'active_ingredient', ''),
         coalesce(e.j->>'base_unit', ''),
         coalesce(nullif(btrim(e.j->>'vat'), '')::numeric, 0),
         coalesce(e.j->>'manufacturer', ''),
         coalesce(e.j->>'country', ''),
         coalesce(e.j->>'category', ''),
         coalesce(e.j->>'product_type', ''),
         coalesce(nullif(btrim(e.j->>'price'), '')::numeric, 0),
         coalesce(nullif(btrim(e.j->>'buy_price'), '')::numeric, 0),
         coalesce(nullif(btrim(e.j->>'unit'), ''), 'Sp'),
         coalesce(e.j->>'buy_unit', ''),
         coalesce(e.j->>'registration_no', ''),
         coalesce(e.j->>'importer', ''),
         coalesce(e.j->>'brand_name', ''),
         coalesce(e.j->>'brand_code', ''),
         coalesce(e.j->>'status', ''),
         now()
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(j, ord)
  WHERE coalesce(btrim(e.j->>'sku'), '') <> ''
  ORDER BY btrim(e.j->>'sku'), e.ord DESC          -- trùng sku: giữ dòng cuối
  ON CONFLICT (sku) DO UPDATE SET
    name              = EXCLUDED.name,
    barcode           = EXCLUDED.barcode,
    description       = EXCLUDED.description,
    active_ingredient = EXCLUDED.active_ingredient,
    base_unit         = EXCLUDED.base_unit,
    vat               = EXCLUDED.vat,
    manufacturer      = EXCLUDED.manufacturer,
    country           = EXCLUDED.country,
    category          = EXCLUDED.category,
    product_type      = EXCLUDED.product_type,
    price             = EXCLUDED.price,
    buy_price         = EXCLUDED.buy_price,
    unit              = EXCLUDED.unit,
    buy_unit          = EXCLUDED.buy_unit,
    registration_no   = EXCLUDED.registration_no,
    importer          = EXCLUDED.importer,
    brand_name        = EXCLUDED.brand_name,
    brand_code        = EXCLUDED.brand_code,
    status            = EXCLUDED.status,
    updated_at        = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'empty_upload';   -- rollback cả DELETE
  END IF;
  RETURN v_n;
END
$fn$;

-- 7.7 branches_upsert(p_code, p_rows) → int
--     Không dùng ON CONFLICT để chạy được cả khi bảng branches có sẵn mà
--     không có unique trên chi_nhanh: cập nhật dòng đã có, chèn dòng mới.
CREATE OR REPLACE FUNCTION public.branches_upsert(p_code text, p_rows jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_n int;
BEGIN
  PERFORM private.require_upload_code(p_code);

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'empty_upload';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.branches IN SHARE ROW EXCLUSIVE MODE;

  WITH src AS (
    SELECT DISTINCT ON (btrim(e.j->>'chi_nhanh'))
           btrim(e.j->>'chi_nhanh')                    AS chi_nhanh,
           btrim(coalesce(e.j->>'tinh_thanh', ''))     AS tinh_thanh
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(j, ord)
    WHERE coalesce(btrim(e.j->>'chi_nhanh'), '') <> ''
    ORDER BY btrim(e.j->>'chi_nhanh'), e.ord DESC
  ),
  upd AS (
    UPDATE public.branches b
       SET tinh_thanh = s.tinh_thanh
      FROM src s
     WHERE b.chi_nhanh = s.chi_nhanh
    RETURNING b.chi_nhanh
  ),
  ins AS (
    INSERT INTO public.branches (chi_nhanh, tinh_thanh)
    SELECT s.chi_nhanh, s.tinh_thanh
    FROM src s
    WHERE NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.chi_nhanh = s.chi_nhanh)
    RETURNING 1
  )
  SELECT (SELECT count(DISTINCT chi_nhanh) FROM upd) + (SELECT count(*) FROM ins)
    INTO v_n;

  RETURN v_n;
END
$fn$;

-- Owner + quyền thực thi
ALTER FUNCTION public.upload_code_check(text)                         OWNER TO postgres;
ALTER FUNCTION public.stock_begin_upload(text, int, text, text)       OWNER TO postgres;
ALTER FUNCTION public.stock_upload_chunk(text, uuid, int, jsonb)      OWNER TO postgres;
ALTER FUNCTION public.stock_commit_upload(text, uuid, int, numeric)   OWNER TO postgres;
ALTER FUNCTION public.stock_abort_upload(text, uuid)                  OWNER TO postgres;
ALTER FUNCTION public.inventory_replace(text, jsonb)                  OWNER TO postgres;
ALTER FUNCTION public.branches_upsert(text, jsonb)                    OWNER TO postgres;
ALTER FUNCTION private.upload_code_ok(text)                           OWNER TO postgres;
ALTER FUNCTION private.require_upload_code(text)                      OWNER TO postgres;

REVOKE EXECUTE ON FUNCTION public.upload_code_check(text)                       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stock_begin_upload(text, int, text, text)     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stock_upload_chunk(text, uuid, int, jsonb)    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stock_commit_upload(text, uuid, int, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stock_abort_upload(text, uuid)                FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.inventory_replace(text, jsonb)                FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.branches_upsert(text, jsonb)                  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.upload_code_check(text)                       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_begin_upload(text, int, text, text)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_upload_chunk(text, uuid, int, jsonb)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_commit_upload(text, uuid, int, numeric) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_abort_upload(text, uuid)                TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inventory_replace(text, jsonb)                TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.branches_upsert(text, jsonb)                  TO anon, authenticated;

-- PostgREST nạp lại schema cache để thấy RPC/bảng mới.
NOTIFY pgrst, 'reload schema';
