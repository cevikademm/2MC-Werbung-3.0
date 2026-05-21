-- ============================================================
-- BİLDİRİM MERKEZİ — Migration
-- ============================================================
-- Edge Function üzerinden gönderilen tüm push bildirimlerinin
-- geçmişini tutar. Yetkili kullanıcılar (cevikademm, gurcan,
-- hakan, seda) sağ üstteki bildirim merkezinden görüntüler.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.notification_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL,             -- off_shift_sale | off_shift_qr | non_kiosk_check | weekly_sales_anomaly
  title       TEXT NOT NULL,
  body        TEXT,
  url         TEXT,
  tag         TEXT,
  meta        JSONB DEFAULT '{}'::jsonb, -- ek alanlar (employee_name, branch, product, quantity vs.)
  read_by     TEXT[] DEFAULT '{}',       -- bu bildirimi "okundu" işaretleyen user_id'ler
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_log_created_desc
  ON public.notification_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_log_type
  ON public.notification_log (type, created_at DESC);

-- RLS: Permissive (push_subscriptions ile aynı strateji)
-- Hassas veri yok; UI tarafında email whitelist ile filtreleniyor.
ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notif_log_anon_all" ON public.notification_log;
CREATE POLICY "notif_log_anon_all" ON public.notification_log
  FOR ALL USING (true) WITH CHECK (true);

-- Realtime publication (yeni bildirim → UI anında görsün)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.notification_log;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ============================================================
-- 90 GÜNDEN ESKİ KAYITLARI TEMİZLE
-- ============================================================
CREATE OR REPLACE FUNCTION public.cleanup_old_notifications()
RETURNS INTEGER AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.notification_log
   WHERE created_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

-- pg_cron ile her gece 03:00 UTC çalışsın
DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-old-notifications');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'cleanup-old-notifications',
  '0 3 * * *',  -- her gün UTC 03:00
  $$ SELECT public.cleanup_old_notifications(); $$
);
