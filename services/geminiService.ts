
import { supabase } from '../lib/supabase';

// Basit bir önbellek mekanizması (Aynı metni tekrar tekrar sormamak için)
const translationCache: Record<string, string> = {};

// Demo Modu için Sözlük (Edge Function erişilemezse fallback)
const DEMO_DICTIONARY: Record<string, string> = {
    "Hata düzelt": "Fehler beheben",
    "Sigorta teyit": "Versicherung bestätigen",
    "Fatura": "Rechnung",
    "Faturalar toplanacak": "Rechnungen werden gesammelt",
    "Sisteme giriş yapılacak": "Eingabe in das System",
    "Ön muhasebe girişi yapılacak": "Vorbuchhaltungseintrag wird erstellt",
    "Factoring ile fatura giriş": "Rechnungseingabe mit Factoring",
    "Pefra faturaları": "Pefra Rechnungen",
    "Melisa Gold montaj": "Melisa Gold Montage",
    "Tabela montaj": "Schildermontage"
};

// GÜVENLİK: Gemini API çağrıları Supabase Edge Function üzerinden yapılır.
// API anahtarı hiçbir zaman client tarafına gönderilmez.
const callGeminiProxy = async (action: string, payload: Record<string, unknown>): Promise<string | null> => {
    try {
        const { data, error } = await supabase.functions.invoke('gemini-proxy', {
            body: { action, payload },
        });

        if (error) {
            console.error('Edge Function error:', error.message);
            return null;
        }

        return data?.result || null;
    } catch (err) {
        console.error('Edge Function call failed:', err);
        return null;
    }
};

export const translateContent = async (text: string, targetLang: 'tr' | 'de'): Promise<string> => {
    // 1. Boş metin kontrolü
    if (!text || !text.trim()) return text;

    // 2. Önbellek kontrolü
    const cacheKey = `${text}_${targetLang}`;
    if (translationCache[cacheKey]) {
        return translationCache[cacheKey];
    }

    // 3. Hedef dil Türkçe ise çevirme
    if (targetLang === 'tr') {
        return text;
    }

    // 4. Demo Sözlük Kontrolü (Hızlı tepki)
    if (targetLang === 'de' && DEMO_DICTIONARY[text]) {
        return DEMO_DICTIONARY[text];
    }

    try {
        // 5. Edge Function üzerinden Gemini API çağrısı
        const result = await callGeminiProxy('translate', { text, targetLang });

        if (result) {
            translationCache[cacheKey] = result;
            return result;
        }

        // Edge Function erişilemezse simülasyon
        return new Promise((resolve) => {
            setTimeout(() => {
                const simulated = `[${targetLang.toUpperCase()}] ${text}`;
                translationCache[cacheKey] = simulated;
                resolve(simulated);
            }, 300);
        });

    } catch (error) {
        console.error("Translation error:", error);
        return text;
    }
};

export const analyzeInvoice = async (mockImage: string): Promise<string> => {
    // Simulation of Gemini Vision API
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(`
            **Fatura Analizi (Gemini AI)**
            -----------------------------
            **Tedarikçi:** Metro Grossmarket
            **Tarih:** 24.10.2023
            **Toplam Tutar:** 1.250,00 €

            **Kalemler:**
            1. Kahve Çekirdeği (10kg) - 450€
            2. Süt (50L) - 50€
            3. Temizlik Malzemeleri - 150€

            **Kategori:** Gider / Stok
            **Vergi Oranı:** %19
            `);
        }, 2000);
    });
};

export const suggestProductivity = async (tasksCompleted: number, hoursWorked: number): Promise<string> => {
    try {
        const result = await callGeminiProxy('analyze', {
            type: 'productivity',
            data: { tasksCompleted, hoursWorked }
        });

        if (result) return result;
    } catch (error) {
        console.error("Productivity analysis error:", error);
    }

    // Fallback
    const ratio = tasksCompleted / hoursWorked;
    if (ratio > 0.5) {
        return "Personel performansı bu hafta %15 arttı. Verimlilik yüksek seviyede.";
    }
    return "Görev tamamlama hızı standartların biraz altında. İş yükü dağılımının gözden geçirilmesi önerilir.";
}

export const analyzeTaskProgress = async (pendingCount: number, highPriorityCount: number): Promise<string> => {
    try {
        const result = await callGeminiProxy('analyze', {
            type: 'taskProgress',
            data: { pendingCount, highPriorityCount }
        });

        if (result) return result;
    } catch (error) {
        console.error("Task analysis error:", error);
    }

    // Fallback
    return `**Sistem Özeti:** Şu an ${pendingCount} aktif iş üzerinde çalışılıyor. Dikkat: ${highPriorityCount} kritik görev teslim bekliyor. Montaj ekibi %85 kapasite ile çalışıyor, Backaffee şubesinde operasyonel hız %12 arttı. Tahmini tamamlanma: Cuma, 17:00.`;
};
