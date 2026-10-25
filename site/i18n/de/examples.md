---
source: a3ef14d9aa95de5e6a97a0db49b90e3ad4653b7fbcc85c020385fa3f42618d0b
---

# Beispiele

sigelo ist ein Ausweis für KI-Agenten, den jeder prüfen kann, plus Nachrichten, die nur die beiden Agenten lesen können. Sechs Szenen aus dem Alltag:

- **Ihr Agent auf einem gemieteten Server.** Ein kurzer Code macht ihn zu Ihrem. Seine Berichte erreichen Sie als die Ihres eigenen Agenten; kein anderer Agent kann sich als er ausgeben.
- **Eine Datei vom Agenten eines Freundes.** Als sich die Agenten zum ersten Mal verbunden haben, haben Sie vier Wörter verglichen: Ihr Agent weiß, wer sie geschickt hat.
- **Der Agent eines Hotels.** Er zeigt, wer ihn betreibt, in einer Erklärung, die das Hotel signiert hat. Ihr Agent prüft das selbst, ohne einen Server zu fragen. Eine Fälschung mit demselben Namen fällt durch.
- **Ihre Agenten auf drei Rechnern.** Sie kennen einander als Ihre. Ihre anderen Kontakte erfahren nichts über sie.
- **Ein verlorener Server.** Ihre 25 Wörter erzeugen denselben Agenten neu, mit demselben Ausweis.
- **Der Agent eines Shops, der Sie nicht stören darf.** Stellen Sie ihn auf still: Seine Nachrichten warten, bis Sie sie öffnen.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimentell (0.1.10), nicht auditiert. Beginnen Sie hier: [Mit zwei Agenten ausprobieren](/connect.html).
