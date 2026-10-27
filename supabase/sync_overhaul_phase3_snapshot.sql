-- ════════════════════════════════════════════════════════════════════════════
-- Sync overhaul — giai đoạn 3: snapshot nén cho tải nhanh
-- ════════════════════════════════════════════════════════════════════════════
-- Chạy SAU phase1 + phase2. Idempotent, chỉ bổ sung.
--
-- Người upload gửi kèm 1 snapshot (JSON từ điển + gzip, base64) qua RPC
-- stock_attach_snapshot; stock_commit_upload công bố snapshot cùng phiên bản mới
-- trong cùng transaction. Máy đọc tải 1 dòng stock_snapshot (~3 MB) thay vì
-- ~460 trang PostgREST; không có snapshot (client cũ upload) → máy đọc tự quay
-- về phân trang keyset như cũ.
--
-- LƯU Ý: chạy lại phase1.sql sẽ ghi đè stock_commit_upload về bản không có
-- snapshot (vẫn chạy đúng, chỉ mất tải nhanh) → chạy lại file này sau đó.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Cột mới trên stock_meta
ALTER TABLE public.stock_meta ADD COLUMN IF NOT EXISTS content_hash    text;  -- sha256 nội dung (phát hiện upload trùng file)
ALTER TABLE public.stock_meta ADD COLUMN IF NOT EXISTS snapshot_sha256 text;  -- sha256 của file gzip; null = không có snapshot
ALTER TABLE public.stock_meta ADD COLUMN IF NOT EXISTS snapshot_bytes  int;

-- 2. Bảng snapshot: tối đa 1 bản đã công bố (version NOT NULL) + bản đang chờ của lượt upload
CREATE TABLE IF NOT EXISTS public.stock_snapshot (
  upload_id    uuid PRIMARY KEY,
  version      uuid UNIQUE,              -- gán khi commit; null = chưa công bố
  data_b64     text NOT NULL,
  sha256       text NOT NULL,
  bytes        int  NOT NULL,
  row_count    int  NOT NULL,
  qty_sum      numeric,
  content_hash text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stock_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anon_select ON public.stock_snapshot;
CREATE POLICY anon_select ON public.stock_snapshot FOR SELECT TO anon USING (version IS NOT NULL);
REVOKE ALL ON public.stock_snapshot FROM anon, authenticated;
GRANT SELECT ON public.stock_snapshot TO anon, authenticated;

-- 3. stock_attach_snapshot: gắn snapshot vào lượt upload đang chạy (gọi trước commit)
CREATE OR REPLACE FUNCTION public.stock_attach_snapshot(
  p_code         text,
  p_upload_id    uuid,
  p_data_b64     text,
  p_sha256       text,
  p_row_count    int,
  p_qty_sum      numeric,
  p_content_hash text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '60s'
AS $fn$
DECLARE
  v_meta  public.stock_meta%ROWTYPE;
  v_bytes bytea;
BEGIN
  PERFORM private.require_upload_code(p_code);

  SELECT * INTO v_meta FROM public.stock_meta WHERE id = 1 FOR SHARE;
  IF NOT FOUND OR v_meta.status <> 'uploading' OR p_upload_id IS NULL
     OR v_meta.upload_id IS DISTINCT FROM p_upload_id THEN
    RAISE EXCEPTION 'upload_mismatch';
  END IF;

  IF p_data_b64 IS NULL OR length(p_data_b64) = 0 OR length(p_data_b64) > 40000000
     OR p_row_count IS NULL OR p_row_count <= 0 THEN
    RAISE EXCEPTION 'snapshot_invalid';
  END IF;

  -- Server tự kiểm toàn vẹn: sha256 khai báo phải khớp nội dung nhận được
  v_bytes := decode(p_data_b64, 'base64');
  IF encode(sha256(v_bytes), 'hex') IS DISTINCT FROM lower(p_sha256) THEN
    RAISE EXCEPTION 'snapshot_invalid' USING DETAIL = 'sha256 không khớp';
  END IF;

  INSERT INTO public.stock_snapshot (upload_id, version, data_b64, sha256, bytes, row_count, qty_sum, content_hash)
  VALUES (p_upload_id, NULL, p_data_b64, lower(p_sha256), octet_length(v_bytes), p_row_count, p_qty_sum, p_content_hash)
  ON CONFLICT (upload_id) DO UPDATE
    SET data_b64 = EXCLUDED.data_b64, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes,
        row_count = EXCLUDED.row_count, qty_sum = EXCLUDED.qty_sum,
        content_hash = EXCLUDED.content_hash, created_at = now(), version = NULL;
END
$fn$;

-- 4. stock_commit_upload: như phase1 + công bố snapshot của đúng lượt upload này
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
  v_snap  public.stock_snapshot%ROWTYPE;
  v_total bigint;
  v_match bigint;
  v_sum   numeric;
BEGIN
  PERFORM private.require_upload_code(p_code);

  PERFORM set_config('lock_timeout', '2s', true);

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
  IF p_qty_sum IS NOT NULL AND abs(p_qty_sum - v_sum) > 0.01 THEN
    RAISE NOTICE 'qty_sum lệch: client=% server=%', p_qty_sum, v_sum;
  END IF;

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

  -- Snapshot: chỉ công bố khi khớp số dòng và tổng tồn server vừa tính; bỏ mọi bản khác
  DELETE FROM public.stock_snapshot WHERE upload_id IS DISTINCT FROM p_upload_id;
  SELECT * INTO v_snap FROM public.stock_snapshot WHERE upload_id = p_upload_id;
  IF FOUND AND v_snap.row_count = v_total
     AND (v_snap.qty_sum IS NULL OR abs(v_snap.qty_sum - v_sum) <= 0.01) THEN
    UPDATE public.stock_snapshot SET version = v_meta.version WHERE upload_id = p_upload_id;
    UPDATE public.stock_meta
       SET snapshot_sha256 = v_snap.sha256, snapshot_bytes = v_snap.bytes, content_hash = v_snap.content_hash
     WHERE id = 1
    RETURNING * INTO v_meta;
  ELSE
    DELETE FROM public.stock_snapshot WHERE upload_id = p_upload_id;
    UPDATE public.stock_meta
       SET snapshot_sha256 = NULL, snapshot_bytes = NULL, content_hash = NULL
     WHERE id = 1
    RETURNING * INTO v_meta;
  END IF;

  NOTIFY pgrst, 'reload schema';

  RETURN to_jsonb(v_meta);
END
$fn$;

-- 5. Quyền
ALTER FUNCTION public.stock_attach_snapshot(text, uuid, text, text, int, numeric, text) OWNER TO postgres;
ALTER FUNCTION public.stock_commit_upload(text, uuid, int, numeric)                     OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.stock_attach_snapshot(text, uuid, text, text, int, numeric, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.stock_attach_snapshot(text, uuid, text, text, int, numeric, text) TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stock_commit_upload(text, uuid, int, numeric) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.stock_commit_upload(text, uuid, int, numeric) TO anon, authenticated;

-- Kiểm tra:
--   SELECT snapshot_sha256, snapshot_bytes, content_hash FROM stock_meta;   -- sau lần upload kế tiếp phải có giá trị
--   SELECT upload_id, version, bytes, row_count FROM stock_snapshot;
