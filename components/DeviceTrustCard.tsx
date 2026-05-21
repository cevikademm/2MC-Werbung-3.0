import React, { useEffect, useMemo, useState } from 'react';
import { Smartphone, Star, ShieldAlert, Loader2, MapPin, Calendar as CalendarIcon, Clock, AlertTriangle } from 'lucide-react';
import { Employee, Role } from '../types';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../lib/i18n';
import { canSeeDeviceInfo } from '../lib/utils';

// QR girişlerinde tespit edilen cihaz markası kayıtlardan gelir.
// Min 3 kayıt + diğer cihazlardan en az 2 kat fazla kullanım → "alışılmış cihaz".
// Bu eşik Payroll.tsx'teki deviceConflicts mantığıyla birebir aynıdır.
const DOMINANT_MIN_COUNT = 3;
const DOMINANCE_RATIO = 2;

interface RawLog {
  id: string;
  employee_id: string;
  device_info: string | null;
  date: string;
  start_time: string | null;
  branch: string | null;
  check_in_at: string | null;
  entry_method: string | null;
}

interface DeviceUsage {
  device: string;
  count: number;
  lastSeen: string;
  isDominant: boolean;
}

// Belirli bir log kümesinden (tek kullanıcının ya da tüm sistemin) her kullanıcının
// alışılmış cihazını çıkarır.
function buildDominantMap(logs: RawLog[]): Map<string, string> {
  const userDeviceCounts = new Map<string, Map<string, number>>();
  logs.forEach(l => {
    if (l.entry_method !== 'qr' || !l.device_info) return;
    if (!userDeviceCounts.has(l.employee_id)) userDeviceCounts.set(l.employee_id, new Map());
    const counts = userDeviceCounts.get(l.employee_id)!;
    counts.set(l.device_info, (counts.get(l.device_info) || 0) + 1);
  });
  const dominant = new Map<string, string>();
  userDeviceCounts.forEach((counts, userId) => {
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (sorted[0] && sorted[0][1] >= DOMINANT_MIN_COUNT) {
      const second = sorted[1]?.[1] || 0;
      if (sorted[0][1] >= second * DOMINANCE_RATIO || second === 0) {
        dominant.set(userId, sorted[0][0]);
      }
    }
  });
  return dominant;
}

