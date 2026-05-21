import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Yerel saatte YYYY-MM-DD üretir. shift_schedules.week_start_date alanı
// için tek doğru kaynak burası — toISOString() kullanmayın, çünkü UTC'ye
// kayar ve yerel saatle Pazartesi gibi görünen gün UTC'de Pazar olabilir
// (Almanya'da UTC+1/+2 nedeniyle). Tüm vardiya kayıt/okuma kodu bu
// helper'dan geçmeli, aksi halde Calendar/Payroll/ShiftSchedule arasında
// "atama hiç yapılmamış gibi" görünen uyuşmazlıklar oluşur.
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// "09:00-17:00" / "09-17" / "9:30 - 17:45" -> { start, end } (dakika)
export function parseTimeRange(label: string): { start: number; end: number } | null {
  if (!label) return null;
  const match = label.match(/(\d{1,2}):?(\d{2})?\s*[-–]\s*(\d{1,2}):?(\d{2})?/);
  if (!match) return null;
  return {
    start: parseInt(match[1]) * 60 + parseInt(match[2] || '0'),
    end: parseInt(match[3]) * 60 + parseInt(match[4] || '0'),
  };
}

// Bir vardiya hücresi (days[dayIdx]) tek bir personel ID'si veya CSV ("id1,id2,…")
// olabilir. Bu helper'lar formatı normalize eder; tek doğruluk kaynağı budur.
// Boş string veya null → boş dizi (mevcut "boş hücre" davranışı korunur).
export function parseCellIds(cell: string | null | undefined): string[] {
  if (!cell) return [];
  return String(cell).split(',').map(s => s.trim()).filter(Boolean);
}

// ID dizisini DB'ye yazmak için CSV string'ine çevirir. Set ile dedup yapar —
// aynı personel iki kez eklense bile hücrede tek satır görünür.
export function joinCellIds(ids: string[]): string {
  return Array.from(new Set(ids.filter(Boolean))).join(',');
}

// Verilen anda kullanıcı atanmış vardiya içinde mi? schedules: shift_schedules satırları
// (week_start_date, time_slot, days[7] — Pzt=0 ... Pzr=6).
export function isUserOnShiftAt(userId: string, now: Date, schedules: any[]): boolean {
  if (!userId || !Array.isArray(schedules) || schedules.length === 0) return false;
  // JS: Pazar=0..Cmt=6 -> Pzt=0..Pzr=6
  const dayIdx = (now.getDay() + 6) % 7;
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  // İçinde olduğumuz haftanın Pazartesi tarihi
  const monday = new Date(now);
  monday.setDate(monday.getDate() - dayIdx);
  const weekKey = formatLocalDate(monday);

  for (const row of schedules) {
    if (row?.week_start_date !== weekKey) continue;
    if (!Array.isArray(row.days)) continue;
    // Hücre CSV olabilir — tüm ID'leri kontrol et
    if (!parseCellIds(row.days[dayIdx]).includes(userId)) continue;
    const range = parseTimeRange(row.time_slot || '');
    if (!range) continue;
    if (minutesNow >= range.start && minutesNow < range.end) return true;
  }
  return false;
}

