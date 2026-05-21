import React, { useState, useEffect, useMemo, useRef } from 'react';
import { SalesLog, Employee, Role, Branch } from '../types';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../lib/i18n';
import { formatLocalDate, isUserOnShiftAt, formatTimeOfDay, canSeeOffShiftAlerts, compressImageToJpeg } from '../lib/utils';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend } from 'recharts';
import { Trophy, TrendingUp, ShoppingBag, MapPin, Award, Medal, Calendar, Package, Activity, BarChart3, ListTodo, User, Lock, EyeOff, Filter, ChevronDown, Clock, Tag, Send, Loader2, CheckCircle2, XCircle, Trash2, X, Star, Zap, Crown, Percent, Settings, AlertTriangle, Camera, Receipt, Upload } from 'lucide-react';
import { GlowingEffect } from './ui/glowing-effect';
import { notifyEvent } from '../lib/notifyEvent';


interface SalesDashboardProps {
    currentUser: Employee;
}

interface ActionProduct {
    id: string;
    name: string;
    is_active: boolean;
}

const AKTION_PRODUCTS = [
    "Ploom",
    "Vuse",
    "İqos iluma prime",
    "İqos iluma",
    "İqos one",
    "Veev"
];

const YEARS = [2024, 2025, 2026];
const MONTHS = [
    { v: 1, l: 'Ocak' }, { v: 2, l: 'Şubat' }, { v: 3, l: 'Mart' },
    { v: 4, l: 'Nisan' }, { v: 5, l: 'Mayıs' }, { v: 6, l: 'Haziran' },
    { v: 7, l: 'Temmuz' }, { v: 8, l: 'Ağustos' }, { v: 9, l: 'Eylül' },
    { v: 10, l: 'Ekim' }, { v: 11, l: 'Kasım' }, { v: 12, l: 'Aralık' }
];

