-- =====================================================
-- SALES_LOGS: FİŞ FOTOĞRAFI EKLEME
-- - Her satış girişine receipt_url alanı (Supabase Storage URL'i)
-- - sales_receipts public bucket'ı (anonymous read için)
-- - Anon ile upload + read RLS politikaları
-- =====================================================

-- 1. receipt_url kolonu
ALTER TABLE sales_logs ADD COLUMN IF NOT EXISTS receipt_url TEXT;

-- 2. Storage bucket (publicly readable, kayıt resimleri için)
INSERT INTO storage.buckets (id, name, public)
VALUES ('sales_receipts', 'sales_receipts', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- 3. RLS — anon read & insert (uygulama anon key kullanıyor)
DROP POLICY IF EXISTS "sales_receipts_read"   ON storage.objects;
DROP POLICY IF EXISTS "sales_receipts_insert" ON storage.objects;
DROP POLICY IF EXISTS "sales_receipts_update" ON storage.objects;
DROP POLICY IF EXISTS "sales_receipts_delete" ON storage.objects;

CREATE POLICY "sales_receipts_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'sales_receipts');

CREATE POLICY "sales_receipts_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'sales_receipts');

CREATE POLICY "sales_receipts_update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'sales_receipts')
  WITH CHECK (bucket_id = 'sales_receipts');

CREATE POLICY "sales_receipts_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'sales_receipts');

-- =====================================================
-- NOT: Bu SQL'i Supabase Dashboard > SQL Editor'da çalıştırın.
-- =====================================================
