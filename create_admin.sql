-- =====================================================================
-- YENİ ADMIN OLUŞTUR (2MC Werbung - ilk giriş için)
-- Hedef proje: wgfkoxjlcovrkzrustpy.supabase.co
-- Kullanım: Supabase Dashboard > SQL Editor > New Query > Yapıştır > Run
--
-- Bu script:
--   1) Cevik Adem (admin) hesabını oluşturur
--   2) Şifreyi bcrypt ile hashleyerek kaydeder (login.tsx ile uyumlu)
--   3) Hata olursa (email çakışırsa) sadece şifreyi günceller
--
-- Login bilgileri (script çalıştıktan sonra):
--   E-posta : cevikademm@gmail.com
--   Şifre   : Adem123
--
-- ⚠ Giriş yaptıktan sonra UI'dan "Profilim → Şifre Değiştir" ile
--   şifrenizi güvenli bir şeyle değiştirin.
--
-- Şifreyi şimdi farklı yapmak istersen aşağıdaki 'Adem123' yazılı 2 yeri
-- (INSERT içinde + ON CONFLICT içinde) yeni şifrenle değiştir.
-- =====================================================================

INSERT INTO public.profiles (
  id,
  full_name,
  email,
  password,
  role,
  branch,
  hourly_rate,
  avatar_url
)
VALUES (
  'admin_1',
  'Cevik Adem',
  'cevikademm@gmail.com',
  crypt('Adem123', gen_salt('bf', 10)),
  'Admin',
  NULL,                       -- şube yok (2MC Werbung tek lokasyon)
  30.00,
  'https://wgfkoxjlcovrkzrustpy.supabase.co/storage/v1/object/public/sales_receipts/logo_werbung%20(1).png'
)
ON CONFLICT (email) DO UPDATE
   SET password = crypt('Adem123', gen_salt('bf', 10)),
       role     = 'Admin',
       full_name = EXCLUDED.full_name,
       updated_at = NOW();

-- Doğrulama
SELECT id, full_name, email, role, branch, created_at
  FROM public.profiles
 WHERE email = 'cevikademm@gmail.com';
