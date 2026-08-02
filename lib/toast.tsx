import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, XCircle, AlertTriangle, Info, X, HelpCircle, Trash2 } from 'lucide-react';

/**
 * Tarayıcının çirkin native alert() / confirm() kutularının yerine geçen
 * kart tasarımlı bildirim sistemi.
 *
 *  - toast('Kaydedildi')            → sağ üstte otomatik kaybolan kart
 *  - window.alert(...)              → ToastHost mount olunca otomatik toast'a yönlenir
 *                                     (mevcut ~75 alert çağrısı değişmeden şık görünür)
 *  - await confirmDialog({...})     → Promise<boolean> döndüren onay modalı
 *
 * Tema (light/dark) Tailwind dark: sınıflarıyla otomatik uyumlanır.
 */

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  type?: ToastType;
  title?: string;
  duration?: number;
}

interface ToastItem {
  id: number;
  type: ToastType;
  title: string;
  message: string;
  duration: number;
}

// --- Dil (i18n hook'una bağımlı kalmadan) ---------------------------------
const lang = (): 'tr' | 'de' =>
  (typeof localStorage !== 'undefined' && localStorage.getItem('app_language') === 'de') ? 'de' : 'tr';

const TEXT = {
  tr: {
    success: 'Başarılı', error: 'Hata', warning: 'Uyarı', info: 'Bilgi',
    confirmTitle: 'Emin misiniz?', confirm: 'Evet, devam et', cancel: 'Vazgeç', close: 'Kapat',
  },
  de: {
    success: 'Erfolgreich', error: 'Fehler', warning: 'Hinweis', info: 'Information',
    confirmTitle: 'Sind Sie sicher?', confirm: 'Ja, fortfahren', cancel: 'Abbrechen', close: 'Schließen',
  },
} as const;

// --- Mesaj metninden tür tahmini ------------------------------------------
// Native alert() çağrılarında tür bilgisi yok; metinden çıkarıyoruz.
// Sıra önemli: "başarısız" kelimesi "başarı" içerdiği için önce hata bakılır.
const ERROR_WORDS = ['başarısız', 'fehlgeschlagen', 'hata', 'fehler', 'error', 'geçersiz', 'ungültig',
  'bulunamadı', 'nicht gefunden', 'yüklenemedi', 'silinemedi', 'olmadı', 'yanlış', 'falsch'];
const SUCCESS_WORDS = ['başarılı', 'başarıyla', 'erfolg', 'kaydedildi', 'gespeichert', 'güncellendi',
  'aktualisiert', 'eklendi', 'hinzugefügt', 'tamamlandı', 'gönderildi', 'gesendet', 'silindi', 'gelöscht'];
const WARNING_WORDS = ['zorunlu', 'erforderlich', 'gerekli', 'uyarı', 'warnung', 'lütfen', 'bitte',
  'seçin', 'wählen', 'emin misiniz', 'dikkat', 'achtung', 'dolduru', 'ausfüllen'];

const detectType = (msg: string): ToastType => {
  const m = msg.toLocaleLowerCase('tr');
  if (ERROR_WORDS.some(w => m.includes(w))) return 'error';
  if (SUCCESS_WORDS.some(w => m.includes(w))) return 'success';
  if (WARNING_WORDS.some(w => m.includes(w))) return 'warning';
  return 'info';
};

// --- Basit store (React dışından da çağrılabilsin diye) --------------------
let counter = 0;
let items: ToastItem[] = [];
const listeners = new Set<(v: ToastItem[]) => void>();
const emit = () => listeners.forEach(l => l([...items]));

const dismissToast = (id: number) => {
  items = items.filter(i => i.id !== id);
  emit();
};

/** Kart tipi bildirim gösterir. Tür verilmezse metinden tahmin edilir. */
export const toast = (message: string, opts: ToastOptions = {}) => {
  const msg = String(message ?? '');
  const type = opts.type ?? detectType(msg);
  const item: ToastItem = {
    id: ++counter,
    type,
    title: opts.title ?? TEXT[lang()][type],
    message: msg,
    duration: opts.duration ?? (type === 'error' ? 6000 : 4000),
  };
  // Aynı mesaj üst üste gelirse tekrarlamasın (ör. döngüdeki hata)
  items = items.filter(i => i.message !== item.message).slice(-3).concat(item);
  emit();
  return item.id;
};

