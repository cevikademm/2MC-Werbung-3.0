// =============================================================
// BAC Handels — Web Push istemci yardımcıları
// =============================================================
// - Service Worker kaydı
// - Push aboneliği oluşturma / iptal
// - Abonelik bilgisini Supabase push_subscriptions tablosuna POST
// - Mevcut izin ve abonelik durumunu sorgulama
// =============================================================

import { supabase } from './supabase';

const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY || '').trim();

// ---------------- Yardımcılar ----------------

/** Web Push API'sinin desteklenip desteklenmediği. */
export const isPushSupported = (): boolean =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/** Uygulama PWA (standalone) modunda mı çalışıyor? */
export const isStandaloneMode = (): boolean => {
  if (typeof window === 'undefined') return false;
  // iOS Safari
  // @ts-ignore
  if (window.navigator.standalone === true) return true;
  // Diğerleri
  return window.matchMedia?.('(display-mode: standalone)').matches === true;
};

/** Cihaz iOS Safari mi? */
export const isIOSSafari = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isWebView = /(CriOS|FxiOS|EdgiOS|OPiOS|GSA)/i.test(ua);
  return isIOS && !isWebView;
};

/** Cihaz tipi etiketi (subscription metadata). */
export const detectPlatform = (): 'ios' | 'android' | 'desktop' => {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
};

/** VAPID public key (base64url) → Uint8Array. */
const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
};

/** ArrayBuffer → base64 (subscription key'leri için). */
const bufferToBase64 = (buffer: ArrayBuffer | null): string => {
  if (!buffer) return '';
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

// ---------------- Service Worker kaydı ----------------

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/** SW'yi tek seferde kaydeder, sonraki çağrılarda mevcut kaydı döndürür. */
export const registerServiceWorker = async (): Promise<ServiceWorkerRegistration | null> => {
  if (!('serviceWorker' in navigator)) return null;
  if (registrationPromise) return registrationPromise;

  registrationPromise = (async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      // Yeni SW geldiğinde otomatik aktive et
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (
            installing.state === 'installed' &&
            navigator.serviceWorker.controller
          ) {
            installing.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
      return reg;
    } catch (err) {
      console.error('[Push] Service Worker kaydı başarısız:', err);
      return null;
    }
  })();

  return registrationPromise;
};

// ---------------- Bildirim izni ----------------

/** Mevcut bildirim izin durumu. */
export const getNotificationPermission = (): NotificationPermission | 'unsupported' => {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
};

/** Kullanıcıdan bildirim izni iste (jest gerektirir → buton onClick içinden çağrılmalı). */
export const requestNotificationPermission = async (): Promise<NotificationPermission> => {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch (err) {
    console.error('[Push] requestPermission error:', err);
    return 'denied';
  }
};

// ---------------- Subscription işlemleri ----------------

export interface PushSubscriptionPayload {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  platform: 'ios' | 'android' | 'desktop';
}

const subscriptionToPayload = (
  sub: PushSubscription
): PushSubscriptionPayload => {
  const json = sub.toJSON() as PushSubscriptionJSON & { keys?: { p256dh?: string; auth?: string } };
  // Bazı tarayıcılar getKey ile, bazıları toJSON.keys ile veriyor
  const p256dh =
    json.keys?.p256dh || bufferToBase64(sub.getKey('p256dh'));
  const auth = json.keys?.auth || bufferToBase64(sub.getKey('auth'));
  return {
    endpoint: sub.endpoint,
    p256dh,
    auth,
    user_agent: navigator.userAgent,
    platform: detectPlatform(),
  };
};

/** Mevcut PushSubscription objesini döndürür (varsa). */
export const getExistingSubscription = async (): Promise<PushSubscription | null> => {
  const reg = await registerServiceWorker();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
};

/**
 * Push aboneliği oluşturur ve Supabase'e kaydeder.
 * Çağırmadan önce kullanıcıdan izin alındığından emin olun.
 */
export const subscribeToPush = async (
  userId: string
): Promise<PushSubscription | null> => {
  if (!isPushSupported()) {
    throw new Error('Bu tarayıcı Web Push API desteklemiyor.');
  }
  if (!VAPID_PUBLIC_KEY) {
    throw new Error('VITE_VAPID_PUBLIC_KEY tanımlı değil (.env).');
  }

  const reg = await registerServiceWorker();
  if (!reg) throw new Error('Service Worker kaydedilemedi.');

  // Aynı endpoint zaten varsa onu döndür
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const payload = subscriptionToPayload(sub);

  // Supabase'e upsert (endpoint UNIQUE)
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: payload.endpoint,
      p256dh: payload.p256dh,
      auth: payload.auth,
      user_agent: payload.user_agent,
      platform: payload.platform,
      last_used_at: new Date().toISOString(),
    },
    { onConflict: 'endpoint' }
  );

  if (error) {
    console.error('[Push] Subscription kaydedilemedi:', error);
    throw new Error(error.message);
  }

  return sub;
};

/** Mevcut aboneliği iptal eder ve Supabase'den siler. */
export const unsubscribeFromPush = async (): Promise<boolean> => {
  const reg = await registerServiceWorker();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return true;

  try {
    await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  } catch (err) {
    console.warn('[Push] Subscription DB silme hatası (devam):', err);
  }

  return sub.unsubscribe();
};

/** Service Worker'a postMessage göndererek lokal bildirim göster. */
export const showLocalNotification = async (
  title: string,
  options: NotificationOptions = {}
): Promise<void> => {
  const reg = await registerServiceWorker();
  if (!reg) return;
  if (reg.active) {
    reg.active.postMessage({ type: 'SHOW_NOTIFICATION', title, options });
  } else {
    // SW henüz aktif değilse direkt göster
    await reg.showNotification(title, options);
  }
};
