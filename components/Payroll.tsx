import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { lazyWithRetry } from '../lib/lazyWithRetry';
import { Employee, Branch, Role, TimeLog, AppNotification } from '../types';
import { Search, Plus, Filter, Calculator, Save, Trash2, Phone, Mail, X, MapPin, Briefcase, Link as LinkIcon, ThumbsUp, ThumbsDown, Clock, Calendar as CalendarIcon, ChevronLeft, ChevronRight, Wallet, Banknote, Map as MapIcon, Timer, Edit2, Loader2, ArrowRightLeft, Building2, CalendarRange, Lock, Rocket, PieChart, Upload, Shield, AlertTriangle, QrCode, AlarmClockOff, Zap, MessageCircle } from 'lucide-react';
import { includeAsPersonnel, isDualRoleAdmin, isRestrictedAdmin } from '../constants';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../lib/i18n';
import { GlowingEffect } from './ui/glowing-effect';
import { notifyEvent } from '../lib/notifyEvent';
import { canSeeDeviceInfo, formatHoursHumanTR } from '../lib/utils';

// QR sayfa yuklenirken patlamasin diye lazy yukleniyor (zxing/browser
// production minify'da top-level import edilince mangled constructor hatasi veriyordu).
// lazyWithRetry: yeni deployment sonrası eski hash'li chunk için MIME hatasında auto-recover
const QrCheckIn = lazyWithRetry(() => import('./QrCheckIn'));


// Yeni sekme yapısı: FINANCIAL eklendi
type Tab = 'STAFF' | 'MONTHLY' | 'FINANCIAL' | 'APPROVALS';

// Süper admin: tüm onay bekleyenleri görebilir
const SUPER_ADMIN_EMAIL = 'cevikademm@gmail.com';

interface PayrollProps {
    currentUser: Employee;
    onNotify: (notification: AppNotification) => void;
}

