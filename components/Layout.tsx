import React, { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  MessageSquare,
  Calendar as CalendarIcon,
  CheckSquare,
  Users,
  Settings as SettingsIcon,
  LogOut,
  User,
  Table,
  ShoppingBag,
  QrCode,
  ShieldAlert,
  Map as MapIcon,
  Smartphone,
  Sun,
  Moon,
  MessageCircle
} from 'lucide-react';
import { SUPPORT_WHATSAPP_URL } from '../lib/support';
import { useLanguage } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { Role } from '../types';
import { GlowingEffect } from './ui/glowing-effect';
import { canAccessLossControl } from './LossControl';
import { canSeeMap } from '../lib/geofence';
import { canSeeDeviceInfo } from '../lib/utils';
import NotificationCenter from './NotificationCenter';


interface LayoutProps {
  children: React.ReactNode;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  userId?: string;
  userRole: string;
  userName: string;
  userAvatar?: string;
  userEmail?: string;
  onLogout: () => void;
}

const BAC_LOGO_URL = "https://wgfkoxjlcovrkzrustpy.supabase.co/storage/v1/object/public/sales_receipts/logo_werbung%20(1).png";

// Desktop Sidebar Item
const SidebarItem = ({ icon: Icon, label, id, active, onClick }: any) => (
  <button
    onClick={() => onClick(id)}
    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 group ${
      active
        ? 'bg-primary-600/20 text-primary-500 border border-primary-600/30'
        : 'text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-900 hover:text-slate-900 dark:hover:text-zinc-100'
    }`}
  >
    <Icon size={20} className={active ? 'text-primary-500' : 'text-slate-400 dark:text-zinc-500 group-hover:text-slate-700 dark:group-hover:text-zinc-300'} />
    <span className="font-medium text-sm">{label}</span>
  </button>
);

// Mobile Bottom Nav Item
const MobileNavItem = ({ icon: Icon, label, id, active, onClick }: any) => (
  <button
    onClick={() => onClick(id)}
    className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition-all active:scale-90 ${
      active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300'
    }`}
  >
    <Icon size={18} strokeWidth={active ? 2.5 : 2} />
    <span className={`text-[9px] font-bold tracking-tight truncate max-w-full px-0.5 ${active ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-zinc-600'}`}>
      {label}
    </span>
  </button>
);

