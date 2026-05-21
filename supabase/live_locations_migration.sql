-- ============================================================
-- LIVE LOCATIONS / GEOFENCE Migration
-- ============================================================
-- "Harita" sekmesi: personellerin canlı konum takibi + 20m
-- şube geofence'i ile otomatik giriş/çıkış event'leri.
--
-- Bağımlılıklar:
--   - public.profiles, public.branch_locations (db_schema.sql)
--   - pg_net extension (Database > Extensions'tan açın)
--   - app.notify_event_url, app.notify_event_anon postgres
--     custom config'leri (Database > Settings)
-- ============================================================

-- A. branch_locations: 20m geofence kolonu
ALTER TABLE public.branch_locations
  ADD COLUMN IF NOT EXISTS geofence_m INTEGER NOT NULL DEFAULT 20;

-- B. live_locations: her personelin son bilinen konumu (UPSERT hedefi)
CREATE TABLE IF NOT EXISTS public.live_locations (
  employee_id     TEXT PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  lat             DOUBLE PRECISION NOT NULL,
  lng             DOUBLE PRECISION NOT NULL,
  accuracy_m      NUMERIC,
  branch          TEXT,
  distance_m      NUMERIC,
  inside_geofence BOOLEAN NOT NULL DEFAULT FALSE,
  battery_pct     INTEGER,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_live_locations_branch ON public.live_locations(branch);

-- C. geofence_events: append-only enter/exit log
CREATE TABLE IF NOT EXISTS public.geofence_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  branch      TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN ('enter','exit')),
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  distance_m  NUMERIC,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_geofence_events_emp_at
  ON public.geofence_events(employee_id, at DESC);

-- D. Haversine helper (db_schema.sql:557-561 ile aynı formül)
CREATE OR REPLACE FUNCTION public.haversine_m(
  lat1 DOUBLE PRECISION, lng1 DOUBLE PRECISION,
  lat2 DOUBLE PRECISION, lng2 DOUBLE PRECISION
) RETURNS DOUBLE PRECISION AS $$
  SELECT 6371000 * 2 * asin(sqrt(
    power(sin(radians((lat2 - lat1)/2)), 2)
    + cos(radians(lat1)) * cos(radians(lat2))
    * power(sin(radians((lng2 - lng1)/2)), 2)
  ));
$$ LANGUAGE SQL IMMUTABLE;

-- E. UPSERT RPC: client lat/lng yollar, server en yakın şube + inside hesaplar
--    p_stable_state=TRUE iken inside_geofence değişimi uygulanır (debounce).
CREATE OR REPLACE FUNCTION public.live_location_upsert(
  p_employee_id   TEXT,
  p_lat           DOUBLE PRECISION,
  p_lng           DOUBLE PRECISION,
  p_accuracy      NUMERIC  DEFAULT NULL,
  p_battery       INTEGER  DEFAULT NULL,
  p_stable_state  BOOLEAN  DEFAULT FALSE
) RETURNS public.live_locations AS $$
DECLARE
  v_branch TEXT;
  v_dist NUMERIC;
  v_geom INTEGER;
  v_raw_inside BOOLEAN;
  v_final_inside BOOLEAN;
  v_prev BOOLEAN;
  v_row public.live_locations;
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
  v_prev := COALESCE(v_prev, FALSE);

  -- Debounce: stable=false ise eski durumu koru (GPS sapması korunması)
  v_final_inside := CASE WHEN p_stable_state THEN v_raw_inside ELSE v_prev END;

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

  RETURN v_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.live_location_upsert(
  TEXT, DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, INTEGER, BOOLEAN
) TO anon, authenticated;

-- F. Trigger: inside_geofence değişti → events insert + pg_net ile notify-event tetikle
CREATE OR REPLACE FUNCTION public.live_locations_geofence_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_event TEXT;
  v_name TEXT;
  v_payload JSONB;
  v_url TEXT;
  v_anon TEXT;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.inside_geofence = TRUE)
     OR (TG_OP = 'UPDATE' AND OLD.inside_geofence IS DISTINCT FROM NEW.inside_geofence) THEN

    v_event := CASE WHEN NEW.inside_geofence THEN 'enter' ELSE 'exit' END;

    INSERT INTO public.geofence_events(
      employee_id, branch, event_type, lat, lng, distance_m, at)
    VALUES (NEW.employee_id, NEW.branch, v_event, NEW.lat, NEW.lng, NEW.distance_m, NEW.captured_at);

    SELECT full_name INTO v_name FROM public.profiles WHERE id = NEW.employee_id;

    v_payload := jsonb_build_object(
      'type',          CASE WHEN v_event='enter' THEN 'geofence_enter' ELSE 'geofence_exit' END,
      'employee_id',   NEW.employee_id,
      'employee_name', v_name,
      'branch',        NEW.branch,
      'lat',           NEW.lat,
      'lng',           NEW.lng,
      'distance_m',    NEW.distance_m,
      'at',            NEW.captured_at::text
    );

    -- pg_net ile Edge Function'ı tetikle. Config yoksa sessizce atla.
    BEGIN
      v_url  := current_setting('app.notify_event_url', true);
      v_anon := current_setting('app.notify_event_anon', true);
      IF v_url IS NOT NULL AND v_anon IS NOT NULL THEN
        PERFORM net.http_post(
          url     := v_url,
          body    := v_payload,
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'authorization', 'Bearer ' || v_anon)
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- pg_net yoksa veya hata varsa event'i kaybetmeyelim; sadece log'la
      RAISE WARNING 'geofence trigger pg_net hata: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_live_locations_geofence ON public.live_locations;
CREATE TRIGGER trg_live_locations_geofence
  AFTER INSERT OR UPDATE ON public.live_locations
  FOR EACH ROW EXECUTE FUNCTION public.live_locations_geofence_trigger();

-- G. RLS: notification_log ile aynı permissive desen.
--        UI tarafı canSeeMap whitelist'i ile guard'lar.
ALTER TABLE public.live_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geofence_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "live_loc_anon_all" ON public.live_locations;
CREATE POLICY "live_loc_anon_all" ON public.live_locations
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "geo_evt_anon_all" ON public.geofence_events;
CREATE POLICY "geo_evt_anon_all" ON public.geofence_events
  FOR ALL USING (true) WITH CHECK (true);

-- H. Realtime publication
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.live_locations;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.geofence_events;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- I. 24 saatten eski durağan kayıtları temizle (cron her 30dk)
CREATE OR REPLACE FUNCTION public.cleanup_stale_live_locations()
RETURNS INTEGER AS $$
DECLARE v INTEGER;
BEGIN
  DELETE FROM public.live_locations WHERE updated_at < NOW() - INTERVAL '24 hours';
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  PERFORM cron.schedule(
    'cleanup-stale-live-locations',
    '*/30 * * * *',
    $cron$SELECT public.cleanup_stale_live_locations();$cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron yok veya zaten kurulu: %', SQLERRM;
END $$;
