// =============================================================
// Map — Canlı Konum Haritası
// =============================================================
// Sadece canSeeMap whitelist'indeki kullanıcılar görür.
// Şube koordinatları (branch_locations) + 20m geofence çemberi
// + canlı personel marker'ları (live_locations realtime sub).
// =============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, Popup, Polyline, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapPin, Users, Activity, Clock, ArrowRightLeft, X, Smartphone, LogIn, LogOut, QrCode, Hand, Hourglass, Route } from 'lucide-react';
import { Employee } from '../types';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../lib/i18n';
import { canSeeMap, formatBerlin } from '../lib/geofence';

interface MapProps {
  currentUser: Employee;
}

interface BranchRow {
  branch: string;
  latitude: number;
  longitude: number;
  geofence_m: number;
  radius_m: number;
}

interface LiveLocationRow {
  employee_id: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  branch: string | null;
  distance_m: number | null;
  inside_geofence: boolean;
  battery_pct: number | null;
  captured_at: string;
  updated_at: string;
}

interface ProfileRow {
  id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  branch: string | null;
}

interface GeofenceEventRow {
  id: string;
  employee_id: string;
  branch: string;
  event_type: 'enter' | 'exit';
  at: string;
}

interface LocationHistoryRow {
  id: number;
  employee_id: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  branch: string | null;
  distance_m: number | null;
  inside_geofence: boolean;
  captured_at: string;
}

type PathRange = 'today' | '24h' | '7d';

interface TimeLogRow {
  id: string | number;
  employee_id: string;
  branch: string;
  date: string;
  check_in_at: string | null;
  check_out_at: string | null;
  entry_method: string | null;
  device_info: string | null;
}

const branchColors: Record<string, string> = {
  Dom: '#06b6d4',       // cyan-500
  Backaffee: '#d946ef', // fuchsia-500
  Ringe: '#f59e0b',     // amber-500
  Mülheim: '#10b981',   // emerald-500
  Tobacgo: '#f43f5e',   // rose-500
};
const colorFor = (b?: string | null) => (b && branchColors[b]) || '#a1a1aa';

// Tile sağlayıcıları — birincil + fallback. tileerror eşiği aşılınca
// otomatik bir sonrakine geçilir. CARTO Voyager: key'siz, hızlı CDN, dark UI ile uyumlu.
const TILE_PROVIDERS = [
  {
    name: 'carto-voyager',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
  },
  {
    name: 'osm',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  },
] as const;

const TILE_ERROR_THRESHOLD = 5;

// 5 şube koordinatı. DB'den çekemediğimizde (offline / seed atlanmış / RLS)
// bunları fallback olarak kullanırız.
// NOT: Dom = "BAC Kiosk" gerçek lokasyonu — kullanıcı tarafından doğrulandı.
const FALLBACK_BRANCHES: BranchRow[] = [
  { branch: 'Dom',       latitude: 50.942212123059406, longitude: 6.955781214751541, geofence_m: 20, radius_m: 150 },
  { branch: 'Backaffee', latitude: 50.9403056233978,   longitude: 6.939539275732692,  geofence_m: 20, radius_m: 150 },
  { branch: 'Ringe',     latitude: 50.93968838730243,  longitude: 6.9400543539197255, geofence_m: 20, radius_m: 150 },
  { branch: 'Mülheim',   latitude: 50.96208006232153,  longitude: 7.0054699260591295, geofence_m: 20, radius_m: 150 },
  { branch: 'Tobacgo',   latitude: 50.960852824404654, longitude: 7.006675154685023,  geofence_m: 20, radius_m: 150 },
];

// DB sonucu + fallback merge: DB'de olan branch öncelikli, eksik olanlar fallback'tan tamamlanır.
// NOT: Bu modüldeki default export adı "Map" olduğu için built-in `new Map()` shadow'lanıyor.
// Bu yüzden plain object kullanıyoruz.
const mergeBranches = (rows: BranchRow[]): BranchRow[] => {
  const byName: Record<string, BranchRow> = {};
  FALLBACK_BRANCHES.forEach((b) => {
    byName[b.branch] = b;
  });
  rows.forEach((r) => {
    byName[r.branch] = r;
  });
  return Object.values(byName);
};

// Verilen noktaları haritaya sığdır. Tek nokta varsa flyTo ile yakınlaştır.
const FitBounds: React.FC<{ points: [number, number][] }> = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.flyTo(points[0], 17, { duration: 0.6 });
      return;
    }
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }, [points, map]);
  return null;
};

const FRESH_THRESHOLD_MS = 60_000; // 60 sn içinde güncellenmiş = aktif

const initials = (name: string) =>
  name
    .split(' ')
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

