-- =====================================================================
-- TEK SEFERLİK YENİ ŞİRKET DB KURULUMU
-- Hedef proje: wgfkoxjlcovrkzrustpy.supabase.co
-- Kullanım: Supabase Dashboard > SQL Editor > New Query > Yapıştır > Run
--
-- İçerik: db_schema.sql (taban) + supabase/*.sql (15 ek migration)
-- Bağımlılık sırasına göre dizilmiştir. Hepsi IF NOT EXISTS /
-- CREATE OR REPLACE kullanır, idempotenttir — tekrar çalıştırılabilir.
--
-- ÖNEMLİ: Çalıştırmadan önce Dashboard > Database > Extensions'tan
--   - uuid-ossp
--   - pgcrypto
--   - pg_net   (live_locations + notify_event için)
-- aktif olduğundan emin ol (zaten ilk SQL bunları CREATE eder ama
-- pg_net için bazen UI'dan enable gerekir).
-- =====================================================================



-- =====================================================================
-- [01/16] db_schema.sql
-- =====================================================================


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
    -- Düz metin karşılaştırma (henüz hash'lenmemiş şifreler) — büyük/küçük harf duyarsız
    OR (password NOT LIKE '$2a$%' AND password NOT LIKE '$2b$%' AND LOWER(password) = LOWER(user_password))
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
        -- Düz metin karşılaştırma (eski/yeni eklenen kullanıcılar için) — büyük/küçük harf duyarsız
        IF LOWER(v_stored_password) != LOWER(p_current_password) THEN
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
    p_new_password TEXT DEFAULT '2mc123'
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


-- =====================================================================
-- [02/16] supabase/notification_prefs_migration.sql
-- =====================================================================

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


-- =====================================================================
-- [03/16] supabase/notification_log_migration.sql
-- =====================================================================

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

-- pg_cron ile her gece 03:00 UTC çalışsın (pg_cron yoksa sessizce atla)
DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-old-notifications');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.schedule(
    'cleanup-old-notifications',
    '0 3 * * *',
    $cron$ SELECT public.cleanup_old_notifications(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron yok — cleanup-old-notifications planlanamadı: %', SQLERRM;
END $$;


-- =====================================================================
-- [04/16] supabase/shift_publications_migration.sql
-- =====================================================================

-- ===================================================================
-- VARDİYA ONAY/YAYINLAMA SİSTEMİ — Supabase Migration
-- Çalıştırma: Supabase Dashboard > SQL Editor > Run
--
-- Amaç: Admin haftalık vardiyayı hazırlar; "Yayınla" butonuna basana
--       kadar personel listesinde görünmez. Bu tablo (week_start_date,
--       branch) çiftine bağlı tek satır onay kaydı tutar.
--
-- Kayıt yoksa → vardiya taslak, personellere gizli.
-- Kayıt varsa → yayında, tüm personeller görebilir.
-- Admin kaydı silerek yayını geri çekebilir.
-- ===================================================================

CREATE TABLE IF NOT EXISTS public.shift_publications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start_date  date        NOT NULL,
  branch           text        NOT NULL,
  published_at     timestamptz NOT NULL DEFAULT NOW(),
  -- profiles.id TEXT olduğu için published_by da TEXT (mevcut şema ile uyumlu)
  published_by     text,
  published_by_name text,
  CONSTRAINT shift_publications_week_branch_unique UNIQUE (week_start_date, branch)
);

CREATE INDEX IF NOT EXISTS idx_shift_publications_lookup
  ON public.shift_publications (week_start_date, branch);

-- RLS aç
ALTER TABLE public.shift_publications ENABLE ROW LEVEL SECURITY;

-- Mevcut policy'leri temizle (idempotent migration)
DROP POLICY IF EXISTS "shift_publications_read_all"   ON public.shift_publications;
DROP POLICY IF EXISTS "shift_publications_write_open" ON public.shift_publications;

-- Herkes okuyabilir — personel onay durumunu görmesi için
CREATE POLICY "shift_publications_read_all"
  ON public.shift_publications FOR SELECT
  USING (true);

-- Yazma açık — uygulama tarafında isAdmin kontrolü zaten yapılıyor.
-- (Mevcut shift_schedules tablosuyla aynı pattern.)
CREATE POLICY "shift_publications_write_open"
  ON public.shift_publications FOR ALL
  USING (true)
  WITH CHECK (true);

-- PostgREST schema cache'ini hemen yenile — uygulama bekleyip schema reload
-- olmadan tablo bulunamadı hatası almasın.
NOTIFY pgrst, 'reload schema';

-- Realtime publication: yayın değişiklikleri tüm bağlı cihazlara anında
-- yansısın. supabase_realtime publication zaten Supabase'de hazır gelir;
-- buraya tabloyu eklemezsek INSERT/DELETE event'leri yayılmaz.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.shift_publications;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
    BEGIN
      -- shift_schedules da realtime'a eklensin: admin satır eklediğinde/sildiğinde
      -- diğer admin ve personel cihazlarında canlı yansısın.
      ALTER PUBLICATION supabase_realtime ADD TABLE public.shift_schedules;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;
END$$;


-- =====================================================================
-- [05/16] supabase/dom_coords_update.sql
-- =====================================================================

-- =============================================================
-- dom_coords_update.sql
-- =============================================================
-- Dom şubesinin koordinatları güncellendi.
-- Eski: 50.94032812642508, 6.939643179081483
-- Yeni: 50.942212123059406, 6.955781214751541
--
-- branch_locations tek satırı UPDATE et. Geofence ve diğer alanlar
-- aynı kalır. Idempotent — birden çok kez çalıştırılabilir.
-- =============================================================

UPDATE public.branch_locations
   SET latitude  = 50.942212123059406,
       longitude = 6.955781214751541,
       updated_at = NOW()
 WHERE branch = 'Dom';


-- =====================================================================
-- [06/16] supabase/live_locations_migration.sql
-- =====================================================================

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


-- =====================================================================
-- [07/16] supabase/location_history_migration.sql
-- =====================================================================

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


-- =====================================================================
-- [08/16] supabase/live_location_first_ping_fix.sql
-- =====================================================================

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


-- =====================================================================
-- [09/16] supabase/loss_control_migration.sql
-- =====================================================================

-- ===================================
-- KAYIP ÖNLEME SİSTEMİ - Supabase Migration
-- Hedef proje: xbbzwitvlrdwnoushgpf.supabase.co
-- Çalıştırma: Supabase Dashboard > SQL Editor > Run
-- ===================================

-- 1. STOK GİRİŞLERİ TABLOSU
CREATE TABLE IF NOT EXISTS public.stock_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  entered_by TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. FİZİKSEL SAYIM TABLOSU
CREATE TABLE IF NOT EXISTS public.stock_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  counted_quantity INTEGER NOT NULL CHECK (counted_quantity >= 0),
  count_date DATE NOT NULL DEFAULT CURRENT_DATE,
  counted_by TEXT REFERENCES public.profiles(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. INDEX'LER
CREATE INDEX IF NOT EXISTS idx_stock_entries_branch ON public.stock_entries(branch);
CREATE INDEX IF NOT EXISTS idx_stock_entries_date   ON public.stock_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_stock_entries_product ON public.stock_entries(product_name);
CREATE INDEX IF NOT EXISTS idx_stock_counts_branch  ON public.stock_counts(branch);
CREATE INDEX IF NOT EXISTS idx_stock_counts_date    ON public.stock_counts(count_date);
CREATE INDEX IF NOT EXISTS idx_stock_counts_product ON public.stock_counts(product_name);

-- 4. RLS — projedeki diğer tablolarla aynı pattern (current_setting('app.current_user_role'))
ALTER TABLE public.stock_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_counts  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_entries_select_all" ON public.stock_entries;
DROP POLICY IF EXISTS "stock_entries_admin_all"  ON public.stock_entries;
DROP POLICY IF EXISTS "stock_counts_select_all"  ON public.stock_counts;
DROP POLICY IF EXISTS "stock_counts_admin_all"   ON public.stock_counts;

CREATE POLICY "stock_entries_select_all" ON public.stock_entries FOR SELECT USING (true);
CREATE POLICY "stock_entries_admin_all"  ON public.stock_entries FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

CREATE POLICY "stock_counts_select_all"  ON public.stock_counts FOR SELECT USING (true);
CREATE POLICY "stock_counts_admin_all"   ON public.stock_counts FOR ALL
  USING (current_setting('app.current_user_role', true) = 'Admin')
  WITH CHECK (current_setting('app.current_user_role', true) = 'Admin');

-- 5. Realtime publication (diğer tablolarla tutarlı)
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_entries; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_counts;  EXCEPTION WHEN OTHERS THEN NULL; END $$;


-- =====================================================================
-- [10/16] supabase/loss_control_rls_fix.sql
-- =====================================================================

-- ===================================
-- KAYIP ÖNLEME RLS DÜZELTMESİ
-- Hedef proje: xbbzwitvlrdwnoushgpf.supabase.co
-- Çalıştırma: Supabase Dashboard > SQL Editor > Run
--
-- Sorun: stock_entries ve stock_counts policy'leri current_setting('app.current_user_role')
-- kullanıyor ama uygulama bu session değişkenini set etmiyor → INSERT 401.
-- Çözüm: Diğer tablolarla (sales_logs, vb.) tutarlı şekilde permissive policy.
-- Erişim kontrolü zaten frontend'de canAccessLossControl() ile yapılıyor.
-- ===================================

DROP POLICY IF EXISTS "stock_entries_select_all" ON public.stock_entries;
DROP POLICY IF EXISTS "stock_entries_admin_all"  ON public.stock_entries;
DROP POLICY IF EXISTS "stock_counts_select_all"  ON public.stock_counts;
DROP POLICY IF EXISTS "stock_counts_admin_all"   ON public.stock_counts;

CREATE POLICY "stock_entries_all" ON public.stock_entries
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "stock_counts_all" ON public.stock_counts
  FOR ALL USING (true) WITH CHECK (true);


-- =====================================================================
-- [11/16] supabase/loss_control_admin_only.sql
-- =====================================================================

-- ===================================================================
-- KAYIP ÖNLEME — ADMIN-ONLY ERİŞİM (Supabase Migration)
-- Hedef proje: xbbzwitvlrdwnoushgpf.supabase.co
-- Çalıştırma: Supabase Dashboard > SQL Editor > Run
--
-- Amaç: stock_entries ve stock_counts tablolarına yalnızca
--       admin personel + LOSS_CONTROL_ALLOWED_EMAILS hesapları erişebilir.
--       Doğrudan REST erişimi RLS ile kapatılır; tüm okuma/yazma işlemleri
--       SECURITY DEFINER RPC fonksiyonları üzerinden yapılır ve her çağrıda
--       caller_id'nin yetkili olup olmadığı kontrol edilir.
--
-- Not: profiles.id şeması TEXT olduğu için tüm caller_id parametreleri TEXT.
-- Frontend (LossControl.tsx) bu RPC'leri kullanmak üzere güncellendi.
-- ===================================================================

-- 1) Yetki kontrol fonksiyonu ----------------------------------------
-- Bir kullanıcının kayıp önleme verilerine erişimi olup olmadığını döndürür.
CREATE OR REPLACE FUNCTION public.lc_is_authorized(p_caller_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = p_caller_id
       AND (
         role = 'Admin'
         OR LOWER(TRIM(email)) IN ('cevikademm@gmail.com', 'gurcan@bac.de')
       )
  );
$$;

COMMENT ON FUNCTION public.lc_is_authorized(TEXT) IS
  'Kayıp Önleme verilerine erişim hakkı (Admin rolü VEYA allowlist email).';

-- 2) Liste RPC'leri --------------------------------------------------

CREATE OR REPLACE FUNCTION public.lc_list_stock_entries(p_caller_id TEXT)
RETURNS SETOF public.stock_entries
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim: Kayıp Önleme verilerine yalnızca yetkili admin hesapları erişebilir.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT *
    FROM public.stock_entries
    ORDER BY entry_date DESC, created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.lc_list_stock_counts(p_caller_id TEXT)
RETURNS SETOF public.stock_counts
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim: Kayıp Önleme verilerine yalnızca yetkili admin hesapları erişebilir.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
  SELECT *
    FROM public.stock_counts
    ORDER BY count_date DESC, created_at DESC;
END;
$$;

-- 3) Yazma RPC'leri --------------------------------------------------
-- p_id = NULL → INSERT, p_id dolu → UPDATE.

CREATE OR REPLACE FUNCTION public.lc_save_stock_entry(
  p_caller_id    TEXT,
  p_id           UUID,
  p_product_name TEXT,
  p_branch       TEXT,
  p_quantity     INT,
  p_entry_date   DATE,
  p_note         TEXT
) RETURNS public.stock_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.stock_entries;
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim.' USING ERRCODE = 'P0001';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.stock_entries (product_name, branch, quantity, entry_date, entered_by, note)
    VALUES (p_product_name, p_branch, p_quantity, p_entry_date, p_caller_id, p_note)
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.stock_entries
       SET product_name = p_product_name,
           branch       = p_branch,
           quantity     = p_quantity,
           entry_date   = p_entry_date,
           note         = p_note
     WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.lc_save_stock_count(
  p_caller_id        TEXT,
  p_id               UUID,
  p_product_name     TEXT,
  p_branch           TEXT,
  p_counted_quantity INT,
  p_count_date       DATE,
  p_note             TEXT
) RETURNS public.stock_counts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.stock_counts;
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim.' USING ERRCODE = 'P0001';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.stock_counts (product_name, branch, counted_quantity, count_date, counted_by, note)
    VALUES (p_product_name, p_branch, p_counted_quantity, p_count_date, p_caller_id, p_note)
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.stock_counts
       SET product_name     = p_product_name,
           branch           = p_branch,
           counted_quantity = p_counted_quantity,
           count_date       = p_count_date,
           note             = p_note
     WHERE id = p_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.lc_delete_stock_entry(p_caller_id TEXT, p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.stock_entries WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.lc_delete_stock_count(p_caller_id TEXT, p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.lc_is_authorized(p_caller_id) THEN
    RAISE EXCEPTION 'Yetkisiz erişim.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM public.stock_counts WHERE id = p_id;
END;
$$;

-- 4) RLS sıkılaştırma — doğrudan REST erişimi kapatılır --------------
ALTER TABLE public.stock_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_counts  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_entries_all"        ON public.stock_entries;
DROP POLICY IF EXISTS "stock_entries_select_all" ON public.stock_entries;
DROP POLICY IF EXISTS "stock_entries_admin_all"  ON public.stock_entries;
DROP POLICY IF EXISTS "stock_entries_no_direct"  ON public.stock_entries;

DROP POLICY IF EXISTS "stock_counts_all"         ON public.stock_counts;
DROP POLICY IF EXISTS "stock_counts_select_all"  ON public.stock_counts;
DROP POLICY IF EXISTS "stock_counts_admin_all"   ON public.stock_counts;
DROP POLICY IF EXISTS "stock_counts_no_direct"   ON public.stock_counts;

-- Doğrudan REST sorgusu yapılırsa hiçbir satır dönmez, yazılamaz.
-- SECURITY DEFINER RPC'ler bu RLS'i bypass eder (definer = postgres role).
CREATE POLICY "stock_entries_no_direct" ON public.stock_entries
  FOR ALL USING (false) WITH CHECK (false);

CREATE POLICY "stock_counts_no_direct" ON public.stock_counts
  FOR ALL USING (false) WITH CHECK (false);

-- 5) RPC çalıştırma izinleri -----------------------------------------
GRANT EXECUTE ON FUNCTION public.lc_is_authorized(TEXT)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_list_stock_entries(TEXT)   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_list_stock_counts(TEXT)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_save_stock_entry(TEXT, UUID, TEXT, TEXT, INT, DATE, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_save_stock_count(TEXT, UUID, TEXT, TEXT, INT, DATE, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_delete_stock_entry(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lc_delete_stock_count(TEXT, UUID) TO anon, authenticated;

-- 6) Realtime publication güncelle (tablolar zaten ekliydi, idempotent)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_entries;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.stock_counts;
EXCEPTION WHEN OTHERS THEN NULL; END $$;


-- =====================================================================
-- [12/16] supabase/qr_scan_attempts_migration.sql
-- =====================================================================

-- ============================================================
-- QR SCAN ATTEMPTS — Migration
-- ============================================================
-- Her QR mesai denemesini (başarılı / başarısız) loglar.
-- Cihaz Markaları sekmesindeki "Okutmayanlar" ve "Hatalar"
-- görünümleri bu tabloyu kullanır.
--
-- time_logs sadece BAŞARILI check-in/out'u tutar; bu tablo ek
-- olarak başarısız denemeleri de tutar ki "kim hata aldı, neden"
-- görülebilsin.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.qr_scan_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    TEXT REFERENCES public.profiles(id) ON DELETE CASCADE,
  employee_name  TEXT,            -- snapshot — profil silinse de raporlanabilsin
  status         TEXT NOT NULL,   -- 'success' | 'error'
  error_kind     TEXT,            -- camera_denied | no_camera | insecure_context | network
                                  -- | invalid_qr | already_checked_in | not_checked_in | other
  error_detail   TEXT,
  action         TEXT,            -- 'in' | 'out' (denemenin niyeti)
  branch         TEXT,
  device_info    TEXT,            -- "Apple iPhone · 62:4A:..." veya null
  user_agent     TEXT,
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qr_scan_attempts_status_check CHECK (status IN ('success','error'))
);

CREATE INDEX IF NOT EXISTS idx_qr_scan_attempts_attempted_desc
  ON public.qr_scan_attempts (attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_qr_scan_attempts_employee_attempted
  ON public.qr_scan_attempts (employee_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_qr_scan_attempts_status_attempted
  ON public.qr_scan_attempts (status, attempted_at DESC);

-- RLS: client kendi denemelerini INSERT edebilir, sadece adminler SELECT.
-- Mevcut projedeki diğer tablolar gibi permissive policy + UI tarafında
-- email whitelist (canSeeDeviceInfo) ile filtre uyguluyoruz.
ALTER TABLE public.qr_scan_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "qr_scan_attempts_anon_all" ON public.qr_scan_attempts;
CREATE POLICY "qr_scan_attempts_anon_all" ON public.qr_scan_attempts
  FOR ALL USING (true) WITH CHECK (true);

-- Realtime: yeni hata anında Cihaz Markaları > Hatalar sekmesine düşsün
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.qr_scan_attempts;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ============================================================
-- 90 GÜNDEN ESKİ KAYITLARI TEMİZLE
-- ============================================================
CREATE OR REPLACE FUNCTION public.cleanup_old_qr_attempts()
RETURNS INTEGER AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.qr_scan_attempts
   WHERE attempted_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-old-qr-attempts');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.schedule(
    'cleanup-old-qr-attempts',
    '15 3 * * *',
    $cron$ SELECT public.cleanup_old_qr_attempts(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron yok — cleanup-old-qr-attempts planlanamadı: %', SQLERRM;
END $$;


-- =====================================================================
-- [13/16] supabase/sales_receipts.sql
-- =====================================================================

-- =====================================================
-- SALES_LOGS: FİŞ FOTOĞRAFI EKLEME
-- - Her satış girişine receipt_url alanı (Supabase Storage URL'i)
-- - sales_receipts public bucket'ı (anonymous read için)
-- - Anon ile upload + read RLS politikaları
-- =====================================================

-- 1. receipt_url kolonu
ALTER TABLE sales_logs ADD COLUMN IF NOT EXISTS receipt_url TEXT;

-- 2. Storage bucket (publicly readable, kayıt resimleri için)
INSERT INTO storage.buckets (id, name, public)
VALUES ('sales_receipts', 'sales_receipts', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- 3. RLS — anon read & insert (uygulama anon key kullanıyor)
DROP POLICY IF EXISTS "sales_receipts_read"   ON storage.objects;
DROP POLICY IF EXISTS "sales_receipts_insert" ON storage.objects;
DROP POLICY IF EXISTS "sales_receipts_update" ON storage.objects;
DROP POLICY IF EXISTS "sales_receipts_delete" ON storage.objects;

CREATE POLICY "sales_receipts_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'sales_receipts');

CREATE POLICY "sales_receipts_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'sales_receipts');

CREATE POLICY "sales_receipts_update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'sales_receipts')
  WITH CHECK (bucket_id = 'sales_receipts');

CREATE POLICY "sales_receipts_delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'sales_receipts');

-- =====================================================
-- NOT: Bu SQL'i Supabase Dashboard > SQL Editor'da çalıştırın.
-- =====================================================


-- =====================================================================
-- [14/16] supabase/sales_logs_off_shift.sql
-- =====================================================================

-- =====================================================
-- SALES_LOGS: MESAİ DIŞI SATIŞ TAKİBİ
-- Satış girişi anında kullanıcı vardiyada değilse
-- (evdeyse) bu kayıt is_off_shift = true ile işaretlenir.
-- Frontend hem girişi engeller hem de yöneticilerin
-- (cevikademm@gmail.com, gurcan@bac.de) tabloda
-- "MESAİ DIŞI" rozeti görmesini sağlar.
-- =====================================================

ALTER TABLE sales_logs
  ADD COLUMN IF NOT EXISTS is_off_shift BOOLEAN NOT NULL DEFAULT FALSE;

-- Yönetici panelinde mesai-dışı kayıtları hızlı filtrelemek için index.
CREATE INDEX IF NOT EXISTS idx_sales_logs_off_shift
  ON sales_logs(is_off_shift)
  WHERE is_off_shift = TRUE;

-- =====================================================
-- NOT: Bu SQL'i Supabase Dashboard > SQL Editor'da çalıştırın.
-- =====================================================


-- =====================================================================
-- [15/16] supabase/overtime_and_validator_migration.sql
-- =====================================================================

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


-- =====================================================================
-- [16/16] supabase/auto_close_pending_migration.sql
-- =====================================================================

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
