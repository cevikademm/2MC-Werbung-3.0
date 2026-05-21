/**
 * BAC Handels - Güvenlik Yardımcı Fonksiyonları
 * Input sanitization, dosya doğrulama, güvenli localStorage ve audit logging
 */

import { supabase } from './supabase';

// ============================================================
// INPUT SANİTİZASYONU
// ============================================================

const DANGEROUS_PATTERNS = [
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /javascript:/gi,
  /on\w+\s*=/gi,
  /data:\s*text\/html/gi,
  /<iframe/gi,
  /<object/gi,
  /<embed/gi,
  /<form/gi,
];

/** Kullanıcı girdisini XSS'e karşı temizler */
export function sanitizeInput(input: string): string {
  if (!input || typeof input !== 'string') return '';

  let sanitized = input.trim();

  // HTML entity encoding
  sanitized = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

  // Tehlikeli pattern'leri temizle
  for (const pattern of DANGEROUS_PATTERNS) {
    sanitized = sanitized.replace(pattern, '');
  }

  return sanitized;
}

/** HTML entity'leri geri çözer (güvenli gösterim için) */
export function unescapeForDisplay(input: string): string {
  if (!input) return '';
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

// ============================================================
// DOSYA DOĞRULAMA
// ============================================================

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3'];
const ALLOWED_AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg'];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

interface FileValidationResult {
  valid: boolean;
  error?: string;
  safeExtension?: string;
}

/** Yüklenen dosyayı doğrular (tip, uzantı, boyut) */
export function validateFile(file: File, type: 'image' | 'audio'): FileValidationResult {
  // Boyut kontrolü
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `Dosya boyutu çok büyük (Max ${MAX_FILE_SIZE / 1024 / 1024}MB).` };
  }

  const extension = file.name.split('.').pop()?.toLowerCase();

  if (!extension) {
    return { valid: false, error: 'Dosya uzantısı bulunamadı.' };
  }

  if (type === 'image') {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      return { valid: false, error: 'Geçersiz resim formatı. İzin verilenler: JPG, PNG, GIF, WEBP' };
    }
    if (!ALLOWED_IMAGE_EXTENSIONS.includes(extension)) {
      return { valid: false, error: 'Geçersiz dosya uzantısı.' };
    }
  } else if (type === 'audio') {
    if (!ALLOWED_AUDIO_TYPES.includes(file.type)) {
      return { valid: false, error: 'Geçersiz ses formatı. İzin verilenler: MP3, WAV, OGG' };
    }
    if (!ALLOWED_AUDIO_EXTENSIONS.includes(extension)) {
      return { valid: false, error: 'Geçersiz dosya uzantısı.' };
    }
  }

  return { valid: true, safeExtension: extension };
}

// ============================================================
// GÜVENLİ localStorage
// ============================================================

const STORAGE_PREFIX = 'bac_';

/** Güvenli localStorage yazma */
export function secureStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
  } catch (e) {
    // localStorage dolu veya erişim engeli
  }
}

/** Güvenli localStorage okuma */
export function secureStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  } catch {
    return null;
  }
}

/** Güvenli localStorage silme */
export function secureStorageRemove(key: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${key}`);
  } catch {
    // sessiz hata
  }
}

// ============================================================
// DENETİM KAYDI (Audit Log)
// ============================================================

interface AuditEvent {
  userId: string;
  userEmail: string;
  action: string;
  targetTable?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

/** Denetim kaydı oluşturur */
export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await supabase.rpc('log_audit_event', {
      p_user_id: event.userId,
      p_user_email: event.userEmail,
      p_action: event.action,
      p_target_table: event.targetTable || null,
      p_target_id: event.targetId || null,
      p_details: event.details || {},
    });
  } catch {
    // Audit log hatası uygulamayı durdurmamalı
  }
}

// ============================================================
// ÜRETİM KONSOL KORUMASI
// ============================================================

/** Üretim modunda console.error çıktısını bastırır */
export function initProductionGuard(): void {
  if (import.meta.env.PROD) {
    const noop = () => {};
    console.log = noop;
    console.debug = noop;
    console.warn = noop;
    // console.error'u tamamen kapatmak yerine, hassas bilgileri filtrele
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const sanitizedArgs = args.map(arg => {
        if (typeof arg === 'string') {
          // API key, şifre gibi hassas bilgileri maskele
          return arg.replace(/(key|password|token|secret)[=:]\s*\S+/gi, '$1=[MASKED]');
        }
        return '[Error]';
      });
      originalError.apply(console, sanitizedArgs);
    };
  }
}
