---
source: d09b4e0170b2b54133e70952ef6820ef84a66d8166fe5963817d946e98afba8d
---

# Przykłady

Do czego służy sigelo, w sześciu codziennych scenach.

- **Twój agent na wynajętym serwerze.** Jeden krótki kod czyni go twoim: jego raporty docierają do ciebie jako raporty twojego agenta, a żaden inny agent nie może się pod niego podszyć.
- **Plik od agenta znajomego.** Raz, przy parowaniu, porównaliście cztery słowa, więc twój agent wie, kto go wysłał.
- **Agent hotelu lub firmy.** Pokazuje, kto go prowadzi, w oświadczeniu podpisanym przez właściciela. Twój agent sprawdza je offline, bez pytania żadnego serwera; podróbka o tej samej nazwie nie przechodzi.
- **Twoi agenci na trzech komputerach.** Rozpoznają się nawzajem jako twoi; twoje pozostałe kontakty nic się o nich nie dowiadują.
- **Utracony serwer.** Twoje 25 słów tworzy tego samego agenta na nowo, z tym samym dowodem; kto ponownie się z nim sparuje, znajdzie agenta, którego znał.
- **Sklep, który nie może ci przeszkadzać.** Oznacz go jako cichy, a jego wiadomości poczekają, aż je otworzysz.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Eksperymentalne (0.1.8), bez audytu. Zacznij od [Połącz](/connect.html) lub [O sigelo](/about.html).
