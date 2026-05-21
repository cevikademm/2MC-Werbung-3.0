import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X, ShoppingBag, Clock, FileText, BarChart3, CheckCheck, Loader2, Inbox, AlarmClockOff, MessageSquare, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { canSeeNotificationCenter } from '../constants';

// =============================================================
// NotificationCenter — Header'a mount edilen Bell butonu + dropdown
// =============================================================
// - Sadece NOTIFICATION_CENTER_ALLOWED_EMAILS listesindekilere render olur
// - notification_log tablosundan son 100 kaydı okur
// - Realtime: yeni INSERT geldiğinde anında listeye düşer
// - "Okundu" işareti read_by[] kolonuna user_id ekler (kişisel)
// =============================================================

interface NotificationRow {
  id: string;
  type: 'off_shift_sale' | 'off_shift_qr' | 'non_kiosk_check' | 'weekly_sales_anomaly' | 'auto_closed_shift' | 'qr_scan_error' | string;
  title: string;
  body: string | null;
  url: string | null;
  tag: string | null;
  meta: any;
  read_by: string[];
  created_at: string;
}

interface Props {
  currentUserId: string | undefined;
  currentUserEmail: string | undefined;
  onNavigate?: (tab: string) => void;
}

const ICON_BY_TYPE: Record<string, { icon: React.ComponentType<{ size?: number; className?: string }>; color: string }> = {
  off_shift_sale: { icon: ShoppingBag, color: 'text-orange-400 bg-orange-500/10 border-orange-500/30' },
  off_shift_qr: { icon: Clock, color: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
  non_kiosk_check: { icon: FileText, color: 'text-blue-400 bg-blue-500/10 border-blue-500/30' },
  weekly_sales_anomaly: { icon: BarChart3, color: 'text-purple-400 bg-purple-500/10 border-purple-500/30' },
  auto_closed_shift: { icon: AlarmClockOff, color: 'text-rose-400 bg-rose-500/10 border-rose-500/30' },
  new_message: { icon: MessageSquare, color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/30' },
  qr_scan_error: { icon: XCircle, color: 'text-red-400 bg-red-500/10 border-red-500/30' },
};

const formatRelative = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'şimdi';
  if (m < 60) return `${m} dk önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} saat önce`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} gün önce`;
  return new Date(iso).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' });
};

const NotificationCenter: React.FC<Props> = ({ currentUserId, currentUserEmail, onNavigate }) => {
  const allowed = canSeeNotificationCenter(currentUserEmail);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [routeUrl, setRouteUrl] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Popup pozisyonu hem mobil hem desktop için JS'te hesaplanır.
  // Tailwind CDN üzerinde calc() + env() arbitrary value'ları her tarayıcıda
  // güvenli üretilemediği için inline style kullanıyoruz.
  const [popupStyle, setPopupStyle] = useState<React.CSSProperties | null>(null);

  useEffect(() => {
    if (!open) {
      setPopupStyle(null);
      return;
    }
    const compute = () => {
      const isDesktop = window.matchMedia('(min-width: 768px)').matches;
      if (isDesktop && buttonRef.current) {
        const r = buttonRef.current.getBoundingClientRect();
        setPopupStyle({
          position: 'fixed',
          top: r.bottom + 6,
          right: Math.max(8, window.innerWidth - r.right),
          width: '24rem',
          maxWidth: 'min(28rem, calc(100vw - 1rem))',
          zIndex: 1000,
        });
        return;
      }
      // Mobil: header altı (header = 4rem + safe-area-top), ekran kenarına 8px margin,
      // bottom nav (h-16 + safe-area-bottom) için 96px tampon bırak.
      // Inline style olduğu için calc() doğrudan tarayıcıya gider — Tailwind CDN'in
      // arbitrary value JIT'inden bağımsız çalışır.
      setPopupStyle({
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 4rem + 4px)',
        left: 8,
        right: 8,
        maxHeight:
          'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 4rem - 96px)',
        zIndex: 1000,
      });
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [open]);

  // Hash route handler — bildirime tıklanınca tab değiştir
  useEffect(() => {
    if (!routeUrl) return;
    if (routeUrl.startsWith('/')) {
      const tab = routeUrl.replace(/^\//, '').split('?')[0] || 'dashboard';
      onNavigate?.(tab);
    }
    setRouteUrl(null);
  }, [routeUrl, onNavigate]);

  // İlk yükleme + realtime subscription. Mesaj bildirimleri tüm rollere
  // açık olduğundan fetch ve subscribe her zaman çalışır; gizleme tarafı
  // filter (visibleItems) ile yapılır.
  useEffect(() => {
    let cancelled = false;
    const fetchInitial = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('notification_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (!cancelled) {
        if (error) console.error('[NotificationCenter] fetch error:', error);
        else setItems((data || []) as NotificationRow[]);
        setLoading(false);
      }
    };
    fetchInitial();

    const channel = supabase
      .channel('notification_log_feed')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notification_log' },
        (payload) => {
          setItems((prev) => [payload.new as NotificationRow, ...prev].slice(0, 100));
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  // Görünür bildirimler — current user'ın görmesi gerekenleri filtrele.
  // - new_message: meta.receiver_id === currentUserId | 'ALL' | (admin && 'ADMIN_BOARD')
  //   Kendi gönderdiğim mesaj kendime bildirim olarak düşmesin.
  // - Diğer operasyonel bildirim tipleri: sadece NOTIFICATION_CENTER_ALLOWED_EMAILS
  //   listesindeki adminler (canSeeNotificationCenter === true) görür.
  const visibleItems = useMemo(() => {
    return items.filter((n) => {
      if (n.type === 'new_message') {
        if (n.meta?.sender_id === currentUserId) return false;
        const rid = n.meta?.receiver_id;
        if (rid === currentUserId) return true;
        if (rid === 'ALL') return true;
        if (rid === 'ADMIN_BOARD' && allowed) return true;
        return false;
      }
      return allowed;
    });
  }, [items, currentUserId, allowed]);

  // Dropdown dışına tıklayınca kapat — popup portal'a alındığı için
  // hem buton (dropdownRef) hem de portal içeriği (popupRef) ayrı kontrol edilir.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: Event) => {
      const target = e.target as Node;
      const inButton = dropdownRef.current?.contains(target);
      const inPopup = popupRef.current?.contains(target);
      if (!inButton && !inPopup) setOpen(false);
    };
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onClick);
      document.addEventListener('touchstart', onClick);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('touchstart', onClick);
    };
  }, [open]);

  const unreadCount = useMemo(() => {
    if (!currentUserId) return 0;
    return visibleItems.filter((n) => !n.read_by?.includes(currentUserId)).length;
  }, [visibleItems, currentUserId]);

  const markAsRead = async (id: string) => {
    if (!currentUserId) return;
    const item = items.find((n) => n.id === id);
    if (!item || item.read_by?.includes(currentUserId)) return;
    const newReadBy = [...(item.read_by || []), currentUserId];
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_by: newReadBy } : n)));
    await supabase.from('notification_log').update({ read_by: newReadBy }).eq('id', id);
  };

  const markAllAsRead = async () => {
    if (!currentUserId) return;
    const unread = visibleItems.filter((n) => !n.read_by?.includes(currentUserId));
    if (unread.length === 0) return;
    setItems((prev) =>
      prev.map((n) =>
        n.read_by?.includes(currentUserId) ? n : { ...n, read_by: [...(n.read_by || []), currentUserId] }
      )
    );
    // DB tarafında tek tek update — array_append RPC yerine pratik yol
    await Promise.all(
      unread.map((n) =>
        supabase
          .from('notification_log')
          .update({ read_by: [...(n.read_by || []), currentUserId] })
          .eq('id', n.id)
      )
    );
  };

  const handleItemClick = (item: NotificationRow) => {
    markAsRead(item.id);
    if (item.url) setRouteUrl(item.url);
    setOpen(false);
  };

  // NOT: Eskiden `if (!allowed) return null` ile NotificationCenter sadece
  // NOTIFICATION_CENTER_ALLOWED_EMAILS listesindekilere render oluyordu. Artık
  // tüm rollere render olur — ancak görünür içerik visibleItems üzerinden
  // filtrelenir (allowed olmayanlar yalnızca kendilerine gelen mesaj
  // bildirimlerini görür).

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((o) => !o)}
        className="relative flex items-center justify-center h-9 w-9 md:h-10 md:w-10 rounded-lg bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 text-slate-700 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white hover:border-slate-300 dark:border-zinc-700 transition-colors"
        title="Bildirimler"
        aria-label="Bildirimler"
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-red-500 text-slate-900 dark:text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-slate-200 dark:border-zinc-950 shadow-lg shadow-red-500/30 animate-pulse">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && popupStyle && createPortal(
        <div
          ref={popupRef}
          style={popupStyle}
          className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-zinc-800">
            <div className="flex items-center gap-2 text-slate-900 dark:text-white font-semibold">
              <Bell size={16} className="text-indigo-400" />
              <span>Bildirimler</span>
              {unreadCount > 0 && (
                <span className="ml-1 px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] font-bold rounded">
                  {unreadCount} yeni
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={markAllAsRead}
                  className="text-xs text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white flex items-center gap-1"
                  title="Tümünü okundu işaretle"
                >
                  <CheckCheck size={14} /> Hepsini oku
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white"
                aria-label="Kapat"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Liste — parent flex-col + maxHeight olduğundan flex-1 ile genişler */}
          <div className="flex-1 min-h-0 md:max-h-[500px] overflow-y-auto custom-scrollbar">
            {loading && visibleItems.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-slate-600 dark:text-zinc-400 text-sm gap-2">
                <Loader2 size={16} className="animate-spin" /> Yükleniyor...
              </div>
            ) : visibleItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-500 dark:text-zinc-500 text-sm gap-2">
                <Inbox size={32} className="text-slate-300 dark:text-zinc-700" />
                Henüz bildirim yok
              </div>
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {visibleItems.map((n) => {
                  const cfg = ICON_BY_TYPE[n.type] || {
                    icon: Bell,
                    color: 'text-slate-600 dark:text-zinc-400 bg-slate-200 dark:bg-zinc-700/30 border-slate-300 dark:border-zinc-700',
                  };
                  const Icon = cfg.icon;
                  const isRead = currentUserId ? n.read_by?.includes(currentUserId) : false;
                  return (
                    <li
                      key={n.id}
                      onClick={() => handleItemClick(n)}
                      className={`px-4 py-3 cursor-pointer transition-colors flex gap-3 ${
                        isRead ? 'bg-transparent hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800/40' : 'bg-indigo-900/10 hover:bg-indigo-900/20'
                      }`}
                    >
                      <div
                        className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${cfg.color}`}
                      >
                        <Icon size={16} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className={`text-sm font-semibold truncate ${isRead ? 'text-slate-700 dark:text-zinc-300' : 'text-slate-900 dark:text-white'}`}>
                            {n.title}
                          </div>
                          {!isRead && (
                            <span className="w-2 h-2 bg-red-500 rounded-full mt-1.5 shrink-0" />
                          )}
                        </div>
                        {n.body && (
                          <div className="text-xs text-slate-600 dark:text-zinc-400 mt-0.5 line-clamp-2 whitespace-pre-line">{n.body}</div>
                        )}
                        <div className="text-[10px] text-slate-500 dark:text-zinc-500 mt-1">{formatRelative(n.created_at)}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {visibleItems.length > 0 && (
            <div className="px-4 py-2 border-t border-slate-200 dark:border-zinc-800 text-[10px] text-slate-500 dark:text-zinc-500 text-center">
              Son 90 gün — toplam {visibleItems.length} bildirim
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
};

export default NotificationCenter;
