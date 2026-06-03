import { createClient } from '@supabase/supabase-js';

// Supabase URL ve Anon Key'i çevre değişkenlerinden alıyoruz.
// Hardcoded fallback: anon key Supabase tarafından "public" olmak üzere
// tasarlanmıştır (RLS politikaları gerçek güvenliği sağlar). Vercel'de
// env var ekleme zorunluluğu olmadan deploy çalışsın diye fallback bırakıldı.
// Production'da env varsa o öncelikli kullanılır.
const FALLBACK_URL = 'https://wgfkoxjlcovrkzrustpy.supabase.co';
const FALLBACK_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnZmtveGpsY292cmt6cnVzdHB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzOTM2MjQsImV4cCI6MjA5NDk2OTYyNH0.q9aC1Zl8WLGohOvHn0nM34u8sAqg49AChbI6c01FV7Q';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || FALLBACK_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || FALLBACK_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
