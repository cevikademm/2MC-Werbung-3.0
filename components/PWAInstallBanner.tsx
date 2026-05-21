import React, { useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, Download, Share, X, Smartphone, Plus, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import {
  isPushSupported,
  isStandaloneMode,
  isIOSSafari,
  registerServiceWorker,
  requestNotificationPermission,
  subscribeToPush,
  unsubscribeFromPush,
  getExistingSubscription,
  getNotificationPermission,
} from '../lib/push';
import { useLanguage } from '../lib/i18n';


// =============================================================
// PWAInstallBanner
// =============================================================
// Görevleri:
// 1. PWA olarak yüklenmemişse ekrana "Ana Ekrana Ekle" yönergesi gösterir.
//    - iOS Safari: Paylaş → Ana Ekrana Ekle görsel adımları
//    - Android/Chrome/Edge: beforeinstallprompt → native dialog
// 2. PWA olarak açıldıysa (display-mode: standalone) bildirim izni / abonelik
//    yönetimini sunar.
// 3. "Daha sonra" → 7 gün boyunca tekrar gösterme (localStorage).
// =============================================================

const SNOOZE_KEY = 'pwa_install_snoozed_until';
const SNOOZE_DAYS = 7;

interface PWAInstallBannerProps {
  /** Aktif kullanıcı id'si — push aboneliğini DB'ye yazarken kullanılır. */
  userId?: string | null;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const isSnoozed = (): boolean => {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return until > Date.now();
  } catch {
    return false;
  }
};

const snooze = (days = SNOOZE_DAYS): void => {
  try {
    localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + days * 24 * 60 * 60 * 1000)
    );
  } catch {
    /* ignore */
  }
};

