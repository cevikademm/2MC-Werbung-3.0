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
// 4) Yeni personel kaydı:
// { "type":"new_user", "employee_id":"...", "employee_name":"Lada",
//   "email":"lada@...", "branch":"Dom", "role":"Personel", "actor_name":"Adem" }
//
// 5) Planlanan mesai aşımı:
// { "type":"shift_overrun", "employee_id":"...", "employee_name":"Lada",
//   "branch":"Dom", "date":"2026-08-02", "planned_start":"07:00",
//   "planned_end":"15:00", "planned_hours":8, "actual_hours":9.6,
//   "overrun_minutes":96 }
//
// 6) Mesai girişi yapılmadı (adminlere):
// { "type":"missing_check_in", "employee_id":"...", "employee_name":"Lada",
//   "branch":"Dom", "date":"2026-08-02", "planned_start":"07:00",
//   "planned_end":"15:00", "late_minutes":20 }
//
// 7) Personele hatırlatma (kendisine gider):
// { "type":"shift_reminder", "employee_id":"...", "employee_name":"Lada",
//   "branch":"Dom", "planned_start":"07:00", "late_minutes":20 }
//
// Hedef kitle (AUDIENCE):
//   'admin'    → notification_prefs[type] !== false olan Admin'lere gider.
//   'employee' → yalnızca body.employee_id sahibine gider (kendi tercihine bakılır).
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
    | 'task_activity'
    | 'new_user'
    | 'shift_overrun'
    | 'missing_check_in'
    | 'shift_reminder';
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
  note?: string;
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
  // new_user için ek alanlar
  email?: string;
  role?: string;
  // shift_overrun / missing_check_in / shift_reminder için ek alanlar
  planned_start?: string;
  planned_end?: string;
  planned_hours?: number;
  actual_hours?: number;
  overrun_minutes?: number;
  late_minutes?: number;
  // true ise notification_log kaydı atlanır — kaydı çağıran taraf
  // (SQL trigger / cron) zaten kendisi açmıştır, çift satır olmasın.
  skip_log?: boolean;
}

// Bildirim tipi → hedef kitle. Listede olmayan tipler 'admin' kabul edilir.
const AUDIENCE: Record<string, 'admin' | 'employee'> = {
  shift_reminder: 'employee',
};

