-- =============================================================
-- shift_attendance_notifications_migration.sql
-- =============================================================
-- 2MC Werbung — mesai saati bildirimleri. Bu migration üç yeni
-- bildirim akışı ekler:
--
--  (A) shift_overrun    → Personel vardiya planındaki süreden
--                         30 dk+ fazla çalışırsa ADMİNLERE gider.
--                         (time_logs üzerinde AFTER trigger)
--
--  (B) missing_check_in → Vardiyası olduğu halde saat girişi
--                         yapmayan personeli ADMİNLERE bildirir.
--                         (pg_cron ile 15 dk'da bir tarama)
--
--  (C) shift_reminder   → Aynı taramada PERSONELİN KENDİSİNE
--                         "mesai saatini girmedin" hatırlatması.
--
-- Ayrıca (D) yeni notification_prefs anahtarları (new_user,
-- shift_overrun, missing_check_in, shift_reminder) default'a
-- eklenir ve mevcut profillere backfill edilir.
--
-- ÖN KOŞUL — push gönderimi için (geofence trigger'ı ile aynı ayar):
--   ALTER DATABASE postgres
--     SET app.notify_event_url  = 'https://iqsnemkupgfdzpvmzkiu.functions.supabase.co/notify-event';
--   ALTER DATABASE postgres
--     SET app.notify_event_anon = '<SUPABASE_ANON_KEY>';
--   -- ayarlar yeni bağlantılarda geçerli olur.
--   Kontrol: SELECT current_setting('app.notify_event_url', true);
--
-- Bu ayarlar yoksa push atlanır ama notification_log kaydı yine
-- düşer (Bildirim Merkezi'nde görünür).
--
-- Çalıştırma: Supabase Studio > SQL Editor > run (idempotent).
-- =============================================================


-- -------------------------------------------------------------
-- (D) notification_prefs — yeni anahtarlar
-- -------------------------------------------------------------
ALTER TABLE public.profiles
  ALTER COLUMN notification_prefs SET DEFAULT '{
    "off_shift_sale": true,
    "weekly_sales_anomaly": true,
    "off_shift_qr": true,
    "non_kiosk_check": true,
    "geofence_enter": true,
    "geofence_exit": true,
    "qr_check": true,
    "task_activity": true,
    "new_user": true,
    "shift_overrun": true,
    "missing_check_in": true,
    "shift_reminder": true
  }'::jsonb;

-- Mevcut kullanıcılar: eksik anahtarlar default'tan gelsin,
-- kullanıcının daha önce kapattığı anahtarlar korunsun.
-- (|| operatöründe SAĞ taraf kazanır → mevcut tercihler sağda.)
UPDATE public.profiles
   SET notification_prefs = '{
     "off_shift_sale": true,
     "weekly_sales_anomaly": true,
     "off_shift_qr": true,
     "non_kiosk_check": true,
     "geofence_enter": true,
     "geofence_exit": true,
     "qr_check": true,
     "task_activity": true,
     "new_user": true,
     "shift_overrun": true,
     "missing_check_in": true,
     "shift_reminder": true
   }'::jsonb || COALESCE(notification_prefs, '{}'::jsonb);


-- -------------------------------------------------------------
-- (1) Yardımcı: "07:00-15:00" / "9-17" → dakika
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.parse_time_slot(p_slot TEXT)
RETURNS TABLE(start_min INT, end_min INT)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m TEXT[];
BEGIN
  IF p_slot IS NULL THEN RETURN; END IF;
  m := regexp_match(p_slot, '(\d{1,2}):?(\d{2})?\s*[-–—]\s*(\d{1,2}):?(\d{2})?');
  IF m IS NULL THEN RETURN; END IF;
  start_min := m[1]::int * 60 + COALESCE(m[2], '0')::int;
  end_min   := m[3]::int * 60 + COALESCE(m[4], '0')::int;
  RETURN NEXT;
END;
$$;


-- -------------------------------------------------------------
-- (2) Yardımcı: dakika → "1 sa 36 dk"
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.human_minutes(p_min NUMERIC)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_m INT := GREATEST(0, ROUND(COALESCE(p_min, 0)))::int;
  v_h INT := v_m / 60;
  v_r INT := v_m % 60;
BEGIN
  IF v_h > 0 AND v_r > 0 THEN RETURN v_h || ' sa ' || v_r || ' dk'; END IF;
  IF v_h > 0 THEN RETURN v_h || ' sa'; END IF;
  RETURN v_r || ' dk';
END;
$$;


-- -------------------------------------------------------------
-- (3) Yardımcı: personelin belirli bir gündeki vardiya planı
-- -------------------------------------------------------------
-- shift_schedules.days[i] hücresi CSV personel adı içerir
-- (proje konvansiyonu — has_shift_today ile aynı eşleme mantığı).
-- 0 = Pazartesi ... 6 = Pazar → dizi indeksi = ISODOW.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.planned_shift_for(
  p_employee_id TEXT,
  p_date        DATE
) RETURNS TABLE(
  branch      TEXT,
  start_min   INT,
  end_min     INT,
  planned_min INT,
  start_txt   TEXT,
  end_txt     TEXT
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_name    TEXT;
  v_day_idx INT;
  v_monday  DATE;
BEGIN
  SELECT full_name INTO v_name FROM public.profiles WHERE id = p_employee_id;
  IF v_name IS NULL OR btrim(v_name) = '' THEN RETURN; END IF;

  v_day_idx := EXTRACT(ISODOW FROM p_date)::int - 1;   -- 0=Pzt .. 6=Paz
  v_monday  := p_date - v_day_idx;

  RETURN QUERY
  SELECT s.branch,
         t.start_min,
         t.end_min,
         (CASE WHEN t.end_min <= t.start_min
               THEN t.end_min + 1440 - t.start_min      -- gece geçişi
               ELSE t.end_min - t.start_min END)::int   AS planned_min,
         to_char((t.start_min || ' minutes')::interval, 'HH24:MI') AS start_txt,
         to_char((t.end_min   || ' minutes')::interval, 'HH24:MI') AS end_txt
    FROM public.shift_schedules s
    CROSS JOIN LATERAL public.parse_time_slot(s.time_slot) t
   WHERE s.week_start_date = to_char(v_monday, 'YYYY-MM-DD')
     AND (
       COALESCE(s.days[v_day_idx + 1], '') ILIKE '%' || v_name || '%'
       OR COALESCE(s.days[v_day_idx + 1], '') ILIKE '%' || p_employee_id || '%'
     )
   ORDER BY s.created_at DESC
   LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.parse_time_slot(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.human_minutes(NUMERIC) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.planned_shift_for(TEXT, DATE) TO anon, authenticated;


-- -------------------------------------------------------------
-- (4) Yardımcı: notify-event Edge Function'ına push tetikle
-- -------------------------------------------------------------
-- notification_log kaydını HER ZAMAN çağıran SQL atar; bu fonksiyon
-- yalnızca push gönderimi içindir → payload'a "skip_log": true
-- eklenir, böylece Edge Function ikinci bir log satırı açmaz.
-- pg_net veya app.notify_event_* ayarı yoksa sessizce FALSE döner.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_event_push(p_payload JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_url  TEXT;
  v_anon TEXT;
BEGIN
  v_url  := current_setting('app.notify_event_url',  true);
  v_anon := current_setting('app.notify_event_anon', true);
  IF v_url IS NULL OR btrim(v_url) = '' OR v_anon IS NULL OR btrim(v_anon) = '' THEN
    RETURN FALSE;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    body    := p_payload || jsonb_build_object('skip_log', true),
    headers := jsonb_build_object(
      'content-type',  'application/json',
      'authorization', 'Bearer ' || v_anon)
  );
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_event_push hata: %', SQLERRM;
  RETURN FALSE;
END;
$$;


-- =============================================================
-- (A) PLANLANAN MESAİ AŞIMI — time_logs trigger
-- =============================================================
-- Vardiya planındaki süreyi 30 dk+ aşan her kapanmış mesai kaydı
-- adminlere bildirilir. Plan bulunamazsa sessiz geçilir (bu durum
-- zaten off_shift_qr bildirimi ile kapsanıyor).
-- =============================================================
CREATE OR REPLACE FUNCTION public.check_shift_overrun()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_worked_min NUMERIC;
  v_plan       RECORD;
  v_overrun    INT;
  v_name       TEXT;
  v_branch     TEXT;
  v_tag        TEXT;
  v_title      TEXT;
  v_body       TEXT;
  CONST_TOL    CONSTANT INT := 30;   -- dakika toleransı
BEGIN
  -- Yalnızca kapanmış kayıtlar
  IF NEW.check_out_at IS NULL AND COALESCE(NEW.end_time, '') = '' THEN
    RETURN NEW;
  END IF;

  -- Geçmiş verinin toplu güncellenmesi bildirim yağmuruna dönmesin
  IF NEW.date IS NULL
     OR NEW.date < (NOW() AT TIME ZONE 'Europe/Berlin')::date - 7 THEN
    RETURN NEW;
  END IF;

  -- Süre/çıkış değişmediyse tekrar hesaplama
  IF TG_OP = 'UPDATE'
     AND OLD.check_out_at IS NOT DISTINCT FROM NEW.check_out_at
     AND OLD.total_hours  IS NOT DISTINCT FROM NEW.total_hours
     AND OLD.end_time     IS NOT DISTINCT FROM NEW.end_time THEN
    RETURN NEW;
  END IF;

  -- Çalışılan süre (dk)
  IF COALESCE(NEW.total_hours, 0) > 0 THEN
    v_worked_min := NEW.total_hours * 60.0;
  ELSIF NEW.check_in_at IS NOT NULL AND NEW.check_out_at IS NOT NULL THEN
    v_worked_min := EXTRACT(EPOCH FROM (NEW.check_out_at - NEW.check_in_at)) / 60.0
                    - COALESCE(NEW.break_duration, 0);
  ELSE
    RETURN NEW;
  END IF;

  SELECT * INTO v_plan FROM public.planned_shift_for(NEW.employee_id, NEW.date);
  IF NOT FOUND THEN
    RETURN NEW;   -- o güne ait vardiya planı yok
  END IF;
  IF COALESCE(v_plan.planned_min, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_overrun := ROUND(v_worked_min - v_plan.planned_min)::int;
  IF v_overrun < CONST_TOL THEN
    RETURN NEW;
  END IF;

  v_tag := 'shift-overrun-' || NEW.id::text || '-' || v_overrun::text;

  IF EXISTS (SELECT 1 FROM public.notification_log WHERE tag = v_tag) THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE id = NEW.employee_id;
  v_branch := COALESCE(NEW.branch, v_plan.branch, '-');

  v_title := '⏱️ Planlanan Mesai Aşımı';
  v_body  := COALESCE(v_name, 'Personel') || ' (' || v_branch || ') — plan '
             || v_plan.start_txt || '–' || v_plan.end_txt
             || ' (' || ROUND(v_plan.planned_min / 60.0, 2) || ' sa), çalışılan '
             || ROUND(v_worked_min / 60.0, 2) || ' sa • aşım +'
             || public.human_minutes(v_overrun);

  BEGIN
    INSERT INTO public.notification_log(type, title, body, url, tag, meta)
    VALUES (
      'shift_overrun', v_title, v_body, '/payroll', v_tag,
      jsonb_build_object(
        'log_id',          NEW.id,
        'employee_id',     NEW.employee_id,
        'employee_name',   v_name,
        'branch',          v_branch,
        'date',            NEW.date,
        'planned_start',   v_plan.start_txt,
        'planned_end',     v_plan.end_txt,
        'planned_hours',   ROUND(v_plan.planned_min / 60.0, 2),
        'actual_hours',    ROUND(v_worked_min / 60.0, 2),
        'overrun_minutes', v_overrun
      )
    );

    PERFORM public.notify_event_push(jsonb_build_object(
      'type',            'shift_overrun',
      'employee_id',     NEW.employee_id,
      'employee_name',   v_name,
      'branch',          v_branch,
      'date',            NEW.date::text,
      'planned_start',   v_plan.start_txt,
      'planned_end',     v_plan.end_txt,
      'planned_hours',   ROUND(v_plan.planned_min / 60.0, 2),
      'actual_hours',    ROUND(v_worked_min / 60.0, 2),
      'overrun_minutes', v_overrun
    ));
  EXCEPTION WHEN OTHERS THEN
    -- Bildirim hatası mesai kaydını engellemesin
    RAISE WARNING 'check_shift_overrun bildirim hatası: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_shift_overrun ON public.time_logs;

CREATE TRIGGER trg_check_shift_overrun
  AFTER INSERT OR UPDATE OF check_out_at, end_time, total_hours
  ON public.time_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.check_shift_overrun();


-- =============================================================
-- (B)+(C) MESAİ GİRİŞİ YAPILMAYAN VARDİYALAR
-- =============================================================
-- Vardiyası başlamış (p_grace_min dk geçmiş) ama o güne ait hiç
-- time_logs kaydı olmayan personel için:
--   • adminlere  → 'missing_check_in'
--   • personele  → 'shift_reminder'
-- Her personel + vardiya günü için tek sefer (tag ile dedup).
-- p_window_min: kaç dakikaya kadar geriye bakılacağı (geç kalan
-- vardiyalar sonsuza dek bildirilmesin diye).
-- =============================================================
CREATE OR REPLACE FUNCTION public.check_missing_check_ins(
  p_grace_min  INT DEFAULT 15,
  p_window_min INT DEFAULT 240
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_now_local TIMESTAMP := (NOW() AT TIME ZONE 'Europe/Berlin');
  v_today     DATE      := (NOW() AT TIME ZONE 'Europe/Berlin')::date;
  rec         RECORD;
  v_late      INT;
  v_admin_tag TEXT;
  v_staff_tag TEXT;
  v_plan_txt  TEXT;
  v_admin_n   INT := 0;
  v_staff_n   INT := 0;
  v_scanned   INT := 0;
BEGIN
  FOR rec IN
    WITH days AS (
      SELECT v_today AS d
      UNION
      SELECT v_today - 1                       -- gece geçişi / geç tarama için
    ),
    cells AS (
      SELECT d.d AS shift_date,
             s.branch,
             s.time_slot,
             s.created_at,
             COALESCE(s.days[EXTRACT(ISODOW FROM d.d)::int], '') AS cell
        FROM days d
        JOIN public.shift_schedules s
          ON s.week_start_date =
             to_char(d.d - (EXTRACT(ISODOW FROM d.d)::int - 1), 'YYYY-MM-DD')
    ),
    tokens AS (
      SELECT c.shift_date, c.branch, c.time_slot, c.created_at,
             btrim(tok) AS token
        FROM cells c
        CROSS JOIN LATERAL unnest(string_to_array(c.cell, ',')) AS tok
       WHERE btrim(COALESCE(tok, '')) <> ''
    ),
    matched AS (
      SELECT DISTINCT ON (t.shift_date, t.branch, t.token)
             t.shift_date, t.branch, t.time_slot,
             p.id AS employee_id, p.full_name
        FROM tokens t
        JOIN public.profiles p
          ON p.id = t.token
          OR lower(p.full_name) = lower(t.token)
          OR lower(p.full_name) LIKE '%' || lower(t.token) || '%'
       ORDER BY t.shift_date, t.branch, t.token,
                CASE WHEN p.id = t.token                        THEN 0
                     WHEN lower(p.full_name) = lower(t.token)   THEN 1
                     ELSE 2 END,
                p.full_name
    ),
    planned AS (
      SELECT m.shift_date, m.branch, m.employee_id, m.full_name,
             ts.start_min, ts.end_min,
             (m.shift_date + (ts.start_min || ' minutes')::interval) AS start_local,
             to_char((ts.start_min || ' minutes')::interval, 'HH24:MI') AS start_txt,
             to_char((ts.end_min   || ' minutes')::interval, 'HH24:MI') AS end_txt
        FROM matched m
        CROSS JOIN LATERAL public.parse_time_slot(m.time_slot) ts
    )
    SELECT pl.*
      FROM planned pl
     WHERE pl.start_local <= v_now_local - (p_grace_min  || ' minutes')::interval
       AND pl.start_local >  v_now_local - (p_window_min || ' minutes')::interval
       AND NOT EXISTS (
             SELECT 1 FROM public.time_logs tl
              WHERE tl.employee_id = pl.employee_id
                AND tl.date        = pl.shift_date
           )
  LOOP
    v_scanned  := v_scanned + 1;
    v_late     := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now_local - rec.start_local)) / 60))::int;
    v_plan_txt := rec.start_txt || '–' || rec.end_txt;

    v_admin_tag := 'missing-checkin-' || rec.employee_id || '-' || rec.shift_date::text;
    v_staff_tag := 'shift-reminder-'  || rec.employee_id || '-' || rec.shift_date::text;

    -- (B) Adminlere: mesai girişi yapılmadı
    IF NOT EXISTS (SELECT 1 FROM public.notification_log WHERE tag = v_admin_tag) THEN
      BEGIN
        INSERT INTO public.notification_log(type, title, body, url, tag, meta)
        VALUES (
          'missing_check_in',
          '🚫 Mesai Girişi Yapılmadı',
          COALESCE(rec.full_name, 'Personel') || ' (' || COALESCE(rec.branch, '-') || ') — '
            || v_plan_txt || ' vardiyası başladı, ' || public.human_minutes(v_late)
            || ' geçti, hâlâ giriş yok.',
          '/payroll',
          v_admin_tag,
          jsonb_build_object(
            'employee_id',   rec.employee_id,
            'employee_name', rec.full_name,
            'branch',        rec.branch,
            'date',          rec.shift_date,
            'planned_start', rec.start_txt,
            'planned_end',   rec.end_txt,
            'late_minutes',  v_late
          )
        );

        PERFORM public.notify_event_push(jsonb_build_object(
          'type',          'missing_check_in',
          'employee_id',   rec.employee_id,
          'employee_name', rec.full_name,
          'branch',        rec.branch,
          'date',          rec.shift_date::text,
          'planned_start', rec.start_txt,
          'planned_end',   rec.end_txt,
          'late_minutes',  v_late
        ));

        v_admin_n := v_admin_n + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'missing_check_in bildirim hatası (%): %', rec.employee_id, SQLERRM;
      END;
    END IF;

    -- (C) Personelin kendisine: hatırlatma
    IF NOT EXISTS (SELECT 1 FROM public.notification_log WHERE tag = v_staff_tag) THEN
      BEGIN
        INSERT INTO public.notification_log(type, title, body, url, tag, meta)
        VALUES (
          'shift_reminder',
          '⏰ Mesai Saatini Girmeyi Unutma',
          v_plan_txt || ' vardiyan ' || public.human_minutes(v_late) || ' önce başladı ('
            || COALESCE(rec.branch, '-') || '). Lütfen mesai saat girişini yap.',
          '/payroll',
          v_staff_tag,
          jsonb_build_object(
            'employee_id',   rec.employee_id,
            'employee_name', rec.full_name,
            'branch',        rec.branch,
            'date',          rec.shift_date,
            'planned_start', rec.start_txt,
            'planned_end',   rec.end_txt,
            'late_minutes',  v_late
          )
        );

        PERFORM public.notify_event_push(jsonb_build_object(
          'type',          'shift_reminder',
          'employee_id',   rec.employee_id,
          'employee_name', rec.full_name,
          'branch',        rec.branch,
          'date',          rec.shift_date::text,
          'planned_start', rec.start_txt,
          'planned_end',   rec.end_txt,
          'late_minutes',  v_late
        ));

        v_staff_n := v_staff_n + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'shift_reminder bildirim hatası (%): %', rec.employee_id, SQLERRM;
      END;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',              true,
    'scanned',         v_scanned,
    'admin_notified',  v_admin_n,
    'staff_reminded',  v_staff_n,
    'grace_min',       p_grace_min,
    'window_min',      p_window_min,
    'ran_at',          NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_missing_check_ins(INT, INT) TO anon, authenticated;


-- -------------------------------------------------------------
-- (5) pg_cron — 15 dakikada bir tarama
-- -------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('check-missing-check-ins');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'check-missing-check-ins',
  '*/15 * * * *',
  $$ SELECT public.check_missing_check_ins(); $$
);


-- -------------------------------------------------------------
-- (6) Kontrol sorguları (manuel çalıştırma)
-- -------------------------------------------------------------
-- SELECT public.check_missing_check_ins();            -- şimdi tara
-- SELECT * FROM public.planned_shift_for('<emp_id>', CURRENT_DATE);
-- SELECT type, title, body, created_at
--   FROM public.notification_log
--  WHERE type IN ('shift_overrun','missing_check_in','shift_reminder','new_user')
--  ORDER BY created_at DESC LIMIT 20;