const PWAInstallBanner: React.FC<PWAInstallBannerProps> = ({ userId }) => {
  const { t } = useLanguage();
  const [standalone, setStandalone] = useState(false);
  const [showInstallHint, setShowInstallHint] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  const ios = useMemo(() => isIOSSafari(), []);

  // ---------------- 1) Standalone tespiti ----------------
  useEffect(() => {
    setStandalone(isStandaloneMode());
    const mq = window.matchMedia('(display-mode: standalone)');
    const onChange = () => setStandalone(isStandaloneMode());
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // ---------------- 2) beforeinstallprompt yakala (Android/desktop) ----------------
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      if (!isStandaloneMode() && !isSnoozed()) {
        setShowInstallHint(true);
      }
    };
    window.addEventListener('beforeinstallprompt', handler);

    // Yüklendikten sonra çıkar
    const installed = () => {
      setShowInstallHint(false);
      setShowIOSGuide(false);
      setDeferredPrompt(null);
      setStandalone(true);
    };
    window.addEventListener('appinstalled', installed);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  // ---------------- 3) iOS Safari için 3sn sonra yönerge ----------------
  useEffect(() => {
    if (!ios || standalone || isSnoozed()) return;
    const t = setTimeout(() => setShowInstallHint(true), 3000);
    return () => clearTimeout(t);
  }, [ios, standalone]);

  // ---------------- Aksiyonlar ----------------

  const handleNativeInstall = async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setShowInstallHint(false);
        setStandalone(true);
      }
    } catch (err) {
      console.error('[PWA] Install prompt hatası:', err);
    } finally {
      setDeferredPrompt(null);
    }
  };

  const handleSnooze = () => {
    snooze();
    setShowInstallHint(false);
    setShowIOSGuide(false);
  };

  // ---------------- Render ----------------

  // PWA olarak kuruluysa banner gösterme. (Push durumu Settings sayfasına bırakılır.)
  if (standalone) return null;

  // Snooze edilmişse veya henüz tetiklenmediyse hiçbir şey gösterme
  if (!showInstallHint && !showIOSGuide) return null;

  // iOS yönerge modal'ı
  if (showIOSGuide) {
    return (
      <div className="fixed inset-0 z-[100] flex items-end md:items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div className="w-full max-w-md bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-zinc-800">
            <div className="flex items-center gap-2 text-slate-900 dark:text-white font-semibold">
              <Smartphone size={18} className="text-indigo-400" />
              {t('pwa.addToHome')}
            </div>
            <button
              onClick={() => setShowIOSGuide(false)}
              className="text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white"
              aria-label={t('pwa.close')}
            >
              <X size={18} />
            </button>
          </div>
          <div className="p-5 space-y-4 text-sm text-slate-800 dark:text-zinc-200">
            <p>
              {t('pwa.iosIntro')}
              <strong className="text-slate-900 dark:text-white"> {t('pwa.iosIntroBold')}</strong> {t('pwa.iosIntroEnd')}
            </p>
            <ol className="space-y-3">
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-indigo-600 text-slate-900 dark:text-white text-xs flex items-center justify-center font-bold shrink-0">
                  1
                </span>
                <span>
                  {t('pwa.step1Pre')}{' '}
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 dark:bg-zinc-800 rounded">
                    <Share size={14} className="text-blue-400" /> {t('pwa.step1Btn')}
                  </span>{' '}
                  {t('pwa.step1Post')}
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-indigo-600 text-slate-900 dark:text-white text-xs flex items-center justify-center font-bold shrink-0">
                  2
                </span>
                <span>
                  {t('pwa.step2Pre')}{' '}
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 dark:bg-zinc-800 rounded">
                    <Plus size={14} className="text-emerald-400" /> {t('pwa.step2Btn')}
                  </span>{' '}
                  {t('pwa.step2Post')}
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 rounded-full bg-indigo-600 text-slate-900 dark:text-white text-xs flex items-center justify-center font-bold shrink-0">
                  3
                </span>
                <span>
                  {t('pwa.step3Pre')} <strong>{t('pwa.step3Bold')}</strong>{t('pwa.step3Post')}
                </span>
              </li>
            </ol>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-900/20 border border-amber-700/40 text-amber-200 text-xs">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div>
                <strong>{t('pwa.iosLimitsBold')}</strong> {t('pwa.iosLimits')}{' '}
                <code>requireInteraction</code> {t('pwa.iosLimitsEnd')}
              </div>
            </div>
          </div>
          <div className="px-5 py-3 border-t border-slate-200 dark:border-zinc-800 flex justify-end gap-2">
            <button
              onClick={handleSnooze}
              className="px-3 py-2 text-xs text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white"
            >
              {t('pwa.snooze7')}
            </button>
            <button
              onClick={() => setShowIOSGuide(false)}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-slate-900 dark:text-white rounded-lg text-sm font-medium"
            >
              {t('pwa.understood')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Alt banner (iOS hint butonu veya Android native install)
  return (
    <div
      className="fixed left-0 right-0 z-[90] px-3 pointer-events-none"
      style={{
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)',
      }}
    >
      <div className="max-w-md mx-auto pointer-events-auto bg-white dark:bg-zinc-900/95 backdrop-blur-xl border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl p-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-600/30 flex items-center justify-center text-indigo-400 shrink-0">
          <Download size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
            {t('pwa.installApp')}
          </div>
          <div className="text-[11px] text-slate-600 dark:text-zinc-400 truncate">
            {ios ? t('pwa.iosTeaser') : t('pwa.androidTeaser')}
          </div>
        </div>
        {ios ? (
          <button
            onClick={() => setShowIOSGuide(true)}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-slate-900 dark:text-white text-xs font-bold rounded-lg shrink-0"
          >
            {t('pwa.howTo')}
          </button>
        ) : (
          <button
            onClick={handleNativeInstall}
            disabled={!deferredPrompt}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-slate-900 dark:text-white text-xs font-bold rounded-lg shrink-0"
          >
            {t('pwa.install')}
          </button>
        )}
        <button
          onClick={handleSnooze}
          className="text-slate-500 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white p-1 shrink-0"
          aria-label={t('pwa.later')}
          title={t('pwa.snooze7')}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
};

export default PWAInstallBanner;

// =============================================================
// Bonus: Standalone modda Settings sayfasına gömülecek küçük
// "Bildirim aboneliği" kartı. PWAInstallBanner'dan ayrı export.
// =============================================================
export const PushSubscriptionCard: React.FC<PWAInstallBannerProps> = ({ userId }) => {
  const { t } = useLanguage();
  const supported = useMemo(() => isPushSupported(), []);
  const standalone = useMemo(() => isStandaloneMode(), []);
  const ios = useMemo(() => isIOSSafari(), []);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('unsupported');
  const [hasSubscription, setHasSubscription] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    (async () => {
      try {
        await registerServiceWorker();
        if (cancelled) return;
        setPermission(getNotificationPermission());
        const sub = await getExistingSubscription();
        if (!cancelled) setHasSubscription(!!sub);
      } catch (err) {
        console.error('[Push] Card init error:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const enable = async () => {
    if (!userId) {
      setError(t('pwa.loginFirst'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const perm = await requestNotificationPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setError(
          perm === 'denied'
            ? t('pwa.permDeniedDetail')
            : t('pwa.permFailed')
        );
        return;
      }
      const sub = await subscribeToPush(userId);
      setHasSubscription(!!sub);
    } catch (err: any) {
      setError(err?.message || t('pwa.subFailed'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      await unsubscribeFromPush();
      setHasSubscription(false);
    } catch (err: any) {
      setError(err?.message || t('pwa.unsubFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
        <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-2 flex items-center gap-2">
          <BellOff size={20} className="text-slate-500 dark:text-zinc-500" />
          {t('pwa.pushTitle')}
        </h3>
        <p className="text-sm text-slate-600 dark:text-zinc-400">
          {t('pwa.pushUnsupported')}
        </p>
      </div>
    );
  }

  if (ios && !standalone) {
    return (
      <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
        <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-2 flex items-center gap-2">
          <Bell size={20} className="text-indigo-400" />
          {t('pwa.pushTitle')}
        </h3>
        <p className="text-sm text-slate-700 dark:text-zinc-300 mb-2">
          {t('pwa.iosNeedsHomeScreenPre')}{' '}
          <strong className="text-slate-900 dark:text-white">{t('pwa.iosNeedsHomeScreenBold')}</strong> {t('pwa.iosNeedsHomeScreenPost')}
        </p>
        <div className="text-xs text-amber-300/90 bg-amber-900/15 border border-amber-700/30 rounded-lg p-3">
          {t('pwa.iosShareSteps')}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
      <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-4 flex items-center gap-2">
        <Bell size={20} className="text-indigo-400" />
        {t('pwa.pushTitle')}
      </h3>
      <div className="bg-white dark:bg-zinc-900 rounded-lg p-4 border border-slate-200 dark:border-zinc-800/50 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-slate-800 dark:text-zinc-200 text-sm font-medium mb-1">
            {hasSubscription ? t('pwa.subActive') : t('pwa.subAsk')}
          </p>
          <p className="text-xs text-slate-500 dark:text-zinc-500">
            {t('pwa.permHint')}
          </p>
          {error && (
            <p className="text-xs text-red-400 mt-2 flex items-center gap-1">
              <AlertTriangle size={12} /> {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasSubscription ? (
            <>
              <span className="text-emerald-400 text-xs flex items-center gap-1">
                <CheckCircle2 size={14} /> {t('pwa.active')}
              </span>
              <button
                onClick={disable}
                disabled={busy}
                className="px-3 py-2 bg-slate-100 dark:bg-zinc-800 hover:bg-red-900/30 text-slate-700 dark:text-zinc-300 hover:text-red-400 rounded-lg text-xs font-medium border border-slate-300 dark:border-zinc-700"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : t('pwa.disable')}
              </button>
            </>
          ) : (
            <button
              onClick={enable}
              disabled={busy || permission === 'denied'}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-slate-900 dark:text-white text-sm font-medium rounded-lg flex items-center gap-2"
            >
              {busy ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Bell size={14} />
              )}
              {permission === 'denied' ? t('pwa.permDenied') : t('pwa.enableNotif')}
            </button>
          )}
        </div>
      </div>

      {ios && standalone && (
        <div className="mt-3 text-xs text-amber-300/90 bg-amber-900/15 border border-amber-700/30 rounded-lg p-3">
          <strong>{t('pwa.iosNoteBold')}</strong> {t('pwa.iosNote')}{' '}
          <code>requireInteraction</code> {t('pwa.iosNoteEnd')}
        </div>
      )}
    </div>
  );
};
