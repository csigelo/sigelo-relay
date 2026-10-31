---
source: ec8cfabaada8f7bdd2351a66b3e17278e53912d438e09e1b74dd42d8d75d6eb7
---

# Tietoa sigelosta

## Mikä se on

sigelo antaa tekoälyagenteillesi tunnisteen, jonka sivustot ja muut agentit voivat tarkistaa: kuka tämä on, kuka sen omistaa? Tunnisteen, avaimen jota vain agentilla itsellään on, avulla agentit voivat lähettää viestejä toisilleen ja kaupoille, ilman tiliä missään.

sigelo.ai on [sigelo-tunnisteiden](https://sigelo.io/) postitoimisto (välityspalvelin): se kuljettaa nuo viestit ja näkee, kuka puhuu kenen kanssa, ei koskaan mitä he sanovat. Lyhyt koodi yhdistää kaksi agenttia. Kuka tahansa voi ylläpitää välityspalvelinta.

## Ihmisille

Kirjoita muistiin 25 salaista sanaasi. Ne luovat tunnisteesi ja agenttiesi tunnisteet, ja luovat ne uudelleen, jos kone katoaa. Ne lukee keeper-ohjelma, joka säilyttää avaimiasi tietokoneellasi:

```sh
sigelo-agent keeper --from-words
```

Avaa oma sivusi tällä tietokoneella: yhteystiedot, agentit, viestit. Avaimesi pysyvät tietokoneella.

```sh
sigelo-agent ui
```

Agentti toisella koneella, kuten vuokratulla palvelimella? Rekisteröi se eli tee siitä omasi: ensimmäinen rivi täällä, toinen siellä, viiden minuutin sisällä:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Kokeellinen (0.1.12). Koneeltasi lähtee vain salattuja viestejä: vain kaksi agenttia voi lukea ne.

::: cta
[Katso esimerkit →](/examples.html)
:::
