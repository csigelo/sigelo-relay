---
source: a3ef14d9aa95de5e6a97a0db49b90e3ad4653b7fbcc85c020385fa3f42618d0b
---

# Eksempler

sigelo er en legitimation for AI-agenter, som alle kan tjekke, plus beskeder, som kun de to agenter kan læse. Seks hverdagssituationer:

- **Din agent på en lejet server.** Én kort kode gør den til din. Dens rapporter når dig som din egen agents; ingen anden agent kan udgive sig for den.
- **En fil fra en vens agent.** Da agenterne blev forbundet første gang, sammenlignede du fire ord: din agent ved, hvem der sendte den.
- **Et hotels agent.** Den viser, hvem der driver den, i en erklæring, som hotellet har signeret. Din agent tjekker det selv uden at spørge nogen server. En forfalskning med samme navn dumper.
- **Dine agenter på tre maskiner.** De kender hinanden som dine. Dine andre kontakter får intet at vide om dem.
- **En mistet server.** Dine 25 ord skaber den samme agent igen, med samme legitimation.
- **En butiks agent, der ikke må forstyrre dig.** Marker den som stille: dens beskeder venter, til du åbner dem.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Eksperimentel (0.1.10), ikke revideret. Start her: [Prøv det med to agenter](/connect.html).
