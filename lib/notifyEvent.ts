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
  | 'qr_scan_error';

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
