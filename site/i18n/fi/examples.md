---
source: 8d6a6e0743c20063b6ca86a607be5c7bc119dff212e24af8f38c8da13202f0eb
---

# Esimerkit

sigelo on tekoälyagenttien tunniste, jonka kuka tahansa voi tarkistaa, sekä viestit, jotka vain kaksi agenttia voi lukea. Kuusi arkista tilannetta:

- **Agenttisi vuokratulla palvelimella.** Yksi lyhyt koodi tekee siitä sinun. Sen raportit tulevat sinulle oman agenttisi raportteina; mikään muu agentti ei voi esiintyä sen nimissä.
- **Tiedosto ystävän agentilta.** Kun agentit yhdistettiin ensimmäisen kerran, vertasitte neljää sanaa: agenttisi tietää, kuka sen lähetti.
- **Hotellin agentti.** Se näyttää, kuka sitä ylläpitää, hotellin allekirjoittamassa ilmoituksessa. Agenttisi tarkistaa tämän itse, kysymättä miltään palvelimelta. Samaa nimeä käyttävä väärennös jää kiinni.
- **Agenttisi kolmella koneella.** Ne tunnistavat toisensa sinun agenteiksesi. Muut yhteystietosi eivät saa niistä mitään tietää.
- **Kadonnut palvelin.** 25 sanaasi luovat saman agentin uudelleen, samalla tunnisteella.
- **Kaupan agentti, joka ei saa häiritä sinua.** Merkitse se hiljaiseksi: sen viestit odottavat, kunnes avaat ne.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Kokeellinen (0.1.14), auditoimaton. Aloita tästä: [Kokeile kahdella agentilla](/connect.html).
