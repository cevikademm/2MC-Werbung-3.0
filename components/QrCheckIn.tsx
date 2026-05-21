import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  QrCode, Camera, MapPin, CheckCircle, AlertTriangle, XCircle, Loader2, LogIn, LogOut,
  ShieldCheck, ShieldAlert, Smartphone, MessageCircle
} from 'lucide-react';
import { BrowserQRCodeReader, IScannerControls } from '@zxing/browser';
import { Employee } from '../types';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../lib/i18n';
import { notifyEvent } from '../lib/notifyEvent';
import { detectDeviceInfo } from '../lib/utils';
import { setShiftActive, clearShiftActive } from '../lib/geofence';

type Phase = 'idle' | 'scanning' | 'posting' | 'result' | 'error';
type ScanAction = 'in' | 'out';

type RpcResponse = {
  ok: boolean;
  error?: 'invalid_qr' | 'already_checked_in' | 'not_checked_in';
  action?: 'in' | 'out';
  status?: 'Onaylandı' | 'Bekliyor';
  branch?: string;
  start_time?: string;
  end_time?: string;
  total_hours?: number;
  in_range?: boolean;
  log_id?: string;
};

type ErrorKind =
  | 'camera_denied'
  | 'no_camera'
  | 'insecure_context'
  | 'network'
  | 'invalid_qr'
  | 'already_checked_in'
  | 'not_checked_in'
  | 'other';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Props {
  currentUser: Employee;
  onComplete?: () => void;
}

// Her QR denemesini (başarılı/başarısız) qr_scan_attempts tablosuna log'lar.
// Başarısız denemelerde ayrıca notifyEvent ile admin'e bildirim düşürür.
// "fire-and-forget" — UI'ı bloklamaz.
async function logScanAttempt(args: {
  employee: Employee;
  status: 'success' | 'error';
  errorKind?: string | null;
  errorDetail?: string;
  action: ScanAction;
  branch?: string | null;
  deviceInfo?: string | null;
}) {
  try {
    await supabase.from('qr_scan_attempts').insert({
      employee_id: args.employee.id,
      employee_name: args.employee.name,
      status: args.status,
      error_kind: args.errorKind || null,
      error_detail: args.errorDetail || null,
      action: args.action,
      branch: args.branch || (args.employee as any).branch || null,
      device_info: args.deviceInfo || null,
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    });
  } catch (e) {
    console.warn('[QR] qr_scan_attempts insert failed:', e);
  }
}

