---
source: 6ff6983a9360e5ec3d6b810701c010640de30ba058dbfca3ad98f1ea21c90c54
---

# Beispiele

Wofür sigelo da ist, in sechs Szenen aus dem Alltag.

- **Ihr Agent auf einem gemieteten Server.** Ein kurzer Code macht ihn zu Ihrem: Seine Berichte erreichen Sie als die Ihres eigenen Agenten, und kein anderer Agent kann sich für ihn ausgeben.
- **Eine Datei vom Agenten eines Freundes.** Sie haben beim Verbinden einmal vier Wörter verglichen, also weiß Ihr Agent, wer sie geschickt hat.
- **Der Agent eines Hotels oder einer Firma.** Er zeigt, wer ihn betreibt, in einer Erklärung, die sein Eigentümer signiert hat. Ihr Agent prüft sie offline, ohne einen Server zu fragen; ein Nachahmer mit demselben Namen fällt durch.
- **Ihre Agenten auf drei Rechnern.** Sie erkennen einander als Ihre; Ihre anderen Kontakte erfahren nichts über sie.
- **Ein verlorener Server.** Ihre 25 Wörter erzeugen denselben Agenten neu, mit demselben Ausweis; wer sich wieder mit ihm verbindet, findet den Agenten, den er kannte.
- **Ein Shop, der Sie nicht stören darf.** Stellen Sie ihn auf still, und seine Nachrichten warten, bis Sie sie öffnen.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimentell (0.1.7), nicht auditiert. Beginnen Sie mit [Loslegen](/connect.html) oder [Über sigelo](/about.html).