const Layout: React.FC<LayoutProps> = ({ children, activeTab, setActiveTab, userId, userRole, userName, userAvatar, userEmail, onLogout }) => {
  const { t, language, setLanguage } = useLanguage();
  const { theme, setTheme, toggleTheme } = useTheme();

  const isAdmin = userRole.includes('Admin');

  // Mobile klavye açık mı? Açıksa bottom nav'ı gizle (mesaj yazarken,
  // arama yaparken vs. nav klavyenin üstünde durmasın). VisualViewport
  // API kullanır — klavye viewport.height'i küçültür, innerHeight ile
  // farkı kontrol ederiz. Eşik: 150px (klavye genelde 250-350px).
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const diff = window.innerHeight - vv.height;
      setKeyboardOpen(diff > 150);
    };
    vv.addEventListener('resize', onResize);
    onResize();
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  return (
    <div className="app-shell relative w-full bg-slate-50 dark:bg-zinc-950 text-slate-900 dark:text-zinc-200 font-sans overflow-hidden flex flex-col md:flex-row">

      {/* --- MOBILE HEADER (Visible only on mobile) --- */}
      <header className="md:hidden h-[calc(4rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] bg-white dark:bg-zinc-950 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between px-3 shrink-0 z-30 relative shadow-sm">
          <div
            className="flex items-center gap-2 min-w-0"
            onClick={() => setActiveTab('dashboard')}
          >
              <div className="w-12 h-9 rounded-lg bg-white border border-slate-200 dark:border-zinc-800 flex items-center justify-center shadow-lg shadow-indigo-500/10 dark:shadow-indigo-900/10 shrink-0 px-1 py-0.5">
                 <img src={BAC_LOGO_URL} alt="2MC Werbung Logo" className="max-w-full max-h-full object-contain" referrerPolicy="no-referrer" />
              </div>
              {/* 2MC kısa logo başlığı — logo ile uyumlu indigo */}
              <h1 className="hidden xs:block text-base font-bold bg-gradient-to-r from-indigo-700 to-indigo-900 dark:from-white dark:to-zinc-400 bg-clip-text text-transparent truncate">
                2MC
              </h1>
          </div>

          <div className="flex items-center gap-1">
              <button
                onClick={() => setLanguage(language === 'tr' ? 'de' : 'tr')}
                className="flex items-center justify-center h-8 px-1.5 bg-slate-100 dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-lg text-[11px] font-bold text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                  {language === 'tr' ? '🇹🇷' : '🇩🇪'}
              </button>
              <button
                onClick={toggleTheme}
                className="flex items-center justify-center h-8 w-8 bg-slate-100 dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white transition-colors"
                title={theme === 'dark' ? t('set.themeLight') : t('set.themeDark')}
                aria-label={theme === 'dark' ? t('set.themeLight') : t('set.themeDark')}
              >
                  {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              </button>
              {isAdmin && (
                <button
                  onClick={() => setActiveTab('loss-control')}
                  className={`flex items-center justify-center h-8 w-8 rounded-lg border transition-colors ${
                    activeTab === 'loss-control'
                      ? 'bg-red-100 dark:bg-red-600/20 text-red-600 dark:text-red-400 border-red-300 dark:border-red-600/40'
                      : 'bg-slate-100 dark:bg-zinc-900/50 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:text-red-600 dark:hover:text-red-400'
                  }`}
                  title={canAccessLossControl(userEmail) ? t('nav.lossControl') : t('nav.stock')}
                >
                  <ShieldAlert size={16} />
                </button>
              )}
              {canSeeMap(userEmail, userRole) && (
                <button
                  onClick={() => setActiveTab('map')}
                  className={`flex items-center justify-center h-8 w-8 rounded-lg border transition-colors ${
                    activeTab === 'map'
                      ? 'bg-indigo-100 dark:bg-indigo-600/20 text-indigo-600 dark:text-indigo-400 border-indigo-300 dark:border-indigo-600/40'
                      : 'bg-slate-100 dark:bg-zinc-900/50 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:text-indigo-600 dark:hover:text-indigo-400'
                  }`}
                  title={t('nav.map')}
                >
                  <MapIcon size={16} />
                </button>
              )}
              {isAdmin && canSeeDeviceInfo(userEmail) && (
                <button
                  onClick={() => setActiveTab('device-brands')}
                  className={`flex items-center justify-center h-8 w-8 rounded-lg border transition-colors ${
                    activeTab === 'device-brands'
                      ? 'bg-cyan-100 dark:bg-cyan-600/20 text-cyan-600 dark:text-cyan-400 border-cyan-300 dark:border-cyan-600/40'
                      : 'bg-slate-100 dark:bg-zinc-900/50 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:text-cyan-600 dark:hover:text-cyan-400'
                  }`}
                  title={t('nav.deviceBrands')}
                >
                  <Smartphone size={16} />
                </button>
              )}
              <NotificationCenter currentUserId={userId} currentUserEmail={userEmail} onNavigate={setActiveTab} />
              <button
                onClick={() => setActiveTab('settings')}
                className={`p-1.5 rounded-full transition-colors ${activeTab === 'settings' ? 'bg-slate-200 dark:bg-zinc-800 text-slate-900 dark:text-white' : 'text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white'}`}
              >
                  <SettingsIcon size={18} />
              </button>
              <button
                onClick={onLogout}
                className="p-1.5 text-slate-600 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
              >
                  <LogOut size={18} />
              </button>
          </div>
      </header>

      {/* --- DESKTOP SIDEBAR (Hidden on mobile) --- */}
      <div className="hidden md:flex z-40 h-full w-64 bg-white dark:bg-zinc-950 border-r border-slate-200 dark:border-zinc-800 flex-col transition-all duration-300">
        <div className="p-6 border-b border-slate-200 dark:border-zinc-900/50 flex items-center gap-3 relative">
          <div
            className="cursor-pointer group flex items-center gap-3 flex-1 min-w-0"
            onClick={() => setActiveTab('dashboard')}
            title={t('layout.backToHome')}
          >
            <div className="w-14 h-12 rounded-xl bg-white border border-slate-200 dark:border-zinc-800 flex items-center justify-center shadow-lg shadow-indigo-500/10 dark:shadow-indigo-900/20 group-hover:scale-105 transition-transform px-1.5 py-1">
               <img src={BAC_LOGO_URL} alt="2MC Werbung Logo" className="max-w-full max-h-full object-contain" referrerPolicy="no-referrer" />
            </div>
            <div className="min-w-0">
              {/* 2MC Werbung başlığı — logo ile uyumlu indigo gradient (her tema) */}
              <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-700 to-indigo-900 dark:from-blue-400 dark:to-indigo-600 bg-clip-text text-transparent group-hover:opacity-80 transition-opacity">
                  2MC Werbung
              </h1>
              <p className="text-[10px] text-slate-500 dark:text-zinc-500 mt-0.5">{t('layout.subtitle')}</p>
            </div>
          </div>
          <NotificationCenter currentUserId={userId} currentUserEmail={userEmail} onNavigate={setActiveTab} />
        </div>

        <nav className="flex-1 px-4 py-6 space-y-2 overflow-y-auto custom-scrollbar">
          <SidebarItem icon={LayoutDashboard} label={t('nav.dashboard')} id="dashboard" active={activeTab === 'dashboard'} onClick={setActiveTab} />
          <SidebarItem icon={MessageSquare} label={t('nav.messages')} id="messages" active={activeTab === 'messages'} onClick={setActiveTab} />
          <SidebarItem icon={CalendarIcon} label={t('nav.calendar')} id="calendar" active={activeTab === 'calendar'} onClick={setActiveTab} />
          <SidebarItem icon={Table} label={t('nav.shifts')} id="shifts" active={activeTab === 'shifts'} onClick={setActiveTab} />
          <SidebarItem icon={CheckSquare} label={t('nav.tasks')} id="tasks" active={activeTab === 'tasks'} onClick={setActiveTab} />
          <SidebarItem icon={ShoppingBag} label={t('nav.sales')} id="sales" active={activeTab === 'sales'} onClick={setActiveTab} />
          <SidebarItem icon={Users} label={t('nav.payroll')} id="payroll" active={activeTab === 'payroll'} onClick={setActiveTab} />
          {canSeeMap(userEmail, userRole) && (
            <SidebarItem icon={MapIcon} label={t('nav.map')} id="map" active={activeTab === 'map'} onClick={setActiveTab} />
          )}
          {isAdmin && canSeeDeviceInfo(userEmail) && (
            <SidebarItem icon={Smartphone} label={t('nav.deviceBrands')} id="device-brands" active={activeTab === 'device-brands'} onClick={setActiveTab} />
          )}
          <div className="pt-4 mt-4 border-t border-slate-200 dark:border-zinc-900">
             <SidebarItem icon={SettingsIcon} label={t('nav.settings')} id="settings" active={activeTab === 'settings'} onClick={setActiveTab} />
          </div>
        </nav>

        <div className="mt-auto">
            {isAdmin && (
              <div className="px-4 pb-2">
                <button
                  onClick={() => setActiveTab('loss-control')}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-bold transition-all border ${
                    activeTab === 'loss-control'
                      ? 'bg-red-100 dark:bg-red-600/20 text-red-600 dark:text-red-400 border-red-300 dark:border-red-600/40'
                      : 'bg-slate-50 dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:text-red-600 dark:hover:text-red-400 hover:border-red-300 dark:hover:border-red-600/30'
                  }`}
                >
                  <ShieldAlert size={16} />
                  <span>{canAccessLossControl(userEmail) ? t('nav.lossControl') : t('nav.stock')}</span>
                </button>
              </div>
            )}
            <div className="px-4 pb-2">
                <div className="flex bg-slate-50 dark:bg-zinc-900 rounded-lg p-1 border border-slate-200 dark:border-zinc-800">
                    <button
                        onClick={() => setLanguage('tr')}
                        className={`flex-1 py-1.5 text-xs font-bold rounded transition-all ${language === 'tr' ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300'}`}
                    >
                        🇹🇷 TR
                    </button>
                    <button
                        onClick={() => setLanguage('de')}
                        className={`flex-1 py-1.5 text-xs font-bold rounded transition-all ${language === 'de' ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300'}`}
                    >
                        🇩🇪 DE
                    </button>
                </div>
            </div>
            <div className="px-4 pb-4">
                <div className="flex bg-slate-50 dark:bg-zinc-900 rounded-lg p-1 border border-slate-200 dark:border-zinc-800">
                    <button
                        onClick={() => setTheme('dark')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded transition-all ${theme === 'dark' ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300'}`}
                    >
                        <Moon size={12} /> {t('set.themeDark')}
                    </button>
                    <button
                        onClick={() => setTheme('light')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded transition-all ${theme === 'light' ? 'bg-white dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-zinc-300'}`}
                    >
                        <Sun size={12} /> {t('set.themeLight')}
                    </button>
                </div>
            </div>

            <div className="p-4 border-t border-slate-200 dark:border-zinc-900/50 bg-slate-50/50 dark:bg-zinc-900/20">
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/50 border border-indigo-300 dark:border-indigo-500/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400 overflow-hidden">
                {userAvatar ? (
                    <img src={userAvatar} className="w-full h-full object-cover" alt="User" referrerPolicy="no-referrer" />
                ) : (
                    <User size={20} />
                )}
                </div>
                <div className="flex-1 overflow-hidden">
                <p className="text-sm font-medium text-slate-900 dark:text-white truncate" title={userName}>{userName}</p>
                <p className="text-xs text-slate-500 dark:text-zinc-500 uppercase">{userRole}</p>
                </div>
                <button onClick={onLogout} className="text-slate-500 dark:text-zinc-500 hover:text-red-600 dark:hover:text-red-400 transition-colors" title={t('nav.logout')}>
                <LogOut size={18} />
                </button>
            </div>
            </div>
        </div>
      </div>

      {/* --- MAIN CONTENT AREA --- */}
      <main
        className="flex-1 relative overflow-hidden min-h-0 flex flex-col md:pb-0"
      >
         <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
             <div className="absolute top-[-20%] right-[-10%] w-[500px] h-[500px] bg-indigo-500/5 dark:bg-indigo-900/10 rounded-full blur-3xl"></div>
             <div className="absolute bottom-[-10%] left-[-10%] w-[600px] h-[600px] bg-blue-500/5 dark:bg-blue-900/5 rounded-full blur-3xl"></div>
         </div>

         <div className="relative h-full flex flex-col">
            {children}
         </div>
      </main>

      {/* --- WHATSAPP DESTEK FAB ---
          - Her ekranda görünür (admin + personel).
          - Mobilde: bottom-nav var (16h + safe-area). FAB onun üstüne otururken
            klavye açıkken nav gibi gizlenir.
          - Messages sekmesinde: yazma alanını kapatmasın diye gizlenir.
          - Tıklayınca: +90 532 496 14 12 WhatsApp sohbeti, hazır mesajla açılır. */}
      <a
        href={SUPPORT_WHATSAPP_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('support.whatsappAria')}
        title={t('support.whatsappTitle')}
        className={`whatsapp-fab fixed right-4 md:right-6 z-[60] flex items-center justify-center w-14 h-14 rounded-full bg-emerald-500 hover:bg-emerald-400 text-white shadow-lg shadow-emerald-900/40 ring-4 ring-emerald-500/15 transition-all active:scale-90 ${
          activeTab === 'messages' || keyboardOpen ? 'opacity-0 pointer-events-none translate-y-2' : 'opacity-100'
        }`}
      >
        <MessageCircle size={26} strokeWidth={2.2} />
        <span className="sr-only">WhatsApp</span>
      </a>

      {/* --- MOBILE BOTTOM NAVIGATION ---
          - paddingBottom env() Apple'da homebar boşluğunu, Samsung/diğerlerinde
            12px varsayılan boşluğu garanti eder.
          - Mesajlar sekmesindeyken nav komple gizlenir (yazma alanı kapanmasın).
          - Diğer sekmelerde klavye açılınca nav fade-out olur (VisualViewport).
          - Bazı cihazlarda VisualViewport sinyali güvenilmez olduğundan
            mesajlar için ayrı sabit bir gizleme kuralı kullanıyoruz. */}
      <div
        className={`md:hidden fixed bottom-0 left-0 right-0 z-50 px-4 pb-3 pointer-events-none transition-all duration-200 ${
          activeTab === 'messages' || keyboardOpen
            ? 'opacity-0 translate-y-full pointer-events-none'
            : 'opacity-100 translate-y-0'
        }`}
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
        aria-hidden={activeTab === 'messages' || keyboardOpen}
      >
        <nav className="w-full h-16 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xl border border-slate-200/80 dark:border-zinc-800/60 rounded-2xl flex justify-around items-center px-1 shadow-[0_8px_30px_rgba(15,23,42,0.08)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] pointer-events-auto">
            <MobileNavItem icon={LayoutDashboard} label={t('nav.dashboard')} id="dashboard" active={activeTab === 'dashboard'} onClick={setActiveTab} />
            <MobileNavItem icon={CalendarIcon} label={t('nav.calendar')} id="calendar" active={activeTab === 'calendar'} onClick={setActiveTab} />
            <MobileNavItem icon={ShoppingBag} label={t('nav.sales')} id="sales" active={activeTab === 'sales'} onClick={setActiveTab} />
            <MobileNavItem icon={Table} label={t('nav.shifts')} id="shifts" active={activeTab === 'shifts'} onClick={setActiveTab} />
            <MobileNavItem icon={CheckSquare} label={t('nav.tasks')} id="tasks" active={activeTab === 'tasks'} onClick={setActiveTab} />
            <MobileNavItem icon={Users} label={t('nav.payroll')} id="payroll" active={activeTab === 'payroll'} onClick={setActiveTab} />
        </nav>
      </div>

    </div>
  );
};

export default Layout;