const QrCheckIn: React.FC<Props> = ({ currentUser, onComplete }) => {
  const { t } = useLanguage();
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [errorDetail, setErrorDetail] = useState<string>('');
  const [result, setResult] = useState<RpcResponse | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const decodedRef = useRef<boolean>(false);
  const locationPromiseRef = useRef<Promise<GeolocationPosition | null> | null>(null);
  const actionRef = useRef<ScanAction>('in');

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, []);

  // Start scanner when entering 'scanning' phase (video element already mounted)
  useEffect(() => {
    if (phase !== 'scanning') {
      controlsRef.current?.stop();
      controlsRef.current = null;
      return;
    }

    if (!videoRef.current) {
      // safety — shouldn't happen since video is pre-mounted
      setErrorKind('other');
      setErrorDetail('Video element not mounted');
      setPhase('error');
      return;
    }

    let cancelled = false;

    const start = async () => {
      // Secure context check (covers deployed HTTP)
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setErrorKind('insecure_context');
        setErrorDetail('window.isSecureContext = false');
        setPhase('error');
        return;
      }

      const reader = new BrowserQRCodeReader(undefined, {
        delayBetweenScanAttempts: 150,
      });

      const onResult = (res: any, _err: any, ctrls: IScannerControls) => {
        if (cancelled) return;
        if (res && !decodedRef.current) {
          const text = res.getText().trim();
          if (!UUID_RE.test(text)) return;
          decodedRef.current = true;
          ctrls.stop();
          controlsRef.current = null;
          submit(text);
        }
      };

      try {
        // Prefer back camera for QR scanning
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } } },
          videoRef.current!,
          onResult
        );
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
      } catch (e: any) {
        console.error('[QR] scanner start error:', e);
        if (cancelled) return;

        // Fallback: any camera if environment-facing not available
        const name = e?.name || '';
        if (name === 'OverconstrainedError' || name === 'NotFoundError') {
          try {
            const controls = await reader.decodeFromVideoDevice(
              undefined,
              videoRef.current!,
              onResult
            );
            if (cancelled) {
              controls.stop();
              return;
            }
            controlsRef.current = controls;
            return;
          } catch (e2: any) {
            console.error('[QR] fallback camera error:', e2);
            classifyError(e2);
            return;
          }
        }
        classifyError(e);
      }
    };

    const classifyError = (e: any) => {
      const name = e?.name || '';
      const msg = e?.message || String(e);
      const code = e?.code != null ? String(e.code) : '';
      const parts = [
        `name: ${name || 'Error'}`,
        `message: ${msg}`,
      ];
      if (code) parts.push(`code: ${code}`);
      const detail = parts.join('\n');
      setErrorDetail(detail);
      let kind: ErrorKind;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        kind = 'camera_denied';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        kind = 'no_camera';
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        kind = 'no_camera';
      } else if (name === 'SecurityError') {
        kind = 'insecure_context';
      } else {
        kind = 'other';
      }
      setErrorKind(kind);
      setPhase('error');
      // Hatayı log'la + admin'e bildirim düşür
      void logScanAttempt({
        employee: currentUser,
        status: 'error',
        errorKind: kind,
        errorDetail: detail,
        action: actionRef.current,
        deviceInfo: deviceLabel,
      });
      notifyEvent({
        type: 'qr_scan_error',
        employee_id: currentUser.id,
        employee_name: currentUser.name,
        branch: (currentUser as any).branch,
        action: actionRef.current,
        error_kind: kind,
        error_detail: detail,
        device_info: deviceLabel,
        at: new Date().toISOString(),
      });
    };

    start();

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [phase]);

  const getLocation = (): Promise<GeolocationPosition | null> =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(pos),
        (err) => {
          console.warn('[QR] geolocation error:', err);
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
      );
    });

  const handleStart = (action: ScanAction) => {
    actionRef.current = action;
    setErrorKind(null);
    setErrorDetail('');
    setResult(null);
    decodedRef.current = false;
    // Kick off geolocation in parallel (don't block camera on it)
    locationPromiseRef.current = getLocation();
    setPhase('scanning');
  };

  const submit = async (token: string) => {
    setPhase('posting');
    const pos = await (locationPromiseRef.current ?? Promise.resolve(null));
    const lat = pos?.coords.latitude ?? null;
    const lng = pos?.coords.longitude ?? null;

    try {
      const { data, error } = await supabase.rpc('qr_check_in_out', {
        p_employee_id: currentUser.id,
        p_qr_token: token,
        p_lat: lat,
        p_lng: lng,
        p_action: actionRef.current,
        p_device_info: deviceLabel,
      });
      if (error) throw error;

      const resp = data as RpcResponse;
      if (!resp?.ok) {
        // Farklı iş-kuralı hatalarını ayır
        let kind: ErrorKind;
        let detail: string;
        if (resp?.error === 'already_checked_in') {
          kind = 'already_checked_in';
          const extras: string[] = [`branch: ${(resp as any).branch ?? '—'}`];
          if ((resp as any).start_time) extras.push(`start_time: ${(resp as any).start_time}`);
          detail = extras.join('\n');
        } else if (resp?.error === 'not_checked_in') {
          kind = 'not_checked_in';
          detail = 'no open time_log row for today';
        } else {
          kind = 'invalid_qr';
          detail = resp?.error || 'Unknown RPC error';
        }
        setErrorKind(kind);
        setErrorDetail(detail);
        setPhase('error');
        void logScanAttempt({
          employee: currentUser,
          status: 'error',
          errorKind: kind,
          errorDetail: detail,
          action: actionRef.current,
          branch: (resp as any).branch,
          deviceInfo: deviceLabel,
        });
        notifyEvent({
          type: 'qr_scan_error',
          employee_id: currentUser.id,
          employee_name: currentUser.name,
          branch: (resp as any).branch || (currentUser as any).branch,
          action: actionRef.current,
          error_kind: kind,
          error_detail: detail,
          device_info: deviceLabel,
          at: new Date().toISOString(),
        });
        return;
      }
      setResult(resp);
      setPhase('result');
      // Başarılı denemeyi de log'la (zaten time_logs'a yazıldı ama
      // qr_scan_attempts ortak metrik için tek noktada)
      void logScanAttempt({
        employee: currentUser,
        status: 'success',
        action: actionRef.current,
        branch: resp.branch,
        deviceInfo: deviceLabel,
      });
      // Notify parent (Payroll) so list refreshes immediately on mobile
      onComplete?.();

      // Canlı konum tracker'ı aç/kapat — Harita sekmesi için.
      // 'in' başarılıysa flag aktif, 'out' başarılıysa silinir.
      if (actionRef.current === 'in') {
        setShiftActive(currentUser.id);
      } else if (actionRef.current === 'out') {
        clearShiftActive();
      }

      // Vardiya saati dışı QR ise admin'e push (edge function shift kontrolü yapar)
      notifyEvent({
        type: 'off_shift_qr',
        employee_id: currentUser.id,
        employee_name: currentUser.name,
        branch: (resp as any).branch,
        action: actionRef.current,
        at: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[QR] qr_check_in_out RPC error:', err);
      const parts = [
        `name: ${err?.name || 'Error'}`,
        `message: ${err?.message || String(err)}`,
      ];
      if (err?.code) parts.push(`code: ${err.code}`);
      if (err?.status) parts.push(`status: ${err.status}`);
      if (err?.hint) parts.push(`hint: ${err.hint}`);
      const detail = parts.join('\n');
      setErrorKind('network');
      setErrorDetail(detail);
      setPhase('error');
      void logScanAttempt({
        employee: currentUser,
        status: 'error',
        errorKind: 'network',
        errorDetail: detail,
        action: actionRef.current,
        deviceInfo: deviceLabel,
      });
      notifyEvent({
        type: 'qr_scan_error',
        employee_id: currentUser.id,
        employee_name: currentUser.name,
        branch: (currentUser as any).branch,
        action: actionRef.current,
        error_kind: 'network',
        error_detail: detail,
        device_info: deviceLabel,
        at: new Date().toISOString(),
      });
    }
  };

  const reset = () => {
    setPhase('idle');
    setResult(null);
    setErrorKind(null);
    setErrorDetail('');
    decodedRef.current = false;
  };

  const errorMessage = (): string => {
    switch (errorKind) {
      case 'camera_denied': return t('qr.cameraDenied');
      case 'no_camera': return t('qr.noCamera');
      case 'insecure_context': return t('qr.insecureContext');
      case 'network': return t('qr.networkError');
      case 'invalid_qr': return t('qr.invalidQr');
      case 'already_checked_in': return t('qr.alreadyCheckedIn');
      case 'not_checked_in': return t('qr.notCheckedIn');
      default: return t('qr.networkError');
    }
  };

  // Tarayıcının User-Agent'ından cihaz markası+modelini çöz. Kullanıcının
  // kendi telefonu olduğu için herkes görür (admin filtresi yok); QR
  // taramadan önce hangi cihaz bilgisinin RPC'ye gideceği şeffaf olsun diye.
  const deviceLabel = useMemo(() => detectDeviceInfo(), []);

  // Environment diagnostics (pre-scan)
  const diag = (() => {
    if (typeof window === 'undefined') return null;
    const proto = window.location?.protocol || '';
    const host = window.location?.hostname || '';
    const secure = window.isSecureContext;
    const hasCamera = !!navigator.mediaDevices?.getUserMedia;
    const hasGeo = !!navigator.geolocation;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    // Secure context = HTTPS or localhost
    const isOk = secure && hasCamera && hasGeo;
    return { proto, host, secure, hasCamera, hasGeo, isLocalhost, isOk };
  })();

  return (
    <div className="p-4 md:p-8 max-w-2xl mx-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <QrCode size={24} /> {t('qr.title')}
        </h2>
        <p className="text-sm text-slate-600 dark:text-zinc-400 mt-1">{t('qr.subtitle')}</p>
      </div>

      {/* Scanner view — video always in DOM, visibility controlled by phase */}
      <div
        className={`rounded-2xl border border-slate-200 dark:border-zinc-800 bg-black overflow-hidden relative aspect-square ${
          phase === 'scanning' ? 'block' : 'hidden'
        }`}
      >
        <video
          ref={videoRef}
          className="w-full h-full object-cover"
          muted
          playsInline
          autoPlay
        />
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
          <motion.div
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 1.6, repeat: Infinity }}
            className="w-64 h-64 border-2 border-emerald-400/80 rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
          />
        </div>
        <div className="absolute bottom-4 left-0 right-0 text-center">
          <p className="text-slate-900 dark:text-white text-sm bg-black/60 inline-block px-4 py-2 rounded-full">
            {t('qr.scanning')}
          </p>
        </div>
        <button
          onClick={reset}
          className="absolute top-3 right-3 w-9 h-9 rounded-full bg-black/60 text-slate-900 dark:text-white flex items-center justify-center"
          aria-label={t('qr.close')}
        >
          <XCircle size={20} />
        </button>
      </div>

      <AnimatePresence mode="wait">
        {phase === 'idle' && (
          <motion.div
            key="idle"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 p-8 text-center"
          >
            <div className="mx-auto w-20 h-20 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 flex items-center justify-center mb-6">
              <QrCode size={40} className="text-emerald-400" />
            </div>
            <p className="text-sm text-slate-700 dark:text-zinc-300 mb-4 font-medium">{t('qr.pickAction')}</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <button
                onClick={() => handleStart('in')}
                disabled={!diag?.isOk}
                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-200 dark:bg-zinc-700 disabled:cursor-not-allowed text-slate-900 dark:text-white font-semibold transition-colors min-w-[160px]"
              >
                <LogIn size={18} />
                {t('qr.actionIn')}
              </button>
              <button
                onClick={() => handleStart('out')}
                disabled={!diag?.isOk}
                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:bg-slate-200 dark:bg-zinc-700 disabled:cursor-not-allowed text-slate-900 dark:text-white font-semibold transition-colors min-w-[160px]"
              >
                <LogOut size={18} />
                {t('qr.actionOut')}
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-zinc-500 mt-4 flex items-center justify-center gap-1">
              <MapPin size={12} /> {t('qr.gettingLocation')}
            </p>

            {/* Ortam tanılaması */}
            {diag && (
              <div className={`mt-6 text-left rounded-xl border p-3 text-xs ${
                diag.isOk ? 'border-emerald-900/40 bg-emerald-950/20' : 'border-amber-800/60 bg-amber-950/20'
              }`}>
                <div className={`flex items-center gap-1.5 font-semibold mb-2 ${diag.isOk ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {diag.isOk ? <ShieldCheck size={14}/> : <ShieldAlert size={14}/>}
                  {diag.isOk ? t('qr.envReady') : t('qr.envNotReady')}
                </div>
                <ul className="space-y-1 font-mono text-[11px] text-slate-700 dark:text-zinc-300">
                  <li>URL: <span className="text-slate-600 dark:text-zinc-400">{diag.proto}//{diag.host}</span></li>
                  <li>Secure context: <span className={diag.secure ? 'text-emerald-400' : 'text-red-400'}>{diag.secure ? '✓' : `✗ (${t('qr.diagSecureNeeded')})`}</span></li>
                  <li>{t('qr.diagCameraApi')}: <span className={diag.hasCamera ? 'text-emerald-400' : 'text-red-400'}>{diag.hasCamera ? '✓' : '✗'}</span></li>
                  <li>{t('qr.diagLocationApi')}: <span className={diag.hasGeo ? 'text-emerald-400' : 'text-red-400'}>{diag.hasGeo ? '✓' : '✗'}</span></li>
                  <li className="flex items-start gap-1.5 pt-1 border-t border-slate-200 dark:border-zinc-800/60 mt-1">
                    <Smartphone size={11} className="mt-0.5 text-slate-600 dark:text-zinc-400 shrink-0" />
                    <span>{t('qr.deviceLabel')}: <span className="text-slate-900 dark:text-zinc-100 font-semibold">{deviceLabel || t('qr.deviceUnknown')}</span></span>
                  </li>
                </ul>
                {!diag.secure && !diag.isLocalhost && (
                  <p className="mt-2 text-amber-200 text-[11px]">
                    {t('qr.needHttps')}
                  </p>
                )}
              </div>
            )}
          </motion.div>
        )}

        {phase === 'posting' && (
          <motion.div
            key="posting"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950 p-10 text-center"
          >
            <Loader2 className="animate-spin mx-auto text-emerald-400 mb-3" size={32} />
            <p className="text-slate-700 dark:text-zinc-300">{t('qr.gettingLocation')}</p>
          </motion.div>
        )}

        {phase === 'result' && result && (
          <ResultCard result={result} onClose={reset} t={t} deviceLabel={deviceLabel} />
        )}

        {phase === 'error' && (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-2xl border border-red-900/60 bg-red-950/40 p-6 text-center"
          >
            <XCircle size={40} className="text-red-400 mx-auto mb-3" />
            {errorKind && (
              <div className="inline-flex items-center gap-1 mb-3 px-2.5 py-1 rounded-full bg-red-900/60 border border-red-800 text-red-100 font-mono text-[11px] uppercase tracking-wider">
                {t('qr.errorCode')}: {errorKind}
              </div>
            )}
            <p className="text-red-200 mb-3 font-medium">{errorMessage()}</p>
            {errorDetail && (
              <div className="text-[11px] text-red-300/80 mb-4 text-left bg-black/30 p-3 rounded border border-red-900/40">
                <div className="text-[10px] uppercase text-red-400/80 mb-1 font-semibold">{t('qr.errorDetails')}</div>
                <pre className="whitespace-pre-wrap break-words font-mono leading-relaxed">{errorDetail}</pre>
              </div>
            )}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2">
              <button
                onClick={reset}
                className="px-5 py-2 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-900 dark:text-white"
              >
                {t('qr.tryAgain')}
              </button>
              <a
                href={(() => {
                  const codeLine = errorKind ? `Hata kodu: ${errorKind}` : '';
                  const detailLine = errorDetail ? `Detay: ${errorDetail}` : '';
                  const msg = [
                    'Merhaba, QR mesai açarken hata aldım.',
                    codeLine,
                    detailLine,
                    'Ekran görüntüsü ekte.'
                  ].filter(Boolean).join('\n');
                  return `https://wa.me/905324961412?text=${encodeURIComponent(msg)}`;
                })()}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold shadow-lg shadow-emerald-900/30"
              >
                <MessageCircle size={18} />
                {t('qr.reportWhatsapp')}
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const ResultCard: React.FC<{ result: RpcResponse; onClose: () => void; t: (k: string) => string; deviceLabel: string }> = ({ result, onClose, t, deviceLabel }) => {
  const isCheckin = result.action === 'in';
  const isApproved = result.status === 'Onaylandı';
  const outOfRange = result.in_range === false;

  const toneClass = isApproved
    ? 'border-emerald-800/60 bg-emerald-950/30'
    : 'border-amber-800/60 bg-amber-950/30';
  const Icon = isApproved ? CheckCircle : AlertTriangle;
  const iconColor = isApproved ? 'text-emerald-400' : 'text-amber-400';

  return (
    <motion.div
      key="result"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      className={`rounded-2xl border ${toneClass} p-8 text-center`}
    >
      <Icon className={`${iconColor} mx-auto mb-3`} size={48} />
      <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2 flex items-center justify-center gap-2">
        {isCheckin ? <LogIn size={20} /> : <LogOut size={20} />}
        {isCheckin ? t('qr.checkinSuccess') : t('qr.checkoutSuccess')}
      </h3>

      <div className="mt-4 space-y-1 text-sm text-slate-800 dark:text-zinc-200">
        <div><span className="text-slate-600 dark:text-zinc-400">{t('qr.branch')}:</span> <span className="font-semibold">{result.branch}</span></div>
        {result.start_time && (
          <div><span className="text-slate-600 dark:text-zinc-400">{t('qr.start')}:</span> <span className="font-mono">{result.start_time}</span></div>
        )}
        {result.end_time && (
          <div><span className="text-slate-600 dark:text-zinc-400">{t('qr.end')}:</span> <span className="font-mono">{result.end_time}</span></div>
        )}
        {typeof result.total_hours === 'number' && result.total_hours > 0 && (
          <div>
            <span className="text-slate-600 dark:text-zinc-400">{t('qr.totalHours')}:</span>{' '}
            <span className="font-semibold">{result.total_hours.toFixed(2)} {t('qr.hours')}</span>
          </div>
        )}
        {deviceLabel && (
          <div className="pt-2 mt-2 border-t border-slate-200 dark:border-zinc-800/60 flex items-center justify-center gap-1.5 text-xs text-slate-600 dark:text-zinc-400">
            <Smartphone size={12} />
            <span>{t('qr.deviceLabel')}:</span>
            <span className="text-slate-800 dark:text-zinc-200 font-medium">{deviceLabel}</span>
          </div>
        )}
      </div>

      {outOfRange && (
        <div className="mt-4 p-3 rounded-lg bg-amber-900/30 border border-amber-800/50 text-amber-200 text-xs">
          {t('qr.outOfRange')}
        </div>
      )}

      <button
        onClick={onClose}
        className="mt-6 px-5 py-2 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-900 dark:text-white"
      >
        {t('qr.close')}
      </button>
    </motion.div>
  );
};

export default QrCheckIn;
