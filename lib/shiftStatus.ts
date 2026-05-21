// =============================================================
// shiftStatus.ts — Vardiya + QR durum hesabı (paylaşılan helper)
// =============================================================
// shift_schedules.days[i] hücrelerinden personel adlarını CSV olarak
// çıkarır, time_slot string'ini parse eder, gece geçişlerini (end <= start)
// destekler. time_logs ile birleştirip her vardiya için QR durumunu (5'li)
// hesaplar:
//   - complete    : giriş + çıkış tamam
//   - active      : giriş var, vardiya hâlâ devam ediyor
//   - missing_out : giriş var ama vardiya bitti, çıkış yok
//   - no_show     : vardiya başladı/bitti, hiç giriş yok
//   - pending     : vardiya henüz başlamadı (geleceğin vardiyası)
// =============================================================

import { supabase } from './supabase';

export type QrStatus = 'complete' | 'active' | 'missing_out' | 'no_show' | 'pending';

export interface ShiftWithStatus {
  employeeId: string;          // profile.id veya isim — eşleşme alındığında doldurulur
  employeeName: string;
  branch: string;
  startTime: string;           // 'HH:MM' yerel
  endTime: string;             // 'HH:MM' yerel
  shiftStartIso: string;       // tam ISO timestamp
  shiftEndIso: string;
  spansMidnight: boolean;
  // QR durum metaları
  status: QrStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  hasError: boolean;
  errorKind: string | null;
}

// "07:00-15:00" / "9-17" / "07:00 – 15:00" gibi formatları HH:MM'ye normalize
export function parseTimeSlot(slot: string | null | undefined):
  | { startTime: string; endTime: string; startMins: number; endMins: number; spansMidnight: boolean }
  | null {
  if (!slot) return null;
  const m = slot.match(/(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/);
  if (!m) return null;
  const sH = parseInt(m[1], 10);
  const sM = m[2] ? parseInt(m[2], 10) : 0;
  const eH = parseInt(m[3], 10);
  const eM = m[4] ? parseInt(m[4], 10) : 0;
  const startMins = sH * 60 + sM;
  const endMins = eH * 60 + eM;
  const spansMidnight = endMins <= startMins;
  return {
    startTime: `${String(sH).padStart(2, '0')}:${String(sM).padStart(2, '0')}`,
    endTime: `${String(eH).padStart(2, '0')}:${String(eM).padStart(2, '0')}`,
    startMins,
    endMins,
    spansMidnight,
  };
}

// week_start_date (YYYY-MM-DD, pazartesi) + dayIdx (0=Pzt..6=Paz) → JS Date
function dateFromWeekDay(weekStart: string, dayIdx: number): Date {
  const [y, m, d] = weekStart.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + dayIdx);
  return dt;
}