// =====================================================================
// 1) Kullanıcının kendi cihaz geçmişi — herkese görünür
// =====================================================================
export const DeviceHistoryCard: React.FC<{ currentUser: Employee | null }> = ({ currentUser }) => {
  const { t, formatDate } = useLanguage();
  const [logs, setLogs] = useState<RawLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from('time_logs')
      .select('id, employee_id, device_info, date, start_time, branch, check_in_at, entry_method')
      .eq('employee_id', currentUser.id)
      .eq('entry_method', 'qr')
      .not('device_info', 'is', null)
      .order('check_in_at', { ascending: false })
      .limit(500)
      .then(({ data }) => {
        if (cancelled) return;
        setLogs((data as RawLog[]) || []);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [currentUser?.id]);

  const usages = useMemo<DeviceUsage[]>(() => {
    const counts = new Map<string, { count: number; lastSeen: string }>();
    logs.forEach(l => {
      if (!l.device_info) return;
      const cur = counts.get(l.device_info) || { count: 0, lastSeen: l.check_in_at || l.date };
      cur.count += 1;
      const ts = l.check_in_at || l.date;
      if (ts > cur.lastSeen) cur.lastSeen = ts;
      counts.set(l.device_info, cur);
    });
    const dominant = buildDominantMap(logs).get(currentUser?.id || '');
    return Array.from(counts.entries())
      .map(([device, v]) => ({ device, count: v.count, lastSeen: v.lastSeen, isDominant: device === dominant }))
      .sort((a, b) => b.count - a.count);
  }, [logs, currentUser?.id]);

  return (
    <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
      <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-2 flex items-center gap-2">
        <Smartphone size={20} className="text-cyan-400" />
        {t('set.deviceHistoryTitle')}
      </h3>
      <p className="text-sm text-slate-600 dark:text-zinc-400 mb-4">{t('set.deviceHistoryDesc')}</p>

      {loading ? (
        <div className="flex items-center gap-2 text-slate-500 dark:text-zinc-500 text-sm py-4"><Loader2 size={14} className="animate-spin" /> {t('common.loading')}</div>
      ) : usages.length === 0 ? (
        <div className="p-4 bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 text-sm text-slate-500 dark:text-zinc-500 italic text-center">
          {t('set.deviceHistoryEmpty')}
        </div>
      ) : (
        <ul className="space-y-2">
          {usages.map(u => (
            <li key={u.device} className={`flex items-center justify-between gap-3 p-3 rounded-lg border ${u.isDominant ? 'bg-cyan-900/10 border-cyan-700/40' : 'bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-800/50'}`}>
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Smartphone size={18} className={u.isDominant ? 'text-cyan-400 shrink-0' : 'text-slate-500 dark:text-zinc-500 shrink-0'} />
                <div className="min-w-0">
                  <div className="text-sm text-slate-900 dark:text-white font-medium truncate flex items-center gap-2">
                    {u.device}
                    {u.isDominant && (
                      <span className="text-[10px] uppercase tracking-wider bg-cyan-900/40 text-cyan-300 px-1.5 py-0.5 rounded border border-cyan-800/60 inline-flex items-center gap-1">
                        <Star size={10} /> {t('set.deviceUsual')}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-zinc-500 mt-0.5">
                    {t('set.deviceLastSeen')}: {formatDate(u.lastSeen, { day: '2-digit', month: 'short', year: 'numeric' })}
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-bold text-slate-900 dark:text-white tabular-nums">{u.count}</div>
                <div className="text-[10px] text-slate-500 dark:text-zinc-500 uppercase tracking-wider">{t('set.deviceUseCount')}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// =====================================================================
// 2) Admin-only telefon çakışmaları
//    "Saniye QR mesai açtı ama bu Mehmet'in telefonu" tipi durumları gösterir.
// =====================================================================
interface ConflictRow {
  logId: string;
  employeeId: string;
  employeeName: string;
  date: string;
  time: string;
  branch: string;
  deviceUsed: string;
  expectedDevice: string;
  ownerName: string | null;     // bu cihazın asıl sahibi (varsa)
  ownerEmployeeId: string | null;
  checkInAt: string | null;
}

export const PhoneConflictsCard: React.FC<{ currentUser: Employee | null }> = ({ currentUser }) => {
  const { t, formatDate } = useLanguage();
  const [logs, setLogs] = useState<RawLog[]>([]);
  const [empMap, setEmpMap] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  // Sadece adminler ve canSeeDeviceInfo allowlist'i çağırır
  const allowed = currentUser?.role === Role.ADMIN && canSeeDeviceInfo(currentUser?.email);

  useEffect(() => {
    if (!allowed) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);

    Promise.all([
      supabase
        .from('time_logs')
        .select('id, employee_id, device_info, date, start_time, branch, check_in_at, entry_method')
        .eq('entry_method', 'qr')
        .not('device_info', 'is', null)
        .order('check_in_at', { ascending: false })
        .limit(2000),
      supabase
        .from('profiles')
        .select('id, full_name')
        .limit(1000),
    ]).then(([logsRes, profilesRes]) => {
      if (cancelled) return;
      setLogs((logsRes.data as RawLog[]) || []);
      const m = new Map<string, string>();
      (profilesRes.data || []).forEach((p: any) => { m.set(p.id, p.full_name || '—'); });
      setEmpMap(m);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [allowed]);

  const conflicts = useMemo<ConflictRow[]>(() => {
    if (!allowed || !logs.length) return [];
    const dominant = buildDominantMap(logs);

    // Cihaz → sahip (alışılmış cihazı bu cihaz olan kullanıcı) eşlemesi.
    // Aynı cihazın birden çok kullanıcının "dominant"ı olması teorik olarak
    // mümkün; ilk eşleşeni alıyoruz (genellikle olmaz).
    const deviceOwner = new Map<string, string>();
    dominant.forEach((device, userId) => {
      if (!deviceOwner.has(device)) deviceOwner.set(device, userId);
    });

    const rows: ConflictRow[] = [];
    logs.forEach(l => {
      if (!l.device_info) return;
      const expected = dominant.get(l.employee_id);
      if (!expected || expected === l.device_info) return; // çakışma yok

      const ownerId = deviceOwner.get(l.device_info) || null;
      rows.push({
        logId: l.id,
        employeeId: l.employee_id,
        employeeName: empMap.get(l.employee_id) || '—',
        date: l.date,
        time: (l.start_time || '').slice(0, 5),
        branch: l.branch || '—',
        deviceUsed: l.device_info,
        expectedDevice: expected,
        ownerName: ownerId ? (empMap.get(ownerId) || null) : null,
        ownerEmployeeId: ownerId,
        checkInAt: l.check_in_at,
      });
    });
    rows.sort((a, b) => (b.checkInAt || b.date).localeCompare(a.checkInAt || a.date));
    return rows;
  }, [logs, empMap, allowed]);

  if (!allowed) return null;

  return (
    <div className="bg-white dark:bg-zinc-900/50 border border-red-900/30 rounded-xl p-6">
      <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-2 flex items-center gap-2">
        <ShieldAlert size={20} className="text-red-500" />
        {t('set.phoneConflictsTitle')}
        {!loading && conflicts.length > 0 && (
          <span className="ml-auto text-[10px] uppercase tracking-wider bg-red-900/40 text-red-300 px-2 py-0.5 rounded-full border border-red-800/60">
            {conflicts.length}
          </span>
        )}
      </h3>
      <p className="text-sm text-slate-600 dark:text-zinc-400 mb-4">{t('set.phoneConflictsDesc')}</p>

      {loading ? (
        <div className="flex items-center gap-2 text-slate-500 dark:text-zinc-500 text-sm py-4"><Loader2 size={14} className="animate-spin" /> {t('common.loading')}</div>
      ) : conflicts.length === 0 ? (
        <div className="p-4 bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 text-sm text-slate-500 dark:text-zinc-500 italic text-center flex items-center justify-center gap-2">
          <span className="text-emerald-400">✓</span> {t('set.phoneConflictsEmpty')}
        </div>
      ) : (
        <ul className="space-y-2 max-h-[480px] overflow-y-auto custom-scrollbar pr-1">
          {conflicts.map(c => (
            <li key={c.logId} className="p-3 rounded-lg bg-red-900/10 border border-red-900/40">
              <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="text-red-400 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-sm font-bold text-slate-900 dark:text-white">{c.employeeName}</span>
                    <span className="text-[10px] text-slate-500 dark:text-zinc-500">QR</span>
                    <span className="ml-auto text-[10px] text-slate-500 dark:text-zinc-500 inline-flex items-center gap-1">
                      <CalendarIcon size={10} />
                      {formatDate(c.date, { day: '2-digit', month: 'short', year: 'numeric' })}
                      <Clock size={10} className="ml-1" />
                      <span className="font-mono">{c.time || '—'}</span>
                      <MapPin size={10} className="ml-1" />
                      <span>{c.branch}</span>
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2 text-xs">
                    <div className="p-2 rounded bg-slate-50 dark:bg-zinc-950/60 border border-red-900/30">
                      <div className="text-[10px] uppercase tracking-wider text-red-400 mb-1">
                        {t('set.deviceUsedLabel')}
                      </div>
                      <div className="text-slate-900 dark:text-white font-mono break-all">{c.deviceUsed}</div>
                      <div className="text-[11px] mt-1.5">
                        {c.ownerName ? (
                          <span className="text-amber-300">
                            ⚠ {t('set.deviceBelongsTo')}: <strong className="text-amber-200">{c.ownerName}</strong>
                          </span>
                        ) : (
                          <span className="text-slate-500 dark:text-zinc-500 italic">{t('set.deviceOwnerUnknown')}</span>
                        )}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800/60">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-500 mb-1">
                        {t('set.deviceExpectedLabel')}
                      </div>
                      <div className="text-slate-700 dark:text-zinc-300 font-mono break-all">{c.expectedDevice}</div>
                      <div className="text-[11px] mt-1.5 text-slate-500 dark:text-zinc-500">
                        {t('set.deviceExpectedHint').replace('{name}', c.employeeName)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