// window.alert devralınıyor — modül yüklenir yüklenmez, ki ilk render
// sırasında tetiklenen uyarılar da native kutuya düşmesin. Toast'lar host
// mount olana kadar kuyrukta bekler.
if (typeof window !== 'undefined' && !(window as any).__toastAlertPatched) {
  (window as any).__toastAlertPatched = true;
  window.alert = (msg?: any) => { toast(String(msg ?? '')); };
}

toast.success = (m: string, o?: ToastOptions) => toast(m, { ...o, type: 'success' });
toast.error = (m: string, o?: ToastOptions) => toast(m, { ...o, type: 'error' });
toast.warning = (m: string, o?: ToastOptions) => toast(m, { ...o, type: 'warning' });
toast.info = (m: string, o?: ToastOptions) => toast(m, { ...o, type: 'info' });

// --- Onay modalı -----------------------------------------------------------
export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  /** true → kırmızı "sil" görünümü */
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

let confirmListener: ((s: ConfirmState | null) => void) | null = null;

/** Native confirm() yerine kart tasarımlı onay kutusu. `await` ile kullanılır. */
export const confirmDialog = (opts: ConfirmOptions | string): Promise<boolean> => {
  const o = typeof opts === 'string' ? { message: opts } : opts;
  return new Promise<boolean>(resolve => {
    if (!confirmListener) {
      // Host mount edilmemişse davranışı bozmamak için native'e düş
      resolve(window.confirm(o.message));
      return;
    }
    confirmListener({ ...o, resolve });
  });
};

