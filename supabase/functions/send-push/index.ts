// =============================================================
// BAC Handels — Web Push gönderim Edge Function
// =============================================================
// Stack: Supabase Edge Functions (Deno) + npm:web-push
//
// Deploy:
//   supabase secrets set VAPID_PUBLIC_KEY=...
//   supabase secrets set VAPID_PRIVATE_KEY=...
//   supabase secrets set VAPID_SUBJECT=mailto:cevikademm@gmail.com
//   supabase functions deploy send-push --no-verify-jwt
//
// Çağırma (örnek):
//   POST https://<proj>.functions.supabase.co/send-push
//   Headers: Authorization: Bearer <SUPABASE_ANON_KEY>
//   Body: {
//     "user_ids": ["admin_1"] | null,   // null = tüm aboneler
//     "title": "Yeni satış",
//     "body": "Lada — Dom şubesinde 3 adet sattı",
//     "url": "/sales",
//     "tag": "sales-123",               // opsiyonel
//     "requireInteraction": false       // opsiyonel
//   }
//
// Yetki: Body içinde "admin_secret" alanı zorunlu (Edge secret ile karşılaştırılır)
// veya çağıran user 'Admin' rolüne sahip olmalı.
// =============================================================

// @ts-nocheck — Deno runtime
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT =
  Deno.env.get('VAPID_SUBJECT') || 'mailto:cevikademm@gmail.com';
const PUSH_ADMIN_SECRET = Deno.env.get('PUSH_ADMIN_SECRET') || '';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface SendPushBody {
  user_ids?: string[] | null;
  title: string;
  body?: string;
  url?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
  vibrate?: number[];
  actions?: { action: string; title: string }[];
  admin_secret?: string;
  caller_user_id?: string;
}

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body: SendPushBody;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!body.title) {
    return json(400, { error: 'title zorunlu' });
  }

  // ----- Yetkilendirme -----
  let authorized = false;

  if (PUSH_ADMIN_SECRET && body.admin_secret === PUSH_ADMIN_SECRET) {
    authorized = true;
  }

  if (!authorized && body.caller_user_id) {
    const { data: profile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', body.caller_user_id)
      .maybeSingle();
    if (profile?.role === 'Admin') authorized = true;
  }

  if (!authorized) {
    return json(401, { error: 'Yetkisiz. admin_secret veya admin caller_user_id gerekli.' });
  }

  // ----- Abonelikleri çek -----
  let query = admin
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth');

  if (Array.isArray(body.user_ids) && body.user_ids.length > 0) {
    query = query.in('user_id', body.user_ids);
  }

  const { data: subs, error: subsErr } = await query;
  if (subsErr) {
    console.error('[send-push] subs error:', subsErr);
    return json(500, { error: subsErr.message });
  }
  if (!subs || subs.length === 0) {
    return json(200, { sent: 0, message: 'Aktif abonelik yok.' });
  }

  // ----- Payload hazırla -----
  const payload = JSON.stringify({
    title: body.title,
    body: body.body || '',
    icon: body.icon,
    badge: body.badge,
    tag: body.tag || `bac-${Date.now()}`,
    requireInteraction: body.requireInteraction === true,
    vibrate: body.vibrate,
    actions: body.actions,
    data: { url: body.url || '/' },
  });

  // ----- Gönder -----
  const results = await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          payload,
          { TTL: 60 * 60 * 24 } // 1 gün
        );
        // Başarılı → last_used_at güncelle
        await admin
          .from('push_subscriptions')
          .update({ last_used_at: new Date().toISOString() })
          .eq('id', s.id);
        return { id: s.id, ok: true };
      } catch (err: any) {
        const status = err?.statusCode || 0;
        // 404 / 410 → endpoint ölmüş, sil
        if (status === 404 || status === 410) {
          await admin.from('push_subscriptions').delete().eq('id', s.id);
        }
        console.warn('[send-push] gönderim hatası:', status, err?.body || err?.message);
        return { id: s.id, ok: false, status, error: err?.message };
      }
    })
  );

  const sent = results.filter((r) => r.status === 'fulfilled' && (r.value as any).ok).length;
  const failed = results.length - sent;

  return json(200, {
    sent,
    failed,
    total: subs.length,
    details: results.map((r) =>
      r.status === 'fulfilled' ? r.value : { ok: false, error: String(r.reason) }
    ),
  });
});