// Dakikayı "1 sa 36 dk" biçimine çevirir
const humanMinutes = (mins?: number): string => {
  const m = Math.max(0, Math.round(mins ?? 0));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h > 0 && rest > 0) return `${h} sa ${rest} dk`;
  if (h > 0) return `${h} sa`;
  return `${rest} dk`;
};

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
      const note = e.note ? ` • 📝 ${e.note}` : '';
      return {
        title: isOut ? '🔴 Mesai Çıkışı' : '🟢 Mesai Girişi',
        body: `${e.employee_name || 'Personel'} (${e.branch || '-'}) — ${isOut ? 'çıkış' : 'giriş'} (${via})${span}${hours}${note} • ${tt}`,
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
    case 'new_user': {
      const who = e.actor_name ? ` • ekleyen: ${e.actor_name}` : '';
      const mail = e.email ? ` — ${e.email}` : '';
      const role = e.role ? ` (${e.role})` : '';
      const branch = e.branch ? ` • şube: ${e.branch}` : '';
      return {
        title: '👤 Yeni Personel Kaydı',
        body: `${e.employee_name || 'Yeni personel'}${role}${mail}${branch}${who}`,
        url: '/payroll',
        tag: `new-user-${e.employee_id || e.email || e.employee_name || ''}`,
      };
    }
    case 'shift_overrun': {
      const plan =
        e.planned_start || e.planned_end
          ? `plan ${e.planned_start || '—'}–${e.planned_end || '—'}`
          : 'plan yok';
      const planned =
        typeof e.planned_hours === 'number' ? ` (${e.planned_hours.toFixed(2)} sa)` : '';
      const actual =
        typeof e.actual_hours === 'number' ? `${e.actual_hours.toFixed(2)} sa` : '—';
      return {
        title: '⏱️ Planlanan Mesai Aşımı',
        body: `${e.employee_name || 'Personel'} (${e.branch || '-'}) — ${plan}${planned}, çalışılan ${actual} • aşım +${humanMinutes(e.overrun_minutes)}`,
        url: '/payroll',
        tag: `shift-overrun-${e.employee_id || ''}-${e.date || ''}`,
      };
    }
    case 'missing_check_in': {
      const plan = e.planned_start
        ? `${e.planned_start}${e.planned_end ? `–${e.planned_end}` : ''}`
        : '—';
      return {
        title: '🚫 Mesai Girişi Yapılmadı',
        body: `${e.employee_name || 'Personel'} (${e.branch || '-'}) — ${plan} vardiyası başladı, ${humanMinutes(e.late_minutes)} geçti, hâlâ giriş yok.`,
        url: '/payroll',
        tag: `missing-checkin-${e.employee_id || ''}-${e.date || ''}`,
      };
    }
    case 'shift_reminder': {
      const plan = e.planned_start
        ? `${e.planned_start}${e.planned_end ? `–${e.planned_end}` : ''}`
        : '—';
      return {
        title: '⏰ Mesai Saatini Girmeyi Unutma',
        body: `${plan} vardiyan ${humanMinutes(e.late_minutes)} önce başladı${e.branch ? ` (${e.branch})` : ''}. Lütfen mesai saat girişini yap.`,
        url: '/payroll',
        tag: `shift-reminder-${e.employee_id || ''}-${e.date || ''}`,
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

  // 1) Hedef kullanıcıları bul (audience'a göre)
  const prefKey = body.type;
  const audience = AUDIENCE[body.type] || 'admin';
  let targetIds: string[] = [];

  if (audience === 'employee') {
    // Kişisel hatırlatma → sadece ilgili personele, kendi tercihine bakarak
    if (!body.employee_id) {
      return json(400, { error: 'employee_id zorunlu (audience=employee)' });
    }
    const { data: emp, error: empErr } = await admin
      .from('profiles')
      .select('id, notification_prefs')
      .eq('id', body.employee_id)
      .maybeSingle();

    if (empErr) return json(500, { error: empErr.message });
    if (!emp) return json(200, { sent: 0, skipped: 'employee_not_found', pref: prefKey });
    if (emp.notification_prefs?.[prefKey] === false) {
      return json(200, { sent: 0, skipped: 'employee_pref_off', pref: prefKey });
    }
    targetIds = [emp.id];
  } else {
    const { data: admins, error: adminsErr } = await admin
      .from('profiles')
      .select('id, notification_prefs')
      .eq('role', 'Admin');

    if (adminsErr) return json(500, { error: adminsErr.message });

    targetIds = (admins || [])
      .filter((a: any) => a.notification_prefs?.[prefKey] !== false)
      .map((a: any) => a.id);
  }

  if (targetIds.length === 0) {
    return json(200, { sent: 0, skipped: 'no_target_with_pref', pref: prefKey, audience });
  }

  // 2) send-push edge function'ını çağır
  const notif = buildNotification(body);
  const sendUrl = `${SUPABASE_URL}/functions/v1/send-push`;

  // 2a) Bildirim merkezine log kaydı (yetkili kullanıcılar dropdown'dan görür).
  //     skip_log=true → kaydı SQL tarafı (trigger/cron) zaten açtı.
  if (body.skip_log !== true) await admin.from('notification_log').insert({
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
      note: body.note || null,
      task_action: body.task_action || null,
      task_title: body.task_title || null,
      item_text: body.item_text || null,
      actor_name: body.actor_name || null,
      email: body.email || null,
      role: body.role || null,
      planned_start: body.planned_start || null,
      planned_end: body.planned_end || null,
      planned_hours: body.planned_hours ?? null,
      actual_hours: body.actual_hours ?? null,
      overrun_minutes: body.overrun_minutes ?? null,
      late_minutes: body.late_minutes ?? null,
      audience,
    },
  });

  // 2b) send-push yetkisi: caller_user_id bir Admin olmalı. audience='employee'
  //     olduğunda hedef personeldir, bu yüzden ayrıca bir admin id'si bulunur.
  let callerId = targetIds[0];
  if (audience === 'employee') {
    const { data: anyAdmin } = await admin
      .from('profiles')
      .select('id')
      .eq('role', 'Admin')
      .limit(1)
      .maybeSingle();
    if (!anyAdmin?.id) {
      return json(200, { sent: 0, skipped: 'no_admin_for_push_auth', type: body.type });
    }
    callerId = anyAdmin.id;
  }

  const resp = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      caller_user_id: callerId, // send-push admin yetkisi için
      user_ids: targetIds,
      title: notif.title,
      body: notif.body,
      url: notif.url,
      tag: notif.tag,
      requireInteraction: false,
    }),
  });

  const result = await resp.json().catch(() => ({}));
  return json(200, { ok: true, type: body.type, audience, target_count: targetIds.length, push: result });
});
