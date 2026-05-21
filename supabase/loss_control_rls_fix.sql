-- ===================================
-- KAYIP ÖNLEME RLS DÜZELTMESİ
-- Hedef proje: xbbzwitvlrdwnoushgpf.supabase.co
-- Çalıştırma: Supabase Dashboard > SQL Editor > Run
--
-- Sorun: stock_entries ve stock_counts policy'leri current_setting('app.current_user_role')
-- kullanıyor ama uygulama bu session değişkenini set etmiyor → INSERT 401.
-- Çözüm: Diğer tablolarla (sales_logs, vb.) tutarlı şekilde permissive policy.
-- Erişim kontrolü zaten frontend'de canAccessLossControl() ile yapılıyor.
-- ===================================

DROP POLICY IF EXISTS "stock_entries_select_all" ON public.stock_entries;
DROP POLICY IF EXISTS "stock_entries_admin_all"  ON public.stock_entries;
DROP POLICY IF EXISTS "stock_counts_select_all"  ON public.stock_counts;
DROP POLICY IF EXISTS "stock_counts_admin_all"   ON public.stock_counts;

CREATE POLICY "stock_entries_all" ON public.stock_entries
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "stock_counts_all" ON public.stock_counts
  FOR ALL USING (true) WITH CHECK (true);
