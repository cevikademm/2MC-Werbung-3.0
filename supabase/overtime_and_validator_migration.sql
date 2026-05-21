-- =============================================================
-- overtime_and_validator_migration.sql
-- =============================================================
-- Bu migration üç şey ekler:
--
--  (A) Personelin "Fazla Mesai Bildir" akışı:
--      - time_logs tablosuna auto_closed_at, overtime_minutes,
--        overtime_requested_at kolonları
--      - request_overtime(log_id, minutes) RPC: personel kendi
--        otomatik kapatılan kaydına fazla mesai ekler, kayıt
--        admin onayına ('Bekliyor') döner.
--      - auto_close_open_shifts() artık auto_closed_at=NOW() yazar.
--
--  (B) Saat doğrulayıcı (Time Validator):
--      - validation_warning, validation_diff_min kolonları
--      - validate_time_log() BEFORE INSERT/UPDATE trigger
--      - Tolerans: 2 dakika (üzeri uyarı, kayıt bloklanmaz)
--      - Kritik durumlar (negatif süre, >16sa, ≥10dk fark)
--        notification_log'a 'time_log_mismatch' kaydı düşer.
--
--  (C) Backfill:
--      - Eski 'Otomatik Kapatıldı (Vardiya)' status'lu kayıtlar
--        'Bekliyor'a çevrilir + auto_closed_at backfill.
--      - Tüm mevcut time_logs için validate_time_log mantığı
--        no-op update ile tetiklenip warning'ler set edilir.
--
-- Çalıştırma: Supabase Studio > SQL Editor > run.
-- =============================================================

-- -------------------------------------------------------------
-- (1) KOLONLAR
-- -------------------------------------------------------------
ALTER TABLE public.time_logs
  ADD COLUMN IF NOT EXISTS auto_closed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS overtime_minutes      INT,
  ADD COLUMN IF NOT EXISTS overtime_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validation_warning    TEXT,
  ADD COLUMN IF NOT EXISTS validation_diff_min   NUMERIC(8,2);

CREATE INDEX IF NOT EXISTS idx_time_logs_auto_closed_at
  ON public.time_logs(auto_closed_at)
  WHERE auto_closed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_time_logs_validation_warning
  ON public.time_logs(id)
  WHERE validation_warning IS NOT NULL;


-- -------------------------------------------------------------
-- (2) BACKFILL: eski auto-close kayıtları
-- -------------------------------------------------------------
-- Önce auto_closed_at'i set et (status değişmeden önce)
-- NOT: time_logs'ta updated_at yok, created_at fallback kullanıyoruz.
UPDATE public.time_logs
   SET auto_closed_at = COALESCE(created_at, check_in_at)
 WHERE auto_closed_at IS NULL
   AND status = 'Otomatik Kapatıldı (Vardiya)';

-- Sonra status'u 'Bekliyor'a çevir → admin onayına düşsün
UPDATE public.time_logs
   SET status = 'Bekliyor'
 WHERE status = 'Otomatik Kapatıldı (Vardiya)';


-- -------------------------------------------------------------
-- (3) auto_close_open_shifts() — auto_closed_at=NOW() ile
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_close_open_shifts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_planned   INT := 0;
  v_fallback  INT := 0;
  v_total     INT := 0;
  v_lines     TEXT;
  v_meta      JSONB;
