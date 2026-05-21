-- ===================================
-- KAYIP ÖNLEME SİSTEMİ - Supabase Migration
-- Hedef proje: xbbzwitvlrdwnoushgpf.supabase.co
-- Çalıştırma: Supabase Dashboard > SQL Editor > Run
-- ===================================

-- 1. STOK GİRİŞLERİ TABLOSU
CREATE TABLE IF NOT EXISTS public.stock_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  entered_by TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. FİZİKSEL SAYIM TABLOSU
CREATE TABLE IF NOT EXISTS public.stock_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  counted_quantity INTEGER NOT NULL CHECK (counted_quantity >= 0),
  count_date DATE NOT NULL DEFAULT CURRENT_DATE,
  counted_by TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. INDEX'LER
CREATE INDEX IF NOT EXISTS idx_stock_entries_branch ON public.stock_entries(branch);
CREATE INDEX IF NOT EXISTS idx_stock_entries_date   ON public.stock_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_stock_entries_product ON public.stock_entries(product_name);
CREATE INDEX IF NOT EXISTS idx_stock_counts_branch  ON public.stock_counts(branch);
CREATE INDEX IF NOT EXISTS idx_stock_counts_date    ON public.stock_counts(count_date);
CREATE INDEX IF NOT EXISTS idx_stock_counts_product ON public.stock_counts(product_name);

-- 4. RLS — projedeki diğer tablolarla aynı pattern (current_setting('app.current_user_role'))
ALTER TABLE public.stock_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_counts  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_entries_select_all" ON public.stock_entries;
DROP POLICY IF EXISTS "stock_entries_admin_all"  ON public.stock_entries;
DROP POLICY IF EXISTS "stock_counts_select_all"  ON public.stock_counts;
DROP POLICY IF EXISTS "stock_counts_admin_all"   ON public.stock_counts;

CREATE POLICY "stock_entries_select_all" ON public.stock_entries FOR SELECT USING (true);
CREATE POLICY "stock_entries_admin_all"  ON public.stock_entries FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

CREATE POLICY "stock_counts_select_all"  ON public.stock_counts FOR SELECT USING (true);
CREATE POLICY "stock_counts_admin_all"   ON public.stock_counts FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- 5. Realtime publication (diğer tablolarla tutarlı)
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_entries; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_counts;  EXCEPTION WHEN OTHERS THEN NULL; END $$;
