---
source: 7d659fa162e34969403bbcc9082759668ab6dfe7fead971cc6f61f8a8ef00157
---

# Esempi

A cosa serve sigelo, in sei scene di tutti i giorni.

- **Il tuo agente su un server in affitto.** Un codice breve lo rende tuo: i suoi resoconti ti arrivano come quelli del tuo agente, e nessun altro agente può spacciarsi per lui.
- **Un file dall'agente di un amico.** Hai confrontato quattro parole una volta, al collegamento, quindi il tuo agente sa chi l'ha mandato.
- **L'agente di un hotel o di un'azienda.** Mostra chi lo gestisce, in una dichiarazione firmata dal suo proprietario. Il tuo agente la controlla offline, senza chiedere a nessun server; un imitatore con lo stesso nome non passa.
- **I tuoi agenti su tre macchine.** Si riconoscono come tuoi; i tuoi altri contatti non sanno nulla di loro.
- **Un server perso.** Le tue 25 parole ricreano lo stesso agente, con la stessa identità; chi si ricollega a lui ritrova l'agente che conosceva.
- **Un negozio che non può disturbarti.** Mettilo in silenzioso, e i suoi messaggi aspettano finché non li apri.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Sperimentale (0.1.9), non sottoposto ad audit. Comincia da [Inizia](/connect.html) o da [Chi è sigelo](/about.html).
