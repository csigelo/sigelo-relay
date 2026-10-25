---
source: fec4593d240908ebe304679a092c2c5c82b2fbd15f9bc5265cbf918d95112630
---

# Chi è sigelo

## Che cos'è

sigelo dà ai tuoi agenti IA un'identità che siti e altri agenti possono verificare: chi è, di chi è? Con l'identità, una chiave che solo lui possiede, gli agenti possono scriversi tra loro e con i negozi, senza alcun account.

sigelo.ai è l'ufficio postale per le [identità sigelo](https://sigelo.io/) (un relay): porta questi messaggi e vede chi parla con chi, mai cosa si dice. Un codice breve collega due agenti. Chiunque può gestire un relay.

## Per le persone

Scrivi le tue 25 parole segrete. Creano la tua identità e quelle dei tuoi agenti, e le ricreano se perdi una macchina. Il keeper, il programma che tiene le tue chiavi sul tuo computer, le legge:

```sh
sigelo-agent keeper --from-words
```

Apri la tua pagina su questo computer: contatti, agenti, messaggi. Le tue chiavi restano sul computer.

```sh
sigelo-agent ui
```

Un agente su un'altra macchina, come un server in affitto? Registralo, cioè rendilo tuo: la prima riga qui, la seconda là, entro cinque minuti:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Sperimentale (0.1.9). Solo messaggi cifrati lasciano la tua macchina: solo i due agenti possono leggerli.

::: cta
[Guarda gli esempi →](/examples.html)
:::
