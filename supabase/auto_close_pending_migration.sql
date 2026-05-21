-- =============================================================
-- auto_close_open_shifts() — status 'Bekliyor' olarak güncellendi
-- =============================================================
-- Önceki davranış: fonksiyon açık vardiyaları kapatırken status'u
-- 'Otomatik Kapatıldı (Vardiya)' olarak işaretliyordu. Bu yüzden
-- Bordro > Onay Bekleyenler listesinde (filter: status='Bekliyor')
-- gözükmüyor, admin manuel onay/reddedişi yapamıyordu.
--
-- Yeni davranış: status='Bekliyor'. Otomatik kapatılan log Onaylar
-- sekmesine düşer, admin tek tıkla 👍 Onayla / 👎 Reddet yapabilir.
-- Bildirim merkezindeki "X açık vardiya otomatik kapatıldı"
-- bildirimi olduğu gibi devam eder; admin kimin/hangi vardiya/plan
-- mı yoksa fallback +8sa mı olduğunu oradan görür.
--
-- Çalıştırma: Supabase Studio > SQL Editor > tek seferlik run.
-- pg_cron job'ı aynı isimle fonksiyonu çağırmaya devam edecek.
-- =============================================================

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
    SET check_out_at = u.new_co,
        end_time     = to_char(u.new_co AT TIME ZONE 'Europe/Berlin', 'HH24:MI'),
        status       = 'Bekliyor',  -- ⭐ DEĞİŞTİ: önce 'Otomatik Kapatıldı (Vardiya)' idi
        total_hours  = ROUND(EXTRACT(EPOCH FROM (u.new_co - u.check_in_at))/3600::numeric, 2)
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
      v_lines || E'\n\nPlandan: ' || v_planned || ' • Fallback (+8sa): ' || v_fallback || E'\n\nNot: kayıtlar Bordro > Onay Bekleyenler sekmesinde onayınızı bekliyor.',
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

-- =============================================================
-- Geçmiş kayıtları geri al (opsiyonel)
-- =============================================================
-- Daha önce 'Otomatik Kapatıldı (Vardiya)' statüsüyle kapanan log'lar
-- Onaylar sekmesinde görünmüyor. Aşağıdaki UPDATE onları 'Bekliyor'a
-- çevirir, böylece admin geriye dönük de inceleyip onaylayabilir.
-- (Geriye dönük onay istemiyorsan bu satırları çalıştırma.)

-- UPDATE public.time_logs
--   SET status = 'Bekliyor'
--   WHERE status = 'Otomatik Kapatıldı (Vardiya)';
