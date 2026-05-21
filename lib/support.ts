// Destek hattı — kullanıcılar QR hatası ve diğer sorunlarda ekran görüntüsünü
// doğrudan admin'in WhatsApp numarasına gönderebilsin diye sabitleri burada
// tutuyoruz. Numara değişirse tek yerden güncellenir.

export const SUPPORT_WHATSAPP_NUMBER = '905324961412';

/**
 * WhatsApp web/uygulama linkini, opsiyonel önceden doldurulmuş mesajla üretir.
 * wa.me biçimini kullanır (mobil + masaüstü uyumlu).
 */
export const buildWhatsAppUrl = (message?: string): string => {
  const base = `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}`;
  if (!message) return base;
  return `${base}?text=${encodeURIComponent(message)}`;
};

export const SUPPORT_WHATSAPP_URL = buildWhatsAppUrl(
  'Merhaba, sistemde sorun yaşıyorum. Ekran görüntüsünü ekteyim.'
);
