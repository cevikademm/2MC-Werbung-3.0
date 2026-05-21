// =============================================================
// weekly-sales-anomaly — Haftalık satış anormallik kontrolü
// =============================================================
// Son 7 gün ile önceki 7 gün'ü ürün bazında karşılaştırır.
// |fark / önceki_avg| > %40 ise anomali listesine ekler ve push gönderir.
//
// Tetikleme:
//   - pg_cron ile her Pazartesi 09:00 (Europe/Berlin)
//   - UI'dan "Şimdi anomali kontrol et" butonu
//
// Body (opsiyonel):
//   { "threshold": 0.4 }   → varsayılan %40
// =============================================================

// @ts-nocheck Deno
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (s: number, p: unknown) =>
  new Response(JSON.stringify(p), {
    status: s,
    headers: { 'content-type': 'application/json', ...CORS },
  });

interface SaleRow {
  product_name: string;
  branch: string;
  quantity: number;
  sale_date: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  let threshold = 0.4;
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      if (typeof body?.threshold === 'number') threshold = body.threshold;
    } catch { /* boş body OK */ }
  }

  // Son 14 günün satışlarını çek
  const today = new Date();
  const fourteenAgo = new Date(today);
  fourteenAgo.setDate(today.getDate() - 14);
  const fromIso = fourteenAgo.toISOString().slice(0, 10);

  const { data: sales, error } = await admin
    .from('sales_logs')
    .select('product_name, branch, quantity, sale_date')
    .gte('sale_date', fromIso);

  if (error) return json(500, { error: error.message });

  // Bucket: ürün+şube → {recent: total, prev: total}
  const buckets = new Map<string, { recent: number; prev: number }>();
  const sevenAgo = new Date(today);
  sevenAgo.setDate(today.getDate() - 7);
  const sevenAgoIso = sevenAgo.toISOString().slice(0, 10);

  for (const s of (sales || []) as SaleRow[]) {
    const key = `${s.product_name}__${s.branch}`;
    const b = buckets.get(key) || { recent: 0, prev: 0 };
    if (s.sale_date >= sevenAgoIso) b.recent += Number(s.quantity || 0);
    else b.prev += Number(s.quantity || 0);
    buckets.set(key, b);
  }

  // Anomali tespit
  const anomalies: Array<{
    product: string;
    branch: string;
    recent: number;
    prev: number;
    pct: number;
    direction: 'up' | 'down';
  }> = [];

  for (const [key, { recent, prev }] of buckets.entries()) {
    if (prev < 3 && recent < 3) continue; // gürültü filtresi
    const base = Math.max(prev, 1);
    const diff = recent - prev;
    const pct = diff / base;
    if (Math.abs(pct) >= threshold) {
      const [product, branch] = key.split('__');
      anomalies.push({
        product,
        branch,
        recent,
        prev,
        pct: Math.round(pct * 100) / 100,
        direction: pct > 0 ? 'up' : 'down',
      });
    }
  }

  // Anomali yoksa sessiz dön
  if (anomalies.length === 0) {
    return json(200, { ok: true, anomalies: 0, message: 'Anomali yok' });
  }

  // weekly_sales_anomaly tercihi açık olan admin'leri bul
  const { data: admins } = await admin
    .from('profiles')
    .select('id, notification_prefs')
    .eq('role', 'Admin');

  const targetIds = (admins || [])
    .filter((a: any) => a.notification_prefs?.weekly_sales_anomaly !== false)
    .map((a: any) => a.id);

  if (targetIds.length === 0) {
    return json(200, { ok: true, anomalies: anomalies.length, push_skipped: 'no_admin' });
  }

  // En çarpıcı 3 anomaliyi özete koy
  const top = anomalies
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 3);
  const summary = top
    .map((a) => `${a.direction === 'up' ? '↑' : '↓'} ${a.product} (${a.branch}) %${Math.abs(a.pct * 100).toFixed(0)}`)
    .join(' • ');

  const pushBody = {
    caller_user_id: targetIds[0],
    user_ids: targetIds,
    title: `📊 Haftalık Anomali (${anomalies.length} ürün)`,
    body: summary,
    url: '/sales',
    tag: 'weekly-anomaly',
    requireInteraction: true,
  };

  // Bildirim merkezi log kaydı
  await admin.from('notification_log').insert({
    type: 'weekly_sales_anomaly',
    title: pushBody.title,
    body: pushBody.body,
    url: pushBody.url,
    tag: pushBody.tag,
    meta: { threshold, total: anomalies.length, top },
  });

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(pushBody),
  });
  const pushResult = await resp.json().catch(() => ({}));

  return json(200, {
    ok: true,
    anomalies: anomalies.length,
    threshold,
    top,
    push: pushResult,
  });
});