// Ondalık saat değerini "H:MM" string'ine çevir. Örn. 8.42 -> "8:25".
// time_logs.total_hours bu formatta tutulur (2 ondalıklı), insan-okur biçimi.
export function formatHoursAsHM(hours?: number | null): string {
  if (hours == null || isNaN(hours) || hours <= 0) return '0:00';
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// Ondalık saati TR insan-okur kısa formata çevir. Örn. 7.87 -> "7sa 52dk".
// Bordro UI'sinde kullanıcılar "7.87 saat" diye okuyamıyordu (87 dakika sanıyorlardı).
export function formatHoursHumanTR(hours?: number | null): string {
  if (hours == null || isNaN(hours) || hours <= 0) return '0sa 00dk';
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}sa ${String(m).padStart(2, '0')}dk`;
}

// HH:mm formatı (yerel saat). created_at gibi ISO timestamp'ler için.
export function formatTimeOfDay(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

// Mesai dışı satış uyarılarını sadece bu emailler görür.
export const OFF_SHIFT_ALERT_EMAILS = ['cevikademm@gmail.com'];
export const canSeeOffShiftAlerts = (email?: string | null): boolean =>
  !!email && OFF_SHIFT_ALERT_EMAILS.includes(email.trim().toLowerCase());

// QR girişinde kaydedilen cihaz marka/modelini sadece bu adminler görebilir.
// Amaç: Bir personelin kendi şifresini başka birine verip QR okutmasını
// fark etmek — geçmişte "Apple iPhone" gösterirken aniden "Samsung SM-…"
// görünürse şüpheli durum yakalanır. Personeller bu bilgiyi göremez.
export const DEVICE_INFO_VISIBLE_EMAILS = [
  'cevikademm@gmail.com',
];
export const canSeeDeviceInfo = (email?: string | null): boolean =>
  !!email && DEVICE_INFO_VISIBLE_EMAILS.includes(email.trim().toLowerCase());

// Samsung SM-kodlarını insan-okur "Galaxy …" pazarlama adına çevirir.
// Eşleşme bölge eki ('B', 'U', 'N', 'F', '/DS' vb.) önemsemeden yapılır,
// böylece SM-S918B / SM-S918U / SM-S918N hepsi "Galaxy S23 Ultra" döner.
// Liste sadece sahada en sık karşılaşılan modelleri kapsar; eşleşme yoksa
// ham SM-kodu olduğu gibi gösterilir (bilgi kaybı olmasın diye).
const SAMSUNG_MODEL_MAP: Record<string, string> = {
  // Galaxy S serisi
  'S901': 'Galaxy S22', 'S906': 'Galaxy S22+', 'S908': 'Galaxy S22 Ultra',
  'S911': 'Galaxy S23', 'S916': 'Galaxy S23+', 'S918': 'Galaxy S23 Ultra',
  'S711': 'Galaxy S23 FE',
  'S921': 'Galaxy S24', 'S926': 'Galaxy S24+', 'S928': 'Galaxy S24 Ultra',
  'S931': 'Galaxy S25', 'S936': 'Galaxy S25+', 'S938': 'Galaxy S25 Ultra',
  // Galaxy A serisi (orta segment, en sık)
  'A146': 'Galaxy A14', 'A156': 'Galaxy A15', 'A166': 'Galaxy A16',
  'A256': 'Galaxy A25', 'A266': 'Galaxy A26',
  'A346': 'Galaxy A34', 'A356': 'Galaxy A35', 'A366': 'Galaxy A36',
  'A526': 'Galaxy A52', 'A536': 'Galaxy A53', 'A546': 'Galaxy A54',
  'A556': 'Galaxy A55', 'A566': 'Galaxy A56',
  'A736': 'Galaxy A73',
  // Galaxy Z (katlanabilir)
  'F711': 'Galaxy Z Flip3', 'F721': 'Galaxy Z Flip4', 'F731': 'Galaxy Z Flip5',
  'F741': 'Galaxy Z Flip6', 'F761': 'Galaxy Z Flip7',
  'F926': 'Galaxy Z Fold3', 'F936': 'Galaxy Z Fold4', 'F946': 'Galaxy Z Fold5',
  'F956': 'Galaxy Z Fold6', 'F966': 'Galaxy Z Fold7',
  // Note serisi (eski ama hâlâ sahada)
  'N970': 'Galaxy Note 10', 'N975': 'Galaxy Note 10+',
  'N980': 'Galaxy Note 20', 'N985': 'Galaxy Note 20 Ultra',
};

function samsungMarketingName(rawModel: string): string {
  // SM-S918B/DS, SM-S918B, SM-A546B → "S918", "S918", "A546"
  const m = rawModel.match(/^SM-([A-Z]\d{3})/i);
  if (m) {
    const friendly = SAMSUNG_MODEL_MAP[m[1].toUpperCase()];
    if (friendly) return `Samsung ${friendly}`;
  }
  return `Samsung ${rawModel}`;
}

// Tarayıcıda üretilip localStorage'a yazılan, MAC adresi formatında kalıcı
// cihaz kimliği. Web platformu gerçek hardware MAC/IMEI'ye erişemediği için
// (iOS Safari/Chrome/FF privacy nedeniyle blokluyor), random 6 byte üretip
// MAC görünümünde saklıyoruz. Aynı tarayıcı + aynı domain'de stabil; kullanıcı
// site verilerini silerse yenilenir — bu kabul edilebilir, çünkü amaç:
//   "Bu personel hep aynı cihazdan mı giriş yapıyor?" sorusuna cevap vermek.
// Birinci oktette locally-administered bit set ediliyor (gerçek üretici OUI
// ile karışmasın diye standart yaklaşım: bit 1 = 1, bit 0 = 0 → 'X2', 'X6',
// 'XA', 'XE' başlangıç).
const DEVICE_ID_KEY = 'bac_device_id';

function generatePseudoMac(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // locally-administered + unicast: ilk oktetin alt 2 biti '10' olsun
  bytes[0] = (bytes[0] | 0x02) & 0xFE;
  return Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') return '';
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(existing)) return existing;
    const fresh = generatePseudoMac();
    window.localStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    // Private mode / storage disabled — kalıcı ID üretemeyiz.
    return '';
  }
}

// QR check-in anında tarayıcının User-Agent'ından kısa bir cihaz etiketi üretir.
// "Apple iPhone · A3:F7:C2:D1:B2:94", "Samsung Galaxy S23 Ultra · 5E:11:08:…"
// formatında — marka/model + tarayıcıya özel kalıcı MAC-benzeri kimlik.
// Kimlik localStorage'da saklanır; aynı kullanıcı aynı cihazdan tekrar
// tarayınca aynı ID döner. Şifre paylaşımı tespiti: ID değişirse (cihaz
// fiziksel olarak farklı veya kullanıcı verileri sildi) admin uyarı görür.
export function detectDeviceInfo(): string {
  const id = getOrCreateDeviceId();
  const idSuffix = id ? ` · ${id}` : '';
  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';

  const base = (() => {
    if (/iPad/i.test(ua)) return 'Apple iPad';
    if (/iPhone/i.test(ua)) return 'Apple iPhone';
    const android = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build|\))/i);
    if (android) {
      const model = android[1].trim();
      if (/^SM-/i.test(model)) return samsungMarketingName(model);
      if (/^Pixel/i.test(model)) return `Google ${model}`;
      if (/^(Mi |Redmi|POCO|2\d{3}\w+)/i.test(model)) return `Xiaomi ${model}`;
      if (/HUAWEI|HONOR|^(ALP|EVA|VOG|ELS|NOH|LIO|TAS|ANA|JNY|MAR|JAD)-/i.test(model)) {
        return /HUAWEI|HONOR/i.test(model) ? model : `Huawei ${model}`;
      }
      if (/OnePlus|^(LE|GM|HD|IN|KB|CPH)\d{4}/i.test(model)) return `OnePlus ${model}`;
      if (/^(SO-|SOG|XQ-)/i.test(model)) return `Sony ${model}`;
      if (/^(RMX|realme)/i.test(model)) return `Realme ${model}`;
      if (/^(V\d{4}|vivo)/i.test(model)) return `vivo ${model}`;
      if (/^(CPH|OPPO)/i.test(model)) return `OPPO ${model}`;
      if (/^(Nokia|TA-)/i.test(model)) return `Nokia ${model}`;
      return model || 'Android cihaz';
    }
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Macintosh/i.test(ua)) return 'Mac';
    return 'Bilinmeyen cihaz';
  })();

  return `${base}${idSuffix}`;
}

// Fiş fotoğrafı için kanvas tabanlı sıkıştırma. Mobilde ham foto 3-5 MB
// olabiliyor — okunaklı kalan 800px genişlik + JPEG q=0.6 ~30-80 KB üretir.
// EXIF orientation 'from-image' ile otomatik düzeltilir (modern Chrome/Safari).
export async function compressImageToJpeg(
  file: File,
  opts: { maxWidth?: number; quality?: number } = {}
): Promise<Blob> {
  const { maxWidth = 800, quality = 0.6 } = opts;
  // @ts-ignore — imageOrientation 'from-image' Chrome 79+ / Safari 13.4+
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const ratio = Math.min(1, maxWidth / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  const h = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context kullanılamıyor');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('Resim sıkıştırılamadı'))),
      'image/jpeg',
      quality
    );
  });
}
