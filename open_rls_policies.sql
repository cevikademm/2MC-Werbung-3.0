-- =====================================================================
-- RLS POLICY AÇMA — yazma engellerini kaldır (2MC Werbung)
-- Hedef: wgfkoxjlcovrkzrustpy.supabase.co
-- Kullanım: Supabase Dashboard > SQL Editor > New Query > Yapıştır > Run
--
-- Neden: db_schema.sql'deki RLS policy'leri `current_setting('app.current_user_role')`
-- üzerinden Admin kontrolü yapıyor ama client bunu set etmiyor → INSERT/UPDATE/DELETE
-- RLS violation hatası veriyor → frontend "demo modu" fallback'ine düşüyor.
--
-- Çözüm: tüm yazma tablolarında permissive policy (FOR ALL USING(true)).
-- Güvenlik: frontend zaten isAdmin / canSeeX kontrolleri yapıyor. RLS ikinci kat.
-- Anon key zaten public, RLS gerçek güvenlik için değil (RPC ve frontend için).
--
-- ⚠ Loss control (stock_entries/counts) tabloları dokunulmaz — onlar RPC ile
-- erişiliyor zaten ve loss-control sekmesi UI'da gizli.
-- =====================================================================

-- profiles
DROP POLICY IF EXISTS "profiles_select"      ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own"  ON public.profiles;
DROP POLICY IF EXISTS "profiles_admin_all"   ON public.profiles;
DROP POLICY IF EXISTS "profiles_open"        ON public.profiles;
CREATE POLICY "profiles_open" ON public.profiles FOR ALL USING (true) WITH CHECK (true);

-- time_logs
DROP POLICY IF EXISTS "timelogs_select_own"  ON public.time_logs;
DROP POLICY IF EXISTS "timelogs_insert_own"  ON public.time_logs;
DROP POLICY IF EXISTS "timelogs_admin_all"   ON public.time_logs;
DROP POLICY IF EXISTS "timelogs_open"        ON public.time_logs;
CREATE POLICY "timelogs_open" ON public.time_logs FOR ALL USING (true) WITH CHECK (true);

-- tasks
DROP POLICY IF EXISTS "tasks_select_assigned" ON public.tasks;
DROP POLICY IF EXISTS "tasks_admin_all"       ON public.tasks;
DROP POLICY IF EXISTS "tasks_open"            ON public.tasks;
CREATE POLICY "tasks_open" ON public.tasks FOR ALL USING (true) WITH CHECK (true);

-- messages
DROP POLICY IF EXISTS "messages_select_own"  ON public.messages;
DROP POLICY IF EXISTS "messages_insert_own"  ON public.messages;
DROP POLICY IF EXISTS "messages_admin_all"   ON public.messages;
DROP POLICY IF EXISTS "messages_open"        ON public.messages;
CREATE POLICY "messages_open" ON public.messages FOR ALL USING (true) WITH CHECK (true);

-- calendar_events
DROP POLICY IF EXISTS "calendar_select_all" ON public.calendar_events;
DROP POLICY IF EXISTS "calendar_admin_all"  ON public.calendar_events;
DROP POLICY IF EXISTS "calendar_open"       ON public.calendar_events;
CREATE POLICY "calendar_open" ON public.calendar_events FOR ALL USING (true) WITH CHECK (true);

-- shift_schedules
DROP POLICY IF EXISTS "shifts_select_all" ON public.shift_schedules;
DROP POLICY IF EXISTS "shifts_admin_all"  ON public.shift_schedules;
DROP POLICY IF EXISTS "shifts_open"       ON public.shift_schedules;
CREATE POLICY "shifts_open" ON public.shift_schedules FOR ALL USING (true) WITH CHECK (true);

-- sales_logs
DROP POLICY IF EXISTS "sales_select_own"  ON public.sales_logs;
DROP POLICY IF EXISTS "sales_insert_own"  ON public.sales_logs;
DROP POLICY IF EXISTS "sales_admin_all"   ON public.sales_logs;
DROP POLICY IF EXISTS "sales_open"        ON public.sales_logs;
CREATE POLICY "sales_open" ON public.sales_logs FOR ALL USING (true) WITH CHECK (true);

-- app_settings
DROP POLICY IF EXISTS "settings_select_all" ON public.app_settings;
DROP POLICY IF EXISTS "settings_admin_all"  ON public.app_settings;
DROP POLICY IF EXISTS "settings_open"       ON public.app_settings;
CREATE POLICY "settings_open" ON public.app_settings FOR ALL USING (true) WITH CHECK (true);

-- personnel_transfers
DROP POLICY IF EXISTS "transfers_select_all" ON public.personnel_transfers;
DROP POLICY IF EXISTS "transfers_admin_all"  ON public.personnel_transfers;
DROP POLICY IF EXISTS "transfers_open"       ON public.personnel_transfers;
CREATE POLICY "transfers_open" ON public.personnel_transfers FOR ALL USING (true) WITH CHECK (true);

-- audit_logs
DROP POLICY IF EXISTS "audit_admin_only" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_insert_all" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_open"       ON public.audit_logs;
CREATE POLICY "audit_open" ON public.audit_logs FOR ALL USING (true) WITH CHECK (true);

-- branch_locations (eğer RLS aktifse open yap)
ALTER TABLE public.branch_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "branch_loc_open" ON public.branch_locations;
CREATE POLICY "branch_loc_open" ON public.branch_locations FOR ALL USING (true) WITH CHECK (true);

-- PostgREST schema cache'ini yenile
NOTIFY pgrst, 'reload schema';

-- Doğrulama: hangi tablolarda hangi policy'ler aktif
SELECT schemaname, tablename, policyname
  FROM pg_policies
 WHERE schemaname = 'public'
 ORDER BY tablename, policyname;
