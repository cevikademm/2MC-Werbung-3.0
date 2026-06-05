// =============================================================
// notify-event — Olay tabanlı push tetikleyici
// =============================================================
// Body örnekleri:
//
// 1) Vardiya dışı satış:
// { "type":"off_shift_sale", "employee_name":"Lada", "branch":"Dom",
//   "product_name":"Marlboro", "quantity":3 }
//
// 2) Vardiya saati dışı QR mesai:
// { "type":"off_shift_qr", "employee_id":"...", "employee_name":"Lada",
//   "branch":"Dom", "action":"in" | "out", "at":"2026-04-30T14:15:00Z" }
//
// 3) Kiosk haricinde mesai (manual):
// { "type":"non_kiosk_check", "employee_name":"Lada", "branch":"Dom",
//   "action":"in" | "out" }
//
// Edge function admin kullanıcıların notification_prefs'ine bakar,
// ilgili anahtar true ise send-push edge function'ını çağırır.
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

interface EventBody {
  type:
    | 'off_shift_sale'
    | 'off_shift_qr'
    | 'non_kiosk_check'
    | 'geofence_enter'
    | 'geofence_exit'
    | 'qr_scan_error'
    | 'qr_check'
    | 'task_activity';
  employee_name?: string;
  employee_id?: string;
  branch?: string;
  product_name?: string;
  quantity?: number;
  action?: 'in' | 'out';
  at?: string;
  lat?: number;
  lng?: number;
  distance_m?: number;
  // qr_scan_error için ek alanlar
  error_kind?: string;
  error_detail?: string;
  device_info?: string;
  // qr_check (her mesai giriş/çıkışı) için ek alanlar
  method?: 'qr' | 'manual';
  start_time?: string;
  end_time?: string;
  total_hours?: number;
  date?: string;
  // task_activity (görev işlemleri) için ek alanlar
  task_action?:
    | 'created'
    | 'updated'
    | 'deleted'
    | 'checklist_done'
    | 'checklist_undone'
    | 'completed'
    | 'reopened';
  task_title?: string;
  item_text?: string;
  actor_name?: string;
}

// Bildirim gövdesi formatı: "SS, HH:MM, DD.MM.YYYY" (Europe/Berlin)
const formatBerlin = (at?: string): string => {
  const d = at ? new Date(at) : new Date();
  const fmt = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const ss = parts.second ?? '00';
  const hhmm = `${parts.hour ?? '00'}:${parts.minute ?? '00'}`;
  const ddmmyyyy = `${parts.day ?? '01'}.${parts.month ?? '01'}.${parts.year ?? '2000'}`;
  return `${ss}, ${hhmm}, ${ddmmyyyy}`;
};