const buildPersonIcon = (profile: ProfileRow | undefined, isOnline: boolean) => {
  const color = isOnline ? '#22c55e' : '#71717a';
  const ring = isOnline ? 'box-shadow: 0 0 0 2px rgba(34,197,94,0.35), 0 0 8px rgba(34,197,94,0.5);' : '';
  const avatar = profile?.avatar_url
    ? `<img src="${profile.avatar_url}" referrerpolicy="no-referrer" style="width:18px;height:18px;border-radius:9999px;object-fit:cover;" />`
    : `<div style="width:18px;height:18px;border-radius:9999px;background:#3f3f46;display:flex;align-items:center;justify-content:center;color:#fff;font-size:8px;font-weight:700;line-height:1;">${initials(profile?.full_name || '??')}</div>`;
  const html = `
    <div style="position:relative;display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:9999px;border:1.5px solid ${color};background:#18181b;${ring}">
      ${avatar}
    </div>
  `;
  return L.divIcon({
    className: 'bac-person-marker',
    html,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
};

// Pin tam koordinatta dursun — sadece etiket yönü dağıtılır.
// Dom-Backaffee-Ringe (~30-80m), Mülheim-Tobacgo (~140m) üst üste binince
// pinler aynı pikselde olur; etiketler farklı yönlere açılarak hepsi okunur.
const BRANCH_LABEL_SIDE: Record<string, 'left' | 'right' | 'top' | 'bottom'> = {
  Dom:       'left',
  Backaffee: 'right',
  Ringe:     'bottom',
  Mülheim:   'left',
  Tobacgo:   'right',
};

// Üst üste binen pinlerden üstteki etiketi görmek için z-index farkı.
const BRANCH_Z: Record<string, number> = {
  Dom: 30, Backaffee: 20, Ringe: 10, Mülheim: 30, Tobacgo: 20,
};

const buildBranchIcon = (branch: string) => {
  const color = colorFor(branch);
  const side = BRANCH_LABEL_SIDE[branch] ?? 'right';
  const labelStyle =
    side === 'left'
      ? 'right:34px;top:50%;transform:translateY(-50%);'
      : side === 'right'
      ? 'left:34px;top:50%;transform:translateY(-50%);'
      : side === 'top'
      ? 'left:50%;bottom:34px;transform:translateX(-50%);'
      : 'left:50%;top:34px;transform:translateX(-50%);';
  const html = `
    <div style="position:relative;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:${color};border:2px solid rgba(255,255,255,0.4);box-shadow:0 4px 12px rgba(0,0,0,0.5);">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/>
      </svg>
      <span style="position:absolute;${labelStyle}padding:2px 6px;border-radius:6px;background:rgba(9,9,11,0.9);color:#fff;font-size:10px;font-weight:700;white-space:nowrap;border:1px solid ${color};box-shadow:0 2px 6px rgba(0,0,0,0.4);pointer-events:none;">${branch}</span>
    </div>
  `;
  return L.divIcon({
    className: 'bac-branch-marker',
    html,
    iconSize: [30, 30],
    iconAnchor: [15, 15], // Pin TAM koordinatta — offset YOK.
  });
};

// Europe/Berlin saat dilimine göre HH:MM formatı.
const formatHHMM = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return '—';
  }
};

// Europe/Berlin'e göre bugünün YYYY-MM-DD'si — time_logs.date ile karşılaştırma için.
const todayBerlin = (): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts; // en-CA → "2026-05-05"
};

