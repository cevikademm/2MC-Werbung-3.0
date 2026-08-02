// =============================================================
// notifyEvent — client tarafından olay tetikleyici
// =============================================================
// Edge Function notify-event'i çağırarak admin'lere push gönderir.
// Hata olursa konsola yazar, ana akışı kesmez (fire-and-forget).
// =============================================================

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export type NotifyEventType =
  | 'off_shift_sale'
  | 'off_shift_qr'
  | 'non_kiosk_check'
  | 'geofence_enter'
  | 'geofence_exit'
  | 'qr_scan_error'
  | 'qr_check'
  | 'task_activity'
  // Yeni personel kaydı → adminlere
  | 'new_user'
  // Planlanan vardiya süresinin aşılması → adminlere
  | 'shift_overrun'
  // Vardiyası olduğu halde giriş yapmayan personel → adminlere
  | 'missing_check_in'
  // Personelin kendisine giden "mesai girişini unuttun" hatırlatması
  | 'shift_reminder';

export type TaskActionKind =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'checklist_done'
  | 'checklist_undone'
  | 'completed'
  | 'reopened';

export interface NotifyEventPayload {
  type: NotifyEventType;
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
  task_action?: TaskActionKind;
  task_title?: string;
  item_text?: string;
  actor_name?: string;
  // new_user (yeni personel kaydı) için ek alanlar
  email?: string;
  role?: string;
  // shift_overrun / missing_check_in / shift_reminder için ek alanlar
  planned_start?: string;   // 'HH:MM'
  planned_end?: string;     // 'HH:MM'
  planned_hours?: number;
  actual_hours?: number;
  overrun_minutes?: number;
  late_minutes?: number;
}

export const notifyEvent = (payload: NotifyEventPayload): void => {
  if (!SUPABASE_URL) return;
  // fire-and-forget — UI'yı bloklamaz
  void fetch(`${SUPABASE_URL}/functions/v1/notify-event`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ANON}`,
    },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.warn('[notifyEvent] gönderilemedi:', err);
  });
};
