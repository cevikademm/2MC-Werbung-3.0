import React, { useState, useEffect } from 'react';
import { Lock, Mail, ArrowRight, Loader2, Check } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Employee, Role, Branch } from '../types';
import { useLanguage } from '../lib/i18n';
import { GlowingEffect } from './ui/glowing-effect';
import { logAuditEvent, secureStorageGet, secureStorageSet, secureStorageRemove } from '../lib/security';


interface LoginProps {
    onLogin: (user: Employee) => void;
}

const BAC_LOGO_URL = "https://wgfkoxjlcovrkzrustpy.supabase.co/storage/v1/object/public/sales_receipts/logo_werbung%20(1).png";

const Login: React.FC<LoginProps> = ({ onLogin }) => {
    // Varsayılan değerler boşaltıldı
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [rememberMe, setRememberMe] = useState(false);
    const [loading, setLoading] = useState(false);
    
    const { t } = useLanguage();

    // Sayfa yüklendiğinde güvenli localStorage kontrolü
    useEffect(() => {
        const savedEmail = secureStorageGet('remember_email');
        if (savedEmail) {
            setEmail(savedEmail);
            setRememberMe(true);
        }
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            let dbUser = null;
            try {
                // GÜVENLİK: Sadece RPC üzerinden bcrypt doğrulama - düz metin fallback kaldırıldı
                const { data, error } = await supabase
                    .rpc('verify_user_password', {
                        user_email: email,
                        user_password: password
                    })
                    .single();

                if (!error && data) {
                    dbUser = data;
                }
            } catch (dbErr) {
                // Veritabanı bağlantı hatası - güvenli hata mesajı
                alert(t('login.connectionError'));
                setLoading(false);
                return;
            }

            // GÜVENLİK: Hardcoded fallback kaldırıldı - tüm kimlik doğrulama veritabanı üzerinden yapılır

            if (dbUser) {
                // Denetim kaydı: Başarılı giriş
                logAuditEvent({
                    userId: dbUser.id,
                    userEmail: dbUser.email,
                    action: 'LOGIN_SUCCESS',
                    targetTable: 'profiles',
                    targetId: dbUser.id,
                });
                const user: Employee = {
                    id: dbUser.id,
                    name: dbUser.full_name || 'İsimsiz Kullanıcı',
                    email: dbUser.email,
                    role: (dbUser.role as Role) || Role.STAFF,
                    branch: (dbUser.branch as Branch) || Branch.DOM,
                    hourlyRate: dbUser.hourly_rate || 15.00,
                    taxClass: dbUser.tax_class || 1,
                    avatarUrl: dbUser.avatar_url || `https://ui-avatars.com/api/?name=${dbUser.full_name}`,
                    advances: dbUser.advances || 0,
                    phone: dbUser.phone || '',
                    bio: dbUser.bio || '',
                };
                
                // Başarılı girişte Beni Hatırla mantığı (güvenli localStorage)
                if (rememberMe) {
                    secureStorageSet('remember_email', email);
                } else {
                    secureStorageRemove('remember_email');
                }

                onLogin(user);
            } else {
                 // Denetim kaydı: Başarısız giriş denemesi
                 logAuditEvent({
                     userId: 'anonymous',
                     userEmail: email,
                     action: 'LOGIN_FAILED',
                     details: { reason: 'invalid_credentials' },
                 });
                 alert(t('login.invalidCredentials'));
            }
        } catch (err) {
            alert(t('login.genericError'));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 w-full h-full bg-slate-50 dark:bg-zinc-950 overflow-hidden z-[9999]">
             <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-indigo-900/10 rounded-full blur-3xl pointer-events-none"></div>
             <div className="absolute bottom-[-20%] right-[-10%] w-[600px] h-[600px] bg-blue-900/10 rounded-full blur-3xl pointer-events-none"></div>

             <div className="absolute inset-0 w-full h-full overflow-y-auto custom-scrollbar">
                 <div className="min-h-full w-full flex items-center justify-center p-4">
                     <div className="w-full max-w-md relative z-10 my-8">
                        <div className="text-center mb-10">
                            <div className="inline-flex items-center justify-center w-32 h-32 rounded-2xl bg-transparent mb-6 drop-shadow-[0_8px_30px_rgba(38,40,112,0.35)]">
                                 <img
                                    src="/logo4.png"
                                    alt="2MC Werbung Logo"
                                    className="w-full h-full object-contain"
                                    referrerPolicy="no-referrer"
                                 />
                            </div>
                            <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-2 tracking-tight">{t('login.title')}</h1>
                            <p className="text-slate-500 dark:text-zinc-500">{t('login.subtitle')}</p>
                        </div>

                        <div className="glass-panel p-8 rounded-2xl border border-slate-200 dark:border-zinc-800 shadow-2xl bg-white dark:bg-zinc-900/50 backdrop-blur-md relative">
<GlowingEffect spread={40} glow={true} disabled={false} proximity={64} inactiveZone={0.01} />
                            <form onSubmit={handleSubmit} className="space-y-6">
                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400 ml-1">{t('login.email')}</label>
                                    <div className="relative">
                                        <Mail className="absolute left-3 top-3 text-slate-500 dark:text-zinc-500 w-5 h-5" />
                                        <input 
                                            type="email" 
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            className="w-full bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl py-3 pl-10 pr-4 text-slate-900 dark:text-white placeholder:text-slate-400 dark:text-zinc-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all"
                                            placeholder="ornek@mail.com"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-xs font-medium text-slate-600 dark:text-zinc-400 ml-1">{t('login.password')}</label>
                                    <div className="relative">
                                        <Lock className="absolute left-3 top-3 text-slate-500 dark:text-zinc-500 w-5 h-5" />
                                        <input 
                                            type="password" 
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            className="w-full bg-white dark:bg-zinc-900/50 border border-slate-200 dark:border-zinc-800 rounded-xl py-3 pl-10 pr-4 text-slate-900 dark:text-white placeholder:text-slate-400 dark:text-zinc-600 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition-all"
                                            placeholder="••••••••"
                                        />
                                    </div>
                                </div>

                                {/* Beni Hatırla Alanı */}
                                <div 
                                    className="flex items-center gap-2 cursor-pointer group w-fit"
                                    onClick={() => setRememberMe(!rememberMe)}
                                >
                                    <div className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${rememberMe ? 'bg-indigo-600 border-indigo-500' : 'bg-white dark:bg-zinc-900 border-slate-300 dark:border-zinc-700 group-hover:border-zinc-500'}`}>
                                        {rememberMe && <Check size={14} className="text-slate-900 dark:text-white" />}
                                    </div>
                                    <span className={`text-sm select-none transition-colors ${rememberMe ? 'text-indigo-400' : 'text-slate-500 dark:text-zinc-500 group-hover:text-slate-600 dark:hover:text-slate-600 dark:text-zinc-400'}`}>
                                        {t('layout.rememberMe')}
                                    </span>
                                </div>

                                <button 
                                    type="submit" 
                                    disabled={loading}
                                    className="w-full py-4 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-slate-900 dark:text-white font-bold rounded-xl shadow-lg shadow-indigo-900/20 flex items-center justify-center gap-2 group transition-all active:scale-95"
                                >
                                    {loading ? <Loader2 className="animate-spin" size={20} /> : <span className="flex items-center gap-2">{t('login.btn')} <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" /></span>}
                                </button>
                            </form>
                        </div>

                        <p className="text-center text-xs text-slate-400 dark:text-zinc-600 mt-8">
                            &copy; 2026 2MC Werbung Management System
                        </p>
                     </div>
                 </div>
             </div>
        </div>
    );
};

export default Login;