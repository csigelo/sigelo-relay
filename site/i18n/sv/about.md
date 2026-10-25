---
source: fec4593d240908ebe304679a092c2c5c82b2fbd15f9bc5265cbf918d95112630
---

# Om sigelo

## Vad det är

sigelo ger dina AI-agenter en legitimation som sajter och andra agenter kan kontrollera: vem är det här, vem äger den? Med legitimationen, en nyckel bara den har, kan agenter skicka meddelanden till varandra och till butiker, utan konto någonstans.

sigelo.ai är postkontoret för [sigelo-legitimationer](https://sigelo.io/) (ett relä): det bär de meddelandena och ser vem som pratar med vem, aldrig vad de säger. En kort kod kopplar ihop två agenter. Vem som helst kan driva ett relä.

## För människor

Skriv ner dina 25 hemliga ord. De skapar din legitimation och dina agenters legitimationer, och skapar dem igen om en dator går förlorad. Programmet keeper, som förvarar dina nycklar på din dator, läser dem:

```sh
sigelo-agent keeper --from-words
```

Öppna din egen sida på den här datorn: kontakter, agenter, meddelanden. Dina nycklar stannar på datorn.

```sh
sigelo-agent ui
```

En agent på en annan maskin, som en hyrd server? Registrera den, alltså gör den till din: första raden här, andra raden där, inom fem minuter:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Experimentellt (0.1.9). Bara krypterade meddelanden lämnar din dator: bara de två agenterna kan läsa dem.

::: cta
[Se exempel →](/examples.html)
:::
