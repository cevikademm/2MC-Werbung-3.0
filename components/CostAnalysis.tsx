import React, { useMemo, useState } from 'react';

/**
 * CostAnalysis – Maliyet Analizi / Financial Cost Summary
 * ---------------------------------------------------------
 * Self-contained React + Tailwind component extracted from the
 * "Maaş Ödemesi → Maliyet Analizi" view.
 *
 * Zero external dependencies (icons are inlined SVGs).
 *
 * Data flows IN via props (`employees`, `workLogs`). The parent owns the data.
 * Editing a monthly salary calls back via `onUpdateMonthlySalary` – the parent
 * is responsible for persisting it and updating its own `employees` array.
 *
 * Tailwind CSS is required in the target project.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SalaryHistoryItem {
  /** ISO date (YYYY-MM-DD) from which `rate` is valid. */
  date: string;
  rate: number;
}

export interface Employee {
  id: string;
  name: string;
  /** Free-text role/title. */
  role?: string;
  email?: string;
  /** Current gross hourly rate. */
  hourlyRate: number;
  /** Optional rate-change history; used to pick the rate valid on a given date. */
  salary_history?: SalaryHistoryItem[];
  /** Fixed monthly net salary (for salaried, non-hourly employees). */
  monthly_net_salary?: number;
}

export interface WorkLog {
  id: string;
  employeeId: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  netHours: number;
  location: string;
  description: string;
  status?: 'pending' | 'approved' | 'rejected';
}

export interface CostAnalysisProps {
  employees: Employee[];
  workLogs: WorkLog[];
  /** Show admin-only UI (the editable salary table). Defaults to false. */
  isAdmin?: boolean;
  /**
   * Called when an admin saves an employee's monthly net salary.
   * Persist it and update your `employees` state. If omitted, the edit UI is read-only-ish.
   */
  onUpdateMonthlySalary?: (employeeId: string, value: number) => void | Promise<void>;
  /** Currency symbol shown next to amounts. Defaults to "€". */
  currency?: string;
  /** BCP-47 locale used for month/date formatting. Defaults to "tr-TR". */
  locale?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the hourly rate that was valid for `emp` on a given date. */
export function getHourlyRateForDate(emp: Employee, date: Date | string): number {
  if (!emp.salary_history || emp.salary_history.length === 0) {
    return emp.hourlyRate;
  }
  const targetTime = new Date(date).getTime();
  const sortedHistory = [...emp.salary_history].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  const validRecord = sortedHistory.find(h => new Date(h.date).getTime() <= targetTime);
  return validRecord ? validRecord.rate : sortedHistory[sortedHistory.length - 1].rate;
}

// ---------------------------------------------------------------------------
// Inlined icons (no @heroicons dependency)
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

const ArrowTrendingUpIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.25 18 9 11.25l4.306 4.307a11.95 11.95 0 0 1 5.814-5.519l2.74-1.22m0 0-5.94-2.28m5.94 2.28-2.28 5.941" />
  </svg>
);

const ChevronDownIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="m19.5 8.25-7.5 7.5-7.5-7.5" />
  </svg>
);

const ChevronRightIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
  </svg>
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CostAnalysis({
  employees,
  workLogs,
  isAdmin = false,
  onUpdateMonthlySalary,
  currency = '€',
  locale = 'tr-TR',
}: CostAnalysisProps) {
  const [costsMonth, setCostsMonth] = useState<Date>(new Date());
  const [costsStatusFilter, setCostsStatusFilter] = useState<'all' | 'approved'>('approved');
  const [editingSalaryEmpId, setEditingSalaryEmpId] = useState<string | null>(null);
  const [editingSalaryValue, setEditingSalaryValue] = useState<string>('');

  const handleSaveMonthlyNetSalary = async (empId: string) => {
    const val = parseFloat(editingSalaryValue);
    if (isNaN(val) || val < 0) {
      alert('Geçerli bir değer giriniz.');
      return;
    }
    try {
      await onUpdateMonthlySalary?.(empId, val);
      setEditingSalaryEmpId(null);
    } catch (e) {
      console.error('Monthly salary update failed', e);
      alert('Aylık maaş güncellenemedi.');
    }
  };

  // --- Derived data ---------------------------------------------------------
  const model = useMemo(() => {
    const costsMonthStr = `${costsMonth.getFullYear()}-${(costsMonth.getMonth() + 1)
      .toString()
      .padStart(2, '0')}`;

    const filteredLogs = workLogs.filter(l => {
      const monthMatch = l.date.substring(0, 7) === costsMonthStr;
      const statusMatch = costsStatusFilter === 'all' || l.status === 'approved';
      return monthMatch && statusMatch;
    });

    const logsWithCost = filteredLogs.map(l => {
      const emp = employees.find(e => e.id === l.employeeId);
      const rate = emp ? getHourlyRateForDate(emp, l.date) : 0;
      return { ...l, empName: emp?.name ?? 'Bilinmeyen', rate, cost: l.netHours * rate };
    });

    const hourlyTotalCost = logsWithCost.reduce((s, l) => s + l.cost, 0);
    const totalHours = logsWithCost.reduce((s, l) => s + l.netHours, 0);
    const activeDays = new Set(logsWithCost.map(l => l.date));
    const activeLocations = new Set(logsWithCost.map(l => l.location).filter(Boolean));

    // Monthly salary employees (fixed monthly salary)
    const salariedEmps = employees.filter(e => (e.monthly_net_salary || 0) > 0);
    const totalMonthlySalaries = salariedEmps.reduce((s, e) => s + (e.monthly_net_salary || 0), 0);

    // Working days in the selected month (Mon-Fri)
    const daysInMonth = new Date(costsMonth.getFullYear(), costsMonth.getMonth() + 1, 0).getDate();
    let workingDaysInMonth = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(costsMonth.getFullYear(), costsMonth.getMonth(), d).getDay();
      if (dow !== 0 && dow !== 6) workingDaysInMonth++;
    }
    const dailySalaryCost = workingDaysInMonth > 0 ? totalMonthlySalaries / workingDaysInMonth : 0;

    const totalCost = hourlyTotalCost + totalMonthlySalaries;
    const avgCostPerDay =
      activeDays.size > 0 ? hourlyTotalCost / activeDays.size + dailySalaryCost : 0;

    const byDate: Record<string, typeof logsWithCost> = {};
    logsWithCost.forEach(l => {
      if (!byDate[l.date]) byDate[l.date] = [];
      byDate[l.date].push(l);
    });
    const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

    const byLocation: Record<string, { hours: number; cost: number }> = {};
    logsWithCost.forEach(l => {
      const loc = l.location || '(Belirtilmemiş)';
      if (!byLocation[loc]) byLocation[loc] = { hours: 0, cost: 0 };
      byLocation[loc].hours += l.netHours;
      byLocation[loc].cost += l.cost;
    });
    const sortedLocations = Object.entries(byLocation).sort((a, b) => b[1].cost - a[1].cost);

    // Per-employee aggregation
    const byEmployee: Record<
      string,
      { name: string; hours: number; cost: number; rate: number; monthly_net_salary: number }
    > = {};
    logsWithCost.forEach(l => {
      const emp = employees.find(e => e.id === l.employeeId);
      if (!byEmployee[l.employeeId])
        byEmployee[l.employeeId] = {
          name: l.empName,
          hours: 0,
          cost: 0,
          rate: l.rate,
          monthly_net_salary: emp?.monthly_net_salary || 0,
        };
      byEmployee[l.employeeId].hours += l.netHours;
      byEmployee[l.employeeId].cost += l.cost;
    });
    // Include salaried employees that have no hourly logs this month
    salariedEmps.forEach(e => {
      if (!byEmployee[e.id]) {
        byEmployee[e.id] = {
          name: e.name,
          hours: 0,
          cost: 0,
          rate: e.hourlyRate,
          monthly_net_salary: e.monthly_net_salary || 0,
        };
      }
    });
    const sortedEmployees = Object.entries(byEmployee).sort((a, b) => {
      const totalA = a[1].cost + a[1].monthly_net_salary;
      const totalB = b[1].cost + b[1].monthly_net_salary;
      return totalB - totalA;
    });

    return {
      logsWithCost,
      hourlyTotalCost,
      totalHours,
      activeDays,
      activeLocations,
      salariedEmps,
      totalMonthlySalaries,
      workingDaysInMonth,
      dailySalaryCost,
      totalCost,
      avgCostPerDay,
      byDate,
      sortedDates,
      sortedLocations,
      sortedEmployees,
    };
  }, [employees, workLogs, costsMonth, costsStatusFilter]);

  const {
    logsWithCost,
    hourlyTotalCost,
    totalHours,
    activeDays,
    activeLocations,
    salariedEmps,
    totalMonthlySalaries,
    workingDaysInMonth,
    dailySalaryCost,
    totalCost,
    avgCostPerDay,
    byDate,
    sortedDates,
    sortedLocations,
    sortedEmployees,
  } = model;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-[#0e0e11] border border-zinc-800 p-4 rounded-xl">
        <div>
          <h3 className="font-bold text-white flex items-center gap-2">
            <ArrowTrendingUpIcon className="w-5 h-5 text-emerald-400" /> Maliyet Analizi
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">İş yeri ve personel bazlı maliyet dağılımı</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1">
            <button
              onClick={() => setCostsMonth(new Date(costsMonth.getFullYear(), costsMonth.getMonth() - 1, 1))}
              className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white"
            >
              <ChevronDownIcon className="w-4 h-4 rotate-90" />
            </button>
            <span className="text-sm font-mono text-white w-36 text-center">
              {costsMonth.toLocaleString(locale, { month: 'long', year: 'numeric' })}
            </span>
            <button
              onClick={() => setCostsMonth(new Date(costsMonth.getFullYear(), costsMonth.getMonth() + 1, 1))}
              className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white"
            >
              <ChevronRightIcon className="w-4 h-4" />
            </button>
          </div>
          <div className="flex bg-zinc-900 border border-zinc-700 rounded-lg p-0.5">
            <button
              onClick={() => setCostsStatusFilter('approved')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${costsStatusFilter === 'approved' ? 'bg-emerald-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Onaylı
            </button>
            <button
              onClick={() => setCostsStatusFilter('all')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${costsStatusFilter === 'all' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              Tümü
            </button>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#0e0e11] border border-zinc-800 rounded-xl p-4">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Toplam Maliyet</div>
          <div className="text-2xl font-mono font-bold text-emerald-400">{totalCost.toFixed(2)} {currency}</div>
          <div className="text-[10px] text-zinc-600 mt-1">
            saat ({hourlyTotalCost.toFixed(0)}{currency}) + maaş ({totalMonthlySalaries.toFixed(0)}{currency})
          </div>
        </div>
        <div className="bg-[#0e0e11] border border-zinc-800 rounded-xl p-4">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Toplam Saat</div>
          <div className="text-2xl font-mono font-bold text-blue-400">{totalHours.toFixed(1)} s</div>
          <div className="text-[10px] text-zinc-600 mt-1">{activeDays.size} aktif gün</div>
        </div>
        <div className="bg-[#0e0e11] border border-zinc-800 rounded-xl p-4">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Ort. Günlük Maliyet</div>
          <div className="text-2xl font-mono font-bold text-yellow-400">{avgCostPerDay.toFixed(2)} {currency}</div>
          <div className="text-[10px] text-zinc-600 mt-1">saatlik + maaş payı</div>
        </div>
        <div className="bg-[#0e0e11] border border-zinc-800 rounded-xl p-4">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Aylık Sabit Maaş</div>
          <div className="text-2xl font-mono font-bold text-pink-400">{totalMonthlySalaries.toFixed(2)} {currency}</div>
          <div className="text-[10px] text-zinc-600 mt-1">
            {salariedEmps.length} maaşlı personel · {activeLocations.size} lokasyon
          </div>
        </div>
      </div>

      {/* Per-Location + Per-Employee */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#0e0e11] border border-zinc-800 rounded-xl p-5">
          <h4 className="font-bold text-white mb-4 flex items-center gap-2 text-sm">
            <span className="w-2 h-2 rounded-full bg-purple-500 inline-block"></span> İş Yeri Bazlı Maliyet
          </h4>
          {sortedLocations.length === 0 ? (
            <p className="text-zinc-600 text-sm text-center py-6">Bu ay için kayıt yok.</p>
          ) : (
            <div className="space-y-3">
              {sortedLocations.map(([loc, data]) => {
                const pct = totalCost > 0 ? (data.cost / totalCost) * 100 : 0;
                return (
                  <div key={loc}>
                    <div className="flex justify-between items-center text-sm mb-1">
                      <span className="text-zinc-300 font-medium truncate max-w-[55%]">{loc}</span>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-zinc-500 text-xs">{data.hours.toFixed(1)} s</span>
                        <span className="text-emerald-400 font-mono font-bold">{data.cost.toFixed(2)} {currency}</span>
                      </div>
                    </div>
                    <div className="w-full bg-zinc-800 rounded-full h-1.5">
                      <div className="bg-purple-500 h-1.5 rounded-full transition-all" style={{ width: `${pct.toFixed(1)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="bg-[#0e0e11] border border-zinc-800 rounded-xl p-5">
          <h4 className="font-bold text-white mb-4 flex items-center gap-2 text-sm">
            <span className="w-2 h-2 rounded-full bg-blue-500 inline-block"></span> Personel Bazlı Maliyet
          </h4>
          {sortedEmployees.length === 0 ? (
            <p className="text-zinc-600 text-sm text-center py-6">Bu ay için kayıt yok.</p>
          ) : (
            <div className="space-y-3">
              {sortedEmployees.map(([empId, data]) => {
                const empTotal = data.cost + data.monthly_net_salary;
                const pct = totalCost > 0 ? (empTotal / totalCost) * 100 : 0;
                return (
                  <div key={empId}>
                    <div className="flex justify-between items-center mb-1">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center text-[10px] font-bold text-zinc-300">
                          {data.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="text-sm text-zinc-200 font-medium leading-none">{data.name}</div>
                          {data.monthly_net_salary > 0 ? (
                            <div className="text-[10px] text-pink-500">
                              aylık {data.monthly_net_salary.toFixed(0)} {currency} · {data.hours.toFixed(1)} s
                            </div>
                          ) : (
                            <div className="text-[10px] text-zinc-600">
                              {data.rate.toFixed(2)} {currency}/s · {data.hours.toFixed(1)} s
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-emerald-400 font-mono font-bold text-sm">{empTotal.toFixed(2)} {currency}</div>
                        {data.cost > 0 && data.monthly_net_salary > 0 && (
                          <div className="text-[10px] text-zinc-500">
                            {data.cost.toFixed(0)}{currency} saat + {data.monthly_net_salary.toFixed(0)}{currency} maaş
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="w-full bg-zinc-800 rounded-full h-1.5">
                      <div className="bg-blue-500 h-1.5 rounded-full transition-all" style={{ width: `${pct.toFixed(1)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Daily Breakdown */}
      <div className="bg-[#0e0e11] border border-zinc-800 rounded-xl p-5">
        <h4 className="font-bold text-white mb-4 flex items-center gap-2 text-sm">
          <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block"></span> Günlük Maliyet Dökümü
        </h4>
        {sortedDates.length === 0 ? (
          <p className="text-zinc-600 text-sm text-center py-6">Bu ay için kayıt yok.</p>
        ) : (
          <div className="space-y-2">
            {sortedDates.map(date => {
              const dayLogs = byDate[date];
              const dayHourlyCost = dayLogs.reduce((s, l) => s + l.cost, 0);
              const dayHours = dayLogs.reduce((s, l) => s + l.netHours, 0);
              const dayOfWeek = new Date(date + 'T00:00:00').getDay();
              const isWeekday = dayOfWeek !== 0 && dayOfWeek !== 6;
              const dayTotal = dayHourlyCost + (isWeekday ? dailySalaryCost : 0);
              const dayDate = new Date(date + 'T00:00:00');
              return (
                <details key={date} className="group">
                  <summary className="flex items-center justify-between cursor-pointer list-none select-none bg-zinc-900/50 hover:bg-zinc-800/50 rounded-lg px-4 py-3 transition-colors">
                    <div className="flex items-center gap-3">
                      <ChevronRightIcon className="w-4 h-4 text-zinc-500 group-open:rotate-90 transition-transform shrink-0" />
                      <div>
                        <span className="text-white text-sm font-medium">
                          {dayDate.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}
                        </span>
                        <span className="text-zinc-500 text-xs ml-2">
                          ({dayLogs.length} kayıt · {dayHours.toFixed(1)} s)
                        </span>
                      </div>
                    </div>
                    <span className="text-emerald-400 font-mono font-bold text-sm shrink-0">{dayTotal.toFixed(2)} {currency}</span>
                  </summary>
                  <div className="mt-1 ml-4 border-l-2 border-zinc-800 pl-4 space-y-1 pb-2">
                    {dayLogs.map(l => (
                      <div
                        key={l.id}
                        className="flex items-center justify-between text-sm py-1.5 border-b border-zinc-800/40 last:border-0"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-5 h-5 rounded-full bg-zinc-700 flex items-center justify-center text-[9px] font-bold text-zinc-300 shrink-0">
                            {l.empName.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-zinc-200 font-medium">{l.empName}</span>
                              {l.location && (
                                <span className="text-[10px] bg-purple-900/30 text-purple-400 border border-purple-800/50 px-1.5 py-0.5 rounded">
                                  {l.location}
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-zinc-600">
                              {l.startTime} – {l.endTime} · {l.netHours.toFixed(1)} s · {l.rate.toFixed(2)} {currency}/s
                            </div>
                            {l.description && (
                              <div className="text-[10px] text-zinc-500 italic truncate max-w-xs">{l.description}</div>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0 ml-3">
                          <div className="text-emerald-400 font-mono font-bold">{l.cost.toFixed(2)} {currency}</div>
                          <div
                            className={`text-[9px] ${l.status === 'approved' ? 'text-green-500' : l.status === 'rejected' ? 'text-red-500' : 'text-yellow-500'}`}
                          >
                            {l.status === 'approved' ? 'Onaylı' : l.status === 'rejected' ? 'Reddedildi' : 'Bekliyor'}
                          </div>
                        </div>
                      </div>
                    ))}
                    {isWeekday &&
                      salariedEmps.length > 0 &&
                      salariedEmps.map(e => (
                        <div
                          key={`sal-${e.id}`}
                          className="flex items-center justify-between text-sm py-1.5 border-b border-zinc-800/40 last:border-0"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-5 h-5 rounded-full bg-pink-900 flex items-center justify-center text-[9px] font-bold text-pink-300 shrink-0">
                              {e.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <span className="text-zinc-300 font-medium">{e.name}</span>
                              <div className="text-[10px] text-zinc-600">
                                Aylık maaş günlük payı ({workingDaysInMonth} iş günü)
                              </div>
                            </div>
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <div className="text-pink-400 font-mono font-bold">
                              {((e.monthly_net_salary || 0) / workingDaysInMonth).toFixed(2)} {currency}
                            </div>
                            <div className="text-[9px] text-pink-700">Sabit Maaş</div>
                          </div>
                        </div>
                      ))}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </div>

      {/* Salary Entry Table (admin only) */}
      {isAdmin && (
        <div className="bg-[#0e0e11] border border-zinc-800 rounded-xl p-5">
          <h4 className="font-bold text-white mb-1 flex items-center gap-2 text-sm">
            <span className="w-2 h-2 rounded-full bg-pink-500 inline-block"></span> Personel Maaş Tablosu
          </h4>
          <p className="text-[11px] text-zinc-500 mb-4">
            Saatlik çalışanlar için aylık ortalama gösterilir. Aylık net maaş girilmiş olanlar toplam maliyete dahil
            edilir.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
                  <th className="text-left pb-2">Personel</th>
                  <th className="text-right pb-2">Saatlik Ücret</th>
                  <th className="text-right pb-2">Bu Ay Saatlik Toplam</th>
                  <th className="text-right pb-2">Aylık Net Maaş</th>
                  <th className="text-right pb-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {employees.map(emp => {
                  const empLogs = logsWithCost.filter(l => l.employeeId === emp.id);
                  const empHourlyTotal = empLogs.reduce((s, l) => s + l.cost, 0);
                  const empHours = empLogs.reduce((s, l) => s + l.netHours, 0);
                  const isEditing = editingSalaryEmpId === emp.id;
                  return (
                    <tr key={emp.id} className="group">
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-zinc-700 flex items-center justify-center text-[10px] font-bold text-zinc-300">
                            {emp.name.charAt(0).toUpperCase()}
                          </div>
                          <span className="text-zinc-200 font-medium">{emp.name}</span>
                        </div>
                      </td>
                      <td className="py-2.5 text-right text-zinc-400 font-mono">
                        {emp.hourlyRate > 0 ? `${emp.hourlyRate.toFixed(2)} ${currency}/s` : <span className="text-zinc-700">—</span>}
                      </td>
                      <td className="py-2.5 text-right">
                        {empHourlyTotal > 0 ? (
                          <span className="text-emerald-400 font-mono">
                            {empHourlyTotal.toFixed(2)} {currency}
                            <span className="text-zinc-600 text-[10px] ml-1">({empHours.toFixed(1)} s)</span>
                          </span>
                        ) : (
                          <span className="text-zinc-700">—</span>
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        {isEditing ? (
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            className="bg-zinc-900 border border-pink-700 rounded px-2 py-1 text-white font-mono text-sm w-28 text-right"
                            value={editingSalaryValue}
                            onChange={e => setEditingSalaryValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleSaveMonthlyNetSalary(emp.id);
                              if (e.key === 'Escape') setEditingSalaryEmpId(null);
                            }}
                            autoFocus
                          />
                        ) : (
                          <span
                            className={`font-mono ${(emp.monthly_net_salary || 0) > 0 ? 'text-pink-400 font-bold' : 'text-zinc-700'}`}
                          >
                            {(emp.monthly_net_salary || 0) > 0 ? `${emp.monthly_net_salary!.toFixed(2)} ${currency}` : '—'}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        {isEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => handleSaveMonthlyNetSalary(emp.id)}
                              className="px-2 py-1 bg-pink-700 hover:bg-pink-600 text-white rounded text-xs"
                            >
                              Kaydet
                            </button>
                            <button
                              onClick={() => setEditingSalaryEmpId(null)}
                              className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-xs"
                            >
                              İptal
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => {
                              setEditingSalaryEmpId(emp.id);
                              setEditingSalaryValue(String(emp.monthly_net_salary || ''));
                            }}
                            className="opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs"
                          >
                            Düzenle
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
