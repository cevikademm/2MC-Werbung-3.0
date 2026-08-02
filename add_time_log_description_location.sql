-- =====================================================================
-- time_logs: açıklama (description) + konum (location) kolonları
-- Hedef: iqsnemkupgfdzpvmzkiu.supabase.co  (2MCWERBUNG 3.0)
-- Durum: 2026-08-02 itibarıyla UYGULANDI — description + location kolonları
--        canlı veritabanında mevcut. Dosya kayıt amaçlı duruyor.
--
-- Neden: Manuel saat ekleme ve QR saat ekleme alanlarına "açıklama" ve
-- "konum" bilgisi zorunlu hale getirildi. Frontend bu kolonlara yazıyor.
--   - Manuel: description = serbest metin, location = serbest metin/adres
--   - QR:     description = personelin girdiği açıklama,
--             location    = "GPS: <lat>, <lng>" (otomatik)
-- =====================================================================

ALTER TABLE public.time_logs
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS location    text;

-- PostgREST şema önbelleğini yenile (yeni kolonlar API'de görünsün)
NOTIFY pgrst, 'reload schema';

-- Doğrulama
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'time_logs'
   AND column_name IN ('description', 'location')
 ORDER BY column_name;
