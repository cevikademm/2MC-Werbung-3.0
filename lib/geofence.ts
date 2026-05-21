// =============================================================
// geofence — Harita / Canlı konum yardımcıları
// =============================================================
// Saf fonksiyonlar + whitelist. State yok, side effect yok.
// =============================================================

// Harita sekmesini görebilen kullanıcılar — whitelist.
// Admin rolü dahi olsa whitelist dışındaki kullanıcılar göremez.
export const MAP_VISIBLE_EMAILS = [
  'cevikademm@gmail.com',
];

// role parametresi imza uyumu için tutuluyor (Layout.tsx çağrısı kırılmasın),
// ancak erişim KARARı sadece e-posta whitelist'ine dayanır.
export const canSeeMap = (email?: string | null, _role?: string | null): boolean => {
  return !!email && MAP_VISIBLE_EMAILS.includes(email.trim().toLowerCase());
};

// Haversine — iki coğrafi nokta arası metre cinsinden mesafe.
// db_schema.sql:557-561'deki server-side formülün TS karşılığı.
export interface LatLng { lat: number; lng: number; }

export const haversineMeters = (a: LatLng, b: LatLng): number => {
  const R = 6371000; // Dünya yarıçapı (m)
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(x));
};

export interface BranchPoint extends LatLng {
  branch: string;
  geofence_m: number;
  radius_m?: number;
}

export const nearestBranch = (
  point: LatLng,
  branches: BranchPoint[],
): { branch: BranchPoint; distance_m: number } | null => {
  if (branches.length === 0) return null;
  let best = { branch: branches[0], distance_m: haversineMeters(point, branches[0]) };
  for (let i = 1; i < branches.length; i++) {
    const d = haversineMeters(point, branches[i]);
    if (d < best.distance_m) best = { branch: branches[i], distance_m: d };
  }
  return best;
};

// Bildirim gövdesi formatı: "SS, HH:MM, DD.MM.YYYY" (Europe/Berlin)
// Edge function ve UI tarafında ortak kullanılır.
export const formatBerlin = (date: Date | string | undefined): string => {
  const d = typeof date === 'string' ? new Date(date) : date ?? new Date();
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
  // de-DE çıktısı: "05.05.2026, 12:34:56"
  // İstediğimiz: "12, 12:34, 05.05.2026" formatı kullanıcının
  // "saniye SS, saatte HH:MM, tarihte DD.MM.YYYY" özetinin sade hali.
  const parts = fmt.formatToParts(d).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const ss = parts.second ?? '00';
  const hhmm = `${parts.hour ?? '00'}:${parts.minute ?? '00'}`;
  const ddmmyyyy = `${parts.day ?? '01'}.${parts.month ?? '01'}.${parts.year ?? '2000'}`;
  return `${ss}, ${hhmm}, ${ddmmyyyy}`;
};

// localStorage flag'leri — QrCheckIn ile LiveLocationTracker
// arasındaki köprü. Aynı sekme içinde 'storage' event'i tetiklenmediği
// için BroadcastChannel veya custom event kullanırız.
export const SHIFT_ACTIVE_KEY = 'bac_shift_active';
export const SHIFT_EMPLOYEE_KEY = 'bac_shift_employee_id';
export const SHIFT_CHANGED_EVENT = 'bac:shift-active-changed';

export const setShiftActive = (employeeId: string): void => {
  try {
    localStorage.setItem(SHIFT_ACTIVE_KEY, '1');
    localStorage.setItem(SHIFT_EMPLOYEE_KEY, employeeId);
    window.dispatchEvent(new CustomEvent(SHIFT_CHANGED_EVENT, { detail: { active: true } }));
  } catch {
    /* localStorage kapalıysa sessizce geç */
  }
};

export const clearShiftActive = (): void => {
  try {
    localStorage.removeItem(SHIFT_ACTIVE_KEY);
    localStorage.removeItem(SHIFT_EMPLOYEE_KEY);
    window.dispatchEvent(new CustomEvent(SHIFT_CHANGED_EVENT, { detail: { active: false } }));
  } catch {
    /* */
  }
};

export const isShiftActive = (): boolean => {
  try {
    return localStorage.getItem(SHIFT_ACTIVE_KEY) === '1';
  } catch {
    return false;
  }
};
