-- =============================================================================
-- sync_overhaul_phase2.sql  —  GIAI ĐOẠN 2: THU QUYỀN GHI CỦA anon
-- =============================================================================
-- !!! CẢNH BÁO — CHỈ CHẠY KHI:
--   1. sync_overhaul_phase1.sql đã chạy xong và mã upload đã được đặt;
--   2. MỌI máy/mọi tab đã dùng bản mới của cả "Tra cứu tồn kho"
--      (inventory-lookup) và "Lập báo giá" (index.html) — tức là upload tồn kho,
--      danh mục (inventory) và chi nhánh (branches) đều đi qua RPC có mã upload.
--      (Khuyến nghị: chờ 1–2 tuần sau khi deploy, nhắc mọi người tải lại trang.)
-- Sau khi chạy, bản CŨ sẽ KHÔNG upload được nữa (báo "permission denied" ngay
-- ở bước xoá, trước khi đụng tới dữ liệu) — đọc vẫn bình thường.
--
-- File idempotent: chạy lại nhiều lần không lỗi.
-- Phạm vi: stock_by_branch, stock_by_branch_staging, inventory, branches
-- (+ khẳng định lại stock_meta chỉ đọc). KHÔNG đụng orders/employees/
-- pharmacies/shipping_providers (đợt sau, cần Supabase Auth).
--
-- Hoàn tác khẩn cấp (mở lại ghi trực tiếp cho bản cũ), chạy cho từng bảng:
--   CREATE POLICY anon_all ON public.<bảng> FOR ALL TO anon USING (true) WITH CHECK (true);
--   GRANT INSERT, UPDATE, DELETE ON public.<bảng> TO anon, authenticated;
-- =============================================================================

DO $do$
DECLARE
  t   text;
  pol record;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_by_branch', 'stock_by_branch_staging', 'inventory', 'branches'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'Bỏ qua %: bảng không tồn tại', t;
      CONTINUE;
    END IF;

    -- Bật RLS, bỏ anon_all, đảm bảo anon_select.
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS anon_all ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS anon_select ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY anon_select ON public.%I FOR SELECT TO anon USING (true)', t);

    -- Thu quyền ghi ở mức GRANT (client cũ dừng ngay với "permission denied"
    -- thay vì DELETE im lặng 0 dòng rồi lỗi ở INSERT).
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);

    -- Báo các policy khác còn sót (không còn tác dụng ghi vì đã REVOKE, nhưng nên dọn).
    FOR pol IN
      SELECT p.policyname, p.cmd, p.roles
      FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = t
        AND p.policyname <> 'anon_select'
    LOOP
      RAISE NOTICE 'Bảng % còn policy "%" (cmd=%, roles=%) — kiểm tra/xoá tay nếu không cần',
        t, pol.policyname, pol.cmd, pol.roles;
    END LOOP;
  END LOOP;
END
$do$;

-- stock_meta: chỉ đọc (khẳng định lại; phase 1 đã làm).
ALTER TABLE public.stock_meta ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anon_all ON public.stock_meta;
DROP POLICY IF EXISTS anon_select ON public.stock_meta;
CREATE POLICY anon_select ON public.stock_meta FOR SELECT TO anon USING (true);
REVOKE ALL ON public.stock_meta FROM anon, authenticated;
GRANT SELECT ON public.stock_meta TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- Kiểm tra sau khi chạy (chỉ đọc):
--   SELECT tablename, policyname, cmd, roles FROM pg_policies
--    WHERE schemaname = 'public'
--      AND tablename IN ('stock_by_branch','stock_by_branch_staging','inventory','branches','stock_meta');
--   SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
--      AND table_name IN ('stock_by_branch','stock_by_branch_staging','inventory','branches','stock_meta')
--    ORDER BY 1, 2, 3;
