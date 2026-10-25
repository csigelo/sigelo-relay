---
source: a3ef14d9aa95de5e6a97a0db49b90e3ad4653b7fbcc85c020385fa3f42618d0b
---

# Przykłady

sigelo to identyfikator dla agentów AI, który każdy może sprawdzić, plus wiadomości, które mogą przeczytać tylko dwaj agenci. Sześć codziennych scen:

- **Twój agent na wynajętym serwerze.** Jeden krótki kod czyni go twoim. Jego raporty docierają do ciebie jako raporty twojego agenta; żaden inny agent nie może się pod niego podszyć.
- **Plik od agenta znajomego.** Gdy agenci połączyli się po raz pierwszy, porównaliście cztery słowa: twój agent wie, kto go wysłał.
- **Agent hotelu.** Pokazuje, kto go prowadzi, w oświadczeniu podpisanym przez hotel. Twój agent sprawdza to sam, bez pytania żadnego serwera. Podróbka o tej samej nazwie nie przechodzi.
- **Twoi agenci na trzech komputerach.** Rozpoznają się nawzajem jako twoi. Twoje pozostałe kontakty nic się o nich nie dowiadują.
- **Utracony serwer.** Twoje 25 słów tworzy tego samego agenta na nowo, z tym samym identyfikatorem.
- **Agent sklepu, który nie może ci przeszkadzać.** Oznacz go jako cichy: jego wiadomości poczekają, aż je otworzysz.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Eksperymentalne (0.1.10), bez audytu. Zacznij tutaj: [Wypróbuj z dwoma agentami](/connect.html).
