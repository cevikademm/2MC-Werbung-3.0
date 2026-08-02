import { createClient } from '@supabase/supabase-js';

// Supabase URL ve Anon Key'i çevre değişkenlerinden alıyoruz.
// Hardcoded fallback: anon key Supabase tarafından "public" olmak üzere
// tasarlanmıştır (RLS politikaları gerçek güvenliği sağlar). Vercel'de
// env var ekleme zorunluluğu olmadan deploy çalışsın diye fallback bırakıldı.
// Production'da env varsa o öncelikli kullanılır.
const FALLBACK_URL = 'https://iqsnemkupgfdzpvmzkiu.supabase.co';
const FALLBACK_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlxc25lbWt1cGdmZHpwdm16a2l1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MTg5MTcsImV4cCI6MjEwMTE5NDkxN30.c6PJf_1MnrXkXuXKrvjz-f_BHFOMT92rw37YxuLCXhI';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || FALLBACK_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || FALLBACK_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