BEGIN
  WITH open_logs AS (
    SELECT tl.id, tl.employee_id, tl.check_in_at,
           (tl.check_in_at AT TIME ZONE 'Europe/Berlin')::date AS local_date
    FROM time_logs tl
    WHERE tl.check_out_at IS NULL
      AND tl.check_in_at  IS NOT NULL
      AND tl.check_in_at  < NOW() - INTERVAL '16 hours'
  ),
  with_week AS (
    SELECT o.*,
           (o.local_date - ((EXTRACT(ISODOW FROM o.local_date)::int - 1) || ' days')::interval)::date AS monday,
           EXTRACT(ISODOW FROM o.local_date)::int - 1 AS day_idx
    FROM open_logs o
  ),
  matched AS (
    SELECT w.*,
           regexp_match(ss.time_slot, '(\d{1,2}):?(\d{2})?\s*[-–]\s*(\d{1,2}):?(\d{2})?') AS rng
    FROM with_week w
    LEFT JOIN LATERAL (
      SELECT s.time_slot
      FROM shift_schedules s
      WHERE s.week_start_date = to_char(w.monday, 'YYYY-MM-DD')
        AND COALESCE(s.days[w.day_idx + 1], '') ILIKE '%' || w.employee_id || '%'
        AND s.time_slot ~ '\d'
      ORDER BY s.created_at DESC
      LIMIT 1
    ) ss ON TRUE
  ),
  calc AS (
    SELECT m.*,
      CASE WHEN rng IS NOT NULL THEN
        ((local_date::timestamp
          + (rng[3]::int || ' hours')::interval
          + (COALESCE(rng[4],'0')::int || ' minutes')::interval)
         AT TIME ZONE 'Europe/Berlin')
      END AS raw_co
    FROM matched m
  ),
  to_close AS (
    SELECT id, employee_id, check_in_at, (rng IS NOT NULL) AS has_plan,
      CASE
        WHEN raw_co IS NULL              THEN check_in_at + INTERVAL '8 hours'
        WHEN raw_co <= check_in_at       THEN raw_co + INTERVAL '1 day'
        ELSE raw_co
      END AS new_co
    FROM calc
  ),
  upd AS (
    UPDATE time_logs t
    SET check_out_at  = u.new_co,
        end_time      = to_char(u.new_co AT TIME ZONE 'Europe/Berlin', 'HH24:MI'),
        status        = 'Bekliyor',
        total_hours   = ROUND(EXTRACT(EPOCH FROM (u.new_co - u.check_in_at))/3600::numeric, 2),
        auto_closed_at = NOW()
    FROM to_close u
    WHERE t.id = u.id
    RETURNING u.employee_id, u.check_in_at, u.new_co, u.has_plan
  ),
  agg AS (
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE has_plan)::int     AS planned,
      COUNT(*) FILTER (WHERE NOT has_plan)::int AS fallback,
      string_agg(
        '• ' || p.full_name
             || ' — giriş ' || to_char(u.check_in_at AT TIME ZONE 'Europe/Berlin', 'DD.MM HH24:MI')
             || ' / çıkış ' || to_char(u.new_co     AT TIME ZONE 'Europe/Berlin', 'DD.MM HH24:MI')
             || CASE WHEN u.has_plan THEN '' ELSE ' ⚠ (plan yok, +8sa)' END,
        E'\n' ORDER BY u.check_in_at
      ) AS lines,
      jsonb_agg(jsonb_build_object(
        'employee_id', u.employee_id,
        'name',        p.full_name,
        'check_in',    u.check_in_at,
        'check_out',   u.new_co,
        'has_plan',    u.has_plan
      ) ORDER BY u.check_in_at) AS meta
    FROM upd u JOIN profiles p ON p.id = u.employee_id
  )
  SELECT total, planned, fallback, lines, meta
    INTO v_total, v_planned, v_fallback, v_lines, v_meta
  FROM agg;

  IF v_total > 0 THEN
    INSERT INTO public.notification_log(type, title, body, url, tag, meta)
    VALUES (
      'auto_closed_shift',
      v_total || ' açık vardiya otomatik kapatıldı',
      v_lines || E'\n\nPlandan: ' || v_planned || ' • Fallback (+8sa): ' || v_fallback || E'\n\nNot: kayıtlar Bordro > Onay Bekleyenler sekmesinde onayınızı bekliyor. Personel fazla mesai bildirebilir.',
      '/payroll',
      'auto-close-' || to_char((NOW() AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD'),
      jsonb_build_object('planned', v_planned, 'fallback', v_fallback, 'items', v_meta)
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'closed_with_plan',     v_planned,
    'closed_with_fallback', v_fallback,
    'total',                v_total,
    'notified',             v_total > 0,
    'ran_at',               NOW()
  );
END;
$function$;


-- -------------------------------------------------------------
-- (4) request_overtime(log_id, minutes) RPC
-- -------------------------------------------------------------
-- Personel sadece kendi otomatik kapatılan vardiyasına fazla
-- mesai ekleyebilir. Sonuç admin onayına ('Bekliyor') döner.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_overtime(
  p_log_id  UUID,
  p_minutes INT
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_log       RECORD;
  v_new_co    TIMESTAMPTZ;
  v_total     NUMERIC(6,2);
  v_emp_name  TEXT;
  v_caller    UUID := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Oturum bulunamadı';
  END IF;

  IF p_minutes IS NULL OR p_minutes < 1 OR p_minutes > 720 THEN
    RAISE EXCEPTION 'Geçersiz süre — 1 ile 720 dk arasında olmalı';
  END IF;

  SELECT * INTO v_log
    FROM public.time_logs
   WHERE id = p_log_id
     AND employee_id = v_caller;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kayıt bulunamadı veya size ait değil';
  END IF;

  IF v_log.auto_closed_at IS NULL THEN
    RAISE EXCEPTION 'Bu kayıt otomatik kapatılmamış — fazla mesai bildirimi yapılamaz';
  END IF;

  IF v_log.check_out_at IS NULL OR v_log.check_in_at IS NULL THEN
    RAISE EXCEPTION 'Vardiyanın giriş/çıkış zamanı eksik';
  END IF;

  -- Yeni çıkış = mevcut çıkış + p_minutes
  v_new_co := v_log.check_out_at + (p_minutes || ' minutes')::interval;

  -- total_hours = (yeni çıkış - giriş)/3600 - mola
  v_total := ROUND(
    (EXTRACT(EPOCH FROM (v_new_co - v_log.check_in_at)) / 3600.0)
    - (COALESCE(v_log.break_duration, 0) / 60.0),
    2
  );

  IF v_total < 0 THEN
    RAISE EXCEPTION 'Hesaplanan toplam saat negatif çıktı — destek ekibine başvurun';
  END IF;

  UPDATE public.time_logs
     SET check_out_at          = v_new_co,
         end_time              = to_char(v_new_co AT TIME ZONE 'Europe/Berlin', 'HH24:MI'),
         total_hours           = v_total,
         status                = 'Bekliyor',
         overtime_minutes      = COALESCE(overtime_minutes, 0) + p_minutes,
         overtime_requested_at = NOW()
   WHERE id = p_log_id;

  SELECT full_name INTO v_emp_name
    FROM public.profiles
   WHERE id = v_log.employee_id;

  -- Admin'lere bildirim
  BEGIN
    INSERT INTO public.notification_log(type, title, body, url, tag, meta)
    VALUES (
      'overtime_requested',
      COALESCE(v_emp_name, 'Personel') || ' fazla mesai bildirdi',
      'Otomatik kapatılan vardiyaya +' || p_minutes
        || ' dk fazla mesai eklendi. Yeni toplam ' || ROUND(v_total, 2)
        || ' saat. Onayınızı bekliyor.',
      '/payroll',
      'overtime-' || p_log_id::text || '-' || to_char(NOW(), 'YYYYMMDDHH24MISS'),
      jsonb_build_object(
        'log_id',           p_log_id,
        'employee_id',      v_log.employee_id,
        'employee_name',    v_emp_name,
        'overtime_minutes', p_minutes,
        'new_total_hours',  v_total,
        'new_check_out_at', v_new_co
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'ok',               true,
    'new_total_hours',  v_total,
    'new_check_out_at', v_new_co,
    'overtime_minutes', p_minutes
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.request_overtime(UUID, INT) TO authenticated;


-- -------------------------------------------------------------
-- (5) validate_time_log() — BEFORE INSERT/UPDATE trigger
-- -------------------------------------------------------------
-- Tolerans: 2 dk. Daha büyük fark uyarı olarak işaretlenir,
-- kayıt bloklanmaz. ≥10 dk fark → notification_log'a düşer.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_time_log()
 RETURNS TRIGGER
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_expected_min  NUMERIC(10,2);
  v_actual_min    NUMERIC(10,2);
  v_diff          NUMERIC(10,2);
  v_emp_name      TEXT;
  v_break         NUMERIC := COALESCE(NEW.break_duration, 0);
  CONST_TOL       CONSTANT NUMERIC := 2.0;   -- dakika
  CONST_NOTIFY    CONSTANT NUMERIC := 10.0;  -- ≥10dk → bildirim
  CONST_MAX_HOUR  CONSTANT NUMERIC := 16.0;  -- saat
BEGIN
  -- 1) check_in_at + check_out_at varsa onları kullan (en güvenilir)
  IF NEW.check_in_at IS NOT NULL AND NEW.check_out_at IS NOT NULL THEN
    v_expected_min := EXTRACT(EPOCH FROM (NEW.check_out_at - NEW.check_in_at)) / 60.0;

  -- 2) yoksa start_time / end_time / date'den hesapla
  ELSIF NEW.start_time IS NOT NULL
        AND NEW.end_time IS NOT NULL
        AND NEW.date IS NOT NULL
        AND length(NEW.start_time) >= 4
        AND length(NEW.end_time) >= 4 THEN
    v_expected_min := EXTRACT(EPOCH FROM (
        (NEW.date::timestamp + NEW.end_time::time)
      - (NEW.date::timestamp + NEW.start_time::time)
    )) / 60.0;
    -- Gece geçişi: end < start ise +24sa
    IF v_expected_min < 0 THEN
      v_expected_min := v_expected_min + (24 * 60);
    END IF;

  ELSE
    -- doğrulama için yeterli veri yok
    NEW.validation_warning  := NULL;
    NEW.validation_diff_min := NULL;
    RETURN NEW;
  END IF;

  -- Mola düş
  v_expected_min := v_expected_min - v_break;

  -- Gerçek (kaydedilen) total_hours dakika cinsinden
  v_actual_min := COALESCE(NEW.total_hours, 0) * 60.0;

  v_diff := ABS(v_expected_min - v_actual_min);

  -- Sınıflandırma
  IF v_expected_min < 0 THEN
    NEW.validation_warning  := 'Negatif çalışma süresi — başlangıç bitişten sonra';
    NEW.validation_diff_min := v_expected_min;

  ELSIF v_expected_min > CONST_MAX_HOUR * 60 THEN
    NEW.validation_warning  := format(
      'Olağandışı uzun vardiya — %s saat (limit %s)',
      ROUND(v_expected_min / 60, 2),
      CONST_MAX_HOUR
    );
    NEW.validation_diff_min := v_expected_min - (CONST_MAX_HOUR * 60);

  ELSIF v_diff > CONST_TOL THEN
    NEW.validation_warning  := format(
      'Saat tutarsızlığı: beklenen %s sa %s dk, kayıtlı %s sa %s dk (fark %s dk)',
      FLOOR(v_expected_min / 60)::int,
      ROUND(v_expected_min - FLOOR(v_expected_min / 60) * 60, 0)::int,
      FLOOR(v_actual_min / 60)::int,
      ROUND(v_actual_min - FLOOR(v_actual_min / 60) * 60, 0)::int,
      ROUND(v_diff, 1)
    );
    NEW.validation_diff_min := v_diff;

  ELSE
    NEW.validation_warning  := NULL;
    NEW.validation_diff_min := NULL;
  END IF;

  -- Yeni veya değişmiş bir warning ise + ≥10dk ise bildirim at
  IF NEW.validation_warning IS NOT NULL
     AND COALESCE(NEW.validation_diff_min, 0) >= CONST_NOTIFY
     AND (
       TG_OP = 'INSERT'
       OR OLD.validation_warning IS DISTINCT FROM NEW.validation_warning
     ) THEN

    BEGIN
      SELECT full_name INTO v_emp_name
        FROM public.profiles
       WHERE id = NEW.employee_id;

      INSERT INTO public.notification_log(type, title, body, url, tag, meta)
      VALUES (
        'time_log_mismatch',
        'Saat hatası: ' || COALESCE(v_emp_name, 'Personel'),
        format('%s — %s', COALESCE(to_char(NEW.date, 'DD.MM.YYYY'), '?'), NEW.validation_warning),
        '/payroll',
        'mismatch-' || NEW.id::text,
        jsonb_build_object(
          'log_id',        NEW.id,
          'employee_id',   NEW.employee_id,
          'employee_name', v_emp_name,
          'date',          NEW.date,
          'expected_min',  v_expected_min,
          'actual_min',    v_actual_min,
          'diff_min',      v_diff
        )
      );
    EXCEPTION WHEN OTHERS THEN
      -- bildirim hatası kaydı engellemesin
      NULL;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_validate_time_log ON public.time_logs;

CREATE TRIGGER trg_validate_time_log
  BEFORE INSERT OR UPDATE OF
    start_time, end_time, total_hours,
    check_in_at, check_out_at, break_duration, date
  ON public.time_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_time_log();


-- -------------------------------------------------------------
-- (6) Mevcut kayıtları doğrula (no-op update ile trigger tetikle)
-- -------------------------------------------------------------
-- NOT: Büyük tablolarda yavaş olabilir. İstersen bu satırı
-- yorum satırına alıp daha sonra batch halinde çalıştır.
UPDATE public.time_logs
   SET total_hours = total_hours
 WHERE check_in_at IS NOT NULL
    OR (start_time IS NOT NULL AND end_time IS NOT NULL);
