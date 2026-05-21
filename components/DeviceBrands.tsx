import React, { useEffect, useMemo, useState } from 'react';
import {
  Smartphone, Loader2, Search, ShieldAlert, Copy, Check, User as UserIcon, AlertTriangle,
  UserX, XCircle, Camera, Wifi, Lock, QrCode, Calendar as CalendarIcon, Clock,
  LogIn, LogOut, CalendarDays
} from 'lucide-react';
import { Employee, Role } from '../types';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../lib/i18n';
import { canSeeDeviceInfo } from '../lib/utils';
import { fetchShiftsForDate, ShiftWithStatus, STATUS_META } from '../lib/shiftStatus';

interface RawLog {
  employee_id: string;
  device_info: string | null;
  check_in_at: string | null;
}

// "Apple iPhone · 62:4A:B4:F6:DD:59" → "62:4A:B4:F6:DD:59"
function extractMac(deviceInfo: string): string {
  const parts = deviceInfo.split('·');
  return (parts[1] || '').trim();
}

interface MacUsage {
  mac: string;
  count: number;
  lastSeen: string;
}

interface PersonRow {
  employeeId: string;
  employeeName: string;
  macs: MacUsage[]; // benzersiz, kullanım sayısı azalan
}

interface MacConflictUser {
  employeeId: string;
  employeeName: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

interface MacConflict {
  mac: string;
  users: MacConflictUser[];
  totalCount: number;
  firstSeen: string;
  lastSeen: string;
}

// Sayfa başı çekilen kayıt sayısı (Supabase JS varsayılanı 1000).
// Hardcap güvenlik için: pratikte hiç ulaşılmamalı ama sonsuz loop'a karşı sigorta.
const PAGE_SIZE = 1000;
const HARD_CAP = 100000;

type TabView = 'people' | 'conflicts' | 'shifts' | 'errors';
type ShiftFilter = 'today' | 'tomorrow';

// QR scan hata kaydı (qr_scan_attempts tablosu)
interface ErrorRow {
  id: string;
  employeeId: string | null;
  employeeName: string;
  errorKind: string;
  errorDetail: string | null;
  action: string | null;
  branch: string | null;
  deviceInfo: string | null;
  attemptedAt: string;
}

// QR hatası türü → renkli rozet metaverisi
const ERROR_META: Record<string, { color: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  camera_denied:      { color: 'text-orange-400 bg-orange-500/10 border-orange-500/40',  icon: Camera },
  no_camera:          { color: 'text-orange-400 bg-orange-500/10 border-orange-500/40',  icon: Camera },
  insecure_context:   { color: 'text-amber-400 bg-amber-500/10 border-amber-500/40',     icon: Lock },
  network:            { color: 'text-sky-400 bg-sky-500/10 border-sky-500/40',           icon: Wifi },
  invalid_qr:         { color: 'text-red-400 bg-red-500/10 border-red-500/40',           icon: QrCode },
  already_checked_in: { color: 'text-violet-400 bg-violet-500/10 border-violet-500/40',  icon: AlertTriangle },
  not_checked_in:     { color: 'text-violet-400 bg-violet-500/10 border-violet-500/40',  icon: AlertTriangle },
  other:              { color: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/40',        icon: XCircle },
};

interface DeviceBrandsProps {
  currentUser: Employee;
}

const DeviceBrands: React.FC<DeviceBrandsProps> = ({ currentUser }) => {
  const { t, formatDate } = useLanguage();
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [conflicts, setConflicts] = useState<MacConflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [copiedMac, setCopiedMac] = useState<string | null>(null);
  const [tab, setTab] = useState<TabView>('people');
  const [scannedCount, setScannedCount] = useState<number>(0);
  const [oldestSeen, setOldestSeen] = useState<string>('');

  // "Bugünün Vardiyaları" ve "Hatalar" sekmesi verileri
  const [shiftsToday, setShiftsToday] = useState<ShiftWithStatus[]>([]);
  const [shiftsTomorrow, setShiftsTomorrow] = useState<ShiftWithStatus[]>([]);
  const [shiftFilter, setShiftFilter] = useState<ShiftFilter>('today');
  const [errors, setErrors] = useState<ErrorRow[]>([]);

  const allowed = currentUser?.role === Role.ADMIN && canSeeDeviceInfo(currentUser?.email);

  useEffect(() => {
    if (!allowed) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);

    // Tüm QR check-in kayıtlarını sayfalı olarak çek (geçmişteki çakışmaları da
    // yakalayabilmek için). Profiles paralel çekilir, loglar sıralı.
    const fetchAllLogs = async (): Promise<RawLog[]> => {
      const all: RawLog[] = [];
      let offset = 0;
      while (offset < HARD_CAP) {
        const { data, error } = await supabase
          .from('time_logs')
          .select('employee_id, device_info, check_in_at')
          .eq('entry_method', 'qr')
          .not('device_info', 'is', null)
          .order('check_in_at', { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);
        if (error || !data || data.length === 0) break;
        all.push(...(data as RawLog[]));
        if (data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      return all;
    };

    // Bugün ve yarın için vardiya + QR durumu (helper içinde gece geçişleri dahil)
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    Promise.all([
      fetchAllLogs(),
      supabase
        .from('profiles')
        .select('id, full_name')
        .limit(1000),
      fetchShiftsForDate(today),
      fetchShiftsForDate(tomorrow),
      supabase
        .from('qr_scan_attempts')
        .select('id, employee_id, employee_name, error_kind, error_detail, action, branch, device_info, attempted_at')
        .eq('status', 'error')
        .order('attempted_at', { ascending: false })
        .limit(200),
    ]).then(([logs, profilesRes, shiftsTodayRes, shiftsTomorrowRes, errorsRes]) => {
      if (cancelled) return;

      const nameMap = new Map<string, string>();
      (profilesRes.data || []).forEach((p: any) => {
        nameMap.set(p.id, p.full_name || '—');
      });

      // === Hata listesi ====================================================
      const errorList: ErrorRow[] = (errorsRes.data || []).map((r: any) => ({
        id: r.id,
        employeeId: r.employee_id,
        employeeName: r.employee_name || nameMap.get(r.employee_id) || '—',
        errorKind: r.error_kind || 'other',
        errorDetail: r.error_detail,
        action: r.action,
        branch: r.branch,
        deviceInfo: r.device_info,
        attemptedAt: r.attempted_at,
      }));

      // employee_id → MAC → { count, lastSeen }
      const perUser = new Map<string, Map<string, { count: number; lastSeen: string }>>();
      // MAC → employee_id → { count, firstSeen, lastSeen }  (çakışma hesabı için)
      const perMac = new Map<string, Map<string, { count: number; firstSeen: string; lastSeen: string }>>();

      let oldest = '';
      logs.forEach(l => {
        if (!l.device_info) return;
        const mac = extractMac(l.device_info).toUpperCase();
        if (!mac) return;
        const ts = l.check_in_at || '';
        if (ts && (oldest === '' || ts < oldest)) oldest = ts;

        // perUser
        if (!perUser.has(l.employee_id)) perUser.set(l.employee_id, new Map());
        const userMap = perUser.get(l.employee_id)!;
        const u = userMap.get(mac) || { count: 0, lastSeen: ts };
        u.count += 1;
        if (ts > u.lastSeen) u.lastSeen = ts;
        userMap.set(mac, u);

        // perMac
        if (!perMac.has(mac)) perMac.set(mac, new Map());
        const macMap = perMac.get(mac)!;
        const m = macMap.get(l.employee_id) || { count: 0, firstSeen: ts, lastSeen: ts };
        m.count += 1;
        if (ts && (m.firstSeen === '' || ts < m.firstSeen)) m.firstSeen = ts;
        if (ts > m.lastSeen) m.lastSeen = ts;
        macMap.set(l.employee_id, m);
      });

      // PersonRow listesi
      const list: PersonRow[] = [];
      perUser.forEach((macMap, employeeId) => {
        const macs: MacUsage[] = Array.from(macMap.entries())
          .map(([mac, v]) => ({ mac, count: v.count, lastSeen: v.lastSeen }))
          .sort((a, b) => b.count - a.count);
        list.push({
          employeeId,
          employeeName: nameMap.get(employeeId) || '—',
          macs,
        });
      });
      list.sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'tr'));

      // Çakışma listesi: sadece 2+ farklı kişinin kullandığı MAC'ler
      const confs: MacConflict[] = [];
      perMac.forEach((userMap, mac) => {
        if (userMap.size < 2) return;
        const users: MacConflictUser[] = Array.from(userMap.entries())
          .map(([uid, v]) => ({
            employeeId: uid,
            employeeName: nameMap.get(uid) || '—',
            count: v.count,
            firstSeen: v.firstSeen,
            lastSeen: v.lastSeen,
          }))
          .sort((a, b) => b.count - a.count);
        const totalCount = users.reduce((s, u) => s + u.count, 0);
        const firstSeen = users.reduce(
          (min, u) => (u.firstSeen && (min === '' || u.firstSeen < min)) ? u.firstSeen : min,
          ''
        );
        const lastSeen = users.reduce((max, u) => u.lastSeen > max ? u.lastSeen : max, '');
        confs.push({ mac, users, totalCount, firstSeen, lastSeen });
      });
      // Çok kişili olanlar üstte, sonra son kullanım yeniliği
      confs.sort((a, b) => {
        if (b.users.length !== a.users.length) return b.users.length - a.users.length;
        return (b.lastSeen || '').localeCompare(a.lastSeen || '');
      });

      setRows(list);
      setConflicts(confs);
      setScannedCount(logs.length);
      setOldestSeen(oldest);
      setShiftsToday(shiftsTodayRes);
      setShiftsTomorrow(shiftsTomorrowRes);
      setErrors(errorList);
      setLoading(false);
    });

    // Realtime: yeni QR hatası anında "Hatalar" sekmesine düşsün
    const channel = supabase
      .channel('qr_scan_attempts_errors')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'qr_scan_attempts', filter: 'status=eq.error' },
        (payload: any) => {
          const r = payload.new;
          if (!r) return;
          setErrors(prev => {
            // Duplicate guard
            if (prev.some(x => x.id === r.id)) return prev;
            const row: ErrorRow = {
              id: r.id,
              employeeId: r.employee_id,
              employeeName: r.employee_name || '—',
              errorKind: r.error_kind || 'other',
              errorDetail: r.error_detail,
              action: r.action,
              branch: r.branch,
              deviceInfo: r.device_info,
              attemptedAt: r.attempted_at,
            };
            return [row, ...prev].slice(0, 200);
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      try { supabase.removeChannel(channel); } catch { /* ignore */ }
    };
  }, [allowed]);

  const filteredPeople = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.employeeName.toLowerCase().includes(q) ||
      r.macs.some(m => m.mac.toLowerCase().includes(q))
    );
  }, [rows, search]);

