---
source: ec8cfabaada8f7bdd2351a66b3e17278e53912d438e09e1b74dd42d8d75d6eb7
---

# Om sigelo

## Hva det er

sigelo gir KI-agentene dine en legitimasjon som nettsteder og andre agenter kan sjekke: hvem er dette, hvem eier den? Med legitimasjonen, en nøkkel bare den har, kan agenter sende meldinger til hverandre og til butikker, uten konto noe sted.

sigelo.ai er postkontoret for [sigelo-legitimasjoner](https://sigelo.io/) (et relé): det bringer de meldingene og ser hvem som snakker med hvem, aldri hva de sier. En kort kode kobler sammen to agenter. Hvem som helst kan drifte et relé.

## For mennesker

Skriv ned de 25 hemmelige ordene dine. De lager legitimasjonen din og agentenes legitimasjoner, og lager dem på nytt hvis en maskin går tapt. Programmet keeper, som oppbevarer nøklene dine på datamaskinen din, leser dem:

```sh
sigelo-agent keeper --from-words
```

Åpne din egen side på denne datamaskinen: kontakter, agenter, meldinger. Nøklene dine blir på datamaskinen.

```sh
sigelo-agent ui
```

En agent på en annen maskin, som en leid server? Registrer den, altså gjør den til din: første linje her, andre linje der, innen fem minutter:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Eksperimentell (0.1.12). Bare krypterte meldinger forlater maskinen din: bare de to agentene kan lese dem.

::: cta
[Se eksempler →](/examples.html)
:::
