# BAC Handels - Bilinen Guvenlik Notlari

Shannon pentest oncesi tespit edilen potansiyel guvenlik riskleri.
Bu noktalar Shannon tarafindan otomatik olarak test edilecektir.

## Kritik Riskler

### 1. Duz Metin Sifre Saklama
- **Dosya:** `db_schema.sql:12`
- **Sorun:** `password TEXT DEFAULT '123'` - Sifreler duz metin olarak saklanıyor
- **Oneri:** Bcrypt hash kullanilmali, varsayilan sifre kaldirilmali

### 2. Supabase Anon Key Frontend'de Acik
- **Dosya:** `lib/supabase.ts:5`
- **Sorun:** Anon key dogrudan kaynak kodda hardcoded
- **Oneri:** Environment variable kullanilmali, key rotate edilmeli

### 3. RLS Politikalari Tamamen Acik
- **Dosya:** `db_schema.sql:150-157`
- **Sorun:** Tum tablolarda `USING (true) WITH CHECK (true)` - herkes her seye erisebilir
- **Oneri:** Kullanici bazli RLS politikalari tanimlanmali

### 4. Admin Kimlik Bilgileri Kaynak Kodda
- **Dosya:** `db_schema.sql:205-206`
- **Sorun:** Admin email ve sifre seed data icinde acik metin
- **Oneri:** Seed data production'da kullanilmamali

### 5. Sifre Dogrulama Fonksiyonu
- **Dosya:** `db_schema.sql:266-278`
- **Sorun:** `SECURITY DEFINER` ile calisiyor, duz metin karsilastirma yapıyor
- **Oneri:** Sadece bcrypt hash desteklenmeli

## Orta Riskler

### 6. IDOR (Insecure Direct Object Reference)
- Supabase REST API uzerinden baska kullanicilarin verilerine erisim mumkun olabilir
- Ozellikle `profiles`, `messages`, `time_logs` tablolari risk altinda

### 7. XSS Potansiyeli
- Kullanici girdileri (gorev aciklamalari, mesajlar, bio alani) sanitize edilmeden gosteriliyor olabilir

### 8. API Key Yonetimi
- Gemini API key `process.env.API_KEY` uzerinden erisilebilir durumda
