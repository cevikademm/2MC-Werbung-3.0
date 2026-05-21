-- =====================================================
-- SALES_LOGS: MESAİ DIŞI SATIŞ TAKİBİ
-- Satış girişi anında kullanıcı vardiyada değilse
-- (evdeyse) bu kayıt is_off_shift = true ile işaretlenir.
-- Frontend hem girişi engeller hem de yöneticilerin
-- (cevikademm@gmail.com, gurcan@bac.de) tabloda
-- "MESAİ DIŞI" rozeti görmesini sağlar.
-- =====================================================

ALTER TABLE sales_logs
  ADD COLUMN IF NOT EXISTS is_off_shift BOOLEAN NOT NULL DEFAULT FALSE;

-- Yönetici panelinde mesai-dışı kayıtları hızlı filtrelemek için index.
CREATE INDEX IF NOT EXISTS idx_sales_logs_off_shift
  ON sales_logs(is_off_shift)
  WHERE is_off_shift = TRUE;

-- =====================================================
-- NOT: Bu SQL'i Supabase Dashboard > SQL Editor'da çalıştırın.
-- =====================================================