// --- Stil (bir kez enjekte edilir) ----------------------------------------
const STYLE_ID = 'app-toast-styles';
const injectStyles = () => {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
@keyframes toast-in {
  from { opacity: 0; transform: translateY(-14px) scale(.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes toast-progress { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@keyframes dialog-in {
  from { opacity: 0; transform: translateY(10px) scale(.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes overlay-in { from { opacity: 0; } to { opacity: 1; } }
.toast-card { animation: toast-in .28s cubic-bezier(.16,1,.3,1) both; }
.toast-bar  { animation: toast-progress linear forwards; transform-origin: left; }
.toast-card:hover .toast-bar { animation-play-state: paused; }
.dialog-card { animation: dialog-in .22s cubic-bezier(.16,1,.3,1) both; }
.dialog-overlay { animation: overlay-in .18s ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .toast-card, .dialog-card, .dialog-overlay { animation: none; }
  .toast-bar { animation-duration: 0s; }
}`;
  document.head.appendChild(el);
};

// --- Görsel tema tablosu ---------------------------------------------------
const SKIN: Record<ToastType, { accent: string; chip: string; icon: React.ReactNode; ring: string }> = {
  success: {
    accent: 'bg-emerald-500',
    chip: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    ring: 'ring-emerald-500/20',
    icon: <CheckCircle2 size={18} />,
  },
  error: {
    accent: 'bg-rose-500',
    chip: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
    ring: 'ring-rose-500/20',
    icon: <XCircle size={18} />,
  },
  warning: {
    accent: 'bg-amber-500',
    chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    ring: 'ring-amber-500/20',
    icon: <AlertTriangle size={18} />,
  },
  info: {
    accent: 'bg-indigo-500',
    chip: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
    ring: 'ring-indigo-500/20',
    icon: <Info size={18} />,
  },
};

const ToastCard: React.FC<{ item: ToastItem }> = ({ item }) => {
  const skin = SKIN[item.type];
  const timer = useRef<number | null>(null);
  const startedAt = useRef<number>(Date.now());
  const left = useRef<number>(item.duration);

  const start = (ms: number) => {
    if (timer.current) window.clearTimeout(timer.current);
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => dismissToast(item.id), ms);
  };

  useEffect(() => {
    start(item.duration);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fare üstündeyken sayaç durur (ilerleme çubuğu CSS ile duraklar)
  const pause = () => {
    if (timer.current) window.clearTimeout(timer.current);
    left.current = Math.max(400, item.duration - (Date.now() - startedAt.current));
  };
  const resume = () => start(left.current);

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={pause}
      onMouseLeave={resume}
      className={`toast-card pointer-events-auto relative overflow-hidden rounded-2xl border border-slate-200/80 dark:border-zinc-800
                  bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl shadow-xl shadow-slate-900/10 dark:shadow-black/40 ring-1 ${skin.ring}`}
    >
      <span className={`absolute inset-y-0 left-0 w-1 ${skin.accent}`} />
      <div className="flex items-start gap-3 p-4 pl-5">
        <div className={`w-9 h-9 rounded-xl grid place-items-center shrink-0 ${skin.chip}`}>{skin.icon}</div>
        <div className="flex-1 min-w-0 pt-0.5">
          <p className="text-sm font-bold text-slate-900 dark:text-white leading-tight">{item.title}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-600 dark:text-zinc-400 whitespace-pre-line break-words">
            {item.message}
          </p>
        </div>
        <button
          onClick={() => dismissToast(item.id)}
          aria-label={TEXT[lang()].close}
          className="shrink-0 p-1 rounded-lg text-slate-400 dark:text-zinc-600 hover:text-slate-700 dark:hover:text-zinc-200 hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <X size={15} />
        </button>
      </div>
      <div className={`h-[3px] ${skin.accent} toast-bar opacity-70`} style={{ animationDuration: `${item.duration}ms` }} />
    </div>
  );
};

const ConfirmCard: React.FC<{ state: ConfirmState; onDone: (v: boolean) => void }> = ({ state, onDone }) => {
  const T = TEXT[lang()];
  const danger = !!state.danger;

  // Esc → vazgeç, Enter → onayla
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone(false);
      if (e.key === 'Enter') onDone(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  return (
    <div
      className="dialog-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => onDone(false)}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="dialog-card w-full max-w-sm rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden"
      >
        <div className="p-6 text-center">
          <div
            className={`w-14 h-14 mx-auto rounded-2xl grid place-items-center mb-4 ${
              danger ? 'bg-rose-500/15 text-rose-500' : 'bg-indigo-500/15 text-indigo-500'
            }`}
          >
            {danger ? <Trash2 size={26} /> : <HelpCircle size={26} />}
          </div>
          <h3 className="text-base font-bold text-slate-900 dark:text-white">{state.title || T.confirmTitle}</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-slate-600 dark:text-zinc-400 whitespace-pre-line">
            {state.message}
          </p>
        </div>
        <div className="flex gap-3 p-4 pt-0">
          <button
            onClick={() => onDone(false)}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
          >
            {state.cancelText || T.cancel}
          </button>
          <button
            autoFocus
            onClick={() => onDone(true)}
            className={`flex-1 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors shadow-lg ${
              danger
                ? 'bg-rose-600 hover:bg-rose-500 shadow-rose-900/30'
                : 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-900/30'
            }`}
          >
            {state.confirmText || T.confirm}
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Uygulamada bir kez mount edilir (App.tsx). Mount olduğunda window.alert'i
 * devralır; böylece mevcut tüm alert() çağrıları kart tasarımıyla görünür.
 */
export const ToastHost: React.FC = () => {
  const [list, setList] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  useEffect(() => {
    injectStyles();
    listeners.add(setList);
    confirmListener = setConfirmState;
    // Host mount olmadan önce birikmiş bildirimler varsa hemen göster
    if (items.length) setList([...items]);

    return () => {
      listeners.delete(setList);
      confirmListener = null;
    };
  }, []);

  if (typeof document === 'undefined') return null;

  const closeConfirm = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };

  return createPortal(
    <>
      <div className="fixed z-[9999] top-4 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-sm
                      md:left-auto md:translate-x-0 md:right-6 md:top-6
                      flex flex-col gap-3 pointer-events-none">
        {list.map(item => <ToastCard key={item.id} item={item} />)}
      </div>
      {confirmState && <ConfirmCard state={confirmState} onDone={closeConfirm} />}
    </>,
    document.body,
  );
};
