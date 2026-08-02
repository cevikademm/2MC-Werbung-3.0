/**
 * Uygulama genelinde açılıp kapatılabilen özellikler.
 *
 * QR_ATTENDANCE_ENABLED = false → QR kod ile mesai giriş/çıkış sistemi
 * tamamen gizlenir (Dashboard kartı, Bordro'daki "QR Kodu Tara" butonu ve
 * #qr rotası). Kod ve veritabanı tarafı olduğu gibi durur; tekrar açmak
 * için bu değeri true yapmak yeterlidir.
 */
export const QR_ATTENDANCE_ENABLED = false;
