-- =============================================================
-- live_location_first_ping_fix.sql
-- =============================================================
-- Bug: Personel şubeye girip ilk ping atıldığında harita "şube
-- dışında" gözüküyor, ~15sn sonra düzeliyor.
--
-- Neden: live_location_upsert RPC, p_stable_state=FALSE iken
--   v_prev (eski inside_geofence değeri) kullanıyor. İlk kayıtta
--   v_prev NULL → COALESCE ile FALSE → ilk ping yanlış işaretleniyor.
--
-- Fix: v_prev IS NULL (yeni personel kaydı) ise raw değeri kullan.
--      Stable debounce mantığı korunur — sadece ilk fix savunması.
--
-- Bu dosya location_history_migration.sql'deki RPC'yi (history
-- INSERT'li sürüm) baz alır. SQL Editor'de bir kez çalıştır.
-- =============================================================

CREATE OR REPLACE FUNCTION public.live_location_upsert(
  p_employee_id   TEXT,
  p_lat           DOUBLE PRECISION,
  p_lng           DOUBLE PRECISION,
  p_accuracy      NUMERIC  DEFAULT NULL,
  p_battery       INTEGER  DEFAULT NULL,
  p_stable_state  BOOLEAN  DEFAULT FALSE
) RETURNS public.live_locations AS $$
DECLARE
  v_branch         TEXT;
  v_dist           NUMERIC;
  v_geom           INTEGER;
  v_raw_inside     BOOLEAN;
  v_final_inside   BOOLEAN;
  v_prev           BOOLEAN;
  v_row            public.live_locations;
  v_last_hist      public.location_history;
  v_dist_from_last DOUBLE PRECISION;
  v_minutes_since  DOUBLE PRECISION;
  v_should_log     BOOLEAN;
BEGIN
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

  -- Debounce: stable=false ise eski durumu koru (GPS sapması savunması).
  -- Ancak ilk kayıtta (v_prev IS NULL) eski durum yok → raw değeri kullan,
  -- yoksa personel şubeye girip ilk ping'te "dışarıda" gözükür.
  v_final_inside := CASE
    WHEN p_stable_state THEN v_raw_inside
    WHEN v_prev IS NULL THEN v_raw_inside
    ELSE v_prev
  END;

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

  SELECT * INTO v_last_hist
    FROM public.location_history
   WHERE employee_id = p_employee_id
   ORDER BY captured_at DESC
   LIMIT 1;

  IF v_last_hist.id IS NULL THEN
    v_should_log := TRUE;
  ELSE
    v_dist_from_last := public.haversine_m(
      p_lat, p_lng, v_last_hist.lat, v_last_hist.lng
    );
    v_minutes_since := EXTRACT(EPOCH FROM (NOW() - v_last_hist.captured_at)) / 60.0;
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
