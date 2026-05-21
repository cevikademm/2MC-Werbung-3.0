import React, { useState } from 'react';
import { Phone, Loader2, ShieldCheck, MessageCircle } from 'lucide-react';
import { Employee } from '../types';
import { supabase } from '../lib/supabase';
import { useLanguage } from '../lib/i18n';

interface Props {
  currentUser: Employee;
  onSaved: (updated: Employee) => void;
}

/**
 * Personel ve dual-role adminler (Apo, Malik) için zorunlu telefon numarası
 * giriş ekranı. Modal kullanıcı geçerli bir numara kaydedip butona basana
 * kadar açık kalır — kapat butonu, X tuşu, dışına tıklama ile kapanmaz.
 *
 * Açıklama metni hem Türkçe hem Almanca aynı anda gösterilir.
 */
const RequirePhoneModal: React.FC<Props> = ({ currentUser, onSaved }) => {
  const { t } = useLanguage();
  const [phone, setPhone] = useState<string>(currentUser.phone || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const digits = phone.replace(/\D/g, '');
  const isValid = digits.length >= 10; // En az 10 hane (ulusal numara)

  const handleSave = async () => {
    if (!isValid || saving) return;
    setError(null);
    setSaving(true);

    try {
      const { error: dbError } = await supabase
        .from('profiles')
        .update({ phone, updated_at: new Date().toISOString() })
        .eq('id', currentUser.id);

      if (dbError) throw dbError;

      onSaved({ ...currentUser, phone });
    } catch (e: any) {
      console.error('Telefon kaydedilemedi:', e);
      setError(e?.message || t('reqphone.errorGeneric'));
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reqphone-title"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-300"
    >
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-2xl">
        {/* Header */}
        <div className="p-6 pb-4 border-b border-slate-200 dark:border-zinc-800 bg-gradient-to-br from-emerald-500/10 to-indigo-500/10">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
              <Phone className="text-emerald-600 dark:text-emerald-400" size={22} />
            </div>
            <div>
              <h2 id="reqphone-title" className="text-lg font-bold text-slate-900 dark:text-white">
                {t('reqphone.title')}
              </h2>
              <p className="text-xs text-slate-500 dark:text-zinc-500">{t('reqphone.titleDe')}</p>
            </div>
          </div>
        </div>

        {/* Açıklama — TR + DE */}
        <div className="p-6 space-y-4">
          {/* TR */}
          <div className="rounded-xl bg-slate-50 dark:bg-zinc-950/50 border border-slate-200 dark:border-zinc-800 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-base">🇹🇷</span>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-500">Türkçe</span>
            </div>
            <p className="text-sm text-slate-700 dark:text-zinc-300 leading-relaxed">
              {t('reqphone.explainTr')}
            </p>
          </div>

          {/* DE */}
          <div className="rounded-xl bg-slate-50 dark:bg-zinc-950/50 border border-slate-200 dark:border-zinc-800 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-base">🇩🇪</span>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-500">Deutsch</span>
            </div>
            <p className="text-sm text-slate-700 dark:text-zinc-300 leading-relaxed">
              {t('reqphone.explainDe')}
            </p>
          </div>

          {/* Form */}
          <div className="space-y-2 pt-2">
            <label className="text-xs font-semibold text-slate-700 dark:text-zinc-300 flex items-center gap-2">
              <MessageCircle size={14} className="text-emerald-500" />
              {t('reqphone.label')}
            </label>
            <input
              type="tel"
              autoFocus
              inputMode="tel"
              value={phone}
              onChange={(e) => { setPhone(e.target.value); setError(null); }}
              placeholder="+49 1xx xxx xx xx / +90 5xx xxx xx xx"
              className="w-full px-4 py-3 rounded-xl bg-white dark:bg-zinc-950 border border-slate-300 dark:border-zinc-700 text-slate-900 dark:text-white text-base focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 transition-all"
              onKeyDown={(e) => { if (e.key === 'Enter' && isValid) handleSave(); }}
            />
            <p className="text-xs text-slate-500 dark:text-zinc-500">
              {t('reqphone.hint')}
            </p>
            {!isValid && phone.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                {t('reqphone.tooShort')}
              </p>
            )}
            {error && (
              <p className="text-xs text-red-600 dark:text-red-400 font-medium">{error}</p>
            )}
          </div>

          {/* Güven rozeti */}
          <div className="flex items-start gap-2 pt-1">
            <ShieldCheck size={14} className="text-slate-400 dark:text-zinc-600 mt-0.5 shrink-0" />
            <p className="text-[11px] text-slate-500 dark:text-zinc-500 leading-relaxed">
              {t('reqphone.privacyTr')}
              <br />
              <span className="opacity-75">{t('reqphone.privacyDe')}</span>
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 pt-2 border-t border-slate-200 dark:border-zinc-800 bg-slate-50 dark:bg-zinc-950/30">
          <button
            type="button"
            disabled={!isValid || saving}
            onClick={handleSave}
            className={`w-full py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all ${
              isValid && !saving
                ? 'bg-emerald-500 hover:bg-emerald-400 text-white shadow-lg shadow-emerald-900/20 active:scale-[0.98]'
                : 'bg-slate-200 dark:bg-zinc-800 text-slate-400 dark:text-zinc-600 cursor-not-allowed'
            }`}
          >
            {saving ? <Loader2 className="animate-spin" size={18} /> : <Phone size={18} />}
            <span>{t('reqphone.saveBtn')}</span>
          </button>
          <p className="text-center text-[11px] text-slate-400 dark:text-zinc-600 mt-3">
            {t('reqphone.noSkipTr')} · {t('reqphone.noSkipDe')}
          </p>
        </div>
      </div>
    </div>
  );
};

export default RequirePhoneModal;
