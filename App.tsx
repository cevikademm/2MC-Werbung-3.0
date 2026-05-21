import React, { useState, useEffect, Suspense } from 'react';
import { lazyWithRetry } from './lib/lazyWithRetry';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import Messages from './components/Messages';
import Tasks from './components/Tasks';
import Calendar from './components/Calendar';
import ShiftSchedule from './components/ShiftSchedule';
import Payroll from './components/Payroll';
import Login from './components/Login';
import SalesDashboard from './components/SalesDashboard';
import LossControl from './components/LossControl';
import DeviceBrands from './components/DeviceBrands';
import LiveLocationTracker from './components/LiveLocationTracker';
import RequirePhoneModal from './components/RequirePhoneModal';
import PWAInstallBanner, { PushSubscriptionCard } from './components/PWAInstallBanner';
import NotificationPreferencesCard from './components/NotificationPreferencesCard';
import { DeviceHistoryCard, PhoneConflictsCard } from './components/DeviceTrustCard';
import { canSeeMap } from './lib/geofence';
import { canSeeDeviceInfo } from './lib/utils';

// Lazy: zxing/browser top-level import'u prod minify'da bozuluyordu
// lazyWithRetry: yeni deployment sonrası eski hash'li chunk için MIME hatasında auto-recover
const QrCheckIn = lazyWithRetry(() => import('./components/QrCheckIn'));
// Lazy: Leaflet+react-leaflet ~140kB; harita sekmesine girilene dek yüklenmesin
const Map = lazyWithRetry(() => import('./components/Map'));
import { Settings as SettingsIcon, Shield, Volume2, Upload, RefreshCw, Play, Loader2, KeyRound, Globe, Lock, Server, CheckCircle, Sun, Moon } from 'lucide-react';
import { MOCK_EMPLOYEES, NOTIFICATION_SOUND, isDualRoleAdmin } from './constants';
import { Employee, Role, AppNotification } from './types';
import { supabase } from './lib/supabase';
import { LanguageProvider, useLanguage } from './lib/i18n';
import { ThemeProvider, useTheme } from './lib/theme';
import { validateFile, logAuditEvent, sanitizeInput, initProductionGuard } from './lib/security';

// Üretim modunda konsol çıktılarını koru
initProductionGuard();

