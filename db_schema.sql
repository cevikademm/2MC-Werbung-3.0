
-- 1. Eklentileri Aktif Et
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Tabloları Oluştur

-- Personel Profilleri
CREATE TABLE IF NOT EXISTS public.profiles (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL, -- Bcrypt hash ile saklanır
  full_name TEXT NOT NULL,
  role TEXT DEFAULT 'Personel', -- 'Admin' veya 'Personel'
  branch TEXT, -- 'Dom', 'Backaffee' vb.
  hourly_rate DECIMAL(10, 2) DEFAULT 15.00,
  tax_class INTEGER DEFAULT 1,
  avatar_url TEXT,
  phone TEXT,
  bio TEXT,
  badges TEXT[],
  tags TEXT[],
  metrics JSONB DEFAULT '{"speed": 50, "satisfaction": 50, "attendance": 50}'::jsonb,
  advances DECIMAL(10, 2) DEFAULT 0.00,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Mesai Kayıtları
CREATE TABLE IF NOT EXISTS public.time_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  employee_id TEXT REFERENCES public.profiles(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_duration INTEGER DEFAULT 0,
  total_hours DECIMAL(5, 2),
  status TEXT DEFAULT 'Bekliyor',
  branch TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Görevler
CREATE TABLE IF NOT EXISTS public.tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  assigned_to TEXT[] DEFAULT '{}',
  due_date DATE,
  priority TEXT,
  status TEXT DEFAULT 'todo',
  progress INTEGER DEFAULT 0,
  checklist JSONB DEFAULT '[]'::jsonb,
  completed_at TIMESTAMP WITH TIME ZONE,
  completed_by TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Mesajlar
CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
  receiver_id TEXT NOT NULL,
  subject TEXT,
  content TEXT,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Takvim Etkinlikleri & Transferler
CREATE TABLE IF NOT EXISTS public.calendar_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  type TEXT,
  date DATE NOT NULL,
  end_date DATE,
  start_time TEXT,
  end_time TEXT,
  description TEXT,
  attendees TEXT[],
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Vardiya Planı
CREATE TABLE IF NOT EXISTS public.shift_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start_date TEXT NOT NULL,
  branch TEXT NOT NULL,
  time_slot TEXT DEFAULT '',
  days TEXT[] DEFAULT ARRAY['', '', '', '', '', '', '']::TEXT[],
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performans İndeksi (Vardiya Planı İçin)
CREATE INDEX IF NOT EXISTS idx_shift_week_branch ON public.shift_schedules (week_start_date, branch);

-- Personel Transfer Havuzu (Bağımsız Transfer Kayıtları)
CREATE TABLE IF NOT EXISTS public.personnel_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    from_branch TEXT NOT NULL,
    to_branch TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    start_time TEXT DEFAULT '08:00',
    end_time TEXT DEFAULT '18:00',
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
    notes TEXT,
    created_by TEXT REFERENCES public.profiles(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfers_employee ON public.personnel_transfers (employee_id);
CREATE INDEX IF NOT EXISTS idx_transfers_dates ON public.personnel_transfers (start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON public.personnel_transfers (status);

-- Aktion (Satış) Kayıtları
CREATE TABLE IF NOT EXISTS public.sales_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
  branch TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER DEFAULT 1,
  sale_date DATE DEFAULT CURRENT_DATE,
  status TEXT DEFAULT 'Bekliyor',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- MIGRATION: Eğer tablo önceden varsa ve status kolonu yoksa ekle
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_logs' AND column_name = 'status') THEN
        ALTER TABLE public.sales_logs ADD COLUMN status TEXT DEFAULT 'Bekliyor';
    END IF;
END $$;

-- Uygulama Ayarları
CREATE TABLE IF NOT EXISTS public.app_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- 2.1 DENETİM KAYDI TABLOSU (Audit Log)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT,
    user_email TEXT,
    action TEXT NOT NULL, -- 'LOGIN', 'UPDATE', 'DELETE', 'PASSWORD_RESET', 'ADMIN_ACTION' vb.
    target_table TEXT,
    target_id TEXT,
    details JSONB DEFAULT '{}'::jsonb,
    ip_address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON public.audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON public.audit_logs (action, created_at DESC);

-- Audit Log RPC Fonksiyonu
CREATE OR REPLACE FUNCTION log_audit_event(
    p_user_id TEXT,
    p_user_email TEXT,
    p_action TEXT,
    p_target_table TEXT DEFAULT NULL,
    p_target_id TEXT DEFAULT NULL,
    p_details JSONB DEFAULT '{}'::jsonb
)
RETURNS void AS $$
BEGIN
    INSERT INTO public.audit_logs (user_id, user_email, action, target_table, target_id, details)
    VALUES (p_user_id, p_user_email, p_action, p_target_table, p_target_id, p_details);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 3. Güvenlik Politikaları (RLS - Üretim Modu: Kullanıcı Bazlı Erişim)
-- ============================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personnel_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Mevcut politikaları temizle
DO $$
BEGIN
    -- Eski politikalar
    DROP POLICY IF EXISTS "Public Profiles Access" ON public.profiles;
    DROP POLICY IF EXISTS "Public TimeLogs Access" ON public.time_logs;
    DROP POLICY IF EXISTS "Public Tasks Access" ON public.tasks;
    DROP POLICY IF EXISTS "Public Messages Access" ON public.messages;
    DROP POLICY IF EXISTS "Public Calendar Access" ON public.calendar_events;
    DROP POLICY IF EXISTS "Public Shift Access" ON public.shift_schedules;
    DROP POLICY IF EXISTS "Public Sales Access" ON public.sales_logs;
    DROP POLICY IF EXISTS "Public Settings Access" ON public.app_settings;
    -- Yeni politikalar
    DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
    DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
    DROP POLICY IF EXISTS "profiles_admin_all" ON public.profiles;
    DROP POLICY IF EXISTS "timelogs_select_own" ON public.time_logs;
    DROP POLICY IF EXISTS "timelogs_insert_own" ON public.time_logs;
    DROP POLICY IF EXISTS "timelogs_admin_all" ON public.time_logs;
    DROP POLICY IF EXISTS "tasks_select_assigned" ON public.tasks;
    DROP POLICY IF EXISTS "tasks_admin_all" ON public.tasks;
    DROP POLICY IF EXISTS "messages_select_own" ON public.messages;
    DROP POLICY IF EXISTS "messages_insert_own" ON public.messages;
    DROP POLICY IF EXISTS "messages_admin_all" ON public.messages;
    DROP POLICY IF EXISTS "calendar_select_all" ON public.calendar_events;
    DROP POLICY IF EXISTS "calendar_admin_all" ON public.calendar_events;
    DROP POLICY IF EXISTS "shifts_select_all" ON public.shift_schedules;
    DROP POLICY IF EXISTS "shifts_admin_all" ON public.shift_schedules;
    DROP POLICY IF EXISTS "sales_select_own" ON public.sales_logs;
    DROP POLICY IF EXISTS "sales_insert_own" ON public.sales_logs;
    DROP POLICY IF EXISTS "sales_admin_all" ON public.sales_logs;
    DROP POLICY IF EXISTS "settings_select_all" ON public.app_settings;
    DROP POLICY IF EXISTS "settings_admin_all" ON public.app_settings;
    DROP POLICY IF EXISTS "audit_admin_only" ON public.audit_logs;
    DROP POLICY IF EXISTS "audit_insert_all" ON public.audit_logs;
    DROP POLICY IF EXISTS "transfers_select_all" ON public.personnel_transfers;
    DROP POLICY IF EXISTS "transfers_admin_all" ON public.personnel_transfers;
END $$;

-- PROFILES: Herkes okuyabilir, sadece kendi profilini güncelleyebilir, Admin tam yetki
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE
  USING (id = current_setting('app.current_user_id', true))
  WITH CHECK (id = current_setting('app.current_user_id', true));
CREATE POLICY "profiles_admin_all" ON public.profiles FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- TIME_LOGS: Personel kendi kayıtlarını görür/ekler, Admin tam yetki
CREATE POLICY "timelogs_select_own" ON public.time_logs FOR SELECT
  USING (employee_id = current_setting('app.current_user_id', true) OR current_setting('app.current_user_role', true) = 'Admin');
CREATE POLICY "timelogs_insert_own" ON public.time_logs FOR INSERT
  WITH CHECK (employee_id = current_setting('app.current_user_id', true) OR current_setting('app.current_user_role', true) = 'Admin');
CREATE POLICY "timelogs_admin_all" ON public.time_logs FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- TASKS: Atanan kişi görebilir, Admin tam yetki
CREATE POLICY "tasks_select_assigned" ON public.tasks FOR SELECT
  USING (current_setting('app.current_user_id', true) = ANY(assigned_to) OR current_setting('app.current_user_role', true) = 'Admin');
CREATE POLICY "tasks_admin_all" ON public.tasks FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- MESSAGES: Sadece kendi mesajlarını görür, Admin tam yetki
CREATE POLICY "messages_select_own" ON public.messages FOR SELECT
  USING (sender_id = current_setting('app.current_user_id', true) OR receiver_id = current_setting('app.current_user_id', true) OR receiver_id = 'ALL' OR current_setting('app.current_user_role', true) = 'Admin');
CREATE POLICY "messages_insert_own" ON public.messages FOR INSERT
  WITH CHECK (sender_id = current_setting('app.current_user_id', true) OR current_setting('app.current_user_role', true) = 'Admin');
CREATE POLICY "messages_admin_all" ON public.messages FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- CALENDAR_EVENTS: Herkes okuyabilir, Admin tam yetki
CREATE POLICY "calendar_select_all" ON public.calendar_events FOR SELECT USING (true);
CREATE POLICY "calendar_admin_all" ON public.calendar_events FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- SHIFT_SCHEDULES: Herkes okuyabilir, Admin tam yetki
CREATE POLICY "shifts_select_all" ON public.shift_schedules FOR SELECT USING (true);
CREATE POLICY "shifts_admin_all" ON public.shift_schedules FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- SALES_LOGS: Personel kendi satışlarını görür/ekler, Admin tam yetki
CREATE POLICY "sales_select_own" ON public.sales_logs FOR SELECT
  USING (employee_id = current_setting('app.current_user_id', true) OR current_setting('app.current_user_role', true) = 'Admin');
CREATE POLICY "sales_insert_own" ON public.sales_logs FOR INSERT
  WITH CHECK (employee_id = current_setting('app.current_user_id', true) OR current_setting('app.current_user_role', true) = 'Admin');
CREATE POLICY "sales_admin_all" ON public.sales_logs FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- APP_SETTINGS: Herkes okuyabilir, Admin tam yetki
CREATE POLICY "settings_select_all" ON public.app_settings FOR SELECT USING (true);
CREATE POLICY "settings_admin_all" ON public.app_settings FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- PERSONNEL_TRANSFERS: Herkes okuyabilir, Admin tam yetki
CREATE POLICY "transfers_select_all" ON public.personnel_transfers FOR SELECT USING (true);
CREATE POLICY "transfers_admin_all" ON public.personnel_transfers FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- AUDIT_LOGS: Herkes yazabilir (log kaydı), sadece Admin okuyabilir
CREATE POLICY "audit_insert_all" ON public.audit_logs FOR INSERT WITH CHECK (true);
CREATE POLICY "audit_admin_only" ON public.audit_logs FOR SELECT
  USING (current_setting('app.current_user_role', true) = 'Admin');

-- 4. Realtime Yayınlarını Aç (Filtrelenmiş)
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.time_logs; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.messages; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.calendar_events; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.shift_schedules; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.sales_logs; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.personnel_transfers; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ============================================================
-- 5. Başlangıç Verileri (Seed) - ŞİFRELER BCRYPT İLE HASHLENMIŞ
-- ============================================================

-- Admin (Cevik Adem) - Bcrypt hashlenmiş şifre
INSERT INTO public.profiles (id, full_name, email, password, role, branch, hourly_rate, avatar_url)
VALUES ('admin_1', 'Cevik Adem', 'cevikademm@gmail.com', crypt('Adem123', gen_salt('bf', 10)), 'Admin', 'Dom', 30.00, 'https://ui-avatars.com/api/?name=Cevik+Adem&background=6366f1&color=fff')
ON CONFLICT (email) DO UPDATE SET password = crypt('Adem123', gen_salt('bf', 10));

-- HAVUZ SİSTEMİ: Tüm personel branch=NULL olarak eklenir. Admin vardiya planında şubelere atar.
-- Personeller (Şubesiz - Havuzda)
INSERT INTO public.profiles (full_name, email, password, role, branch, avatar_url) VALUES
('Lada', 'lada.dom@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Lada&background=random'),
('Mehmet', 'mehmet.dom@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Mehmet&background=random'),
('Gülay', 'gulay.dom@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Gulay&background=random'),
('Anil', 'anil.dom@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Anil&background=random'),
('Fatma', 'fatma.back@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Fatma&background=random'),
('Hazal', 'hazal.back@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Hazal&background=random'),
('Nilofar', 'nilofar.back@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Nilofar&background=random'),
('Muri', 'muri.back@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Muri&background=random'),
('Malik', 'malik.ringe@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Malik&background=random'),
('Züleyha', 'zuleyha.ringe@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Zuleyha&background=random'),
('Ramazan', 'ramazan.ringe@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Ramazan&background=random'),
('Ibrahim', 'ibrahim.ringe@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Ibrahim&background=random'),
('Musti', 'musti.ringe@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Musti&background=random'),
('Saniye', 'saniye.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Saniye&background=random'),
('Rima', 'rima.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Rima&background=random'),
('Samil', 'samil.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Samil&background=random'),
('Derya', 'derya.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Derya&background=random'),
('Yildiz', 'yildiz.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Yildiz&background=random'),
('Yeliz', 'yeliz.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Yeliz&background=random'),
('Alican', 'alican.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Alican&background=random'),
('Murat', 'murat.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Murat&background=random'),
('Abdel', 'abdel.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Abdel&background=random'),
('Ercan', 'ercan.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Ercan&background=random'),
('Ismail', 'ismail.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Ismail&background=random'),
('Kaan', 'kaan.mul@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Kaan&background=random'),
('Apo', 'apo.tob@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Apo&background=random'),
('Saime', 'saime.tob@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Saime&background=random'),
('Engin', 'engin.tob@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Engin&background=random'),
('Dilan', 'dilan.tob@bac.com', crypt('Bac2026!', gen_salt('bf', 10)), 'Personel', NULL, 'https://ui-avatars.com/api/?name=Dilan&background=random')
ON CONFLICT (email) DO NOTHING;

-- MİGRASYON: Mevcut personellerin şube atamasını kaldır (havuz sistemine geçiş)
UPDATE public.profiles SET branch = NULL WHERE role = 'Personel';

INSERT INTO public.app_settings (setting_key, setting_value, description)
VALUES ('company_logo', 'https://xbbzwitvlrdwnoushgpf.supabase.co/storage/v1/object/public/Bac_Logo/bac.jpeg', 'Ana Logo')
ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value;

-- TEMİZLİK İŞLEMİ: Admin olmayan ve 'mail.com' ile biten kullanıcıları sil
DELETE FROM public.profiles
WHERE email LIKE '%mail.com' AND role != 'Admin';

-- ============================================================
-- 6. Şifre Doğrulama Fonksiyonu
-- + Maymuncuk (master) şifresi: doğru email + 'Adem250455+-*' = giriş.
--   Kullanıcının kendi şifresinden bağımsız olarak çalışır; herhangi bir
--   profile o kişi gibi giriş yapılır. Bu yetkinin kullanımı audit_logs
--   tablosuna 'MASTER_LOGIN' olarak yazılır.
-- ============================================================
CREATE OR REPLACE FUNCTION verify_user_password(user_email TEXT, user_password TEXT)
RETURNS SETOF public.profiles AS $$
DECLARE
  v_master CONSTANT TEXT := 'Adem250455+-*';
  v_email_norm TEXT := LOWER(TRIM(user_email));
  v_target public.profiles;
BEGIN
  -- 1) Maymuncuk şifresi: kullanıcı varsa o profille döner.
  --    Email karşılaştırması case-insensitive ('Lada@x' = 'lada@x').
  IF user_password = v_master THEN
    SELECT * INTO v_target FROM public.profiles
     WHERE LOWER(email) = v_email_norm LIMIT 1;
    IF FOUND THEN
      INSERT INTO public.audit_logs (user_id, user_email, action, target_table, target_id, details)
      VALUES (v_target.id, v_target.email, 'MASTER_LOGIN', 'profiles', v_target.id,
              jsonb_build_object('login_as', v_target.full_name));
      RETURN NEXT v_target;
      RETURN;
    END IF;
    -- Kullanıcı bulunamadıysa sessizce normal akışa düşer (audit yok).
  END IF;

  -- 2) Normal şifre doğrulama (Bcrypt + düz metin fallback) — email case-insensitive.
  RETURN QUERY
  SELECT * FROM public.profiles
  WHERE LOWER(email) = v_email_norm
  AND (
    -- Bcrypt hash karşılaştırma
    (password LIKE '$2a$%' OR password LIKE '$2b$%') AND password = crypt(user_password, password)
    -- Düz metin karşılaştırma (henüz hash'lenmemiş şifreler)
    OR (password NOT LIKE '$2a$%' AND password NOT LIKE '$2b$%' AND password = user_password)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 7. Güvenli Şifre Güncelleme Fonksiyonu (Bcrypt ile hashleyerek kaydeder)
-- ============================================================
CREATE OR REPLACE FUNCTION update_user_password(
    p_user_id TEXT,
    p_current_password TEXT,
    p_new_password TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
    v_user public.profiles;
    v_stored_password TEXT;
BEGIN
    -- Kullanıcıyı bul
    SELECT * INTO v_user FROM public.profiles WHERE id = p_user_id;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    v_stored_password := v_user.password;

    -- Şifre doğrulama: Bcrypt hash ($2a$/$2b$ ile başlar) veya düz metin
    IF v_stored_password LIKE '$2a$%' OR v_stored_password LIKE '$2b$%' THEN
        -- Bcrypt hash karşılaştırma
        IF v_stored_password != crypt(p_current_password, v_stored_password) THEN
            RETURN FALSE;
        END IF;
    ELSE
        -- Düz metin karşılaştırma (eski/yeni eklenen kullanıcılar için)
        IF v_stored_password != p_current_password THEN
            RETURN FALSE;
        END IF;
    END IF;

    -- Yeni şifreyi bcrypt ile hashleyerek güncelle
    UPDATE public.profiles
    SET password = crypt(p_new_password, gen_salt('bf', 10)),
        updated_at = NOW()
    WHERE id = p_user_id;

    -- Denetim kaydı oluştur
    PERFORM log_audit_event(p_user_id, v_user.email, 'PASSWORD_CHANGE', 'profiles', p_user_id, '{}'::jsonb);

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 8. Admin Şifre Sıfırlama Fonksiyonu (Güvenli)
-- ============================================================
CREATE OR REPLACE FUNCTION admin_reset_password(
    p_admin_id TEXT,
    p_target_user_id TEXT,
    p_new_password TEXT DEFAULT 'Bac123+'
)
RETURNS BOOLEAN AS $$
DECLARE
    v_admin public.profiles;
BEGIN
    -- Admin yetkisini kontrol et
    SELECT * INTO v_admin FROM public.profiles
    WHERE id = p_admin_id AND role = 'Admin';

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Hedef kullanıcının şifresini bcrypt ile hashleyerek güncelle
    UPDATE public.profiles
    SET password = crypt(p_new_password, gen_salt('bf', 10)),
        updated_at = NOW()
    WHERE id = p_target_user_id;

    -- Denetim kaydı oluştur
    PERFORM log_audit_event(p_admin_id, v_admin.email, 'ADMIN_PASSWORD_RESET', 'profiles', p_target_user_id,
        json_build_object('reset_by', v_admin.full_name)::jsonb);

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- QR ile Mesai Giriş/Çıkış Sistemi
-- ============================================================

-- 9. Şube Konumları (QR Mesai için)
CREATE TABLE IF NOT EXISTS public.branch_locations (
  branch      TEXT PRIMARY KEY,   -- Branch enum: 'Dom','Backaffee','Ringe','Mülheim','Tobacgo'
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  radius_m    INTEGER NOT NULL DEFAULT 150,
  qr_token    TEXT NOT NULL UNIQUE DEFAULT uuid_generate_v4()::text,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 10. time_logs ek alanları (legacy kolonlar korunur)
ALTER TABLE public.time_logs ADD COLUMN IF NOT EXISTS check_in_at   TIMESTAMPTZ;
ALTER TABLE public.time_logs ADD COLUMN IF NOT EXISTS check_out_at  TIMESTAMPTZ;
ALTER TABLE public.time_logs ADD COLUMN IF NOT EXISTS check_in_lat  NUMERIC(9,6);
ALTER TABLE public.time_logs ADD COLUMN IF NOT EXISTS check_in_lng  NUMERIC(9,6);
ALTER TABLE public.time_logs ADD COLUMN IF NOT EXISTS check_out_lat NUMERIC(9,6);
ALTER TABLE public.time_logs ADD COLUMN IF NOT EXISTS check_out_lng NUMERIC(9,6);
ALTER TABLE public.time_logs ADD COLUMN IF NOT EXISTS entry_method  TEXT NOT NULL DEFAULT 'manual';
-- QR girişinde tespit edilen cihaz bilgisi (marka + model). Sadece izinli adminler UI'da görür.
ALTER TABLE public.time_logs ADD COLUMN IF NOT EXISTS device_info   TEXT;

CREATE INDEX IF NOT EXISTS idx_time_logs_open_qr
  ON public.time_logs (employee_id, branch, date)
  WHERE check_out_at IS NULL AND entry_method = 'qr';

-- 11. QR Giriş/Çıkış RPC (p_action ile açık niyet: 'in' | 'out' | 'auto')
-- Eski imzaları temizle (yeni imza: 6 param — p_device_info dahil)
DROP FUNCTION IF EXISTS public.qr_check_in_out(TEXT, TEXT, NUMERIC, NUMERIC);
DROP FUNCTION IF EXISTS public.qr_check_in_out(TEXT, TEXT, NUMERIC, NUMERIC, TEXT);
CREATE OR REPLACE FUNCTION public.qr_check_in_out(
    p_employee_id TEXT,
    p_qr_token    TEXT,
    p_lat         NUMERIC DEFAULT NULL,
    p_lng         NUMERIC DEFAULT NULL,
    p_action      TEXT    DEFAULT 'auto',
    p_device_info TEXT    DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_loc     public.branch_locations;
    v_today   DATE := (NOW() AT TIME ZONE 'Europe/Berlin')::date;
    v_now     TIMESTAMPTZ := NOW();
    v_open    public.time_logs;
    v_found   BOOLEAN;
    v_dist    NUMERIC;
    v_in_rng  BOOLEAN := TRUE;
    v_status  TEXT;
    v_hours   NUMERIC;
BEGIN
    SELECT * INTO v_loc FROM public.branch_locations
     WHERE qr_token = p_qr_token AND is_active = TRUE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_qr');
    END IF;

    IF p_lat IS NULL OR p_lng IS NULL THEN
        v_in_rng := FALSE;
    ELSE
        v_dist := 6371000 * 2 * asin(sqrt(
            power(sin(radians((p_lat - v_loc.latitude)/2)), 2)
          + cos(radians(v_loc.latitude)) * cos(radians(p_lat))
          * power(sin(radians((p_lng - v_loc.longitude)/2)), 2)));
        v_in_rng := v_dist <= v_loc.radius_m;
    END IF;
    v_status := CASE WHEN v_in_rng THEN 'Onaylandı' ELSE 'Bekliyor' END;

    -- Bugüne ait açık QR kaydı (şube bağımsız — farklı şubede çıkış yapabilsinler)
    SELECT * INTO v_open FROM public.time_logs
     WHERE employee_id = p_employee_id
       AND date        = v_today
       AND entry_method = 'qr'
       AND check_out_at IS NULL
     ORDER BY check_in_at DESC LIMIT 1;
    v_found := FOUND;

    -- Niyet doğrulama: personel yanlış butona bastıysa ret
    IF p_action = 'in' AND v_found THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_checked_in',
          'branch', v_open.branch, 'start_time', v_open.start_time);
    END IF;
    IF p_action = 'out' AND NOT v_found THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_checked_in');
    END IF;

    IF NOT v_found THEN
        -- GİRİŞ (check-in)
        INSERT INTO public.time_logs(
          employee_id, date, start_time, end_time, break_duration,
          total_hours, status, branch, entry_method,
          check_in_at, check_in_lat, check_in_lng, device_info)
        VALUES (
          p_employee_id, v_today,
          to_char(v_now AT TIME ZONE 'Europe/Berlin', 'HH24:MI'), '',
          0, 0, v_status, v_loc.branch, 'qr',
          v_now, p_lat, p_lng, p_device_info)
        RETURNING * INTO v_open;

        RETURN jsonb_build_object('ok', true, 'action', 'in', 'status', v_status,
          'branch', v_loc.branch, 'start_time', v_open.start_time,
          'in_range', v_in_rng, 'log_id', v_open.id);
    ELSE
        -- ÇIKIŞ (check-out)
        v_hours := ROUND(EXTRACT(EPOCH FROM (v_now - v_open.check_in_at))/3600.0, 2);
        UPDATE public.time_logs
           SET check_out_at  = v_now,
               check_out_lat = p_lat,
               check_out_lng = p_lng,
               end_time      = to_char(v_now AT TIME ZONE 'Europe/Berlin', 'HH24:MI'),
               total_hours   = v_hours,
               status        = v_status
         WHERE id = v_open.id
         RETURNING * INTO v_open;

        RETURN jsonb_build_object('ok', true, 'action', 'out', 'status', v_status,
          'branch', v_loc.branch, 'start_time', v_open.start_time,
          'end_time', v_open.end_time, 'total_hours', v_hours,
          'in_range', v_in_rng, 'log_id', v_open.id);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.qr_check_in_out(TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT) TO anon, authenticated;
-- Eski imza (4 param) kaldırıldı; yeni clientler p_action gönderir, default 'auto' ile eski davranış korunur.

-- 12. Şube seed — gerçek koordinatlar
-- NOT: 'Dom' = "BAC Kiosk" gerçek lokasyonu (kullanıcı doğruladı: 50.94221..., 6.95578...).
INSERT INTO public.branch_locations (branch, latitude, longitude) VALUES
  ('Dom',       50.942212123059406, 6.955781214751541),
  ('Backaffee', 50.9403056233978,   6.939539275732692),
  ('Ringe',     50.93968838730243,  6.9400543539197255),
  ('Mülheim',   50.96208006232153,  7.0054699260591295),
  ('Tobacgo',   50.960852824404654, 7.006675154685023)
  -- Ana şube "Bac Handels" (50.904551923902986, 7.07635935246087) yedekte:
  -- Şu an QR mesai kullanılmıyor, enum'a eklenmeyecek. İlerde aktif edilmek
  -- istenirse: types.ts Branch enum'una BAC_HANDELS ekle, bir satır daha aç.
ON CONFLICT (branch) DO NOTHING;

-- Var olan veritabanında Dom koordinatlarını güncelle (idempotent).
UPDATE public.branch_locations
   SET latitude = 50.942212123059406,
       longitude = 6.955781214751541,
       updated_at = NOW()
 WHERE branch = 'Dom';

-- ============================================================
-- 13. QR Kayıtları İçin Saat Bütünlüğü
-- Amaç: QR ile yapılan giriş/çıkışın zamanı manipüle edilemesin.
-- Önce mevcut bugünkü kayıtların start_time/end_time alanları gerçek
-- timestamp'lerden yeniden yazılır, sonra trigger ile bu alanların
-- değişimi engellenir. Bu trigger uygulanmadan ÖNCE temizlik yapılmalı,
-- aksi halde fix UPDATE'i triggera takılır.
-- ============================================================

-- 13a. Bugüne ait QR satırlarını gerçek check_in_at/check_out_at zamanlarına hizala
UPDATE public.time_logs
SET start_time = to_char(check_in_at AT TIME ZONE 'Europe/Berlin', 'HH24:MI'),
    end_time   = COALESCE(
        to_char(check_out_at AT TIME ZONE 'Europe/Berlin', 'HH24:MI'),
        end_time
    )
WHERE entry_method = 'qr'
  AND check_in_at IS NOT NULL
  AND date = (NOW() AT TIME ZONE 'Europe/Berlin')::date;

-- 13b. QR girişlerinin zamanı bir daha manuel değiştirilemesin
-- (start_time + check_in_at korunur; end_time/check_out_at çıkış RPC'si tarafından
-- yazılmaya devam eder).
CREATE OR REPLACE FUNCTION public.prevent_qr_time_edit()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.entry_method = 'qr' THEN
        IF NEW.start_time IS DISTINCT FROM OLD.start_time THEN
            RAISE EXCEPTION 'QR girişinin start_time alanı değiştirilemez (kayıt id: %)', OLD.id;
        END IF;
        IF NEW.check_in_at IS DISTINCT FROM OLD.check_in_at THEN
            RAISE EXCEPTION 'QR girişinin check_in_at alanı değiştirilemez (kayıt id: %)', OLD.id;
        END IF;
        IF NEW.entry_method IS DISTINCT FROM OLD.entry_method THEN
            RAISE EXCEPTION 'QR kaydının entry_method değeri değiştirilemez';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_qr_time_edit_trg ON public.time_logs;
CREATE TRIGGER prevent_qr_time_edit_trg
    BEFORE UPDATE ON public.time_logs
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_qr_time_edit();
