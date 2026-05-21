-- =============================================================
-- location_history_migration.sql
-- =============================================================
-- Personel hareket geçmişi (path/breadcrumb) için kalıcı
-- konum log'u. live_locations sadece son konumu tutar (UPSERT),
-- bu tablo append-only — Tuğrul gibi vardiyada çalışan kişinin
-- nereden nereye gittiğini Polyline olarak çizebilelim.
--
-- Throttle: live_location_upsert RPC, history'ye sadece
--   - önceki noktadan ≥30m hareket varsa, VEYA
--   - son INSERT'ten ≥5dk geçtiyse
-- yeni satır ekler. Aksi halde DB şişer (15sn ping × 8sa = 1920 satır/gün/kişi).
--
-- Retention: cleanup_old_location_history() 7 günden eski satırları siler.
-- pg_cron her 6 saatte bir çalıştırır.
--
-- Çalıştırma: Supabase Studio > SQL Editor > Run.
-- =============================================================

-- (1) Tablo
CREATE TABLE IF NOT EXISTS public.location_history (
  id              BIGSERIAL PRIMARY KEY,
  employee_id     TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  lat             DOUBLE PRECISION NOT NULL,
  lng             DOUBLE PRECISION NOT NULL,
  accuracy_m      NUMERIC,
  branch          TEXT,
  distance_m      NUMERIC,
  inside_geofence BOOLEAN NOT NULL DEFAULT FALSE,
  battery_pct     INTEGER,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Personel + zaman bazlı sorgu için index (en kritik)
CREATE INDEX IF NOT EXISTS idx_location_history_emp_at
  ON public.location_history(employee_id, captured_at DESC);

-- Retention için zaman bazlı index
CREATE INDEX IF NOT EXISTS idx_location_history_captured_at
  ON public.location_history(captured_at);


-- (2) live_location_upsert RPC'sini güncelle: history'ye throttle'lı INSERT ekle
CREATE OR REPLACE FUNCTION public.live_location_upsert(
  p_employee_id   TEXT,
  p_lat           DOUBLE PRECISION,
  p_lng           DOUBLE PRECISION,
  p_accuracy      NUMERIC  DEFAULT NULL,
  p_battery       INTEGER  DEFAULT NULL,
  p_stable_state  BOOLEAN  DEFAULT FALSE
) RETURNS public.live_locations AS $$
DECLARE
  v_branch        TEXT;
  v_dist          NUMERIC;
  v_geom          INTEGER;
  v_raw_inside    BOOLEAN;
  v_final_inside  BOOLEAN;
  v_prev          BOOLEAN;
  v_row           public.live_locations;
  v_last_hist     public.location_history;
  v_dist_from_last DOUBLE PRECISION;
  v_minutes_since DOUBLE PRECISION;
  v_should_log    BOOLEAN;
BEGIN
  -- En yakın aktif şubeyi bul
  SELECT bl.branch,
         public.haversine_m(p_lat, p_lng, bl.latitude, bl.longitude),
         bl.geofence_m
    INTO v_branch, v_dist, v_geom
    FROM public.branch_locations bl
   WHERE bl.is_active = TRUE
   ORDER BY public.haversine_m(p_lat, p_lng, bl.latitude, bl.longitude) ASC
   LIMIT 1;
  v_raw_inside := COALESCE(v_dist <= v_geom, FALSE);

  SELECT inside_geofence INTO v_prev FROM public.live_locations
   WHERE employee_id = p_employee_id;
  v_prev := COALESCE(v_prev, FALSE);

  -- Debounce: stable=false ise eski durumu koru
  v_final_inside := CASE WHEN p_stable_state THEN v_raw_inside ELSE v_prev END;

  -- live_locations UPSERT (mevcut davranış)
  INSERT INTO public.live_locations(
    employee_id, lat, lng, accuracy_m, branch, distance_m,
    inside_geofence, battery_pct, captured_at, updated_at)
  VALUES (
    p_employee_id, p_lat, p_lng, p_accuracy, v_branch, v_dist,
    v_final_inside, p_battery, NOW(), NOW())
  ON CONFLICT (employee_id) DO UPDATE
    SET lat = EXCLUDED.lat,
        lng = EXCLUDED.lng,
        accuracy_m = EXCLUDED.accuracy_m,
        branch = EXCLUDED.branch,
        distance_m = EXCLUDED.distance_m,
        inside_geofence = EXCLUDED.inside_geofence,
        battery_pct = EXCLUDED.battery_pct,
        captured_at = EXCLUDED.captured_at,
        updated_at = NOW()
  RETURNING * INTO v_row;

  -- (YENİ) location_history'ye throttle'lı INSERT
  -- En son noktayı çek
  SELECT * INTO v_last_hist
    FROM public.location_history
   WHERE employee_id = p_employee_id
   ORDER BY captured_at DESC
   LIMIT 1;

  IF v_last_hist.id IS NULL THEN
    -- İlk kayıt → her zaman INSERT
    v_should_log := TRUE;
  ELSE
    v_dist_from_last := public.haversine_m(
      p_lat, p_lng, v_last_hist.lat, v_last_hist.lng
    );
    v_minutes_since := EXTRACT(EPOCH FROM (NOW() - v_last_hist.captured_at)) / 60.0;
    -- 30m hareket VEYA 5dk geçtiyse logla
    v_should_log := (COALESCE(v_dist_from_last, 0) >= 30)
                    OR (COALESCE(v_minutes_since, 0) >= 5);
  END IF;

  IF v_should_log THEN
    INSERT INTO public.location_history(
      employee_id, lat, lng, accuracy_m, branch, distance_m,
      inside_geofence, battery_pct, captured_at)
    VALUES (
      p_employee_id, p_lat, p_lng, p_accuracy, v_branch, v_dist,
      v_final_inside, p_battery, NOW());
  END IF;

  RETURN v_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.live_location_upsert(
  TEXT, DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, INTEGER, BOOLEAN
) TO anon, authenticated;


-- (3) RLS — live_locations ile aynı permissive desen
ALTER TABLE public.location_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "loc_hist_anon_all" ON public.location_history;
CREATE POLICY "loc_hist_anon_all" ON public.location_history
  FOR ALL USING (true) WITH CHECK (true);


-- (4) Realtime publication (admin haritada canlı path uzasın)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.location_history;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;


-- (5) 7 günden eski kayıtları temizle
CREATE OR REPLACE FUNCTION public.cleanup_old_location_history()
RETURNS INTEGER AS $$
DECLARE v INTEGER;
BEGIN
  DELETE FROM public.location_history
   WHERE captured_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

-- pg_cron: 6 saatte bir çalıştır
DO $$
BEGIN
  PERFORM cron.schedule(
    'cleanup-old-location-history',
    '0 */6 * * *',
    $cron$SELECT public.cleanup_old_location_history();$cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron yok veya zaten kurulu: %', SQLERRM;
END $$;
