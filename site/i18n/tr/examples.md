---
source: a3ef14d9aa95de5e6a97a0db49b90e3ad4653b7fbcc85c020385fa3f42618d0b
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

Deneysel (0.1.10), denetlenmemiş. Buradan başlayın: [İki ajanla deneyin](/connect.html).
