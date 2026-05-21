// =============================================================
// LiveLocationTracker — Görünmez canlı konum izleyici
// =============================================================
// Personel QR ile giriş yaptıktan sonra (localStorage flag aktif)
// arka planda konum takibi başlatır ve supabase.rpc('live_location_upsert')
// çağırır. Server live_locations'ı günceller, location_history tablosuna
// throttle'lı INSERT atar.
//
// İKİ MOD:
//  (A) NATIVE (Capacitor — Android/iOS app)
//      @capacitor-community/background-geolocation plugin'i kullanılır.
//      Cihaz kilitliyken/uygulama arka plandayken bile native OS-level
//      izleme yapar. Distance filter: 30m. Foreground servis bildirimi
//      Android'de zorunlu (kullanıcı GPS'in açık olduğunu bilir).
//
//  (B) WEB (tarayıcı)
//      navigator.geolocation.watchPosition + Wake Lock + visibilitychange
//      re-bootstrap. Sayfa kapalıysa OS izlemeyi durdurur; kısmî çözüm.
//
// Her iki modda aynı sendPing yardımcısına düşer → backend tek.
// =============================================================

import React, { useEffect, useRef } from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import { supabase } from '../lib/supabase';

// Plugin'i runtime'da kayıt et — web build'inde paket yok, sadece type
// definition. Native platformda Capacitor bridge gerçek implementasyonu
// sağlar; web'de no-op döner ve isNative guard'ı zaten by-pass eder.
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');
import { Employee } from '../types';
import {
  isShiftActive,
  SHIFT_CHANGED_EVENT,
  SHIFT_EMPLOYEE_KEY,
  haversineMeters,
  type LatLng,
  type BranchPoint,
} from '../lib/geofence';

interface Props {
  currentUser: Employee | null;
}

const TICK_THROTTLE_MS = 15_000;
// Standart Web Wake Lock API tipi (TS lib henüz tam değil)
type WakeLockSentinelLite = { release: () => Promise<void> };

