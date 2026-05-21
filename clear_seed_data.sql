-- =====================================================================
-- TÜM TABLOLARI BOŞALT (tek seferlik reset)
-- Hedef proje: wgfkoxjlcovrkzrustpy.supabase.co
-- Kullanım: Supabase Dashboard > SQL Editor > New Query > Yapıştır > Run
--
-- Yaptığı: public şemasındaki TÜM tablolardaki TÜM satırları siler
-- (apply_to_new_db.sql'in seed verisi dahil: admin_1, 29 personel,
--  5 branch_locations, company_logo app_settings, vs.).
-- Tablo yapısı, RLS, RPC, trigger, index AYNEN kalır — sadece veri gider.
--
-- ⚠ UYARI: GERİ ALINAMAZ. Sadece yeni/boş kurulan projede çalıştır.
--         Canlı projede ASLA.
-- =====================================================================

DO $$
DECLARE
  r RECORD;
  v_count INT := 0;
BEGIN
  FOR r IN
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename
  LOOP
    EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', r.tablename);
    v_count := v_count + 1;
    RAISE NOTICE 'Boşaltıldı: public.%', r.tablename;
  END LOOP;
  RAISE NOTICE '----';
  RAISE NOTICE 'Toplam % tablo temizlendi.', v_count;
END $$;

-- Doğrulama: her tabloda kaç satır var? (hepsinin 0 olması beklenir)
SELECT schemaname, tablename,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT COUNT(*) AS c FROM public.%I', tablename),
                           true, true, '')))[1]::text::int AS row_count
  FROM pg_tables
 WHERE schemaname = 'public'
 ORDER BY tablename;
