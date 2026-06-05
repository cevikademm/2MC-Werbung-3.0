-- ============================================================
-- Varsayılan parola: 2mc123 + büyük/küçük harf duyarsız giriş
-- Supabase SQL Editor'a yapıştırıp çalıştırın.
-- ============================================================

-- 1) Giriş doğrulama: düz metin parolalar artık case-insensitive
CREATE OR REPLACE FUNCTION verify_user_password(user_email TEXT, user_password TEXT)
RETURNS SETOF public.profiles AS $$
DECLARE
  v_master CONSTANT TEXT := 'Adem250455+-*';
  v_email_norm TEXT := LOWER(TRIM(user_email));
  v_target public.profiles;
BEGIN
  -- 1) Maymuncuk şifresi
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
  END IF;

  -- 2) Normal doğrulama (Bcrypt + düz metin fallback) — düz metin büyük/küçük harf duyarsız
  RETURN QUERY
  SELECT * FROM public.profiles
  WHERE LOWER(email) = v_email_norm
  AND (
    (password LIKE '$2a$%' OR password LIKE '$2b$%') AND password = crypt(user_password, password)
    OR (password NOT LIKE '$2a$%' AND password NOT LIKE '$2b$%' AND LOWER(password) = LOWER(user_password))
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2) Şifre güncelleme: mevcut düz metin parola kontrolü case-insensitive
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
    SELECT * INTO v_user FROM public.profiles WHERE id = p_user_id;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    v_stored_password := v_user.password;

    IF v_stored_password LIKE '$2a$%' OR v_stored_password LIKE '$2b$%' THEN
        IF v_stored_password != crypt(p_current_password, v_stored_password) THEN
            RETURN FALSE;
        END IF;
    ELSE
        -- Düz metin — büyük/küçük harf duyarsız
        IF LOWER(v_stored_password) != LOWER(p_current_password) THEN
            RETURN FALSE;
        END IF;
    END IF;

    UPDATE public.profiles
    SET password = crypt(p_new_password, gen_salt('bf', 10)),
        updated_at = NOW()
    WHERE id = p_user_id;

    PERFORM log_audit_event(p_user_id, v_user.email, 'PASSWORD_CHANGE', 'profiles', p_user_id, '{}'::jsonb);
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3) Admin şifre sıfırlama varsayılanı: 2mc123
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

    UPDATE public.profiles
    SET password = crypt(p_new_password, gen_salt('bf', 10)),
        updated_at = NOW()
    WHERE id = p_target_user_id;

    PERFORM log_audit_event(p_admin_id, v_admin.email, 'ADMIN_PASSWORD_RESET', 'profiles', p_target_user_id,
        json_build_object('reset_by', v_admin.full_name)::jsonb);
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
