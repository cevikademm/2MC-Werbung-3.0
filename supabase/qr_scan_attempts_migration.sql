-- ============================================================
-- QR SCAN ATTEMPTS — Migration
-- ============================================================
-- Her QR mesai denemesini (başarılı / başarısız) loglar.
-- Cihaz Markaları sekmesindeki "Okutmayanlar" ve "Hatalar"
-- görünümleri bu tabloyu kullanır.
--
-- time_logs sadece BAŞARILI check-in/out'u tutar; bu tablo ek
-- olarak başarısız denemeleri de tutar ki "kim hata aldı, neden"
-- görülebilsin.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.qr_scan_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    TEXT REFERENCES public.profiles(id) ON DELETE CASCADE,
  employee_name  TEXT,            -- snapshot — profil silinse de raporlanabilsin
  status         TEXT NOT NULL,   -- 'success' | 'error'
  error_kind     TEXT,            -- camera_denied | no_camera | insecure_context | network
                                  -- | invalid_qr | already_checked_in | not_checked_in | other
  error_detail   TEXT,
  action         TEXT,            -- 'in' | 'out' (denemenin niyeti)
  branch         TEXT,
  device_info    TEXT,            -- "Apple iPhone · 62:4A:..." veya null
  user_agent     TEXT,
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qr_scan_attempts_status_check CHECK (status IN ('success','error'))
);

CREATE INDEX IF NOT EXISTS idx_qr_scan_attempts_attempted_desc
  ON public.qr_scan_attempts (attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_qr_scan_attempts_employee_attempted
  ON public.qr_scan_attempts (employee_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_qr_scan_attempts_status_attempted
  ON public.qr_scan_attempts (status, attempted_at DESC);

-- RLS: client kendi denemelerini INSERT edebilir, sadece adminler SELECT.
-- Mevcut projedeki diğer tablolar gibi permissive policy + UI tarafında
-- email whitelist (canSeeDeviceInfo) ile filtre uyguluyoruz.
ALTER TABLE public.qr_scan_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "qr_scan_attempts_anon_all" ON public.qr_scan_attempts;
CREATE POLICY "qr_scan_attempts_anon_all" ON public.qr_scan_attempts
  FOR ALL USING (true) WITH CHECK (true);

-- Realtime: yeni hata anında Cihaz Markaları > Hatalar sekmesine düşsün
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.qr_scan_attempts;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ============================================================
-- 90 GÜNDEN ESKİ KAYITLARI TEMİZLE
-- ============================================================
CREATE OR REPLACE FUNCTION public.cleanup_old_qr_attempts()
RETURNS INTEGER AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.qr_scan_attempts
   WHERE attempted_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-old-qr-attempts');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'cleanup-old-qr-attempts',
  '15 3 * * *',  -- her gün UTC 03:15
  $$ SELECT public.cleanup_old_qr_attempts(); $$
);
