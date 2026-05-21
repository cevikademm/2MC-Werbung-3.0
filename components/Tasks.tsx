import React, { useState, useEffect } from 'react';
import { Task, Employee, Role, Branch } from '../types';
import { Calendar, CheckCircle2, MoreVertical, Plus, Edit2, Trash2, CheckSquare, X, Save, User, ListPlus, Users, Archive, Layout, Building2, Undo2, LayoutGrid, ListTodo, AlertCircle, Clock, CheckCircle, Zap, Loader2, ArrowRightLeft, Lock } from 'lucide-react';
import { includeAsPersonnel } from '../constants';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../lib/i18n';
import { translateContent } from '../services/geminiService';
import { GlowingEffect } from './ui/glowing-effect';


interface TasksProps {
    currentUser: Employee;
}

// Sekme yapısı: 'ACTIVE' (Todo + In Progress) ve 'DONE'
type TaskTab = 'ACTIVE' | 'DONE';

// --- SMART TRANSLATION COMPONENT ---
// Bu bileşen metni alır, dil değiştiğinde Gemini servisine sorar ve çeviriyi basar.
const SmartText: React.FC<{ text: string, className?: string, as?: 'span' | 'p' | 'h4' }> = ({ text, className, as = 'span' }) => {
    const { language, t } = useLanguage();
    const [displayText, setDisplayText] = useState(text);
    const [isTranslating, setIsTranslating] = useState(false);

    useEffect(() => {
        let isMounted = true;

        const performTranslation = async () => {
            // Eğer metin bir "i18n key" ise (task.mock ile başlıyorsa), i18n kütüphanesini kullan
            if (text.startsWith('task.mock') || text.startsWith('checklist.')) {
                if(isMounted) setDisplayText(t(text));
                return;
            }

            // Dil Türkçe ise ve kaynak metin de muhtemelen Türkçe ise (admin girişi), orijinali göster.
            // (Burada basitçe 'tr' modunda orijinali gösteriyoruz)
            if (language === 'tr') {
                if(isMounted) setDisplayText(text);
                return;
            }

            // Almanca (de) modundaysak çeviri yap
            setIsTranslating(true);
            try {
                const translated = await translateContent(text, language);
                if (isMounted) setDisplayText(translated);
            } catch (err) {
                if (isMounted) setDisplayText(text); // Hata olursa orijinal kalsın
            } finally {
                if (isMounted) setIsTranslating(false);
            }
        };

        performTranslation();

        return () => { isMounted = false; };
    }, [text, language, t]); // Metin veya Dil değişince çalış

    const Tag = as as any;

    return (
        <Tag className={`${className} transition-opacity duration-300 ${isTranslating ? 'opacity-50' : 'opacity-100'}`}>
            {displayText}
        </Tag>
    );
};


