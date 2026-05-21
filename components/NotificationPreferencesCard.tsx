import React, { useEffect, useState } from 'react';
import { Bell, AlertTriangle, ShoppingBag, Clock, FileText, Loader2, RefreshCw, CheckCircle2, BarChart3, MapPin, DoorOpen } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Employee, Role } from '../types';
import { useLanguage } from '../lib/i18n';

// =============================================================
// NotificationPreferencesCard — Admin için bildirim tercihleri
// =============================================================
// Sadece Admin role kullanıcılarına gösterilir.
// 4 toggle: off_shift_sale, weekly_sales_anomaly, off_shift_qr, non_kiosk_check
// + manuel "Şimdi anomali kontrol et" butonu
// =============================================================

interface NotificationPrefs {
  off_shift_sale: boolean;
  weekly_sales_anomaly: boolean;
  off_shift_qr: boolean;
  non_kiosk_check: boolean;
  geofence_enter: boolean;
  geofence_exit: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = {
  off_shift_sale: true,
  weekly_sales_anomaly: true,
  off_shift_qr: true,
  non_kiosk_check: true,
  geofence_enter: true,
  geofence_exit: true,
};

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');

interface Props {
  currentUser: Employee | null;
}

interface ToggleItem {
  key: keyof NotificationPrefs;
  titleKey: string;
  descKey: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}

const TOGGLES: ToggleItem[] = [
  {
    key: 'off_shift_sale',
    titleKey: 'notif.offShiftSaleTitle',
    descKey: 'notif.offShiftSaleDesc',
    icon: ShoppingBag,
    color: 'text-orange-400',
  },
  {
    key: 'weekly_sales_anomaly',
    titleKey: 'notif.weeklyAnomalyTitle',
    descKey: 'notif.weeklyAnomalyDesc',
    icon: BarChart3,
    color: 'text-purple-400',
  },
  {
    key: 'off_shift_qr',
    titleKey: 'notif.offShiftQrTitle',
    descKey: 'notif.offShiftQrDesc',
    icon: Clock,
    color: 'text-amber-400',
  },
  {
    key: 'non_kiosk_check',
    titleKey: 'notif.nonKioskTitle',
    descKey: 'notif.nonKioskDesc',
    icon: FileText,
    color: 'text-blue-400',
  },
  {
    key: 'geofence_enter',
    titleKey: 'notif.geofenceEnterTitle',
    descKey: 'notif.geofenceEnterDesc',
    icon: MapPin,
    color: 'text-emerald-400',
  },
  {
    key: 'geofence_exit',
    titleKey: 'notif.geofenceExitTitle',
    descKey: 'notif.geofenceExitDesc',
    icon: DoorOpen,
    color: 'text-rose-400',
  },
];

const NotificationPreferencesCard: React.FC<Props> = ({ currentUser }) => {
  const { t } = useLanguage();
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [anomalyBusy, setAnomalyBusy] = useState(false);
  const [anomalyMsg, setAnomalyMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = currentUser?.role === Role.ADMIN;

  // İlk yüklemede mevcut tercihleri çek
  useEffect(() => {
    if (!currentUser?.id || !isAdmin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('notification_prefs')
          .eq('id', currentUser.id)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          setError(error.message);
        } else if (data?.notification_prefs) {
          setPrefs({ ...DEFAULT_PREFS, ...data.notification_prefs });
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || t('notif.loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser?.id, isAdmin]);

  const togglePref = async (key: keyof NotificationPrefs) => {
    if (!currentUser?.id) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setSavingKey(key);
    setError(null);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ notification_prefs: next })
        .eq('id', currentUser.id);
      if (error) {
        setPrefs(prefs); // geri al
        setError(error.message);
      }
    } catch (err: any) {
      setPrefs(prefs);
      setError(err?.message || t('notif.saveFailed'));
    } finally {
      setSavingKey(null);
    }
  };

  const runAnomalyCheck = async () => {
    if (!SUPABASE_URL) {
      setAnomalyMsg(t('notif.envMissing'));
      return;
    }
    setAnomalyBusy(true);
    setAnomalyMsg(null);
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/weekly-sales-anomaly`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ threshold: 0.4 }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setAnomalyMsg(t('notif.errorPrefix') + (data?.error || resp.status));
      } else if (data.anomalies === 0) {
        setAnomalyMsg(t('notif.noAnomaly'));
      } else {
        setAnomalyMsg(`${data.anomalies} ${t('notif.anomaliesFound')}`);
      }
    } catch (err: any) {
      setAnomalyMsg(t('notif.errorPrefix') + (err?.message || t('notif.unknownError')));
    } finally {
      setAnomalyBusy(false);
    }
  };

  if (!isAdmin) return null;

  return (
    <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
      <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-1 flex items-center gap-2">
        <Bell size={20} className="text-indigo-400" />
        {t('notif.title')}
      </h3>
      <p className="text-xs text-slate-500 dark:text-zinc-500 mb-4">{t('notif.desc')}</p>

      {loading ? (
        <div className="flex items-center gap-2 text-slate-600 dark:text-zinc-400 text-sm py-6">
          <Loader2 size={16} className="animate-spin" /> {t('notif.loading')}
        </div>
      ) : (
        <div className="space-y-2">
          {TOGGLES.map((item) => {
            const Icon = item.icon;
            const enabled = !!prefs[item.key];
            const saving = savingKey === item.key;
            return (
              <div
                key={item.key}
                className="bg-white dark:bg-zinc-900 rounded-lg p-3 border border-slate-200 dark:border-zinc-800/50 flex items-start gap-3"
              >
                <Icon size={18} className={`${item.color} mt-0.5 shrink-0`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">{t(item.titleKey)}</div>
                  <div className="text-xs text-slate-500 dark:text-zinc-500 mt-0.5">{t(item.descKey)}</div>
                </div>
                <button
                  onClick={() => togglePref(item.key)}
                  disabled={saving}
                  className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                    enabled ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-zinc-700'
                  } ${saving ? 'opacity-60' : ''}`}
                  aria-pressed={enabled}
                  aria-label={t(item.titleKey)}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                      enabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                  {saving && (
                    <Loader2
                      size={10}
                      className="animate-spin absolute -right-5 top-1.5 text-slate-600 dark:text-zinc-400"
                    />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Manuel anomali tetikleyici */}
      <div className="mt-4 pt-4 border-t border-slate-200 dark:border-zinc-800/50">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <BarChart3 size={16} className="text-purple-400" />
              {t('notif.runAnomaly')}
            </div>
            <div className="text-xs text-slate-500 dark:text-zinc-500 mt-1">
              {t('notif.scheduleInfo')}
            </div>
            {anomalyMsg && (
              <div
                className={`text-xs mt-2 flex items-center gap-1 ${
                  anomalyMsg.startsWith(t('notif.errorPrefix').trim())
                    ? 'text-red-400'
                    : 'text-emerald-400'
                }`}
              >
                {anomalyMsg.startsWith(t('notif.errorPrefix').trim()) ? (
                  <AlertTriangle size={12} />
                ) : (
                  <CheckCircle2 size={12} />
                )}
                {anomalyMsg}
              </div>
            )}
          </div>
          <button
            onClick={runAnomalyCheck}
            disabled={anomalyBusy}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-slate-900 dark:text-white text-sm font-medium rounded-lg flex items-center gap-2 shrink-0"
          >
            {anomalyBusy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            {t('notif.runNow')}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 mt-3 flex items-center gap-1">
          <AlertTriangle size={12} /> {error}
        </p>
      )}
    </div>
  );
};

export default NotificationPreferencesCard;
