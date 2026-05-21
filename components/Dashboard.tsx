import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { lazyWithRetry } from '../lib/lazyWithRetry';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, BarChart, Bar, Legend, Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis } from 'recharts';
import { Bell, TrendingUp, Users, Clock, AlertCircle, Sparkles, CheckCircle2, Zap, Target, ArrowUpRight, Activity, ArrowRightLeft, Briefcase, CalendarCheck, Medal, AlertTriangle, DollarSign, MapPin, Coffee, Wallet, Timer, Filter, BarChart3, ListTodo, CheckSquare, PlusCircle, MessageSquare, ChevronRight, User, ShoppingBag, AlertOctagon, Tag, Trophy, Award, Upload, Loader2, QrCode, X } from 'lucide-react';
import { AppNotification, Employee, Role, CalendarEvent, Branch, Task, Message, SalesLog } from '../types';
import { isDualRoleAdmin } from '../constants';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { GlowingEffect } from './ui/glowing-effect';
import { fetchShiftsForDate, ShiftWithStatus, STATUS_META } from '../lib/shiftStatus';

// QR scanner lazy: zxing/browser top-level import prod minify'da bozuluyor
// lazyWithRetry: yeni deployment sonrası eski hash'li chunk için MIME hatasında auto-recover
const QrCheckIn = lazyWithRetry(() => import('./QrCheckIn'));


interface DashboardProps {
    notifications?: AppNotification[];
    currentUser: Employee;
    onUpdateUser?: (user: Employee) => void;
}

// Sci-fi dark palette (Panel sekmesinde dark modda devrede; light modda
// index.html'deki BAC marka kırmızı/beyaz override'ları zaten geçerli).
const COLORS = ['#22d3ee', '#06b6d4', '#67e8f9', '#a78bfa', '#f472b6'];
const STATUS_COLORS = {
    todo: '#475569',         // slate-600 (sci-fi muted)
    in_progress: '#22d3ee',  // cyan-400
    done: '#10b981',         // emerald-500
};
// Recharts dark grid/axis renkleri — koyu lacivert palet
const SCIFI_GRID    = '#1e293b';
const SCIFI_AXIS    = '#64748b';
const SCIFI_LABEL   = '#94a3b8';
const SCIFI_TOOLTIP = { backgroundColor: 'rgba(5, 10, 26, 0.95)', border: '1px solid rgba(34, 211, 238, 0.3)', borderRadius: '8px', color: '#e2e8f0', boxShadow: '0 0 24px rgba(6, 182, 212, 0.2)' };

// Helper function for relative time
const getRelativeTime = (dateString: string, lang: 'tr' | 'de' = 'tr') => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    const isDe = lang === 'de';

    if (diffInSeconds < 60) return isDe ? 'Jetzt' : 'Şimdi';
    const minutes = Math.floor(diffInSeconds / 60);
    if (minutes < 60) return isDe ? `vor ${minutes} Min` : `${minutes} dk önce`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return isDe ? `vor ${hours} Std` : `${hours} saat önce`;
    const days = Math.floor(hours / 24);
    if (days < 7) return isDe ? `vor ${days} Tagen` : `${days} gün önce`;
    return date.toLocaleDateString(isDe ? 'de-DE' : 'tr-TR', { day: 'numeric', month: 'short' });
};

