-- ===================================================================
-- VARDİYA ONAY/YAYINLAMA SİSTEMİ — Supabase Migration
-- Çalıştırma: Supabase Dashboard > SQL Editor > Run
--
-- Amaç: Admin haftalık vardiyayı hazırlar; "Yayınla" butonuna basana
--       kadar personel listesinde görünmez. Bu tablo (week_start_date,
--       branch) çiftine bağlı tek satır onay kaydı tutar.
--
-- Kayıt yoksa → vardiya taslak, personellere gizli.
-- Kayıt varsa → yayında, tüm personeller görebilir.
-- Admin kaydı silerek yayını geri çekebilir.
-- ===================================================================

CREATE TABLE IF NOT EXISTS public.shift_publications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start_date  date        NOT NULL,
  branch           text        NOT NULL,
  published_at     timestamptz NOT NULL DEFAULT NOW(),
  -- profiles.id TEXT olduğu için published_by da TEXT (mevcut şema ile uyumlu)
  published_by     text,
  published_by_name text,
  CONSTRAINT shift_publications_week_branch_unique UNIQUE (week_start_date, branch)
);

CREATE INDEX IF NOT EXISTS idx_shift_publications_lookup
  ON public.shift_publications (week_start_date, branch);

-- RLS aç
ALTER TABLE public.shift_publications ENABLE ROW LEVEL SECURITY;

-- Mevcut policy'leri temizle (idempotent migration)
DROP POLICY IF EXISTS "shift_publications_read_all"   ON public.shift_publications;
DROP POLICY IF EXISTS "shift_publications_write_open" ON public.shift_publications;

-- Herkes okuyabilir — personel onay durumunu görmesi için
CREATE POLICY "shift_publications_read_all"
  ON public.shift_publications FOR SELECT
  USING (true);

-- Yazma açık — uygulama tarafında isAdmin kontrolü zaten yapılıyor.
-- (Mevcut shift_schedules tablosuyla aynı pattern.)
CREATE POLICY "shift_publications_write_open"
  ON public.shift_publications FOR ALL
  USING (true)
  WITH CHECK (true);

-- PostgREST schema cache'ini hemen yenile — uygulama bekleyip schema reload
-- olmadan tablo bulunamadı hatası almasın.
NOTIFY pgrst, 'reload schema';

-- Realtime publication: yayın değişiklikleri tüm bağlı cihazlara anında
-- yansısın. supabase_realtime publication zaten Supabase'de hazır gelir;
-- buraya tabloyu eklemezsek INSERT/DELETE event'leri yayılmaz.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.shift_publications;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
    BEGIN
      -- shift_schedules da realtime'a eklensin: admin satır eklediğinde/sildiğinde
      -- diğer admin ve personel cihazlarında canlı yansısın.
      ALTER PUBLICATION supabase_realtime ADD TABLE public.shift_schedules;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;
END$$;
