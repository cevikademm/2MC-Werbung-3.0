// =============================================================
// lazyWithRetry — React.lazy + chunk-hash recovery
// =============================================================
// Yeni deployment sonrası eski sekmedeki kullanıcı eski hash'li
// chunk'u (`/assets/QrCheckIn-XYZ.js`) istediğinde, dosya artık
// yoktur ve Vercel SPA fallback eskiden index.html (text/html)
// dönerdi → ES module bunu reddeder ve "'text/html' is not a valid
// JavaScript MIME type" fırlatırdı. vercel.json artık 404 dönüyor;
// burada da defansif olarak: chunk yükleme hatası yakalanırsa SW
// cache'i ve registration'ı temizleyip tek seferlik sert reload
// yapıyoruz. sessionStorage flag ile reload-loop'a karşı koruyoruz.
// =============================================================

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

const RELOAD_KEY = 'bac:chunk-reloaded';

/** Hata mesajından dinamik import hatası mı tespit eder. */
export const isChunkLoadError = (err: unknown): boolean => {
  if (!err) return false;
  const e = err as { message?: unknown; name?: unknown };
  const raw = `${String(e?.name ?? '')} ${String(e?.message ?? err)}`.toLowerCase();
  return (
    raw.includes('failed to fetch dynamically imported module') ||
    raw.includes('failed to import') ||
    raw.includes('error loading dynamically imported module') ||
    raw.includes('loading chunk') ||
    raw.includes('loading css chunk') ||
    raw.includes('importing a module script failed') ||
    raw.includes('is not a valid javascript mime type') ||
    raw.includes("expected a javascript module") ||
    raw.includes('text/html')
  );
};

/** Tüm SW kayıtlarını ve cache'leri sessizce temizler. */
const purgeCachesAndSw = async (): Promise<void> => {
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* ignore */ }
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch { /* ignore */ }
};

/** Loop önleyici: bu oturumda zaten reload edildi mi? */
const alreadyReloaded = (): boolean => {
  try { return sessionStorage.getItem(RELOAD_KEY) === '1'; } catch { return false; }
};
const markReloaded = (): void => {
  try { sessionStorage.setItem(RELOAD_KEY, '1'); } catch { /* ignore */ }
};
/** Başarılı yüklemede flag'i temizle (bir sonraki deployment için yeniden çalışabilsin). */
export const clearChunkReloadFlag = (): void => {
  try { sessionStorage.removeItem(RELOAD_KEY); } catch { /* ignore */ }
};

/**
 * React.lazy benzeri; dinamik import sırasında chunk MIME / load
 * hatası yakalanırsa SW + cache temizleyip tek seferlik sert reload
 * tetikler. İkinci başarısızlıkta hata yukarı atılır (ErrorBoundary
 * yine de yakalar, sonsuz reload loop'u oluşmaz).
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const mod = await factory();
      clearChunkReloadFlag();
      return mod;
    } catch (err) {
      if (isChunkLoadError(err) && !alreadyReloaded() && typeof window !== 'undefined') {
        markReloaded();
        await purgeCachesAndSw();
        const url = new URL(window.location.href);
        url.searchParams.set('_v', Date.now().toString(36));
        window.location.replace(url.toString());
        // Promise asılı kalsın — sayfa zaten reload olacak
        return new Promise<{ default: T }>(() => { /* never resolves */ });
      }
      throw err;
    }
  });
}