// Bir Date'in YYYY-MM-DD (pazartesi başlangıç) hafta string'ini döndür
export function getWeekStartYmd(d: Date = new Date()): string {
  const local = new Date(d);
  const isoDow = local.getDay() === 0 ? 7 : local.getDay();
  const monday = new Date(local);
  monday.setDate(local.getDate() - (isoDow - 1));
  monday.setHours(0, 0, 0, 0);
  return ymd(monday);
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// shift_schedules.days[i] hücresi CSV personel adları içerebilir.
// "Ali, Veli" → ["ali", "veli"] (lowercase trim'li)
function parseCsvNames(cell: string | null | undefined): string[] {
  if (!cell) return [];
  return cell.split(',').map(s => s.trim()).filter(Boolean);
}

interface Profile {
  id: string;
  full_name: string;
  branch?: string | null;
}

interface TimeLogRow {
  employee_id: string;
  check_in_at: string | null;
  check_out_at: string | null;
}

interface QrErrorRow {
  employee_id: string;
  error_kind: string;
  attempted_at: string;
}

// Belirli bir tarih için (lokal gün) tüm vardiyaları ve QR durumlarını döndürür.
// Gece geçişi vardiyaları doğal olarak kapsanır (önceki gün başlayıp hedef güne
// sarkan + hedef gün başlayıp ertesi güne sarkan).
export async function fetchShiftsForDate(targetDate: Date = new Date()): Promise<ShiftWithStatus[]> {
  // İlgili tarihin etrafındaki 3 haftayı çek (önceki/bu/sonraki) —
  // gece geçişi en fazla 1 gün sarkabilir, hafta sınırı için tampon.
  const target = new Date(targetDate);
  target.setHours(0, 0, 0, 0);
  const dayStartMs = target.getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;

  const prevWeek = new Date(target);
  prevWeek.setDate(prevWeek.getDate() - 7);
  const nextWeek = new Date(target);
  nextWeek.setDate(nextWeek.getDate() + 7);

  const weeks = [getWeekStartYmd(prevWeek), getWeekStartYmd(target), getWeekStartYmd(nextWeek)];
  const uniqueWeeks = Array.from(new Set(weeks));

  // 1) profiller (isim ↔ id eşlemesi)
  const profilesPromise = supabase.from('profiles').select('id, full_name, branch').limit(1000);

  // 2) ilgili haftaların shift_schedules kayıtları
  const schedulesPromise = supabase
    .from('shift_schedules')
    .select('week_start_date, branch, time_slot, days')
    .in('week_start_date', uniqueWeeks);

  // 3) hedef gün ± 1 gün penceresindeki QR time_logs (gece geçişi için)
  const winStartIso = new Date(dayStartMs - 24 * 60 * 60 * 1000).toISOString();
  const winEndIso = new Date(dayEndMs + 24 * 60 * 60 * 1000).toISOString();
  const logsPromise = supabase
    .from('time_logs')
    .select('employee_id, check_in_at, check_out_at')
    .eq('entry_method', 'qr')
    .gte('check_in_at', winStartIso)
    .lt('check_in_at', winEndIso);

  // 4) hedef gün penceresindeki QR scan hataları
  const errorsPromise = supabase
    .from('qr_scan_attempts')
    .select('employee_id, error_kind, attempted_at')
    .eq('status', 'error')
    .gte('attempted_at', winStartIso)
    .lt('attempted_at', winEndIso);

  const [profilesRes, schedulesRes, logsRes, errorsRes] = await Promise.all([
    profilesPromise, schedulesPromise, logsPromise, errorsPromise,
  ]);

  const profiles: Profile[] = (profilesRes.data || []) as any;
  const logs: TimeLogRow[] = (logsRes.data || []) as any;
  const errors: QrErrorRow[] = (errorsRes.data || []) as any;

  // İsim → profile eşleştirme (lowercase, substring tabanlı — has_shift_today
  // ile aynı yaklaşım)
  const nameToProfile = new Map<string, Profile>();
  profiles.forEach(p => {
    const key = (p.full_name || '').toLowerCase().trim();
    if (key) nameToProfile.set(key, p);
  });
  const idToProfile = new Map<string, Profile>();
  profiles.forEach(p => idToProfile.set(p.id, p));

  // CSV hücredeki bir adı en iyi profile'a eşle
  // (önce tam isim, sonra substring fallback)
  const resolveProfile = (token: string): Profile | null => {
    const k = token.toLowerCase().trim();
    if (!k) return null;
    // Direct ID match (some legacy data may use IDs in days[])
    if (idToProfile.has(token)) return idToProfile.get(token)!;
    // Tam isim
    if (nameToProfile.has(k)) return nameToProfile.get(k)!;
    // Substring (ilk eşleşme)
    for (const [n, p] of nameToProfile) {
      if (n.includes(k) || k.includes(n)) return p;
    }
    return null;
  };

  // log endeksleri: employee_id → en yakın vardiyaya eşlemek için
  const logsByEmployee = new Map<string, TimeLogRow[]>();
  logs.forEach(l => {
    if (!l.employee_id || !l.check_in_at) return;
    const arr = logsByEmployee.get(l.employee_id) || [];
    arr.push(l);
    logsByEmployee.set(l.employee_id, arr);
  });

  const errorsByEmployee = new Map<string, QrErrorRow[]>();
  errors.forEach(e => {
    if (!e.employee_id) return;
    const arr = errorsByEmployee.get(e.employee_id) || [];
    arr.push(e);
    errorsByEmployee.set(e.employee_id, arr);
  });

  const now = Date.now();
  const shifts: ShiftWithStatus[] = [];

  (schedulesRes.data || []).forEach((sch: any) => {
    const parsed = parseTimeSlot(sch.time_slot);
    if (!parsed) return;

    (sch.days || []).forEach((cell: any, dayIdx: number) => {
      const tokens = parseCsvNames(cell);
      tokens.forEach(token => {
        const prof = resolveProfile(token);
        if (!prof) return;

        const dayDate = dateFromWeekDay(sch.week_start_date, dayIdx);
        const shiftStart = new Date(dayDate);
        shiftStart.setHours(Math.floor(parsed.startMins / 60), parsed.startMins % 60, 0, 0);
        const shiftEnd = new Date(dayDate);
        shiftEnd.setHours(Math.floor(parsed.endMins / 60), parsed.endMins % 60, 0, 0);
        if (parsed.spansMidnight) shiftEnd.setDate(shiftEnd.getDate() + 1);

        // Hedef gün ile kesişiyor mu?
        if (shiftEnd.getTime() <= dayStartMs) return;
        if (shiftStart.getTime() >= dayEndMs) return;

        // En yakın time_log eşleşmesi (vardiya başlangıcına en yakın check_in_at)
        const empLogs = logsByEmployee.get(prof.id) || [];
        let bestLog: TimeLogRow | null = null;
        let bestDelta = Infinity;
        empLogs.forEach(l => {
          if (!l.check_in_at) return;
          const t = new Date(l.check_in_at).getTime();
          const delta = Math.abs(t - shiftStart.getTime());
          // Vardiya başlangıcının ±4 saat penceresinde olmalı
          if (delta <= 4 * 60 * 60 * 1000 && delta < bestDelta) {
            bestDelta = delta;
            bestLog = l;
          }
        });

        // Hata kontrol
        const empErrors = errorsByEmployee.get(prof.id) || [];
        const hasError = empErrors.some(e => {
          const t = new Date(e.attempted_at).getTime();
          return t >= shiftStart.getTime() - 2 * 60 * 60 * 1000
              && t <= shiftEnd.getTime() + 30 * 60 * 1000;
        });
        const errorKind = hasError ? (empErrors[0]?.error_kind || null) : null;

        // Status
        const startMs = shiftStart.getTime();
        const endMs = shiftEnd.getTime();
        const checkInAt = bestLog?.check_in_at || null;
        const checkOutAt = bestLog?.check_out_at || null;

        let status: QrStatus;
        if (!checkInAt) {
          if (now < startMs) status = 'pending';
          else status = 'no_show';
        } else if (checkOutAt) {
          status = 'complete';
        } else {
          // Giriş var, çıkış yok
          if (now < endMs + 15 * 60 * 1000) status = 'active';
          else status = 'missing_out';
        }

        shifts.push({
          employeeId: prof.id,
          employeeName: prof.full_name,
          branch: sch.branch || prof.branch || '',
          startTime: parsed.startTime,
          endTime: parsed.endTime,
          shiftStartIso: shiftStart.toISOString(),
          shiftEndIso: shiftEnd.toISOString(),
          spansMidnight: parsed.spansMidnight,
          status,
          checkInAt,
          checkOutAt,
          hasError,
          errorKind,
        });
      });
    });
  });

  // shift başlangıç saatine göre sırala
  shifts.sort((a, b) => a.shiftStartIso.localeCompare(b.shiftStartIso));
  return shifts;
}

// Status → UI meta
export const STATUS_META: Record<QrStatus, { tone: string; emoji: string; tKey: string }> = {
  complete:    { tone: 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/10 dark:border-emerald-500/30', emoji: '✓', tKey: 'shiftStatus.complete' },
  active:      { tone: 'text-green-700 bg-green-50 border-green-200 dark:text-green-300 dark:bg-green-500/10 dark:border-green-500/30',             emoji: '●', tKey: 'shiftStatus.active' },
  missing_out: { tone: 'text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/10 dark:border-amber-500/30',             emoji: '⚠', tKey: 'shiftStatus.missingOut' },
  no_show:     { tone: 'text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-500/30',                         emoji: '✗', tKey: 'shiftStatus.noShow' },
  pending:     { tone: 'text-slate-600 bg-slate-50 border-slate-200 dark:text-zinc-400 dark:bg-zinc-800/50 dark:border-zinc-700',                   emoji: '○', tKey: 'shiftStatus.pending' },
};
