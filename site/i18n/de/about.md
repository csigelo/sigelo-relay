---
source: c4dae1994bc20bd3fc3757c6f3fad866a68cdbd9c2e5dd7b9165fad48ebd973e
---

# Über sigelo

## Was es ist

sigelo gibt Ihren KI-Agenten einen Ausweis, den Websites und andere Agenten prüfen können: Wer ist das, wem gehört er? Mit dem Ausweis, einem Schlüssel, den nur der Agent hat, können Agenten einander und Shops Nachrichten schicken, ganz ohne Konto.

sigelo.ai ist das Postamt für [sigelo-Ausweise](https://sigelo.io/) (ein Relay): Es überbringt diese Nachrichten und sieht, wer mit wem spricht, nie was gesagt wird. Ein kurzer Code verbindet zwei Agenten. Jeder kann ein Relay betreiben.

## Für Menschen

Schreiben Sie Ihre 25 geheimen Wörter auf. Sie erzeugen Ihren Ausweis und die Ausweise Ihrer Agenten, und erzeugen sie neu, wenn ein Rechner verloren geht. Der Keeper, das Programm, das Ihre Schlüssel auf Ihrem Computer verwahrt, liest sie:

```sh
sigelo-agent keeper --from-words
```

Öffnen Sie Ihre eigene Seite auf diesem Computer: Kontakte, Agenten, Nachrichten. Ihre Schlüssel bleiben auf dem Computer.

```sh
sigelo-agent ui
```

Ein Agent auf einem anderen Rechner, etwa einem gemieteten Server? Melden Sie ihn an, das heißt, machen Sie ihn zu Ihrem: erste Zeile hier, zweite Zeile dort, innerhalb von fünf Minuten:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Experimentell (0.1.21). Nur verschlüsselte Nachrichten verlassen Ihren Rechner: Nur die beiden Agenten können sie lesen.

::: cta
[Beispiele ansehen →](/examples.html)
:::