const buildNotification = (e: EventBody): { title: string; body: string; url: string; tag: string } => {
  switch (e.type) {
    case 'off_shift_sale':
      return {
        title: '🚨 Vardiya Dışı Satış',
        body: `${e.employee_name || 'Personel'} (${e.branch || '-'}) → ${e.product_name || 'ürün'} × ${e.quantity ?? 1}`,
        url: '/sales',
        tag: 'off-shift-sale',
      };
    case 'off_shift_qr':
      return {
        title: '⏰ Vardiya Saati Dışı Mesai QR',
        body: `${e.employee_name || 'Personel'} (${e.branch || '-'}) — ${e.action === 'out' ? 'çıkış' : 'giriş'} yaptı`,
        url: '/payroll',
        tag: 'off-shift-qr',
      };
    case 'non_kiosk_check':
      return {
        title: '📝 Kiosk Dışı Mesai Girişi',
        body: `${e.employee_name || 'Personel'} (${e.branch || '-'}) — manuel ${e.action === 'out' ? 'çıkış' : 'giriş'}`,
        url: '/payroll',
        tag: 'non-kiosk-check',
      };
    case 'geofence_enter': {
      const t = formatBerlin(e.at);
      return {
        title: '📍 Şube girişi',
        body: `${e.employee_name || 'Personel'} (${e.branch || '-'}) — ${t}`,
        url: '/map',
        tag: `geofence-enter-${e.employee_id || ''}`,
      };
    }
    case 'geofence_exit': {
      const t = formatBerlin(e.at);
      return {
        title: '🚪 Şube çıkışı',
        body: `${e.employee_name || 'Personel'} (${e.branch || '-'}) — ${t}`,
        url: '/map',
        tag: `geofence-exit-${e.employee_id || ''}`,
      };
    }
    case 'qr_scan_error': {
      const labels: Record<string, string> = {
        camera_denied: 'kamera izni reddedildi',
        no_camera: 'kamera bulunamadı',
        insecure_context: 'HTTPS gerekli',
        network: 'sunucuya ulaşılamadı',
        invalid_qr: 'geçersiz QR',
        already_checked_in: 'zaten giriş yapmış',
        not_checked_in: 'giriş kaydı yok',
        other: 'bilinmeyen hata',
      };
      const reason = labels[e.error_kind || ''] || (e.error_kind || 'hata');
      return {
        title: '❌ QR Mesai Hatası',
        body: `${e.employee_name || 'Personel'} (${e.branch || '-'}) — ${reason}`,
        url: '/device-brands',
        tag: `qr-scan-error-${e.employee_id || ''}`,
      };
    }
    case 'qr_check': {
      const tt = formatBerlin(e.at);
      const isOut = e.action === 'out';
      const via = e.method === 'manual' ? 'manuel' : 'QR';
      const hours =
        typeof e.total_hours === 'number' && e.total_hours > 0
          ? ` • ${e.total_hours.toFixed(2)} sa`
          : '';
      const span =
        e.start_time || e.end_time
          ? ` • ${e.start_time || '—'}–${e.end_time || '—'}`
          : '';
      return {
        title: isOut ? '🔴 Mesai Çıkışı' : '🟢 Mesai Girişi',
        body: `${e.employee_name || 'Personel'} (${e.branch || '-'}) — ${isOut ? 'çıkış' : 'giriş'} (${via})${span}${hours} • ${tt}`,
        url: '/payroll',
        tag: `qr-check-${e.employee_id || ''}-${e.action || ''}-${e.at || ''}`,
      };
    }
    case 'task_activity': {
      const labels: Record<string, string> = {
        created: 'görev oluşturdu',
        updated: 'görevi güncelledi',
        deleted: 'görevi sildi',
        checklist_done: 'adımı tamamladı',
        checklist_undone: 'adımı geri aldı',
        completed: 'görevi bitirdi',
        reopened: 'görevi yeniden açtı',
      };
      const lbl = labels[e.task_action || ''] || (e.task_action || 'işlem yaptı');
      const who = e.actor_name || e.employee_name || 'Kullanıcı';
      const item = e.item_text ? ` → "${e.item_text}"` : '';
      return {
        title: '📋 Görev İşlemi',
        body: `${who}: "${e.task_title || 'Görev'}" ${lbl}${item}`,
        url: '/tasks',
        tag: `task-activity-${e.task_action || ''}-${e.task_title || ''}-${e.item_text || ''}`,
      };
    }
    default:
      return { title: '2MC Werbung', body: '', url: '/dashboard', tag: 'event' };
  }
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  let body: EventBody;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (!body?.type) return json(400, { error: 'type zorunlu' });

  // 0) off_shift_qr için: personelin bugün vardiya planı VAR ise sessiz dön
  if (body.type === 'off_shift_qr' && body.employee_name && body.branch) {
    const { data: hasShift } = await admin.rpc('has_shift_today', {
      p_employee_name: body.employee_name,
      p_branch: body.branch,
      p_at: body.at || new Date().toISOString(),
    });
    if (hasShift === true) {
      return json(200, { skipped: 'on_shift', type: body.type });
    }
  }

  // 1) İlgili tercihi açık olan adminleri bul
  const { data: admins, error: adminsErr } = await admin
    .from('profiles')
    .select('id, notification_prefs')
    .eq('role', 'Admin');

  if (adminsErr) return json(500, { error: adminsErr.message });

  const prefKey = body.type;
  const targetIds = (admins || [])
    .filter((a: any) => a.notification_prefs?.[prefKey] !== false)
    .map((a: any) => a.id);

  if (targetIds.length === 0) {
    return json(200, { sent: 0, skipped: 'no_admin_with_pref', pref: prefKey });
  }

  // 2) send-push edge function'ını çağır
  const notif = buildNotification(body);
  const sendUrl = `${SUPABASE_URL}/functions/v1/send-push`;

  // 2a) Bildirim merkezine log kaydı (yetkili kullanıcılar dropdown'dan görür)
  await admin.from('notification_log').insert({
    type: body.type,
    title: notif.title,
    body: notif.body,
    url: notif.url,
    tag: notif.tag,
    meta: {
      employee_id: body.employee_id || null,
      employee_name: body.employee_name || null,
      branch: body.branch || null,
      product_name: body.product_name || null,
      quantity: body.quantity ?? null,
      action: body.action || null,
      at: body.at || null,
      lat: body.lat ?? null,
      lng: body.lng ?? null,
      distance_m: body.distance_m ?? null,
      error_kind: body.error_kind || null,
      error_detail: body.error_detail || null,
      device_info: body.device_info || null,
      method: body.method || null,
      start_time: body.start_time || null,
      end_time: body.end_time || null,
      total_hours: body.total_hours ?? null,
      date: body.date || null,
      task_action: body.task_action || null,
      task_title: body.task_title || null,
      item_text: body.item_text || null,
      actor_name: body.actor_name || null,
    },
  });

  const resp = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      caller_user_id: targetIds[0], // admin yetkisi için (tek admin → admin_1)
      user_ids: targetIds,
      title: notif.title,
      body: notif.body,
      url: notif.url,
      tag: notif.tag,
      requireInteraction: false,
    }),
  });

  const result = await resp.json().catch(() => ({}));
  return json(200, { ok: true, type: body.type, target_count: targetIds.length, push: result });
});