  const filteredConflicts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conflicts;
    return conflicts.filter(c =>
      c.mac.toLowerCase().includes(q) ||
      c.users.some(u => u.employeeName.toLowerCase().includes(q))
    );
  }, [conflicts, search]);

  const shiftsSource = shiftFilter === 'today' ? shiftsToday : shiftsTomorrow;
  const filteredShifts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return shiftsSource;
    return shiftsSource.filter(s =>
      s.employeeName.toLowerCase().includes(q) ||
      (s.branch || '').toLowerCase().includes(q) ||
      s.status.toLowerCase().includes(q)
    );
  }, [shiftsSource, search]);

  // Özet sayaç: bugünkü vardiyalardan kaçı tamam, kaçı eksik vb.
  const shiftSummary = useMemo(() => {
    const src = shiftsSource;
    return {
      total: src.length,
      complete: src.filter(s => s.status === 'complete').length,
      active: src.filter(s => s.status === 'active').length,
      missing: src.filter(s => s.status === 'no_show').length,
      pending: src.filter(s => s.status === 'pending').length,
      missingOut: src.filter(s => s.status === 'missing_out').length,
    };
  }, [shiftsSource]);

  const filteredErrors = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return errors;
    return errors.filter(e =>
      e.employeeName.toLowerCase().includes(q) ||
      e.errorKind.toLowerCase().includes(q) ||
      (e.branch || '').toLowerCase().includes(q)
    );
  }, [errors, search]);

  const copyMac = async (mac: string) => {
    try {
      await navigator.clipboard.writeText(mac);
      setCopiedMac(mac);
      setTimeout(() => setCopiedMac(null), 1500);
    } catch {
      // sessizce yut
    }
  };

  const totalMacs = rows.reduce((s, r) => s + r.macs.length, 0);

  if (!allowed) {
    return (
      <div className="h-full w-full overflow-y-auto custom-scrollbar p-4 md:p-8 pb-32">
        <div className="max-w-3xl mx-auto bg-white dark:bg-zinc-900/50 border border-red-900/30 rounded-xl p-8 text-center">
          <ShieldAlert size={32} className="text-red-500 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">{t('devices.deniedTitle')}</h2>
          <p className="text-sm text-slate-600 dark:text-zinc-400">{t('devices.deniedDesc')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto custom-scrollbar p-4 md:p-8 pb-32">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <h2 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Smartphone size={26} className="text-cyan-400" />
            {t('devices.title')}
          </h2>
          {!loading && (
            <div className="text-[12px] text-slate-500 dark:text-zinc-500 tabular-nums">
              {rows.length} {t('devices.statUsers').toLowerCase()} · {totalMacs} MAC · {scannedCount.toLocaleString('tr')} {t('devices.recordsScanned')}
              {oldestSeen && (
                <span className="ml-1">
                  ({t('devices.sinceLabel')} {formatDate(oldestSeen, { day: '2-digit', month: 'short', year: 'numeric' })})
                </span>
              )}
            </div>
          )}
        </div>

        {/* Sekme seçimi: Kişiler / Çakışmalar / Okutmayanlar / Hatalar */}
        <div className="mt-4 inline-flex flex-wrap gap-1 bg-white dark:bg-zinc-900/60 border border-slate-200 dark:border-zinc-800 rounded-lg p-1">
          <button
            onClick={() => setTab('people')}
            className={`px-3 py-1.5 text-xs md:text-sm font-medium rounded-md transition-all inline-flex items-center gap-2 ${
              tab === 'people'
                ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow'
                : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:text-zinc-300'
            }`}
          >
            <UserIcon size={14} />
            {t('devices.tabPeople')}
            <span className="text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-slate-50 dark:bg-zinc-950/60 text-slate-600 dark:text-zinc-400">
              {rows.length}
            </span>
          </button>
          <button
            onClick={() => setTab('conflicts')}
            className={`px-3 py-1.5 text-xs md:text-sm font-medium rounded-md transition-all inline-flex items-center gap-2 ${
              tab === 'conflicts'
                ? 'bg-red-950/60 text-red-200 shadow border border-red-900/40'
                : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:text-zinc-300'
            }`}
          >
            <AlertTriangle size={14} />
            {t('devices.tabConflicts')}
            <span className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded ${
              conflicts.length > 0
                ? 'bg-red-900/50 text-red-200'
                : 'bg-slate-50 dark:bg-zinc-950/60 text-slate-600 dark:text-zinc-400'
            }`}>
              {conflicts.length}
            </span>
          </button>
          <button
            onClick={() => setTab('shifts')}
            className={`px-3 py-1.5 text-xs md:text-sm font-medium rounded-md transition-all inline-flex items-center gap-2 ${
              tab === 'shifts'
                ? 'bg-indigo-950/60 text-indigo-200 shadow border border-indigo-900/40'
                : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:text-zinc-300'
            }`}
          >
            <CalendarDays size={14} />
            {t('devices.tabShifts')}
            <span className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded ${
              shiftsToday.length > 0
                ? 'bg-indigo-900/50 text-indigo-200'
                : 'bg-slate-50 dark:bg-zinc-950/60 text-slate-600 dark:text-zinc-400'
            }`}>
              {shiftsToday.length}
            </span>
          </button>
          <button
            onClick={() => setTab('errors')}
            className={`px-3 py-1.5 text-xs md:text-sm font-medium rounded-md transition-all inline-flex items-center gap-2 ${
              tab === 'errors'
                ? 'bg-red-950/60 text-red-200 shadow border border-red-900/40'
                : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:text-zinc-300'
            }`}
          >
            <XCircle size={14} />
            {t('devices.tabErrors')}
            <span className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded ${
              errors.length > 0
                ? 'bg-red-900/50 text-red-200'
                : 'bg-slate-50 dark:bg-zinc-950/60 text-slate-600 dark:text-zinc-400'
            }`}>
              {errors.length}
            </span>
          </button>
        </div>

        {/* Vardiyalar alt filtresi: bugün / yarın + özet rozet */}
        {tab === 'shifts' && (
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <div className="inline-flex bg-white dark:bg-zinc-900/60 border border-slate-200 dark:border-zinc-800 rounded-lg p-1">
              <button
                onClick={() => setShiftFilter('today')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-all inline-flex items-center gap-1.5 ${
                  shiftFilter === 'today'
                    ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow'
                    : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:text-zinc-300'
                }`}
              >
                <Clock size={12} />
                {t('devices.shiftsToday')}
                <span className="text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-slate-50 dark:bg-zinc-950/60 text-slate-600 dark:text-zinc-400">
                  {shiftsToday.length}
                </span>
              </button>
              <button
                onClick={() => setShiftFilter('tomorrow')}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-all inline-flex items-center gap-1.5 ${
                  shiftFilter === 'tomorrow'
                    ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow'
                    : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:text-zinc-300'
                }`}
              >
                <CalendarIcon size={12} />
                {t('devices.shiftsTomorrow')}
                <span className="text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-slate-50 dark:bg-zinc-950/60 text-slate-600 dark:text-zinc-400">
                  {shiftsTomorrow.length}
                </span>
              </button>
            </div>
            {/* Özet sayaçlar */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {shiftSummary.complete > 0 && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_META.complete.tone}`}>
                  {STATUS_META.complete.emoji} {shiftSummary.complete} {t('shiftStatus.complete')}
                </span>
              )}
              {shiftSummary.active > 0 && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_META.active.tone}`}>
                  {STATUS_META.active.emoji} {shiftSummary.active} {t('shiftStatus.active')}
                </span>
              )}
              {shiftSummary.missing > 0 && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_META.no_show.tone}`}>
                  {STATUS_META.no_show.emoji} {shiftSummary.missing} {t('shiftStatus.noShow')}
                </span>
              )}
              {shiftSummary.missingOut > 0 && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_META.missing_out.tone}`}>
                  {STATUS_META.missing_out.emoji} {shiftSummary.missingOut} {t('shiftStatus.missingOut')}
                </span>
              )}
              {shiftSummary.pending > 0 && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_META.pending.tone}`}>
                  {STATUS_META.pending.emoji} {shiftSummary.pending} {t('shiftStatus.pending')}
                </span>
              )}
            </div>
          </div>
        )}

        <div className="mt-4 relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-zinc-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('devices.searchSimple')}
            className="w-full bg-white dark:bg-zinc-900/60 border border-slate-200 dark:border-zinc-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-900 dark:text-white focus:border-cyan-600/60 outline-none transition-all placeholder:text-slate-400 dark:text-zinc-600"
          />
        </div>

        <div className="mt-6 space-y-2">
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 dark:text-zinc-500 text-sm py-8 justify-center">
              <Loader2 size={16} className="animate-spin" /> {t('common.loading')}
            </div>
          ) : tab === 'shifts' ? (
            filteredShifts.length === 0 ? (
              <div className="p-6 bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl text-center text-sm text-slate-500 dark:text-zinc-500 italic">
                {shiftFilter === 'today' ? t('devices.shiftsEmptyToday') : t('devices.shiftsEmptyTomorrow')}
              </div>
            ) : (
              <>
                <div className="text-[11px] text-slate-500 dark:text-zinc-500 px-1 pb-1">
                  {shiftFilter === 'today' ? t('devices.shiftsHintToday') : t('devices.shiftsHintTomorrow')}
                </div>
                {filteredShifts.map((s, idx) => {
                  const meta = STATUS_META[s.status];
                  const fmtTime = (iso: string | null): string => {
                    if (!iso) return '—';
                    const d = new Date(iso);
                    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                  };
                  return (
                    <div
                      key={`${s.employeeId}-${idx}`}
                      className="flex items-center gap-3 bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl px-3 py-2.5"
                    >
                      <div className="w-9 h-9 rounded-full bg-indigo-900/40 border border-indigo-700/40 flex items-center justify-center shrink-0">
                        <UserIcon size={14} className="text-indigo-300" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-slate-900 dark:text-white truncate flex items-center gap-2">
                          {s.employeeName}
                          {s.spansMidnight && (
                            <span className="text-[9px] uppercase tracking-wider bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 px-1.5 py-0.5 rounded border border-violet-200 dark:border-violet-700/40">
                              {t('devices.nightShift')}
                            </span>
                          )}
                          {s.hasError && (
                            <span className="text-[9px] uppercase tracking-wider bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 px-1.5 py-0.5 rounded border border-red-200 dark:border-red-700/40 inline-flex items-center gap-0.5" title={s.errorKind || ''}>
                              <AlertTriangle size={9} /> {t('devices.errorBadge')}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-zinc-500 flex items-center gap-2 flex-wrap">
                          {s.branch && <span className="truncate">{s.branch}</span>}
                          {s.branch && <span className="opacity-40">·</span>}
                          <span className="font-mono">{s.startTime}–{s.endTime}</span>
                          {s.checkInAt && (
                            <>
                              <span className="opacity-40">·</span>
                              <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                                <LogIn size={10} /> {fmtTime(s.checkInAt)}
                              </span>
                            </>
                          )}
                          {s.checkOutAt && (
                            <span className="inline-flex items-center gap-0.5 text-orange-600 dark:text-orange-400">
                              <LogOut size={10} /> {fmtTime(s.checkOutAt)}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-full border shrink-0 inline-flex items-center gap-1 ${meta.tone}`}>
                        <span aria-hidden="true">{meta.emoji}</span>
                        {t(meta.tKey)}
                      </span>
                    </div>
                  );
                })}
              </>
            )
          ) : tab === 'errors' ? (
            filteredErrors.length === 0 ? (
              <div className="p-6 bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl text-center text-sm text-emerald-600 dark:text-emerald-400 italic">
                {t('devices.errorsEmpty')}
              </div>
            ) : filteredErrors.map(e => {
              const meta = ERROR_META[e.errorKind] || ERROR_META.other;
              const Icon = meta.icon;
              return (
                <div
                  key={e.id}
                  className="bg-red-950/15 border border-red-900/40 rounded-xl p-3 md:p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${meta.color}`}>
                      <Icon size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">{e.employeeName}</span>
                        <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border font-mono ${meta.color}`}>
                          {t(`qr.err.${e.errorKind}`)}
                        </span>
                        {e.action && (
                          <span className="text-[10px] uppercase tracking-wider bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 px-2 py-0.5 rounded border border-slate-200 dark:border-zinc-700">
                            {e.action === 'in' ? t('qr.actionIn') : t('qr.actionOut')}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500 dark:text-zinc-500 flex items-center gap-2 flex-wrap">
                        {e.branch && <span>{e.branch}</span>}
                        {e.branch && <span>·</span>}
                        <span>{formatDate(e.attemptedAt, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                        {e.deviceInfo && <><span>·</span><span className="font-mono truncate max-w-[200px]">{e.deviceInfo}</span></>}
                      </div>
                      {e.errorDetail && (
                        <pre className="mt-2 text-[10px] font-mono text-slate-600 dark:text-zinc-500 bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800/60 rounded p-2 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
{e.errorDetail}
                        </pre>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          ) : tab === 'people' ? (
            filteredPeople.length === 0 ? (
              <div className="p-6 bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl text-center text-sm text-slate-500 dark:text-zinc-500 italic">
                {t('devices.empty')}
              </div>
            ) : filteredPeople.map(r => (
              <div
                key={r.employeeId}
                className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-3 md:p-4"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-indigo-900/40 border border-indigo-700/40 flex items-center justify-center shrink-0">
                    <UserIcon size={14} className="text-indigo-300" />
                  </div>
                  <div className="text-sm md:text-base font-semibold text-slate-900 dark:text-white truncate">
                    {r.employeeName}
                  </div>
                  <div className="ml-auto text-[11px] text-slate-500 dark:text-zinc-500 tabular-nums shrink-0">
                    {r.macs.length} MAC
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {r.macs.map(({ mac }) => (
                    <button
                      key={mac}
                      onClick={() => copyMac(mac)}
                      className="group inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 hover:border-cyan-700/60 transition-colors"
                      title={t('devices.copyMac')}
                    >
                      <span className="text-[12px] font-mono text-slate-800 dark:text-zinc-200 tabular-nums">{mac}</span>
                      {copiedMac === mac
                        ? <Check size={12} className="text-emerald-400" />
                        : <Copy size={12} className="text-slate-500 dark:text-zinc-500 group-hover:text-cyan-400" />}
                    </button>
                  ))}
                </div>
              </div>
            ))
          ) : (
            // Çakışma sekmesi
            filteredConflicts.length === 0 ? (
              <div className="p-6 bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl text-center text-sm text-slate-500 dark:text-zinc-500 italic">
                {t('devices.conflictsEmpty')}
              </div>
            ) : filteredConflicts.map(c => (
              <div
                key={c.mac}
                className="bg-red-950/20 border border-red-900/40 rounded-xl p-3 md:p-4"
              >
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <button
                    onClick={() => copyMac(c.mac)}
                    className="group inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-50 dark:bg-zinc-950 border border-red-900/50 hover:border-red-700 transition-colors"
                    title={t('devices.copyMac')}
                  >
                    <span className="text-[10px] uppercase tracking-wider text-red-400">MAC</span>
                    <span className="text-[12px] md:text-[13px] font-mono text-red-100 tabular-nums">{c.mac}</span>
                    {copiedMac === c.mac
                      ? <Check size={12} className="text-emerald-400" />
                      : <Copy size={12} className="text-slate-500 dark:text-zinc-500 group-hover:text-red-300" />}
                  </button>
                  <span className="text-[11px] uppercase tracking-wider bg-red-900/40 text-red-200 px-2 py-0.5 rounded border border-red-800/60 inline-flex items-center gap-1">
                    <AlertTriangle size={10} /> {c.users.length} {t('devices.peopleShort')}
                  </span>
                  <div className="ml-auto text-[11px] text-slate-500 dark:text-zinc-500">
                    {c.totalCount} {t('devices.useShort')}
                  </div>
                </div>
                {(c.firstSeen || c.lastSeen) && (
                  <div className="text-[11px] text-slate-500 dark:text-zinc-500 mb-3">
                    {c.firstSeen ? formatDate(c.firstSeen, { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                    <span className="mx-1.5">→</span>
                    {c.lastSeen ? formatDate(c.lastSeen, { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                  </div>
                )}
                <ul className="space-y-1">
                  {c.users.map(u => (
                    <li
                      key={u.employeeId}
                      className="flex items-center justify-between gap-3 px-2 py-1.5 rounded bg-slate-50 dark:bg-zinc-950/40 border border-slate-200 dark:border-zinc-800/60"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <UserIcon size={12} className="text-indigo-300 shrink-0" />
                        <span className="text-sm text-slate-900 dark:text-white truncate">{u.employeeName}</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 text-[11px]">
                        <span className="text-slate-500 dark:text-zinc-500 hidden sm:inline">
                          {u.firstSeen ? formatDate(u.firstSeen, { day: '2-digit', month: 'short' }) : '—'}
                          <span className="mx-1">→</span>
                          {u.lastSeen ? formatDate(u.lastSeen, { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                        </span>
                        <span className="text-slate-500 dark:text-zinc-500 sm:hidden">
                          {u.lastSeen ? formatDate(u.lastSeen, { day: '2-digit', month: 'short' }) : '—'}
                        </span>
                        <span className="text-slate-900 dark:text-white font-bold tabular-nums w-8 text-right">{u.count}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default DeviceBrands;
