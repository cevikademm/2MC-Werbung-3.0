-- ============================================================
-- BİLDİRİM TERCİHLERİ — Migration
-- ============================================================
-- profiles tablosuna notification_prefs JSONB kolonu ekler.
-- Kullanıcı (admin) bu kolondan hangi tip bildirimleri almak istediğini seçer.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB
  NOT NULL DEFAULT '{
    "off_shift_sale": true,
    "weekly_sales_anomaly": true,
    "off_shift_qr": true,
    "non_kiosk_check": true
  }'::jsonb;

-- Mevcut kullanıcılar için default doldur (NULL kalmasın)
UPDATE public.profiles
   SET notification_prefs = '{
     "off_shift_sale": true,
     "weekly_sales_anomaly": true,
     "off_shift_qr": true,
     "non_kiosk_check": true
   }'::jsonb
 WHERE notification_prefs IS NULL OR notification_prefs = '{}'::jsonb;

-- ============================================================
-- "Personel o anda vardiyada mı?" yardımcı fonksiyonu
-- ============================================================
-- shift_schedules.days[i] elemanı boş ('') değilse o gün vardiyası vardır
-- (proje konvansiyonu — Personel adı yazılı olunca shift atanmış sayılır)
-- 0 = Pazartesi ... 6 = Pazar
-- ============================================================
CREATE OR REPLACE FUNCTION public.has_shift_today(
  p_employee_name TEXT,
  p_branch        TEXT,
  p_at            TIMESTAMPTZ DEFAULT NOW()
) RETURNS BOOLEAN AS $$
DECLARE
  v_local      TIMESTAMPTZ := p_at AT TIME ZONE 'Europe/Berlin';
  v_dow        INTEGER;     -- 0=Pazartesi, 6=Pazar
  v_week_start DATE;
  v_count      INTEGER;
BEGIN
  -- Postgres EXTRACT(dow): 0=Pazar, 6=Cumartesi → bizim modelimize çevir
  v_dow := (EXTRACT(ISODOW FROM v_local)::int - 1);  -- 0..6 (Pzt..Paz)
  v_week_start := (v_local::date - v_dow);

  SELECT COUNT(*) INTO v_count
    FROM public.shift_schedules s
   WHERE s.branch = p_branch
     AND s.week_start_date = v_week_start::text
     AND COALESCE(s.days[v_dow + 1], '') ILIKE '%' || p_employee_name || '%';

  RETURN v_count > 0;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION public.has_shift_today(TEXT, TEXT, TIMESTAMPTZ) TO anon, authenticated;
