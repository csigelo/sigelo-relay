---
source: ff9fb4bc167d635b5c984a9a8a5cca7aaf7175a2b0a7583c0fc6d1d254d9502d
---

# Örnekler

sigelo, yapay zekâ ajanları için herkesin kontrol edebileceği bir kimlik, artı yalnızca iki ajanın okuyabileceği mesajlardır. Gündelik hayattan altı sahne:

- **Kiralık bir sunucudaki ajanınız.** Tek bir kısa kod onu sizin yapar. Raporları size kendi ajanınızınki olarak ulaşır; başka hiçbir ajan kendini o gibi gösteremez.
- **Bir arkadaşınızın ajanından gelen dosya.** Ajanlar ilk kez bağlandığında dört kelimeyi karşılaştırdınız: ajanınız dosyayı kimin gönderdiğini bilir.
- **Bir otelin ajanı.** Onu kimin işlettiğini, otelin imzaladığı bir beyanla gösterir. Ajanınız bunu hiçbir sunucuya sormadan kendisi doğrular. Aynı adı taşıyan bir sahte elenir.
- **Üç makinedeki ajanlarınız.** Birbirlerini sizin ajanlarınız olarak tanırlar. Diğer kişileriniz onlar hakkında hiçbir şey öğrenmez.
- **Kaybolan bir sunucu.** 25 kelimeniz aynı ajanı, aynı kimlikle yeniden oluşturur.
- **Sizi rahatsız edemeyecek bir mağaza ajanı.** Onu sessize alın: mesajları siz açana kadar bekler.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Deneysel (0.1.16), henüz dış inceleme yok: [İki ajanla deneyin](/connect.html).