const SalesDashboard: React.FC<SalesDashboardProps> = ({ currentUser }) => {
    const { t, formatDate } = useLanguage();
    const [salesData, setSalesData] = useState<SalesLog[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    // PERFORMANCE CARD STATE
    const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);

    const isAdmin = currentUser.role === Role.ADMIN;
    const isMounted = useRef(true);

    // Mesai dışı satış uyarısını sadece bu emailler görür ve onlar engelleme dışıdır.
    const canSeeOffShift = canSeeOffShiftAlerts(currentUser.email);

    // Bu haftanın shift_schedules satırları — satış giriş anındaki vardiya kontrolü için.
    const [currentWeekShifts, setCurrentWeekShifts] = useState<any[]>([]);

    // Filter States
    const [selectedBranch, setSelectedBranch] = useState<string>('ALL');
    const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
    const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1);

    // Product Management States
    const [actionProducts, setActionProducts] = useState<ActionProduct[]>([]);
    const [showProductModal, setShowProductModal] = useState(false);
    const [newProductName, setNewProductName] = useState('');

    // New Sales Form State
    // branch: Personel havuzdan farklı şubelerde çalışabildiği için satış girilirken
    // hangi şubede yapıldığı zorunlu olarak seçilmeli — currentUser.branch boş olabilir.
    const [salesForm, setSalesForm] = useState({
        product: '',
        quantity: 1,
        date: new Date().toISOString().split('T')[0],
        branch: (currentUser.branch as string) || (Object.values(Branch)[0] as string)
    });

    useEffect(() => {
        isMounted.current = true;
        fetchData();
        return () => { isMounted.current = false; };
    }, []);

    const fetchData = async () => {
        setIsLoading(true);
        try {
            // Fetch Products
            const { data: productsData, error: productsError } = await supabase.from('action_products').select('*');
            if (productsError) {
                console.error("Error fetching products:", productsError);
            }
            if (productsData && isMounted.current) {
                // Remove duplicates by name (keep the latest one)
                const uniqueProducts = Array.from(new Map(productsData.map(item => [item.name, item])).values());
                setActionProducts(uniqueProducts);
                const activeProducts = uniqueProducts.filter(p => p.is_active === true || String(p.is_active).toLowerCase() === 'true' || p.is_active === 1);
                if (activeProducts.length > 0 && !salesForm.product) {
                    setSalesForm(prev => ({ ...prev, product: activeProducts[0].name }));
                }
            }

            // Admin dışında herkes sadece kendi satışlarını görür.
            let salesQuery = supabase.from('sales_logs').select('*').order('sale_date', { ascending: false });
            if (!isAdmin) {
                salesQuery = salesQuery.eq('employee_id', currentUser.id);
            }
            const { data: sales } = await salesQuery;
            if (sales && isMounted.current) {
                const formattedSales = sales.map((l: any) => ({
                    id: l.id,
                    employeeId: l.employee_id,
                    branch: l.branch,
                    productName: l.product_name,
                    quantity: l.quantity,
                    saleDate: l.sale_date,
                    status: l.status,
                    createdAt: l.created_at,
                    isOffShift: !!l.is_off_shift,
                    receiptUrl: l.receipt_url || undefined
                }));
                setSalesData(formattedSales);
            }

            // Mevcut haftanın vardiya programı — satış giriş anında kullanıcı mesaide mi kontrolü için.
            const today = new Date();
            const dayIdx = (today.getDay() + 6) % 7; // Pzt=0..Pzr=6
            const monday = new Date(today);
            monday.setDate(monday.getDate() - dayIdx);
            const weekKey = formatLocalDate(monday);
            const { data: shiftRows } = await supabase
                .from('shift_schedules')
                .select('week_start_date, time_slot, days')
                .eq('week_start_date', weekKey);
            if (shiftRows && isMounted.current) setCurrentWeekShifts(shiftRows);

            const { data: profiles } = await supabase.from('profiles').select('*');
            if (profiles && isMounted.current) {
                const formattedEmps = profiles.map((p: any) => ({
                    id: p.id,
                    name: p.full_name,
                    avatarUrl: p.avatar_url || `https://ui-avatars.com/api/?name=${p.full_name}`,
                    branch: p.branch,
                    role: p.role // Rol bilgisi eklendi
                }));
                setEmployees(formattedEmps as Employee[]);
            }
        } catch (err) {
            console.error(err);
        } finally {
            if(isMounted.current) setIsLoading(false);
        }
    };

    // Product Management Functions
    const handleAddProduct = async () => {
        if (!newProductName.trim()) return;
        const { data, error } = await supabase.from('action_products').insert([{ name: newProductName.trim(), is_active: true }]).select();
        if (!error && data) {
            setActionProducts([...actionProducts, data[0]]);
            setNewProductName('');
            if (!salesForm.product) {
                setSalesForm(prev => ({ ...prev, product: data[0].name }));
            }
        }
    };

    const handleToggleProductStatus = async (id: string, isActive: boolean) => {
        const { error } = await supabase.from('action_products').update({ is_active: isActive }).eq('id', id);
        if (!error) {
            setActionProducts(actionProducts.map(p => p.id === id ? { ...p, is_active: isActive } : p));
        }
    };

    const handleDeleteProduct = async (id: string) => {
        if (!confirm(t('sales.deleteProductConfirm'))) return;
        const { error } = await supabase.from('action_products').delete().eq('id', id);
        if (!error) {
            setActionProducts(actionProducts.filter(p => p.id !== id));
            // Reset form product if the deleted one was selected
            const deletedProduct = actionProducts.find(p => p.id === id);
            if (deletedProduct && salesForm.product === deletedProduct.name) {
                const remainingActive = actionProducts.filter(p => p.id !== id && p.is_active);
                setSalesForm(prev => ({ ...prev, product: remainingActive.length > 0 ? remainingActive[0].name : '' }));
            }
        }
    };

    // Fiş fotoğrafı için iki ayrı file input — kamera ve galeri
    const cameraInputRef = useRef<HTMLInputElement>(null);
    const galleryInputRef = useRef<HTMLInputElement>(null);

    // Kaynak seçim modal'ı
    const [showSourceModal, setShowSourceModal] = useState(false);

    // 1. ADIM: form gönderilince validate + kaynak seçim modal'ı aç.
    const handleSaveSale = (e: React.FormEvent) => {
        e.preventDefault();
        if (isSaving) return;

        if (!salesForm.branch) { alert(t('sales.branch')); return; }
        if (!salesForm.product) { alert(t('sales.alertSelectProduct')); return; }
        if (!salesForm.quantity || salesForm.quantity <= 0) { alert(t('sales.alertValidQty')); return; }

        // Mesai kontrolü
        const onShift = isUserOnShiftAt(currentUser.id, new Date(), currentWeekShifts);
        if (!onShift && !canSeeOffShift) {
            alert(t('sales.alertOffShift'));
            return;
        }

        // Kaynak seçim modal'ını aç
        setShowSourceModal(true);
    };

    // Modal'dan seçim sonrası kamera veya galeri input'unu tetikle
    const triggerSourceInput = (source: 'camera' | 'gallery') => {
        setShowSourceModal(false);
        const ref = source === 'camera' ? cameraInputRef : galleryInputRef;
        if (ref.current) {
            ref.current.value = '';
            // Modal kapanma animasyonu için micro-delay
            setTimeout(() => ref.current?.click(), 50);
        }
    };

    // 2. ADIM: kullanıcı fişi seçince → sıkıştır → Storage'a yükle → satışı kaydet.
    const handleReceiptSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (e.target) e.target.value = '';
        if (!file) return;

        setIsSaving(true);
        try {
            // Fişi sıkıştır (max 800px, q=0.6 — ~30-80 KB ama metin okunaklı)
            const blob = await compressImageToJpeg(file, { maxWidth: 800, quality: 0.6 });

            // Storage path: <userId>/<timestamp>.jpg — çakışmaz, kullanıcıya göre gruplanır
            const path = `${currentUser.id}/${Date.now()}.jpg`;
            const { error: upErr } = await supabase.storage
                .from('sales_receipts')
                .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
            if (upErr) throw upErr;

            const { data: pub } = supabase.storage.from('sales_receipts').getPublicUrl(path);
            const receiptUrl = pub.publicUrl;

            // is_off_shift değeri formun submit'lendiği andaki vardiya durumuna göre
            const onShift = isUserOnShiftAt(currentUser.id, new Date(), currentWeekShifts);

            const payload = {
                employee_id: currentUser.id,
                branch: salesForm.branch,
                product_name: salesForm.product,
                quantity: salesForm.quantity,
                sale_date: salesForm.date,
                status: 'Bekliyor',
                is_off_shift: !onShift,
                receipt_url: receiptUrl
            };
            const { data, error } = await supabase.from('sales_logs').insert([payload]).select();
            if (error) throw error;

            if (data && isMounted.current) {
                const newLog: SalesLog = {
                    id: data[0].id,
                    employeeId: data[0].employee_id,
                    branch: data[0].branch,
                    productName: data[0].product_name,
                    quantity: data[0].quantity,
                    saleDate: data[0].sale_date,
                    status: 'Bekliyor',
                    createdAt: data[0].created_at,
                    isOffShift: !!data[0].is_off_shift,
                    receiptUrl: data[0].receipt_url || receiptUrl
                };
                setSalesData(prev => [newLog, ...prev]);

                // Vardiya dışı ise admin'lere push gönder
                if (!onShift) {
                    notifyEvent({
                        type: 'off_shift_sale',
                        employee_id: currentUser.id,
                        employee_name: currentUser.name,
                        branch: salesForm.branch,
                        product_name: salesForm.product,
                        quantity: salesForm.quantity,
                    });
                }

                alert(t('sales.alertSuccess'));
            }
        } catch (err: any) {
            alert(t('sales.alertUploadFailed') + (err.message || err));
        } finally {
            if (isMounted.current) setIsSaving(false);
        }
    };

    const handleUpdateStatus = async (id: string, newStatus: 'Onaylandı' | 'Reddedildi') => {
        if(!isAdmin) return;
        try {
            await supabase.from('sales_logs').update({ status: newStatus }).eq('id', id);
            setSalesData(prev => prev.map(l => l.id === id ? { ...l, status: newStatus } : l));
        } catch (err) { console.error(err); }
    };
  
    const handleDeleteSale = async (id: string) => {
        if(!confirm(t('sales.deleteConfirm'))) return;
        try {
            await supabase.from('sales_logs').delete().eq('id', id);
            setSalesData(prev => prev.filter(l => l.id !== id));
        } catch (err) { console.error(err); }
    };

    // Filtered Data Logic
    const filteredResults = useMemo(() => {
        return salesData.filter(s => {
            const date = new Date(s.saleDate);
            const matchesYear = date.getFullYear() === selectedYear;
            const matchesMonth = (date.getMonth() + 1) === selectedMonth;
            
            // Personel artık havuzda - herkes tüm satışları görebilir, admin şube filtresi kullanabilir
            const matchesBranch = selectedBranch === 'ALL' || s.branch === selectedBranch;

            return matchesYear && matchesMonth && matchesBranch;
        });
    }, [salesData, selectedYear, selectedMonth, selectedBranch]);

    // Leaderboard Data (With Masking Logic & GLOBAL SCOPE)
    const leaderboardData = useMemo(() => {
        const currentMonthData = salesData.filter(s => {
            const d = new Date(s.saleDate);
            return d.getFullYear() === selectedYear && 
                   (d.getMonth() + 1) === selectedMonth && 
                   s.status === 'Onaylandı';
        });

        const personnelMap: Record<string, number> = {};
        currentMonthData.forEach(s => {
            const empId = s.employeeId || 'unknown';
            personnelMap[empId] = (personnelMap[empId] || 0) + s.quantity;
        });

        return Object.entries(personnelMap)
            .map(([id, count]) => {
                if (id === 'unknown') return null;
                const emp = employees.find(e => e.id === id);
                const isMe = id === currentUser.id;

                const displayName = (isAdmin || isMe) ? (emp?.name || 'Bilinmeyen') : '???????';
                const displayAvatar = (isAdmin || isMe) 
                    ? (emp?.avatarUrl || `https://ui-avatars.com/api/?name=${emp?.name || '?'}`)
                    : `https://ui-avatars.com/api/?name=?&background=27272a&color=52525b&length=1`; 
                const displayBranch = (isAdmin || isMe) ? (emp?.branch || '-') : '***';

                return { id, name: displayName, avatar: displayAvatar, count, branch: displayBranch, isMe, role: emp?.role };
            })
            .filter(Boolean)
            .sort((a, b) => (b?.count || 0) - (a?.count || 0));
    }, [salesData, selectedYear, selectedMonth, employees, isAdmin, currentUser.id]);

    // Statistics based on filtered data
    const stats = useMemo(() => {
        const approvedCount = filteredResults.filter(s => s.status === 'Onaylandı').reduce((a, b) => a + b.quantity, 0);
        const pendingCount = filteredResults.filter(s => s.status === 'Bekliyor').reduce((a, b) => a + b.quantity, 0);
        
        const branchMap: Record<string, { approved: number, pending: number }> = {};
        filteredResults.forEach(s => {
            const b = s.branch || 'Bilinmiyor';
            if (!branchMap[b]) branchMap[b] = { approved: 0, pending: 0 };
            if (s.status === 'Onaylandı') branchMap[b].approved += s.quantity;
            else branchMap[b].pending += s.quantity;
        });

        const chartData = Object.entries(branchMap).map(([name, val]) => ({
            name,
            approved: val.approved,
            pending: val.pending
        })).sort((a,b) => (b.approved + b.pending) - (a.approved + a.pending));

        const productMap: Record<string, number> = {};
        filteredResults.forEach(s => {
            productMap[s.productName] = (productMap[s.productName] || 0) + s.quantity;
        });
        const topProduct = Object.keys(productMap).sort((a, b) => productMap[b] - productMap[a])[0];

        return { approvedCount, pendingCount, chartData, topProduct, topProductVal: productMap[topProduct] || 0 };
    }, [filteredResults]);

    // --- HELPER: STAFF CARD CALCULATIONS ---
    const getStaffPerformance = (staffId: string) => {
        const staffSales = salesData.filter(s => s.employeeId === staffId);
        const totalSales = staffSales.reduce((a, b) => a + b.quantity, 0);
        const approved = staffSales.filter(s => s.status === 'Onaylandı').length;
        const rejected = staffSales.filter(s => s.status === 'Reddedildi').length;
        
        const productBreakdown: Record<string, number> = {};
        staffSales.forEach(s => {
            productBreakdown[s.productName] = (productBreakdown[s.productName] || 0) + s.quantity;
        });
        const favoriteProduct = Object.keys(productBreakdown).sort((a, b) => productBreakdown[b] - productBreakdown[a])[0] || '-';

        // Rank Calculation (Global)
        const rank = leaderboardData.findIndex(i => i?.id === staffId) + 1;
        
        // Sadece son 30 işlemi göster (Scroll testi için yeterli)
        return { totalSales, approved, rejected, favoriteProduct, rank, history: staffSales.slice(0, 30) }; 
    };

    // --- RENDER: PERFORMANCE CARD MODAL (UPDATED DESIGN) ---
    const renderPerformanceCard = () => {
        if (!selectedStaffId || !isAdmin) return null;
        
        const staff = employees.find(e => e.id === selectedStaffId);
        if (!staff) return null;

        const perf = getStaffPerformance(selectedStaffId);
        
        // Rank styling
        let rankColor = 'text-slate-600 dark:text-zinc-400';
        let rankBg = 'bg-slate-100 dark:bg-zinc-800';
        if (perf.rank === 1) { rankColor = 'text-yellow-400'; rankBg = 'bg-yellow-500/10 border-yellow-500/30'; }
        if (perf.rank === 2) { rankColor = 'text-gray-300'; rankBg = 'bg-gray-500/10 border-gray-500/30'; }
        if (perf.rank === 3) { rankColor = 'text-amber-600'; rankBg = 'bg-amber-700/10 border-amber-700/30'; }

        return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200" onClick={() => setSelectedStaffId(null)}>
                <div 
                    className="w-full max-w-2xl h-[85vh] bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-3xl shadow-2xl flex flex-col overflow-hidden relative ring-1 ring-white/10"
                    onClick={e => e.stopPropagation()}
                >
                    {/* --- FIXED HEADER SECTION --- */}
                    <div className="shrink-0 p-6 border-b border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 backdrop-blur relative overflow-hidden">
                        {/* Decorative Background */}
                        <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-900/10 rounded-full blur-3xl pointer-events-none -mr-16 -mt-16"></div>
                        
                        <div className="flex justify-between items-start relative z-10">
                            <div className="flex gap-5 items-center">
                                <div className="relative">
                                    <div className="w-20 h-20 rounded-full p-1 bg-gradient-to-br from-zinc-700 to-zinc-800 shadow-xl">
                                        <img src={staff.avatarUrl} className="w-full h-full rounded-full object-cover border-2 border-slate-200 dark:border-zinc-950" referrerPolicy="no-referrer" />
                                    </div>
                                    <div className={`absolute -bottom-2 -right-2 w-8 h-8 flex items-center justify-center rounded-full border-4 border-slate-200 dark:border-zinc-950 text-xs font-bold ${rankBg} ${rankColor}`}>
                                        #{perf.rank}
                                    </div>
                                </div>
                                <div>
                                    <h2 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">{staff.name}</h2>
                                    <div className="flex items-center gap-3 mt-1 text-sm text-slate-600 dark:text-zinc-400">
                                        <span className="flex items-center gap-1"><User size={14}/> {staff.role}</span>
                                        <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 text-slate-700 dark:text-zinc-300">Havuz</span>
                                    </div>
                                </div>
                            </div>
                            <button onClick={() => setSelectedStaffId(null)} className="p-2 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white rounded-full transition-colors">
                                <X size={20} />
                            </button>
                        </div>
                    </div>

                    {/* --- SCROLLABLE CONTENT BODY --- */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-8 bg-slate-50 dark:bg-zinc-950 pb-24">
                        
                        {/* 1. Main Stats Grid */}
                        <div className="grid grid-cols-3 gap-4">
                            <div className="p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 flex flex-col gap-1 hover:border-indigo-500/30 transition-colors group">
                                <span className="text-[10px] text-slate-500 dark:text-zinc-500 font-bold uppercase tracking-wider">{t('sales.totalSales')}</span>
                                <span className="text-2xl font-black text-slate-900 dark:text-white group-hover:text-indigo-400 transition-colors">{perf.totalSales}</span>
                            </div>
                            <div className="p-4 rounded-2xl bg-green-950/20 border border-green-900/30 flex flex-col gap-1">
                                <span className="text-[10px] text-green-500/70 font-bold uppercase tracking-wider">{t('sales.approved')}</span>
                                <span className="text-2xl font-black text-green-500">{perf.approved}</span>
                            </div>
                            <div className="p-4 rounded-2xl bg-orange-950/20 border border-orange-900/30 flex flex-col gap-1">
                                <span className="text-[10px] text-orange-500/70 font-bold uppercase tracking-wider">{t('sales.pendingCount')}</span>
                                <span className="text-2xl font-black text-orange-500">{perf.totalSales - perf.approved - perf.rejected}</span>
                            </div>
                        </div>

                        {/* 2. Success Rate & Favorite */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                            <div className="p-5 rounded-2xl bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800">
                                <div className="flex justify-between items-end mb-3">
                                    <span className="text-xs font-bold text-slate-600 dark:text-zinc-400 uppercase">{t('sales.successRate')}</span>
                                    <span className="text-xl font-bold text-slate-900 dark:text-white">{perf.totalSales > 0 ? Math.round((perf.approved / perf.totalSales) * 100) : 0}%</span>
                                </div>
                                <div className="w-full h-2 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                                    <div 
                                        className="h-full bg-gradient-to-r from-blue-500 to-indigo-500" 
                                        style={{width: `${perf.totalSales > 0 ? Math.round((perf.approved / perf.totalSales) * 100) : 0}%`}}
                                    ></div>
                                </div>
                            </div>
                            <div className="p-5 rounded-2xl bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 flex items-center gap-4">
                                <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-400">
                                    <Zap size={20} />
                                </div>
                                <div>
                                    <span className="text-xs font-bold text-slate-500 dark:text-zinc-500 uppercase block mb-0.5">{t('sales.favProduct')}</span>
                                    <span className="text-sm font-bold text-slate-900 dark:text-white truncate max-w-[150px] block">{perf.favoriteProduct}</span>
                                </div>
                            </div>
                        </div>

                        {/* 3. Detailed History List */}
                        <div>
                            <h4 className="text-sm font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                                <Clock size={16} className="text-slate-500 dark:text-zinc-500"/> 
                                {t('sales.history')} ({perf.history.length})
                            </h4>
                            <div className="space-y-3">
                                {perf.history.length === 0 ? (
                                    <div className="text-center py-10 text-slate-400 dark:text-zinc-600 italic bg-white dark:bg-zinc-900/30 rounded-2xl border border-dashed border-slate-200 dark:border-zinc-800 relative">
<GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                                        {t('sales.noHistory')}
                                    </div>
                                ) : (
                                    perf.history.map((log: any) => (
                                        <div key={log.id} className="flex items-center justify-between p-4 rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:border-zinc-700 transition-all group">
                                            <div className="flex items-center gap-4">
                                                <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-slate-600 dark:text-zinc-400 border border-slate-300 dark:border-zinc-700 group-hover:text-slate-900 dark:hover:text-white transition-colors">
                                                    <ShoppingBag size={18} />
                                                </div>
                                                <div>
                                                    <p className="text-sm font-bold text-slate-900 dark:text-white mb-0.5">{log.productName}</p>
                                                    <p className="text-[10px] text-slate-500 dark:text-zinc-500 font-medium">
                                                        {formatDate(log.saleDate)}
                                                        {formatTimeOfDay(log.createdAt) && (
                                                            <span className="ml-1.5 text-slate-400 dark:text-zinc-600 font-mono">{formatTimeOfDay(log.createdAt)}</span>
                                                        )}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className="text-sm font-bold text-slate-900 dark:text-white mb-0.5">{log.quantity} {t('sales.quantity')}</div>
                                                <span className={`inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                                                    log.status === 'Onaylandı' ? 'bg-green-500/10 text-green-500' : 
                                                    log.status === 'Reddedildi' ? 'bg-red-500/10 text-red-500' : 'bg-orange-500/10 text-orange-500'
                                                }`}>
                                                    {log.status === 'Onaylandı' ? t('sales.statusApproved') : 
                                                     log.status === 'Reddedildi' ? t('sales.statusRejected') : t('sales.statusPending')}
                                                </span>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                        
                        {/* Footer Spacer */}
                        <div className="h-4"></div>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="h-full w-full p-4 md:p-8 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b] pb-36 md:pb-8">
            
            {/* RENDER MODAL */}
            {renderPerformanceCard()}

            {/* Header & Global Filters */}
            <div className="mb-8 flex flex-col xl:flex-row justify-between items-start xl:items-end gap-6">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-4">
                        <h1 className="text-3xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-3">
                            <ShoppingBag className="text-orange-500" size={32} />
                            {t('sales.title')}
                        </h1>
                        {isAdmin && (
                            <button onClick={() => setShowProductModal(true)} className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700 hover:border-orange-500/50 text-slate-900 dark:text-white rounded-xl transition-colors text-xs font-medium shadow-lg">
                                <Settings size={14} className="text-orange-400" />
                                {t('sales.productMgmt')}
                            </button>
                        )}
                    </div>
                    <p className="text-slate-500 dark:text-zinc-500 text-sm flex items-center gap-2">
                        <Activity size={14} className="text-green-500" />
                        {formatDate(new Date(selectedYear, selectedMonth - 1, 1), { month: 'long', year: 'numeric' })}
                    </p>
                </div>
                
                <div className="flex flex-col md:flex-row items-start md:items-center gap-3 bg-white dark:bg-zinc-900/50 p-2 rounded-2xl border border-slate-200 dark:border-zinc-800 relative min-w-0 w-full xl:w-auto">
<GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                    <div className="flex items-center gap-2 px-3 md:border-r border-slate-200 dark:border-zinc-800 w-full md:w-auto">
                        <Filter size={14} className="text-slate-500 dark:text-zinc-500 shrink-0" />
                        <select 
                            value={selectedYear} 
                            onChange={e => setSelectedYear(Number(e.target.value))}
                            className="bg-transparent text-sm font-bold text-slate-700 dark:text-zinc-300 outline-none cursor-pointer hover:text-slate-900 dark:hover:text-white"
                        >
                            {YEARS.map(y => <option key={y} value={y} className="bg-white dark:bg-zinc-900">{y}</option>)}
                        </select>
                        <select 
                            value={selectedMonth} 
                            onChange={e => setSelectedMonth(Number(e.target.value))}
                            className="bg-transparent text-sm font-bold text-slate-700 dark:text-zinc-300 outline-none cursor-pointer hover:text-slate-900 dark:hover:text-white"
                        >
                            {MONTHS.map(m => <option key={m.v} value={m.v} className="bg-white dark:bg-zinc-900">{m.l}</option>)}
                        </select>
                    </div>

                    <div className="flex gap-1 overflow-x-auto max-w-full w-full md:w-auto pb-1 md:pb-0 custom-scrollbar">
                        {isAdmin ? (
                            <>
                                <button 
                                    onClick={() => setSelectedBranch('ALL')}
                                    className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${selectedBranch === 'ALL' ? 'bg-white text-black' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                                >
                                    All
                                </button>
                                {Object.values(Branch).map(b => (
                                    <button 
                                        key={b}
                                        onClick={() => setSelectedBranch(b)}
                                        className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${selectedBranch === b ? 'bg-orange-600 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                                    >
                                        {b}
                                    </button>
                                ))}
                            </>
                        ) : (
                            <div className="px-4 py-1.5 bg-emerald-600/20 text-emerald-400 rounded-lg text-xs font-bold border border-emerald-500/30 flex items-center gap-2">
                                Havuz
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* SALES INPUT FORM (Ported from ShiftSchedule) */}
            <div className="mb-8 bg-orange-600 border border-orange-500 rounded-2xl p-6 shadow-xl shadow-orange-950/20">
                <div className="flex flex-col lg:flex-row items-center gap-6">
                    <div className="flex-1 w-full space-y-2">
                        <h3 className="text-slate-900 dark:text-white font-black uppercase text-sm flex items-center gap-2">
                            <Tag size={16}/> {t('sales.newEntry')}
                        </h3>
                        <p className="text-orange-100 text-xs">{t('sales.entryDesc')}</p>
                    </div>
                    <form onSubmit={handleSaveSale} className="w-full lg:w-auto flex flex-col sm:flex-row flex-wrap lg:flex-nowrap items-stretch sm:items-end gap-3">
                        <div className="flex-1 w-full sm:w-auto lg:w-40">
                            <input type="date" value={salesForm.date} onChange={e => setSalesForm({...salesForm, date: e.target.value})} className="w-full bg-orange-700/50 border border-orange-400/30 rounded-xl px-4 py-3 text-sm text-slate-900 dark:text-white outline-none focus:bg-orange-700" />
                        </div>
                        <div className="flex-1 w-full sm:w-auto lg:w-40">
                            <select required value={salesForm.branch} onChange={e => setSalesForm({...salesForm, branch: e.target.value})} className="w-full bg-orange-700/50 border border-orange-400/30 rounded-xl px-4 py-3 text-sm text-slate-900 dark:text-white outline-none focus:bg-orange-700" title={t('sales.branch')}>
                                {Object.values(Branch).map(b => <option key={b} value={b} className="text-zinc-900">{b}</option>)}
                            </select>
                        </div>
                        <div className="flex-[2] w-full sm:w-auto lg:w-64">
                            <select value={salesForm.product} onChange={e => setSalesForm({...salesForm, product: e.target.value})} className="w-full bg-orange-700/50 border border-orange-400/30 rounded-xl px-4 py-3 text-sm text-slate-900 dark:text-white outline-none focus:bg-orange-700">
                                {actionProducts.filter(p => p.is_active === true || String(p.is_active).toLowerCase() === 'true' || p.is_active === 1).length === 0 && <option value="" disabled className="text-zinc-900">{t('sales.productNotFound')}</option>}
                                {actionProducts.filter(p => p.is_active === true || String(p.is_active).toLowerCase() === 'true' || p.is_active === 1).map(p => <option key={p.id} value={p.name} className="text-zinc-900">{p.name}</option>)}
                            </select>
                        </div>
                        <div className="flex gap-3 w-full sm:w-auto">
                            <div className="flex-1 sm:w-24">
                                <input type="number" min="1" value={salesForm.quantity} onChange={e => setSalesForm({...salesForm, quantity: parseInt(e.target.value)})} className="w-full bg-orange-700/50 border border-orange-400/30 rounded-xl px-4 py-3 text-sm text-slate-900 dark:text-white font-bold text-center outline-none focus:bg-orange-700" />
                            </div>
                            <button type="submit" disabled={isSaving} className="flex-1 sm:flex-none px-6 py-3 bg-white text-orange-600 font-black rounded-xl hover:scale-105 active:scale-95 transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed">
                                {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />}
                                {isSaving ? t('common.loading') : t('sales.takeReceiptAdd')}
                            </button>
                        </div>
                        {/* Gizli file inputlar — modal'dan tetiklenir.
                            capture="environment" → arka kamera; capture yok → galeri/dosya */}
                        <input
                            ref={cameraInputRef}
                            type="file"
                            accept="image/*"
                            capture="environment"
                            onChange={handleReceiptSelected}
                            className="sr-only"
                            tabIndex={-1}
                            aria-hidden="true"
                        />
                        <input
                            ref={galleryInputRef}
                            type="file"
                            accept="image/*"
                            onChange={handleReceiptSelected}
                            className="sr-only"
                            tabIndex={-1}
                            aria-hidden="true"
                        />
                    </form>
                </div>
            </div>

            {/* KAYNAK SEÇİM MODAL'I — Kamera mı, Galeri mi? */}
            {showSourceModal && (
                <div className="fixed inset-0 z-[100] flex items-end md:items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                    <div className="w-full max-w-md bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden">
                        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-zinc-800">
                            <div className="flex items-center gap-2 text-slate-900 dark:text-white font-semibold">
                                <Receipt size={18} className="text-orange-400" />
                                Fiş Fotoğrafı
                            </div>
                            <button
                                onClick={() => setShowSourceModal(false)}
                                className="text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white"
                                aria-label="Kapat"
                            >
                                <X size={18} />
                            </button>
                        </div>
                        <div className="p-5 space-y-3">
                            <p className="text-sm text-slate-700 dark:text-zinc-300 mb-4">
                                Fişi nasıl eklemek istersin?
                            </p>
                            <button
                                onClick={() => triggerSourceInput('camera')}
                                className="w-full flex items-center gap-4 p-4 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 border border-slate-300 dark:border-zinc-700 hover:border-orange-500/40 rounded-xl transition-all group"
                            >
                                <div className="w-12 h-12 rounded-xl bg-orange-500/20 border border-orange-500/30 flex items-center justify-center text-orange-400 group-hover:scale-110 transition-transform shrink-0">
                                    <Camera size={22} />
                                </div>
                                <div className="text-left flex-1">
                                    <div className="text-slate-900 dark:text-white font-semibold text-sm">Kamera ile Çek</div>
                                    <div className="text-xs text-slate-500 dark:text-zinc-500 mt-0.5">Fişi şu an kamerayla fotoğrafla</div>
                                </div>
                            </button>
                            <button
                                onClick={() => triggerSourceInput('gallery')}
                                className="w-full flex items-center gap-4 p-4 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 border border-slate-300 dark:border-zinc-700 hover:border-indigo-500/40 rounded-xl transition-all group"
                            >
                                <div className="w-12 h-12 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 group-hover:scale-110 transition-transform shrink-0">
                                    <Upload size={22} />
                                </div>
                                <div className="text-left flex-1">
                                    <div className="text-slate-900 dark:text-white font-semibold text-sm">Galeriden Yükle</div>
                                    <div className="text-xs text-slate-500 dark:text-zinc-500 mt-0.5">Ekran görüntüsü veya kayıtlı fotoğraf seç</div>
                                </div>
                            </button>
                        </div>
                        <div className="px-5 py-3 border-t border-slate-200 dark:border-zinc-800 flex justify-end">
                            <button
                                onClick={() => setShowSourceModal(false)}
                                className="px-4 py-2 text-sm text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white"
                            >
                                İptal
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Quick Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 p-6 rounded-2xl relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-20 h-20 bg-green-500/10 rounded-full blur-2xl"></div>
                    <p className="text-xs text-slate-500 dark:text-zinc-500 font-bold uppercase tracking-wider mb-1">{t('sales.approvedCount')}</p>
                    <p className="text-3xl font-bold text-green-400">{stats.approvedCount}</p>
                </div>
                <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 p-6 rounded-2xl relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-20 h-20 bg-orange-500/10 rounded-full blur-2xl"></div>
                    <p className="text-xs text-slate-500 dark:text-zinc-500 font-bold uppercase tracking-wider mb-1">{t('sales.pendingCount')}</p>
                    <p className="text-3xl font-bold text-orange-400">{stats.pendingCount}</p>
                </div>
                <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 p-6 rounded-2xl relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-20 h-20 bg-blue-500/10 rounded-full blur-2xl"></div>
                    <p className="text-xs text-slate-500 dark:text-zinc-500 font-bold uppercase tracking-wider mb-1">{t('sales.totalTx')}</p>
                    <p className="text-3xl font-bold text-slate-900 dark:text-white">{stats.approvedCount + stats.pendingCount}</p>
                </div>
                <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 p-6 rounded-2xl relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-20 h-20 bg-purple-500/10 rounded-full blur-2xl"></div>
                    <p className="text-xs text-slate-500 dark:text-zinc-500 font-bold uppercase tracking-wider mb-1">{t('sales.bestSeller')}</p>
                    <div className="flex items-baseline gap-2">
                        <p className="text-xl font-bold text-purple-400 truncate">{stats.topProduct || '-'}</p>
                        <span className="text-xs text-slate-400 dark:text-zinc-600">({stats.topProductVal})</span>
                    </div>
                </div>
            </div>

            <div className="mb-8">
                {/* Visual Chart */}
                <div className="bg-white dark:bg-zinc-900/30 border border-slate-200 dark:border-zinc-800 rounded-3xl p-6 flex flex-col">
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                        <BarChart3 className="text-indigo-500" size={20}/>
                        {t('sales.chartTitle')}
                    </h3>
                    <div className="flex-1 min-h-[300px] w-full overflow-hidden">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={stats.chartData} barSize={40}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                                <XAxis dataKey="name" stroke="#71717a" fontSize={12} tickLine={false} axisLine={false} dy={10}/>
                                <YAxis stroke="#71717a" fontSize={12} tickLine={false} axisLine={false} />
                                <Tooltip 
                                    cursor={{fill: '#27272a', opacity: 0.2}}
                                    contentStyle={{ backgroundColor: '#09090b', border: '1px solid #27272a', borderRadius: '12px', color: '#fff' }}
                                />
                                <Legend wrapperStyle={{paddingTop: '20px'}} />
                                <Bar dataKey="approved" name={t('sales.statusApproved')} stackId="a" fill="#22c55e" radius={[0, 0, 4, 4]} />
                                <Bar dataKey="pending" name={t('sales.statusPending')} stackId="a" fill="#f97316" radius={[4, 4, 0, 0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            </div>

            {/* DETAILED TABLE SECTION (UPDATED WITH ACTIONS) */}
            <div className="bg-white dark:bg-zinc-900/30 border border-slate-200 dark:border-zinc-800 rounded-3xl overflow-hidden shadow-2xl">
                <div className="p-6 border-b border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950/50 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div>
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                            <ListTodo className="text-blue-500" size={20}/>
                            {t('sales.tableTitle')}
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-zinc-500 mt-1">
                            {isAdmin ? t('sales.tableDescAdmin') : t('sales.tableDescStaff')}
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 rounded-lg border border-green-500/20">
                            <div className="w-2 h-2 rounded-full bg-green-500"></div>
                            <span className="text-[10px] font-bold text-green-400 uppercase">{t('sales.statusApproved')}</span>
                        </div>
                        <div className="flex items-center gap-2 px-3 py-1.5 bg-orange-500/10 rounded-lg border border-orange-500/20">
                            <div className="w-2 h-2 rounded-full bg-orange-500"></div>
                            <span className="text-[10px] font-bold text-orange-400 uppercase">{t('sales.statusPending')}</span>
                        </div>
                    </div>
                </div>
                
                {/* Desktop Table */}
                <div className="hidden md:block overflow-x-auto custom-scrollbar">
                    <table className="w-full text-left">
                        <thead className="bg-slate-50 dark:bg-zinc-950 border-b border-slate-200 dark:border-zinc-800">
                            <tr className="text-[11px] font-bold text-slate-500 dark:text-zinc-500 uppercase tracking-widest">
                                <th className="p-4">{t('sales.date')}</th>
                                <th className="p-4">{t('sales.personnel')}</th>
                                <th className="p-4">{t('sales.branch')}</th>
                                <th className="p-4">{t('sales.product')}</th>
                                <th className="p-4 text-center">{t('sales.quantity')}</th>
                                <th className="p-4 text-right">{t('sales.statusActionCol')}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800">
                            {filteredResults.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="p-12 text-center text-slate-400 dark:text-zinc-600 italic">
                                        {t('sales.noData')}
                                    </td>
                                </tr>
                            ) : filteredResults.map(log => {
                                const emp = employees.find(e => e.id === log.employeeId);
                                const isMe = log.employeeId === currentUser.id;
                                const isPending = log.status === 'Bekliyor';

                                const displayName = (isAdmin || isMe) ? (emp?.name || 'Bilinmeyen') : '???????';
                                const displayAvatar = (isAdmin || isMe) 
                                    ? (emp?.avatarUrl || `https://ui-avatars.com/api/?name=${emp?.name || '?'}`)
                                    : `https://ui-avatars.com/api/?name=?&background=18181b&color=52525b`;

                                const entryTime = formatTimeOfDay(log.createdAt);
                                const showOffShift = canSeeOffShift && log.isOffShift;
                                return (
                                    <tr key={log.id} className={`hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800/30 transition-colors group ${isPending ? 'bg-orange-500/5' : ''} ${showOffShift ? 'bg-red-500/5' : ''}`}>
                                        <td className="p-4">
                                            <div className="flex flex-col gap-1">
                                                <div className="flex items-center gap-2">
                                                    <Calendar size={14} className="text-slate-400 dark:text-zinc-600" />
                                                    <span className="text-sm font-medium text-slate-600 dark:text-zinc-400">{formatDate(log.saleDate)}</span>
                                                    {entryTime && (
                                                        <span className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-500 dark:text-zinc-500 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 px-1.5 py-0.5 rounded">
                                                            <Clock size={10} /> {entryTime}
                                                        </span>
                                                    )}
                                                </div>
                                                {showOffShift && (
                                                    <span className="inline-flex items-center gap-1 self-start text-[9px] font-bold uppercase tracking-wider text-red-400 bg-red-500/10 border border-red-500/30 px-1.5 py-0.5 rounded" title={t('sales.offShiftBadgeTitle')}>
                                                        <AlertTriangle size={10} /> {t('sales.offShift')}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="p-4">
                                            <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full overflow-hidden border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
                                                    <img src={displayAvatar} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                                </div>
                                                <span className={`text-sm font-bold ${isMe ? 'text-orange-400' : 'text-slate-800 dark:text-zinc-200'}`}>
                                                    {displayName}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="p-4">
                                            <span className="text-xs font-bold text-slate-500 dark:text-zinc-500 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 px-2 py-1 rounded">
                                                {log.branch}
                                            </span>
                                        </td>
                                        <td className="p-4">
                                            <div className="flex items-center gap-2">
                                                <Package size={14} className="text-indigo-400" />
                                                <span className="text-sm text-slate-800 dark:text-zinc-200">{log.productName}</span>
                                            </div>
                                        </td>
                                        <td className="p-4 text-center">
                                            <span className={`text-base font-mono font-bold ${isPending ? 'text-orange-400' : 'text-slate-900 dark:text-white'}`}>
                                                {log.quantity}
                                            </span>
                                        </td>
                                        <td className="p-4 text-right">
                                            {/* ADMIN ACTIONS OR STATUS BADGE */}
                                            {isAdmin && isPending ? (
                                                <div className="flex justify-end gap-2">
                                                    <button onClick={() => handleUpdateStatus(log.id, 'Onaylandı')} className="p-1.5 bg-green-500/10 text-green-500 hover:bg-green-500 hover:text-slate-900 dark:hover:text-white rounded-lg transition-all" title={t('sales.statusApproved')}>
                                                        <CheckCircle2 size={16}/>
                                                    </button>
                                                    <button onClick={() => handleUpdateStatus(log.id, 'Reddedildi')} className="p-1.5 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-slate-900 dark:hover:text-white rounded-lg transition-all" title={t('sales.statusRejected')}>
                                                        <XCircle size={16}/>
                                                    </button>
                                                    <button onClick={() => handleDeleteSale(log.id)} className="p-1.5 bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 hover:text-slate-900 dark:hover:text-white rounded-lg transition-all" title={t('tasks.delete')}>
                                                        <Trash2 size={16}/>
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="flex justify-end items-center gap-3">
                                                    <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-[10px] font-bold uppercase ${
                                                        log.status === 'Onaylandı' ? 'bg-green-500/10 text-green-500 border-green-500/20' : 
                                                        log.status === 'Reddedildi' ? 'bg-red-500/10 text-red-500 border-red-500/20' : 
                                                        'bg-orange-500/10 text-orange-500 border-orange-500/20'
                                                    }`}>
                                                        {isPending ? <Clock size={10} className="animate-pulse" /> : null}
                                                        {log.status === 'Onaylandı' ? t('sales.statusApproved') : log.status === 'Reddedildi' ? t('sales.statusRejected') : t('sales.statusPending')}
                                                    </div>
                                                    {/* Staff can delete only pending items, Admin can delete any */}
                                                    {(isAdmin || (isMe && isPending)) && (
                                                        <button onClick={() => handleDeleteSale(log.id)} className="p-1.5 text-slate-400 dark:text-zinc-600 hover:text-red-500 transition-colors">
                                                            <Trash2 size={14}/>
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Mobile Cards */}
                <div className="md:hidden flex flex-col divide-y divide-zinc-800/50">
                    {filteredResults.length === 0 ? (
                        <div className="p-12 text-center text-slate-400 dark:text-zinc-600 italic">
                            {t('sales.noData')}
                        </div>
                    ) : filteredResults.map(log => {
                        const emp = employees.find(e => e.id === log.employeeId);
                        const isMe = log.employeeId === currentUser.id;
                        const isPending = log.status === 'Bekliyor';

                        const displayName = (isAdmin || isMe) ? (emp?.name || 'Bilinmeyen') : '???????';
                        const displayAvatar = (isAdmin || isMe) 
                            ? (emp?.avatarUrl || `https://ui-avatars.com/api/?name=${emp?.name || '?'}`)
                            : `https://ui-avatars.com/api/?name=?&background=18181b&color=52525b`;

                        const entryTime = formatTimeOfDay(log.createdAt);
                        const showOffShift = canSeeOffShift && log.isOffShift;
                        return (
                            <div key={log.id} className={`p-4 flex flex-col gap-3 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800/30 transition-colors ${isPending ? 'bg-orange-500/5' : ''} ${showOffShift ? 'bg-red-500/5' : ''}`}>
                                <div className="flex justify-between items-start">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full overflow-hidden border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
                                            <img src={displayAvatar} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                        </div>
                                        <div>
                                            <span className={`text-sm font-bold block ${isMe ? 'text-orange-400' : 'text-slate-800 dark:text-zinc-200'}`}>
                                                {displayName}
                                            </span>
                                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                                <Calendar size={12} className="text-slate-400 dark:text-zinc-600" />
                                                <span className="text-xs font-medium text-slate-600 dark:text-zinc-400">{formatDate(log.saleDate)}</span>
                                                {entryTime && (
                                                    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-slate-500 dark:text-zinc-500 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 px-1 py-0.5 rounded">
                                                        <Clock size={9} /> {entryTime}
                                                    </span>
                                                )}
                                                {showOffShift && (
                                                    <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-red-400 bg-red-500/10 border border-red-500/30 px-1.5 py-0.5 rounded">
                                                        <AlertTriangle size={9} /> {t('sales.offShift')}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <span className={`text-lg font-mono font-bold ${isPending ? 'text-orange-400' : 'text-slate-900 dark:text-white'}`}>
                                            {log.quantity}
                                        </span>
                                        <span className="text-[10px] text-slate-500 dark:text-zinc-500 block uppercase">{t('sales.quantity')}</span>
                                    </div>
                                </div>
                                
                                <div className="flex items-center justify-between gap-2 mt-1 flex-wrap">
                                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                                        <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-emerald-500/10 border border-emerald-500/30 rounded">
                                            <MapPin size={12} className="text-emerald-400 shrink-0" />
                                            <span className="text-xs font-bold text-emerald-300 truncate">{log.branch || '—'}</span>
                                        </div>
                                        <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded">
                                            <Package size={12} className="text-indigo-400 shrink-0" />
                                            <span className="text-xs text-slate-700 dark:text-zinc-300 truncate">{log.productName}</span>
                                        </div>
                                        {log.receiptUrl && (isAdmin || isMe) && (
                                            <a
                                                href={log.receiptUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-1.5 px-2 py-1 bg-indigo-500/10 border border-indigo-500/30 rounded hover:bg-indigo-500/20 transition-colors"
                                                title={t('sales.viewReceipt')}
                                            >
                                                <Receipt size={12} className="text-indigo-400 shrink-0" />
                                                <span className="text-[10px] font-bold text-indigo-300">{t('sales.receiptBadge')}</span>
                                            </a>
                                        )}
                                    </div>
                                    
                                    {/* Actions / Status */}
                                    {isAdmin && isPending ? (
                                        <div className="flex justify-end gap-1.5">
                                            <button onClick={() => handleUpdateStatus(log.id, 'Onaylandı')} className="p-1.5 bg-green-500/10 text-green-500 hover:bg-green-500 hover:text-slate-900 dark:hover:text-white rounded-lg transition-all" title={t('sales.statusApproved')}>
                                                <CheckCircle2 size={14}/>
                                            </button>
                                            <button onClick={() => handleUpdateStatus(log.id, 'Reddedildi')} className="p-1.5 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-slate-900 dark:hover:text-white rounded-lg transition-all" title={t('sales.statusRejected')}>
                                                <XCircle size={14}/>
                                            </button>
                                            <button onClick={() => handleDeleteSale(log.id)} className="p-1.5 bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 hover:text-slate-900 dark:hover:text-white rounded-lg transition-all" title={t('tasks.delete')}>
                                                <Trash2 size={14}/>
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex justify-end items-center gap-2">
                                            <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border text-[9px] font-bold uppercase ${
                                                log.status === 'Onaylandı' ? 'bg-green-500/10 text-green-500 border-green-500/20' : 
                                                log.status === 'Reddedildi' ? 'bg-red-500/10 text-red-500 border-red-500/20' : 
                                                'bg-orange-500/10 text-orange-500 border-orange-500/20'
                                            }`}>
                                                {isPending ? <Clock size={10} className="animate-pulse" /> : null}
                                                {log.status === 'Onaylandı' ? t('sales.statusApproved') : log.status === 'Reddedildi' ? t('sales.statusRejected') : t('sales.statusPending')}
                                            </div>
                                            {(isAdmin || (isMe && isPending)) && (
                                                <button onClick={() => handleDeleteSale(log.id)} className="p-1.5 text-slate-400 dark:text-zinc-600 hover:text-red-500 transition-colors">
                                                    <Trash2 size={14}/>
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
            {/* PRODUCT MANAGEMENT MODAL */}
            {showProductModal && isAdmin && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[80vh]">
                        <div className="p-6 border-b border-slate-200 dark:border-zinc-800 flex justify-between items-center">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                <Settings size={20} className="text-orange-500" /> {t('sales.productActionMgmt')}
                            </h3>
                            <button onClick={() => setShowProductModal(false)} className="text-slate-500 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white">
                                <X size={20} />
                            </button>
                        </div>
                        <div className="p-6 flex-1 overflow-y-auto custom-scrollbar">
                            <div className="flex gap-2 mb-6">
                                <input 
                                    type="text" 
                                    value={newProductName} 
                                    onChange={e => setNewProductName(e.target.value)} 
                                    onKeyDown={e => e.key === 'Enter' && handleAddProduct()}
                                    placeholder={t('sales.newProductPlaceholder')}
                                    className="flex-1 bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-lg p-2 text-slate-900 dark:text-white text-sm outline-none focus:border-orange-500/50" 
                                />
                                <button onClick={handleAddProduct} className="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-slate-900 dark:text-white rounded-lg text-sm font-bold transition-colors">
                                    Ekle
                                </button>
                            </div>
                            <div className="space-y-2">
                                {actionProducts.length === 0 ? (
                                    <p className="text-sm text-slate-500 dark:text-zinc-500 text-center py-4">{t('sales.noProductsYet')}</p>
                                ) : actionProducts.map(product => (
                                    <div key={product.id} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-zinc-950/50 border border-slate-200 dark:border-zinc-800 rounded-lg group">
                                        <span className={`text-sm font-medium ${product.is_active ? 'text-slate-900 dark:text-white' : 'text-slate-500 dark:text-zinc-500 line-through'}`}>
                                            {product.name}
                                        </span>
                                        <div className="flex items-center gap-2">
                                            <button 
                                                onClick={() => handleToggleProductStatus(product.id, !product.is_active)} 
                                                className={`text-[10px] px-2 py-1 rounded font-bold transition-colors ${product.is_active ? 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700' : 'bg-green-900/30 text-green-400 hover:bg-green-900/50'}`}
                                            >
                                                {product.is_active ? 'Pasif Yap' : 'Aktif Yap'}
                                            </button>
                                            <button 
                                                onClick={() => handleDeleteProduct(product.id)} 
                                                className="p-1.5 text-slate-400 dark:text-zinc-600 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
                                                title="Sil"
                                            >
                                                <Trash2 size={14}/>
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Spacer for mobile bottom navigation */}
            <div className="h-24 md:h-0 w-full shrink-0"></div>
        </div>
    );
};

export default SalesDashboard;