const Tasks: React.FC<TasksProps> = ({ currentUser }) => {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]); // Canlı personel listesi
    const [transferredEmpIds, setTransferredEmpIds] = useState<string[]>([]); // Transfer olanların ID listesi
    
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<TaskTab>('ACTIVE');

    const { t, formatDate } = useLanguage();

    // Modal State
    const [showAddModal, setShowAddModal] = useState(false);
    const [selectedBranches, setSelectedBranches] = useState<Branch[]>([]); 
    
    // Task Editing State
    const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

    // New/Edit Task Form State
    const [newTaskForm, setNewTaskForm] = useState<Partial<Task>>({
        title: '',
        description: '',
        assignedTo: [],
        dueDate: new Date().toISOString().split('T')[0],
        priority: 'Orta',
        status: 'todo',
        checklist: []
    });

    const [newChecklistItem, setNewChecklistItem] = useState('');

    useEffect(() => {
        fetchData();
        
        // SUBSCRIBE TO REALTIME CHANGES
        const channel = supabase.channel('tasks-page-realtime')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
                fetchData();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
                fetchData(); // Personel şube değiştirirse listeyi yenile
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_events' }, () => {
                fetchData(); // Transfer olaylarını takip et
            })
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [currentUser]);

    const fetchData = async () => {
        setIsLoading(true);
        try {
            // 1. Fetch Employees (Realtime Profile Data)
            // Çift rollü adminler (Apo, Malik) personel listesinde kalır, diğer adminler filtrelenir.
            const { data: empData } = await supabase.from('profiles').select('*');
            let liveEmployees: Employee[] = [];

            if (empData) {
                liveEmployees = empData.filter(includeAsPersonnel).map((e: any) => ({
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
                    badges: e.badges || [],
                    tags: e.tags || [],
                    metrics: e.metrics
                }));
                setEmployees(liveEmployees);
            } else {
                setEmployees([]);
                liveEmployees = [];
            }

            // 2. Fetch Tasks (ONLY FROM DB, NO MOCKS)
            let taskQuery = supabase.from('tasks').select('*');
            if (currentUser.role !== Role.ADMIN) {
                taskQuery = taskQuery.contains('assigned_to', [currentUser.id]);
            }

            const { data: taskData, error: taskError } = await taskQuery;
            if(taskError) throw taskError;

            const dbTasks: Task[] = taskData ? taskData.map((t: any) => ({
                id: t.id,
                title: t.title,
                description: t.description,
                assignedTo: t.assigned_to || [],
                dueDate: t.due_date,
                priority: t.priority,
                status: t.status,
                progress: t.progress,
                checklist: t.checklist || [],
                completedAt: t.completed_at,
                completedBy: t.completed_by
            })) : [];

            // Tarihe göre sırala
            dbTasks.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
            
            // Sadece veritabanı kayıtlarını set et (Mock yok)
            setTasks(dbTasks);

            // 3. Fetch Active Transfers from personnel_transfers
            const today = new Date().toISOString().split('T')[0];
            const { data: transferData } = await supabase.from('personnel_transfers')
                .select('employee_id')
                .eq('status', 'active')
                .lte('start_date', today)
                .gte('end_date', today);

            if (transferData) {
                const activeIds = transferData.map((t: any) => t.employee_id);
                setTransferredEmpIds(activeIds);
            } else {
                setTransferredEmpIds([]);
            }

        } catch (error) {
            console.error("Veri yükleme hatası:", error);
            setTasks([]); // Hata durumunda boş liste
        } finally {
            setIsLoading(false);
        }
    };

    const getAssignees = (ids: string[]) => {
        return employees.filter(e => ids.includes(e.id));
    };

    const toggleChecklistItem = async (taskId: string, itemId: string) => {
        const taskToUpdate = tasks.find(t => t.id === taskId);
        if(!taskToUpdate) return;

        const targetItem = taskToUpdate.checklist.find(c => c.id === itemId);
        if (targetItem?.completed) {
            if (targetItem.completedBy !== currentUser.id && currentUser.role !== Role.ADMIN) {
                alert(t('tasks.checklistOnlyOwner'));
                return;
            }
        }

        const newChecklist = taskToUpdate.checklist.map(c => {
            if (c.id === itemId) {
                const isNowCompleted = !c.completed;
                return { 
                    ...c, 
                    completed: isNowCompleted,
                    completedBy: isNowCompleted ? currentUser.id : undefined
                };
            }
            return c;
        });

        const completedCount = newChecklist.filter(c => c.completed).length;
        const totalCount = newChecklist.length;
        const newProgress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
        
        let newStatus = taskToUpdate.status;
        let newCompletedAt = taskToUpdate.completedAt;
        let newCompletedBy = taskToUpdate.completedBy;

        if (newProgress === 100) {
            newStatus = 'done';
            newCompletedAt = new Date().toISOString();
            newCompletedBy = currentUser.id; 
        } else if (newStatus === 'done' && newProgress < 100) {
            newStatus = 'in_progress';
            newCompletedAt = undefined;
            newCompletedBy = undefined;
        }

        try {
            await supabase.from('tasks').update({
                checklist: newChecklist,
                progress: newProgress,
                status: newStatus,
                completed_at: newCompletedAt,
                completed_by: newCompletedBy
            }).eq('id', taskId);
            
            // Local update for immediate feedback
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, checklist: newChecklist, progress: newProgress, status: newStatus, completedAt: newCompletedAt, completedBy: newCompletedBy } : t));

        } catch (err) {
            console.error("Checklist update error:", err);
        }
    };

    const reopenTask = async (taskId: string) => {
        try {
            const { error } = await supabase.from('tasks').update({
                status: 'in_progress',
                completed_at: null
            }).eq('id', taskId);
            
            if(error) throw error;
            
            // Local update
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'in_progress', completedAt: undefined } : t));
        } catch (err) {
            console.error("Task reopen error:", err);
        }
    };
    
    const handleDeleteTask = async (taskId: string) => {
        if (!confirm(t('tasks.confirmDelete'))) return;
        try {
            const { error } = await supabase.from('tasks').delete().eq('id', taskId);
            if(error) throw error;
            
            // State update
            setTasks(prev => prev.filter(t => t.id !== taskId));
        } catch(err: any) {
            console.warn("Delete error:", err);
            alert(t('tasks.deleteFailed'));
        }
    };
    
    const handleEditTask = (task: Task) => {
        setEditingTaskId(task.id);
        setNewTaskForm({
            title: task.title,
            description: task.description,
            assignedTo: task.assignedTo,
            dueDate: task.dueDate,
            priority: task.priority,
            status: task.status,
            checklist: task.checklist
        });
        
        const branches = Object.values(Branch);
        setSelectedBranches(branches);
        
        setShowAddModal(true);
    };

    const handleAddChecklistItem = (e: React.KeyboardEvent | React.MouseEvent) => {
        if ((e.type === 'keydown' && (e as React.KeyboardEvent).key !== 'Enter') || !newChecklistItem.trim()) return;
        e.preventDefault();
        const newItem = { id: `cl_${Date.now()}`, text: newChecklistItem.trim(), completed: false };
        setNewTaskForm(prev => ({ ...prev, checklist: [...(prev.checklist || []), newItem] }));
        setNewChecklistItem('');
    };

    const handleRemoveChecklistItem = (id: string) => {
        setNewTaskForm(prev => ({ ...prev, checklist: prev.checklist?.filter(item => item.id !== id) }));
    };

    const toggleBranchSelection = (branch: Branch) => {
        setSelectedBranches(prev => 
            prev.includes(branch) ? prev.filter(b => b !== branch) : [...prev, branch]
        );
    };

    const toggleAssignee = (employeeId: string) => {
        setNewTaskForm(prev => {
            const current = prev.assignedTo || [];
            return current.includes(employeeId) 
                ? { ...prev, assignedTo: current.filter(id => id !== employeeId) }
                : { ...prev, assignedTo: [...current, employeeId] };
        });
    };

    const handleSaveTask = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTaskForm.title || !newTaskForm.assignedTo || newTaskForm.assignedTo.length === 0) {
            alert(t('tasks.warnTitle'));
            return;
        }

        setIsLoading(true);
        
        const taskPayload: any = {
            title: newTaskForm.title!,
            description: newTaskForm.description,
            assigned_to: newTaskForm.assignedTo!,
            due_date: newTaskForm.dueDate!,
            priority: newTaskForm.priority,
            checklist: newTaskForm.checklist || []
        };
        
        if (!editingTaskId) {
            taskPayload.id = `task_${Date.now()}`;
            taskPayload.status = 'todo';
            taskPayload.progress = 0;
        }

        try {
            if (editingTaskId) {
                 const { error } = await supabase.from('tasks').update(taskPayload).eq('id', editingTaskId);
                 if(error) throw error;
                
                // Local Update
                setTasks(prev => prev.map(t => t.id === editingTaskId ? { ...t, ...taskPayload, assignedTo: taskPayload.assigned_to, dueDate: taskPayload.due_date } : t));

            } else {
                const { error } = await supabase.from('tasks').insert([taskPayload]);
                if(error) throw error;
                // Local Update
                const newTask = { ...taskPayload, id: taskPayload.id, assignedTo: taskPayload.assigned_to, dueDate: taskPayload.due_date } as Task;
                setTasks(prev => [...prev, newTask]);
            }

            setShowAddModal(false);
            setNewTaskForm({
                title: '', description: '', assignedTo: [],
                dueDate: new Date().toISOString().split('T')[0], priority: 'Orta', status: 'todo', checklist: []
            });
            setSelectedBranches([]);
            setEditingTaskId(null);
            
        } catch (err: any) {
             console.warn("DB Save error:", err);
             alert(t('tasks.saveError'));
        } finally {
            setIsLoading(false);
        }
    };

    const getPriorityBadge = (priority: string) => {
         switch(priority) {
            case 'Yüksek': return <span className="flex h-2 w-2 rounded-full bg-red-500 animate-pulse"></span>;
            case 'Orta': return <span className="flex h-2 w-2 rounded-full bg-amber-500"></span>;
            default: return <span className="flex h-2 w-2 rounded-full bg-blue-500"></span>;
        }
    }

    const renderCard = (task: Task) => {
        const assignees = getAssignees(task.assignedTo);
        
        let mainCompleter = null;
        if (task.completedBy) {
            mainCompleter = employees.find(e => e.id === task.completedBy);
        } else if (task.checklist && task.checklist.length > 0) {
            const lastCompletedItem = [...task.checklist].reverse().find(i => i.completed && i.completedBy);
            if (lastCompletedItem && lastCompletedItem.completedBy) {
                mainCompleter = employees.find(e => e.id === lastCompletedItem.completedBy);
            }
        }

        const displayProgress = task.checklist.length > 0 
            ? Math.round((task.checklist.filter(c => c.completed).length / task.checklist.length) * 100) 
            : task.progress;

        const isHighPriority = task.priority === 'Yüksek';
        const isDone = task.status === 'done';
        const isInProgress = task.status === 'in_progress';

        return (
            <div 
                key={task.id} 
                className={`w-full group relative overflow-hidden rounded-2xl border transition-all duration-300 mb-4
                ${isDone 
                    ? 'bg-white dark:bg-zinc-900/30 border-slate-200 dark:border-zinc-800 opacity-80 hover:opacity-100' 
                    : 'bg-white dark:bg-zinc-900/60 backdrop-blur-sm hover:translate-y-[-2px] hover:shadow-xl border-white/5 hover:border-slate-300 dark:border-zinc-700'
                } 
                ${isHighPriority && !isDone ? 'border-red-500/20 hover:border-red-500/40' : ''}`}
            >
                {/* Priority Strip */}
                <div className={`absolute top-0 bottom-0 left-0 w-1 ${
                    task.priority === 'Yüksek' ? 'bg-red-500' : 
                    task.priority === 'Orta' ? 'bg-amber-500' : 'bg-blue-500'
                }`}></div>

                <div className="p-5 pl-6">
                    {/* Header */}
                    <div className="flex justify-between items-start mb-3">
                        <div className="flex flex-col gap-1 w-full">
                            <div className="flex items-center justify-between w-full">
                                <div className="flex items-center gap-2">
                                    {/* Status Indicator */}
                                    {!isDone && (
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded border flex items-center gap-1 ${
                                            isInProgress 
                                            ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' 
                                            : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 border-slate-300 dark:border-zinc-700'
                                        }`}>
                                            {isInProgress ? <Loader2 size={10} className="animate-spin" /> : <ListTodo size={10} />}
                                            {isInProgress ? t('tasks.statusProgress') : t('tasks.statusTodo')}
                                        </span>
                                    )}
                                    
                                    {getPriorityBadge(task.priority)}
                                    <span className={`text-[10px] font-bold tracking-wider uppercase ${
                                        task.priority === 'Yüksek' ? 'text-red-400' : 
                                        task.priority === 'Orta' ? 'text-amber-400' : 'text-blue-400'
                                    }`}>{t(`priority.${task.priority}`)}</span>
                                </div>

                                <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {task.status === 'done' && (
                                        <button onClick={() => reopenTask(task.id)} title={t('tasks.reopenTask')} className="p-1.5 bg-slate-100 dark:bg-zinc-800 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors">
                                            <Undo2 size={14} />
                                        </button>
                                    )}
                                    
                                    {/* ADMIN EDIT / DELETE ACTIONS */}
                                    {currentUser.role === Role.ADMIN && (
                                        <>
                                            <button 
                                                onClick={() => handleEditTask(task)} 
                                                title={t('tasks.editTitle')}
                                                className="p-1.5 bg-slate-100 dark:bg-zinc-800 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                                            >
                                                <Edit2 size={14} />
                                            </button>
                                            <button 
                                                onClick={() => handleDeleteTask(task.id)} 
                                                title={t('tasks.cancelDelete')}
                                                className="p-1.5 bg-slate-100 dark:bg-zinc-800 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-red-400 hover:bg-red-900/20 transition-colors"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* SMART TEXT: TITLE */}
                            <SmartText 
                                as="h4" 
                                text={task.title} 
                                className={`text-base font-bold leading-tight mt-1 ${task.status === 'done' ? 'text-slate-500 dark:text-zinc-500 line-through' : 'text-slate-900 dark:text-zinc-100'}`} 
                            />
                            
                            {isDone && (
                                <div className="flex items-center gap-2 mt-2 bg-gradient-to-r from-green-900/30 to-emerald-900/10 w-fit px-3 py-1 rounded-lg border border-green-500/20">
                                    <CheckCircle2 size={14} className="text-green-500"/>
                                    <span className="text-[11px] text-green-300 font-bold">
                                        {t('tasks.completedBy')}: {mainCompleter ? mainCompleter.name : t('tasks.unknown')}
                                    </span>
                                    {mainCompleter && (
                                        <img src={mainCompleter.avatarUrl} className="w-5 h-5 rounded-full border border-green-500/50" referrerPolicy="no-referrer" />
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* SMART TEXT: DESCRIPTION */}
                    {task.description && (
                        <SmartText 
                            as="p"
                            text={task.description} 
                            className="text-xs text-slate-600 dark:text-zinc-400 mb-4 line-clamp-2 leading-relaxed" 
                        />
                    )}

                    {/* Progress Bar */}
                    <div className="mb-4">
                        <div className="flex justify-between items-center text-[10px] text-slate-500 dark:text-zinc-500 mb-1.5">
                            <span className="font-medium">Durum</span>
                            <span className={`font-mono ${displayProgress === 100 ? 'text-green-400' : 'text-slate-700 dark:text-zinc-300'}`}>%{displayProgress}</span>
                        </div>
                        <div className="w-full h-1 bg-slate-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all duration-700 ease-out ${displayProgress === 100 ? 'bg-green-500' : 'bg-gradient-to-r from-indigo-500 to-purple-500'}`} style={{ width: `${displayProgress}%` }}></div>
                        </div>
                    </div>

                    {/* Checklist Preview - Styled */}
                    {task.checklist.length > 0 && (
                        <div className="bg-black/20 rounded-xl p-2 mb-4 space-y-1">
                            {task.checklist.map(item => {
                                const completer = item.completedBy ? employees.find(e => e.id === item.completedBy) : null;
                                
                                // UI KONTROLÜ
                                const isLocked = item.completed && item.completedBy !== currentUser.id && currentUser.role !== Role.ADMIN;

                                return (
                                    <div
                                        key={item.id}
                                        onClick={() => toggleChecklistItem(task.id, item.id)}
                                        className={`flex items-center justify-between p-1.5 rounded-lg transition-colors group/item ${isLocked ? 'cursor-not-allowed opacity-60 hover:bg-red-900/10' : 'cursor-pointer hover:bg-white/5'}`}
                                        title={isLocked ? t('tasks.checklistOnlyOwner') : ''}
                                    >
                                         <div className="flex items-center gap-3 overflow-hidden">
                                             <div className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border transition-all ${item.completed ? (isLocked ? 'bg-slate-200 dark:bg-zinc-700 border-zinc-600' : 'bg-green-500/20 border-green-500/50') : 'border-zinc-600 group-hover/item:border-zinc-400'}`}>
                                                {item.completed && !isLocked && <CheckCircle2 size={10} className="text-green-400" />}
                                                {isLocked && <Lock size={8} className="text-slate-600 dark:text-zinc-400" />}
                                             </div>
                                             {/* SMART TEXT: CHECKLIST ITEM */}
                                             <SmartText 
                                                text={item.text} 
                                                className={`text-xs truncate transition-colors ${item.completed ? 'text-slate-400 dark:text-zinc-600 line-through' : 'text-slate-700 dark:text-zinc-300'}`}
                                             />
                                         </div>
                                         
                                         {item.completed && completer && (
                                             <div className="flex items-center gap-1.5 pl-2 flex-shrink-0">
                                                 <span className="text-[9px] text-slate-500 dark:text-zinc-500 font-medium hidden sm:inline">{completer.name.split(' ')[0]}</span>
                                                 <img src={completer.avatarUrl} className="w-4 h-4 rounded-full opacity-80 border border-slate-200 dark:border-zinc-800" title={`Tamamlayan: ${completer.name}`} referrerPolicy="no-referrer" />
                                             </div>
                                         )}
                                    </div>
                                )
                            })}
                        </div>
                    )}

                    {/* Footer Info */}
                    <div className="flex items-center justify-between pt-3 border-t border-white/5">
                        <div className="flex items-center -space-x-2 pl-1">
                            {assignees.slice(0, 3).map(user => (
                                <div key={user.id} className="relative group/avatar">
                                    <img src={user.avatarUrl} className="w-7 h-7 rounded-full border-2 border-slate-200 dark:border-zinc-900 object-cover transition-transform hover:scale-110 hover:z-10" referrerPolicy="no-referrer" />
                                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-black text-slate-900 dark:text-white text-[10px] rounded opacity-0 group-hover/avatar:opacity-100 whitespace-nowrap pointer-events-none">
                                        {user.name}
                                    </div>
                                </div>
                            ))}
                            {assignees.length > 3 && (
                                <div className="w-7 h-7 rounded-full bg-slate-100 dark:bg-zinc-800 border-2 border-slate-200 dark:border-zinc-900 flex items-center justify-center text-[9px] font-bold text-slate-600 dark:text-zinc-400">+{assignees.length - 3}</div>
                            )}
                        </div>
                        
                        <div className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-medium ${
                            new Date(task.dueDate) < new Date() && task.status !== 'done' 
                            ? 'bg-red-900/20 text-red-400 border border-red-900/30' 
                            : 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                        }`}>
                            <Calendar size={10} />
                            <span>{formatDate(task.dueDate, { day: 'numeric', month: 'short' })}</span>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    // --- STATS CALCULATION ---
    const stats = {
        total: tasks.length,
        todo: tasks.filter(t => t.status === 'todo').length,
        inProgress: tasks.filter(t => t.status === 'in_progress').length,
        done: tasks.filter(t => t.status === 'done').length
    };

    const currentTasks = tasks.filter(t => {
        if (activeTab === 'ACTIVE') return t.status === 'todo' || t.status === 'in_progress';
        if (activeTab === 'DONE') return t.status === 'done';
        return true;
    });

    return (
        <div className="h-full flex flex-col relative bg-[#09090b]">
             {/* Background Gradients */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-indigo-900/5 rounded-full blur-[100px]"></div>
                <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-blue-900/5 rounded-full blur-[100px]"></div>
            </div>

            {/* NEW TASK MODAL */}
            {showAddModal && (
                <div className="fixed inset-0 z-[100] flex justify-center sm:items-center bg-black/80 backdrop-blur-sm p-0 sm:p-4 animate-in fade-in duration-200">
                    <div className="bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-800 sm:border sm:rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col h-full sm:h-auto sm:max-h-[85dvh] ring-1 ring-white/10 animate-in slide-in-from-bottom-10 sm:zoom-in-95">
                        
                        <div className="p-5 border-b border-slate-200 dark:border-zinc-800 flex justify-between items-center bg-slate-50 dark:bg-zinc-950/80 backdrop-blur-xl shrink-0 gap-4">
                            <div className="flex-1 min-w-0">
                                <h3 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2 truncate">
                                    <CheckSquare size={22} className="text-indigo-500 shrink-0" /> 
                                    <span className="truncate">{editingTaskId ? t('tasks.editTask') : t('tasks.newTask')}</span>
                                </h3>
                            </div>
                            <button onClick={() => { setShowAddModal(false); setEditingTaskId(null); }} className="p-2 bg-slate-100 dark:bg-zinc-800/50 rounded-lg text-slate-600 dark:text-zinc-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors">
                                <X size={20} />
                            </button>
                        </div>
                        
                        <div className="p-6 overflow-y-auto custom-scrollbar flex-1 pb-32">
                            <form id="taskForm" onSubmit={handleSaveTask} className="space-y-6">
                                {/* Title */}
                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400 uppercase tracking-wider">{t('tasks.titleLabel')} <span className="text-red-500">*</span></label>
                                    <input type="text" required value={newTaskForm.title} onChange={(e) => setNewTaskForm({...newTaskForm, title: e.target.value})} placeholder="..." className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-4 py-3 text-sm text-slate-900 dark:text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all" />
                                </div>

                                {/* BRANCH & ASSIGNEE SELECTOR */}
                                <div className="p-5 bg-slate-50 dark:bg-zinc-950/50 border border-slate-200 dark:border-zinc-800 rounded-2xl space-y-5">
                                    {/* 1. Branch Select */}
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium text-slate-600 dark:text-zinc-400 flex items-center gap-2"><Building2 size={14} className="text-indigo-400"/> {t('tasks.branchLabel')}</label>
                                        <div className="flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    if (selectedBranches.length === Object.values(Branch).length) {
                                                        setSelectedBranches([]);
                                                    } else {
                                                        setSelectedBranches(Object.values(Branch));
                                                    }
                                                }}
                                                className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${selectedBranches.length === Object.values(Branch).length ? 'bg-indigo-600 text-slate-900 dark:text-white border-indigo-500 shadow-lg shadow-indigo-900/20' : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:border-zinc-700'}`}
                                            >
                                                {t('tasks.allBranches')}
                                            </button>
                                            {Object.values(Branch).map(branch => (
                                                <button
                                                    key={branch}
                                                    type="button"
                                                    onClick={() => toggleBranchSelection(branch)}
                                                    className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${selectedBranches.includes(branch) ? 'bg-indigo-600 text-slate-900 dark:text-white border-indigo-500 shadow-lg shadow-indigo-900/20' : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:border-zinc-700'}`}
                                                >
                                                    {branch}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    {/* 2. Employee Select (Filtered) */}
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium text-slate-600 dark:text-zinc-400 flex items-center gap-2"><Users size={14} className="text-indigo-400"/> {t('tasks.staffLabel')} <span className="text-red-500">*</span></label>
                                        {false ? (
                                            <div className="text-xs text-slate-400 dark:text-zinc-600 italic px-2 py-2 border border-dashed border-slate-200 dark:border-zinc-800 rounded-lg text-center">{t('tasks.warnBranch')}</div>
                                        ) : (
                                            <div className="flex gap-2 overflow-x-auto pb-2 custom-scrollbar">
                                                {employees.map(emp => {
                                                    const isSelected = newTaskForm.assignedTo?.includes(emp.id);
                                                    const isTransferred = false; // Transfer feature disabled

                                                    return (
                                                        <div key={emp.id} onClick={() => toggleAssignee(emp.id)} className={`cursor-pointer flex items-center gap-3 px-3 py-2 rounded-xl border transition-all min-w-[160px] flex-shrink-0 ${isSelected ? 'bg-indigo-500/10 border-indigo-500 text-slate-900 dark:text-white' : 'bg-white dark:bg-zinc-900 border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:border-zinc-700 text-slate-600 dark:text-zinc-400'}`}>
                                                            <div className="relative">
                                                                <img src={emp.avatarUrl} className={`w-8 h-8 rounded-full ${isTransferred ? 'border-2 border-orange-500' : ''}`} referrerPolicy="no-referrer" />
                                                                {isSelected && <div className="absolute -top-1 -right-1 w-3 h-3 bg-indigo-500 rounded-full border-2 border-slate-200 dark:border-zinc-900"></div>}
                                                            </div>
                                                            <div className="flex flex-col overflow-hidden">
                                                                <span className={`text-xs truncate flex items-center gap-1 ${isTransferred ? 'text-orange-500 font-bold' : 'font-medium'}`}>
                                                                    {emp.name} 
                                                                    {isTransferred && <ArrowRightLeft size={10} className="text-orange-500"/>}
                                                                </span>
                                                                <span className="text-[10px] opacity-60 truncate">Havuz</span>
                                                            </div>
                                                        </div>
                                                    )
                                                })}
                                                {employees.length === 0 && (
                                                     <div className="text-xs text-slate-500 dark:text-zinc-500 px-2">{t('tasks.noStaff')}</div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Checklist Builder */}
                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400 flex items-center gap-2"><ListPlus size={14}/> {t('tasks.checklist')}</label>
                                    <div className="flex gap-2">
                                        <input type="text" value={newChecklistItem} onChange={(e) => setNewChecklistItem(e.target.value)} onKeyDown={handleAddChecklistItem} placeholder={t('tasks.addChecklist')} className="flex-1 bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-slate-900 dark:text-white focus:border-indigo-500 outline-none" />
                                        <button type="button" onClick={handleAddChecklistItem} className="px-4 bg-slate-100 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-slate-200 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 rounded-xl"><Plus size={18} /></button>
                                    </div>
                                    <div className="space-y-1 mt-2 max-h-[120px] overflow-y-auto pr-1 custom-scrollbar">
                                        {newTaskForm.checklist?.map(item => (
                                            <div key={item.id} className="flex items-center justify-between group p-2 rounded-lg bg-white dark:bg-zinc-900/30 border border-slate-200 dark:border-zinc-800/50 hover:bg-slate-100 dark:hover:bg-white dark:hover:bg-zinc-900/80 transition-colors">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500"></div>
                                                    {/* SMART TEXT PREVIEW */}
                                                    <span className="text-sm text-slate-700 dark:text-zinc-300">{item.text}</span>
                                                </div>
                                                <button type="button" onClick={() => handleRemoveChecklistItem(item.id)} className="text-slate-400 dark:text-zinc-600 hover:text-red-400 p-1"><Trash2 size={14} /></button>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">{t('tasks.dueDate')}</label>
                                        <input 
                                            type="date" 
                                            required 
                                            value={newTaskForm.dueDate || ''} 
                                            onChange={(e) => setNewTaskForm({...newTaskForm, dueDate: e.target.value})} 
                                            className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-slate-900 dark:text-white focus:border-indigo-500 outline-none [color-scheme:dark] cursor-pointer" 
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">{t('tasks.priority')}</label>
                                        <div className="grid grid-cols-3 gap-2">
                                            {['Düşük', 'Orta', 'Yüksek'].map(p => (
                                                <button
                                                    key={p}
                                                    type="button"
                                                    onClick={() => setNewTaskForm({...newTaskForm, priority: p as any})}
                                                    className={`py-2.5 text-xs font-medium rounded-xl border transition-all ${
                                                        newTaskForm.priority === p 
                                                        ? (p === 'Yüksek' ? 'bg-red-500/20 text-red-400 border-red-500/50' : p === 'Orta' ? 'bg-amber-500/20 text-amber-400 border-amber-500/50' : 'bg-blue-500/20 text-blue-400 border-blue-500/50')
                                                        : 'bg-slate-50 dark:bg-zinc-950 text-slate-500 dark:text-zinc-500 border-slate-200 dark:border-zinc-800 hover:border-slate-300 dark:border-zinc-700'
                                                    }`}
                                                >
                                                    {t(`priority.${p}`)}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>

                                <div className="pt-6 border-t border-slate-200 dark:border-zinc-800/50 space-y-3">
                                    <button 
                                        type="submit" 
                                        disabled={isLoading} 
                                        className="w-full py-4 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-slate-900 dark:text-white font-bold rounded-2xl shadow-xl shadow-indigo-900/20 flex items-center justify-center gap-3 active:scale-95 transition-all"
                                    >
                                        {isLoading ? <Loader2 className="animate-spin" size={24}/> : <Save size={24} />}
                                        <span className="text-base">{t('tasks.save')}</span>
                                    </button>
                                    
                                    <button 
                                        type="button"
                                        onClick={() => { setShowAddModal(false); setEditingTaskId(null); }}
                                        className="w-full py-3 bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-400 font-medium rounded-xl hover:bg-slate-200 dark:hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                                    >
                                        {t('tasks.cancel')}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}

            {/* HEADER AREA - STATS & ACTIONS */}
            <div className="px-8 pt-6 pb-2 relative z-10">
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                    <div>
                        <h2 className="text-3xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-3">
                           {t('tasks.title')}
                           <span className="text-sm font-normal text-slate-500 dark:text-zinc-500 bg-white dark:bg-zinc-900 px-3 py-1 rounded-full border border-slate-200 dark:border-zinc-800">
                                {currentUser.role === Role.ADMIN ? t('tasks.adminView') : t('tasks.staffView')}
                           </span>
                        </h2>
                        {/* MINI STATS BAR */}
                        <div className="flex gap-6 mt-6">
                            <div className="flex flex-col">
                                <span className="text-[10px] text-slate-500 dark:text-zinc-500 uppercase tracking-wider font-bold">{t('tasks.total')}</span>
                                <span className="text-2xl font-light text-slate-900 dark:text-white">{stats.total}</span>
                            </div>
                            <div className="w-px h-8 bg-slate-100 dark:bg-zinc-800 self-end mb-1"></div>
                            <div className="flex flex-col">
                                <span className="text-[10px] text-indigo-400/70 uppercase tracking-wider font-bold">{t('tasks.active')}</span>
                                <span className="text-2xl font-light text-indigo-400">{stats.todo + stats.inProgress}</span>
                            </div>
                            <div className="w-px h-8 bg-slate-100 dark:bg-zinc-800 self-end mb-1"></div>
                            <div className="flex flex-col">
                                <span className="text-[10px] text-green-500/70 uppercase tracking-wider font-bold">{t('tasks.completed')}</span>
                                <span className="text-2xl font-light text-green-500">{stats.done}</span>
                            </div>
                        </div>
                    </div>
                    
                    <div className="flex items-center gap-3">
                        <div className="flex bg-white dark:bg-zinc-900/80 backdrop-blur-md p-1 rounded-xl border border-slate-200 dark:border-zinc-800">
                            <button 
                                onClick={() => setActiveTab('ACTIVE')} 
                                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === 'ACTIVE' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow-md' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                            >
                                <Zap size={16} /> {t('tasks.tabActive')}
                            </button>
                             <button 
                                onClick={() => setActiveTab('DONE')} 
                                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${activeTab === 'DONE' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow-md' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                            >
                                <CheckCircle size={16} /> {t('tasks.tabDone')}
                            </button>
                        </div>

                        {currentUser.role === Role.ADMIN && (
                            <button onClick={() => { setEditingTaskId(null); setNewTaskForm({title: '', description: '', assignedTo: [], dueDate: new Date().toISOString().split('T')[0], priority: 'Orta', status: 'todo', checklist: []}); setSelectedBranches([]); setShowAddModal(true); }} className="flex items-center gap-2 px-5 py-3 bg-white text-black text-sm font-bold rounded-xl hover:bg-zinc-200 transition-colors shadow-lg shadow-white/10">
                                <Plus size={18} /> {t('tasks.newTask')}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* CONTENT AREA */}
            <div className="flex-1 overflow-x-auto p-8 relative z-10 flex flex-col items-center">
                 <div className="w-full max-w-4xl space-y-4 pb-20">
                     {currentTasks.length === 0 ? (
                         <div className="flex flex-col items-center justify-center py-20 text-slate-400 dark:text-zinc-600 border-2 border-dashed border-slate-200 dark:border-zinc-800/50 rounded-3xl bg-white dark:bg-zinc-900/10">
                             <ListTodo size={48} className="mb-4 opacity-20"/>
                             <p className="text-sm font-medium">{t('tasks.emptyCat')}</p>
                             <p className="text-xs opacity-60 mt-1">...</p>
                         </div>
                     ) : (
                         currentTasks.map(task => renderCard(task))
                     )}
                 </div>
            </div>
        </div>
    );
};

export default Tasks;