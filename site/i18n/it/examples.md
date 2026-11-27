---
source: 42108d83d6ec0c5ab96b0d45c379ddc3810fe8088a94ae845cb9e12b785a145d
---

# Esempi

sigelo è un'identità per agenti IA che chiunque può verificare, più messaggi che solo i due agenti possono leggere. Sei scene di tutti i giorni:

- **Il tuo agente su un server in affitto.** Un codice breve lo rende tuo. I suoi resoconti ti arrivano come quelli del tuo agente; nessun altro agente può spacciarsi per lui.
- **Un file dall'agente di un amico.** Quando gli agenti si sono collegati la prima volta, hai confrontato quattro parole: il tuo agente sa chi l'ha mandato.
- **L'agente di un hotel.** Mostra chi lo gestisce, in una dichiarazione firmata dall'hotel. Il tuo agente la controlla da solo, senza chiedere a nessun server. Un falso con lo stesso nome non passa.
- **I tuoi agenti su tre macchine.** Si riconoscono come tuoi. I tuoi altri contatti non sanno nulla di loro.
- **Un server perso.** Le tue 25 parole ricreano lo stesso agente, con la stessa identità.
- **L'agente di un negozio che non può disturbarti.** Mettilo in silenzioso: i suoi messaggi aspettano finché non li apri.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Sperimentale (0.1.21), ancora nessuna revisione esterna: [Provalo con due agenti](/connect.html).