const LiveLocationTracker: React.FC<Props> = ({ currentUser }) => {
  const watchIdRef = useRef<number | null>(null);
  const nativeWatcherIdRef = useRef<string | null>(null);
  const lastSentAtRef = useRef<number>(0);
  const lastRawInsideRef = useRef<boolean | null>(null);
  const branchesRef = useRef<BranchPoint[]>([]);
  const wakeLockRef = useRef<WakeLockSentinelLite | null>(null);
  const employeeIdRef = useRef<string | null>(null);
  const isNative = Capacitor.isNativePlatform();

  useEffect(() => {
    // Wake Lock — vardiya boyunca ekran kilidini engelle (mobilde uygulama
    // foreground'da kalırsa GPS sürekli çalışır). User-gesture sonrası
    // request edilmesi tarayıcı tarafından zorlanmaz; sayfa yüklendiğinde
    // try ediyoruz, fail olursa sessiz devam.
    const acquireWakeLock = async () => {
      try {
        const wl = (navigator as any).wakeLock;
        if (wl && typeof wl.request === 'function' && wakeLockRef.current === null) {
          const sentinel = await wl.request('screen');
          wakeLockRef.current = sentinel as WakeLockSentinelLite;
        }
      } catch {
        // Sessizce yut — bazı tarayıcılarda izin/HTTPS/visible şartı var
      }
    };
    const releaseWakeLock = async () => {
      try {
        await wakeLockRef.current?.release();
      } catch {
        // ignore
      }
      wakeLockRef.current = null;
    };

    // Anlık single-shot getCurrentPosition — visibilitychange'te re-bootstrap için (sadece web)
    const pingOnce = async () => {
      if (!employeeIdRef.current) return;
      if (isNative) return; // native modda BackgroundGeolocation watcher tek başına yeterli
      if (typeof navigator === 'undefined' || !navigator.geolocation) return;
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            maximumAge: 5_000,
            timeout: 15_000,
          });
        });
        await sendPing(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      } catch {
        // izin yok / timeout — sessizce geç
      }
    };

    // Tek "send" yardımcısı — pure: lat/lng/accuracy raw alır, hem native
    // hem web yolundan çağrılır. Throttle, geofence stable hesabı, RPC.
    const sendPing = async (lat: number, lng: number, accuracy: number | null | undefined) => {
      const employeeId = employeeIdRef.current;
      if (!employeeId) return;
      const now = Date.now();
      if (now - lastSentAtRef.current < TICK_THROTTLE_MS) return;
      lastSentAtRef.current = now;

      let rawInside = false;
      const branches = branchesRef.current;
      if (branches.length > 0) {
        const point: LatLng = { lat, lng };
        let nearest = { d: Number.POSITIVE_INFINITY, geom: 20 };
        for (const b of branches) {
          const d = haversineMeters(point, b);
          if (d < nearest.d) nearest = { d, geom: b.geofence_m };
        }
        rawInside = nearest.d <= nearest.geom;
      }
      // İlk ölçümde stable=true kabul et — aksi halde server v_prev=FALSE
      // ile eski durumu korur ve ilk ping'te personel "şube dışında" gözükür.
      const isFirstPing = lastRawInsideRef.current === null;
      const stable = isFirstPing || lastRawInsideRef.current === rawInside;
      lastRawInsideRef.current = rawInside;

      try {
        const { error } = await supabase.rpc('live_location_upsert', {
          p_employee_id: employeeId,
          p_lat: lat,
          p_lng: lng,
          p_accuracy: typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : null,
          p_battery: null,
          p_stable_state: stable,
        });
        if (error) console.warn('[tracker] upsert error:', error.message);
      } catch (err) {
        console.warn('[tracker] rpc threw:', err);
      }
    };

    const stop = async () => {
      // Web watcher'ı durdur
      if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      // Native watcher'ı durdur
      if (nativeWatcherIdRef.current !== null) {
        try {
          await BackgroundGeolocation.removeWatcher({ id: nativeWatcherIdRef.current });
        } catch (err) {
          console.warn('[tracker] removeWatcher error:', err);
        }
        nativeWatcherIdRef.current = null;
      }
      void releaseWakeLock();
      lastSentAtRef.current = 0;
      lastRawInsideRef.current = null;
      employeeIdRef.current = null;
    };

    const start = async () => {
      // Aktif watcher zaten varsa çık
      if (watchIdRef.current !== null || nativeWatcherIdRef.current !== null) return;

      // Kendi cihazımızın hangi personel için kayıt yaptığını belirle.
      // QrCheckIn flag bırakırken employee_id'yi de yazıyor; yoksa
      // currentUser.id fallback.
      const employeeId =
        (typeof localStorage !== 'undefined' && localStorage.getItem(SHIFT_EMPLOYEE_KEY)) ||
        currentUser?.id ||
        null;
      if (!employeeId) return;
      employeeIdRef.current = employeeId;

      // Şubeleri bir kez çek (geofence_m ve koordinatlar için)
      if (branchesRef.current.length === 0) {
        const { data, error } = await supabase
          .from('branch_locations')
          .select('branch, latitude, longitude, geofence_m, radius_m, is_active')
          .eq('is_active', true);
        if (!error && Array.isArray(data)) {
          branchesRef.current = data.map((b: any) => ({
            branch: b.branch as string,
            lat: Number(b.latitude),
            lng: Number(b.longitude),
            geofence_m: Number(b.geofence_m ?? 20),
            radius_m: Number(b.radius_m ?? 150),
          }));
        }
      }

      // ============================================================
      // NATIVE (Capacitor) — Background Geolocation plugin
      // ============================================================
      if (isNative) {
        try {
          const watcherId = await BackgroundGeolocation.addWatcher(
            {
              backgroundMessage: 'Vardiyanız aktif — konum takibi açık',
              backgroundTitle: '2MC Werbung',
              requestPermissions: true,
              stale: false,
              distanceFilter: 30, // en az 30m hareket → yeni fix
            },
            (location, error) => {
              if (error) {
                if (error.code === 'NOT_AUTHORIZED') {
                  console.warn('[tracker] native: konum izni reddedildi');
                  return;
                }
                console.warn('[tracker] native error:', error);
                return;
              }
              if (!location) return;
              void sendPing(location.latitude, location.longitude, location.accuracy);
            },
          );
          nativeWatcherIdRef.current = watcherId;
        } catch (err) {
          console.warn('[tracker] BackgroundGeolocation.addWatcher error:', err);
        }
        return;
      }

      // ============================================================
      // WEB (tarayıcı) — watchPosition + Wake Lock + visibility
      // ============================================================
      if (typeof navigator === 'undefined' || !navigator.geolocation) return;

      // Wake Lock dene (sessizce başarısız olabilir)
      void acquireWakeLock();

      const onError = (err: GeolocationPositionError) => {
        console.warn('[tracker] geolocation error:', err.message);
      };

      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) => { void sendPing(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy); },
        onError,
        {
          enableHighAccuracy: true,
          maximumAge: 10_000,
          timeout: 30_000,
        },
      );

      // İlk açılışta hemen bir nokta yolla (watchPosition first-fix bekleme)
      void pingOnce();
    };

    const evaluate = () => {
      if (isShiftActive() && currentUser) {
        void start();
      } else {
        void stop();
      }
    };

    evaluate();

    // QrCheckIn aynı sekme içinden flag set/clear yaparken
    // CustomEvent dispatch eder; storage event sadece diğer
    // sekmeler için tetiklendiğinden ikisini de dinleriz.
    const onCustom = () => evaluate();
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.startsWith('bac_shift_')) evaluate();
    };

    // Sayfa görünür olduğunda hemen bir ping yolla — sadece WEB modu için
    // anlamlı (native plugin arka planda zaten çalışır).
    const onVisibility = () => {
      if (isNative) return;
      if (document.visibilityState !== 'visible') return;
      if (!isShiftActive()) return;
      void acquireWakeLock();
      lastSentAtRef.current = 0; // throttle'ı by-pass et
      void pingOnce();
    };
    const onPageShow = () => onVisibility();

    window.addEventListener(SHIFT_CHANGED_EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    if (!isNative) {
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pageshow', onPageShow);
    }

    return () => {
      window.removeEventListener(SHIFT_CHANGED_EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
      if (!isNative) {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pageshow', onPageShow);
      }
      void stop();
    };
  }, [currentUser]);

  return null;
};

export default LiveLocationTracker;