// Fallback Settings Component
const Settings = ({ currentUser, onUpdateUser }: { currentUser: Employee | null, onUpdateUser?: (user: Employee) => void }) => {
    const [soundLoading, setSoundLoading] = useState(false);
    const [hasCustomSound, setHasCustomSound] = useState(false);
    const { language, setLanguage, t } = useLanguage();
    const { theme, setTheme } = useTheme();

    // Password State
    const [passForm, setPassForm] = useState({ current: '', new: '', confirm: '' });
    const [passLoading, setPassLoading] = useState(false);

    // Admin Password Reset State
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
    const [resetLoading, setResetLoading] = useState(false);

    // Avatar Upload State
    const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);

    const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !currentUser) return;

        // GÜVENLİK: Dosya tipi, uzantı ve boyut doğrulaması
        const validation = validateFile(file, 'image');
        if (!validation.valid) {
            alert(validation.error);
            return;
        }

        setIsUploadingAvatar(true);
        try {
            const fileExt = validation.safeExtension;
            const fileName = `${currentUser.id}-${crypto.randomUUID()}.${fileExt}`;
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

    useEffect(() => {
        // Bileşen yüklendiğinde kayıtlı özel ses var mı kontrol et
        const stored = localStorage.getItem('custom_notification_sound');
        setHasCustomSound(!!stored);
    }, []);

    useEffect(() => {
        if (currentUser?.role === Role.ADMIN) {
            const fetchEmployees = async () => {
                try {
                    const { data, error } = await supabase
                        .from('profiles')
                        .select('*')
                        .neq('id', currentUser.id)
                        .order('full_name');

                    if (error) throw error;
                    if (data) {
                        const mapped = data.map(d => ({
                            id: d.id,
                            name: d.full_name || d.email || 'İsimsiz',
                            email: d.email,
                            role: d.role as Role,
                            branch: d.branch,
                            hourlyRate: d.hourly_rate,
                            taxClass: d.tax_class,
                            avatarUrl: d.avatar_url,
                            advances: d.advances,
                            phone: d.phone,
                            bio: d.bio,
                        }));
                        setEmployees(mapped);
                    }
                } catch (err) {
                    console.error("Personel listesi çekilemedi:", err);
                }
            };
            fetchEmployees();
        }
    }, [currentUser]);

    const handleAdminPasswordReset = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedEmployeeId) {
            alert(t('app.selectStaff'));
            return;
        }

        if (!window.confirm(t('app.confirmResetOne'))) {
            return;
        }

        setResetLoading(true);
        try {
            // Doğrudan profiles tablosunu güncelle (Admin RLS politikası ile)
            const { error } = await supabase
                .from('profiles')
                .update({ password: 'Bac123+', updated_at: new Date().toISOString() })
                .eq('id', selectedEmployeeId);

            if (error) throw error;

            // Denetim kaydı oluştur
            logAuditEvent({
                userId: currentUser?.id || '',
                userEmail: currentUser?.email || '',
                action: 'ADMIN_PASSWORD_RESET',
                targetTable: 'profiles',
                targetId: selectedEmployeeId,
                details: { reset_by: currentUser?.name },
            });

            alert(t('app.resetOneOk'));
            setSelectedEmployeeId('');
        } catch (err) {
            console.error("Şifre sıfırlama hatası:", err);
            alert(t('app.resetOneError') + (err as Error).message);
        } finally {
            setResetLoading(false);
        }
    };

    const handleResetAllPasswords = async () => {
        if (!window.confirm(t('app.confirmResetAll'))) {
            return;
        }
        if (!window.confirm(t('app.confirmResetAll2'))) {
            return;
        }

        setResetLoading(true);
        try {
            const { error } = await supabase
                .from('profiles')
                .update({ password: 'Bac123+', updated_at: new Date().toISOString() })
                .neq('id', currentUser?.id || '');

            if (error) throw error;

            logAuditEvent({
                userId: currentUser?.id || '',
                userEmail: currentUser?.email || '',
                action: 'ADMIN_PASSWORD_RESET',
                targetTable: 'profiles',
                targetId: 'ALL_USERS',
                details: { reset_by: currentUser?.name, scope: 'all' },
            });

            alert(t('app.resetAllOk'));
        } catch (err) {
            console.error("Toplu şifre sıfırlama hatası:", err);
            alert(t('app.resetAllError') + (err as Error).message);
        } finally {
            setResetLoading(false);
        }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('audio/')) {
            alert(t('app.fileTypeError'));
            return;
        }

        if (file.size > 1 * 1024 * 1024) {
            alert(t('app.fileTooBig'));
            return;
        }

        setSoundLoading(true);

        const reader = new FileReader();
        reader.onload = async (event) => {
            const base64 = event.target?.result as string;
            
            try {
                localStorage.setItem('custom_notification_sound', base64);
                
                if (currentUser) {
                    try {
                        await supabase.from('profiles').update({ custom_sound_enabled: true }).eq('id', currentUser.id);
                    } catch (dbErr) {
                        console.warn("Supabase kayıt hatası (Kritik değil):", dbErr);
                    }
                }

                setHasCustomSound(true);
                const audio = new Audio(base64);
                audio.volume = 0.5;
                audio.play().catch(e => console.warn("Otomatik oynatma engellendi:", e)); 
                alert(t('app.soundSaved'));
            } catch (err) {
                alert(t('app.soundProcessError'));
                console.error(err);
            } finally {
                setSoundLoading(false);
            }
        };
        reader.readAsDataURL(file);
    };

    const handleResetSound = () => {
        localStorage.removeItem('custom_notification_sound');
        setHasCustomSound(false);
        try {
            const audio = new Audio(NOTIFICATION_SOUND);
            audio.volume = 0.5;
            audio.play().catch(() => {});
        } catch (e) {
            console.error("Varsayılan ses çalma hatası:", e);
        }
    };

    const handleTestSound = () => {
        try {
            const src = localStorage.getItem('custom_notification_sound') || NOTIFICATION_SOUND;
            const audio = new Audio(src);
            audio.volume = 0.5;
            audio.play().catch(e => {
                console.error("Ses çalma hatası:", e);
                alert(t('app.soundPlayError'));
            });
        } catch (error) {
            alert(t('app.soundFileBroken'));
        }
    };

    const handlePasswordUpdate = async (e: React.FormEvent) => {
        e.preventDefault();
        
        if (!passForm.current || !passForm.new || !passForm.confirm) {
            alert(t('app.passFillAll'));
            return;
        }

        if (passForm.new !== passForm.confirm) {
            alert(t('app.passNoMatch'));
            return;
        }

        if (passForm.new.length < 6) {
            alert(t('app.passMinLen'));
            return;
        }

        if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(passForm.new)) {
            alert(t('app.passComplexity'));
            return;
        }

        setPassLoading(true);

        try {
            // GÜVENLİK: Güvenli RPC ile bcrypt şifre güncelleme
            if (currentUser) {
                const { data, error } = await supabase.rpc('update_user_password', {
                    p_user_id: currentUser.id,
                    p_current_password: passForm.current,
                    p_new_password: passForm.new,
                });

                if (error) throw error;

                if (data === false) {
                    alert(t('app.passCurrentWrong'));
                    setPassLoading(false);
                    return;
                }

                alert(t('app.passUpdated'));
                setPassForm({ current: '', new: '', confirm: '' });
            }
        } catch (err: any) {
            console.error("Password update error:", err);
            alert(t('app.passUpdateError') + (err?.message || JSON.stringify(err)));
        } finally {
            setPassLoading(false);
        }
    };

    // UPDATE: Settings container now fills height and scrolls internally
    // Added pb-32 to prevent content being hidden behind mobile nav
    return (
        <div className="h-full w-full overflow-y-auto custom-scrollbar p-4 md:p-8 pb-32">
            <div className="max-w-4xl mx-auto">
                <h2 className="text-3xl font-bold text-slate-900 dark:text-white mb-8">{t('set.title')}</h2>
                
                <div className="grid gap-6">
                    
                    {/* AVATAR UPLOAD SETTINGS */}
                    <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
                        <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                            <Upload size={20} className="text-pink-500"/>
                            {t('set.profilePhoto')}
                        </h3>
                        <div className="bg-white dark:bg-zinc-900 rounded-lg p-4 border border-slate-200 dark:border-zinc-800/50 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                            <div className="flex items-center gap-4">
                                <div className="w-16 h-16 rounded-full overflow-hidden bg-slate-100 dark:bg-zinc-800 border-2 border-slate-300 dark:border-zinc-700">
                                    {currentUser?.avatarUrl ? (
                                        <img src={currentUser.avatarUrl} alt="Avatar" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-slate-500 dark:text-zinc-500">?</div>
                                    )}
                                </div>
                                <div>
                                    <p className="text-slate-800 dark:text-zinc-200 text-sm font-medium mb-1">
                                        {t('set.updatePhotoTitle')}
                                    </p>
                                    <p className="text-xs text-slate-500 dark:text-zinc-500">
                                        {t('set.updatePhotoHint')}
                                    </p>
                                </div>
                            </div>
                            
                            <div className="flex items-center gap-2 w-full md:w-auto">
                                <label className={`flex-1 md:flex-none cursor-pointer px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-slate-900 dark:text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 shadow-lg shadow-indigo-900/20 ${isUploadingAvatar ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                    {isUploadingAvatar ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                                    <span>{isUploadingAvatar ? t('common.loading') : t('set.uploadPhoto')}</span>
                                    <input type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} disabled={isUploadingAvatar} />
                                </label>
                            </div>
                        </div>
                    </div>

                    {/* LANGUAGE SETTINGS */}
                    <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
                        <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                            <Globe size={20} className="text-blue-500"/>
                            {t('set.language')}
                        </h3>
                        <div className="bg-white dark:bg-zinc-900 rounded-lg p-1.5 border border-slate-200 dark:border-zinc-800/50 inline-flex gap-1">
                            <button 
                                onClick={() => setLanguage('tr')}
                                className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${language === 'tr' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                            >
                                🇹🇷 Türkçe
                            </button>
                            <button
                                onClick={() => setLanguage('de')}
                                className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${language === 'de' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                            >
                                🇩🇪 Deutsch
                            </button>
                        </div>
                    </div>

                    {/* THEME SETTINGS */}
                    <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
                        <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                            {theme === 'dark' ? <Moon size={20} className="text-indigo-400"/> : <Sun size={20} className="text-amber-500"/>}
                            {t('set.theme')}
                        </h3>
                        <div className="bg-white dark:bg-zinc-900 rounded-lg p-1.5 border border-slate-200 dark:border-zinc-800/50 inline-flex gap-1">
                            <button
                                onClick={() => setTheme('dark')}
                                className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${theme === 'dark' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                            >
                                <Moon size={14} /> {t('set.themeDark')}
                            </button>
                            <button
                                onClick={() => setTheme('light')}
                                className={`px-4 py-2 rounded-md text-sm font-medium transition-all flex items-center gap-2 ${theme === 'light' ? 'bg-slate-100 dark:bg-zinc-800 text-slate-900 dark:text-white shadow' : 'text-slate-500 dark:text-zinc-500 hover:text-slate-700 dark:hover:text-slate-700 dark:text-zinc-300'}`}
                            >
                                <Sun size={14} /> {t('set.themeLight')}
                            </button>
                        </div>
                    </div>

                    {/* NOTIFICATION SOUND SETTINGS */}
                    <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
                        <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                            <Volume2 size={20} className="text-amber-500"/>
                            {t('set.sound')}
                        </h3>
                        <div className="bg-white dark:bg-zinc-900 rounded-lg p-4 border border-slate-200 dark:border-zinc-800/50 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                            <div>
                                <p className="text-slate-800 dark:text-zinc-200 text-sm font-medium mb-1">
                                    {hasCustomSound ? t('set.soundDesc') : t('set.soundDef')}
                                </p>
                                <p className="text-xs text-slate-500 dark:text-zinc-500">
                                    {hasCustomSound 
                                        ? t('set.soundInfo')
                                        : t('set.soundDefInfo')}
                                </p>
                            </div>
                            
                            <div className="flex items-center gap-2 w-full md:w-auto">
                                <button 
                                    onClick={handleTestSound}
                                    className="p-2.5 bg-slate-100 dark:bg-zinc-800 hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 rounded-lg transition-colors border border-slate-300 dark:border-zinc-700"
                                    title={t('set.test')}
                                >
                                    <Play size={16} />
                                </button>
                                
                                <label className={`flex-1 md:flex-none cursor-pointer px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-slate-900 dark:text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 shadow-lg shadow-indigo-900/20 ${soundLoading ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                    {soundLoading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                                    <span>{soundLoading ? t('common.loading') : t('set.upload')}</span>
                                    <input type="file" accept="audio/*" className="hidden" onChange={handleFileUpload} disabled={soundLoading} />
                                </label>

                                {hasCustomSound && (
                                    <button 
                                        onClick={handleResetSound}
                                        className="p-2.5 bg-slate-100 dark:bg-zinc-800 hover:bg-red-900/30 text-slate-600 dark:text-zinc-400 hover:text-red-400 border border-slate-300 dark:border-zinc-700 hover:border-red-900/50 rounded-lg transition-all"
                                        title={t('set.reset')}
                                    >
                                        <RefreshCw size={16} />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* PUSH NOTIFICATION SUBSCRIPTION (PWA) */}
                    <PushSubscriptionCard userId={currentUser?.id} />

                    {/* NOTIFICATION PREFERENCES (Admin only) */}
                    <NotificationPreferencesCard currentUser={currentUser} />

                    {/* TELEFON GEÇMİŞİ + ÇAKIŞMALARI — yalnızca cevikademm@gmail.com (Admin).
                        Diğer kullanıcılar (admin dahil) bu iki kartı göremez. */}
                    {currentUser?.role === Role.ADMIN
                      && currentUser?.email?.trim().toLowerCase() === 'cevikademm@gmail.com' && (
                      <>
                        <DeviceHistoryCard currentUser={currentUser} />
                        <PhoneConflictsCard currentUser={currentUser} />
                      </>
                    )}

                    {/* PASSWORD CHANGE SECTION */}
                    <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
                        <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                            <KeyRound size={20} className="text-indigo-500"/>
                            {t('set.password')}
                        </h3>
                        <p className="text-sm text-slate-600 dark:text-zinc-400 mb-6">{t('set.passDesc')}</p>
                        
                        <form onSubmit={handlePasswordUpdate} className="space-y-4 max-w-lg">
                            <div className="space-y-2">
                                <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">{t('set.currentPass')}</label>
                                <input 
                                    type="password" 
                                    value={passForm.current}
                                    onChange={(e) => setPassForm({...passForm, current: e.target.value})}
                                    className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-slate-900 dark:text-white focus:border-indigo-500 outline-none transition-all placeholder:text-zinc-700"
                                    placeholder="••••••••"
                                />
                            </div>
                            
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">{t('set.newPass')}</label>
                                    <input 
                                        type="password" 
                                        value={passForm.new}
                                        onChange={(e) => setPassForm({...passForm, new: e.target.value})}
                                        className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-slate-900 dark:text-white focus:border-indigo-500 outline-none transition-all placeholder:text-zinc-700"
                                        placeholder={t('set.passMin6')}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">{t('set.confirmPass')}</label>
                                    <input 
                                        type="password" 
                                        value={passForm.confirm}
                                        onChange={(e) => setPassForm({...passForm, confirm: e.target.value})}
                                        className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-slate-900 dark:text-white focus:border-indigo-500 outline-none transition-all placeholder:text-zinc-700"
                                        placeholder="••••••••"
                                    />
                                </div>
                            </div>

                            <div className="pt-2">
                                <button 
                                    type="submit" 
                                    disabled={passLoading}
                                    className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-slate-900 dark:text-white rounded-xl text-sm font-medium transition-colors shadow-lg shadow-indigo-900/20 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {passLoading ? <Loader2 size={16} className="animate-spin" /> : t('set.update')}
                                </button>
                            </div>
                        </form>
                    </div>

                    {/* ADMIN PASSWORD RESET SECTION */}
                    {currentUser?.role === Role.ADMIN && (
                        <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
                            <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                                <Shield size={20} className="text-red-500"/>
                                {t('set.staffPwReset')}
                            </h3>
                            <p className="text-sm text-slate-600 dark:text-zinc-400 mb-6">
                                {t('set.staffPwResetDesc')}
                            </p>
                            
                            <form onSubmit={handleAdminPasswordReset} className="space-y-4 max-w-lg">
                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400">{t('set.staffSelectLabel')}</label>
                                    <select 
                                        value={selectedEmployeeId}
                                        onChange={(e) => setSelectedEmployeeId(e.target.value)}
                                        className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-slate-900 dark:text-white focus:border-indigo-500 outline-none transition-all"
                                    >
                                        <option value="">{t('set.staffSelectPlaceholder')}</option>
                                        {employees.map(emp => (
                                            <option key={emp.id} value={emp.id}>{emp.name}{emp.role ? ` - ${emp.role}` : ''}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="pt-2 flex items-center gap-3">
                                    <button
                                        type="submit"
                                        disabled={resetLoading || !selectedEmployeeId}
                                        className="px-6 py-2.5 bg-red-600 hover:bg-red-500 text-slate-900 dark:text-white rounded-xl text-sm font-medium transition-colors shadow-lg shadow-red-900/20 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {resetLoading ? <Loader2 size={16} className="animate-spin" /> : t('set.resetPasswordBtn')}
                                    </button>
                                </div>
                            </form>

                            <div className="mt-6 pt-6 border-t border-slate-200 dark:border-zinc-800">
                                <p className="text-xs text-slate-500 dark:text-zinc-500 mb-3">{t('set.resetAllInfo')}</p>
                                <button
                                    onClick={handleResetAllPasswords}
                                    disabled={resetLoading}
                                    className="px-6 py-2.5 bg-orange-600 hover:bg-orange-500 text-slate-900 dark:text-white rounded-xl text-sm font-medium transition-colors shadow-lg shadow-orange-900/20 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {resetLoading ? <Loader2 size={16} className="animate-spin" /> : t('set.resetAllBtn')}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* SECURITY & CERTIFICATES */}
                    <div className="bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl p-6">
                        <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                            <Shield size={20} className="text-emerald-500"/>
                            {t('set.security') || t('set.securityFallback')}
                        </h3>
                        <p className="text-sm text-slate-600 dark:text-zinc-400 mb-6 font-medium">
                            {t('set.securityIntro')}
                        </p>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* RLS */}
                            <div className="flex flex-col p-4 bg-white dark:bg-zinc-900/80 rounded-xl border border-slate-200 dark:border-zinc-800/50 gap-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-slate-800 dark:text-zinc-200 text-sm font-semibold flex items-center gap-2">
                                        <Lock size={16} className="text-indigo-400" />
                                        RLS (Row Level Security)
                                    </span>
                                    <span className="px-2 py-1 bg-emerald-900/20 text-emerald-400 text-xs rounded border border-emerald-900/30 font-medium">{t('set.rlsActive')}</span>
                                </div>
                                <span className="text-xs text-slate-500 dark:text-zinc-500">{t('set.rlsDesc')}</span>
                            </div>
                            
                            {/* Database Encryption */}
                            <div className="flex flex-col p-4 bg-white dark:bg-zinc-900/80 rounded-xl border border-slate-200 dark:border-zinc-800/50 gap-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-slate-800 dark:text-zinc-200 text-sm font-semibold flex items-center gap-2">
                                        <Server size={16} className="text-blue-400" />
                                        {t('set.dbEnc') || t('set.dbEncFallback')}
                                    </span>
                                    <span className="px-2 py-1 bg-emerald-900/20 text-emerald-400 text-xs rounded border border-emerald-900/30 font-medium">AES-256</span>
                                </div>
                                <span className="text-xs text-slate-500 dark:text-zinc-500">{t('set.dbEncDesc')}</span>
                            </div>

                            {/* SSL Certificate */}
                            <div className="flex flex-col p-4 bg-white dark:bg-zinc-900/80 rounded-xl border border-slate-200 dark:border-zinc-800/50 gap-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-slate-800 dark:text-zinc-200 text-sm font-semibold flex items-center gap-2">
                                        <Globe size={16} className="text-emerald-400" />
                                        {t('set.sslTitle')}
                                    </span>
                                    <span className="px-2 py-1 bg-emerald-900/20 text-emerald-400 text-xs rounded border border-emerald-900/30 font-medium">{t('set.sslValid')}</span>
                                </div>
                                <span className="text-xs text-slate-500 dark:text-zinc-500">{t('set.sslDesc')}</span>
                            </div>

                            {/* GDPR / KVKK Compliance */}
                            <div className="flex flex-col p-4 bg-white dark:bg-zinc-900/80 rounded-xl border border-slate-200 dark:border-zinc-800/50 gap-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-slate-800 dark:text-zinc-200 text-sm font-semibold flex items-center gap-2">
                                        <CheckCircle size={16} className="text-purple-400" />
                                        {t('set.complianceTitle')}
                                    </span>
                                    <span className="px-2 py-1 bg-emerald-900/20 text-emerald-400 text-xs rounded border border-emerald-900/30 font-medium">GDPR / KVKK</span>
                                </div>
                                <span className="text-xs text-slate-500 dark:text-zinc-500">{t('set.complianceDesc')}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

const AppContent: React.FC = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState<Employee | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  
  const [activeTab, setActiveTabState] = useState('dashboard');
  const { t } = useLanguage();
  
  // ADMIN MESAJLARINI DINLEME (Global)
  useEffect(() => {
    if (!currentUser) return;

    // GÜVENLİK: Realtime abonelik filtrelemesi - sadece ilgili mesajları dinle
    const channel = supabase.channel(`user-alerts-${currentUser.id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${currentUser.id}` }, async (payload) => {
            try {
                const newMsg = payload.new;
                
                // Mesaj bana mı geldi veya Herkese mi?
                if (newMsg.receiver_id === currentUser.id || newMsg.receiver_id === 'ALL') {
                    // Gönderen ID'sinden rolünü kontrol et
                    const { data: senderProfile } = await supabase
                        .from('profiles')
                        .select('role, full_name')
                        .eq('id', newMsg.sender_id)
                        .single();
                    
                    // Eğer gönderen Admin ise, ALERT bildirimi oluştur
                    if (senderProfile && senderProfile.role === Role.ADMIN) {
                         addNotification({
                             id: `admin_msg_${newMsg.id}`,
                             type: 'ALERT',
                             title: t('dash.adminAlert'),
                             message: `${senderProfile.full_name}: ${newMsg.content.substring(0, 50)}${newMsg.content.length > 50 ? '...' : ''}`,
                             timestamp: new Date().toISOString(),
                             recipientId: currentUser.id
                         });
                    }
                }
            } catch (e) {
                console.error("Notification processing error:", e);
            }
        })
        .subscribe();

    return () => {
        supabase.removeChannel(channel);
    };
  }, [currentUser, t]);

  useEffect(() => {
      const handleHashChange = () => {
          const hash = window.location.hash.replace('#', '');
          if (hash) {
              setActiveTabState(hash);
          } else {
              setActiveTabState('dashboard');
              window.location.hash = 'dashboard';
          }
      };
      handleHashChange();
      window.addEventListener('hashchange', handleHashChange);
      return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const setActiveTab = (tab: string) => {
      window.location.hash = tab;
      setActiveTabState(tab);
  };
  
  const handleLogin = (user: Employee) => {
      setCurrentUser(user);
      setIsAuthenticated(true);
      // KESİN YÖNLENDİRME: Giriş yapınca dashboard'a at
      setActiveTabState('dashboard');
      window.location.hash = 'dashboard';
  };

  const handleLogout = () => {
      setIsAuthenticated(false);
      setCurrentUser(null);
      window.location.hash = '';
  };

  const addNotification = (notif: AppNotification) => {
      setNotifications(prev => [notif, ...prev]);
      try {
          const customSound = localStorage.getItem('custom_notification_sound');
          const src = customSound || NOTIFICATION_SOUND;
          if (src) {
              const audio = new Audio(src);
              audio.volume = 0.5;
              audio.play().catch(err => console.log('Audio playback blocked or failed:', err));
          }
      } catch (e) {
          console.error('Error handling notification sound:', e);
      }
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard notifications={notifications} currentUser={currentUser || MOCK_EMPLOYEES[0]} onUpdateUser={setCurrentUser} />;
      case 'messages':
        return <Messages currentUser={currentUser || MOCK_EMPLOYEES[0]} />;
      case 'tasks':
        return <Tasks currentUser={currentUser || MOCK_EMPLOYEES[0]} />;
      case 'calendar':
        return <Calendar currentUser={currentUser || MOCK_EMPLOYEES[0]} />;
      case 'shifts':
        // MODIFIED: Pass currentUser to ShiftSchedule
        return <ShiftSchedule currentUser={currentUser || MOCK_EMPLOYEES[0]} />;
      case 'payroll':
        return <Payroll currentUser={currentUser || MOCK_EMPLOYEES[0]} onNotify={addNotification} />;
      case 'qr':
        return (
          <Suspense fallback={<div className="p-12 flex items-center justify-center text-slate-600 dark:text-zinc-400"><Loader2 className="animate-spin mr-2" size={20}/> {t('common.loading')}</div>}>
            <QrCheckIn currentUser={currentUser || MOCK_EMPLOYEES[0]} />
          </Suspense>
        );
      // NEW ROUTE
      case 'sales':
        return <SalesDashboard currentUser={currentUser || MOCK_EMPLOYEES[0]} />;
      case 'loss-control':
        // Kayıp Önleme yalnızca admin rolüne açık. Personel doğrudan
        // hash ile gelse bile dashboard'a düşürülür.
        if (currentUser?.role !== Role.ADMIN) {
          return <Dashboard notifications={notifications} currentUser={currentUser || MOCK_EMPLOYEES[0]} onUpdateUser={setCurrentUser} />;
        }
        return <LossControl currentUser={currentUser || MOCK_EMPLOYEES[0]} />;
      case 'map':
        // Harita admin'ler + canSeeMap whitelist'indeki email'lere açık.
        if (!canSeeMap(currentUser?.email, currentUser?.role)) {
          return <Dashboard notifications={notifications} currentUser={currentUser || MOCK_EMPLOYEES[0]} onUpdateUser={setCurrentUser} />;
        }
        return (
          <Suspense fallback={<div className="flex items-center justify-center h-full text-slate-600 dark:text-zinc-400 text-sm">Harita yükleniyor…</div>}>
            <Map currentUser={currentUser || MOCK_EMPLOYEES[0]} />
          </Suspense>
        );
      case 'device-brands':
        // Cihaz markaları sadece admin + canSeeDeviceInfo allowlist'ine açık.
        if (currentUser?.role !== Role.ADMIN || !canSeeDeviceInfo(currentUser?.email)) {
          return <Dashboard notifications={notifications} currentUser={currentUser || MOCK_EMPLOYEES[0]} onUpdateUser={setCurrentUser} />;
        }
        return <DeviceBrands currentUser={currentUser || MOCK_EMPLOYEES[0]} />;
      case 'settings':
        return <Settings currentUser={currentUser} onUpdateUser={setCurrentUser} />;
      default:
        return <Dashboard notifications={notifications} currentUser={currentUser || MOCK_EMPLOYEES[0]} onUpdateUser={setCurrentUser} />;
    }
  };

  if (!isAuthenticated) {
      return <Login onLogin={handleLogin} />;
  }

  // Zorunlu telefon gate'i:
  // - Personel (role !== ADMIN)
  // - Dual-role adminler (Apo, Malik)
  // Telefon alanı boş veya 8 haneden kısa ise modal kapanmaz, başka hiçbir
  // ekrana geçilemez. "Gerçek" adminler (cevikademm vb.) muaftır çünkü
  // numara sahibi zaten kendileridir.
  const phoneDigits = (currentUser?.phone || '').replace(/\D/g, '');
  const requiresPhoneEntry = !!currentUser
      && (currentUser.role !== Role.ADMIN || isDualRoleAdmin(currentUser))
      && phoneDigits.length < 10;

  return (
    <>
      <Layout
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        userId={currentUser?.id}
        userRole={currentUser?.role === Role.ADMIN ? t('app.adminTitle') : t('app.staffTitle')}
        userName={currentUser?.name || t('app.unnamedUser')}
        userAvatar={currentUser?.avatarUrl}
        userEmail={currentUser?.email}
        onLogout={handleLogout}
      >
        {renderContent()}
      </Layout>
      <PWAInstallBanner userId={currentUser?.id} />
      <LiveLocationTracker currentUser={currentUser} />
      {requiresPhoneEntry && currentUser && (
        <RequirePhoneModal
          currentUser={currentUser}
          onSaved={(updated) => setCurrentUser(updated)}
        />
      )}
    </>
  );
};

// Main App Wrapper for Provider
const App: React.FC = () => {
    return (
        <ThemeProvider>
            <LanguageProvider>
                <AppContent />
            </LanguageProvider>
        </ThemeProvider>
    );
};

export default App;