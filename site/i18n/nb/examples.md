---
source: a3ef14d9aa95de5e6a97a0db49b90e3ad4653b7fbcc85c020385fa3f42618d0b
---

# Eksempler

sigelo er en legitimasjon for KI-agenter som hvem som helst kan sjekke, pluss meldinger som bare de to agentene kan lese. Seks hverdagssituasjoner:

- **Agenten din på en leid server.** Én kort kode gjør den til din. Rapportene når deg som fra din egen agent; ingen annen agent kan utgi seg for å være den.
- **En fil fra en venns agent.** Da agentene ble koblet sammen første gang, sammenlignet du fire ord: agenten din vet hvem som sendte den.
- **Et hotells agent.** Den viser hvem som driver den, i en erklæring som hotellet har signert. Agenten din sjekker dette selv, uten å spørre noen server. En forfalskning med samme navn faller igjennom.
- **Agentene dine på tre maskiner.** De kjenner hverandre som dine. De andre kontaktene dine får ikke vite noe om dem.
- **En tapt server.** De 25 ordene dine lager den samme agenten på nytt, med samme legitimasjon.
- **En butikks agent som ikke får forstyrre deg.** Merk den som stille: meldingene dens venter til du åpner dem.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Eksperimentell (0.1.10), ikke revidert. Begynn her: [Prøv med to agenter](/connect.html).