// İki ISO arası süreyi "Xh Ym" gibi gösterir.
const formatDuration = (fromIso: string, toIso: string): string => {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}s ${m}d` : `${m}d`;
};

const Map: React.FC<MapProps> = ({ currentUser }) => {
  const { t } = useLanguage();
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [liveLocations, setLiveLocations] = useState<Record<string, LiveLocationRow>>({});
  const [profiles, setProfiles] = useState<Record<string, ProfileRow>>({});
  const [recentEvents, setRecentEvents] = useState<GeofenceEventRow[]>([]);
  const [todayLogs, setTodayLogs] = useState<TimeLogRow[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null); // null = Tümü
  const [selectedLog, setSelectedLog] = useState<TimeLogRow | null>(null);
  const [logTimeline, setLogTimeline] = useState<GeofenceEventRow[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const tickRef = useRef<number | null>(null);

  // Hareket geçmişi (path) — bir personel seçilince yüklenir.
  const [pathEmployeeId, setPathEmployeeId] = useState<string | null>(null);
  const [pathRange, setPathRange] = useState<PathRange>('today');
  const [pathPoints, setPathPoints] = useState<LocationHistoryRow[]>([]);
  const [pathLoading, setPathLoading] = useState(false);

  // Tile yükleme dayanıklılığı — birincil sağlayıcı başarısız olursa
  // otomatik fallback'e geç, kullanıcıya skeleton/error UI göster.
  const [tileProviderIdx, setTileProviderIdx] = useState(0);
  const [tileMapState, setTileMapState] = useState<'loading' | 'ready' | 'error'>('loading');
  const tileErrorCountRef = useRef(0);

  // Guard — sadece admin'ler veya whitelist email'i.
  // App.tsx zaten guard'lıyor; defansif olarak burada da kontrol et.
  if (!canSeeMap(currentUser?.email, currentUser?.role)) {
    return null;
  }

  // Saat bazlı "fresh" gösterimi için her 10s'de bir re-render
  useEffect(() => {
    tickRef.current = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
    };
  }, []);

  // İlk yükleme — her sorgu BAĞIMSIZ. live_locations/geofence_events
  // tabloları yoksa branches yine fallback ile dolar.
  useEffect(() => {
    // Önce fallback'ı hemen göster ki harita boş kalmasın.
    setBranches((prev) => (prev.length === 0 ? mergeBranches([]) : prev));

    void (async () => {
      try {
        const { data } = await supabase
          .from('branch_locations')
          .select('branch, latitude, longitude, geofence_m, radius_m')
          .eq('is_active', true);
        const dbBranches: BranchRow[] = Array.isArray(data)
          ? data.map((b: any) => ({
              branch: b.branch,
              latitude: Number(b.latitude),
              longitude: Number(b.longitude),
              geofence_m: Number(b.geofence_m ?? 20),
              radius_m: Number(b.radius_m ?? 150),
            }))
          : [];
        setBranches(mergeBranches(dbBranches));
      } catch (err) {
        console.warn('[Map] branch_locations okunamadı, fallback kullanılıyor:', err);
        setBranches(mergeBranches([]));
      }
    })();

    void (async () => {
      try {
        const { data } = await supabase.from('live_locations').select('*');
        if (Array.isArray(data)) {
          const map: Record<string, LiveLocationRow> = {};
          data.forEach((row: any) => {
            map[row.employee_id] = row as LiveLocationRow;
          });
          setLiveLocations(map);
        }
      } catch (err) {
        console.warn('[Map] live_locations okunamadı:', err);
      }
    })();

    void (async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id, full_name, email, avatar_url, branch');
        if (Array.isArray(data)) {
          const map: Record<string, ProfileRow> = {};
          data.forEach((p: any) => {
            map[p.id] = p as ProfileRow;
          });
          setProfiles(map);
        }
      } catch (err) {
        console.warn('[Map] profiles okunamadı:', err);
      }
    })();

    void (async () => {
      try {
        const { data } = await supabase
          .from('geofence_events')
          .select('id, employee_id, branch, event_type, at')
          .order('at', { ascending: false })
          .limit(20);
        if (Array.isArray(data)) setRecentEvents(data as GeofenceEventRow[]);
      } catch (err) {
        console.warn('[Map] geofence_events okunamadı:', err);
      }
    })();
  }, []);

  // Bugünkü time_logs (resmi QR giriş/çıkış kayıtları) — 60 sn'de bir refresh.
  useEffect(() => {
    let cancelled = false;
    const fetchLogs = async () => {
      try {
        const { data } = await supabase
          .from('time_logs')
          .select('id, employee_id, branch, date, check_in_at, check_out_at, entry_method, device_info')
          .eq('date', todayBerlin())
          .order('check_in_at', { ascending: false });
        if (!cancelled && Array.isArray(data)) setTodayLogs(data as TimeLogRow[]);
      } catch (err) {
        console.warn('[Map] time_logs okunamadı:', err);
      }
    };
    void fetchLogs();
    const id = window.setInterval(fetchLogs, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Modal açıldığında — seçili kişinin o gün şubeye girip-çıkış zaman çizelgesi.
  useEffect(() => {
    if (!selectedLog) {
      setLogTimeline([]);
      return;
    }
    let cancelled = false;
    setTimelineLoading(true);
    void (async () => {
      try {
        const dateStr = selectedLog.date; // YYYY-MM-DD
        const { data } = await supabase
          .from('geofence_events')
          .select('id, employee_id, branch, event_type, at')
          .eq('employee_id', selectedLog.employee_id)
          .gte('at', `${dateStr}T00:00:00Z`)
          .lt('at', `${dateStr}T23:59:59Z`)
          .order('at', { ascending: true });
        if (!cancelled && Array.isArray(data)) {
          setLogTimeline(data as GeofenceEventRow[]);
        }
      } catch (err) {
        console.warn('[Map] timeline okunamadı:', err);
      } finally {
        if (!cancelled) setTimelineLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedLog]);

  // ESC ile modal'ı kapat
  useEffect(() => {
    if (!selectedLog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedLog(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedLog]);

  // Path fetch: pathEmployeeId / pathRange değiştiğinde location_history sorgusu
  useEffect(() => {
    if (!pathEmployeeId) {
      setPathPoints([]);
      return;
    }
    let cancelled = false;
    setPathLoading(true);
    void (async () => {
      try {
        const sinceIso = (() => {
          if (pathRange === 'today') {
            const d = new Date();
            const berlinDate = new Intl.DateTimeFormat('en-CA', {
              timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(d);
            return new Date(`${berlinDate}T00:00:00+02:00`).toISOString();
          }
          if (pathRange === '24h') {
            return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          }
          return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        })();

        const { data, error } = await supabase
          .from('location_history')
          .select('id, employee_id, lat, lng, accuracy_m, branch, distance_m, inside_geofence, captured_at')
          .eq('employee_id', pathEmployeeId)
          .gte('captured_at', sinceIso)
          .order('captured_at', { ascending: true })
          .limit(2000);
        if (!cancelled && !error && Array.isArray(data)) {
          setPathPoints(data as LocationHistoryRow[]);
        } else if (error) {
          console.warn('[Map] location_history okunamadı:', error.message);
        }
      } catch (err) {
        console.warn('[Map] path fetch hata:', err);
      } finally {
        if (!cancelled) setPathLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pathEmployeeId, pathRange, now]);

  // Realtime — location_history (sadece path açıkken takip et)
  useEffect(() => {
    if (!pathEmployeeId) return;
    const ch = supabase
      .channel(`map-location-history-${pathEmployeeId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'location_history',
          filter: `employee_id=eq.${pathEmployeeId}`,
        },
        (payload) => {
          const row = payload.new as LocationHistoryRow;
          setPathPoints((prev) => [...prev, row]);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [pathEmployeeId]);

  // Realtime — live_locations
  useEffect(() => {
    const ch = supabase
      .channel('map-live-locations')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'live_locations' },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const row = payload.old as Partial<LiveLocationRow>;
            if (row.employee_id) {
              setLiveLocations((prev) => {
                const next = { ...prev };
                delete next[row.employee_id!];
                return next;
              });
            }
          } else {
            const row = payload.new as LiveLocationRow;
            setLiveLocations((prev) => ({ ...prev, [row.employee_id]: row }));
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  // Realtime — geofence_events
  useEffect(() => {
    const ch = supabase
      .channel('map-geofence-events')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'geofence_events' },
        (payload) => {
          const row = payload.new as GeofenceEventRow;
          setRecentEvents((prev) => [row, ...prev].slice(0, 20));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  // FitBounds için noktalar — şube seçiliyse SADECE o şube, değilse tüm şubeler.
  const branchPoints = useMemo<[number, number][]>(() => {
    if (selectedBranch) {
      const b = branches.find((br) => br.branch === selectedBranch);
      return b ? [[b.latitude, b.longitude]] : [];
    }
    return branches.map((b) => [b.latitude, b.longitude]);
  }, [branches, selectedBranch]);

  // Initial center; FitBounds devreye girdiğinde bu zaten override olur.
  const mapCenter: [number, number] = useMemo(() => {
    if (branches.length === 0) return [50.95, 6.97];
    const lat = branches.reduce((s, b) => s + b.latitude, 0) / branches.length;
    const lng = branches.reduce((s, b) => s + b.longitude, 0) / branches.length;
    return [lat, lng];
  }, [branches]);

  const liveList = useMemo(() => {
    const rows: LiveLocationRow[] = Object.values(liveLocations);
    return rows
      .filter((row) => !selectedBranch || row.branch === selectedBranch)
      .map((row) => {
        const profile = profiles[row.employee_id];
        const updatedAt = new Date(row.updated_at).getTime();
        const isOnline = now - updatedAt < FRESH_THRESHOLD_MS;
        return { row, profile, isOnline };
      })
      .sort((a, b) => {
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
        return new Date(b.row.updated_at).getTime() - new Date(a.row.updated_at).getTime();
      });
  }, [liveLocations, profiles, now, selectedBranch]);

  // Bugünkü time_logs — şube seçiliyse sadece o şube; check_in_at'a göre sıralı.
  const filteredLogs = useMemo(() => {
    return todayLogs
      .filter((l) => !selectedBranch || l.branch === selectedBranch)
      .sort((a, b) => {
        const ta = a.check_in_at ? new Date(a.check_in_at).getTime() : 0;
        const tb = b.check_in_at ? new Date(b.check_in_at).getTime() : 0;
        return tb - ta;
      });
  }, [todayLogs, selectedBranch]);

  const filteredEvents = useMemo(
    () => recentEvents.filter((e) => !selectedBranch || e.branch === selectedBranch),
    [recentEvents, selectedBranch],
  );

  const onlineCount = liveList.filter((x) => x.isOnline).length;

  return (
    <div className="flex-1 flex flex-col p-4 md:p-6 overflow-y-auto lg:overflow-hidden custom-scrollbar pb-32 lg:pb-6">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <MapPin size={26} className="text-indigo-400" />
            {t('map.title')}
          </h1>
          <p className="text-sm text-slate-600 dark:text-zinc-400 mt-1">{t('map.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
            <Activity size={14} />
            {onlineCount} {t('map.legend.online')}
          </span>
        </div>
      </div>

      {/* Şube filtresi */}
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setSelectedBranch(null)}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all border ${
            selectedBranch === null
              ? 'bg-indigo-600/30 text-indigo-200 border-indigo-500/50'
              : 'bg-white dark:bg-zinc-900/60 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:text-slate-900 dark:hover:text-white hover:border-slate-300 dark:border-zinc-700'
          }`}
        >
          {t('map.filter.all')}
        </button>
        {branches.map((b) => {
          const active = selectedBranch === b.branch;
          const c = colorFor(b.branch);
          return (
            <button
              key={b.branch}
              type="button"
              onClick={() => setSelectedBranch(active ? null : b.branch)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all border flex items-center gap-1.5 ${
                active
                  ? 'text-slate-900 dark:text-white border-transparent shadow'
                  : 'bg-white dark:bg-zinc-900/60 text-slate-700 dark:text-zinc-300 border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:border-zinc-700'
              }`}
              style={
                active
                  ? { background: `${c}33`, borderColor: c, color: c }
                  : undefined
              }
            >
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: c }}
              />
              {b.branch}
            </button>
          );
        })}
      </div>

      {/* Layout: Map + Side Panel — flex ile rows/cols arası geçiş */}
      <div className="flex-1 flex flex-col lg:flex-row gap-4 lg:min-h-0 lg:overflow-hidden">
        {/* Map */}
        <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 h-[55vh] lg:h-auto lg:flex-1 lg:min-h-[420px] relative">
          {/* Rota kontrol kutucuğu — path açıkken haritanın üstünde gözükür */}
          {pathEmployeeId && (
            <div className="absolute top-3 left-3 z-[500] bg-white dark:bg-zinc-900/95 backdrop-blur-sm border border-indigo-700/50 rounded-xl shadow-xl p-3 flex flex-col gap-2 min-w-[220px]">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Route size={14} className="text-indigo-400" />
                  <span className="text-xs font-semibold text-slate-900 dark:text-white">
                    {profiles[pathEmployeeId]?.full_name || t('map.path')}
                  </span>
                </div>
                <button
                  onClick={() => setPathEmployeeId(null)}
                  className="text-slate-500 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white p-0.5 rounded"
                  title={t('map.hidePath')}
                >
                  <X size={14} />
                </button>
              </div>
              <div className="flex gap-1">
                {(['today', '24h', '7d'] as PathRange[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setPathRange(r)}
                    className={`flex-1 text-[10px] font-medium px-2 py-1.5 rounded-md transition-colors ${
                      pathRange === r
                        ? 'bg-indigo-600 text-slate-900 dark:text-white'
                        : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {r === 'today' ? t('map.pathToday') : r === '24h' ? t('map.path24h') : t('map.path7d')}
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-slate-500 dark:text-zinc-500 flex items-center justify-between">
                <span>
                  {pathLoading
                    ? t('map.pathLoading')
                    : `${pathPoints.length} ${t('map.pathPoints')}`}
                </span>
                {pathPoints.length > 0 && (
                  <span className="font-mono">
                    {formatBerlin(pathPoints[0].captured_at).slice(0, 5)} →{' '}
                    {formatBerlin(pathPoints[pathPoints.length - 1].captured_at).slice(0, 5)}
                  </span>
                )}
              </div>
            </div>
          )}
          {tileMapState === 'loading' && (
            <div className="absolute inset-0 z-[400] bg-white dark:bg-zinc-900/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
              <div className="flex items-center gap-3 text-slate-700 dark:text-zinc-300">
                <MapPin size={20} className="animate-pulse text-indigo-400" />
                <span className="text-sm">{t('map.loadingTiles')}</span>
              </div>
            </div>
          )}
          {tileMapState === 'error' && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[600] bg-rose-900/95 border border-rose-700 text-rose-100 px-4 py-2 rounded-lg shadow-xl flex items-center gap-3">
              <span className="text-sm">{t('map.tileError')}</span>
              <button
                onClick={() => {
                  tileErrorCountRef.current = 0;
                  setTileProviderIdx(0);
                  setTileMapState('loading');
                }}
                className="text-xs bg-rose-700 hover:bg-rose-600 px-2 py-1 rounded"
              >
                {t('map.retry')}
              </button>
            </div>
          )}
          <MapContainer
            center={mapCenter}
            zoom={13}
            scrollWheelZoom
            style={{ height: '100%', width: '100%' }}
          >
            <TileLayer
              key={tileProviderIdx}
              url={TILE_PROVIDERS[tileProviderIdx].url}
              subdomains={TILE_PROVIDERS[tileProviderIdx].subdomains}
              attribution={TILE_PROVIDERS[tileProviderIdx].attribution}
              maxZoom={TILE_PROVIDERS[tileProviderIdx].maxZoom}
              keepBuffer={4}
              updateWhenIdle
              crossOrigin="anonymous"
              eventHandlers={{
                tileerror: () => {
                  tileErrorCountRef.current += 1;
                  if (tileErrorCountRef.current >= TILE_ERROR_THRESHOLD) {
                    if (tileProviderIdx < TILE_PROVIDERS.length - 1) {
                      tileErrorCountRef.current = 0;
                      setTileProviderIdx((i) => i + 1);
                    } else {
                      setTileMapState('error');
                    }
                  }
                },
                load: () => {
                  tileErrorCountRef.current = 0;
                  setTileMapState('ready');
                },
              }}
            />

            {/* 5 şubeyi tek seferde ekrana sığdır */}
            <FitBounds points={branchPoints} />

            {/* Şube marker'ları + geofence çemberi */}
            {branches.map((b) => (
              <React.Fragment key={b.branch}>
                <Circle
                  center={[b.latitude, b.longitude]}
                  radius={b.geofence_m}
                  pathOptions={{
                    color: colorFor(b.branch),
                    fillColor: colorFor(b.branch),
                    fillOpacity: 0.15,
                    weight: 1.5,
                  }}
                />
                <Marker
                  position={[b.latitude, b.longitude]}
                  icon={buildBranchIcon(b.branch)}
                  zIndexOffset={(BRANCH_Z[b.branch] ?? 0) * 100}
                >
                  <Popup>
                    <div style={{ minWidth: 140 }}>
                      <strong>{b.branch}</strong>
                      <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                        {b.latitude.toFixed(5)}, {b.longitude.toFixed(5)}
                      </div>
                      <div style={{ fontSize: 11, color: '#666' }}>
                        {t('map.legend.geofence')}: {b.geofence_m}m
                      </div>
                    </div>
                  </Popup>
                </Marker>
              </React.Fragment>
            ))}

            {/* Personel marker'ları */}
            {liveList.map(({ row, profile, isOnline }) => (
              <Marker
                key={row.employee_id}
                position={[row.lat, row.lng]}
                icon={buildPersonIcon(profile, isOnline)}
              >
                <Popup>
                  <div style={{ minWidth: 200 }}>
                    <strong>{profile?.full_name || row.employee_id}</strong>
                    <div style={{ fontSize: 12, marginTop: 4, color: '#444' }}>
                      {row.branch
                        ? `${row.branch} — ${
                            row.inside_geofence
                              ? t('map.insideGeofence')
                              : t('map.outsideGeofence')
                          }`
                        : '—'}
                    </div>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                      {t('map.distance')}:{' '}
                      {row.distance_m != null ? `${Math.round(row.distance_m)}m` : '—'}
                    </div>
                    <div style={{ fontSize: 11, color: '#666' }}>
                      {t('map.lastSeen')}: {formatBerlin(row.updated_at)}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (pathEmployeeId === row.employee_id) {
                          setPathEmployeeId(null);
                        } else {
                          setPathEmployeeId(row.employee_id);
                        }
                      }}
                      style={{
                        marginTop: 8,
                        width: '100%',
                        padding: '6px 10px',
                        background: pathEmployeeId === row.employee_id ? '#4f46e5' : '#1f2937',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                      }}
                    >
                      <Route size={12} />
                      {pathEmployeeId === row.employee_id
                        ? t('map.hidePath')
                        : t('map.showPath')}
                    </button>
                  </div>
                </Popup>
              </Marker>
            ))}

            {/* Hareket geçmişi (path) */}
            {pathEmployeeId && pathPoints.length >= 2 && (
              <Polyline
                positions={pathPoints.map((p) => [p.lat, p.lng] as [number, number])}
                pathOptions={{ color: '#4f46e5', weight: 3, opacity: 0.85, dashArray: '4 6' }}
              />
            )}
            {pathEmployeeId && pathPoints.map((p, i) => (
              <CircleMarker
                key={p.id}
                center={[p.lat, p.lng]}
                radius={i === pathPoints.length - 1 ? 5 : 3}
                pathOptions={{
                  color: i === pathPoints.length - 1 ? '#4f46e5' : '#6366f1',
                  fillColor: i === pathPoints.length - 1 ? '#818cf8' : '#a5b4fc',
                  fillOpacity: 0.9,
                  weight: 1,
                }}
              >
                <Popup>
                  <div style={{ fontSize: 11 }}>
                    <strong>{formatBerlin(p.captured_at)}</strong>
                    {p.branch && <div style={{ color: '#666' }}>{p.branch} • {Math.round(p.distance_m || 0)}m</div>}
                    {p.accuracy_m && <div style={{ color: '#999' }}>±{Math.round(p.accuracy_m)}m</div>}
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>
        </div>

        {/* Side Panel */}
        <div className="flex flex-col gap-4 lg:min-h-0 lg:w-[360px] lg:shrink-0">
          {/* Aktif personel listesi */}
          <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 p-4 flex flex-col max-h-[360px] lg:max-h-none lg:flex-1 lg:min-h-0">
            <div className="flex items-center gap-2 mb-3">
              <Users size={16} className="text-indigo-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{t('map.activeStaff')}</h3>
              <span className="ml-auto text-xs text-slate-500 dark:text-zinc-500">{liveList.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
              {liveList.length === 0 && (
                <p className="text-sm text-slate-500 dark:text-zinc-500 italic">{t('map.noActiveStaff')}</p>
              )}
              {liveList.map(({ row, profile, isOnline }) => (
                <div
                  key={row.employee_id}
                  className="flex items-center gap-3 p-2.5 rounded-lg bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800"
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold border-2 ${
                      isOnline ? 'border-emerald-500' : 'border-zinc-600'
                    } bg-slate-100 dark:bg-zinc-800 text-slate-800 dark:text-zinc-200 overflow-hidden`}
                  >
                    {profile?.avatar_url ? (
                      <img
                        src={profile.avatar_url}
                        alt={profile.full_name}
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      initials(profile?.full_name || '??')
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 dark:text-white truncate">
                      {profile?.full_name || row.employee_id}
                    </p>
                    <p className="text-[11px] text-slate-600 dark:text-zinc-400 flex items-center gap-1.5">
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full"
                        style={{ background: colorFor(row.branch) }}
                      />
                      {row.branch || '—'} ·{' '}
                      <span
                        className={
                          row.inside_geofence ? 'text-emerald-400' : 'text-amber-400'
                        }
                      >
                        {row.inside_geofence
                          ? t('map.insideGeofence')
                          : t('map.outsideGeofence')}
                      </span>
                    </p>
                    <p className="text-[10px] text-slate-500 dark:text-zinc-500 mt-0.5 flex items-center gap-1">
                      <Clock size={10} />
                      {formatBerlin(row.updated_at)} ·{' '}
                      {row.distance_m != null ? `${Math.round(row.distance_m)}m` : '—'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Bugünkü Giriş/Çıkış (time_logs) — şube filtresine duyarlı */}
          <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 p-4 flex flex-col max-h-[400px] lg:max-h-none lg:flex-1 lg:min-h-0">
            <div className="flex items-center gap-2 mb-3">
              <Clock size={16} className="text-indigo-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                {t('map.todayCheckIns')}
              </h3>
              {selectedBranch && (
                <span
                  className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border"
                  style={{
                    background: `${colorFor(selectedBranch)}22`,
                    borderColor: colorFor(selectedBranch),
                    color: colorFor(selectedBranch),
                  }}
                >
                  {selectedBranch}
                </span>
              )}
              <span className="ml-auto text-xs text-slate-500 dark:text-zinc-500">{filteredLogs.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
              {filteredLogs.length === 0 && (
                <p className="text-xs text-slate-500 dark:text-zinc-500 italic">{t('map.noCheckInsToday')}</p>
              )}
              {filteredLogs.map((log) => {
                const profile = profiles[log.employee_id];
                const c = colorFor(log.branch);
                const stillIn = !log.check_out_at;
                return (
                  <button
                    type="button"
                    key={String(log.id)}
                    onClick={() => setSelectedLog(log)}
                    className="w-full text-left flex items-center gap-3 p-2.5 rounded-lg bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800 hover:border-indigo-500/50 hover:bg-slate-100 dark:hover:bg-white dark:hover:bg-zinc-900 transition-colors cursor-pointer"
                  >
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold border-2 bg-slate-100 dark:bg-zinc-800 text-slate-800 dark:text-zinc-200 overflow-hidden shrink-0"
                      style={{ borderColor: c }}
                    >
                      {profile?.avatar_url ? (
                        <img
                          src={profile.avatar_url}
                          alt={profile.full_name}
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        initials(profile?.full_name || '??')
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-white truncate">
                        {profile?.full_name || log.employee_id}
                      </p>
                      <div className="flex items-center gap-1.5 text-[11px] mt-0.5">
                        <span className="text-emerald-300 font-mono">
                          {t('map.checkIn')}: {formatHHMM(log.check_in_at)}
                        </span>
                        <span className="text-slate-400 dark:text-zinc-600">→</span>
                        {stillIn ? (
                          <span className="text-amber-300 font-medium">
                            {t('map.stillWorking')}
                          </span>
                        ) : (
                          <span className="text-rose-300 font-mono">
                            {t('map.checkOut')}: {formatHHMM(log.check_out_at)}
                          </span>
                        )}
                      </div>
                      {!selectedBranch && (
                        <p className="text-[10px] text-slate-500 dark:text-zinc-500 mt-0.5 flex items-center gap-1">
                          <span
                            className="inline-block w-1.5 h-1.5 rounded-full"
                            style={{ background: c }}
                          />
                          {log.branch}
                          {log.check_in_at && log.check_out_at && (
                            <span className="ml-1 text-slate-500 dark:text-zinc-500">
                              · {t('map.duration')}:{' '}
                              {formatDuration(log.check_in_at, log.check_out_at)}
                            </span>
                          )}
                        </p>
                      )}
                      {selectedBranch && log.check_in_at && log.check_out_at && (
                        <p className="text-[10px] text-slate-500 dark:text-zinc-500 mt-0.5">
                          {t('map.duration')}:{' '}
                          {formatDuration(log.check_in_at, log.check_out_at)}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Geofence enter/exit (geçmiş 20 olay) — şube filtresine duyarlı */}
          <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 p-4 max-h-[200px] flex flex-col">
            <div className="flex items-center gap-2 mb-3">
              <ArrowRightLeft size={16} className="text-indigo-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                {t('map.event.enter')}/{t('map.event.exit')}
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
              {filteredEvents.length === 0 && (
                <p className="text-xs text-slate-500 dark:text-zinc-500 italic">—</p>
              )}
              {filteredEvents.map((ev) => {
                const profile = profiles[ev.employee_id];
                const isEnter = ev.event_type === 'enter';
                return (
                  <div
                    key={ev.id}
                    className="flex items-start gap-2 p-2 rounded-md bg-slate-50 dark:bg-zinc-950/40 border border-slate-200 dark:border-zinc-800/60"
                  >
                    <span
                      className={`mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] ${
                        isEnter
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : 'bg-amber-500/20 text-amber-300'
                      }`}
                    >
                      {isEnter ? '→' : '←'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-900 dark:text-white truncate">
                        <span className="font-medium">
                          {profile?.full_name || ev.employee_id}
                        </span>{' '}
                        <span className="text-slate-600 dark:text-zinc-400">
                          ({ev.branch}) —{' '}
                          {isEnter ? t('map.event.enter') : t('map.event.exit')}
                        </span>
                      </p>
                      <p className="text-[10px] text-slate-500 dark:text-zinc-500">{formatBerlin(ev.at)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* DETAIL MODAL — kişi kartına tıklanınca açılır */}
      {selectedLog && (() => {
        const log = selectedLog;
        const profile = profiles[log.employee_id];
        const live = liveLocations[log.employee_id];
        const c = colorFor(log.branch);
        const stillIn = !log.check_out_at;
        const totalDuration =
          log.check_in_at
            ? formatDuration(log.check_in_at, log.check_out_at || new Date().toISOString())
            : '—';
        const method = (log.entry_method || '').toLowerCase();
        const methodLabel =
          method === 'qr' ? t('map.detail.method.qr') : t('map.detail.method.manual');
        const liveUpdated = live ? new Date(live.updated_at).getTime() : 0;
        const isLiveOnline = live && now - liveUpdated < FRESH_THRESHOLD_MS;

        return (
          <div
            className="fixed inset-0 z-[2000] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setSelectedLog(null)}
          >
            <div
              className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl max-w-md w-full max-h-[88vh] overflow-y-auto custom-scrollbar relative"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Close button */}
              <button
                type="button"
                onClick={() => setSelectedLog(null)}
                className="absolute top-3 right-3 z-10 w-8 h-8 rounded-full bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white flex items-center justify-center transition-colors border border-slate-300 dark:border-zinc-700"
                aria-label={t('map.detail.close')}
              >
                <X size={16} />
              </button>

              {/* Header */}
              <div
                className="px-6 pt-6 pb-4 border-b border-slate-200 dark:border-zinc-800"
                style={{ background: `linear-gradient(180deg, ${c}22 0%, transparent 100%)` }}
              >
                <p className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-zinc-500 font-bold mb-2">
                  {t('map.detail.title')}
                </p>
                <div className="flex items-center gap-3">
                  <div
                    className="w-12 h-12 rounded-full overflow-hidden border-2 bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white flex items-center justify-center font-bold shrink-0"
                    style={{ borderColor: c }}
                  >
                    {profile?.avatar_url ? (
                      <img
                        src={profile.avatar_url}
                        alt={profile.full_name}
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      initials(profile?.full_name || '??')
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-bold text-slate-900 dark:text-white truncate">
                      {profile?.full_name || log.employee_id}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border"
                        style={{
                          background: `${c}22`,
                          borderColor: c,
                          color: c,
                        }}
                      >
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full"
                          style={{ background: c }}
                        />
                        {log.branch}
                      </span>
                      {stillIn ? (
                        <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-2 py-0.5">
                          ● {t('map.stillWorking')}
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold text-slate-600 dark:text-zinc-400 bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-full px-2 py-0.5">
                          {t('map.checkOut')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Vardiya Bilgileri */}
              <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800/60">
                <h4 className="text-xs font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Clock size={14} className="text-indigo-400" />
                  {t('map.detail.shiftInfo')}
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800 rounded-lg p-3">
                    <p className="text-[10px] text-slate-500 dark:text-zinc-500 uppercase tracking-wide font-semibold mb-1 flex items-center gap-1">
                      <LogIn size={11} className="text-emerald-400" />
                      {t('map.checkIn')}
                    </p>
                    <p className="text-base font-mono font-bold text-emerald-300">
                      {formatHHMM(log.check_in_at)}
                    </p>
                  </div>
                  <div className="bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800 rounded-lg p-3">
                    <p className="text-[10px] text-slate-500 dark:text-zinc-500 uppercase tracking-wide font-semibold mb-1 flex items-center gap-1">
                      <LogOut size={11} className="text-rose-400" />
                      {t('map.checkOut')}
                    </p>
                    <p className="text-base font-mono font-bold text-rose-300">
                      {stillIn ? '—' : formatHHMM(log.check_out_at)}
                    </p>
                  </div>
                  <div className="bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800 rounded-lg p-3">
                    <p className="text-[10px] text-slate-500 dark:text-zinc-500 uppercase tracking-wide font-semibold mb-1 flex items-center gap-1">
                      <Hourglass size={11} className="text-amber-400" />
                      {t('map.detail.totalDuration')}
                    </p>
                    <p className="text-base font-mono font-bold text-amber-300">
                      {totalDuration}
                    </p>
                  </div>
                  <div className="bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800 rounded-lg p-3">
                    <p className="text-[10px] text-slate-500 dark:text-zinc-500 uppercase tracking-wide font-semibold mb-1 flex items-center gap-1">
                      {method === 'qr' ? (
                        <QrCode size={11} className="text-indigo-400" />
                      ) : (
                        <Hand size={11} className="text-slate-600 dark:text-zinc-400" />
                      )}
                      {t('map.detail.entryMethod')}
                    </p>
                    <p className="text-sm font-bold text-slate-800 dark:text-zinc-200">{methodLabel}</p>
                  </div>
                </div>

                {/* Cihaz */}
                <div className="mt-3 bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800 rounded-lg p-3 flex items-center gap-2">
                  <Smartphone size={14} className="text-indigo-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-slate-500 dark:text-zinc-500 uppercase tracking-wide font-semibold">
                      {t('map.detail.device')}
                    </p>
                    <p className="text-xs text-slate-800 dark:text-zinc-200 truncate" title={log.device_info || ''}>
                      {log.device_info || t('map.detail.deviceUnknown')}
                    </p>
                  </div>
                </div>
              </div>

              {/* Şube içi/dışı zaman çizelgesi */}
              <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800/60">
                <h4 className="text-xs font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <ArrowRightLeft size={14} className="text-indigo-400" />
                  {t('map.detail.timeline')}
                </h4>
                {timelineLoading ? (
                  <p className="text-xs text-slate-500 dark:text-zinc-500 italic">…</p>
                ) : logTimeline.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-zinc-500 italic">{t('map.detail.noTimeline')}</p>
                ) : (
                  <ol className="relative border-l border-slate-200 dark:border-zinc-800 ml-2 pl-4 space-y-3">
                    {logTimeline.map((ev) => {
                      const isEnter = ev.event_type === 'enter';
                      return (
                        <li key={ev.id} className="relative">
                          <span
                            className={`absolute -left-[22px] top-0.5 w-3.5 h-3.5 rounded-full border-2 ${
                              isEnter
                                ? 'bg-emerald-500/30 border-emerald-400'
                                : 'bg-amber-500/30 border-amber-400'
                            }`}
                          />
                          <p className={`text-xs font-semibold ${isEnter ? 'text-emerald-300' : 'text-amber-300'}`}>
                            {isEnter ? t('map.detail.enteredAt') : t('map.detail.exitedAt')}
                          </p>
                          <p className="text-[11px] text-slate-600 dark:text-zinc-400 font-mono">
                            {formatHHMM(ev.at)}{' '}
                            <span className="text-slate-400 dark:text-zinc-600">({ev.branch})</span>
                          </p>
                        </li>
                      );
                    })}
                    {stillIn && (
                      <li className="relative">
                        <span className="absolute -left-[22px] top-0.5 w-3.5 h-3.5 rounded-full border-2 border-indigo-400 bg-indigo-500/30 animate-pulse" />
                        <p className="text-xs font-semibold text-indigo-300">
                          {t('map.detail.now')}
                        </p>
                        <p className="text-[11px] text-slate-600 dark:text-zinc-400 font-mono">
                          {formatHHMM(new Date().toISOString())}
                        </p>
                      </li>
                    )}
                  </ol>
                )}
              </div>

              {/* Mevcut konum (live_locations) */}
              {live && (
                <div className="px-6 py-4">
                  <h4 className="text-xs font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <MapPin size={14} className="text-indigo-400" />
                    {t('map.detail.currentLocation')}
                  </h4>
                  <div className="bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800 rounded-lg p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 dark:text-zinc-500">{t('map.lastSeen')}</span>
                      <span className="text-xs text-slate-800 dark:text-zinc-200 font-mono flex items-center gap-1.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            isLiveOnline ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'
                          }`}
                        />
                        {formatBerlin(live.updated_at)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 dark:text-zinc-500">{t('map.distance')}</span>
                      <span className="text-xs font-mono text-slate-800 dark:text-zinc-200">
                        {live.distance_m != null ? `${Math.round(live.distance_m)}m` : '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 dark:text-zinc-500">
                        {live.inside_geofence ? t('map.insideGeofence') : t('map.outsideGeofence')}
                      </span>
                      <span
                        className={`text-xs font-semibold ${
                          live.inside_geofence ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        ●
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default Map;
