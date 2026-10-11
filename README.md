# Smart Subtitles

YouTube videolarını Türkçe altyazıyla izlemek için bir Chrome ve Brave eklentisi. Videonun mevcut altyazısını alır, Gemini ile çevirir ve oynatma zamanına göre ekranda gösterir. İlk bölüm hazır olduğunda izlemeye başlayabilirsiniz; kalan satırlar arka planda çevrilir.

## Neler yapar?

- Manuel ve otomatik oluşturulmuş altyazıları bulur; İngilizce kaynaklara öncelik verir.
- Türkçe altyazı bulunan videolarda tekrar çeviri başlatmaz.
- Türkçe veya kaynak metinle birlikte çift satırlı görünüm sunar.
- Altyazı boyutunu, konumunu ve arka planını ayarlamanızı sağlar.
- Hazır çevirileri tarayıcıda saklar; aynı videoda yeniden kullanır.
- Video değişimini, tam ekranı ve oynatma konumunu takip eder.
- Çeviri ilerlemesini ve bağlantı hatalarını eklenti penceresinde gösterir.

Ses tanıma yapmaz. Videoda mevcut altyazı yoksa çeviri de yapılamaz.

## Kurulum

Node.js 24 veya üzeri ve güncel Chrome ya da Brave gerekir.

```bash
git clone https://github.com/1tedd/otomatikceviri.git
cd otomatikceviri
npm ci
npm run build
```

1. Chrome'da `chrome://extensions`, Brave'de `brave://extensions` sayfasını açın.
2. **Geliştirici modu** seçeneğini etkinleştirin.
3. **Paketlenmemiş öğe yükle** düğmesine basıp projenin `dist` klasörünü seçin.
4. Eklenti simgesine tıklayın, [Google AI Studio](https://aistudio.google.com/apikey) üzerinden aldığınız API anahtarını girin ve **Kaydet** düğmesine basın.
5. Altyazısı bulunan bir YouTube videosu açın. Önceden açık olan sekmeyi yenileyin.

API anahtarı `.env` dosyasından okunmaz. Her kullanıcı kendi anahtarını eklenti penceresinden kaydeder; derleme sırasında anahtar gerekmez.

## Kullanım

Çeviri video açıldığında otomatik başlar. Eklenti penceresinden altyazıları açıp kapatabilir, görünümü değiştirebilir ve **Yeniden çevir** seçeneğiyle mevcut videoyu tekrar çevirebilirsiniz. Video önbelleğini veya tüm çeviri önbelleğini aynı pencereden temizleyebilirsiniz.

İlk istek en fazla 20 satır içerir. Devamındaki istekler en fazla 80 satırlık ve metin uzunluğuyla sınırlanmış parçalara ayrılır. Öncelikli model Gemini 3.1 Flash-Lite'tır; istek başarısız olursa Gemini 3.5 Flash-Lite denenir. Model adları `src/core/config.ts` dosyasında tanımlıdır.

## Veriler ve API kullanımı

Altyazı metinleri çeviri için doğrudan Google'ın Gemini API'sine gönderilir. Projeye ait ayrı bir sunucu, hesap sistemi veya analitik servisi yoktur.

API anahtarı tarayıcının yerel eklenti depolamasında tutulur ve yalnızca güvenilir eklenti bağlamlarının erişimine açıktır. Bu depolama bir şifre kasası değildir. Anahtarınızı, tarayıcı profilinizi ve hata kayıtlarınızı paylaşırken dikkatli olun. Çeviriler ve video kimlikleri yerel önbellekte saklanır; görünüm ayarları tarayıcının senkronize ayar depolamasını kullanır.

API erişimi, ücretlendirme ve kota Google hesabınıza ve kullandığınız modele bağlıdır. İstek aralığı uygulanması kota hatalarını tamamen önlemez. Sağlayıcının veri işleme ve saklama koşulları gönderilen altyazılar için geçerlidir.

## Geliştirme

```bash
npm run typecheck
npm run build
```

Kaynakları değiştirdikten sonra tekrar derleyin, eklentiler sayfasından eklentiyi yeniden yükleyin ve YouTube sekmesini yenileyin. `npm run dev` arayüz geliştirmesi içindir; eklentinin tamamını denemek için derlenmiş `dist` klasörünü yükleyin.

## Sorun giderme

- **Altyazı bulunamadı:** Videonun YouTube üzerinden altyazı sunduğunu kontrol edin. Altyazısız videolar, erişimi kısıtlı içerikler ve bazı canlı yayınlar desteklenmeyebilir.
- **API hatası:** Anahtarı ve Google AI Studio'daki model erişimini kontrol edin. Kota dolduysa daha sonra yeniden deneyin.
- **Eklenti yanıt vermiyor:** Eklentiyi ve YouTube sekmesini yenileyin; penceredeki canlı log bölümünü kontrol edin.
- **Eski çeviri görünüyor:** Video önbelleğini temizleyip yeniden çevirin.

Çeviriler hatalı veya eksik olabilir. YouTube'un altyazı uçlarında ve sayfa yapısında yaptığı değişiklikler eklentinin çalışmasını etkileyebilir.
