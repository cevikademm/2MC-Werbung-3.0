import React, { useState, useEffect, useMemo } from 'react';
import { Employee, Branch } from '../types';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../lib/i18n';
import { confirmDialog } from '../lib/toast';
import {
  AlertTriangle, Package, TrendingDown, TrendingUp, ShieldAlert, BarChart3,
  Plus, Trash2, Pencil, CheckCircle2, XCircle, Filter, Calendar, MapPin, Clock,
  ArrowDownRight, ArrowUpRight, Eye, RefreshCw, Loader2, Search, FileText,
  Sparkles, Crown, Zap, Users, Activity, Award, TrendingUp as TUp
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LineChart, Line, Legend } from 'recharts';

// ========================
// KAYIP ÖNLEME PANELİ
// Erişim: cevikademm@gmail.com (whitelist)
// ========================

export const LOSS_CONTROL_ALLOWED_EMAILS = ['cevikademm@gmail.com'];

export const canAccessLossControl = (email?: string | null): boolean =>
  !!email && LOSS_CONTROL_ALLOWED_EMAILS.includes(email.trim().toLowerCase());

// Patron paneli (AI Analiz sekmesi) — şimdilik sadece bu hesap görür
export const SUPER_ADMIN_EMAIL = 'cevikademm@gmail.com';
export const isSuperAdmin = (email?: string | null): boolean =>
  !!email && email.trim().toLowerCase() === SUPER_ADMIN_EMAIL;

interface LossControlProps {
  currentUser: Employee;
}

interface StockEntry {
  id: string;
  product_name: string;
  branch: string;
  quantity: number;
  entry_date: string;
  entered_by: string;
  note?: string;
  created_at: string;
}

interface StockCount {
  id: string;
  product_name: string;
  branch: string;
  counted_quantity: number;
  count_date: string;
  counted_by: string;
  note?: string;
  created_at: string;
}

interface SalesLog {
  id: string;
  employee_id: string;
  product_name: string;
  branch: string;
  quantity: number;
  sale_date: string;
  status: string;
  created_at: string;
}

interface LossAlert {
  id: string;
  branch: string;
  product_name: string;
  expected_stock: number;
  actual_stock: number;
  difference: number;
  alert_type: 'kayip' | 'fazla' | 'anormal_satis';
  severity: 'low' | 'medium' | 'high';
  date: string;
  resolved: boolean;
  note?: string;
}

const BRANCHES = Object.values(Branch);