const Payroll: React.FC<PayrollProps> = ({ currentUser, onNotify }) => {
  // LOGIC CHANGE: If Staff, default to MONTHLY (Time Logs), else STAFF list
  const [currentTab, setCurrentTab] = useState<Tab>(currentUser.role === Role.ADMIN ? 'STAFF' : 'MONTHLY');
  const [employees, setEmployees] = useState<Employee[]>([]); 
  const [timeLogs, setTimeLogs] = useState<TimeLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  const { t, formatDate, language } = useLanguage();

  // Tüm adminler aynı paneli görür

  // Şube Seçimi kaldırıldı - tüm personel havuzda
  const selectedBranch: 'ALL' = 'ALL';
  
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(
      currentUser.role === Role.ADMIN ? null : currentUser.id
  );
  
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Employee>>({});

  // Transfer Modal
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [targetBranch, setTargetBranch] = useState<Branch>(Branch.DOM);
  // Transfer Date Range State
  const [transferDates, setTransferDates] = useState({
      startDate: new Date().toISOString().split('T')[0],
      endDate: new Date().toISOString().split('T')[0],
      startTime: '08:00',
      endTime: '18:00'
  });
  const [transferHistory, setTransferHistory] = useState<any[]>([]);
  const [selectedTransferDay, setSelectedTransferDay] = useState<string | null>(null);

  const [showTimeModal, setShowTimeModal] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  // editingLogId: null → yeni saat ekleme, dolu → mevcut kaydı düzeltme.
  // Admin saat aralığını değiştirdiğinde total_hours otomatik tekrar hesaplanır.
  const [editingLogId, setEditingLogId] = useState<string | null>(null);
  const [timeForm, setTimeForm] = useState({
      date: new Date().toISOString().split('T')[0],
      startTime: '09:00',
      endTime: '17:00',
      breakDuration: 0,
      branch: Branch.DOM
  });

  // Arama state'i
  const [searchQuery, setSearchQuery] = useState('');

  // Onay Bekleyenler paneli (Süper Admin)
  const [approvalsSearch, setApprovalsSearch] = useState('');

  // Admin personel listesi
  const [adminEmployees, setAdminEmployees] = useState<Employee[]>([]);
  const [showAdminList, setShowAdminList] = useState(false);

  // "Fazla Mesai Bildir" modal — sadece auto-close edilmiş kendi vardiyası için
  const [overtimeLogId, setOvertimeLogId] = useState<string | null>(null);
  const [overtimeMinutes, setOvertimeMinutes] = useState<number>(60);
  const [overtimeSubmitting, setOvertimeSubmitting] = useState(false);

  // --- SUPABASE VERİ ÇEKME & REALTIME ---
  useEffect(() => {
    fetchData();

    // SUBSCRIBE TO REALTIME CHANGES
    const channel = supabase.channel('payroll-realtime')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
             fetchData(); // Refresh list on transfer or update
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'time_logs' }, () => {
             fetchData(); // Refresh logs
        })
        .subscribe();

    return () => {
        supabase.removeChannel(channel);
    };
  }, [currentUser]); // currentUser değişirse tekrar çek

  const fetchData = async () => {
    setIsLoading(true);
    try {
        // 1. Personelleri Çek
        // Çift rollü adminler (Apo, Malik) personel listesinde de görünür; diğer adminler filtrelenir.
        let empQuery = supabase.from('profiles').select('*').limit(1000);

        // Veritabanı bağlantısı yoksa veya hata olursa mock veriye düşülecek
        const { data: empData, error: empError } = await empQuery;

        if (empError) throw empError;

        // DB verisini Frontend formatına çevir (snake_case -> camelCase)
        const formattedEmployees: Employee[] = (empData || []).filter(includeAsPersonnel).map((e: any) => ({
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

        // KURAL: Adminler personel listesinde gösterilmez. İstisna: Çift rollü adminler (Apo, Malik).
        const visibleEmployees = formattedEmployees.filter(e => e.role !== Role.ADMIN || isDualRoleAdmin(e));
        
        // Eğer DB boşsa Mock veriyi kullan, yoksa DB'yi kullan
        if(visibleEmployees.length > 0) {
            setEmployees(visibleEmployees);
        } else {
             // Mock veriyi de filtrele
             setEmployees([]);
        }

        // 1.5 Admin Personelleri Çek (Sadece admin kullanıcı için)
        if (currentUser.role === Role.ADMIN) {
            const { data: adminData } = await supabase.from('profiles').select('*').eq('role', 'Admin').order('full_name');
            if (adminData) {
                const formattedAdmins: Employee[] = adminData.map((e: any) => ({
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
                setAdminEmployees(formattedAdmins);
            }
        }

        // 2. Zaman Loglarını Çek
        let logQuery = supabase.from('time_logs').select('*');

        // GÜVENLİK: Admin değilse VEYA kısıtlanmış admin (Apo, Malik) ise
        // sadece kendi loglarını gör.
        if (currentUser.role !== Role.ADMIN || isRestrictedAdmin(currentUser)) {
             logQuery = logQuery.eq('employee_id', currentUser.id);
        }

        const { data: logData, error: logError } = await logQuery;
        
        const formattedLogs: TimeLog[] = (logData || []).map((l: any) => {
            // FALLBACK HESAPLAMA (0 SAAT HATASI İÇİN)
            // Eğer DB'den gelen total_hours 0 veya null ise, burada manuel hesaplıyoruz.
            let displayHours = Number(l.total_hours);

            // Henüz çıkış yapılmamış QR kaydı (end_time boş) → hesaplama yapma, 0 kalsın.
            const hasStart = !!(l.start_time && l.start_time.length >= 4);
            const hasEnd = !!(l.end_time && l.end_time.length >= 4);

            if ((!displayHours || displayHours <= 0) && hasStart && hasEnd) {
                const s = new Date(`1970-01-01T${l.start_time}:00`);
                const e = new Date(`1970-01-01T${l.end_time}:00`);
                let diffMs = e.getTime() - s.getTime();
                if (diffMs < 0) diffMs += 24 * 60 * 60 * 1000;

                const breakMins = l.break_duration || 0;
                const netMins = (diffMs / 60000) - breakMins;
                displayHours = Math.max(0, Number((netMins / 60).toFixed(2)));
            } else if (!displayHours || displayHours <= 0) {
                displayHours = 0;
            }

            return {
                id: l.id,
                employeeId: l.employee_id,
                date: l.date,
                startTime: (l.start_time || '').slice(0, 5),
                // end_time boşsa check_out_at'ten türet (otomatik kapatılan eski kayıtlar için fallback)
                endTime: (l.end_time && l.end_time.length >= 4)
                    ? l.end_time.slice(0, 5)
                    : (l.check_out_at
                        ? new Date(l.check_out_at).toLocaleTimeString('de-DE', {
                              hour: '2-digit', minute: '2-digit',
                              timeZone: 'Europe/Berlin', hour12: false,
                          })
                        : ''),
                breakDuration: l.break_duration,
                totalHours: displayHours,
                branch: l.branch || 'Bilinmiyor', // Şube verisi
                status: l.status,
                method: l.entry_method === 'qr' ? 'qr' : 'manual',
                checkInAt: l.check_in_at || undefined,
                checkOutAt: l.check_out_at || undefined,
                checkInLat: l.check_in_lat != null ? Number(l.check_in_lat) : undefined,
                checkInLng: l.check_in_lng != null ? Number(l.check_in_lng) : undefined,
                checkOutLat: l.check_out_lat != null ? Number(l.check_out_lat) : undefined,
                checkOutLng: l.check_out_lng != null ? Number(l.check_out_lng) : undefined,
                deviceInfo: l.device_info || undefined,
                autoClosedAt: l.auto_closed_at || undefined,
                overtimeMinutes: l.overtime_minutes != null ? Number(l.overtime_minutes) : undefined,
                overtimeRequestedAt: l.overtime_requested_at || undefined,
                validationWarning: l.validation_warning || undefined,
                validationDiffMin: l.validation_diff_min != null ? Number(l.validation_diff_min) : undefined,
            };
        });
        
        setTimeLogs(formattedLogs);

    } catch (error) {
        console.error("Veri çekme hatası (Mock Kullanılıyor):", error);
        // Hata durumunda mock veriyi filtreleyip bas
        setEmployees([]);
    } finally {
        setIsLoading(false);
    }
  };


  // --- HESAPLAMALAR ---
  const filteredEmployees = useMemo(() => {
    // KURAL: Admin değilse VEYA kısıtlanmış admin (Apo, Malik) ise sadece kendisini görür.
    if (currentUser.role !== Role.ADMIN || isRestrictedAdmin(currentUser)) {
        return employees.filter(e => e.id === currentUser.id);
    }
    // Tüm personel havuzda - sadece arama filtresi
    return employees.filter(e => {
        const searchMatch = !searchQuery || e.name.toLowerCase().includes(searchQuery.toLowerCase()) || e.email.toLowerCase().includes(searchQuery.toLowerCase());
        return searchMatch;
    });
  }, [employees, currentUser, searchQuery]);

  // Tüm çalışanlar (personel + admin) birleşik listesi - detay görüntüleme için
  // Çift rollü adminler (Apo, Malik) her iki listeye de girebildiği için id bazlı dedupe yapılır.
  const allEmployees = useMemo(() => {
      const seen = new Set<string>();
      return [...employees, ...adminEmployees].filter(e => {
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
      });
  }, [employees, adminEmployees]);

  // Kısıtlanmış admin (Apo, Malik) seçim yapamaz; daima kendi id'sine sabitlenir.
  const restricted = isRestrictedAdmin(currentUser);
  const targetEmployeeId = restricted
    ? currentUser.id
    : (selectedEmployeeId || (currentUser.role === Role.ADMIN ? null : currentUser.id));
  const targetEmployee = allEmployees.find(e => e.id === targetEmployeeId);

  const selectedEmployeeForDetail = selectedEmployeeId === 'NEW'
    ? (editForm as Employee)
    : allEmployees.find(e => e.id === selectedEmployeeId);

  // Tüm personeller için bekleyen kayıtlar — sadece SUPER_ADMIN için doldurulur.
  // Filtre, Finansal Özet'teki "onay bekleyen kayıt" uyarısıyla aynı mantığı kullanır:
  // 'Onaylandı' veya 'Reddedildi' DIŞINDAKİ her şey (Bekliyor + eski kayıtlardaki
  // 'Otomatik Kapatıldı (Vardiya)' gibi statüler) bu listeye girer.
  const pendingApprovals = useMemo(() => {
      if (currentUser.email !== SUPER_ADMIN_EMAIL) return [];
      const empById = new Map(allEmployees.map(e => [e.id, e]));
      const q = approvalsSearch.trim().toLowerCase();
      return timeLogs
          .filter(l => l.status !== 'Onaylandı' && l.status !== 'Reddedildi')
          .map(l => ({ log: l, emp: empById.get(l.employeeId) }))
          .filter(({ emp }) => {
              if (!q) return true;
              if (!emp) return false;
              return emp.name.toLowerCase().includes(q) || (emp.email || '').toLowerCase().includes(q);
          })
          .sort((a, b) => {
              const dc = b.log.date.localeCompare(a.log.date);
              if (dc !== 0) return dc;
              return (b.log.startTime || '').localeCompare(a.log.startTime || '');
          });
  }, [timeLogs, allEmployees, approvalsSearch, currentUser.email]);

  // === TELEFON ÇAKIŞMASI TESPİTİ ===
  // Her kullanıcının QR girişlerinden cihaz frekanslarını çıkar. ≥3 kez
  // kullanılan en sık cihaz "baskın cihaz" sayılır. Yeni bir kayıt baskın
  // cihazdan farklıysa "Telefon çakışması" — başkasının şifresiyle başka
  // telefondan giriş yapılmış olabilir, manuel inceleme gerekir.
  const deviceConflicts = useMemo(() => {
    const userDeviceCounts = new Map<string, Map<string, number>>();
    timeLogs.forEach(log => {
      if (log.method !== 'qr' || !log.deviceInfo) return;
      if (!userDeviceCounts.has(log.employeeId)) userDeviceCounts.set(log.employeeId, new Map());
      const counts = userDeviceCounts.get(log.employeeId)!;
      counts.set(log.deviceInfo, (counts.get(log.deviceInfo) || 0) + 1);
    });

    const dominant = new Map<string, string>();
    userDeviceCounts.forEach((counts, userId) => {
      const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      // Min 3 kayıt + diğer cihazlardan en az 2 kat fazla → "alışılmış cihaz"
      if (sorted[0] && sorted[0][1] >= 3) {
        const second = sorted[1]?.[1] || 0;
        if (sorted[0][1] >= second * 2 || second === 0) dominant.set(userId, sorted[0][0]);
      }
    });

    const conflicts = new Map<string, { expected: string }>();
    timeLogs.forEach(log => {
      if (log.method !== 'qr' || !log.deviceInfo) return;
      const expected = dominant.get(log.employeeId);
      if (expected && expected !== log.deviceInfo) {
        conflicts.set(log.id, { expected });
      }
    });
    return conflicts;
  }, [timeLogs]);

  // === FİNANSAL ÖZET — BORDRO'DA ONAYLANAN SAATLER ÜZERİNDEN HAFTALIK HESAP ===
  // Ödeme: time_logs.status === 'Onaylandı' kayıtları baz alınır.
  // Bekliyor / Reddedildi durumundaki saatler hesaba dahil edilmez.
  // Periyot: Pzt → Paz (Vardiya Planı sekmesindeki ile aynı haftalık model).
  const getMonday = (d: Date): Date => {
      const date = new Date(d);
      const day = date.getDay();
      const diff = date.getDate() - day + (day === 0 ? -6 : 1);
      date.setHours(0, 0, 0, 0);
      date.setDate(diff);
      return date;
  };

  const [currentWeekStart, setCurrentWeekStart] = useState<Date>(() => getMonday(new Date()));
  const fmtDate = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const currentWeekEnd = useMemo(() => {
      const e = new Date(currentWeekStart);
      e.setDate(e.getDate() + 6);
      return e;
  }, [currentWeekStart]);

  const handleWeekShift = (delta: -1 | 0 | 1) => {
      if (delta === 0) {
          setCurrentWeekStart(getMonday(new Date()));
          return;
      }
      const next = new Date(currentWeekStart);
      next.setDate(next.getDate() + delta * 7);
      setCurrentWeekStart(getMonday(next));
  };

  // Haftanın 7 günü için "YYYY-MM-DD" string'leri (filtre için)
  const weekDates = useMemo(() => {
      const arr: string[] = [];
      for (let i = 0; i < 7; i++) {
          const d = new Date(currentWeekStart);
          d.setDate(d.getDate() + i);
          arr.push(fmtDate(d));
      }
      return arr;
  }, [currentWeekStart]);

  // targetEmployee'in TÜM kayıtları (Onaylandı + Bekliyor + Reddedildi) — alt listede gösterilir.
  const allEmployeeLogs = useMemo(() => {
      if (!targetEmployeeId) return [] as TimeLog[];
      return timeLogs
          .filter(l => l.employeeId === targetEmployeeId)
          .sort((a, b) => b.date.localeCompare(a.date)); // en yeni üstte
  }, [timeLogs, targetEmployeeId]);

  // Onaylanmış alt küme (toplama dahil olanlar)
  const allApprovedLogs = useMemo(
      () => allEmployeeLogs.filter(l => l.status === 'Onaylandı'),
      [allEmployeeLogs]
  );

  // Seçili haftadaki onaylanmış kayıtlar (haftalık ödeme stat kartı için)
  const weeklyApprovedLogs = useMemo(
      () => allApprovedLogs.filter(l => weekDates.includes(l.date)),
      [allApprovedLogs, weekDates]
  );

  // Bordro / Çalışma Geçmişi: seçili haftadaki TÜM kayıtlar (status filtresiz)
  const weeklyLogs = useMemo(
      () => allEmployeeLogs.filter(l => weekDates.includes(l.date)),
      [allEmployeeLogs, weekDates]
  );

  // Personelin shift_schedules'taki tüm haftalardaki atamaları — Çalışma Geçmişi
  // kartlarında "Plan: 06-14" rozeti olarak gösterilir. Plan vs gerçek karşılaştırması.
  const [employeeSchedules, setEmployeeSchedules] = useState<Array<{
      weekKey: string;
      timeSlot: string;
      days: string[];
  }>>([]);

  useEffect(() => {
      if (!targetEmployeeId) { setEmployeeSchedules([]); return; }
      let cancelled = false;
      void (async () => {
          try {
              const { data, error } = await supabase
                  .from('shift_schedules')
                  .select('week_start_date, time_slot, days');
              if (cancelled || error || !Array.isArray(data)) return;
              const rows = data
                  .filter((r: any) => Array.isArray(r.days) && r.days.includes(targetEmployeeId))
                  .map((r: any) => ({
                      weekKey: r.week_start_date as string,
                      timeSlot: (r.time_slot as string) || '',
                      days: r.days as string[],
                  }));
              setEmployeeSchedules(rows);
          } catch (err) {
              console.warn('[Payroll] shift_schedules fetch error:', err);
          }
      })();
      return () => { cancelled = true; };
  }, [targetEmployeeId]);

  // Tarih → planlı time_slot listesi map'i. Bir kişi bir günde birden fazla
  // slot'a atanmışsa ['06-14', '16-20'] gibi liste döner.
  const plannedSlotsByDate = useMemo<Map<string, string[]>>(() => {
      const map = new Map<string, string[]>();
      if (!targetEmployeeId) return map;
      employeeSchedules.forEach(s => {
          if (!s.timeSlot || !Array.isArray(s.days)) return;
          // week_start_date'i lokal saat ile parse et — Payroll'daki fmtDate
          // (line 353) ile aynı YYYY-MM-DD formatına dönüştür.
          const monday = new Date(s.weekKey + 'T00:00:00');
          if (Number.isNaN(monday.getTime())) return;
          s.days.forEach((eid, dayIdx) => {
              if (eid !== targetEmployeeId) return;
              const target = new Date(monday);
              target.setDate(target.getDate() + dayIdx);
              const dateStr = fmtDate(target);
              const list = map.get(dateStr) || [];
              list.push(s.timeSlot);
              map.set(dateStr, list);
          });
      });
      return map;
  }, [employeeSchedules, targetEmployeeId]);

  // Bekleyen kayıt sayısı — kullanıcının onay bekleyen iş yüküne dair bilgi (uyarı şeridi).
  const pendingLogsCount = useMemo(
      () => allEmployeeLogs.filter(l => l.status !== 'Onaylandı' && l.status !== 'Reddedildi').length,
      [allEmployeeLogs]
  );

  const plannedPayrollStats = useMemo(() => {
      const approvedHours = weeklyApprovedLogs.reduce((acc, l) => acc + (l.totalHours || 0), 0);
      const shiftCount = weeklyApprovedLogs.length;
      const hourlyRate = targetEmployee?.hourlyRate || 0;
      const grossPay = approvedHours * hourlyRate;
      const totalApprovedHours = allApprovedLogs.reduce((acc, l) => acc + (l.totalHours || 0), 0);
      const totalApprovedGross = totalApprovedHours * hourlyRate;
      return { approvedHours, shiftCount, grossPay, totalApprovedHours, totalApprovedGross, totalApprovedCount: allApprovedLogs.length };
  }, [weeklyApprovedLogs, allApprovedLogs, targetEmployee]);


  // --- CRUD İŞLEMLERİ ---

  useEffect(() => {
    if (selectedEmployeeForDetail && !isEditing && selectedEmployeeId !== 'NEW') {
        setEditForm(JSON.parse(JSON.stringify(selectedEmployeeForDetail)));
    }
  }, [selectedEmployeeForDetail, isEditing, selectedEmployeeId]);

  // Transfer geçmişini yükle
  useEffect(() => {
    if (!selectedEmployeeId || selectedEmployeeId === 'NEW') { setTransferHistory([]); return; }
    const fetchTransferHistory = async () => {
        const { data } = await supabase
            .from('personnel_transfers')
            .select('*')
            .eq('employee_id', selectedEmployeeId)
            .order('start_date', { ascending: false })
            .order('start_time', { ascending: true });
        setTransferHistory(data || []);
    };
    fetchTransferHistory();
  }, [selectedEmployeeId]);

  const handleSelectEmployee = (id: string) => {
    if(isEditing && selectedEmployeeId !== id) {
        if (!window.confirm(t('pay.unsavedChanges'))) return;
    }
    setIsEditing(false);
    setEditForm({});
    setSelectedEmployeeId(id);
  };

  const handleAddNew = () => {
      setIsEditing(true);
      setSelectedEmployeeId('NEW');
      setCurrentTab('STAFF');
      setEditForm({
          name: '', email: '', role: Role.STAFF, hourlyRate: 15.0,
          avatarUrl: `https://ui-avatars.com/api/?name=Yeni+Personel&background=random`,
          bio: ''
      });
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setIsLoading(true);
      try {
          const fileExt = file.name.split('.').pop();
          const fileName = `${Math.random()}.${fileExt}`;
          const filePath = `${fileName}`;

          const { error: uploadError } = await supabase.storage
              .from('avatars')
              .upload(filePath, file);

          if (uploadError) {
              throw uploadError;
          }

          const { data } = supabase.storage.from('avatars').getPublicUrl(filePath);
          
          // Delete old avatar if it exists and is from supabase storage
          if (editForm.avatarUrl && editForm.avatarUrl.includes('/storage/v1/object/public/avatars/')) {
              try {
                  const oldFileName = editForm.avatarUrl.split('/avatars/').pop();
                  if (oldFileName) {
                      await supabase.storage.from('avatars').remove([oldFileName]);
                  }
              } catch (e) {
                  console.error('Eski fotoğraf silinirken hata oluştu:', e);
              }
          }

          setEditForm({ ...editForm, avatarUrl: data.publicUrl });
      } catch (error: any) {
          console.error('Error uploading avatar:', error);
          alert(t('pay.imageError') + ': ' + error.message);
      } finally {
          setIsLoading(false);
      }
  };

  const handleSave = async () => {
      const isAdminUser = currentUser.role === Role.ADMIN;

      // Admin tüm alanları zorunlu doldursun; personel self-edit ise sadece
      // telefon/bio güncellediği için isim/email validasyonunu atla.
      if (isAdminUser && (!editForm.name?.trim() || !editForm.email?.trim())) {
          alert(t('pay.nameEmailRequired'));
          return;
      }

      setIsLoading(true);
      const dbData: Record<string, any> = isAdminUser
          ? {
              full_name: editForm.name,
              email: editForm.email,
              role: editForm.role,
              hourly_rate: editForm.hourlyRate,
              avatar_url: editForm.avatarUrl,
              phone: editForm.phone,
              bio: editForm.bio,
          }
          : {
              // Personel kendi profilinde sadece iletişim/bio düzenleyebilir
              phone: editForm.phone,
              bio: editForm.bio,
          };

      try {
          if (selectedEmployeeId === 'NEW') {
              // Supabase Insert Denemesi - varsayılan şifre ile
              const defaultPassword = 'Bac123+';
              const { data, error } = await supabase.from('profiles').insert([{ ...dbData, password: defaultPassword }]).select();

              if(error) throw error;

              if(data) {
                  const newEmp = { ...editForm, id: data[0].id } as Employee;
                  setEmployees([...employees, newEmp]);
                  setSelectedEmployeeId(data[0].id);

                  // Bildirim: Yeni personel eklendi ve şifre gösterildi
                  onNotify({
                      id: `notif_${Date.now()}`,
                      type: 'INFO',
                      title: 'Yeni Personel Eklendi',
                      message: `${editForm.name} (${editForm.email}) başarıyla eklendi. Varsayılan şifre: ${defaultPassword}`,
                      timestamp: new Date().toISOString(),
                  });
              }
          } else {
              // Supabase Update Denemesi
              const { error } = await supabase.from('profiles').update(dbData).eq('id', selectedEmployeeId);
              
              if(error) throw error;
              
              // Admin mi personel mi kontrol et ve doğru state'i güncelle
              const isAdminEmployee = adminEmployees.some(a => a.id === selectedEmployeeId);
              if (isAdminEmployee) {
                  setAdminEmployees(adminEmployees.map(e => e.id === selectedEmployeeId ? { ...e, ...editForm } as Employee : e));
              } else {
                  setEmployees(employees.map(e => e.id === selectedEmployeeId ? { ...e, ...editForm } as Employee : e));
              }
          }
          alert(t('common.success'));
      } catch (err: any) {
          console.warn("Veritabanı bağlantı hatası, yerel modda devam ediliyor:", err);

          // --- FALLBACK: YEREL KAYIT ---
          if (selectedEmployeeId === 'NEW') {
              const tempId = `local_${Date.now()}`;
              const defaultPassword = 'Bac123+';
              const newEmp = { ...editForm, id: tempId } as Employee;
              setEmployees([...employees, newEmp]);
              setSelectedEmployeeId(tempId);

              onNotify({
                  id: `notif_${Date.now()}`,
                  type: 'INFO',
                  title: 'Yeni Personel Eklendi (Yerel)',
                  message: `${editForm.name} (${editForm.email}) eklendi. Varsayılan şifre: ${defaultPassword}`,
                  timestamp: new Date().toISOString(),
              });
          } else {
              const isAdminEmployee = adminEmployees.some(a => a.id === selectedEmployeeId);
              if (isAdminEmployee) {
                  setAdminEmployees(adminEmployees.map(e => e.id === selectedEmployeeId ? { ...e, ...editForm } as Employee : e));
              } else {
                  setEmployees(employees.map(e => e.id === selectedEmployeeId ? { ...e, ...editForm } as Employee : e));
              }
          }
          alert(t('pay.dbOfflineSave'));
      } finally {
          setIsEditing(false);
          setIsLoading(false);
      }
  };

  const handleTransfer = async () => {
      if(!selectedEmployeeForDetail) return;
      if(!transferDates.startDate || !transferDates.endDate) {
          alert(t('pay.dateRangeRequired'));
          return;
      }
      if(transferDates.endDate < transferDates.startDate) {
          alert(t('pay.endBeforeStart'));
          return;
      }

      setIsLoading(true);

      try {
          // 1. personnel_transfers tablosuna atama kaydı ekle
          const { error: transferError } = await supabase.from('personnel_transfers').insert([{
              employee_id: selectedEmployeeForDetail.id,
              from_branch: 'Havuz',
              to_branch: targetBranch,
              start_date: transferDates.startDate,
              end_date: transferDates.endDate,
              start_time: transferDates.startTime || '08:00',
              end_time: transferDates.endTime || '18:00',
              status: 'active',
              created_by: currentUser.id
          }]);
          if (transferError) throw transferError;

          // 2. Takvimde görünürlük için calendar_events kaydı oluştur
          const transferEvent = {
              title: `${selectedEmployeeForDetail.name} -> ${targetBranch}`,
              type: 'Şube Transferi',
              date: transferDates.startDate,
              end_date: transferDates.endDate,
              start_time: transferDates.startTime || '08:00',
              end_time: transferDates.endTime || '18:00',
              attendees: [selectedEmployeeForDetail.id],
              description: `Yeni Çalışma Şubeniz: ${targetBranch}`
          };
          await supabase.from('calendar_events').insert([transferEvent]);

          // 3. Bildirim gönder
          onNotify({
              id: `notif_${Date.now()}`,
              type: 'TRANSFER',
              title: t('dash.transferAlert'),
              message: `${selectedEmployeeForDetail.name}: Yeni Çalışma Şubeniz: ${targetBranch} (${transferDates.startDate} - ${transferDates.endDate})`,
              timestamp: new Date().toISOString(),
              recipientId: selectedEmployeeForDetail.id
          });

          setShowTransferModal(false);

          // Transfer geçmişini yeniden yükle
          const { data: updatedHistory } = await supabase
              .from('personnel_transfers')
              .select('*')
              .eq('employee_id', selectedEmployeeForDetail.id)
              .order('start_date', { ascending: false });
          setTransferHistory(updatedHistory || []);

          alert(t('common.success'));

      } catch (err: any) {
          console.warn("Transfer hatası (Demo modunda devam):", err);
          // Fallback bildirim
          onNotify({
              id: `notif_${Date.now()}`,
              type: 'TRANSFER',
              title: 'Personel Transferi (Demo)',
              message: `${selectedEmployeeForDetail.name}: Yeni Çalışma Şubeniz: ${targetBranch} (Demo mod)`,
              timestamp: new Date().toISOString(),
              recipientId: selectedEmployeeForDetail.id
          });
          setShowTransferModal(false);
      } finally {
          setIsLoading(false);
      }
  };

  const handleDelete = async () => {
      if(!confirm(t('pay.deleteConfirm'))) return;
      setIsLoading(true);
      try {
          const { error } = await supabase.from('profiles').delete().eq('id', selectedEmployeeId);
          if(error) throw error;
          
          // Başarılı olursa state'den sil (admin veya personel)
          const isAdminDel = adminEmployees.some(a => a.id === selectedEmployeeId);
          if (isAdminDel) {
              setAdminEmployees(adminEmployees.filter(e => e.id !== selectedEmployeeId));
          } else {
              setEmployees(employees.filter(e => e.id !== selectedEmployeeId));
          }
          setSelectedEmployeeId(null);
          setIsEditing(false);
      } catch (err: any) {
          console.warn("Silme hatası, yerel modda devam ediliyor:", err);

          // --- FALLBACK: YEREL SİLME ---
          const isAdminDel = adminEmployees.some(a => a.id === selectedEmployeeId);
          if (isAdminDel) {
              setAdminEmployees(adminEmployees.filter(e => e.id !== selectedEmployeeId));
          } else {
              setEmployees(employees.filter(e => e.id !== selectedEmployeeId));
          }
          setSelectedEmployeeId(null);
          setIsEditing(false);

          alert(t('pay.dbOfflineDelete'));
      } finally {
          setIsLoading(false);
      }
  };

  const handleSaveTimeLog = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!targetEmployeeId) return;

      setIsLoading(true);

      // Saatler değiştiğinde total_hours otomatik yeniden hesaplanır.
      const start = new Date(`1970-01-01T${timeForm.startTime}:00`);
      const end = new Date(`1970-01-01T${timeForm.endTime}:00`);
      let diffMs = end.getTime() - start.getTime();
      if (diffMs < 0) diffMs += 24 * 60 * 60 * 1000;
      const diffMins = Math.floor(diffMs / 60000);
      const netMins = diffMins - (timeForm.breakDuration || 0);
      const totalHours = Math.max(0, Number((netMins / 60).toFixed(2)));

      // --- DÜZELTME MODU: Mevcut kaydı güncelle ---
      if (editingLogId) {
          const existing = timeLogs.find(l => l.id === editingLogId);
          // QR kaydında check_out_at boşsa "Sürüyor" rozeti gösteriliyor.
          // Admin manuel saat girince vardiyayı kapanmış sayalım: check_out_at'i de set et.
          let checkOutAtUpdate: string | undefined;
          if (existing && existing.method === 'qr' && !existing.checkOutAt) {
              const synth = new Date(`${timeForm.date}T${timeForm.endTime}:00`);
              if (!isNaN(synth.getTime())) checkOutAtUpdate = synth.toISOString();
          }

          const updates: Record<string, unknown> = {
              date: timeForm.date,
              start_time: timeForm.startTime,
              end_time: timeForm.endTime,
              break_duration: timeForm.breakDuration || 0,
              total_hours: totalHours,
              branch: timeForm.branch,
          };
          if (checkOutAtUpdate) updates.check_out_at = checkOutAtUpdate;

          try {
              const { error } = await supabase.from('time_logs').update(updates).eq('id', editingLogId);
              if (error) throw error;
          } catch (err) {
              console.warn('Saat güncelleme hatası (yerel güncelleme yapılıyor):', err);
              alert(t('pay.dbErrorLocal'));
          }

          // Optimistic local update — realtime event de gelecek ama UI'yi anında tazelemek için.
          setTimeLogs(prev => prev.map(log => log.id === editingLogId ? {
              ...log,
              date: timeForm.date,
              startTime: timeForm.startTime,
              endTime: timeForm.endTime,
              breakDuration: timeForm.breakDuration || 0,
              totalHours,
              branch: timeForm.branch,
              checkOutAt: checkOutAtUpdate || log.checkOutAt,
          } : log));
          setShowTimeModal(false);
          setEditingLogId(null);
          setIsLoading(false);
          return;
      }

      // --- YENİ KAYIT MODU ---
      try {
          const newLogDb = {
              employee_id: targetEmployeeId,
              date: timeForm.date,
              start_time: timeForm.startTime,
              end_time: timeForm.endTime,
              break_duration: timeForm.breakDuration,
              total_hours: totalHours,
              branch: timeForm.branch,
              status: currentUser.role === Role.ADMIN ? 'Onaylandı' : 'Bekliyor',
          };

          const { data, error } = await supabase.from('time_logs').insert([newLogDb]).select();
          if(error) throw error;

          if(data) {
              const newLogFrontend: TimeLog = {
                  id: data[0].id,
                  employeeId: targetEmployeeId,
                  date: timeForm.date,
                  startTime: timeForm.startTime,
                  endTime: timeForm.endTime,
                  breakDuration: timeForm.breakDuration,
                  totalHours: totalHours,
                  status: newLogDb.status as any,
                  branch: timeForm.branch
              };
              setTimeLogs([newLogFrontend, ...timeLogs]);
              setShowTimeModal(false);
              alert(t('common.success'));

              // Kiosk haricinde (manuel) mesai kaydı → admin'e push
              const targetEmp = employees.find(e => e.id === targetEmployeeId);
              notifyEvent({
                  type: 'non_kiosk_check',
                  employee_id: targetEmployeeId,
                  employee_name: targetEmp?.name || 'Personel',
                  branch: timeForm.branch,
                  action: 'in',
              });
          }
      } catch (err: any) {
           console.warn("Saat kaydetme hatası (Yerel Mod Devrede):", err);

           // --- FALLBACK: Foreign Key veya Ağ Hatasında Yerel Ekleme ---
           const newLogFrontend: TimeLog = {
                id: `local_log_${Date.now()}`,
                employeeId: targetEmployeeId,
                date: timeForm.date,
                startTime: timeForm.startTime,
                endTime: timeForm.endTime,
                breakDuration: timeForm.breakDuration,
                totalHours: totalHours,
                status: currentUser.role === Role.ADMIN ? 'Onaylandı' : 'Bekliyor',
                branch: timeForm.branch
           };
           setTimeLogs([newLogFrontend, ...timeLogs]);
           setShowTimeModal(false);

           // Özel Hata Mesajı: Foreign Key Violation
           if (err.code === '23503') {
               alert(t('pay.demoWarning'));
           } else {
               alert(t('pay.dbErrorLocal'));
           }
      } finally {
          setIsLoading(false);
      }
  };

  const handleStatusChange = async (logId: string, newStatus: 'Onaylandı' | 'Reddedildi') => {
    try {
        const { error } = await supabase.from('time_logs').update({ status: newStatus }).eq('id', logId);
        if(error) throw error;
        setTimeLogs(prev => prev.map(log => log.id === logId ? { ...log, status: newStatus } : log));
    } catch (err: any) {
        // Fallback for status change
        setTimeLogs(prev => prev.map(log => log.id === logId ? { ...log, status: newStatus } : log));
    }
  };

  // === FAZLA MESAİ BİLDİR ===
  // Personel sadece kendi auto-close edilmiş vardiyasına ek dakika
  // bildirebilir. RPC: request_overtime(log_id, minutes).
  const handleOpenOvertimeModal = (log: TimeLog) => {
      if (!log.autoClosedAt) {
          alert(t('pay.overtimeOnlyForAutoClosed') || 'Sadece otomatik kapatılan vardiyalar için bildirim yapılabilir.');
          return;
      }
      if (log.employeeId !== currentUser.id) {
          alert(t('pay.overtimeOwnRecordOnly') || 'Sadece kendi kaydınız için bildirim yapabilirsiniz.');
          return;
      }
      setOvertimeLogId(log.id);
      setOvertimeMinutes(60);
  };

  const handleSubmitOvertime = async () => {
      if (!overtimeLogId) return;
      if (!Number.isFinite(overtimeMinutes) || overtimeMinutes < 1 || overtimeMinutes > 720) {
          alert(t('pay.overtimeRangeError') || 'Süre 1 ile 720 dakika arasında olmalı.');
          return;
      }
      setOvertimeSubmitting(true);
      try {
          const { data, error } = await supabase.rpc('request_overtime', {
              p_log_id: overtimeLogId,
              p_minutes: overtimeMinutes,
          });
          if (error) throw error;

          // Optimistic UI: dakika ekle, status='Bekliyor', total_hours güncelle
          setTimeLogs(prev => prev.map(log => {
              if (log.id !== overtimeLogId) return log;
              const newTotal = (data as any)?.new_total_hours ?? log.totalHours;
              const newCheckOut = (data as any)?.new_check_out_at ?? log.checkOutAt;
              const endLocal = newCheckOut
                  ? new Date(newCheckOut).toLocaleTimeString('de-DE', {
                        hour: '2-digit', minute: '2-digit',
                        timeZone: 'Europe/Berlin', hour12: false,
                    })
                  : log.endTime;
              return {
                  ...log,
                  status: 'Bekliyor',
                  totalHours: Number(newTotal) || log.totalHours,
                  checkOutAt: newCheckOut,
                  endTime: endLocal,
                  overtimeMinutes: (log.overtimeMinutes || 0) + overtimeMinutes,
                  overtimeRequestedAt: new Date().toISOString(),
              };
          }));

          alert(t('pay.overtimeSubmitted') || 'Fazla mesai bildirimi adminin onayına gönderildi.');
          setOvertimeLogId(null);
      } catch (err: any) {
          console.error('[overtime] hata:', err);
          alert((t('pay.overtimeError') || 'Fazla mesai bildirimi başarısız') + ': ' + (err?.message || ''));
      } finally {
          setOvertimeSubmitting(false);
      }
  };

  const handleDeleteTimeLog = async (logId: string) => {
    try {
        const { error } = await supabase.from('time_logs').delete().eq('id', logId);
        if(error) throw error;
        setTimeLogs(prev => prev.filter(log => log.id !== logId));
    } catch (err: any) {
        console.error('Error deleting time log:', err);
        // Fallback for delete
        setTimeLogs(prev => prev.filter(log => log.id !== logId));
    }
  };

  const handleOpenTimeModal = () => {
      if (!targetEmployee && currentUser.role === Role.ADMIN) {
          alert(t('pay.selectStaffFirst'));
          return;
      }
      setEditingLogId(null);
      setTimeForm({
          date: new Date().toISOString().split('T')[0],
          startTime: '09:00',
          endTime: '17:00',
          breakDuration: 0,
          branch: Branch.DOM
      });
      setShowTimeModal(true);
  };

  // Admin → mevcut bir mesai kaydını düzeltmek için modal açar.
  // Saatler değiştirilince kaydet sırasında total_hours otomatik yeniden hesaplanır.
  const handleOpenEditTimeLog = (log: TimeLog) => {
      // Düzenlenen kaydın personeline odaklan ki targetEmployeeId tutarlı olsun.
      if (log.employeeId && log.employeeId !== selectedEmployeeId) {
          setSelectedEmployeeId(log.employeeId);
      }
      setEditingLogId(log.id);
      setTimeForm({
          date: log.date || new Date().toISOString().split('T')[0],
          startTime: log.startTime || '09:00',
          endTime: log.endTime || '17:00',
          breakDuration: log.breakDuration || 0,
          branch: (log.branch as Branch) || Branch.DOM,
      });
      setShowTimeModal(true);
  };

  const handleCloseTimeModal = () => {
      setShowTimeModal(false);
      setEditingLogId(null);
  };

  // --- RENDERERS ---

  // 1. FINANCIAL CONTENT (NEW TAB)
  const renderFinancialContent = () => {
      if (!targetEmployee) return <div className="h-full flex items-center justify-center text-slate-500 dark:text-zinc-500"><p>{t('pay.selectStaff')}</p></div>;
      
      return (
          // MODIFIED: Changed justify-start md:justify-center to justify-start and items-stretch to force full width
          // Mobil: alt nav bar (h-16 + güvenli alan) içeriği örtmesin diye pb-28 verildi.
          <div className="h-full flex flex-col items-stretch justify-start p-4 pb-28 md:p-6 md:pb-6 bg-slate-50 dark:bg-zinc-950 overflow-y-auto overscroll-contain">
              {/* MODIFIED: Removed max-w-lg to allow full width */}
              <div className="w-full bg-white dark:bg-gradient-to-br dark:from-zinc-900 dark:to-black border border-slate-200 dark:border-zinc-800 rounded-3xl shadow-2xl overflow-hidden relative">
                  {/* Decorative Background — sadece dark modda görünür (light'ta tamamen beyaz kart) */}
                  <div className="hidden dark:block absolute top-0 right-0 w-64 h-64 bg-emerald-900/10 rounded-full blur-[80px] pointer-events-none"></div>
                  
                  <div className="p-8 relative z-10">
                      {/* Header */}
                      <div className="flex items-center gap-5 border-b border-slate-200 dark:border-zinc-800 pb-6 mb-6">
                          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-lg shadow-emerald-900/40">
                              <Wallet size={32} className="text-slate-900 dark:text-white" />
                          </div>
                          <div className="flex-1 min-w-0">
                              <h2 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">{t('pay.tabFinancial')}</h2>
                              <p className="text-sm text-slate-600 dark:text-zinc-400 mt-1">
                                  <span className="text-emerald-400 font-medium">{t('pay.weeklyPeriod')}</span> • {targetEmployee.name}
                              </p>
                          </div>
                      </div>

                      {/* Hafta navigasyonu — Vardiya Planı sekmesindeki ile aynı UX */}
                      <div className="flex items-center justify-between gap-2 mb-6 p-2 bg-white dark:bg-zinc-900/40 rounded-xl border border-slate-200 dark:border-zinc-800">
                          <button onClick={() => handleWeekShift(-1)} className="p-2 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors" aria-label={t('pay.prevWeek')}>
                              <ChevronLeft size={18} />
                          </button>
                          <div className="flex-1 text-center min-w-0">
                              <div className="text-sm font-bold text-slate-900 dark:text-white truncate">
                                  {formatDate(fmtDate(currentWeekStart), { day: 'numeric', month: 'short' })} – {formatDate(fmtDate(currentWeekEnd), { day: 'numeric', month: 'short', year: 'numeric' })}
                              </div>
                              <button onClick={() => handleWeekShift(0)} className="text-[10px] uppercase tracking-wider text-indigo-400 hover:text-indigo-300 transition-colors mt-0.5">
                                  {t('pay.thisWeek')}
                              </button>
                          </div>
                          <button onClick={() => handleWeekShift(1)} className="p-2 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors" aria-label={t('pay.nextWeek')}>
                              <ChevronRight size={18} />
                          </button>
                      </div>

                      {/* Stats Grid — Bordro'da onaylanan saatler */}
                      <div className="space-y-6">
                          <div className="grid grid-cols-2 gap-4">
                              <div className="p-4 bg-emerald-900/10 rounded-xl border border-emerald-500/20">
                                  <p className="text-xs text-emerald-400/80 mb-1">{t('pay.approvedHoursWeek')}</p>
                                  <p className="text-xl font-bold text-emerald-300">{formatHoursHumanTR(plannedPayrollStats.approvedHours)}</p>
                              </div>
                              <div className="p-4 bg-white dark:bg-zinc-900/50 rounded-xl border border-slate-200 dark:border-zinc-800">
                                  <p className="text-xs text-slate-500 dark:text-zinc-500 mb-1">{t('pay.shiftCount')}</p>
                                  <p className="text-xl font-bold text-slate-900 dark:text-white">{plannedPayrollStats.shiftCount}</p>
                              </div>
                          </div>

                          {/* Onay bekleyen kayıt uyarısı — admin onaylayınca otomatik toplama dahil olur */}
                          {pendingLogsCount > 0 && (
                              <div className="p-3 bg-amber-900/10 border border-amber-500/30 rounded-xl flex items-center gap-2 text-xs text-amber-300">
                                  <AlertTriangle size={14} className="shrink-0" />
                                  <span>
                                      {t('pay.pendingNotice').replace('{count}', String(pendingLogsCount))}
                                  </span>
                              </div>
                          )}

                          <div className="p-5 bg-white dark:bg-zinc-900/30 rounded-xl border border-slate-200 dark:border-zinc-800 space-y-3">
                              <div className="flex justify-between items-center text-sm">
                                  <span className="text-slate-600 dark:text-zinc-400">{t('pay.hourlyRate')}</span>
                                  <span className="text-slate-900 dark:text-white font-medium">€{(targetEmployee.hourlyRate || 0).toFixed(2)}</span>
                              </div>
                              <div className="text-[11px] text-slate-500 dark:text-zinc-500 italic pt-1 border-t border-slate-200 dark:border-zinc-800/60">
                                  {t('pay.basedOnApprovedLogs')}
                              </div>
                          </div>

                          <div className="border-t border-dashed border-slate-200 dark:border-zinc-800 pt-6">
                              <div className="flex justify-between items-end">
                                  <span className="text-sm font-bold text-slate-500 dark:text-zinc-500 uppercase tracking-widest">{t('pay.weeklyGross')}</span>
                                  <span className="text-4xl font-bold text-slate-900 dark:text-white tracking-tight">€{(plannedPayrollStats.grossPay || 0).toFixed(2)}</span>
                              </div>
                              {/* Tüm zamanlar onaylı toplamı — kıyas için */}
                              {plannedPayrollStats.totalApprovedCount > 0 && (
                                  <div className="flex justify-between items-center mt-2 text-[11px] text-slate-500 dark:text-zinc-500">
                                      <span>{t('pay.totalApprovedAllTime')}</span>
                                      <span className="font-medium tabular-nums">{formatHoursHumanTR(plannedPayrollStats.totalApprovedHours)} · €{(plannedPayrollStats.totalApprovedGross || 0).toFixed(2)}</span>
                                  </div>
                              )}
                          </div>

                          {/* Sadece seçili haftadaki kayıtlar — onaylı, bekleyen, reddedilen tek liste; toplama yalnızca 'Onaylandı' girer. */}
                          <div className="pt-4">
                              <div className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-zinc-500 mb-2 font-bold flex items-center justify-between">
                                  <span>{t('pay.workHistoryAll')} · {weeklyLogs.length}</span>
                                  <span className="text-emerald-400/80 normal-case font-medium">{weeklyApprovedLogs.length} {t('pay.approvedLower')}</span>
                              </div>
                              {weeklyLogs.length === 0 ? (
                                  <div className="p-4 bg-white dark:bg-zinc-900/40 rounded-lg border border-slate-200 dark:border-zinc-800 text-xs text-slate-500 dark:text-zinc-500 text-center italic">
                                      {t('pay.noLogsAtAll')}
                                  </div>
                              ) : (
                                  <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950/40 divide-y divide-zinc-800/60 md:max-h-[360px] md:overflow-y-auto md:custom-scrollbar">
                                      {weeklyLogs.map((l: TimeLog, i: number) => {
                                          const inCurrentWeek = weekDates.includes(l.date);
                                          const isApproved = l.status === 'Onaylandı';
                                          const isRejected = l.status === 'Reddedildi';
                                          // Approved + bu hafta → yeşil vurgu (haftalık ödemeye giren)
                                          // Approved + diğer hafta → nötr ama tutar yeşil
                                          // Bekleyen → genel sönük + amber badge
                                          // Reddedilen → kırmızı badge, üstü çizili
                                          const rowBg = isApproved && inCurrentWeek ? 'bg-emerald-900/10' : !isApproved && !isRejected ? 'bg-amber-900/5' : '';
                                          const dateColor = isApproved && inCurrentWeek ? 'text-emerald-300' : isRejected ? 'text-slate-400 dark:text-zinc-600 line-through' : isApproved ? 'text-slate-700 dark:text-zinc-300' : 'text-slate-600 dark:text-zinc-400';
                                          const hourColor = !isApproved ? 'text-slate-500 dark:text-zinc-500' : (inCurrentWeek ? 'text-emerald-300' : 'text-emerald-400/80');
                                          return (
                                              <div key={`${l.id}-${i}`} className={`flex items-center justify-between px-3 py-2 text-xs gap-2 ${rowBg}`}>
                                                  <div className="flex items-center gap-2 min-w-0 flex-1">
                                                      <span className={`font-medium tabular-nums w-20 shrink-0 ${dateColor}`}>{formatDate(l.date, { weekday: 'short', day: '2-digit', month: 'short' })}</span>
                                                      <span className="text-indigo-400 font-mono shrink-0">{l.startTime || '—'}–{l.endTime || '—'}</span>
                                                      <span className="text-slate-500 dark:text-zinc-500 truncate">{l.branch}</span>
                                                      {/* Status badge */}
                                                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide shrink-0 ${
                                                          isApproved ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-700/50'
                                                          : isRejected ? 'bg-red-900/20 text-red-400 border border-red-700/40'
                                                          : 'bg-amber-900/20 text-amber-400 border border-amber-700/40'
                                                      }`}>{l.status}</span>
                                                  </div>
                                                  <span className={`font-bold tabular-nums shrink-0 ${hourColor}`}>{formatHoursHumanTR(l.totalHours)}</span>
                                              </div>
                                          );
                                      })}
                                  </div>
                              )}
                              <div className="text-[10px] text-slate-400 dark:text-zinc-600 mt-2 italic">
                                  {t('pay.totalsApprovedOnly')}
                              </div>
                          </div>
                      </div>
                  </div>
              </div>
          </div>
      );
  };

  const renderStaffContent = () => {
    if (!selectedEmployeeForDetail) {
        return <div className="h-full flex flex-col items-center justify-center text-slate-400 dark:text-zinc-600"><p>Görüntülemek için bir profil seçin</p></div>;
    }
    return (
        <div className="flex h-full w-full flex-col bg-white dark:bg-black relative overflow-hidden">
            {/* Üst dekoratif gradient — sadece dark modda görünür */}
            <div className="hidden dark:block absolute top-0 w-full h-64 bg-gradient-to-b from-zinc-900 to-black pointer-events-none z-0"></div>
            <div className="relative z-10 flex-1 w-full overflow-y-auto min-h-0 pb-28 md:pb-0">
                <div className="sticky top-0 z-50 w-full flex items-center justify-between p-4 md:p-6 bg-gradient-to-b from-white/80 dark:from-black/80 to-transparent backdrop-blur-[2px]">
                    {/* Back Button for Admin on Mobile */}
                    <button 
                        onClick={() => setSelectedEmployeeId(null)}
                        className={`md:hidden p-2 rounded-lg bg-slate-100 dark:bg-zinc-800/50 text-slate-900 dark:text-white ${currentUser.role === Role.ADMIN ? 'block' : 'hidden'}`}
                    >
                        <ChevronLeft size={20} />
                    </button>
                    
                    <div className="flex gap-2 ml-auto">
                        {isEditing ? (
                            <>
                                <button onClick={() => setIsEditing(false)} className="px-4 py-2 text-sm bg-black/50 rounded-lg text-slate-600 dark:text-zinc-400">{t('tasks.cancel')}</button>
                                <button onClick={handleSave} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-slate-900 dark:text-white text-sm rounded-lg hover:bg-indigo-500">
                                    {isLoading ? <Loader2 className="animate-spin" size={16}/> : <Save size={16} />} {t('pay.save')}
                                </button>
                            </>
                        ) : (
                            currentUser.role === Role.ADMIN ? (
                                <>
                                    {/* DİKKAT ÇEKİCİ TRANSFER BUTONU */}
                                    <button
                                        onClick={() => { setTargetBranch(Branch.DOM); setShowTransferModal(true); }}
                                        className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-slate-900 dark:text-white text-sm font-bold rounded-xl transition-all shadow-[0_0_15px_rgba(249,115,22,0.4)] hover:shadow-[0_0_25px_rgba(249,115,22,0.6)] hover:scale-105 active:scale-95 border border-orange-400/20"
                                    >
                                        <ArrowRightLeft size={18} className="animate-pulse" />
                                        <span className="hidden md:inline uppercase tracking-wide">{t('pay.transferBtn')}</span>
                                        <span className="md:hidden">Transfer</span>
                                    </button>

                                    <div className="flex bg-white dark:bg-zinc-900 rounded-lg p-1 border border-slate-200 dark:border-zinc-800 ml-2">
                                        <button onClick={() => setIsEditing(true)} className="flex items-center gap-2 px-3 py-1.5 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-md transition-colors">
                                            <Edit2 size={16} />
                                        </button>
                                        <div className="w-px bg-slate-100 dark:bg-zinc-800 mx-1 my-1"></div>
                                        <button onClick={handleDelete} className="flex items-center gap-2 px-3 py-1.5 text-slate-600 dark:text-zinc-400 hover:text-red-400 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-md transition-colors">
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                </>
                            ) : (
                                // Personel kendi profilini görüyorsa: telefon/bio düzenleme butonu
                                selectedEmployeeForDetail?.id === currentUser.id && (
                                    <button
                                        onClick={() => setIsEditing(true)}
                                        className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors"
                                        title={t('pay.editMyProfile')}
                                    >
                                        <Edit2 size={16} />
                                        <span className="hidden sm:inline">{t('pay.editMyProfile')}</span>
                                    </button>
                                )
                            )
                        )}
                    </div>
                </div>

                <div className="px-4 md:px-8 pb-12 w-full -mt-4">
                     <div className="flex flex-col items-center mb-12">
                        <img src={(isEditing && currentUser.role === Role.ADMIN) ? editForm.avatarUrl : selectedEmployeeForDetail.avatarUrl} className="w-24 h-24 md:w-32 md:h-32 rounded-full border-4 border-black shadow-2xl object-cover" referrerPolicy="no-referrer" />
                        <div className="mt-6 text-center w-full space-y-2">
                            {isEditing && currentUser.role === Role.ADMIN ? (
                                <div className="flex flex-col gap-3 items-center w-full">
                                    <input value={editForm.name} onChange={(e) => setEditForm({...editForm, name: e.target.value})} className="text-3xl font-bold text-slate-900 dark:text-white bg-transparent border-b border-slate-300 dark:border-zinc-700 text-center w-full" placeholder="İsim" />
                                    <div className="flex gap-2">
                                        <select value={editForm.role} onChange={e=>setEditForm({...editForm, role: e.target.value as Role})} className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded px-2 py-1 text-sm text-slate-700 dark:text-zinc-300">{Object.values(Role).map(r=><option key={r} value={r}>{r}</option>)}</select>
                                    </div>
                                    <div className="flex flex-col gap-2 w-full">
                                        <input value={editForm.avatarUrl} onChange={e => setEditForm({...editForm, avatarUrl: e.target.value})} className="text-xs text-slate-600 dark:text-zinc-400 bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded px-3 py-1.5 w-full" placeholder="Avatar URL"/>
                                        <label className={`flex items-center justify-center gap-2 px-3 py-1.5 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 text-xs rounded cursor-pointer transition-colors w-full border border-slate-300 dark:border-zinc-700 ${isLoading ? 'opacity-50 pointer-events-none' : ''}`}>
                                            <Upload size={14} /> {isLoading ? 'Yükleniyor...' : 'Fotoğraf Yükle'}
                                            <input type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} disabled={isLoading} />
                                        </label>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <h1 className="text-2xl md:text-4xl font-bold text-slate-900 dark:text-white text-center">{selectedEmployeeForDetail.name}</h1>
                                    <div className="flex justify-center gap-3 text-slate-600 dark:text-zinc-400">
                                        <span className="text-sm">{selectedEmployeeForDetail.role}</span>
                                        <span className="text-sm flex items-center gap-1 text-emerald-400 bg-emerald-900/20 px-2 py-0.5 rounded border border-emerald-500/30">
                                            Havuz
                                        </span>
                                    </div>
                                </>
                            )}
                        </div>
                     </div>

                     {/* FULL WIDTH GRID LAYOUT */}
                     <div className="grid grid-cols-12 gap-6 w-full">
                        {/* LEFT COLUMN: Contact & About */}
                        <div className={`col-span-12 space-y-6 ${(currentUser.role === Role.ADMIN) ? 'xl:col-span-4' : 'xl:col-span-12 md:max-w-2xl md:mx-auto'}`}>
                            <div className="p-6 rounded-2xl bg-white dark:bg-zinc-900/30 border border-slate-200 dark:border-zinc-800/50">
                                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 opacity-50">{t('pay.contact')}</h3>
                                <div className="space-y-4">
                                    <div className="flex items-center gap-4"><Mail size={18} className="text-slate-600 dark:text-zinc-400 min-w-[18px]"/>{(isEditing && currentUser.role === Role.ADMIN) ? <input value={editForm.email} onChange={e=>setEditForm({...editForm, email:e.target.value})} className="bg-transparent border-b border-slate-300 dark:border-zinc-700 text-slate-900 dark:text-white w-full"/> : <span className="text-slate-700 dark:text-zinc-300 break-all">{selectedEmployeeForDetail.email}</span>}</div>
                                    <div className="flex items-center gap-4">
                                        <Phone size={18} className="text-slate-600 dark:text-zinc-400 min-w-[18px]"/>
                                        {isEditing ? (
                                            <input value={editForm.phone || ''} onChange={e=>setEditForm({...editForm, phone:e.target.value})} placeholder={t('payroll.phonePlaceholder')} className="bg-transparent border-b border-slate-300 dark:border-zinc-700 text-slate-900 dark:text-white w-full"/>
                                        ) : (
                                            <div className="flex items-center gap-2 flex-1 flex-wrap">
                                                <span className="text-slate-700 dark:text-zinc-300">{selectedEmployeeForDetail.phone || '-'}</span>
                                                {selectedEmployeeForDetail.phone && (
                                                    <>
                                                        <a
                                                            href={`tel:${selectedEmployeeForDetail.phone}`}
                                                            className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500 hover:text-white transition-colors"
                                                            title={t('pay.callPhone')}
                                                            aria-label={t('pay.callPhone')}
                                                        >
                                                            <Phone size={14} />
                                                        </a>
                                                        <a
                                                            href={`https://wa.me/${selectedEmployeeForDetail.phone.replace(/\D/g, '')}`}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500 hover:text-white transition-colors"
                                                            title={t('pay.whatsappContact')}
                                                            aria-label={t('pay.whatsappContact')}
                                                        >
                                                            <MessageCircle size={14} />
                                                        </a>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                    {/* HOURLY RATE: NOW VISIBLE TO ALL ADMINS */}
                                    {currentUser.role === Role.ADMIN && (
                                        <div className="flex items-center gap-4"><Calculator size={18} className="text-slate-600 dark:text-zinc-400 min-w-[18px]"/>{isEditing ? <input type="number" value={editForm.hourlyRate} onChange={e=>setEditForm({...editForm, hourlyRate:parseFloat(e.target.value)})} className="bg-transparent border-b border-slate-300 dark:border-zinc-700 text-slate-900 dark:text-white w-full"/> : <span className="text-slate-700 dark:text-zinc-300">€{selectedEmployeeForDetail.hourlyRate}</span>}</div>
                                    )}
                                </div>
                            </div>
                             <div className="p-6 rounded-2xl bg-white dark:bg-zinc-900/30 border border-slate-200 dark:border-zinc-800/50">
                                 <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 opacity-50">{t('pay.about')}</h3>
                                 {isEditing ? <textarea value={editForm.bio} onChange={e=>setEditForm({...editForm, bio:e.target.value})} className="w-full bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded p-2 text-sm text-slate-700 dark:text-zinc-300 min-h-[100px]"/> : <p className="text-sm text-slate-600 dark:text-zinc-400">{selectedEmployeeForDetail.bio || '...'}</p>}
                            </div>
                        </div>
                        
                        {/* RIGHT COLUMN: Transfer Geçmişi + Super Admin Panelleri */}
                        {currentUser.role === Role.ADMIN && (
                            <div className="col-span-12 xl:col-span-8 space-y-6">

                                {/* TRANSFER GÜNLÜĞÜ - HAFTALIK PLAN + GÜNLÜK DETAY */}
                                {currentUser.role === Role.ADMIN && transferHistory.length > 0 && (() => {
                                    // Aktif transferlerin kapsadığı tüm günleri hesapla
                                    const dayNames = ['Pz', 'Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct'];
                                    const today = new Date();
                                    // Haftanın başlangıcını bul (Pazartesi)
                                    const weekStart = new Date(today);
                                    const dayOfWeek = today.getDay();
                                    weekStart.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

                                    // Haftalık 7 gün oluştur
                                    const weekDays = Array.from({ length: 7 }, (_, i) => {
                                        const d = new Date(weekStart);
                                        d.setDate(weekStart.getDate() + i);
                                        return d.toISOString().split('T')[0];
                                    });

                                    // Her gün için o günü kapsayan transferleri bul
                                    const getTransfersForDay = (dateStr: string) => {
                                        return transferHistory.filter((tr: any) =>
                                            tr.status !== 'cancelled' && dateStr >= tr.start_date && dateStr <= tr.end_date
                                        );
                                    };

                                    // Günlük gruplandırma: Tüm transferleri tarihe göre grupla
                                    const allDates = new Set<string>();
                                    transferHistory.forEach((tr: any) => {
                                        const start = new Date(tr.start_date);
                                        const end = new Date(tr.end_date);
                                        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                                            allDates.add(d.toISOString().split('T')[0]);
                                        }
                                    });
                                    const sortedDates = Array.from(allDates).sort((a, b) => b.localeCompare(a));

                                    return (
                                    <div className="p-5 rounded-2xl bg-white dark:bg-zinc-900/30 border border-orange-800/30 animate-in fade-in">
                                        <h3 className="text-xs font-semibold text-orange-400 mb-4 flex items-center gap-2 uppercase tracking-wider">
                                            <ArrowRightLeft size={14} className="text-orange-500"/> Transfer Günlüğü ({transferHistory.length})
                                        </h3>

                                        {/* HAFTALIK PLAN ÜST BÖLÜM - TIKLANABILIR */}
                                        <div className="mb-5 p-3 rounded-xl bg-slate-50 dark:bg-zinc-950/50 border border-slate-200 dark:border-zinc-800/50">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-[10px] text-slate-500 dark:text-zinc-500 uppercase tracking-wider font-medium">Bu Hafta</span>
                                                {selectedTransferDay && (
                                                    <button onClick={() => setSelectedTransferDay(null)} className="text-[10px] text-orange-400 hover:text-orange-300 transition-colors">
                                                        Tümünü Göster
                                                    </button>
                                                )}
                                            </div>
                                            <div className="grid grid-cols-7 gap-1">
                                                {weekDays.map((dateStr, i) => {
                                                    const dayTransfers = getTransfersForDay(dateStr);
                                                    const isToday = dateStr === today.toISOString().split('T')[0];
                                                    const hasTransfer = dayTransfers.length > 0;
                                                    const isSelected = selectedTransferDay === dateStr;
                                                    const dayNum = new Date(dateStr).getDate();
                                                    return (
                                                        <button
                                                            key={dateStr}
                                                            onClick={() => hasTransfer ? setSelectedTransferDay(isSelected ? null : dateStr) : null}
                                                            className={`flex flex-col items-center p-1.5 rounded-lg transition-all ${hasTransfer ? 'cursor-pointer hover:scale-105' : 'cursor-default'} ${isSelected ? 'ring-2 ring-orange-500 bg-orange-900/50 shadow-lg shadow-orange-900/30' : isToday ? 'ring-1 ring-orange-500/50' : ''} ${hasTransfer && !isSelected ? 'bg-orange-950/40 hover:bg-orange-950/60' : !hasTransfer ? 'bg-white dark:bg-zinc-900/30' : ''}`}
                                                        >
                                                            <span className={`text-[9px] font-medium ${isSelected ? 'text-orange-300' : isToday ? 'text-orange-400' : 'text-slate-500 dark:text-zinc-500'}`}>{dayNames[(i + 1) % 7]}</span>
                                                            <span className={`text-xs font-bold mt-0.5 ${isSelected ? 'text-slate-900 dark:text-white' : isToday ? 'text-slate-900 dark:text-white' : hasTransfer ? 'text-orange-300' : 'text-slate-400 dark:text-zinc-600'}`}>{dayNum}</span>
                                                            {hasTransfer && (
                                                                <div className="flex gap-0.5 mt-1">
                                                                    {dayTransfers.slice(0, 3).map((tr: any) => (
                                                                        <div key={tr.id} className={`w-1.5 h-1.5 rounded-full ${isSelected ? 'bg-orange-300' : 'bg-orange-500'}`} title={`Yeni Çalışma Şubeniz: ${tr.to_branch}`}></div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        {/* GÜNLÜK DETAY - Seçili güne göre filtrelenir */}
                                        <div className="relative overflow-y-auto max-h-[350px] pr-1">
                                            <div className="absolute left-3 top-0 bottom-0 w-px bg-orange-800/40"></div>
                                            <div className="space-y-0">
                                                {(selectedTransferDay ? [selectedTransferDay] : sortedDates).map(dateStr => {
                                                    const dayTransfers = transferHistory.filter((tr: any) =>
                                                        dateStr >= tr.start_date && dateStr <= tr.end_date
                                                    ).sort((a: any, b: any) => (a.start_time || '00:00').localeCompare(b.start_time || '00:00'));
                                                    if (dayTransfers.length === 0) return null;
                                                    const isToday = dateStr === today.toISOString().split('T')[0];
                                                    const dateObj = new Date(dateStr);
                                                    const dayLabel = dateObj.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });

                                                    return (
                                                        <div key={dateStr} className="relative pl-8 pb-3">
                                                            {/* Timeline noktası */}
                                                            <div className={`absolute left-1.5 top-1.5 w-3 h-3 rounded-full border-2 ${isToday ? 'bg-orange-500 border-orange-400 shadow-[0_0_8px_rgba(249,115,22,0.6)]' : 'bg-slate-200 dark:bg-zinc-700 border-zinc-600'}`}></div>

                                                            {/* Gün başlığı */}
                                                            <div className={`text-[10px] font-bold mb-1.5 uppercase tracking-wider ${isToday ? 'text-orange-400' : 'text-slate-500 dark:text-zinc-500'}`}>
                                                                {isToday ? '● Bugün — ' : ''}{dayLabel}
                                                                <span className="text-slate-400 dark:text-zinc-600 normal-case ml-1">({dayTransfers.length} transfer)</span>
                                                            </div>

                                                            {/* O güne ait tüm transferler */}
                                                            <div className="space-y-1.5">
                                                                {dayTransfers.map((tr: any) => (
                                                                    <div key={tr.id} className={`p-2.5 rounded-lg border ${tr.status === 'active' ? 'bg-orange-950/30 border-orange-700/40' : 'bg-white dark:bg-zinc-900/30 border-slate-200 dark:border-zinc-800/50'}`}>
                                                                        <div className="flex items-center justify-between">
                                                                            <div className="flex items-center gap-1.5">
                                                                                <span className="text-[11px] text-slate-600 dark:text-zinc-400">Yeni Çalışma Şubeniz:</span>
                                                                                <span className="text-[11px] text-slate-900 dark:text-white font-semibold bg-orange-600/20 px-1.5 py-0.5 rounded border border-orange-500/20">{tr.to_branch}</span>
                                                                            </div>
                                                                            <div className="flex items-center gap-1">
                                                                                <span className="text-[10px] text-slate-500 dark:text-zinc-500 flex items-center gap-0.5">
                                                                                    <Clock size={9}/> {tr.start_time}-{tr.end_time}
                                                                                </span>
                                                                                <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${tr.status === 'active' ? 'bg-orange-600/20 text-orange-400' : 'bg-slate-200 dark:bg-zinc-700/30 text-slate-600 dark:text-zinc-400'}`}>
                                                                                    {tr.status === 'active' ? 'Aktif' : 'Bitti'}
                                                                                </span>
                                                                                <button
                                                                                    onClick={async () => {
                                                                                        if(!confirm(t('pay.deleteTransferConfirm'))) return;
                                                                                        await supabase.from('personnel_transfers').delete().eq('id', tr.id);
                                                                                        // Takvimden de ilgili etkinliği sil
                                                                                        await supabase.from('calendar_events').delete()
                                                                                            .eq('type', 'Şube Transferi')
                                                                                            .eq('date', tr.start_date)
                                                                                            .contains('attendees', [selectedEmployeeForDetail!.id]);
                                                                                        setTransferHistory(prev => prev.filter((t: any) => t.id !== tr.id));
                                                                                    }}
                                                                                    className="text-slate-400 dark:text-zinc-600 hover:text-red-400 transition-colors"
                                                                                    title="Sil"
                                                                                >
                                                                                    <Trash2 size={11}/>
                                                                                </button>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                    );
                                })()}
                            </div>
                        )}
                     </div>
                </div>
            </div>
        </div>
    );
  };

  // ONAY BEKLEYENLER (Süper Admin) — mobil-uyumlu kart liste
  const renderApprovalsContent = () => {
      const empById = new Map(allEmployees.map(e => [e.id, e]));
      return (
          <div className="h-full flex flex-col bg-slate-50 dark:bg-zinc-950/50 overflow-hidden">
              <div className="p-4 md:p-6 border-b border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 backdrop-blur-md sticky top-0 z-20 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                          <Shield size={18} className="text-amber-400" />
                          <h2 className="text-base md:text-lg font-bold text-slate-900 dark:text-white">Onay Bekleyenler</h2>
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-300 border border-amber-800/50">{pendingApprovals.length}</span>
                      </div>
                  </div>
                  <div className="relative">
                      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-zinc-500" />
                      <input
                          type="text"
                          value={approvalsSearch}
                          onChange={e => setApprovalsSearch(e.target.value)}
                          placeholder="İsim veya e-posta ile ara..."
                          className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-800 dark:text-zinc-200 outline-none focus:border-amber-500"
                      />
                  </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-3 pb-28 md:p-6 md:pb-6 space-y-2">
                  {pendingApprovals.length === 0 ? (
                      <div className="text-center text-slate-500 dark:text-zinc-500 text-sm py-12">
                          {approvalsSearch ? 'Aramaya uyan bekleyen kayıt yok.' : 'Bekleyen kayıt yok 🎉'}
                      </div>
                  ) : pendingApprovals.map(({ log, emp }) => (
                      <div key={log.id} className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-3 md:p-4">
                          <div className="flex items-start gap-3">
                              <img
                                  src={emp?.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(emp?.name || '?')}`}
                                  className="w-10 h-10 rounded-full object-cover border border-slate-200 dark:border-zinc-800 shrink-0"
                                  referrerPolicy="no-referrer"
                                  alt=""
                              />
                              <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">{emp?.name || 'Bilinmeyen'}</span>
                                      {log.method === 'qr' ? (
                                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60">QR</span>
                                      ) : (
                                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border border-slate-300 dark:border-zinc-700">Manuel</span>
                                      )}
                                      {log.autoClosedAt && (
                                          <span
                                              className="text-[9px] px-1.5 py-0.5 rounded bg-rose-900/40 text-rose-300 border border-rose-700/60 inline-flex items-center gap-1"
                                              title={t('pay.autoClosedTooltip')}
                                          >
                                              <AlarmClockOff size={10} /> {t('pay.autoClosedShort')}
                                          </span>
                                      )}
                                      {log.overtimeMinutes && log.overtimeMinutes > 0 && (
                                          <span
                                              className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-700/60 inline-flex items-center gap-1"
                                              title={t('pay.overtimeReportedTooltip')}
                                          >
                                              <Zap size={10} /> {t('pay.overtimeBadge')} +{log.overtimeMinutes} dk
                                          </span>
                                      )}
                                      {log.validationWarning && (
                                          <span
                                              className="text-[9px] px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 border border-red-600/60 font-bold inline-flex items-center gap-1"
                                              title={log.validationWarning}
                                          >
                                              <AlertTriangle size={10} /> {t('pay.timeMismatchShort')}
                                          </span>
                                      )}
                                      {log.method === 'qr' && log.deviceInfo && canSeeDeviceInfo(currentUser.email) && (
                                          <>
                                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-300 dark:border-zinc-700" title="Cihaz markası — sadece yetkili adminler görür">
                                                  {log.deviceInfo}
                                              </span>
                                              {deviceConflicts.has(log.id) && (
                                                  <span
                                                      className="text-[9px] px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 border border-red-600/60 font-black uppercase tracking-wider animate-pulse"
                                                      title={`⚠️ Bu personelin alışılmış cihazı: ${deviceConflicts.get(log.id)?.expected}\nFarklı bir telefondan giriş — şifre paylaşımı şüphesi.`}
                                                  >
                                                      ⚠ Telefon Çakışması
                                                  </span>
                                              )}
                                          </>
                                      )}
                                  </div>
                                  <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-zinc-400 mt-1 flex-wrap">
                                      <CalendarIcon size={11} />
                                      <span>{formatDate(log.date, { day: 'numeric', month: 'long', weekday: 'short' })}</span>
                                      <span className="text-slate-300 dark:text-zinc-700">•</span>
                                      <Clock size={11} />
                                      <span className="font-mono">{log.startTime || '—'} - {log.endTime || '—'}</span>
                                      {typeof log.totalHours === 'number' && log.totalHours > 0 && (
                                          <>
                                              <span className="text-slate-300 dark:text-zinc-700">•</span>
                                              <span className="text-slate-900 dark:text-white font-medium">{formatHoursHumanTR(log.totalHours)}</span>
                                          </>
                                      )}
                                  </div>
                                  <div className={`flex items-center gap-2 text-[11px] mt-1 flex-wrap ${log.method === 'qr' ? 'text-emerald-400' : 'text-slate-500 dark:text-zinc-500'}`}>
                                      <MapPin size={10} />
                                      <span className={log.method === 'qr' ? 'font-semibold' : ''}>{log.branch || 'Şube yok'}</span>
                                      {log.checkInLat != null && log.checkInLng != null && (
                                          <a
                                              href={`https://maps.google.com/?q=${log.checkInLat},${log.checkInLng}`}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-0.5"
                                          >
                                              Konum <MapPin size={10} />
                                          </a>
                                      )}
                                  </div>
                              </div>
                          </div>

                          <div className="flex gap-2 mt-3 pt-3 border-t border-slate-200 dark:border-zinc-800/60">
                              <button
                                  onClick={() => handleStatusChange(log.id, 'Onaylandı')}
                                  className="flex-1 px-3 py-2 bg-white dark:bg-zinc-900 hover:bg-green-600 text-slate-800 dark:text-zinc-200 hover:text-slate-900 dark:hover:text-white text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors border border-slate-200 dark:border-zinc-800 hover:border-green-500"
                              >
                                  <ThumbsUp size={14} /> Onayla
                              </button>
                              <button
                                  onClick={() => handleStatusChange(log.id, 'Reddedildi')}
                                  className="flex-1 px-3 py-2 bg-white dark:bg-zinc-900 hover:bg-red-600 text-slate-800 dark:text-zinc-200 hover:text-slate-900 dark:hover:text-white text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors border border-slate-200 dark:border-zinc-800 hover:border-red-500"
                              >
                                  <ThumbsDown size={14} /> Reddet
                              </button>
                              <button
                                  onClick={() => handleOpenEditTimeLog(log)}
                                  className="px-3 py-2 bg-white dark:bg-zinc-900 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500 dark:text-zinc-500 hover:text-indigo-400 rounded-lg border border-slate-200 dark:border-zinc-800"
                                  title={t('pay.editHours')}
                              >
                                  <Edit2 size={14} />
                              </button>
                              <button
                                  onClick={() => { if (confirm('Bu kaydı silmek istediğinizden emin misiniz?')) handleDeleteTimeLog(log.id); }}
                                  className="px-3 py-2 bg-white dark:bg-zinc-900 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 text-slate-500 dark:text-zinc-500 hover:text-red-400 rounded-lg border border-slate-200 dark:border-zinc-800"
                                  title="Sil"
                              >
                                  <Trash2 size={14} />
                              </button>
                          </div>
                      </div>
                  ))}
              </div>
          </div>
      );
  };

  const renderMonthlyContent = () => {
       if (!targetEmployee) return <div className="h-full flex items-center justify-center text-slate-500 dark:text-zinc-500"><p>Personel seçiniz</p></div>;
       return (
        <div className="h-full flex flex-col bg-slate-50 dark:bg-zinc-950/50">
            {/* MODIFIED HEADER: items-stretch to force height/width, removed w-full constraint to allow flex-1 to work properly */}
            <div className="p-4 md:p-6 border-b border-slate-200 dark:border-zinc-800 flex flex-col md:flex-row justify-between items-stretch md:items-center bg-white dark:bg-zinc-900/50 backdrop-blur-md sticky top-0 z-20 gap-4">
                <div className="flex items-center gap-2 md:gap-4 w-full md:w-auto justify-between md:justify-start">
                     <div className="flex items-center gap-2 flex-1 md:flex-none">
                        {/* Back Button for Admin on Mobile */}
                        <button 
                            onClick={() => setSelectedEmployeeId(null)}
                            className={`md:hidden p-2 rounded-lg bg-slate-100 dark:bg-zinc-800/50 text-slate-900 dark:text-white ${currentUser.role === Role.ADMIN ? 'block' : 'hidden'}`}
                        >
                            <ChevronLeft size={20} />
                        </button>

                        {/* Haftalık navigasyon — Vardiya Planı sekmesindeki ile aynı UX */}
                        <div className="flex flex-1 md:flex-none items-center justify-between bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-lg p-1 w-full md:min-w-[260px]">
                            <button onClick={() => handleWeekShift(-1)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 rounded text-slate-600 dark:text-zinc-400" aria-label={t('pay.prevWeek')}><ChevronLeft size={20}/></button>
                            <button
                                onClick={() => handleWeekShift(0)}
                                className="flex-1 text-center px-2 md:px-3 text-xs md:text-sm font-bold text-slate-900 dark:text-white min-w-[140px] md:min-w-[200px] hover:text-indigo-300 transition-colors"
                                title={t('pay.thisWeek')}
                            >
                                {formatDate(fmtDate(currentWeekStart), { day: 'numeric', month: 'short' })} – {formatDate(fmtDate(currentWeekEnd), { day: 'numeric', month: 'short', year: 'numeric' })}
                            </button>
                            <button onClick={() => handleWeekShift(1)} className="p-1 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 rounded text-slate-600 dark:text-zinc-400" aria-label={t('pay.nextWeek')}><ChevronRight size={20}/></button>
                        </div>
                     </div>
                    <div className="hidden md:block"><h2 className="text-lg font-bold text-slate-900 dark:text-white">{targetEmployee.name}</h2></div>
                    {/* Mobile Only Name Display */}
                    <div className="md:hidden text-right ml-2"><h2 className="text-sm font-bold text-slate-900 dark:text-white">{targetEmployee.name.split(' ')[0]}</h2></div>
                </div>
                <div className="flex gap-2 w-full md:w-auto">
                    <button onClick={() => setShowQrModal(true)} className="flex-1 md:flex-none flex items-center justify-center gap-2 px-3 md:px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-slate-900 dark:text-white text-xs md:text-sm font-medium rounded-lg"><QrCode size={16} /> <span className="inline">{t('qr.scanBtn')}</span></button>
                    {/* Manuel "Saat Ekle" — herkese açık (personel + tüm adminler).
                        Personel kayıtları status='Bekliyor' olarak admin onayına düşer
                        (handleSaveTimeLog:782); admin kayıtları doğrudan 'Onaylandı'. */}
                    <button onClick={handleOpenTimeModal} className="flex-1 md:flex-none flex items-center justify-center gap-2 px-3 md:px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-slate-900 dark:text-white text-xs md:text-sm font-medium rounded-lg"><Plus size={16} /> <span className="inline">{t('pay.addHours')}</span></button>
                </div>
            </div>
            <div className="flex-1 overflow-hidden flex flex-col md:flex-row min-h-0">
                <div className="flex-1 w-full overflow-y-auto min-h-0 p-4 pb-28 md:p-6 md:pb-6">
                    <h3 className="text-sm font-semibold text-slate-600 dark:text-zinc-400 mb-6 flex items-center gap-2"><Clock size={16}/> {t('pay.workHistory')}</h3>
                    <div className="relative ml-3 space-y-8 border-l border-slate-200 dark:border-zinc-800">
                        {weeklyLogs.length===0 ? <span className="ml-6 text-slate-500 dark:text-zinc-500 text-sm">{t('pay.noRecord')}</span> : weeklyLogs.map(log=>(
                            <div key={log.id} className="relative ml-6 group">
                                <span className={`absolute -left-[31px] top-1 w-4 h-4 rounded-full border-2 border-slate-200 dark:border-zinc-900 ${log.status==='Onaylandı'?'bg-green-500':log.status==='Reddedildi'?'bg-red-500':'bg-amber-500'}`}></span>
                                <div className="bg-white dark:bg-zinc-900/40 border border-slate-200 dark:border-zinc-800 rounded-xl p-4">
                                    <div className="flex justify-between items-start mb-2">
                                        <div>
                                            <span className="text-sm font-bold text-slate-900 dark:text-white">{formatDate(log.date, {day:'numeric',month:'long',weekday:'long'})}</span>
                                            {/* GÜNCELLEME: SAAT GÖSTERİMİ & ŞUBE DETAYI */}
                                            <div className="flex flex-col gap-1 mt-1">
                                                <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-zinc-400 flex-wrap">
                                                    <Clock size={12} />
                                                    <span className="font-mono">{log.startTime || '—'} - {log.endTime || '—'}</span>
                                                    <span className="text-slate-400 dark:text-zinc-600">•</span>
                                                    {/* Sürüyor: QR kaydı, henüz kapanmamış (check_out_at boş) VE manuel düzeltme de yapılmamış (end_time boş). */}
                                                    {log.method === 'qr' && !log.checkOutAt && !log.endTime ? (
                                                        <span className="text-amber-300 font-semibold text-[11px] px-1.5 py-0.5 rounded bg-amber-900/30 border border-amber-800/60 inline-flex items-center gap-1">
                                                            <Loader2 size={10} className="animate-spin" /> Sürüyor
                                                        </span>
                                                    ) : (
                                                        <span className="text-slate-900 dark:text-white font-medium">{formatHoursHumanTR(log.totalHours)}</span>
                                                    )}
                                                </div>
                                                {log.branch && (
                                                    <div className={`flex items-center gap-2 text-[10px] ${log.method === 'qr' ? 'text-emerald-400' : 'text-slate-500 dark:text-zinc-500'}`}>
                                                        <MapPin size={10} />
                                                        <span className={log.method === 'qr' ? 'font-semibold' : ''}>{log.branch}</span>
                                                        {log.method === 'qr' && (
                                                            <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60">QR</span>
                                                        )}
                                                        {log.method === 'qr' && log.deviceInfo && canSeeDeviceInfo(currentUser.email) && (
                                                            <>
                                                                <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-300 dark:border-zinc-700" title="Cihaz markası — sadece yetkili adminler görür">
                                                                    {log.deviceInfo}
                                                                </span>
                                                                {deviceConflicts.has(log.id) && (
                                                                    <span
                                                                        className="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-red-900/40 text-red-300 border border-red-600/60 font-black uppercase tracking-wider animate-pulse"
                                                                        title={`⚠️ Alışılmış cihazı: ${deviceConflicts.get(log.id)?.expected}\nFarklı telefondan giriş — şifre paylaşımı şüphesi.`}
                                                                    >
                                                                        ⚠ Telefon Çakışması
                                                                    </span>
                                                                )}
                                                            </>
                                                        )}
                                                        {log.checkInLat != null && log.checkInLng != null && (
                                                            <a
                                                                href={`https://maps.google.com/?q=${log.checkInLat},${log.checkInLng}`}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="inline-flex items-center gap-0.5 text-emerald-400 hover:text-emerald-300 font-semibold"
                                                                title={`${log.checkInLat}, ${log.checkInLng}`}
                                                            >
                                                                Konum <MapPin size={10} />
                                                            </a>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex flex-col items-end gap-2">
                                            <div className="flex items-center gap-1.5 flex-wrap justify-end">
                                                {/* Saat doğrulayıcı uyarısı (validation_warning) */}
                                                {log.validationWarning && (
                                                    <span
                                                        className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-300 border border-red-700/50 inline-flex items-center gap-1"
                                                        title={log.validationWarning}
                                                    >
                                                        <AlertTriangle size={10} /> {t('pay.timeMismatchShort')}
                                                    </span>
                                                )}
                                                {/* Otomatik kapatıldı işareti — onay bekleniyor */}
                                                {log.autoClosedAt && log.status === 'Bekliyor' && (
                                                    <span
                                                        className="text-[10px] px-1.5 py-0.5 rounded bg-rose-900/30 text-rose-300 border border-rose-700/50 inline-flex items-center gap-1"
                                                        title={t('pay.autoClosedTooltip')}
                                                    >
                                                        <AlarmClockOff size={10} /> {t('pay.autoClosedShort')}
                                                    </span>
                                                )}
                                                {/* Personelin bildirdiği fazla mesai */}
                                                {log.overtimeMinutes && log.overtimeMinutes > 0 && (
                                                    <span
                                                        className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/30 text-indigo-300 border border-indigo-700/50 inline-flex items-center gap-1"
                                                        title={t('pay.overtimeReportedTooltip')}
                                                    >
                                                        <Zap size={10} /> +{log.overtimeMinutes} dk
                                                    </span>
                                                )}
                                                {/* Vardiya planındaki saatler — shift_schedules'tan çekilir.
                                                    Plan ile gerçek check-in/out karşılaştırması için. */}
                                                {(() => {
                                                    const slots = plannedSlotsByDate.get(log.date);
                                                    if (!slots || slots.length === 0) return null;
                                                    return (
                                                        <span
                                                            className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/20 text-indigo-300 border border-indigo-700/40 inline-flex items-center gap-1 font-mono"
                                                            title="Vardiya planındaki saat"
                                                        >
                                                            <CalendarRange size={10} /> Plan: {slots.join(' · ')}
                                                        </span>
                                                    );
                                                })()}
                                                <span className={`text-[10px] px-2 py-1 rounded ${log.status==='Onaylandı'?'bg-green-900/20 text-green-400':log.status==='Reddedildi'?'bg-red-900/20 text-red-400':'bg-amber-900/20 text-amber-400'}`}>{log.status}</span>
                                            </div>
                                            {currentUser.role === Role.ADMIN && (
                                                <div className="flex items-center gap-1">
                                                    <button onClick={() => handleOpenEditTimeLog(log)} className="text-slate-500 dark:text-zinc-500 hover:text-indigo-400 p-1 rounded-md transition-colors" title={t('pay.editHours')}>
                                                        <Edit2 size={16} />
                                                    </button>
                                                    <button onClick={() => handleDeleteTimeLog(log.id)} className="text-slate-500 dark:text-zinc-500 hover:text-red-400 p-1 rounded-md transition-colors" title="Sil">
                                                        <Trash2 size={18} />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    {/* Personel: kendi auto-close edilmiş kaydına fazla mesai bildirebilir */}
                                    {log.employeeId === currentUser.id && log.autoClosedAt && log.status === 'Bekliyor' && (
                                        <div className="mt-3 pt-3 border-t border-slate-200 dark:border-zinc-800/50 flex justify-end">
                                            <button
                                                onClick={() => handleOpenOvertimeModal(log)}
                                                className="px-3 py-1.5 bg-indigo-600/20 hover:bg-indigo-600 text-indigo-300 hover:text-slate-900 dark:hover:text-white text-xs font-medium rounded-lg flex items-center gap-1.5 border border-indigo-700/40 hover:border-indigo-500 transition-colors"
                                                title={t('pay.overtimeBtnTooltip')}
                                            >
                                                <Zap size={14} /> {t('pay.overtimeBtn')}
                                            </button>
                                        </div>
                                    )}
                                    {currentUser.role === Role.ADMIN && log.status !== 'Onaylandı' && log.status !== 'Reddedildi' && (
                                        <div className="mt-3 pt-3 border-t border-slate-200 dark:border-zinc-800/50 flex justify-end gap-2">
                                            <button onClick={()=>handleStatusChange(log.id,'Reddedildi')} className="p-1.5 hover:bg-red-900/20 text-slate-500 dark:text-zinc-500 hover:text-red-400 rounded"><ThumbsDown size={14}/></button>
                                            <button onClick={()=>handleStatusChange(log.id,'Onaylandı')} className="px-3 py-1.5 bg-slate-100 dark:bg-zinc-800 hover:bg-green-600 hover:text-slate-900 dark:hover:text-white text-slate-700 dark:text-zinc-300 text-xs rounded flex gap-1"><ThumbsUp size={14}/> Onayla</button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
                {/* NOT: Finansal Özet buradan kaldırıldı ve ayrı bir 'FINANCIAL' sekmesine taşındı. */}
            </div>
        </div>
       )
  };

  return (
    <div className="h-full flex flex-col relative overflow-hidden bg-slate-50 dark:bg-zinc-950">
        {/* TRANSFER MODAL — KREATIV TASARIM */}
        {showTransferModal && selectedEmployeeForDetail && (() => {
            // Çakışma hesaplayıcı
            const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
            const getConflictsForBranch = (branch: string) => transferHistory.filter((tr: any) => {
                if (tr.status === 'cancelled' || tr.to_branch === branch) return false;
                if (!transferDates.startDate || !transferDates.endDate) return false;
                const dateOverlap = tr.start_date <= transferDates.endDate && tr.end_date >= transferDates.startDate;
                if (!dateOverlap) return false;
                const trS = toMin(tr.start_time || '08:00'), trE = toMin(tr.end_time || '18:00');
                const nS = toMin(transferDates.startTime || '08:00'), nE = toMin(transferDates.endTime || '18:00');
                return nS < trE && trS < nE;
            });
            const allConflicts = getConflictsForBranch(targetBranch);
            const hasAnyConflict = allConflicts.length > 0;

            return (
            <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
                <div className="bg-gradient-to-b from-zinc-900 via-zinc-900 to-zinc-950 border border-slate-300 dark:border-zinc-700/50 rounded-3xl shadow-[0_0_80px_rgba(249,115,22,0.08)] w-full max-w-md max-h-[90vh] flex flex-col animate-in fade-in zoom-in-95">

                    {/* HEADER — Gradient accent bar (sabit) */}
                    <div className="relative overflow-hidden shrink-0">
                        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-orange-500 via-amber-400 to-orange-600"></div>
                        <div className="p-5 flex justify-between items-center">
                            <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center shadow-lg shadow-orange-900/30">
                                    <ArrowRightLeft size={18} className="text-slate-900 dark:text-white" />
                                </div>
                                <div>
                                    <h3 className="text-base font-bold text-slate-900 dark:text-white tracking-tight">Transfer Planla</h3>
                                    <p className="text-[10px] text-slate-500 dark:text-zinc-500 mt-0.5">Personel görevlendirme</p>
                                </div>
                            </div>
                            <button onClick={() => setShowTransferModal(false)} className="w-8 h-8 rounded-full bg-slate-100 dark:bg-zinc-800/80 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 flex items-center justify-center transition-colors group">
                                <X size={16} className="text-slate-600 dark:text-zinc-400 group-hover:text-slate-900 dark:hover:text-white" />
                            </button>
                        </div>
                    </div>

                    <div className="px-5 pb-5 space-y-5 overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent">
                        {/* PERSONEL KARTI */}
                        <div className="flex items-center gap-3 p-3 rounded-2xl bg-slate-100 dark:bg-zinc-800/30 border border-slate-200 dark:border-zinc-800/50">
                            <div className="relative">
                                <div className="w-12 h-12 rounded-xl overflow-hidden ring-2 ring-zinc-700 shadow-lg">
                                    <img src={selectedEmployeeForDetail.avatarUrl} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                </div>
                                <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 border-2 border-slate-200 dark:border-zinc-900"></div>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h4 className="text-sm font-semibold text-slate-900 dark:text-white truncate">{selectedEmployeeForDetail.name}</h4>
                                <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">Havuzda</span>
                                    {transferHistory.filter((t: any) => t.status === 'active').length > 0 && (
                                        <span className="text-[10px] text-slate-500 dark:text-zinc-500">{transferHistory.filter((t: any) => t.status === 'active').length} aktif transfer</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* TARIH & SAAT — Kompakt grid */}
                        <div className="space-y-3">
                            <div className="flex items-center gap-2">
                                <CalendarRange size={13} className="text-slate-500 dark:text-zinc-500" />
                                <span className="text-xs font-medium text-slate-600 dark:text-zinc-400">Tarih & Saat</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div className="space-y-1">
                                    <span className="text-[10px] text-slate-400 dark:text-zinc-600 font-medium uppercase tracking-wider">Başlangıç</span>
                                    <input type="date" value={transferDates.startDate} onChange={(e) => setTransferDates({...transferDates, startDate: e.target.value})}
                                        className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20 transition-all" />
                                </div>
                                <div className="space-y-1">
                                    <span className="text-[10px] text-slate-400 dark:text-zinc-600 font-medium uppercase tracking-wider">Bitiş</span>
                                    <input type="date" value={transferDates.endDate} onChange={(e) => setTransferDates({...transferDates, endDate: e.target.value})}
                                        className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20 transition-all" />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div className="relative">
                                    <Clock size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-600" />
                                    <input type="time" value={transferDates.startTime} onChange={(e) => {
                                        const val = e.target.value;
                                        const [h, m] = val.split(':').map(Number);
                                        const endH = Math.min(h + 1, 23);
                                        const autoEnd = `${String(endH).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
                                        setTransferDates({...transferDates, startTime: val, endTime: autoEnd});
                                    }}
                                        className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl pl-8 pr-3 py-2 text-xs text-slate-900 dark:text-white focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20 transition-all" />
                                </div>
                                <div className="relative">
                                    <Clock size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-zinc-600" />
                                    <input type="time" value={transferDates.endTime} onChange={(e) => setTransferDates({...transferDates, endTime: e.target.value})}
                                        className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl pl-8 pr-3 py-2 text-xs text-slate-900 dark:text-white focus:border-orange-500/50 focus:ring-1 focus:ring-orange-500/20 transition-all" />
                                </div>
                            </div>
                        </div>

                        {/* HEDEF ŞUBE SEÇİMİ */}
                        <div className="space-y-3">
                            <div className="flex items-center gap-2">
                                <Building2 size={13} className="text-slate-500 dark:text-zinc-500" />
                                <span className="text-xs font-medium text-slate-600 dark:text-zinc-400">Hangi şubeye gönderilecek?</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                {Object.values(Branch).map(branch => {
                                    const isActive = targetBranch === branch;
                                    return (
                                        <button key={branch} onClick={() => setTargetBranch(branch)}
                                            className={`relative flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-all duration-200 ${
                                                isActive
                                                    ? 'bg-orange-500/15 border-orange-500 ring-1 ring-orange-500/30'
                                                    : 'bg-white dark:bg-zinc-900/50 border-slate-200 dark:border-zinc-800 hover:border-zinc-600'
                                            }`}
                                        >
                                            <div className={`w-2.5 h-2.5 rounded-full shrink-0 transition-colors ${isActive ? 'bg-orange-500 shadow-[0_0_6px_rgba(249,115,22,0.5)]' : 'bg-slate-200 dark:bg-zinc-700'}`}></div>
                                            <span className={`text-xs font-semibold ${isActive ? 'text-orange-300' : 'text-slate-600 dark:text-zinc-400'}`}>{branch}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* GÜNLÜK PROGRAM TABLOSU */}
                        {(() => {
                            const activeTransfers = transferHistory.filter((tr: any) => {
                                if (tr.status === 'cancelled') return false;
                                if (!transferDates.startDate || !transferDates.endDate) return false;
                                return tr.start_date <= transferDates.endDate && tr.end_date >= transferDates.startDate;
                            });

                            const newStart = toMin(transferDates.startTime || '08:00');
                            const newEnd = toMin(transferDates.endTime || '18:00');
                            const formatTime = (m: number) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

                            // Tüm görevleri birleştir: mevcut + yeni
                            const allEntries = [
                                ...activeTransfers.map((tr: any) => ({
                                    id: tr.id,
                                    branch: tr.to_branch,
                                    start: toMin(tr.start_time || '08:00'),
                                    end: toMin(tr.end_time || '18:00'),
                                    isNew: false,
                                    overlaps: newStart < toMin(tr.end_time || '18:00') && toMin(tr.start_time || '08:00') < newEnd
                                })),
                                { id: 'new', branch: targetBranch, start: newStart, end: newEnd, isNew: true, overlaps: false }
                            ].sort((a, b) => a.start - b.start);

                            return (
                                <div className="space-y-2.5">
                                    <div className="flex items-center gap-2">
                                        <Clock size={13} className="text-slate-500 dark:text-zinc-500" />
                                        <span className="text-xs font-medium text-slate-600 dark:text-zinc-400">Günün programı</span>
                                        {activeTransfers.length > 0 && (
                                            <span className="text-[10px] text-slate-400 dark:text-zinc-600 ml-auto">{activeTransfers.length} mevcut görev</span>
                                        )}
                                    </div>
                                    <div className="rounded-xl border border-slate-200 dark:border-zinc-800 overflow-hidden">
                                        {allEntries.map((entry, i) => (
                                            <div key={entry.id} className={`flex items-center px-3 py-2.5 ${i > 0 ? 'border-t border-slate-200 dark:border-zinc-800/60' : ''} ${
                                                entry.isNew ? 'bg-orange-500/8' : entry.overlaps ? 'bg-red-500/8' : 'bg-white dark:bg-zinc-900/30'
                                            }`}>
                                                {/* Saat aralığı */}
                                                <div className="w-[90px] shrink-0">
                                                    <span className={`text-xs font-mono font-semibold ${entry.isNew ? 'text-orange-400' : entry.overlaps ? 'text-red-400' : 'text-slate-700 dark:text-zinc-300'}`}>
                                                        {formatTime(entry.start)} - {formatTime(entry.end)}
                                                    </span>
                                                </div>
                                                {/* Şube adı */}
                                                <div className="flex items-center gap-2 flex-1 min-w-0">
                                                    <div className={`w-1.5 h-6 rounded-full shrink-0 ${entry.isNew ? 'bg-orange-500' : entry.overlaps ? 'bg-red-500' : 'bg-zinc-600'}`}></div>
                                                    <span className={`text-xs font-medium truncate ${entry.isNew ? 'text-orange-300' : entry.overlaps ? 'text-red-300' : 'text-slate-600 dark:text-zinc-400'}`}>
                                                        {entry.branch}
                                                    </span>
                                                </div>
                                                {/* Durum etiketi */}
                                                <div className="shrink-0 ml-2">
                                                    {entry.isNew ? (
                                                        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/20">YENİ</span>
                                                    ) : entry.overlaps ? (
                                                        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/20 flex items-center gap-1">
                                                            <AlertTriangle size={9}/> ÇAKIŞMA
                                                        </span>
                                                    ) : (
                                                        <span className="text-[9px] font-medium px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500">MEVCUT</span>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                        {allEntries.length === 1 && (
                                            <div className="px-3 py-2 border-t border-slate-200 dark:border-zinc-800/60 bg-white dark:bg-zinc-900/20">
                                                <span className="text-[10px] text-slate-400 dark:text-zinc-600 italic">Bu tarihte başka görev bulunmuyor</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })()}

                        {/* ÇAKIŞMA UYARISI */}
                        {hasAnyConflict && (
                            <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-3.5 space-y-2.5">
                                <div className="flex items-center gap-2">
                                    <AlertTriangle size={14} className="text-red-400" />
                                    <span className="text-xs font-bold text-red-300">Dikkat: Saat çakışması var!</span>
                                </div>
                                <p className="text-[11px] text-red-300/70 leading-relaxed">
                                    Bu personelin seçtiğiniz saat aralığında başka şubelerde görevi bulunuyor. Yine de devam edebilirsiniz, ancak aynı saatte iki farklı şubede çalışması gerekeceğini unutmayın.
                                </p>
                            </div>
                        )}

                        {/* ONAYLA BUTONU */}
                        <button onClick={handleTransfer} disabled={isLoading}
                            className={`w-full py-3.5 rounded-2xl font-semibold text-sm transition-all duration-300 flex items-center justify-center gap-2.5 shadow-xl ${
                                hasAnyConflict
                                    ? 'bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-500 hover:to-orange-500 text-slate-900 dark:text-white shadow-red-900/30'
                                    : 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-slate-900 dark:text-white shadow-orange-900/30'
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                            {isLoading ? <Loader2 className="animate-spin" size={18}/> : (
                                <>
                                    {hasAnyConflict ? <AlertTriangle size={16}/> : <Rocket size={16}/>}
                                    {hasAnyConflict ? t('pay.approveConflict') : t('cal.confirmTransfer')}
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
            );
        })()}

        {/* FAZLA MESAİ BİLDİR MODAL — sadece personelin kendi auto-close kaydı için */}
        {overtimeLogId && (() => {
            const log = timeLogs.find(l => l.id === overtimeLogId);
            const presets = [15, 30, 60, 90, 120];
            const safeMin = Number.isFinite(overtimeMinutes) ? overtimeMinutes : 0;
            const newTotalPreview = log
                ? Math.max(0, (log.totalHours || 0) + safeMin / 60)
                : 0;
            return (
                <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
                    <div className="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-indigo-700/40 rounded-2xl shadow-[0_0_60px_rgba(99,102,241,0.15)] w-full max-w-md overflow-hidden">
                        <div className="relative">
                            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-indigo-500"></div>
                            <div className="p-5 flex justify-between items-center border-b border-slate-200 dark:border-zinc-800">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center">
                                        <Zap size={20} className="text-indigo-300" />
                                    </div>
                                    <div>
                                        <h3 className="text-base font-bold text-slate-900 dark:text-white">{t('pay.overtimeModalTitle')}</h3>
                                        <p className="text-[11px] text-slate-600 dark:text-zinc-400 mt-0.5">{t('pay.overtimeModalSubtitle')}</p>
                                    </div>
                                </div>
                                <button
                                    onClick={() => setOvertimeLogId(null)}
                                    className="text-slate-500 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800"
                                    disabled={overtimeSubmitting}
                                >
                                    <X size={18} />
                                </button>
                            </div>
                        </div>

                        <div className="p-5 space-y-4">
                            {log && (
                                <div className="bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl p-3 text-xs">
                                    <div className="flex justify-between items-center text-slate-600 dark:text-zinc-400 mb-1">
                                        <span>{formatDate(log.date, { day: 'numeric', month: 'long', weekday: 'long' })}</span>
                                        <span className="font-mono text-slate-700 dark:text-zinc-300">{log.startTime} - {log.endTime}</span>
                                    </div>
                                    <div className="text-slate-500 dark:text-zinc-500 text-[11px]">
                                        {t('pay.overtimeCurrentTotal')}: <span className="text-slate-900 dark:text-white font-semibold">{formatHoursHumanTR(log.totalHours)}</span>
                                    </div>
                                </div>
                            )}

                            <div>
                                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400 mb-2 block">{t('pay.overtimePresets')}</label>
                                <div className="grid grid-cols-5 gap-1.5">
                                    {presets.map(min => (
                                        <button
                                            key={min}
                                            type="button"
                                            onClick={() => setOvertimeMinutes(min)}
                                            disabled={overtimeSubmitting}
                                            className={`py-2 text-xs font-semibold rounded-lg border transition-all ${
                                                overtimeMinutes === min
                                                    ? 'bg-indigo-600 text-slate-900 dark:text-white border-indigo-500'
                                                    : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 hover:text-slate-900 dark:hover:text-white'
                                            }`}
                                        >
                                            +{min}dk
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400 mb-2 block">{t('pay.overtimeCustom')}</label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="number"
                                        min={1}
                                        max={720}
                                        step={1}
                                        value={overtimeMinutes}
                                        onChange={e => setOvertimeMinutes(parseInt(e.target.value, 10) || 0)}
                                        disabled={overtimeSubmitting}
                                        className="flex-1 bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white outline-none focus:border-indigo-500 font-mono"
                                    />
                                    <span className="text-xs text-slate-500 dark:text-zinc-500">{t('pay.minutes')}</span>
                                </div>
                            </div>

                            {log && safeMin > 0 && (
                                <div className="bg-indigo-950/30 border border-indigo-800/40 rounded-xl p-3">
                                    <div className="text-[11px] text-indigo-300/70 mb-1">{t('pay.overtimeNewTotal')}</div>
                                    <div className="text-lg font-bold text-indigo-200">
                                        {formatHoursHumanTR(Number(newTotalPreview.toFixed(2)))}
                                    </div>
                                </div>
                            )}

                            <p className="text-[10px] text-amber-400/80 bg-amber-950/20 border border-amber-900/30 rounded-lg p-2.5 leading-relaxed">
                                {t('pay.overtimeWarning')}
                            </p>
                        </div>

                        <div className="p-4 border-t border-slate-200 dark:border-zinc-800 flex gap-2">
                            <button
                                onClick={() => setOvertimeLogId(null)}
                                disabled={overtimeSubmitting}
                                className="flex-1 px-4 py-2.5 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                            >
                                {t('common.cancel') || 'İptal'}
                            </button>
                            <button
                                onClick={handleSubmitOvertime}
                                disabled={overtimeSubmitting || safeMin < 1 || safeMin > 720}
                                className="flex-1 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-slate-900 dark:text-white text-sm font-medium rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {overtimeSubmitting ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} />}
                                {t('pay.overtimeSubmit')}
                            </button>
                        </div>
                    </div>
                </div>
            );
        })()}

        {/* QR SCAN MODAL */}
        {showQrModal && (
            <div className="absolute inset-0 z-[100] flex items-start justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
                <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden my-8">
                    <div className="p-4 border-b border-slate-200 dark:border-zinc-800 flex justify-between items-center">
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                            <QrCode size={20} className="text-emerald-500" /> {t('qr.title')}
                        </h3>
                        <button onClick={() => setShowQrModal(false)} className="text-slate-500 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white">
                            <X size={20} />
                        </button>
                    </div>
                    <Suspense fallback={
                        <div className="p-12 flex items-center justify-center text-slate-600 dark:text-zinc-400">
                            <Loader2 className="animate-spin mr-2" size={20}/> Yükleniyor...
                        </div>
                    }>
                        <QrCheckIn currentUser={currentUser} onComplete={fetchData} />
                    </Suspense>
                </div>
            </div>
        )}

        {/* ADD TIME LOG MODAL */}
        {showTimeModal && (() => {
            // Saat aralığı + mola süresi → canlı önizleme. Kaydederken aynı formül kullanılıyor.
            const previewStart = new Date(`1970-01-01T${timeForm.startTime || '00:00'}:00`);
            const previewEnd = new Date(`1970-01-01T${timeForm.endTime || '00:00'}:00`);
            let previewMs = previewEnd.getTime() - previewStart.getTime();
            if (isNaN(previewMs)) previewMs = 0;
            if (previewMs < 0) previewMs += 24 * 60 * 60 * 1000;
            const previewMins = Math.max(0, Math.floor(previewMs / 60000) - (timeForm.breakDuration || 0));
            const previewHours = Number((previewMins / 60).toFixed(2));
            const isEditing = !!editingLogId;
            return (
            <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                    <div className="p-6 border-b border-slate-200 dark:border-zinc-800 flex justify-between items-center">
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                            <Clock size={20} className="text-indigo-500" /> {isEditing ? t('pay.editHours') : t('pay.addHours')}
                        </h3>
                        <button onClick={handleCloseTimeModal} className="text-slate-500 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white"><X size={20} /></button>
                    </div>
                    <form onSubmit={handleSaveTimeLog} className="p-6 space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                             <div className="space-y-1"><label className="text-xs text-slate-600 dark:text-zinc-400">{t('cal.startDate')}</label><input type="date" required value={timeForm.date} onChange={e => setTimeForm({...timeForm, date: e.target.value})} className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded p-2 text-slate-900 dark:text-white"/></div>
                             <div className="space-y-1"><label className="text-xs text-slate-600 dark:text-zinc-400">Şube</label><select value={timeForm.branch} onChange={e => setTimeForm({...timeForm, branch: e.target.value as Branch})} className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded p-2 text-slate-900 dark:text-white">{Object.values(Branch).map(b=><option key={b} value={b}>{b}</option>)}</select></div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                             <div className="space-y-1"><label className="text-xs text-slate-600 dark:text-zinc-400">{t('cal.startTime')}</label><input type="time" required value={timeForm.startTime} onChange={e => setTimeForm({...timeForm, startTime: e.target.value})} className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded p-2 text-slate-900 dark:text-white"/></div>
                             <div className="space-y-1"><label className="text-xs text-slate-600 dark:text-zinc-400">{t('cal.endTime')}</label><input type="time" required value={timeForm.endTime} onChange={e => setTimeForm({...timeForm, endTime: e.target.value})} className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded p-2 text-slate-900 dark:text-white"/></div>
                        </div>
                        <div className="grid grid-cols-2 gap-4 items-end">
                             <div className="space-y-1">
                                <label className="text-xs text-slate-600 dark:text-zinc-400">{t('pay.breakDuration')}</label>
                                <input type="number" min={0} max={480} step={5} value={timeForm.breakDuration}
                                    onChange={e => setTimeForm({...timeForm, breakDuration: Math.max(0, parseInt(e.target.value || '0', 10))})}
                                    className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded p-2 text-slate-900 dark:text-white"/>
                             </div>
                             <div className="text-right">
                                <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-500">{t('pay.totalHours')}</div>
                                <div className="text-lg font-bold text-emerald-400 tabular-nums">{formatHoursHumanTR(previewHours)}</div>
                             </div>
                        </div>
                        {isEditing && (
                            <div className="text-[11px] text-slate-500 dark:text-zinc-500 italic border-t border-slate-200 dark:border-zinc-800 pt-3">
                                {t('pay.editAutoRecalc')}
                            </div>
                        )}
                        <div className="pt-4 flex gap-3">
                            <button type="button" onClick={handleCloseTimeModal} className="flex-1 py-2 bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white rounded">{t('tasks.cancel')}</button>
                            <button type="submit" className="flex-1 py-2 bg-indigo-600 text-slate-900 dark:text-white rounded">
                                {isLoading ? <Loader2 className="animate-spin mx-auto" size={16}/> : t('pay.save')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
            );
        })()}

        <header className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-4 py-3 md:px-6 md:py-4 border-b border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950/80 backdrop-blur-sm shrink-0">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight">{t('pay.title')}</h2>
            <div className="flex w-full md:w-auto bg-white dark:bg-zinc-900 p-1 rounded-xl border border-slate-200 dark:border-zinc-800">
                {currentUser.role === Role.ADMIN && (
                    <button 
                        onClick={() => setCurrentTab('STAFF')} 
                        className={`flex-1 md:flex-none text-center px-4 py-1.5 text-xs font-medium rounded-lg transition-all ${currentTab === 'STAFF' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                    >
                        {t('pay.tabStaff')}
                    </button>
                )}
                <button 
                    onClick={() => setCurrentTab('MONTHLY')} 
                    className={`flex-1 md:flex-none text-center px-4 py-1.5 text-xs font-medium rounded-lg transition-all ${currentTab === 'MONTHLY' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                >
                    {currentUser.role === Role.ADMIN ? 'Bordro' : t('pay.tabMonthly')}
                </button>
                {/* NEW: FINANCIAL SUMMARY TAB BUTTON - VISIBLE TO ALL ADMINS */}
                {currentUser.role === Role.ADMIN && (
                    <button
                        onClick={() => setCurrentTab('FINANCIAL')}
                        className={`flex-1 md:flex-none text-center px-4 py-1.5 text-xs font-medium rounded-lg transition-all ${currentTab === 'FINANCIAL' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                    >
                        {t('pay.tabFinancial')}
                    </button>
                )}
                {/* SÜPER ADMIN: Onay Bekleyenler */}
                {currentUser.email === SUPER_ADMIN_EMAIL && (
                    <button
                        onClick={() => setCurrentTab('APPROVALS')}
                        className={`flex-1 md:flex-none text-center px-4 py-1.5 text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5 ${currentTab === 'APPROVALS' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                    >
                        <Shield size={12} />
                        Onaylar
                        {pendingApprovals.length > 0 && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-900/40 text-amber-300">{pendingApprovals.length}</span>
                        )}
                    </button>
                )}
            </div>
        </header>

        <div className="flex-1 overflow-hidden flex flex-col md:flex-row relative">
            {/* SOL PANEL (LİSTE) - SADECE ADMIN GÖREBİLİR - APPROVALS sekmesinde gizli */}
             {currentUser.role === Role.ADMIN && currentTab !== 'APPROVALS' && (
                 <div className={`w-full md:w-[480px] border-r border-slate-200 dark:border-zinc-800 flex-col bg-slate-50 dark:bg-zinc-950 h-full ${selectedEmployeeId ? 'hidden md:flex' : 'flex'}`}>
                  <div className="p-6 pb-4">
                     <div className="flex justify-between items-center mb-6">
                         <div><h3 className="text-xl font-bold text-slate-900 dark:text-white">{t('pay.tabStaff')}</h3><p className="text-xs text-slate-500 dark:text-zinc-500">{filteredEmployees.length} kişi</p></div>
                         <div className="flex items-center gap-2">
                             {/* ADMIN LİSTESİ BUTONU */}
                             {currentUser.role === Role.ADMIN && adminEmployees.length > 0 && (
                                 <div className="relative">
                                     <button
                                         onClick={() => setShowAdminList(!showAdminList)}
                                         className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${showAdminList ? 'bg-red-900/20 text-red-400 border-red-900/40' : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:text-red-400 hover:border-red-900/30'}`}
                                     >
                                         <Shield size={14} />
                                         <span>Admin</span>
                                         <span className="text-[10px] bg-red-900/30 text-red-400 px-1.5 py-0.5 rounded-full">{adminEmployees.length}</span>
                                         <ChevronRight size={12} className={`transition-transform duration-200 ${showAdminList ? 'rotate-90' : ''}`} />
                                     </button>
                                     {showAdminList && (
                                         <div className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] md:w-64 max-w-64 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-xl shadow-2xl z-50 overflow-hidden">
                                             <div className="p-3 border-b border-slate-200 dark:border-zinc-800 flex items-center gap-2">
                                                 <Shield size={14} className="text-red-500" />
                                                 <span className="text-xs font-bold text-slate-900 dark:text-white">Admin Listesi</span>
                                             </div>
                                             <div className="max-h-64 overflow-y-auto p-2 space-y-1">
                                                 {adminEmployees.map(admin => (
                                                     <div
                                                         key={admin.id}
                                                         onClick={() => { handleSelectEmployee(admin.id); setCurrentTab('STAFF'); setShowAdminList(false); }}
                                                         className={`p-2.5 rounded-lg cursor-pointer transition-all border ${selectedEmployeeId === admin.id ? 'bg-red-900/20 border-red-500/30' : 'bg-slate-50 dark:bg-zinc-950/50 border-slate-200 dark:border-zinc-800/50 hover:border-red-900/30 hover:bg-slate-100 dark:hover:bg-white dark:hover:bg-zinc-900/50'}`}
                                                     >
                                                         <div className="flex items-center gap-3">
                                                             <img src={admin.avatarUrl} className="w-8 h-8 rounded-full object-cover border border-red-900/30" referrerPolicy="no-referrer" />
                                                             <div className="flex-1 min-w-0">
                                                                 <h4 className="text-xs font-semibold text-slate-900 dark:text-white truncate">{admin.name}</h4>
                                                                 <p className="text-[10px] text-slate-500 dark:text-zinc-500 truncate">{admin.email}</p>
                                                             </div>
                                                             <ChevronRight size={14} className="text-slate-400 dark:text-zinc-600 shrink-0" />
                                                         </div>
                                                     </div>
                                                 ))}
                                             </div>
                                         </div>
                                     )}
                                 </div>
                             )}
                             {/* ADD BUTTON NOW FOR ALL ADMINS */}
                             {currentUser.role === Role.ADMIN && (<button onClick={handleAddNew} className="w-8 h-8 flex items-center justify-center bg-indigo-600 rounded-full text-slate-900 dark:text-white hover:bg-indigo-500 shadow-lg"><Plus size={18} /></button>)}
                         </div>
                     </div>
                     <div className="relative mb-4"><Search size={16} className="absolute left-3 top-3 text-slate-500 dark:text-zinc-500" /><input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder={t('pay.search')} className="w-full bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-800 dark:text-zinc-200 outline-none focus:border-indigo-500"/></div>
                     
                     {/* ŞUBE FİLTRESİ KALDIRILDI - Tüm personel havuzda */}
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-28 md:pb-4 space-y-2">
                    {isLoading && employees.length === 0 ? <div className="text-center p-4 text-slate-500 dark:text-zinc-500">{t('common.loading')}</div> : filteredEmployees.map(emp => (
                        <div key={emp.id} onClick={() => handleSelectEmployee(emp.id)} className={`group p-3 rounded-xl cursor-pointer transition-all border ${selectedEmployeeId === emp.id ? 'bg-white dark:bg-zinc-900 border-indigo-500/30 shadow' : 'bg-transparent border-transparent hover:bg-slate-100 dark:hover:bg-white dark:hover:bg-zinc-900 hover:border-slate-200 dark:border-zinc-800'}`}>
                            <div className="flex items-center gap-4">
                                <div className="relative">
                                    <img src={emp.avatarUrl} className="w-12 h-12 rounded-full object-cover" referrerPolicy="no-referrer" />
                                    <div className="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-slate-200 dark:border-zinc-950 bg-emerald-500"></div>
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h4 className={`text-sm font-semibold truncate ${selectedEmployeeId === emp.id ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-zinc-300'}`}>{emp.name}</h4>
                                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                        <span className="text-[11px] text-slate-500 dark:text-zinc-500">{emp.role}</span>
                                        {emp.phone && (
                                            <>
                                                <span className="text-[11px] text-slate-300 dark:text-zinc-700">•</span>
                                                <a
                                                    href={`tel:${emp.phone}`}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="text-[11px] text-slate-500 dark:text-zinc-400 hover:text-indigo-600 dark:hover:text-indigo-400 flex items-center gap-1 font-mono"
                                                    title={t('pay.callPhone')}
                                                >
                                                    <Phone size={10} /> {emp.phone}
                                                </a>
                                                <a
                                                    href={`https://wa.me/${emp.phone.replace(/\D/g, '')}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500 hover:text-white transition-colors"
                                                    title={t('pay.whatsappContact')}
                                                >
                                                    <MessageCircle size={11} />
                                                </a>
                                            </>
                                        )}
                                    </div>
                                </div>
                                
                                {/* HIZLI TRANSFER BUTONU - LISTE İÇİNDE (TURUNCU GÜNCELLEMESİ) - ALL ADMINS */}
                                {currentUser.role === Role.ADMIN && (
                                    <button 
                                        onClick={(e) => {
                                            e.stopPropagation(); // Detaya girmeyi engelle
                                            setSelectedEmployeeId(emp.id); // Modal için seçimi güncelle
                                            setTargetBranch(Branch.DOM); // Modal varsayılan şubesini ayarla
                                            setShowTransferModal(true);
                                        }}
                                        className="hidden md:flex items-center justify-center w-8 h-8 rounded-lg bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white hover:bg-orange-600 transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 z-20 shadow-lg transform active:scale-95 border border-transparent hover:border-orange-400"
                                        title={t('cal.transfer')}
                                    >
                                        <ArrowRightLeft size={16} />
                                    </button>
                                )}

                                <div className="md:hidden text-slate-400 dark:text-zinc-600"><ChevronRight size={18} /></div>
                            </div>
                        </div>
                    ))}
                  </div>
                </div>
            )}

            {/* SAĞ PANEL (İÇERİK) - EĞER PERSONEL İSE TAM EKRAN
                APPROVALS sekmesi mobilde de tam ekran görünmeli */}
            <div className={`flex-1 w-full overflow-hidden ${currentTab === 'APPROVALS' || selectedEmployeeId ? 'flex' : 'hidden md:flex'}`}>
                 {currentTab === 'APPROVALS' ? renderApprovalsContent()
                   : currentTab === 'STAFF' ? renderStaffContent()
                   : currentTab === 'FINANCIAL' ? renderFinancialContent()
                   : renderMonthlyContent()}
            </div>
        </div>
    </div>
  );
};

export default Payroll;