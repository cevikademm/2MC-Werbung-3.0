-- ===================================================================
-- KAYIP ÖNLEME — ADMIN-ONLY ERİŞİM (Supabase Migration)
-- Hedef proje: xbbzwitvlrdwnoushgpf.supabase.co
-- Çalıştırma: Supabase Dashboard > SQL Editor > Run
--
-- Amaç: stock_entries ve stock_counts tablolarına yalnızca
--       admin personel + LOSS_CONTROL_ALLOWED_EMAILS hesapları erişebilir.
--       Doğrudan REST erişimi RLS ile kapatılır; tüm okuma/yazma işlemleri
--       SECURITY DEFINER RPC fonksiyonları üzerinden yapılır ve her çağrıda
--       caller_id'nin yetkili olup olmadığı kontrol edilir.
--
-- Not: profiles.id şeması TEXT olduğu için tüm caller_id parametreleri TEXT.
-- Frontend (LossControl.tsx) bu RPC'leri kullanmak üzere güncellendi.
-- ===================================================================

-- 1) Yetki kontrol fonksiyonu ----------------------------------------
-- Bir kullanıcının kayıp önleme verilerine erişimi olup olmadığını döndürür.
CREATE OR REPLACE FUNCTION public.lc_is_authorized(p_caller_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = p_caller_id
       AND (
         role = 'Admin'
         OR LOWER(TRIM(email)) IN ('cevikademm@gmail.com', 'gurcan@bac.de')
       )
  );
$$;

COMMENT ON FUNCTION public.lc_is_authorized(TEXT) IS
  'Kayıp Önleme verilerine erişim hakkı (Admin rolü VEYA allowlist email).';

-- 2) Liste RPC'leri --------------------------------------------------

CREATE OR REPLACE FUNCTION public.lc_list_stock_entries(p_caller_id TEXT)
RETURNS SETOF public.stock_entries
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim: Kayıp Önleme verilerine yalnızca yetkili admin hesapları erişebilir.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT *
    FROM public.stock_entries
    ORDER BY entry_date DESC, created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.lc_list_stock_counts(p_caller_id TEXT)
RETURNS SETOF public.stock_counts
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim: Kayıp Önleme verilerine yalnızca yetkili admin hesapları erişebilir.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT *
    FROM public.stock_counts
    ORDER BY count_date DESC, created_at DESC;
END;
$$;

-- 3) Yazma RPC'leri --------------------------------------------------
-- p_id = NULL → INSERT, p_id dolu → UPDATE.

CREATE OR REPLACE FUNCTION public.lc_save_stock_entry(
  p_caller_id    TEXT,
  p_id           UUID,
  p_product_name TEXT,
  p_branch       TEXT,
  p_quantity     INT,
  p_entry_date   DATE,
  p_note         TEXT
) RETURNS public.stock_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.stock_entries;
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim.' USING ERRCODE = 'P0001';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.stock_entries (product_name, branch, quantity, entry_date, entered_by, note)
    VALUES (p_product_name, p_branch, p_quantity, p_entry_date, p_caller_id, p_note)
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.stock_entries
       SET product_name = p_product_name,
           branch       = p_branch,
           quantity     = p_quantity,
           entry_date   = p_entry_date,
           note         = p_note
     WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.lc_save_stock_count(
  p_caller_id        TEXT,
  p_id               UUID,
  p_product_name     TEXT,
  p_branch           TEXT,
  p_counted_quantity INT,
  p_count_date       DATE,
  p_note             TEXT
) RETURNS public.stock_counts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.stock_counts;
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim.' USING ERRCODE = 'P0001';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.stock_counts (product_name, branch, counted_quantity, count_date, counted_by, note)
    VALUES (p_product_name, p_branch, p_counted_quantity, p_count_date, p_caller_id, p_note)
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.stock_counts
       SET product_name     = p_product_name,
           branch           = p_branch,
           counted_quantity = p_counted_quantity,
           count_date       = p_count_date,
           note             = p_note
     WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.lc_delete_stock_entry(p_caller_id TEXT, p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.stock_entries WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.lc_delete_stock_count(p_caller_id TEXT, p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.stock_counts WHERE id = p_id;
END;
$$;

-- 4) RLS sıkılaştırma — doğrudan REST erişimi kapatılır --------------
ALTER TABLE public.stock_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_counts  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_entries_all"        ON public.stock_entries;
DROP POLICY IF EXISTS "stock_entries_select_all" ON public.stock_entries;
DROP POLICY IF EXISTS "stock_entries_admin_all"  ON public.stock_entries;
DROP POLICY IF EXISTS "stock_entries_no_direct"  ON public.stock_entries;

DROP POLICY IF EXISTS "stock_counts_all"         ON public.stock_counts;
DROP POLICY IF EXISTS "stock_counts_select_all"  ON public.stock_counts;
DROP POLICY IF EXISTS "stock_counts_admin_all"   ON public.stock_counts;
DROP POLICY IF EXISTS "stock_counts_no_direct"   ON public.stock_counts;

-- Doğrudan REST sorgusu yapılırsa hiçbir satır dönmez, yazılamaz.
-- SECURITY DEFINER RPC'ler bu RLS'i bypass eder (definer = postgres role).
CREATE POLICY "stock_entries_no_direct" ON public.stock_entries
  FOR ALL USING (false) WITH CHECK (false);

CREATE POLICY "stock_counts_no_direct" ON public.stock_counts
  FOR ALL USING (false) WITH CHECK (false);

-- 5) RPC çalıştırma izinleri -----------------------------------------
GRANT EXECUTE ON FUNCTION public.lc_is_authorized(TEXT)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_list_stock_entries(TEXT)   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_list_stock_counts(TEXT)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_save_stock_entry(TEXT, UUID, TEXT, TEXT, INT, DATE, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_save_stock_count(TEXT, UUID, TEXT, TEXT, INT, DATE, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_delete_stock_entry(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_delete_stock_count(TEXT, UUID) TO anon, authenticated;

-- 6) Realtime publication güncelle (tablolar zaten ekliydi, idempotent)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_entries;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_counts;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