// WhatsApp brand icon (lucide-react'da yok, inline SVG)
const WhatsAppIcon = ({ size = 20 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" width={size} height={size} aria-hidden="true">
    <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z" />
  </svg>
);

const ADMIN_WHATSAPP = '905324961412';

const LossControl: React.FC<LossControlProps> = ({ currentUser }) => {
  const { t } = useLanguage();
  const isLossAdmin = canAccessLossControl(currentUser.email);
  const isSuper = isSuperAdmin(currentUser.email);

  const [activeSubTab, setActiveSubTab] = useState<'overview' | 'stock' | 'alerts' | 'report' | 'ai'>(isLossAdmin ? 'overview' : 'stock');
  const [isLoading, setIsLoading] = useState(true);

  // Data States
  const [stockEntries, setStockEntries] = useState<StockEntry[]>([]);
  const [stockCounts, setStockCounts] = useState<StockCount[]>([]);
  const [salesData, setSalesData] = useState<SalesLog[]>([]);
  const [alerts, setAlerts] = useState<LossAlert[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [products, setProducts] = useState<string[]>([]);

  // Filter States
  const [filterBranch, setFilterBranch] = useState<string>('ALL');
  const [filterProduct, setFilterProduct] = useState<string>('ALL');
  const [filterDateRange, setFilterDateRange] = useState<'today' | 'week' | 'month' | 'all'>('month');

  // Vardiya planı — pairing analizi için (sadece super admin için fetch ediliyor)
  const [shifts, setShifts] = useState<any[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  // Stock Entry Form
  const [stockForm, setStockForm] = useState({
    product_name: '',
    branch: BRANCHES[0],
    quantity: 0,
    entry_date: new Date().toISOString().split('T')[0],
    note: ''
  });

  // Count Form
  const [countForm, setCountForm] = useState({
    product_name: '',
    branch: BRANCHES[0],
    counted_quantity: 0,
    count_date: new Date().toISOString().split('T')[0],
    note: ''
  });

  const [showStockForm, setShowStockForm] = useState(false);
  const [showCountForm, setShowCountForm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingEntry, setEditingEntry] = useState<StockEntry | null>(null);
  const [editingCount, setEditingCount] = useState<StockCount | null>(null);

  // Mevcut Stok Durumu için periyot toggle
  const [stockPeriod, setStockPeriod] = useState<'week' | 'month'>('month');

  // Fetch all data
  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setIsLoading(true);
    try {
      // Fetch stock entries — admin-only RPC (RLS doğrudan tablo erişimini engeller)
      const { data: stockData, error: stockErr } = await supabase
        .rpc('lc_list_stock_entries', { p_caller_id: currentUser.id });
      if (stockErr) console.warn('lc_list_stock_entries:', stockErr.message);

      // Fetch stock counts — admin-only RPC
      const { data: countData, error: countErr } = await supabase
        .rpc('lc_list_stock_counts', { p_caller_id: currentUser.id });
      if (countErr) console.warn('lc_list_stock_counts:', countErr.message);

      // Fetch all sales (approved only for loss calc)
      const { data: sales } = await supabase
        .from('sales_logs')
        .select('*')
        .order('sale_date', { ascending: false });

      // Fetch products
      const { data: productsData } = await supabase
        .from('action_products')
        .select('name')
        .eq('is_active', true);

      // Fetch employees
      const { data: empData } = await supabase
        .from('profiles')
        .select('*');

      // Vardiya planı — sadece super admin pairing analizi için kullanır
      const { data: shiftData } = isSuper
        ? await supabase.from('shift_schedules').select('*')
        : { data: null };
      if (shiftData) setShifts(shiftData);
      setLastRefresh(new Date());

      if (stockData) setStockEntries(stockData);
      if (countData) setStockCounts(countData);
      if (sales) setSalesData(sales.map((s: any) => ({
        id: s.id,
        employee_id: s.employee_id,
        product_name: s.product_name,
        branch: s.branch,
        quantity: s.quantity,
        sale_date: s.sale_date,
        status: s.status,
        created_at: s.created_at
      })));
      if (productsData) setProducts(productsData.map((p: any) => p.name));
      if (empData) setEmployees(empData.map((d: any) => ({
        id: d.id,
        name: d.full_name || d.email || t('loss.unnamedStaff'),
        email: d.email,
        role: d.role,
        branch: d.branch,
        hourlyRate: d.hourly_rate || 0,
        taxClass: d.tax_class || 1,
        avatarUrl: d.avatar_url || '',
        advances: d.advances || 0,
      })));

      // Generate alerts after data load
      generateAlerts(stockData || [], countData || [], sales || []);
    } catch (err) {
      console.error('Kayıp Önleme veri hatası:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Alert Generation Logic
  const generateAlerts = (stocks: StockEntry[], counts: StockCount[], sales: any[]) => {
    const newAlerts: LossAlert[] = [];
    const approvedSales = sales.filter((s: any) => s.status === 'Onaylandı');

    // Group by branch + product
    const branchProducts = new Map<string, { stocked: number; sold: number; counted: number | null }>();

    stocks.forEach(s => {
      const key = `${s.branch}|${s.product_name}`;
      const existing = branchProducts.get(key) || { stocked: 0, sold: 0, counted: null };
      existing.stocked += s.quantity;
      branchProducts.set(key, existing);
    });

    approvedSales.forEach((s: any) => {
      const key = `${s.branch}|${s.product_name}`;
      const existing = branchProducts.get(key) || { stocked: 0, sold: 0, counted: null };
      existing.sold += s.quantity;
      branchProducts.set(key, existing);
    });

    counts.forEach(c => {
      const key = `${c.branch}|${c.product_name}`;
      const existing = branchProducts.get(key) || { stocked: 0, sold: 0, counted: null };
      existing.counted = c.counted_quantity;
      branchProducts.set(key, existing);
    });

    branchProducts.forEach((data, key) => {
      const [branch, product] = key.split('|');
      const expectedStock = data.stocked - data.sold;

      if (data.counted !== null) {
        const diff = expectedStock - data.counted;
        if (diff > 0) {
          // Kayıp var
          const severity = diff >= 5 ? 'high' : diff >= 2 ? 'medium' : 'low';
          newAlerts.push({
            id: `loss_${key}`,
            branch,
            product_name: product,
            expected_stock: expectedStock,
            actual_stock: data.counted,
            difference: diff,
            alert_type: 'kayip',
            severity,
            date: new Date().toISOString().split('T')[0],
            resolved: false
          });
        } else if (diff < -2) {
          // Fazla var (stokta olmaması gereken ürün var)
          newAlerts.push({
            id: `extra_${key}`,
            branch,
            product_name: product,
            expected_stock: expectedStock,
            actual_stock: data.counted,
            difference: Math.abs(diff),
            alert_type: 'fazla',
            severity: 'medium',
            date: new Date().toISOString().split('T')[0],
            resolved: false
          });
        }
      }
    });

    // Anomaly detection: unusual sales patterns
    const salesToday = sales.filter((s: any) => s.sale_date === new Date().toISOString().split('T')[0]);
    const salesByEmployee = new Map<string, number>();
    salesToday.forEach((s: any) => {
      salesByEmployee.set(s.employee_id, (salesByEmployee.get(s.employee_id) || 0) + s.quantity);
    });

    salesByEmployee.forEach((qty, empId) => {
      if (qty > 20) {
        // Anormal yüksek satış
        const emp = employees.find(e => e.id === empId);
        newAlerts.push({
          id: `anomaly_${empId}_${Date.now()}`,
          branch: emp?.branch || 'Bilinmiyor',
          product_name: 'Çoklu Ürün',
          expected_stock: 0,
          actual_stock: 0,
          difference: qty,
          alert_type: 'anormal_satis',
          severity: 'high',
          date: new Date().toISOString().split('T')[0],
          resolved: false,
          note: `${emp?.name || empId} - Günlük ${qty} adet satış (Anormal)`
        });
      }
    });

    setAlerts(newAlerts);
  };

  // Open Edit / Reset helpers
  const resetStockForm = () => setStockForm({ product_name: '', branch: BRANCHES[0], quantity: 0, entry_date: new Date().toISOString().split('T')[0], note: '' });
  const resetCountForm = () => setCountForm({ product_name: '', branch: BRANCHES[0], counted_quantity: 0, count_date: new Date().toISOString().split('T')[0], note: '' });

  const closeStockForm = () => { setShowStockForm(false); setEditingEntry(null); resetStockForm(); };
  const closeCountForm = () => { setShowCountForm(false); setEditingCount(null); resetCountForm(); };

  const openEditEntry = (e: StockEntry) => {
    setEditingEntry(e);
    setStockForm({ product_name: e.product_name, branch: e.branch, quantity: e.quantity, entry_date: e.entry_date, note: e.note || '' });
    setShowStockForm(true);
  };

  const openEditCount = (c: StockCount) => {
    setEditingCount(c);
    setCountForm({ product_name: c.product_name, branch: c.branch, counted_quantity: c.counted_quantity, count_date: c.count_date, note: c.note || '' });
    setShowCountForm(true);
  };

  // Save Stock Entry (insert or update) — admin-only RPC
  const handleSaveStockEntry = async () => {
    if (!stockForm.product_name || stockForm.quantity <= 0) return;
    setIsSaving(true);
    try {
      const { error } = await supabase.rpc('lc_save_stock_entry', {
        p_caller_id: currentUser.id,
        p_id: editingEntry?.id || null,
        p_product_name: stockForm.product_name,
        p_branch: stockForm.branch,
        p_quantity: stockForm.quantity,
        p_entry_date: stockForm.entry_date,
        p_note: stockForm.note || null,
      });
      if (error) throw error;
      closeStockForm();
      fetchAllData();
    } catch (err) {
      alert(t('loss.alertSaveStockFail') + (err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  // Save Stock Count (insert or update) — admin-only RPC
  const handleSaveCount = async () => {
    if (!countForm.product_name || countForm.counted_quantity < 0) return;
    setIsSaving(true);
    try {
      const { error } = await supabase.rpc('lc_save_stock_count', {
        p_caller_id: currentUser.id,
        p_id: editingCount?.id || null,
        p_product_name: countForm.product_name,
        p_branch: countForm.branch,
        p_counted_quantity: countForm.counted_quantity,
        p_count_date: countForm.count_date,
        p_note: countForm.note || null,
      });
      if (error) throw error;
      closeCountForm();
      fetchAllData();
    } catch (err) {
      alert(t('loss.alertSaveCountFail') + (err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  // Delete handlers — admin-only RPC
  const handleDeleteEntry = async (id: string) => {
    if (!await confirmDialog({ message: t('loss.confirmDeleteStock'), danger: true })) return;
    try {
      const { error } = await supabase.rpc('lc_delete_stock_entry', {
        p_caller_id: currentUser.id,
        p_id: id,
      });
      if (error) throw error;
      fetchAllData();
    } catch (err) {
      alert('Silinemedi: ' + (err as Error).message);
    }
  };

  const handleDeleteCount = async (id: string) => {
    if (!await confirmDialog({ message: t('loss.confirmDeleteCount'), danger: true })) return;
    try {
      const { error } = await supabase.rpc('lc_delete_stock_count', {
        p_caller_id: currentUser.id,
        p_id: id,
      });
      if (error) throw error;
      fetchAllData();
    } catch (err) {
      alert('Silinemedi: ' + (err as Error).message);
    }
  };

  // (Şube, Ürün) bazında mevcut stok: toplam giriş - dönemde onaylı satış
  const currentStock = useMemo(() => {
    const map = new Map<string, { branch: string; product: string; stocked: number; sold: number }>();

    stockEntries.forEach(s => {
      const key = `${s.branch}|${s.product_name}`;
      const cur = map.get(key) || { branch: s.branch, product: s.product_name, stocked: 0, sold: 0 };
      cur.stocked += s.quantity;
      map.set(key, cur);
    });

    const days = stockPeriod === 'week' ? 7 : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // "Reddedildi" hariç tüm satışlar (Bekliyor + Onaylandı) stoktan düşer.
    // Reddedilen satış gerçekleşmemiş demek olduğu için stoktan düşmez.
    salesData
      .filter(s => s.status !== 'Reddedildi' && s.sale_date >= since)
      .forEach(s => {
        const key = `${s.branch}|${s.product_name}`;
        const cur = map.get(key) || { branch: s.branch, product: s.product_name, stocked: 0, sold: 0 };
        cur.sold += s.quantity;
        map.set(key, cur);
      });

    let rows = Array.from(map.values()).map(r => ({ ...r, remaining: r.stocked - r.sold }));
    if (filterBranch !== 'ALL') rows = rows.filter(r => r.branch === filterBranch);
    if (filterProduct !== 'ALL') rows = rows.filter(r => r.product === filterProduct);
    rows.sort((a, b) => a.branch.localeCompare(b.branch) || a.product.localeCompare(b.product));
    return rows;
  }, [stockEntries, salesData, stockPeriod, filterBranch, filterProduct]);

  // Filtered data
  const filteredSales = useMemo(() => {
    let data = salesData;
    if (filterBranch !== 'ALL') data = data.filter(s => s.branch === filterBranch);
    if (filterProduct !== 'ALL') data = data.filter(s => s.product_name === filterProduct);
    const now = new Date();
    if (filterDateRange === 'today') {
      const today = now.toISOString().split('T')[0];
      data = data.filter(s => s.sale_date === today);
    } else if (filterDateRange === 'week') {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      data = data.filter(s => s.sale_date >= weekAgo);
    } else if (filterDateRange === 'month') {
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      data = data.filter(s => s.sale_date >= monthAgo);
    }
    return data;
  }, [salesData, filterBranch, filterProduct, filterDateRange]);

  // Branch Summary Cards
  const branchSummary = useMemo(() => {
    return BRANCHES.map(branch => {
      const branchSales = filteredSales.filter(s => s.branch === branch && s.status === 'Onaylandı');
      const branchStock = stockEntries.filter(s => s.branch === branch);
      const branchCounts = stockCounts.filter(c => c.branch === branch);
      const branchAlerts = alerts.filter(a => a.branch === branch && !a.resolved);

      const totalSold = branchSales.reduce((sum, s) => sum + s.quantity, 0);
      const totalStocked = branchStock.reduce((sum, s) => sum + s.quantity, 0);
      const totalCounted = branchCounts.length > 0
        ? branchCounts.reduce((sum, c) => sum + c.counted_quantity, 0)
        : null;

      const expectedRemaining = totalStocked - totalSold;
      const loss = totalCounted !== null ? expectedRemaining - totalCounted : null;

      return {
        branch,
        totalSold,
        totalStocked,
        totalCounted,
        expectedRemaining,
        loss,
        alertCount: branchAlerts.length,
        highAlerts: branchAlerts.filter(a => a.severity === 'high').length
      };
    });
  }, [filteredSales, stockEntries, stockCounts, alerts]);

  // Trend data for chart
  const trendData = useMemo(() => {
    const last7Days: { date: string; satis: number; stok_giris: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const daySales = salesData.filter(s => s.sale_date === dateStr && s.status === 'Onaylandı')
        .reduce((sum, s) => sum + s.quantity, 0);
      const dayStock = stockEntries.filter(s => s.entry_date === dateStr)
        .reduce((sum, s) => sum + s.quantity, 0);
      last7Days.push({
        date: dateStr.slice(5), // MM-DD
        satis: daySales,
        stok_giris: dayStock
      });
    }
    return last7Days;
  }, [salesData, stockEntries]);

  // Employee name helper
  const getEmpName = (id: string) => employees.find(e => e.id === id)?.name || id;

  // ========================================================================
  // === AI ANALİZ — sadece super admin (cevikademm@gmail.com) için ===
  // Personel performansı, şube skoru, eşleşme önerileri, otomatik içgörüler
  // ========================================================================

  // Yardımcı: YYYY-MM-DD'ye gün ekle
  const addDays = (dateStr: string, n: number): string => {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
  };

  // Personel performansı (son 30 gün)
  const employeePerf = useMemo(() => {
    if (!isSuper) return [];
    const since = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const map = new Map<string, { id: string; name: string; total: number; approved: number; rejected: number; pending: number; branches: Map<string, number>; offShift: number }>();

    salesData.filter((s: any) => s.sale_date >= since).forEach((s: any) => {
      const id = s.employee_id;
      if (!id) return;
      const cur = map.get(id) || { id, name: getEmpName(id), total: 0, approved: 0, rejected: 0, pending: 0, branches: new Map(), offShift: 0 };
      cur.total += s.quantity;
      if (s.status === 'Onaylandı') cur.approved += s.quantity;
      else if (s.status === 'Reddedildi') cur.rejected += s.quantity;
      else cur.pending += s.quantity;
      if (s.is_off_shift) cur.offShift += 1;
      cur.branches.set(s.branch, (cur.branches.get(s.branch) || 0) + s.quantity);
      map.set(id, cur);
    });

    return Array.from(map.values())
      .map(e => {
        const topB = Array.from(e.branches.entries()).sort((a, b) => b[1] - a[1])[0];
        return {
          ...e,
          approvalRate: e.total > 0 ? (e.approved / e.total) * 100 : 0,
          topBranch: topB?.[0] || '-',
          topBranchSales: topB?.[1] || 0
        };
      })
      .sort((a, b) => b.approved - a.approved);
  }, [salesData, employees, isSuper]);

  // Şube skoru: onaylı satış × 10 − kayıp × 5 − red × 2 − mesai dışı × 1
  const branchScores = useMemo(() => {
    if (!isSuper) return [];
    const since = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    return BRANCHES.map(branch => {
      const branchSales = salesData.filter((s: any) => s.branch === branch && s.sale_date >= since);
      const approved = branchSales.filter((s: any) => s.status === 'Onaylandı').reduce((sum: number, s: any) => sum + s.quantity, 0);
      const pending = branchSales.filter((s: any) => s.status === 'Bekliyor').reduce((sum: number, s: any) => sum + s.quantity, 0);
      const rejected = branchSales.filter((s: any) => s.status === 'Reddedildi').reduce((sum: number, s: any) => sum + s.quantity, 0);
      const offShift = branchSales.filter((s: any) => s.is_off_shift).length;
      const branchAlerts = alerts.filter(a => a.branch === branch);
      const lossCount = branchAlerts.filter(a => a.alert_type === 'kayip').reduce((sum, a) => sum + a.difference, 0);
      const score = approved * 10 - lossCount * 5 - rejected * 2 - offShift * 1;
      return { branch, approved, pending, rejected, offShift, lossCount, score };
    }).sort((a, b) => b.score - a.score);
  }, [salesData, alerts, isSuper]);

  // Personel eşleşme önerileri: vardiya planından (date, branch) bazında çalışan
  // setlerini çıkar, her ikili için birlikte yapılan onaylı satışı topla,
  // şube ortalamasıyla karşılaştır → sinerji yüzdesi.
  const pairingRecs = useMemo(() => {
    if (!isSuper || shifts.length === 0) return [];

    // (date|branch) -> Set<employeeId>
    const dateBranchEmps = new Map<string, Set<string>>();
    shifts.forEach((row: any) => {
      const wsd = row.week_start_date;
      const branch = row.branch;
      const days: string[] = Array.isArray(row.days) ? row.days : [];
      if (!wsd || !branch) return;
      days.forEach((empId, idx) => {
        if (!empId) return;
        const date = addDays(wsd, idx);
        const key = `${date}|${branch}`;
        if (!dateBranchEmps.has(key)) dateBranchEmps.set(key, new Set());
        dateBranchEmps.get(key)!.add(empId);
      });
    });

    // (date|branch) -> onaylı satış toplamı
    const dateBranchSales = new Map<string, number>();
    salesData.filter((s: any) => s.status === 'Onaylandı').forEach((s: any) => {
      const key = `${s.sale_date}|${s.branch}`;
      dateBranchSales.set(key, (dateBranchSales.get(key) || 0) + s.quantity);
    });

    // Branch bazında: pair stats + branch günlük ortalaması
    const branchPairs = new Map<string, Map<string, { e1: string; e2: string; coDays: number; totalSales: number }>>();
    const branchDayAgg = new Map<string, { days: number; sales: number }>();

    dateBranchEmps.forEach((empSet, key) => {
      const [, branch] = key.split('|');
      const sales = dateBranchSales.get(key) || 0;
      const bAgg = branchDayAgg.get(branch) || { days: 0, sales: 0 };
      bAgg.days += 1;
      bAgg.sales += sales;
      branchDayAgg.set(branch, bAgg);
      const arr = Array.from(empSet).sort();
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const pkey = `${arr[i]}|${arr[j]}`;
          if (!branchPairs.has(branch)) branchPairs.set(branch, new Map());
          const bp = branchPairs.get(branch)!;
          const stat = bp.get(pkey) || { e1: arr[i], e2: arr[j], coDays: 0, totalSales: 0 };
          stat.coDays += 1;
          stat.totalSales += sales;
          bp.set(pkey, stat);
        }
      }
    });

    const result: { branch: string; branchAvg: number; pairs: any[] }[] = [];
    branchPairs.forEach((pairs, branch) => {
      const agg = branchDayAgg.get(branch);
      const branchAvg = agg && agg.days > 0 ? agg.sales / agg.days : 0;
      const ranked = Array.from(pairs.values())
        .filter(p => p.coDays >= 2) // anlamlı veri için min 2 ortak gün
        .map(p => ({
          ...p,
          avgSales: p.totalSales / p.coDays,
          synergy: branchAvg > 0 ? ((p.totalSales / p.coDays) / branchAvg - 1) * 100 : 0,
          name1: getEmpName(p.e1),
          name2: getEmpName(p.e2)
        }))
        .sort((a, b) => b.avgSales - a.avgSales)
        .slice(0, 3);
      if (ranked.length > 0) result.push({ branch, branchAvg, pairs: ranked });
    });
    return result;
  }, [shifts, salesData, employees, isSuper]);

  // Hero kartlar (En İyi Şube, Ayın Yıldızı, Aktif Personel, Sinerji İkilisi)
  // için sağlam fallback'li hesap. Eski yaklaşım yalnızca son 30 gün + sadece
  // 'Onaylandı' satışlarına bakıyordu — onay süreci geri kalmışsa veya satışlar
  // 30 günden eskiyse kartlar boş kalıyordu. Bu hesap üç katmanlı:
  //   1) son 30 gün, sadece onaylı  →  yoksa
  //   2) son 30 gün, onaylı + bekleyen  →  yoksa
  //   3) tüm tarih aralığı, onaylı + bekleyen
  // Hangi katmandan veri geldiği `mode` alanında döner; UI alt yazıyı buna göre
  // değiştirir ("0 onaylı" yerine "5 satış (onay bekliyor)" gibi).
  const heroStats = useMemo(() => {
    if (!isSuper) {
      return {
        topBranch: null as { branch: string; count: number } | null,
        topEmployee: null as { name: string; sales: number; approvalRate: number } | null,
        activeEmployeeCount: 0,
        bestPair: null as { name1: string; name2: string; branch: string; synergy: number } | null,
        mode: 'approved30' as 'approved30' | 'all30' | 'allTime',
      };
    }
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const isApprovedSale = (s: any) => s.status === 'Onaylandı';
    const isCountableSale = (s: any) => s.status !== 'Reddedildi'; // Onaylandı + Bekliyor

    // Aday filtre setleri (öncelik sırası)
    const sets: { key: 'approved30' | 'all30' | 'allTime'; pool: any[] }[] = [
      { key: 'approved30', pool: salesData.filter(s => s.sale_date >= since30 && isApprovedSale(s)) },
      { key: 'all30',      pool: salesData.filter(s => s.sale_date >= since30 && isCountableSale(s)) },
      { key: 'allTime',    pool: salesData.filter(isCountableSale) },
    ];
    const chosen = sets.find(s => s.pool.length > 0) || sets[2];
    const pool = chosen.pool;
    const mode = chosen.key;

    // Şube → adet (quantity bazlı)
    const branchTotals = new Map<string, number>();
    // Personel → { total, approved, total-quantity, branchMap }
    const empAgg = new Map<string, { id: string; total: number; approved: number; branches: Map<string, number> }>();
    pool.forEach(s => {
      branchTotals.set(s.branch, (branchTotals.get(s.branch) || 0) + s.quantity);
      const id = s.employee_id;
      if (!id) return;
      const cur = empAgg.get(id) || { id, total: 0, approved: 0, branches: new Map() };
      cur.total += s.quantity;
      if (isApprovedSale(s)) cur.approved += s.quantity;
      cur.branches.set(s.branch, (cur.branches.get(s.branch) || 0) + s.quantity);
      empAgg.set(id, cur);
    });

    const topBranchEntry = Array.from(branchTotals.entries()).sort((a, b) => b[1] - a[1])[0];
    const topBranch = topBranchEntry ? { branch: topBranchEntry[0], count: topBranchEntry[1] } : null;

    const topEmpEntry = Array.from(empAgg.values()).sort((a, b) => b.total - a.total)[0];
    const topEmployee = topEmpEntry ? {
      name: getEmpName(topEmpEntry.id),
      sales: topEmpEntry.total,
      approvalRate: topEmpEntry.total > 0 ? (topEmpEntry.approved / topEmpEntry.total) * 100 : 0,
    } : null;

    const activeEmployeeCount = empAgg.size;

    // Sinerji ikilisi — pairingRecs'ten en iyi çift, zayıfsa null kalır
    const bestPairRaw = pairingRecs.flatMap(b => b.pairs.map(p => ({ ...p, branchName: b.branch })))
      .sort((a, b) => b.synergy - a.synergy)[0];
    const bestPair = bestPairRaw ? {
      name1: bestPairRaw.name1,
      name2: bestPairRaw.name2,
      branch: bestPairRaw.branchName,
      synergy: bestPairRaw.synergy,
    } : null;

    return { topBranch, topEmployee, activeEmployeeCount, bestPair, mode };
  }, [salesData, employees, pairingRecs, isSuper]);

  // Otomatik içgörüler — anlamlı tek cümlelik tespitler
  const autoInsights = useMemo(() => {
    if (!isSuper) return [];
    const out: { type: 'success' | 'warning' | 'info'; text: string }[] = [];

    if (branchScores.length > 0) {
      const top = branchScores[0];
      if (top.approved > 0) out.push({ type: 'success', text: `🏆 ${top.branch} son 30 günün lideri — ${top.approved} onaylı satış, skor ${top.score}.` });
      const bottom = branchScores[branchScores.length - 1];
      if (bottom.score < top.score / 2 && top.score > 0) {
        out.push({ type: 'warning', text: `⚠️ ${bottom.branch} performansı düşük: ${bottom.approved} satış. ${top.branch}'a göre %${(((top.score - bottom.score) / Math.max(1, top.score)) * 100).toFixed(0)} geride.` });
      }
    }

    if (employeePerf.length > 0) {
      const topEmp = employeePerf[0];
      if (topEmp.approved > 0) out.push({ type: 'success', text: `💪 ${topEmp.name} ayın yıldızı — ${topEmp.approved} onaylı satış, %${topEmp.approvalRate.toFixed(0)} onay oranı (en sık: ${topEmp.topBranch}).` });
    }

    const offShiftTotal = salesData.filter((s: any) => s.is_off_shift && s.status !== 'Reddedildi').length;
    if (offShiftTotal >= 5) {
      out.push({ type: 'warning', text: `🕒 Toplam ${offShiftTotal} satış mesai dışında girilmiş — vardiya planlama veya yetki kontrolü gerekiyor.` });
    }

    const bestPair = pairingRecs
      .flatMap(b => b.pairs.map(p => ({ ...p, branchName: b.branch })))
      .sort((a, b) => b.synergy - a.synergy)[0];
    if (bestPair && bestPair.synergy > 10) {
      out.push({ type: 'success', text: `✨ ${bestPair.name1} + ${bestPair.name2} ikilisi ${bestPair.branchName}'da şube ortalamasının %${bestPair.synergy.toFixed(0)} üstünde satış yapıyor — birlikte daha sık planlayın.` });
    }

    const totalLoss = alerts.filter(a => a.alert_type === 'kayip' && !a.resolved).reduce((sum, a) => sum + a.difference, 0);
    if (totalLoss > 0) {
      out.push({ type: 'warning', text: `📉 Çözülmemiş ${totalLoss} adet kayıp tespit edildi — Kayıp Önleme alarmlarını gözden geçirin.` });
    }

    return out;
  }, [branchScores, employeePerf, pairingRecs, alerts, salesData, isSuper]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="animate-spin text-indigo-400" size={32} />
        <span className="ml-3 text-slate-600 dark:text-zinc-400">{t('loss.loadingData')}</span>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-y-auto overflow-x-hidden custom-scrollbar" style={{ WebkitOverflowScrolling: 'touch' }}>
      {!isLossAdmin && (
        <a
          href={`https://wa.me/${ADMIN_WHATSAPP}?text=${encodeURIComponent('Merhaba, stokta bir sorun var. Detay: ')}`}
          target="_blank"
          rel="noopener noreferrer"
          className="fixed bottom-24 right-4 md:bottom-8 md:right-8 z-40 flex items-center gap-2 px-4 py-3 bg-[#25D366] hover:bg-[#1ebe5a] active:scale-95 rounded-full shadow-lg shadow-emerald-500/40 text-slate-900 dark:text-white font-semibold text-xs md:text-sm transition-all"
          title={t('loss.contactAdminTitle')}
          aria-label={t('loss.contactAdminAria')}
        >
          <WhatsAppIcon size={18} />
          <span className="hidden sm:inline">{t('loss.contactAdminBtn')}</span>
        </a>
      )}
      <div className="p-3 md:p-6 pb-32 md:pb-10 space-y-4 md:space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg md:text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <ShieldAlert className="text-red-400 shrink-0" size={22} />
            <span className="truncate">{isLossAdmin ? t('loss.title') : t('loss.titleStock')}</span>
          </h1>
          <p className="text-slate-500 dark:text-zinc-500 text-xs md:text-sm mt-0.5 hidden sm:block">
            {isLossAdmin ? t('loss.subtitleAdmin') : t('loss.subtitleStaff')}
          </p>
        </div>
        <button
          onClick={fetchAllData}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 active:scale-95 rounded-lg text-slate-700 dark:text-zinc-300 text-xs md:text-sm transition-all"
          title="Yenile"
        >
          <RefreshCw size={14} />
          <span className="hidden sm:inline">Yenile</span>
        </button>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 bg-white dark:bg-zinc-900/50 p-1 rounded-xl border border-slate-200 dark:border-zinc-800 overflow-x-auto custom-scrollbar -mx-1 px-1">
        {[
          { id: 'overview', label: t('loss.tabOverview'), icon: BarChart3, adminOnly: false, superOnly: false },
          { id: 'stock', label: t('loss.tabStock'), icon: Package, adminOnly: false, superOnly: false },
          { id: 'alerts', label: 'Alarmlar', icon: AlertTriangle, adminOnly: true, superOnly: false },
          { id: 'report', label: t('loss.tabReport'), icon: FileText, adminOnly: true, superOnly: false },
          { id: 'ai', label: 'AI Analiz', icon: Sparkles, adminOnly: true, superOnly: true },
        ].filter(tab => (isLossAdmin || !tab.adminOnly) && (!tab.superOnly || isSuper)).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveSubTab(tab.id as any)}
            className={`flex items-center gap-1.5 md:gap-2 px-3 md:px-4 py-2 rounded-lg text-xs md:text-sm font-medium transition-all whitespace-nowrap shrink-0 ${
              activeSubTab === tab.id
                ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-600/30'
                : 'text-slate-600 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-slate-800 dark:text-zinc-200 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800'
            }`}
          >
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 sm:gap-3">
        <select
          value={filterBranch}
          onChange={e => setFilterBranch(e.target.value)}
          className="bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-700 dark:text-zinc-300 w-full sm:w-auto"
        >
          <option value="ALL">{t('loss.allBranches')}</option>
          {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select
          value={filterProduct}
          onChange={e => setFilterProduct(e.target.value)}
          className="bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-700 dark:text-zinc-300 w-full sm:w-auto"
          title={t('loss.productFilter')}
        >
          <option value="ALL">{t('loss.allProducts')}</option>
          {products.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          value={filterDateRange}
          onChange={e => setFilterDateRange(e.target.value as any)}
          className="bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-700 dark:text-zinc-300 w-full sm:w-auto"
        >
          <option value="today">{t('loss.periodToday')}</option>
          <option value="week">{t('loss.periodWeek')}</option>
          <option value="month">{t('loss.periodMonth')}</option>
          <option value="all">{t('loss.periodAll')}</option>
        </select>
      </div>

      {/* === OVERVIEW TAB === */}
      {activeSubTab === 'overview' && (
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
            <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-3 md:p-4">
              <div className="text-slate-500 dark:text-zinc-500 text-[10px] md:text-xs mb-1 leading-tight">{t('loss.totalStockIn')}</div>
              <div className="text-xl md:text-2xl font-bold text-slate-900 dark:text-white">{stockEntries.reduce((s, e) => s + e.quantity, 0)}</div>
            </div>
            <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-3 md:p-4">
              <div className="text-slate-500 dark:text-zinc-500 text-[10px] md:text-xs mb-1 leading-tight">{t('loss.totalApprovedSales')}</div>
              <div className="text-xl md:text-2xl font-bold text-emerald-400">
                {salesData.filter(s => s.status === 'Onaylandı').reduce((s, e) => s + e.quantity, 0)}
              </div>
            </div>
            <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-3 md:p-4">
              <div className="text-slate-500 dark:text-zinc-500 text-[10px] md:text-xs mb-1 leading-tight">Aktif Alarm</div>
              <div className="text-xl md:text-2xl font-bold text-red-400">{alerts.filter(a => !a.resolved).length}</div>
            </div>
            <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-3 md:p-4">
              <div className="text-slate-500 dark:text-zinc-500 text-[10px] md:text-xs mb-1 leading-tight">{t('loss.totalLoss')}</div>
              <div className="text-xl md:text-2xl font-bold text-orange-400">
                {alerts.filter(a => a.alert_type === 'kayip').reduce((s, a) => s + a.difference, 0)}
              </div>
            </div>
          </div>

          {/* Trend Chart */}
          <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-3 md:p-4">
            <h3 className="text-xs md:text-sm font-semibold text-slate-700 dark:text-zinc-300 mb-3 md:mb-4">{t('loss.last7Chart')}</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="date" stroke="#71717a" fontSize={12} />
                <YAxis stroke="#71717a" fontSize={12} />
                <Tooltip
                  contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
                  labelStyle={{ color: '#a1a1aa' }}
                />
                <Legend />
                <Line type="monotone" dataKey="stok_giris" stroke="#60a5fa" strokeWidth={2} name={t('loss.lineStockIn')} dot={false} />
                <Line type="monotone" dataKey="satis" stroke="#34d399" strokeWidth={2} name={t('loss.lineSales')} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Branch Quick Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
            {branchSummary.map(bs => (
              <div key={bs.branch} className={`bg-white dark:bg-zinc-900/50 border rounded-xl p-3 md:p-4 ${
                bs.highAlerts > 0 ? 'border-red-600/50' : bs.alertCount > 0 ? 'border-orange-600/30' : 'border-slate-200 dark:border-zinc-800'
              }`}>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <MapPin size={14} className="text-slate-500 dark:text-zinc-500" />
                    {bs.branch}
                  </h4>
                  {bs.highAlerts > 0 && (
                    <span className="text-xs bg-red-600/20 text-red-400 px-2 py-0.5 rounded-full border border-red-600/30">
                      {bs.highAlerts} Kritik
                    </span>
                  )}
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500 dark:text-zinc-500">{t('loss.stockInLabel')}</span>
                    <span className="text-slate-800 dark:text-zinc-200">{bs.totalStocked}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500 dark:text-zinc-500">{t('loss.salesLabel')}</span>
                    <span className="text-emerald-400">{bs.totalSold}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500 dark:text-zinc-500">Beklenen Kalan:</span>
                    <span className="text-slate-800 dark:text-zinc-200">{bs.expectedRemaining}</span>
                  </div>
                  {bs.totalCounted !== null && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-slate-500 dark:text-zinc-500">{t('loss.countLabel')}</span>
                        <span className="text-slate-800 dark:text-zinc-200">{bs.totalCounted}</span>
                      </div>
                      <div className="flex justify-between border-t border-slate-200 dark:border-zinc-800 pt-2">
                        <span className="text-slate-500 dark:text-zinc-500 font-medium">Fark:</span>
                        <span className={`font-bold ${bs.loss && bs.loss > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                          {bs.loss !== null ? (bs.loss > 0 ? `-${bs.loss} ${t('loss.lossWord')}` : bs.loss < 0 ? `+${Math.abs(bs.loss)} ${t('loss.surplusWord')}` : t('loss.equal')) : '—'}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* === STOCK MANAGEMENT TAB === */}
      {activeSubTab === 'stock' && (
        <div className="space-y-4 md:space-y-6">
          {/* Action Buttons */}
          <div className={`grid ${isLossAdmin ? 'grid-cols-2 sm:flex' : 'grid-cols-1'} gap-2 sm:gap-3`}>
            <button
              onClick={() => setShowStockForm(true)}
              className="flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 active:scale-95 rounded-lg text-slate-900 dark:text-white text-xs sm:text-sm font-medium transition-all"
            >
              <Plus size={16} /> {t('loss.btnNewStock')}
            </button>
            {isLossAdmin && (
              <button
                onClick={() => setShowCountForm(true)}
                className="flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 active:scale-95 rounded-lg text-slate-900 dark:text-white text-xs sm:text-sm font-medium transition-all"
              >
                <Search size={16} /> {t('loss.btnAddCount')}
              </button>
            )}
          </div>

          {/* Stock Entry Form Modal */}
          {showStockForm && (
            <div className="bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700 rounded-xl p-5 space-y-4">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">{editingEntry ? t('loss.editStockEntry') : t('loss.newStockEntry')}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-600 dark:text-zinc-400 mb-1 block">{t('loss.product')}</label>
                  <select
                    value={stockForm.product_name}
                    onChange={e => setStockForm(p => ({ ...p, product_name: e.target.value }))}
                    className="w-full bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-200"
                  >
                    <option value="">{t('loss.selectPlaceholder')}</option>
                    {products.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-600 dark:text-zinc-400 mb-1 block">{t('loss.branch')}</label>
                  <select
                    value={stockForm.branch}
                    onChange={e => setStockForm(p => ({ ...p, branch: e.target.value }))}
                    className="w-full bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-200"
                  >
                    {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-600 dark:text-zinc-400 mb-1 block">Adet</label>
                  <input
                    type="number"
                    min={1}
                    value={stockForm.quantity}
                    onChange={e => setStockForm(p => ({ ...p, quantity: Number(e.target.value) }))}
                    className="w-full bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-200"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-600 dark:text-zinc-400 mb-1 block">Tarih</label>
                  <input
                    type="date"
                    value={stockForm.entry_date}
                    onChange={e => setStockForm(p => ({ ...p, entry_date: e.target.value }))}
                    className="w-full bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-200"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-600 dark:text-zinc-400 mb-1 block">Not (Opsiyonel)</label>
                <input
                  type="text"
                  value={stockForm.note}
                  onChange={e => setStockForm(p => ({ ...p, note: e.target.value }))}
                  placeholder={t('loss.invoicePlaceholder')}
                  className="w-full bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-200"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleSaveStockEntry}
                  disabled={isSaving || !stockForm.product_name || stockForm.quantity <= 0}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-slate-900 dark:text-white text-sm font-medium transition-colors"
                >
                  {isSaving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                  Kaydet
                </button>
                <button
                  onClick={closeStockForm}
                  className="px-4 py-2 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 rounded-lg text-slate-700 dark:text-zinc-300 text-sm transition-colors"
                >
                  {t('loss.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* Count Form Modal */}
          {showCountForm && (
            <div className="bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700 rounded-xl p-5 space-y-4">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">{editingCount ? t('loss.editCount') : t('loss.newCount')}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-600 dark:text-zinc-400 mb-1 block">{t('loss.product')}</label>
                  <select
                    value={countForm.product_name}
                    onChange={e => setCountForm(p => ({ ...p, product_name: e.target.value }))}
                    className="w-full bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-200"
                  >
                    <option value="">{t('loss.selectPlaceholder')}</option>
                    {products.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-600 dark:text-zinc-400 mb-1 block">{t('loss.branch')}</label>
                  <select
                    value={countForm.branch}
                    onChange={e => setCountForm(p => ({ ...p, branch: e.target.value }))}
                    className="w-full bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-200"
                  >
                    {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-600 dark:text-zinc-400 mb-1 block">{t('loss.countedQty')}</label>
                  <input
                    type="number"
                    min={0}
                    value={countForm.counted_quantity}
                    onChange={e => setCountForm(p => ({ ...p, counted_quantity: Number(e.target.value) }))}
                    className="w-full bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-200"
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-600 dark:text-zinc-400 mb-1 block">Tarih</label>
                  <input
                    type="date"
                    value={countForm.count_date}
                    onChange={e => setCountForm(p => ({ ...p, count_date: e.target.value }))}
                    className="w-full bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-200"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-600 dark:text-zinc-400 mb-1 block">Not</label>
                <input
                  type="text"
                  value={countForm.note}
                  onChange={e => setCountForm(p => ({ ...p, note: e.target.value }))}
                  placeholder={t('loss.countDetailPlaceholder')}
                  className="w-full bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-zinc-200"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleSaveCount}
                  disabled={isSaving || !countForm.product_name}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-slate-900 dark:text-white text-sm font-medium transition-colors"
                >
                  {isSaving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                  Kaydet
                </button>
                <button
                  onClick={closeCountForm}
                  className="px-4 py-2 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 rounded-lg text-slate-700 dark:text-zinc-300 text-sm transition-colors"
                >
                  {t('loss.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* Mevcut Stok Durumu — (şube + ürün) bazında giriş, satılan, kalan */}
          <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-3 md:px-4 py-3 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-xs md:text-sm font-semibold text-slate-700 dark:text-zinc-300">Mevcut Stok Durumu</h3>
              <div className="flex items-center gap-1 bg-white dark:bg-zinc-900 rounded-lg p-1 border border-slate-200 dark:border-zinc-800">
                <button
                  onClick={() => setStockPeriod('week')}
                  className={`px-3 py-1 text-[11px] md:text-xs font-bold rounded transition-all ${stockPeriod === 'week' ? 'bg-indigo-600 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                >
                  Son 7 Gün
                </button>
                <button
                  onClick={() => setStockPeriod('month')}
                  className={`px-3 py-1 text-[11px] md:text-xs font-bold rounded transition-all ${stockPeriod === 'month' ? 'bg-indigo-600 text-slate-900 dark:text-white' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                >
                  Son 30 Gün
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white dark:bg-zinc-900">
                  <tr className="text-slate-500 dark:text-zinc-500 text-xs">
                    <th className="px-3 md:px-4 py-2 text-left">Şube</th>
                    <th className="px-3 md:px-4 py-2 text-left">Ürün</th>
                    <th className="px-3 md:px-4 py-2 text-right">Toplam Giriş</th>
                    <th className="px-3 md:px-4 py-2 text-right">Satılan</th>
                    <th className="px-3 md:px-4 py-2 text-right">Kalan</th>
                  </tr>
                </thead>
                <tbody>
                  {currentStock.map(r => (
                    <tr key={`${r.branch}|${r.product}`} className="border-t border-slate-200 dark:border-zinc-800/50 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800/30">
                      <td className="px-3 md:px-4 py-2 text-slate-700 dark:text-zinc-300 whitespace-nowrap">{r.branch}</td>
                      <td className="px-3 md:px-4 py-2 text-slate-800 dark:text-zinc-200">{r.product}</td>
                      <td className="px-3 md:px-4 py-2 text-right text-slate-700 dark:text-zinc-300 tabular-nums">{r.stocked}</td>
                      <td className="px-3 md:px-4 py-2 text-right text-emerald-400 font-medium tabular-nums">−{r.sold}</td>
                      <td className={`px-3 md:px-4 py-2 text-right font-bold tabular-nums ${r.remaining < 0 ? 'text-red-400' : r.remaining < 5 ? 'text-orange-400' : 'text-slate-900 dark:text-white'}`}>
                        {r.remaining}
                      </td>
                    </tr>
                  ))}
                  {currentStock.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-400 dark:text-zinc-600">Bu filtreyle eşleşen kayıt yok</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Stock History Table */}
          <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-300">Son Stok Girişleri</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white dark:bg-zinc-900">
                  <tr className="text-slate-500 dark:text-zinc-500 text-xs">
                    <th className="px-4 py-2 text-left">Tarih</th>
                    <th className="px-4 py-2 text-left">Şube</th>
                    <th className="px-4 py-2 text-left">Ürün</th>
                    <th className="px-4 py-2 text-right">Adet</th>
                    <th className="px-4 py-2 text-left">Not</th>
                    {isLossAdmin && <th className="px-4 py-2 text-right">İşlem</th>}
                  </tr>
                </thead>
                <tbody>
                  {stockEntries.slice(0, 20).map(entry => (
                    <tr key={entry.id} className="border-t border-slate-200 dark:border-zinc-800/50 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800/30">
                      <td className="px-4 py-2 text-slate-600 dark:text-zinc-400">{entry.entry_date}</td>
                      <td className="px-4 py-2 text-slate-700 dark:text-zinc-300">{entry.branch}</td>
                      <td className="px-4 py-2 text-slate-800 dark:text-zinc-200">{entry.product_name}</td>
                      <td className="px-4 py-2 text-right text-slate-900 dark:text-white font-medium">{entry.quantity}</td>
                      <td className="px-4 py-2 text-slate-500 dark:text-zinc-500">{entry.note || '—'}</td>
                      {isLossAdmin && (
                        <td className="px-4 py-2">
                          <div className="flex justify-end gap-1">
                            <button
                              onClick={() => openEditEntry(entry)}
                              className="p-1.5 rounded text-slate-600 dark:text-zinc-400 hover:text-indigo-400 hover:bg-indigo-600/10 transition-colors"
                              title="Düzenle"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => handleDeleteEntry(entry.id)}
                              className="p-1.5 rounded text-slate-600 dark:text-zinc-400 hover:text-red-400 hover:bg-red-600/10 transition-colors"
                              title="Sil"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                  {stockEntries.length === 0 && (
                    <tr>
                      <td colSpan={isLossAdmin ? 6 : 5} className="px-4 py-8 text-center text-slate-400 dark:text-zinc-600">Henüz stok girişi yok</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Count History */}
          <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-300">Son Sayımlar</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white dark:bg-zinc-900">
                  <tr className="text-slate-500 dark:text-zinc-500 text-xs">
                    <th className="px-4 py-2 text-left">Tarih</th>
                    <th className="px-4 py-2 text-left">Şube</th>
                    <th className="px-4 py-2 text-left">Ürün</th>
                    <th className="px-4 py-2 text-right">Sayılan</th>
                    <th className="px-4 py-2 text-left">Not</th>
                    {isLossAdmin && <th className="px-4 py-2 text-right">İşlem</th>}
                  </tr>
                </thead>
                <tbody>
                  {stockCounts.slice(0, 20).map(count => (
                    <tr key={count.id} className="border-t border-slate-200 dark:border-zinc-800/50 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800/30">
                      <td className="px-4 py-2 text-slate-600 dark:text-zinc-400">{count.count_date}</td>
                      <td className="px-4 py-2 text-slate-700 dark:text-zinc-300">{count.branch}</td>
                      <td className="px-4 py-2 text-slate-800 dark:text-zinc-200">{count.product_name}</td>
                      <td className="px-4 py-2 text-right text-slate-900 dark:text-white font-medium">{count.counted_quantity}</td>
                      <td className="px-4 py-2 text-slate-500 dark:text-zinc-500">{count.note || '—'}</td>
                      {isLossAdmin && (
                        <td className="px-4 py-2">
                          <div className="flex justify-end gap-1">
                            <button
                              onClick={() => openEditCount(count)}
                              className="p-1.5 rounded text-slate-600 dark:text-zinc-400 hover:text-indigo-400 hover:bg-indigo-600/10 transition-colors"
                              title="Düzenle"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => handleDeleteCount(count.id)}
                              className="p-1.5 rounded text-slate-600 dark:text-zinc-400 hover:text-red-400 hover:bg-red-600/10 transition-colors"
                              title="Sil"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                  {stockCounts.length === 0 && (
                    <tr>
                      <td colSpan={isLossAdmin ? 6 : 5} className="px-4 py-8 text-center text-slate-400 dark:text-zinc-600">Henüz sayım yok</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* === ALERTS TAB === */}
      {activeSubTab === 'alerts' && (
        <div className="space-y-4">
          {alerts.filter(a => !a.resolved).length === 0 ? (
            <div className="bg-emerald-900/20 border border-emerald-700/30 rounded-xl p-8 text-center">
              <CheckCircle2 className="mx-auto text-emerald-400 mb-3" size={40} />
              <h3 className="text-emerald-300 font-semibold text-lg">Aktif Alarm Yok</h3>
              <p className="text-slate-500 dark:text-zinc-500 mt-1">Tüm şubelerde stok-satış dengesi normal görünüyor.</p>
            </div>
          ) : (
            alerts.filter(a => !a.resolved).map(alert => (
              <div
                key={alert.id}
                className={`border rounded-xl p-4 ${
                  alert.severity === 'high' ? 'bg-red-950/30 border-red-600/40' :
                  alert.severity === 'medium' ? 'bg-orange-950/20 border-orange-600/30' :
                  'bg-yellow-950/10 border-yellow-600/20'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    {alert.alert_type === 'kayip' && <TrendingDown className="text-red-400" size={20} />}
                    {alert.alert_type === 'fazla' && <TrendingUp className="text-blue-400" size={20} />}
                    {alert.alert_type === 'anormal_satis' && <AlertTriangle className="text-orange-400" size={20} />}
                    <div>
                      <h4 className="text-slate-900 dark:text-white font-medium text-sm">
                        {alert.alert_type === 'kayip' && `Kayıp Tespit: ${alert.product_name}`}
                        {alert.alert_type === 'fazla' && `Stok Fazlası: ${alert.product_name}`}
                        {alert.alert_type === 'anormal_satis' && `Anormal Satış Aktivitesi`}
                      </h4>
                      <p className="text-slate-600 dark:text-zinc-400 text-xs mt-0.5">
                        {alert.branch} • {alert.date}
                      </p>
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    alert.severity === 'high' ? 'bg-red-600/20 text-red-400' :
                    alert.severity === 'medium' ? 'bg-orange-600/20 text-orange-400' :
                    'bg-yellow-600/20 text-yellow-400'
                  }`}>
                    {alert.severity === 'high' ? 'Kritik' : alert.severity === 'medium' ? 'Orta' : 'Düşük'}
                  </span>
                </div>
                {alert.alert_type !== 'anormal_satis' && (
                  <div className="mt-3 grid grid-cols-3 gap-4 text-sm">
                    <div>
                      <span className="text-slate-500 dark:text-zinc-500 text-xs">Beklenen</span>
                      <div className="text-slate-800 dark:text-zinc-200 font-medium">{alert.expected_stock}</div>
                    </div>
                    <div>
                      <span className="text-slate-500 dark:text-zinc-500 text-xs">Sayılan</span>
                      <div className="text-slate-800 dark:text-zinc-200 font-medium">{alert.actual_stock}</div>
                    </div>
                    <div>
                      <span className="text-slate-500 dark:text-zinc-500 text-xs">Fark</span>
                      <div className="text-red-400 font-bold">{alert.difference} adet</div>
                    </div>
                  </div>
                )}
                {alert.note && (
                  <p className="mt-2 text-xs text-slate-500 dark:text-zinc-500 italic">{alert.note}</p>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* === REPORT TAB === */}
      {activeSubTab === 'report' && (
        <div className="space-y-4 md:space-y-6">
          <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-3 md:p-5">
            <h3 className="text-sm md:text-lg font-semibold text-slate-900 dark:text-white mb-3 md:mb-4">Şube Performans Karşılaştırması</h3>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={branchSummary}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="branch" stroke="#71717a" fontSize={12} />
                <YAxis stroke="#71717a" fontSize={12} />
                <Tooltip
                  contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
                  labelStyle={{ color: '#a1a1aa' }}
                />
                <Legend />
                <Bar dataKey="totalStocked" fill="#60a5fa" name="Stok Giriş" radius={[4, 4, 0, 0]} />
                <Bar dataKey="totalSold" fill="#34d399" name="Satış" radius={[4, 4, 0, 0]} />
                <Bar dataKey="alertCount" fill="#f87171" name="Alarm" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Detailed Branch Table */}
          <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-300">Detaylı Şube Raporu</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white dark:bg-zinc-900">
                  <tr className="text-slate-500 dark:text-zinc-500 text-xs">
                    <th className="px-4 py-2 text-left">Şube</th>
                    <th className="px-4 py-2 text-right">Stok Giriş</th>
                    <th className="px-4 py-2 text-right">Satış</th>
                    <th className="px-4 py-2 text-right">Beklenen Kalan</th>
                    <th className="px-4 py-2 text-right">Sayım</th>
                    <th className="px-4 py-2 text-right">Kayıp/Fazla</th>
                    <th className="px-4 py-2 text-center">Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {branchSummary.map(bs => (
                    <tr key={bs.branch} className="border-t border-slate-200 dark:border-zinc-800/50 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800/30">
                      <td className="px-4 py-3 text-slate-800 dark:text-zinc-200 font-medium">{bs.branch}</td>
                      <td className="px-4 py-3 text-right text-slate-700 dark:text-zinc-300">{bs.totalStocked}</td>
                      <td className="px-4 py-3 text-right text-emerald-400">{bs.totalSold}</td>
                      <td className="px-4 py-3 text-right text-slate-700 dark:text-zinc-300">{bs.expectedRemaining}</td>
                      <td className="px-4 py-3 text-right text-slate-700 dark:text-zinc-300">{bs.totalCounted !== null ? bs.totalCounted : '—'}</td>
                      <td className={`px-4 py-3 text-right font-bold ${
                        bs.loss === null ? 'text-slate-400 dark:text-zinc-600' :
                        bs.loss > 0 ? 'text-red-400' :
                        bs.loss < 0 ? 'text-blue-400' : 'text-emerald-400'
                      }`}>
                        {bs.loss === null ? '—' : bs.loss > 0 ? `-${bs.loss}` : bs.loss < 0 ? `+${Math.abs(bs.loss)}` : '✓'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {bs.highAlerts > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs bg-red-600/20 text-red-400 px-2 py-0.5 rounded-full">
                            <AlertTriangle size={10} /> Risk
                          </span>
                        ) : bs.alertCount > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs bg-orange-600/20 text-orange-400 px-2 py-0.5 rounded-full">
                            Dikkat
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs bg-emerald-600/20 text-emerald-400 px-2 py-0.5 rounded-full">
                            <CheckCircle2 size={10} /> Normal
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent Sales Activity - for verification */}
          <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-zinc-300">Son Satış Aktivitesi (Tüm Durumlar)</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white dark:bg-zinc-900">
                  <tr className="text-slate-500 dark:text-zinc-500 text-xs">
                    <th className="px-4 py-2 text-left">Tarih</th>
                    <th className="px-4 py-2 text-left">Personel</th>
                    <th className="px-4 py-2 text-left">Şube</th>
                    <th className="px-4 py-2 text-left">Ürün</th>
                    <th className="px-4 py-2 text-right">Adet</th>
                    <th className="px-4 py-2 text-center">Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSales.slice(0, 30).map(sale => (
                    <tr key={sale.id} className="border-t border-slate-200 dark:border-zinc-800/50 hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800/30">
                      <td className="px-4 py-2 text-slate-600 dark:text-zinc-400">{sale.sale_date}</td>
                      <td className="px-4 py-2 text-slate-800 dark:text-zinc-200">{getEmpName(sale.employee_id)}</td>
                      <td className="px-4 py-2 text-slate-700 dark:text-zinc-300">{sale.branch}</td>
                      <td className="px-4 py-2 text-slate-800 dark:text-zinc-200">{sale.product_name}</td>
                      <td className="px-4 py-2 text-right text-slate-900 dark:text-white font-medium">{sale.quantity}</td>
                      <td className="px-4 py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          sale.status === 'Onaylandı' ? 'bg-emerald-600/20 text-emerald-400' :
                          sale.status === 'Reddedildi' ? 'bg-red-600/20 text-red-400' :
                          'bg-yellow-600/20 text-yellow-400'
                        }`}>
                          {sale.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* === AI ANALİZ TAB (sadece super admin: cevikademm@gmail.com) === */}
      {activeSubTab === 'ai' && isSuper && (
        <div className="space-y-4 md:space-y-6">
          {/* Live indicator + son güncelleme */}
          <div className="flex items-center justify-between flex-wrap gap-2 bg-gradient-to-r from-violet-900/40 via-fuchsia-900/30 to-pink-900/30 border border-violet-700/40 rounded-xl px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="relative flex items-center justify-center">
                <div className="absolute w-3 h-3 bg-emerald-400 rounded-full animate-ping" />
                <div className="relative w-3 h-3 bg-emerald-400 rounded-full" />
              </div>
              <div>
                <div className="text-xs md:text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <Sparkles size={14} className="text-violet-300" /> Canlı Algoritma Aktif
                </div>
                <div className="text-[10px] md:text-xs text-violet-200/70">
                  Son güncelleme: {lastRefresh.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </div>
              </div>
            </div>
            <button
              onClick={fetchAllData}
              className="text-xs md:text-sm flex items-center gap-1.5 px-3 py-1.5 bg-violet-600/30 hover:bg-violet-600/50 border border-violet-500/40 rounded-lg text-slate-900 dark:text-white font-bold transition-all"
            >
              <RefreshCw size={14} /> Yenile
            </button>
          </div>

          {/* Auto Insights — anlamlı tek-cümle tespitler */}
          {autoInsights.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm md:text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Zap size={16} className="text-yellow-400" /> Anlık İçgörüler
              </h3>
              <div className="grid gap-2">
                {autoInsights.map((ins, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg border text-xs md:text-sm leading-relaxed ${
                      ins.type === 'success' ? 'bg-emerald-950/30 border-emerald-700/40 text-emerald-200' :
                      ins.type === 'warning' ? 'bg-orange-950/30 border-orange-700/40 text-orange-200' :
                      'bg-blue-950/30 border-blue-700/40 text-blue-200'
                    }`}
                  >
                    {ins.text}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hero stats — 4 büyük kart. Etiket altyazıları heroStats.mode'a göre
              değişir; onaylanmamış ama bekleyen kayıtlar varsa "satış (onay
              bekliyor)" şeklinde gösterilir, eski tarih kayıtları varsa
              "tüm zaman" denir. Böylece kartlar gerçekten boş veri yokken
              sıfır gösterip yanıltmaz. */}
          {(() => {
            const modeLabel = heroStats.mode === 'approved30'
              ? 'son 30 gün · onaylı'
              : heroStats.mode === 'all30'
                ? 'son 30 gün · onay bekliyor'
                : 'tüm zaman';
            return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
            <div className="relative overflow-hidden bg-gradient-to-br from-emerald-900/40 to-emerald-950/60 border border-emerald-700/40 rounded-xl p-3 md:p-4">
              <Crown className="absolute -top-2 -right-2 text-emerald-700/30" size={64} />
              <div className="relative">
                <div className="text-[10px] md:text-xs text-emerald-300/70 font-bold uppercase tracking-wider">En İyi Şube</div>
                <div className="text-lg md:text-2xl font-black text-emerald-300 mt-1 truncate">{heroStats.topBranch?.branch || '—'}</div>
                <div className="text-[10px] md:text-xs text-emerald-400/80 mt-0.5">
                  {heroStats.topBranch ? `${heroStats.topBranch.count} satış · ${modeLabel}` : 'Yeterli veri yok'}
                </div>
              </div>
            </div>
            <div className="relative overflow-hidden bg-gradient-to-br from-violet-900/40 to-violet-950/60 border border-violet-700/40 rounded-xl p-3 md:p-4">
              <Award className="absolute -top-2 -right-2 text-violet-700/30" size={64} />
              <div className="relative">
                <div className="text-[10px] md:text-xs text-violet-300/70 font-bold uppercase tracking-wider">Ayın Yıldızı</div>
                <div className="text-lg md:text-2xl font-black text-violet-300 mt-1 truncate">{heroStats.topEmployee?.name || '—'}</div>
                <div className="text-[10px] md:text-xs text-violet-400/80 mt-0.5">
                  {heroStats.topEmployee
                    ? `${heroStats.topEmployee.sales} satış · %${heroStats.topEmployee.approvalRate.toFixed(0)} onay`
                    : 'Yeterli veri yok'}
                </div>
              </div>
            </div>
            <div className="relative overflow-hidden bg-gradient-to-br from-blue-900/40 to-blue-950/60 border border-blue-700/40 rounded-xl p-3 md:p-4">
              <Activity className="absolute -top-2 -right-2 text-blue-700/30" size={64} />
              <div className="relative">
                <div className="text-[10px] md:text-xs text-blue-300/70 font-bold uppercase tracking-wider">Aktif Personel</div>
                <div className="text-lg md:text-2xl font-black text-blue-300 mt-1">{heroStats.activeEmployeeCount}</div>
                <div className="text-[10px] md:text-xs text-blue-400/80 mt-0.5">{modeLabel} · satış girişi</div>
              </div>
            </div>
            <div className="relative overflow-hidden bg-gradient-to-br from-pink-900/40 to-pink-950/60 border border-pink-700/40 rounded-xl p-3 md:p-4">
              <Sparkles className="absolute -top-2 -right-2 text-pink-700/30" size={64} />
              <div className="relative">
                <div className="text-[10px] md:text-xs text-pink-300/70 font-bold uppercase tracking-wider">Sinerji İkilisi</div>
                {heroStats.bestPair ? (
                  <>
                    <div className="text-xs md:text-sm font-black text-pink-300 mt-1 truncate">
                      {heroStats.bestPair.name1.split(' ')[0]} + {heroStats.bestPair.name2.split(' ')[0]}
                    </div>
                    <div className="text-[10px] md:text-xs text-pink-400/80 mt-0.5">
                      {heroStats.bestPair.branch} · {heroStats.bestPair.synergy >= 0 ? '+' : ''}%{heroStats.bestPair.synergy.toFixed(0)}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-pink-400/60 mt-1 italic">Yeterli veri yok</div>
                )}
              </div>
            </div>
          </div>
            );
          })()}

          {/* Şube Sıralaması (Branch Leaderboard) */}
          <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-3 md:px-4 py-3 border-b border-slate-200 dark:border-zinc-800 flex items-center gap-2">
              <BarChart3 size={16} className="text-emerald-400" />
              <h3 className="text-xs md:text-sm font-bold text-slate-800 dark:text-zinc-200">Şube Sıralaması (Son 30 Gün)</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white dark:bg-zinc-900">
                  <tr className="text-slate-500 dark:text-zinc-500 text-[10px] md:text-xs">
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Şube</th>
                    <th className="px-3 py-2 text-right">Onaylı</th>
                    <th className="px-3 py-2 text-right">Bekleyen</th>
                    <th className="px-3 py-2 text-right">Kayıp</th>
                    <th className="px-3 py-2 text-right">Mes.Dışı</th>
                    <th className="px-3 py-2 text-right">Skor</th>
                  </tr>
                </thead>
                <tbody>
                  {branchScores.map((b, i) => (
                    <tr key={b.branch} className="border-t border-slate-200 dark:border-zinc-800/50">
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-black ${
                          i === 0 ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40' :
                          i === 1 ? 'bg-zinc-400/20 text-slate-700 dark:text-zinc-300 border border-zinc-400/40' :
                          i === 2 ? 'bg-orange-700/20 text-orange-400 border border-orange-700/40' :
                          'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-500'
                        }`}>{i + 1}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-800 dark:text-zinc-200 font-medium">{b.branch}</td>
                      <td className="px-3 py-2 text-right text-emerald-400 tabular-nums">{b.approved}</td>
                      <td className="px-3 py-2 text-right text-yellow-400 tabular-nums">{b.pending}</td>
                      <td className="px-3 py-2 text-right text-red-400 tabular-nums">{b.lossCount}</td>
                      <td className="px-3 py-2 text-right text-orange-400 tabular-nums">{b.offShift}</td>
                      <td className={`px-3 py-2 text-right font-black tabular-nums ${b.score < 0 ? 'text-red-400' : 'text-slate-900 dark:text-white'}`}>{b.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-3 md:px-4 py-2 border-t border-slate-200 dark:border-zinc-800 text-[10px] text-slate-500 dark:text-zinc-500 italic">
              Skor formülü: onaylı × 10 − kayıp × 5 − red × 2 − mesai_dışı × 1
            </div>
          </div>

          {/* Personel Performans Tablosu */}
          <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-3 md:px-4 py-3 border-b border-slate-200 dark:border-zinc-800 flex items-center gap-2">
              <Users size={16} className="text-violet-400" />
              <h3 className="text-xs md:text-sm font-bold text-slate-800 dark:text-zinc-200">Personel Performansı (Son 30 Gün)</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white dark:bg-zinc-900">
                  <tr className="text-slate-500 dark:text-zinc-500 text-[10px] md:text-xs">
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2 text-left">Personel</th>
                    <th className="px-3 py-2 text-right">Onaylı</th>
                    <th className="px-3 py-2 text-right">Bekleyen</th>
                    <th className="px-3 py-2 text-right">Reddedilen</th>
                    <th className="px-3 py-2 text-right">Onay %</th>
                    <th className="px-3 py-2 text-left">En Sık Şube</th>
                  </tr>
                </thead>
                <tbody>
                  {employeePerf.slice(0, 15).map((e, i) => (
                    <tr key={e.id} className="border-t border-slate-200 dark:border-zinc-800/50">
                      <td className="px-3 py-2 text-slate-500 dark:text-zinc-500 tabular-nums">{i + 1}</td>
                      <td className="px-3 py-2 text-slate-800 dark:text-zinc-200 font-medium truncate max-w-[160px]">{e.name}</td>
                      <td className="px-3 py-2 text-right text-emerald-400 font-bold tabular-nums">{e.approved}</td>
                      <td className="px-3 py-2 text-right text-yellow-400 tabular-nums">{e.pending}</td>
                      <td className="px-3 py-2 text-right text-red-400 tabular-nums">{e.rejected}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${e.approvalRate >= 80 ? 'text-emerald-400' : e.approvalRate >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {e.approvalRate.toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-slate-600 dark:text-zinc-400 text-xs">{e.topBranch}</td>
                    </tr>
                  ))}
                  {employeePerf.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400 dark:text-zinc-600">Son 30 günde satış girişi yok</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Eşleşme Önerileri (Pairing) */}
          <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-3 md:px-4 py-3 border-b border-slate-200 dark:border-zinc-800 flex items-center gap-2">
              <Sparkles size={16} className="text-pink-400" />
              <h3 className="text-xs md:text-sm font-bold text-slate-800 dark:text-zinc-200">Personel Eşleşme Önerileri</h3>
              <span className="ml-auto text-[10px] text-slate-500 dark:text-zinc-500 italic">Vardiya + satış verisi karşılaştırması</span>
            </div>
            <div className="p-3 md:p-4 space-y-4">
              {pairingRecs.length === 0 ? (
                <div className="text-center text-slate-400 dark:text-zinc-600 italic text-sm py-6">
                  Yeterli vardiya/satış verisi yok — analiz için en az 2 ortak gün gerekiyor.
                </div>
              ) : (
                pairingRecs.map(b => (
                  <div key={b.branch} className="bg-slate-50 dark:bg-zinc-950/60 border border-slate-200 dark:border-zinc-800/60 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <MapPin size={14} className="text-emerald-400" />
                        <span className="font-bold text-slate-900 dark:text-white text-sm">{b.branch}</span>
                      </div>
                      <span className="text-[10px] text-slate-500 dark:text-zinc-500">Şube günlük ort: <span className="text-slate-700 dark:text-zinc-300 font-bold">{b.branchAvg.toFixed(1)}</span></span>
                    </div>
                    <div className="space-y-2">
                      {b.pairs.map((p, idx) => (
                        <div
                          key={`${p.e1}|${p.e2}`}
                          className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border ${
                            p.synergy >= 20 ? 'bg-emerald-950/40 border-emerald-700/40' :
                            p.synergy >= 0 ? 'bg-white dark:bg-zinc-900/60 border-slate-300 dark:border-zinc-700/40' :
                            'bg-orange-950/30 border-orange-700/30'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black ${
                              idx === 0 ? 'bg-yellow-500/30 text-yellow-300' : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                            }`}>{idx + 1}</span>
                            <div className="min-w-0">
                              <div className="text-xs md:text-sm font-bold text-slate-900 dark:text-zinc-100 truncate">{p.name1} + {p.name2}</div>
                              <div className="text-[10px] text-slate-500 dark:text-zinc-500">{p.coDays} ortak gün · ort. {p.avgSales.toFixed(1)} satış/gün</div>
                            </div>
                          </div>
                          <div className={`shrink-0 text-right font-black text-xs md:text-sm tabular-nums ${
                            p.synergy >= 0 ? 'text-emerald-400' : 'text-orange-400'
                          }`}>
                            {p.synergy >= 0 ? '+' : ''}{p.synergy.toFixed(0)}%
                          </div>
                        </div>
                      ))}
                    </div>
                    {b.pairs[0] && b.pairs[0].synergy > 10 && (
                      <div className="mt-3 text-[11px] text-slate-600 dark:text-zinc-400 italic leading-relaxed">
                        💡 <span className="text-slate-700 dark:text-zinc-300 font-bold">{b.pairs[0].name1}</span> ve <span className="text-slate-700 dark:text-zinc-300 font-bold">{b.pairs[0].name2}</span> bu şubede şube ortalamasının <span className="text-emerald-400 font-bold">%{b.pairs[0].synergy.toFixed(0)}</span> üstünde satış üretiyor — birlikte planlamak satışları artırabilir.
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Şube Performans Karşılaştırma Grafiği */}
          {branchScores.length > 0 && (
            <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-3 md:p-5">
              <h3 className="text-xs md:text-sm font-bold text-slate-800 dark:text-zinc-200 mb-3 flex items-center gap-2">
                <TUp size={16} className="text-blue-400" /> Şube Karşılaştırma — Skor & Onaylı Satış
              </h3>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={branchScores}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="branch" stroke="#71717a" fontSize={11} />
                  <YAxis stroke="#71717a" fontSize={11} />
                  <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="approved" fill="#34d399" name="Onaylı Satış" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="score" fill="#a78bfa" name="Skor" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
};

export default LossControl;
