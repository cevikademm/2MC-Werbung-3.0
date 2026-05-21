import { createClient } from '@supabase/supabase-js';

// Supabase URL ve Anon Key'i çevre değişkenlerinden alıyoruz.
// GÜVENLİK: Hardcoded fallback değerler kaldırıldı - env vars zorunlu.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    'UYARI: VITE_SUPABASE_URL ve VITE_SUPABASE_ANON_KEY çevre değişkenleri tanımlanmalıdır. ' +
    '.env.local dosyasını kontrol edin.'
  );
}

export const supabase = createClient(
  SUPABASE_URL || '',
  SUPABASE_ANON_KEY || ''
);