const Dashboard: React.FC<DashboardProps> = ({ notifications = [], currentUser, onUpdateUser }) => {
  const [activeTransferEvent, setActiveTransferEvent] = useState<CalendarEvent | null>(null);
  const [showQrModal, setShowQrModal] = useState(false);
  
  // Real Data States
  const [dashboardTasks, setDashboardTasks] = useState<Task[]>([]);
  const [dashboardEmployees, setDashboardEmployees] = useState<Employee[]>([]);
  const [salesLogs, setSalesLogs] = useState<SalesLog[]>([]); // NEW for Leaderboard
  
  // NEW STATES FOR REQUESTED FEATURES
  const [recentTransfers, setRecentTransfers] = useState<CalendarEvent[]>([]);
  const [recentMessages, setRecentMessages] = useState<Message[]>([]);
  
  // NEW: Filter State for Admin Chart
  const [timeFilter, setTimeFilter] = useState<'WEEKLY' | 'MONTHLY'>('WEEKLY');

  // NEW: Operasyon KPI state'leri (modern admin paneli için)
  const [todayCheckInsCount, setTodayCheckInsCount] = useState<number>(0);
  const [weekPlannedHours, setWeekPlannedHours] = useState<number>(0);
  const [upcomingShifts, setUpcomingShifts] = useState<Array<ShiftWithStatus & { isToday: boolean; avatarUrl?: string }>>([]);

  // Avatar Upload State
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !currentUser) return;

      setIsUploadingAvatar(true);
      try {
          const fileExt = file.name.split('.').pop();
          const fileName = `${currentUser.id}-${Math.random()}.${fileExt}`;
          const filePath = `${fileName}`;

          const { error: uploadError } = await supabase.storage
              .from('avatars')
              .upload(filePath, file);

          if (uploadError) throw uploadError;

          const { data } = supabase.storage
              .from('avatars')
              .getPublicUrl(filePath);

          const newAvatarUrl = data.publicUrl;

          // Delete old avatar if it exists and is from supabase storage
          if (currentUser.avatarUrl && currentUser.avatarUrl.includes('/storage/v1/object/public/avatars/')) {
              try {
                  const oldFileName = currentUser.avatarUrl.split('/avatars/').pop();
                  if (oldFileName) {
                      await supabase.storage.from('avatars').remove([oldFileName]);
                  }
              } catch (e) {
                  console.error('Eski fotoğraf silinirken hata oluştu:', e);
              }
          }

          const { error: updateError } = await supabase
              .from('profiles')
              .update({ avatar_url: newAvatarUrl })
              .eq('id', currentUser.id);

          if (updateError) throw updateError;

          if (onUpdateUser) {
              onUpdateUser({ ...currentUser, avatarUrl: newAvatarUrl });
          }
          alert(t('dash.avatarSuccess'));
      } catch (error) {
          console.error('Error uploading avatar:', error);
          alert(t('dash.avatarError'));
      } finally {
          setIsUploadingAvatar(false);
      }
  };
  
  const { t, formatDate, language } = useLanguage();
  const { theme } = useTheme();
  // Recharts tema-aware palet — class override SVG fill'lere işlemiyor
  const isDark = theme === 'dark';
  const chartBarPrimary    = isDark ? '#22d3ee' : '#262870'; // cyan / 2MC indigo
  const chartBarSecondary  = isDark ? '#0e7490' : '#a8c6e8'; // cyan-700 / brand açık mavi
  const chartGridStroke    = isDark ? '#1e293b' : '#e8f0fa';
  const chartAxisStroke    = isDark ? '#64748b' : '#a47480';
  const chartCursorFill    = isDark ? 'rgba(34, 211, 238, 0.08)' : 'rgba(221, 45, 74, 0.06)';
  const chartTooltipStyle  = isDark
    ? { backgroundColor: 'rgba(5, 10, 26, 0.95)', border: '1px solid rgba(34, 211, 238, 0.3)', borderRadius: '8px', color: '#e2e8f0', boxShadow: '0 0 24px rgba(6, 182, 212, 0.2)' }
    : { backgroundColor: '#ffffff', border: '1px solid #ffe4e9', borderRadius: '8px', color: '#1a0a0e', boxShadow: '0 4px 16px rgba(136, 13, 30, 0.08)' };

  // Tüm adminler aynı paneli görür

  // DATA FILTERING
  // Aktif Görevler (Tamamlanmamışlar)
  const pendingTasks = dashboardTasks.filter(t => t.status !== 'done');
  const highPriorityTasks = pendingTasks.filter(t => t.priority === 'Yüksek');
  
  // Specific Data for Staff
  // Personel için sadece aktif görevler
  const myTasks = dashboardTasks.filter(t => t.assignedTo.includes(currentUser.id) && t.status !== 'done');
  // Personel için tüm görevler (İstatistik için)
  const myTotalTasks = dashboardTasks.filter(t => t.assignedTo.includes(currentUser.id));
  
  // Calculate Overall Completion Rate (Success Metric)
  const totalTasks = dashboardTasks.length;
  const completedTasksCount = dashboardTasks.filter(t => t.status === 'done').length;
  // Oran hesabı: Tamamlanan / Toplam (Eğer hiç görev yoksa 0)
  const completionRate = totalTasks > 0 ? Math.round((completedTasksCount / totalTasks) * 100) : 0;

  // Staff Specific Rate
  const myCompletedCount = myTotalTasks.filter(t => t.status === 'done').length;
  const myCompletionRate = myTotalTasks.length > 0 ? Math.round((myCompletedCount / myTotalTasks.length) * 100) : 0;

  // Filter Notifications
  const filteredNotifications = notifications.filter(n => {
      if (!n.recipientId || n.recipientId === 'ALL') return true;
      return n.recipientId === currentUser.id;
  });

  // ADMIN MESAJI BİLDİRİMİNİ BUL (En sonuncusu)
  const adminMessageAlert = filteredNotifications.find(n => n.title === t('dash.adminAlert'));

  // --- FETCH & REALTIME SUBSCRIPTION ---
  useEffect(() => {
      fetchDashboardData();

      // Subscribe to Realtime Changes
      const channels = supabase.channel('dashboard-realtime')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
              fetchDashboardData(); // Refresh tasks
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
               fetchDashboardData(); // Refresh employees/profiles
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_events' }, () => {
              fetchDashboardData(); // Refresh transfers (General)
              checkTransfers(); // Refresh personal active transfer
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
              fetchDashboardData(); // Refresh messages
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_logs' }, () => {
              fetchDashboardData(); // Refresh sales leaderboard
          })
          .subscribe();

      return () => {
          supabase.removeChannel(channels);
      };
  }, [currentUser]); // Re-subscribe if user changes

  const fetchDashboardData = async () => {
      // 1. Fetch Tasks
      const { data: taskData } = await supabase.from('tasks').select('*');
      
      if (taskData && taskData.length > 0) {
          const formattedTasks: Task[] = taskData.map((t: any) => ({
              id: t.id,
              title: t.title,
              description: t.description,
              assignedTo: t.assigned_to || [],
              dueDate: t.due_date,
              priority: t.priority,
              status: t.status,
              progress: t.progress,
              checklist: t.checklist || [],
              completedAt: t.completed_at
          }));
          setDashboardTasks(formattedTasks);
      } else {
          setDashboardTasks([]); // Real data only
      }

      // 2. Fetch Employees (Filter out Admins from Dashboard Stats)
      const { data: empData } = await supabase.from('profiles').select('*');
      
      let allEmployees: Employee[] = [];
      if (empData && empData.length > 0) {
          allEmployees = empData.map((e: any) => ({
              id: e.id,
              name: e.full_name,
              email: e.email,
              role: e.role as Role,
              branch: e.branch as Branch,
              hourlyRate: e.hourly_rate,
              taxClass: e.tax_class,
              avatarUrl: e.avatar_url || `https://ui-avatars.com/api/?name=${e.full_name}`,
              advances: 0,
              phone: e.phone,
              bio: e.bio,
          }));
          // KURAL: Adminleri dashboard listelerinden ve grafiklerinden çıkar
          // İstisna: Çift rollü adminler (Apo, Malik) personel listesinde kalır.
          const staffOnly = allEmployees.filter(e => e.role !== Role.ADMIN || isDualRoleAdmin(e));
          // Çift kayıtları tek say: email varsa email'e, yoksa normalize edilmiş isme göre dedupe et.
          const seen = new Set<string>();
          const deduped = staffOnly.filter(e => {
              const key = (e.email?.trim().toLowerCase())
                  || (e.name?.trim().toLowerCase().replace(/\s+/g, ' '))
                  || e.id;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
          });
          setDashboardEmployees(deduped);
      } else {
          setDashboardEmployees([]);
      }
      
      checkTransfers();

      // 3. Fetch Recent Transfers from personnel_transfers (ONLY ACTIVE/FUTURE)
      const today = new Date().toISOString().split('T')[0];

      let transferQuery = supabase
          .from('personnel_transfers')
          .select('*')
          .eq('status', 'active')
          .gte('end_date', today)
          .order('start_date', { ascending: true })
          .limit(5);

      // KURAL: Eğer Admin değilse, sadece kendi transferlerini görsün.
      if (currentUser.role !== Role.ADMIN) {
          transferQuery = transferQuery.eq('employee_id', currentUser.id);
      }

      const { data: transferData } = await transferQuery;

      if(transferData) {
          // CalendarEvent formatına dönüştür (mevcut UI uyumluluğu için)
          const formattedTransfers: CalendarEvent[] = transferData.map((t: any) => ({
              id: t.id,
              title: `${t.from_branch} -> ${t.to_branch}`,
              type: 'Şube Transferi' as const,
              date: t.start_date,
              endDate: t.end_date,
              startTime: t.start_time || '08:00',
              endTime: t.end_time || '18:00',
              attendees: [t.employee_id],
              description: `Transfer: ${t.from_branch} -> ${t.to_branch}`
          }));
          setRecentTransfers(formattedTransfers);
      } else {
          setRecentTransfers([]);
      }

      // 4. Fetch Recent Messages (For User)
      let msgQuery = supabase.from('messages').select('*').order('timestamp', { ascending: false }).limit(5);
      if (currentUser.role === Role.ADMIN) {
          msgQuery = msgQuery.or(`receiver_id.eq.${currentUser.id},receiver_id.eq.ALL,receiver_id.eq.ADMIN_BOARD`);
      } else {
          msgQuery = msgQuery.or(`receiver_id.eq.${currentUser.id},receiver_id.eq.ALL`);
      }
      
      const { data: msgData } = await msgQuery;
      if (msgData) {
          const formattedMessages: Message[] = msgData.map((m: any) => ({
              id: m.id,
              senderId: m.sender_id,
              receiverId: m.receiver_id,
              subject: m.subject,
              content: m.content,
              timestamp: m.timestamp,
              read: m.read
          }));
          setRecentMessages(formattedMessages);
      }

      // 5. Fetch Sales Logs (For Leaderboard) - Fetch Current Month
      const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
      const { data: salesData } = await supabase.from('sales_logs').select('*').gte('sale_date', startOfMonth);

      // 6. Bugün QR/Manuel ile giriş yapan benzersiz personel sayısı
      try {
        const todayStr = new Date().toISOString().split('T')[0];
        const { data: logsToday } = await supabase
            .from('time_logs')
            .select('employee_id, check_in_at')
            .eq('date', todayStr)
            .not('check_in_at', 'is', null);
        if (logsToday) {
          const uniq = new Set(logsToday.map((r: any) => r.employee_id));
          setTodayCheckInsCount(uniq.size);
        }
      } catch { /* tablo yoksa sessizce geç */ }

      // 7. Bu haftaki vardiya planı toplam saat + yaklaşan vardiyalar (bugün/yarın)
      try {
        // Pazartesi 00:00 — haftanın ilk günü
        const now = new Date();
        const day = now.getDay() || 7;
        const monday = new Date(now);
        if (day !== 1) monday.setHours(-24 * (day - 1));
        monday.setHours(0, 0, 0, 0);
        const weekKey = monday.toISOString().split('T')[0];

        const { data: shiftRows } = await supabase
            .from('shift_schedules')
            .select('*')
            .eq('week_start_date', weekKey);

        if (shiftRows) {
          // Toplam planlı saat = time_slot süresi × gün başına atanan personel sayısı
          let totalHours = 0;
          for (const row of shiftRows) {
            const slot = String(row.time_slot || '');
            const m = slot.match(/(\d{1,2})(?::(\d{2}))?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?/);
            if (!m) continue;
            const sH = parseInt(m[1], 10), sM = m[2] ? parseInt(m[2], 10) : 0;
            const eH = parseInt(m[3], 10), eM = m[4] ? parseInt(m[4], 10) : 0;
            let mins = (eH * 60 + eM) - (sH * 60 + sM);
            if (mins < 0) mins += 24 * 60;
            const hours = mins / 60;
            const days: any[] = row.days || [];
            days.forEach((cell) => {
              if (!cell) return;
              const empIds = String(cell).split(',').map(s => s.trim()).filter(Boolean);
              totalHours += hours * empIds.length;
            });
          }
          setWeekPlannedHours(Math.round(totalHours));
        }

        // Bugün + yarın vardiyalarını QR durumu ile birlikte çek
        const todayDate = new Date();
        const tomorrowDate = new Date(todayDate);
        tomorrowDate.setDate(tomorrowDate.getDate() + 1);
        const [todayShifts, tomorrowShifts] = await Promise.all([
          fetchShiftsForDate(todayDate),
          fetchShiftsForDate(tomorrowDate),
        ]);
        const todayYmd = todayDate.toISOString().split('T')[0];
        const merged: typeof upcomingShifts = [];
        const seen = new Set<string>();
        const push = (s: ShiftWithStatus, isToday: boolean) => {
          const key = `${s.employeeId}-${s.shiftStartIso}`;
          if (seen.has(key)) return;
          seen.add(key);
          const emp = allEmployees.find(e => e.id === s.employeeId);
          merged.push({ ...s, isToday, avatarUrl: emp?.avatarUrl });
        };
        todayShifts.forEach(s => push(s, true));
        tomorrowShifts.forEach(s => push(s, s.shiftStartIso.slice(0, 10) === todayYmd));
        merged.sort((a, b) => a.shiftStartIso.localeCompare(b.shiftStartIso));
        setUpcomingShifts(merged.slice(0, 12));
      } catch { /* tablo yoksa sessizce geç */ }
      if(salesData) {
          setSalesLogs(salesData.map((s:any) => ({
              id: s.id, employeeId: s.employee_id, branch: s.branch, productName: s.product_name,
              quantity: s.quantity, saleDate: s.sale_date, status: s.status, createdAt: s.created_at
          })));
      }
  };

  const checkTransfers = async () => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const { data, error } = await supabase
            .from('personnel_transfers')
            .select('*')
            .eq('employee_id', currentUser.id)
            .eq('status', 'active')
            .lte('start_date', today)
            .gte('end_date', today)
            .limit(1);

        if (!error && data && data.length > 0) {
            const t = data[0];
            setActiveTransferEvent({
                id: t.id,
                title: `${t.from_branch} -> ${t.to_branch}`,
                type: 'Şube Transferi',
                date: t.start_date,
                endDate: t.end_date,
                startTime: t.start_time || '08:00',
                endTime: t.end_time || '18:00',
                attendees: [t.employee_id],
                description: `Transfer: ${t.from_branch} -> ${t.to_branch}`
            });
        } else {
            setActiveTransferEvent(null);
        }
    } catch (e) {
        console.log("Error checking transfers:", e);
    }
  };

  // --- CHART DATA GENERATION ---

  // 1. Admin: Branch Performance Data (Updated for Weekly/Monthly)
  const branchPerformanceData = useMemo(() => {
      const branches = Object.values(Branch);
      const now = new Date();
      
      // Determine Start Date based on Filter
      const startDate = new Date();
      if (timeFilter === 'WEEKLY') {
          // Get Monday of current week
          const day = now.getDay() || 7; // Sunday is 0, make it 7
          if(day !== 1) startDate.setHours(-24 * (day - 1));
          startDate.setHours(0,0,0,0);
      } else {
          // Get 1st of current month
          startDate.setDate(1);
          startDate.setHours(0,0,0,0);
      }

      // Use dashboardEmployees (already filtered for STAFF ONLY)
      const empsToUse = dashboardEmployees;
      const tasksToUse = dashboardTasks;

      return branches.map(branch => {
          // Find employees in this branch
          const branchEmpIds = empsToUse.filter(e => e.branch === branch).map(e => e.id);
          
          // Filter tasks assigned to this branch
          const branchTasks = tasksToUse.filter(t => t.assignedTo.some(id => branchEmpIds.includes(id)));
          
          // Filter completed tasks within the selected period
          const completedInPeriod = branchTasks.filter(t => {
             if (t.status !== 'done') return false;
             if (!t.completedAt) return false; // If no date, ignore
             return new Date(t.completedAt) >= startDate;
          }).length;

          // Active tasks are snapshot of "now", so we just count them
          const activeTotal = branchTasks.filter(t => t.status !== 'done').length;
          
          const totalInView = completedInPeriod + activeTotal;
          const rate = totalInView > 0 ? Math.round((completedInPeriod / totalInView) * 100) : 0;
          
          return {
              name: branch,
              tamamlanan: completedInPeriod,
              aktif: activeTotal,
              rate: rate
          };
      });
  }, [timeFilter, dashboardTasks, dashboardEmployees]);

  // 2. Staff: Task Status Distribution (Pie Chart)
  const taskStatusData = useMemo(() => {
      return [
          { name: t('tasks.statusTodo'), value: myTotalTasks.filter(t => t.status === 'todo').length, color: STATUS_COLORS.todo },
          { name: t('tasks.statusProgress'), value: myTotalTasks.filter(t => t.status === 'in_progress').length, color: STATUS_COLORS.in_progress },
          { name: t('tasks.statusDone'), value: myTotalTasks.filter(t => t.status === 'done').length, color: STATUS_COLORS.done },
      ].filter(item => item.value > 0);
  }, [myTotalTasks, t]);

  // 3. Staff: Priority Breakdown (Bar Chart)
  // Sadece aktif görevleri göster ki iş yükü analiz edilsin
  const taskPriorityData = useMemo(() => {
    return [
        { name: t('priority.Düşük'), adet: myTasks.filter(t => t.priority === 'Düşük').length },
        { name: t('priority.Orta'), adet: myTasks.filter(t => t.priority === 'Orta').length },
        { name: t('priority.Yüksek'), adet: myTasks.filter(t => t.priority === 'Yüksek').length },
    ];
  }, [myTasks, t]);




  const navigateTo = (path: string) => {
      window.location.hash = path;
  };

  const getSenderName = (senderId: string) => {
      if (senderId === currentUser.id) return language === 'de' ? 'Ich' : 'Ben';
      if (senderId === 'admin_1') return t('dash.management'); // Fallback
      const emp = dashboardEmployees.find(e => e.id === senderId);
      // Adminler listede olmayabilir, isim bulamazsak 'Yönetici' diyelim
      if (!emp) {
           return t('dash.systemAdmin');
      }
      return emp ? emp.name : 'Sistem';
  };

  // --- RENDER: ADMIN DASHBOARD ---
  if (currentUser.role === Role.ADMIN) {
      return (
        <div
          className="dashboard-scifi h-full w-full p-4 md:p-8 overflow-y-auto custom-scrollbar bg-[#09090b]"
          style={{ paddingBottom: 'calc(5.5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {/* HUD HERO BAND — sci-fi başlık (sadece dark'ta görünür; light'ta sade) */}
          <div className="hidden dark:flex relative items-center justify-center mb-6 mt-2 scifi-scan">
            <div className="absolute left-0 top-1/2 -translate-y-1/2 h-px w-1/3 bg-gradient-to-r from-transparent to-cyan-400/60" />
            <div className="absolute right-0 top-1/2 -translate-y-1/2 h-px w-1/3 bg-gradient-to-l from-transparent to-cyan-400/60" />
            <div className="px-6 py-3 flex items-center gap-3">
              <span className="w-2 h-2 rounded-full bg-cyan-400 scifi-pulse" />
              <span className="text-[10px] md:text-xs font-mono tracking-[0.4em] text-cyan-300/80 uppercase">BAC // Operation Panel</span>
              <span className="w-2 h-2 rounded-full bg-cyan-400 scifi-pulse" />
            </div>
          </div>

          {/* Header Section */}
          <header className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
            <div className="flex justify-between items-start w-full">
                <div className="flex items-center gap-5">
                    <div className="relative group cursor-pointer">
                         <label className="block w-16 h-16 rounded-full p-0.5 bg-gradient-to-br from-indigo-500 to-purple-600 cursor-pointer relative transition-transform group-hover:scale-105">
                            <img src={currentUser.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name)}&background=6366f1&color=fff`} className="w-full h-full rounded-full object-cover border-2 border-[#09090b]" alt="Profile" referrerPolicy="no-referrer" />

                            <div className="absolute inset-0.5 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                {isUploadingAvatar ? <Loader2 size={20} className="text-slate-900 dark:text-white animate-spin" /> : <Upload size={20} className="text-slate-900 dark:text-white" />}
                            </div>

                            <input type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} disabled={isUploadingAvatar} />
                         </label>
                         <div className="absolute bottom-0 right-0 w-5 h-5 bg-green-500 border-4 border-[#09090b] rounded-full z-10" title="Online"></div>
                    </div>
                    <div>
                        <h1 className="text-3xl md:text-4xl font-bold text-slate-900 dark:text-white tracking-tight mb-2">
                            <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">{t('dash.title')}</span>
                            <span className="hidden dark:inline ml-3 text-cyan-300 font-light">// DATA</span>
                        </h1>
                        <div className="flex items-center gap-3">
                            <p className="text-slate-600 dark:text-zinc-400 text-sm flex items-center gap-2">
                                <Activity size={14} className="text-green-500" />
                                {t('dash.subtitle')}
                            </p>
                            <span className="hidden dark:inline-flex items-center gap-1.5 text-[10px] font-mono tracking-widest text-cyan-300/70 px-2 py-0.5 rounded border border-cyan-400/30 bg-cyan-500/5">
                                <span className="w-1 h-1 rounded-full bg-cyan-400 scifi-pulse" />
                                LIVE
                            </span>
                        </div>
                    </div>
                </div>
                {/* Dashboard Quick Access Icons */}
                <div className="flex items-center gap-2">
                    <button 
                        onClick={() => navigateTo('messages')}
                        className="p-3 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl text-indigo-400 hover:text-slate-900 dark:hover:text-white hover:bg-indigo-600/20 transition-all shadow-lg relative group"
                        title={t('nav.messages')}
                    >
                        <MessageSquare size={20} />
                        <span className="absolute -top-1 -right-1 w-3 h-3 bg-indigo-500 rounded-full border-2 border-[#09090b]"></span>
                    </button>
                </div>
            </div>
          </header>

          {/* ==================================================
              KPI ROW — 6'lı kart grid (modern admin paneli)
              Her kart minimal, ikon + sayı + label + ince progress
              ================================================== */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 md:gap-4 mb-6">

              {/* 1. Aktif Personel — DAİMA GÖRÜNÜR */}
              <div onClick={() => navigateTo('payroll')} className="group cursor-pointer rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4 hover:border-blue-300 dark:hover:border-blue-500/40 hover:shadow-md hover:shadow-blue-500/5 transition-all relative">
                  <div className="flex items-center justify-between mb-3">
                      <div className="p-2 rounded-xl bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform">
                          <Users size={18} />
                      </div>
                      <span className="text-[10px] font-bold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-500/10 px-1.5 py-0.5 rounded">+12%</span>
                  </div>
                  <div className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight">{dashboardEmployees.length}</div>
                  <div className="text-[11px] md:text-xs text-slate-500 dark:text-zinc-500 font-medium mt-0.5">{t('dash.activeStaff')}</div>
                  <div className="mt-3 h-1 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: '92%' }}></div>
                  </div>
              </div>

              {/* 2. Bugün İşbaşı */}
              <div className="group rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4 hover:border-emerald-300 dark:hover:border-emerald-500/40 hover:shadow-md hover:shadow-emerald-500/5 transition-all relative">
                  <div className="flex items-center justify-between mb-3">
                      <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 group-hover:scale-110 transition-transform">
                          <CalendarCheck size={18} />
                      </div>
                      <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 rounded">{language === 'de' ? 'Heute' : 'Bugün'}</span>
                  </div>
                  <div className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight">
                      {todayCheckInsCount}
                      <span className="text-sm font-medium text-slate-400 dark:text-zinc-600">/{dashboardEmployees.length}</span>
                  </div>
                  <div className="text-[11px] md:text-xs text-slate-500 dark:text-zinc-500 font-medium mt-0.5">{language === 'de' ? 'Eingecheckt' : 'İşbaşı yapan'}</div>
                  <div className="mt-3 h-1 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${dashboardEmployees.length > 0 ? (todayCheckInsCount / dashboardEmployees.length) * 100 : 0}%` }}></div>
                  </div>
              </div>

              {/* 3. Bu Hafta Planlı Saat */}
              <div onClick={() => navigateTo('shifts')} className="group cursor-pointer rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4 hover:border-cyan-300 dark:hover:border-cyan-500/40 hover:shadow-md hover:shadow-cyan-500/5 transition-all relative">
                  <div className="flex items-center justify-between mb-3">
                      <div className="p-2 rounded-xl bg-cyan-50 dark:bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 group-hover:scale-110 transition-transform">
                          <Clock size={18} />
                      </div>
                      <span className="text-[10px] font-bold text-cyan-700 dark:text-cyan-300 bg-cyan-50 dark:bg-cyan-500/10 px-1.5 py-0.5 rounded">{language === 'de' ? 'Woche' : 'Hafta'}</span>
                  </div>
                  <div className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight">
                      {weekPlannedHours}<span className="text-sm font-medium text-slate-400 dark:text-zinc-600 ml-1">sa</span>
                  </div>
                  <div className="text-[11px] md:text-xs text-slate-500 dark:text-zinc-500 font-medium mt-0.5">{language === 'de' ? 'Geplante Std.' : 'Planlı saat'}</div>
                  <div className="mt-3 h-1 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-cyan-500 rounded-full" style={{ width: weekPlannedHours > 0 ? '100%' : '0%' }}></div>
                  </div>
              </div>

              {/* 4. Aktif Görev */}
              <div onClick={() => navigateTo('tasks')} className="group cursor-pointer rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4 hover:border-indigo-300 dark:hover:border-indigo-500/40 hover:shadow-md hover:shadow-indigo-500/5 transition-all relative">
                  <div className="flex items-center justify-between mb-3">
                      <div className="p-2 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 group-hover:scale-110 transition-transform">
                          <ListTodo size={18} />
                      </div>
                      <span className="text-[10px] font-bold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-500/10 px-1.5 py-0.5 rounded">{language === 'de' ? 'Aktiv' : 'Aktif'}</span>
                  </div>
                  <div className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight">{pendingTasks.length}</div>
                  <div className="text-[11px] md:text-xs text-slate-500 dark:text-zinc-500 font-medium mt-0.5">{t('dash.totalTasks')}</div>
                  <div className="mt-3 h-1 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${totalTasks > 0 ? (pendingTasks.length / totalTasks) * 100 : 0}%` }}></div>
                  </div>
              </div>

              {/* 5. Yüksek Öncelik */}
              <div onClick={() => navigateTo('tasks')} className="group cursor-pointer rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4 hover:border-amber-300 dark:hover:border-amber-500/40 hover:shadow-md hover:shadow-amber-500/5 transition-all relative">
                  <div className="flex items-center justify-between mb-3">
                      <div className="p-2 rounded-xl bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 group-hover:scale-110 transition-transform">
                          <AlertTriangle size={18} />
                      </div>
                      {highPriorityTasks.length > 0 && (
                          <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 px-1.5 py-0.5 rounded animate-pulse">!</span>
                      )}
                  </div>
                  <div className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight">{highPriorityTasks.length}</div>
                  <div className="text-[11px] md:text-xs text-slate-500 dark:text-zinc-500 font-medium mt-0.5">{language === 'de' ? 'Hohe Prio.' : 'Yüksek öncelik'}</div>
                  <div className="mt-3 h-1 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-500 rounded-full" style={{ width: `${pendingTasks.length > 0 ? (highPriorityTasks.length / pendingTasks.length) * 100 : 0}%` }}></div>
                  </div>
              </div>

              {/* 6. Tamamlanma Oranı */}
              <div className="group rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-4 hover:border-emerald-300 dark:hover:border-emerald-500/40 hover:shadow-md hover:shadow-emerald-500/5 transition-all relative">
                  <div className="flex items-center justify-between mb-3">
                      <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 group-hover:scale-110 transition-transform">
                          <CheckCircle2 size={18} />
                      </div>
                      <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 rounded">{language === 'de' ? 'Gesamt' : 'Genel'}</span>
                  </div>
                  <div className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight">%{completionRate}</div>
                  <div className="text-[11px] md:text-xs text-slate-500 dark:text-zinc-500 font-medium mt-0.5">{t('dash.successRate')}</div>
                  <div className="mt-3 h-1 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-emerald-400 to-emerald-600 rounded-full transition-all duration-1000" style={{ width: `${completionRate}%` }}></div>
                  </div>
              </div>
          </div>

          {/* MIDDLE SECTION: CHARTS - TÜM ADMİNLER GÖREBİLİR */}
          {currentUser.role === Role.ADMIN && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                  {/* Branch Performance Chart */}
                  <div className="lg:col-span-2 rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30 p-6 flex flex-col relative">
<GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
                          <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                              <MapPin size={18} className="text-purple-400"/> {t('dash.branchPerf')}
                          </h3>
                          <div className="flex bg-slate-50 dark:bg-zinc-950 p-1 rounded-lg border border-slate-200 dark:border-zinc-800">
                              <button 
                                onClick={() => setTimeFilter('WEEKLY')}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${timeFilter === 'WEEKLY' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                              >
                                  {language === 'de' ? 'Woche' : 'Bu Hafta'}
                              </button>
                              <button 
                                onClick={() => setTimeFilter('MONTHLY')}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${timeFilter === 'MONTHLY' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                              >
                                  {language === 'de' ? 'Monat' : 'Bu Ay'}
                              </button>
                          </div>
                      </div>
                      <div className="flex-1 min-h-[300px] w-full">
                          {branchPerformanceData.some(b => b.tamamlanan + b.aktif > 0) ? (
                              <ResponsiveContainer width="100%" height="100%">
                                  <BarChart data={branchPerformanceData} barSize={36}>
                                      <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} vertical={false} />
                                      <XAxis dataKey="name" stroke={chartAxisStroke} fontSize={12} tickLine={false} axisLine={false} dy={10} />
                                      <YAxis stroke={chartAxisStroke} fontSize={12} tickLine={false} axisLine={false} />
                                      <Tooltip
                                          cursor={{fill: chartCursorFill, opacity: 1}}
                                          contentStyle={chartTooltipStyle}
                                      />
                                      <Legend wrapperStyle={{paddingTop: '20px'}} />
                                      <Bar dataKey="tamamlanan" name={t('tasks.completed')} stackId="a" fill={chartBarPrimary} radius={[0, 0, 4, 4]} />
                                      <Bar dataKey="aktif" name={t('tasks.active')} stackId="a" fill={chartBarSecondary} radius={[4, 4, 0, 0]} />
                                  </BarChart>
                              </ResponsiveContainer>
                          ) : (
                              <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-zinc-600 px-6">
                                  <div className="p-4 rounded-2xl bg-slate-50 dark:bg-zinc-900 border border-dashed border-slate-200 dark:border-zinc-800 mb-3">
                                      <BarChart3 size={32} className="opacity-40" />
                                  </div>
                                  <p className="text-sm font-medium text-slate-600 dark:text-zinc-500 mb-1">
                                      {language === 'de' ? 'Noch keine Daten' : 'Henüz veri yok'}
                                  </p>
                                  <p className="text-xs text-slate-400 dark:text-zinc-600 text-center max-w-xs">
                                      {language === 'de'
                                          ? 'Sobald Aufgaben erstellt und abgeschlossen werden, erscheinen hier die Filialvergleiche.'
                                          : 'Görevler oluşturulup tamamlandıkça şube bazlı performans burada görünecek.'}
                                  </p>
                              </div>
                          )}
                      </div>
                  </div>

                  {/* Notifications / Live Feed */}
                  <div className="rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30 p-6 flex flex-col h-[400px] relative">
<GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                      <h3 className="font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                          <Bell size={18} className="text-amber-400"/> {t('dash.liveFeed')}
                      </h3>
                      <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4 pr-2">
                          {filteredNotifications.length > 0 ? filteredNotifications.map((notif, idx) => (
                              <div key={idx} className="flex gap-3 group">
                                  <div className="flex flex-col items-center">
                                      <div className={`w-2 h-2 rounded-full mt-1.5 ${notif.type === 'ALERT' ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-indigo-500'}`}></div>
                                      <div className="w-px h-full bg-slate-100 dark:bg-zinc-800 my-1 group-last:hidden"></div>
                                  </div>
                                  <div className="pb-4 w-full">
                                      <div className="flex justify-between items-start gap-2">
                                          <div className="flex flex-col">
                                              {notif.title && <span className="text-[11px] font-bold text-slate-500 dark:text-zinc-500 mb-0.5">{notif.title}</span>}
                                              <p className="text-sm text-slate-700 dark:text-zinc-300 group-hover:text-slate-900 dark:hover:text-white transition-colors leading-snug">{notif.message}</p>
                                          </div>
                                          <span className="text-[10px] text-slate-500 dark:text-zinc-500 whitespace-nowrap pt-0.5">{getRelativeTime(notif.timestamp, language)}</span>
                                      </div>
                                  </div>
                              </div>
                          )) : (
                              <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-zinc-600">
                                  <Bell size={32} className="mb-2 opacity-20"/>
                                  <div className="text-sm">{language === 'de' ? 'Keine Benachrichtigungen.' : 'Bildirim yok.'}</div>
                              </div>
                          )}
                      </div>
                  </div>
              </div>
          )}

          {/* ==================================================
              ALT WIDGET SATIRI — 3'lü grid
              Yaklaşan Vardiyalar + Son Mesajlar + Aktif Personel
              ================================================== */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

              {/* Widget 1: Yaklaşan Vardiyalar */}
              <div className="rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30 p-6 flex flex-col h-[400px] relative">
                  <GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                  <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                          <CalendarCheck size={18} className="text-cyan-500 dark:text-cyan-400"/>
                          {language === 'de' ? 'Kommende Schichten' : 'Yaklaşan Vardiyalar'}
                      </h3>
                      <button onClick={() => navigateTo('shifts')} className="text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors bg-slate-50 dark:bg-zinc-900 px-3 py-1 rounded-full border border-slate-200 dark:border-zinc-800">
                          {t('dash.viewAll')}
                      </button>
                  </div>
                  <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                      {upcomingShifts.length > 0 ? upcomingShifts.map((s, i) => {
                          const meta = STATUS_META[s.status];
                          const fmtTime = (iso: string | null): string => {
                            if (!iso) return '—';
                            const d = new Date(iso);
                            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                          };
                          return (
                              <div
                                  key={`${s.employeeId}-${i}`}
                                  onClick={() => navigateTo('device-brands')}
                                  className="cursor-pointer flex items-center gap-3 p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-900/50 hover:bg-slate-100 dark:hover:bg-zinc-800/50 border border-slate-100 dark:border-zinc-800/50 transition-colors"
                              >
                                  <img
                                      src={s.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(s.employeeName)}&background=6366f1&color=fff`}
                                      alt={s.employeeName}
                                      className="w-9 h-9 rounded-full border border-slate-200 dark:border-zinc-700 object-cover"
                                      referrerPolicy="no-referrer"
                                  />
                                  <div className="flex-1 min-w-0">
                                      <div className="text-sm font-medium text-slate-800 dark:text-zinc-200 truncate flex items-center gap-1.5">
                                        {s.employeeName}
                                        {s.spansMidnight && (
                                          <span className="text-[8px] uppercase tracking-wider bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 px-1 py-0.5 rounded">
                                            {language === 'de' ? 'Nacht' : 'Gece'}
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-zinc-500 flex-wrap">
                                          <span className="font-mono">{s.startTime}–{s.endTime}</span>
                                          <span className="opacity-40">·</span>
                                          <span className="truncate">{s.branch}</span>
                                          {s.checkInAt && (
                                            <>
                                              <span className="opacity-40">·</span>
                                              <span className="text-emerald-600 dark:text-emerald-400 font-mono">✓ {fmtTime(s.checkInAt)}</span>
                                            </>
                                          )}
                                          {s.checkOutAt && (
                                            <span className="text-orange-600 dark:text-orange-400 font-mono">→ {fmtTime(s.checkOutAt)}</span>
                                          )}
                                      </div>
                                  </div>
                                  <div className="flex flex-col items-end gap-1 shrink-0">
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                                        s.isToday
                                            ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                            : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500'
                                    }`}>
                                        {s.isToday ? (language === 'de' ? 'Heute' : 'Bugün') : (language === 'de' ? 'Morgen' : 'Yarın')}
                                    </span>
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border inline-flex items-center gap-0.5 ${meta.tone}`}>
                                      <span aria-hidden="true">{meta.emoji}</span>
                                      {t(meta.tKey)}
                                    </span>
                                  </div>
                              </div>
                          );
                      }) : (
                          <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-zinc-600">
                              <CalendarCheck size={32} className="mb-2 opacity-20"/>
                              <div className="text-sm">{language === 'de' ? 'Keine geplanten Schichten' : 'Planlı vardiya yok'}</div>
                          </div>
                      )}
                  </div>
              </div>

              {/* Widget 2: Son Mesajlar */}
              <div className="rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30 p-6 flex flex-col h-[400px] relative">
                  <GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                  <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                          <MessageSquare size={18} className="text-indigo-500 dark:text-indigo-400"/>
                          {t('dash.messages')}
                      </h3>
                      <button onClick={() => navigateTo('messages')} className="text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors bg-slate-50 dark:bg-zinc-900 px-3 py-1 rounded-full border border-slate-200 dark:border-zinc-800">
                          {t('dash.viewAll')}
                      </button>
                  </div>
                  <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                      {recentMessages.length > 0 ? recentMessages.slice(0, 5).map(msg => {
                          const senderName = getSenderName(msg.senderId);
                          const isUnread = !msg.read && msg.senderId !== currentUser.id;
                          return (
                              <div
                                  key={msg.id}
                                  onClick={() => navigateTo('messages')}
                                  className={`cursor-pointer p-3 rounded-xl border transition-all hover:scale-[1.01] ${
                                      isUnread
                                          ? 'bg-indigo-50 dark:bg-indigo-900/15 border-indigo-200 dark:border-indigo-500/30'
                                          : 'bg-slate-50 dark:bg-zinc-900/50 border-slate-100 dark:border-zinc-800/50 hover:bg-slate-100 dark:hover:bg-zinc-800/50'
                                  }`}
                              >
                                  <div className="flex items-start justify-between gap-2 mb-1">
                                      <div className="flex items-center gap-2 min-w-0">
                                          <span className={`text-sm font-semibold truncate ${isUnread ? 'text-indigo-700 dark:text-indigo-200' : 'text-slate-700 dark:text-zinc-300'}`}>
                                              {senderName}
                                          </span>
                                          {isUnread && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0" />}
                                      </div>
                                      <span className="text-[10px] text-slate-400 dark:text-zinc-600 whitespace-nowrap">{getRelativeTime(msg.timestamp, language)}</span>
                                  </div>
                                  <p className="text-xs text-slate-600 dark:text-zinc-400 line-clamp-2 leading-snug">{msg.content}</p>
                              </div>
                          );
                      }) : (
                          <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-zinc-600">
                              <MessageSquare size={32} className="mb-2 opacity-20"/>
                              <div className="text-sm">{language === 'de' ? 'Keine Nachrichten' : 'Mesaj yok'}</div>
                          </div>
                      )}
                  </div>
              </div>

              {/* Widget 3: Aktif Personel Listesi */}
              <div className="rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30 p-6 flex flex-col h-[400px] relative">
                  <GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                  <div className="flex justify-between items-center mb-4">
                      <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                          <Users size={18} className="text-blue-500 dark:text-blue-400"/>
                          {t('dash.activeStaff')}
                          <span className="text-xs font-medium text-slate-500 dark:text-zinc-500 ml-1">({dashboardEmployees.length})</span>
                      </h3>
                      <button onClick={() => navigateTo('payroll')} className="text-xs text-indigo-500 dark:text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors bg-slate-50 dark:bg-zinc-900 px-3 py-1 rounded-full border border-slate-200 dark:border-zinc-800">
                          {t('dash.viewAll')}
                      </button>
                  </div>
                  <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                      {dashboardEmployees.length > 0 ? dashboardEmployees.slice(0, 8).map(emp => (
                          <div
                              key={emp.id}
                              onClick={() => navigateTo('payroll')}
                              className="flex items-center gap-3 p-2.5 rounded-xl bg-slate-50 dark:bg-zinc-900/50 hover:bg-slate-100 dark:hover:bg-zinc-800/50 border border-slate-100 dark:border-zinc-800/50 transition-colors cursor-pointer"
                          >
                              <div className="relative shrink-0">
                                  <img
                                      src={emp.avatarUrl}
                                      alt={emp.name}
                                      className="w-9 h-9 rounded-full border border-slate-200 dark:border-zinc-700 object-cover"
                                      referrerPolicy="no-referrer"
                                  />
                                  <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-white dark:border-zinc-900" />
                              </div>
                              <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium text-slate-800 dark:text-zinc-200 truncate">{emp.name}</div>
                                  <div className="text-[11px] text-slate-500 dark:text-zinc-500 truncate">
                                      {emp.branch || (language === 'de' ? 'Pool' : 'Havuz')}
                                  </div>
                              </div>
                              <ChevronRight size={14} className="text-slate-300 dark:text-zinc-700 shrink-0" />
                          </div>
                      )) : (
                          <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-zinc-600">
                              <Users size={32} className="mb-2 opacity-20"/>
                              <div className="text-sm">{language === 'de' ? 'Kein Personal' : 'Personel yok'}</div>
                          </div>
                      )}
                  </div>
              </div>
          </div>
        </div>
      );
  }

  // --- RENDER: STAFF DASHBOARD ---
  return (
    <div
      className="dashboard-scifi h-full w-full p-4 md:p-8 overflow-y-auto custom-scrollbar bg-[#09090b]"
      style={{ paddingBottom: 'calc(5.5rem + env(safe-area-inset-bottom, 0px))' }}
    >
      {/* HUD HERO BAND — sci-fi başlık (sadece dark'ta görünür; light'ta sade) */}
      <div className="hidden dark:flex relative items-center justify-center mb-6 mt-2 scifi-scan">
        <div className="absolute left-0 top-1/2 -translate-y-1/2 h-px w-1/3 bg-gradient-to-r from-transparent to-cyan-400/60" />
        <div className="absolute right-0 top-1/2 -translate-y-1/2 h-px w-1/3 bg-gradient-to-l from-transparent to-cyan-400/60" />
        <div className="px-6 py-3 flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-cyan-400 scifi-pulse" />
          <span className="text-[10px] md:text-xs font-mono tracking-[0.4em] text-cyan-300/80 uppercase">BAC // Operation Panel</span>
          <span className="w-2 h-2 rounded-full bg-cyan-400 scifi-pulse" />
        </div>
      </div>
       
       {/* 1. ADMIN MESSAGE ALERT BANNER (EN ÜSTTE) */}
       {adminMessageAlert && (
            <div className="mb-6 bg-gradient-to-r from-indigo-900/90 to-purple-900/90 border border-indigo-500/50 rounded-2xl p-6 flex flex-col md:flex-row items-center gap-6 animate-in slide-in-from-top-4 shadow-[0_0_30px_rgba(99,102,241,0.2)] relative overflow-hidden ring-1 ring-indigo-500/30">
                <div className="absolute top-0 left-0 w-2 h-full bg-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.8)]"></div>
                
                <div className="relative z-10 p-4 bg-indigo-500/20 rounded-full border border-indigo-500/30 shadow-inner">
                    <MessageSquare size={32} className="text-indigo-300 animate-pulse" />
                </div>
                
                <div className="flex-1 text-center md:text-left z-10">
                    <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-1 flex items-center justify-center md:justify-start gap-2">
                        {t('dash.adminAlert')}
                        <span className="text-[10px] bg-red-600 text-slate-900 dark:text-white px-2 py-0.5 rounded-full font-bold animate-bounce">{t('dash.newBadge')}</span>
                    </h3>
                    <p className="text-indigo-200 text-sm leading-relaxed max-w-2xl line-clamp-1">
                        {adminMessageAlert.message}
                    </p>
                </div>
                
                <button onClick={() => navigateTo('messages')} className="relative z-10 px-8 py-3 bg-white text-indigo-900 text-sm font-bold rounded-xl transition-all shadow-lg hover:bg-slate-200 dark:hover:bg-zinc-100 hover:scale-105 active:scale-95 group">
                    {t('dash.readMessage')}
                    <ArrowUpRight className="inline-block ml-2 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" size={16} />
                </button>
            </div>
       )}

       {/* 2. HIGH PRIORITY TRANSFER ALERT BANNER */}
       {/* Transfer alert hidden - feature disabled */}
       {false && activeTransferEvent && (
           <div className="mb-8 bg-gradient-to-r from-orange-950/90 to-red-950/90 border border-orange-500/50 rounded-2xl p-6 flex flex-col md:flex-row items-center gap-6 animate-in slide-in-from-top-4 shadow-[0_0_40px_rgba(234,88,12,0.3)] relative overflow-hidden ring-1 ring-orange-500/30">
               <div className="absolute top-0 left-0 w-2 h-full bg-orange-500 shadow-[0_0_15px_rgba(249,115,22,0.8)]"></div>
               
               <div className="relative z-10 p-4 bg-orange-500/20 rounded-full border border-orange-500/30 shadow-inner">
                   <AlertTriangle size={32} className="text-orange-400 animate-pulse" />
               </div>
               
               <div className="flex-1 text-center md:text-left z-10">
                   <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2 flex items-center justify-center md:justify-start gap-2 uppercase tracking-wide">
                       ⚠️ {t('dash.transferAlert')}
                   </h3>
                   <div className="space-y-1 text-sm">
                        <p className="text-orange-200 font-medium">
                            {t('dash.transferAlertMsg')}
                        </p>
                        <p className="text-slate-700 dark:text-zinc-300">
                            <span className="bg-orange-500/20 text-orange-200 px-2 py-0.5 rounded border border-orange-500/30 font-bold">{activeTransferEvent.title}</span>
                        </p>
                        <p className="text-slate-700 dark:text-zinc-300">
                            {t('sales.date')}: <span className="text-orange-300 font-bold">{formatDate(activeTransferEvent.date)} - {activeTransferEvent.endDate ? formatDate(activeTransferEvent.endDate) : '...'}</span>
                        </p>
                        <p className="text-slate-700 dark:text-zinc-300">
                            {t('common.timeLabel')}: <span className="text-orange-300 font-bold">{activeTransferEvent.startTime} - {activeTransferEvent.endTime}</span>
                        </p>
                   </div>
               </div>
               
               <button onClick={() => navigateTo('calendar')} className="relative z-10 px-8 py-3 bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-500 hover:to-red-500 text-slate-900 dark:text-white text-sm font-bold rounded-xl transition-all shadow-lg hover:shadow-orange-900/40 hover:scale-105 active:scale-95 group whitespace-nowrap">
                   {t('dash.viewDetails')}
                   <ArrowRightLeft className="inline-block ml-2 group-hover:translate-x-1 transition-transform" size={16} />
               </button>

               {/* Arka plan dekorasyonu */}
               <div className="absolute -right-10 -bottom-20 w-64 h-64 bg-orange-600/10 rounded-full blur-3xl pointer-events-none"></div>
           </div>
       )}

      <header className="mb-8 flex flex-col md:flex-row justify-between items-center gap-6">
        <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-5">
                 <div className="relative group cursor-pointer">
                     <label className="block w-16 h-16 rounded-full p-0.5 bg-gradient-to-br from-indigo-500 to-purple-600 cursor-pointer relative transition-transform group-hover:scale-105">
                        <img src={currentUser.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name)}&background=6366f1&color=fff`} className="w-full h-full rounded-full object-cover border-2 border-[#09090b]" alt="Profile" referrerPolicy="no-referrer" />
                        
                        <div className="absolute inset-0.5 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            {isUploadingAvatar ? <Loader2 size={20} className="text-slate-900 dark:text-white animate-spin" /> : <Upload size={20} className="text-slate-900 dark:text-white" />}
                        </div>
                        
                        <input type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} disabled={isUploadingAvatar} />
                     </label>
                     <div className="absolute bottom-0 right-0 w-5 h-5 bg-green-500 border-4 border-[#09090b] rounded-full z-10" title="Online"></div>
                 </div>
                 <div>
                    <h1 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight">
                        {t('dash.welcome')}, {currentUser.name.split(' ')[0]}
                    </h1>
                    <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs font-medium px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border border-slate-300 dark:border-zinc-700">Havuz</span>
                        <span className="text-xs text-slate-500 dark:text-zinc-500">{formatDate(new Date().toISOString(), { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                    </div>
                </div>
            </div>
            
            <button 
                onClick={() => navigateTo('messages')}
                className="p-3 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl text-indigo-400 hover:text-slate-900 dark:hover:text-white hover:bg-indigo-600/20 transition-all shadow-lg relative"
            >
                <MessageSquare size={20} />
                <span className="absolute -top-1 -right-1 w-3 h-3 bg-indigo-500 rounded-full border-2 border-[#09090b]"></span>
            </button>
        </div>
      </header>

      {/* --- BÖLÜM 1: ÖNCELİKLİ GÖREVLER --- */}
      <div className="mb-8">
          <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white uppercase tracking-wider flex items-center gap-2">
                  <CheckSquare size={20} className="text-yellow-500"/> {t('dash.priorityTasks')}
              </h3>
              <button onClick={() => navigateTo('tasks')} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors bg-white dark:bg-zinc-900 px-3 py-1 rounded-full border border-slate-200 dark:border-zinc-800">{t('dash.viewAll')}</button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {myTasks.length > 0 ? (
                  myTasks.slice(0, 4).map(task => (
                      <div key={task.id} onClick={() => navigateTo('tasks')} className="group p-4 bg-white dark:bg-zinc-900/50 hover:bg-slate-100 dark:hover:bg-zinc-800/80 border border-slate-200 dark:border-zinc-800 rounded-2xl cursor-pointer transition-all hover:scale-[1.02] shadow-sm relative overflow-hidden">
                          {task.priority === 'Yüksek' && <div className="absolute top-0 left-0 w-1 h-full bg-red-500"></div>}
                          <div className="flex justify-between items-start mb-3">
                              <span className={`text-[10px] px-2 py-0.5 rounded border font-medium ${
                                  task.priority === 'Yüksek' ? 'bg-red-900/20 text-red-400 border-red-900/30' : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border-slate-300 dark:border-zinc-700'
                              }`}>{t(`priority.${task.priority}`)}</span>
                              <ArrowUpRight size={16} className="text-slate-400 dark:text-zinc-600 group-hover:text-slate-900 dark:hover:text-white transition-colors"/>
                          </div>
                          <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 group-hover:text-slate-900 dark:hover:text-white line-clamp-2 mb-2">{task.title}</h4>
                          <div className="flex justify-between items-end mt-2">
                                <span className="text-[10px] text-slate-500 dark:text-zinc-500">{t('tasks.dueDate')}: {formatDate(task.dueDate, {day:'numeric', month:'short'})}</span>
                                <div className="text-xs font-mono text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded">%{task.progress}</div>
                          </div>
                          <div className="mt-2 w-full bg-slate-100 dark:bg-zinc-800 h-1 rounded-full overflow-hidden">
                              <div className="bg-indigo-500 h-full rounded-full" style={{ width: `${task.progress}%` }}></div>
                          </div>
                      </div>
                  ))
              ) : (
                  <div className="col-span-4 flex flex-col items-center justify-center py-8 bg-white dark:bg-zinc-900/20 border border-dashed border-slate-200 dark:border-zinc-800 rounded-2xl text-slate-500 dark:text-zinc-500">
                      <CheckCircle2 size={32} className="mb-2 opacity-20"/>
                      <p className="text-sm">{t('dash.noActiveTasks')}</p>
                  </div>
              )}
          </div>
      </div>

      {/* --- BÖLÜM 2: YENİ EK (MESAJLAR & TRANSFERLER) --- */}
      {/* 100% Genişlik - Grid Layout ile yan yana ve tam oturan */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8 w-full">
          
          {/* KART 1: MESAJLAR & BİLDİRİMLER - EĞER TRANSFER YOKSA TAM GENİŞLİK (col-span-2) */}
          <div className={`rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30 p-6 flex flex-col h-full min-h-[300px] relative ${recentTransfers.length === 0 ? 'lg:col-span-2' : ''}`}>
<GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
              <div className="flex justify-between items-center mb-6">
                  <h3 className="text-sm font-bold text-slate-700 dark:text-zinc-300 uppercase tracking-wider flex items-center gap-2">
                      <MessageSquare size={16} className="text-indigo-400"/> {t('dash.messages')}
                  </h3>
                  <button onClick={() => navigateTo('messages')} className="p-1.5 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg text-slate-500 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white transition-colors">
                      <ArrowUpRight size={16}/>
                  </button>
              </div>
              <div className="flex-1 flex flex-col gap-3">
                  {recentMessages.length === 0 && filteredNotifications.length === 0 ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-slate-400 dark:text-zinc-600">
                          <Bell size={24} className="opacity-30 mb-2"/>
                          <p className="text-xs">Yeni bildirim yok</p>
                      </div>
                  ) : (
                      <>
                        {/* Önce Mesajlar */}
                        {recentMessages.map(msg => (
                            <div 
                                key={msg.id} 
                                onClick={() => navigateTo('messages')}
                                className={`flex gap-4 items-start p-3 rounded-xl border transition-all cursor-pointer hover:bg-white dark:hover:bg-zinc-900/60 hover:border-slate-300 dark:border-zinc-700 hover:scale-[1.01] ${!msg.read && msg.senderId !== currentUser.id ? 'bg-indigo-900/10 border-indigo-500/20' : 'bg-white dark:bg-zinc-900/40 border-slate-200 dark:border-zinc-800/50'}`}
                            >
                                <div className="relative flex-shrink-0">
                                    <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-xs font-bold text-slate-600 dark:text-zinc-400 border border-slate-300 dark:border-zinc-700">
                                        {getSenderName(msg.senderId).charAt(0)}
                                    </div>
                                    {!msg.read && msg.senderId !== currentUser.id && <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-indigo-500 rounded-full border-2 border-slate-200 dark:border-zinc-950"></div>}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-baseline mb-0.5">
                                        <h4 className="text-xs font-bold text-slate-800 dark:text-zinc-200">{getSenderName(msg.senderId)}</h4>
                                        <span className="text-[10px] text-slate-500 dark:text-zinc-500">{getRelativeTime(msg.timestamp, language)}</span>
                                    </div>
                                    <p className="text-xs text-slate-600 dark:text-zinc-400 line-clamp-1">{msg.content}</p>
                                </div>
                            </div>
                        ))}
                        {/* Sonra Bildirimler (Varsa ve mesaj azsa) */}
                        {recentMessages.length < 3 && filteredNotifications.slice(0, 3 - recentMessages.length).map(notif => (
                             <div key={notif.id} className="flex gap-4 items-start p-3 rounded-xl border border-slate-200 dark:border-zinc-800/50 bg-white dark:bg-zinc-900/40">
                                <div className="flex-shrink-0 pt-1">
                                    <Bell size={14} className="text-amber-500"/>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-xs text-slate-700 dark:text-zinc-300">{notif.message}</p>
                                    <span className="text-[10px] text-slate-400 dark:text-zinc-600 mt-1 block">{getRelativeTime(notif.timestamp, language)}</span>
                                </div>
                             </div>
                        ))}
                      </>
                  )}
              </div>
          </div>

          {/* KART 2: PERSONEL TRANSFERLERİ - SADECE AKTİF TRANSFER VARSA GÖSTER */}
          {/* Transfer card hidden - feature disabled */}
          {false && recentTransfers.length > 0 && (
              <div className="rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30 p-6 flex flex-col h-full min-h-[300px] relative">
<GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                  <div className="flex justify-between items-center mb-6">
                      <h3 className="text-sm font-bold text-slate-700 dark:text-zinc-300 uppercase tracking-wider flex items-center gap-2">
                          <ArrowRightLeft size={16} className="text-orange-500"/> {t('dash.transfers')}
                      </h3>
                      <button onClick={() => navigateTo('calendar')} className="p-1.5 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-lg text-slate-500 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white transition-colors">
                          <ArrowUpRight size={16}/>
                      </button>
                  </div>
                  <div className="flex-1 flex flex-col gap-3">
                      {recentTransfers.map(tr => (
                          // MODIFIED: SOLID ORANGE SINGLE COLOR CARD
                          <div key={tr.id} className="flex items-center gap-4 p-4 rounded-xl bg-orange-600 border border-orange-500 shadow-lg shadow-orange-900/30 transition-transform hover:scale-[1.01]">
                              <div className="flex -space-x-2 flex-shrink-0">
                                  {tr.attendees.slice(0,2).map(id => {
                                      const emp = dashboardEmployees.find(e => e.id === id);
                                      return emp ? <img key={id} src={emp.avatarUrl} className="w-10 h-10 rounded-full border-2 border-orange-500 bg-orange-700" title={emp.name} referrerPolicy="no-referrer" /> : null;
                                  })}
                                  {tr.attendees.length > 2 && <div className="w-10 h-10 rounded-full bg-orange-800 border-2 border-orange-500 flex items-center justify-center text-[10px] text-orange-200 font-bold">+{tr.attendees.length-2}</div>}
                              </div>
                              <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                      <span className="text-sm font-bold text-slate-900 dark:text-white truncate">
                                          {tr.attendees.length === 1 
                                            ? dashboardEmployees.find(e => e.id === tr.attendees[0])?.name 
                                            : `${tr.attendees.length} Personel`}
                                      </span>
                                  </div>
                                  <div className="text-xs text-orange-100 flex items-center gap-1 mt-0.5">
                                      <span className="truncate font-medium">{tr.title}</span>
                                  </div>
                              </div>
                              <div className="flex-shrink-0 text-right">
                                  <span className="block text-xs font-bold text-slate-900 dark:text-white bg-orange-700/50 px-3 py-1.5 rounded-lg border border-orange-400/30">
                                      {formatDate(tr.date, { day: 'numeric', month: 'short' })}
                                  </span>
                              </div>
                          </div>
                      ))}
                  </div>
                  <button onClick={() => navigateTo('calendar')} className="mt-4 w-full py-2 text-xs font-medium text-slate-500 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-800/50 rounded-lg transition-colors border border-dashed border-slate-200 dark:border-zinc-800">
                      {t('dash.viewAll')}
                  </button>
              </div>
          )}

      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          
          {/* COL 1: DAILY TIME ENTRY & SALES LEADERBOARD */}
          <div className="space-y-6">
              {/* QR İLE MESAİ GİRİŞİ — eski "Saat Girişi" kartının yerine.
                  Tıklanınca payroll'a değil, doğrudan QR scanner modal'ı açılır. */}
              <div
                  onClick={() => setShowQrModal(true)}
                  className="rounded-3xl border border-slate-200 dark:border-zinc-800 bg-gradient-to-br from-emerald-900/40 to-zinc-900 p-6 relative overflow-hidden group cursor-pointer hover:border-emerald-500/50 transition-all shadow-lg"
              >
<GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                  <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                      <QrCode size={100} className="text-emerald-400" />
                  </div>
                  <div className="relative z-10">
                      <div className="w-12 h-12 rounded-2xl bg-emerald-600 flex items-center justify-center text-slate-900 dark:text-white shadow-lg shadow-emerald-900/50 mb-4 group-hover:scale-110 transition-transform">
                          <QrCode size={24} />
                      </div>
                      <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-1">QR ile Mesai</h3>
                      <p className="text-sm text-slate-600 dark:text-zinc-400 mb-4">Şube QR'ını okutarak hızlıca giriş/çıkış yap.</p>
                      <button className="px-4 py-2 bg-slate-50 dark:bg-zinc-950 border border-slate-300 dark:border-zinc-700 text-slate-900 dark:text-white text-xs font-bold rounded-lg group-hover:bg-white group-hover:text-black transition-colors">
                          QR Tara
                      </button>
                  </div>
              </div>



              {/* Task Status Pie Chart */}
              {currentUser.role === Role.ADMIN && (
                <div className="rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30 p-6 flex flex-col justify-between relative">
<GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                    <div className="flex justify-between items-start mb-2">
                        <h3 className="text-sm font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider mb-1 flex items-center gap-2"><ListTodo size={16}/> {t('dash.taskDist')}</h3>
                    </div>
                    <div className="h-[180px] w-full relative">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={taskStatusData}
                                    innerRadius={50}
                                    outerRadius={70}
                                    paddingAngle={5}
                                    dataKey="value"
                                    stroke="none"
                                >
                                    {taskStatusData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.color} />
                                    ))}
                                </Pie>
                                <Tooltip
                                    contentStyle={chartTooltipStyle}
                                    itemStyle={{ color: isDark ? '#e2e8f0' : '#1a0a0e' }}
                                />
                                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '11px', color: chartAxisStroke }}/>
                            </PieChart>
                        </ResponsiveContainer>
                        
                        <div className="absolute inset-0 flex items-center justify-center flex-col pointer-events-none pb-8">
                            <span className="text-3xl font-bold text-slate-900 dark:text-white">{myTasks.length}</span>
                            <span className="text-[10px] text-slate-500 dark:text-zinc-500 uppercase mb-1">{t('tasks.total')} (Aktif)</span>
                            <div className="bg-slate-100 dark:bg-zinc-800/80 px-2 py-0.5 rounded-full border border-slate-300 dark:border-zinc-700 mt-1">
                                <span className="text-xs font-bold text-green-400">%{myCompletionRate}</span>
                            </div>
                        </div>
                    </div>
                </div>
              )}
          </div>

          {/* COL 2: WORKLOAD & PRIORITY ANALYSIS */}
          <div className="rounded-3xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/30 p-6 flex flex-col relative lg:col-span-2">
<GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
              <h3 className="text-sm font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider flex items-center gap-2 mb-4">
                  <BarChart3 size={16}/> {t('dash.workload')}
              </h3>
              <div className="flex-1 min-h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={taskPriorityData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={chartGridStroke} horizontal={true} vertical={false} />
                          <XAxis type="number" stroke={chartAxisStroke} fontSize={11} tickLine={false} axisLine={false} />
                          <YAxis dataKey="name" type="category" stroke={chartAxisStroke} fontSize={12} tickLine={false} axisLine={false} width={50} />
                          <Tooltip
                              cursor={{fill: chartCursorFill, opacity: 1}}
                              contentStyle={chartTooltipStyle}
                          />
                          <Bar dataKey="adet" name="Count" fill={chartBarPrimary} radius={[0, 4, 4, 0]} barSize={32} />
                      </BarChart>
                  </ResponsiveContainer>
              </div>
              <div className="mt-4 p-3 bg-white dark:bg-zinc-900/50 rounded-xl border border-slate-200 dark:border-zinc-800/50 flex items-center gap-4">
                  <div className="p-2 bg-indigo-500/10 rounded-lg text-indigo-400"><Briefcase size={20}/></div>
                  <p className="text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
                      {/* GÜNCELLEME: BURADAKİ METİNDE DE AKTİF SAYI GÖSTERİLMELİ */}
                      <span className="text-indigo-400 font-bold">{t('dash.workload').split('&')[1]}:</span> {t('tasks.total')} {myTasks.length}. <span className="text-red-400 font-bold">{taskPriorityData.find(d=>d.name===t('priority.Yüksek'))?.adet || 0}</span> {t('priority.Yüksek').toLowerCase()}.
                  </p>
              </div>
          </div>
      </div>

      {/* QR MESAİ MODAL — Dashboard "QR ile Mesai" kartından açılır */}
      {showQrModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-zinc-800">
              <div className="flex items-center gap-2 text-slate-900 dark:text-white font-semibold">
                <QrCode size={18} className="text-emerald-400" />
                QR ile Mesai
              </div>
              <button
                onClick={() => setShowQrModal(false)}
                className="text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white"
                aria-label="Kapat"
              >
                <X size={18} />
              </button>
            </div>
            <Suspense fallback={
              <div className="p-12 flex items-center justify-center text-slate-600 dark:text-zinc-400">
                <Loader2 className="animate-spin mr-2" size={20}/> Yükleniyor...
              </div>
            }>
              <QrCheckIn currentUser={currentUser} onComplete={() => setTimeout(() => setShowQrModal(false), 1500)} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;