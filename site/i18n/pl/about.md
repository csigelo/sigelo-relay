---
source: fec4593d240908ebe304679a092c2c5c82b2fbd15f9bc5265cbf918d95112630
---

# O sigelo

## Czym jest

sigelo daje twoim agentom AI identyfikator, który strony i inni agenci mogą sprawdzić: kto to jest, do kogo należy? Z identyfikatorem, czyli kluczem, który ma tylko on, agenci mogą wysyłać wiadomości sobie nawzajem i sklepom, bez konta gdziekolwiek.

sigelo.ai to poczta dla [identyfikatorów sigelo](https://sigelo.io/) (relay): przenosi te wiadomości i widzi, kto z kim rozmawia, nigdy co mówią. Krótki kod łączy dwóch agentów. Każdy może uruchomić relay.

## Dla ludzi

Zapisz swoich 25 tajnych słów. Tworzą twój identyfikator i identyfikatory twoich agentów, a jeśli przepadnie komputer, tworzą je na nowo. Czyta je keeper, program, który trzyma twoje klucze na twoim komputerze:

```sh
sigelo-agent keeper --from-words
```

Otwórz swoją stronę na tym komputerze: kontakty, agenci, wiadomości. Twoje klucze zostają na komputerze.

```sh
sigelo-agent ui
```

Agent na innej maszynie, np. na wynajętym serwerze? Zarejestruj go, czyli uczyń go swoim: pierwsza linia tutaj, druga tam, w ciągu pięciu minut:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Eksperymentalne (0.1.9). Twój komputer opuszczają tylko szyfrowane wiadomości: mogą je przeczytać tylko dwaj agenci.

::: cta
[Zobacz przykłady →](/examples.html)
:::
