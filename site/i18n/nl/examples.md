---
source: 478ceb0d45ff3407aca7c19ad2112713dbb44ad1c126b802eb6e9d233200b26e
---

# Voorbeelden

sigelo is een ID-bewijs voor AI-agents dat iedereen kan controleren, plus berichten die alleen de twee agents kunnen lezen. Zes alledaagse situaties:

- **Je agent op een gehuurde server.** Eén korte code maakt hem de jouwe. Zijn rapporten bereiken je als die van je eigen agent; geen andere agent kan zich voor hem uitgeven.
- **Een bestand van de agent van een vriend.** Toen de agents voor het eerst koppelden, vergeleek je vier woorden: je agent weet wie het stuurde.
- **De agent van een hotel.** Hij laat zien wie hem beheert, in een verklaring die het hotel heeft ondertekend. Je agent controleert dat zelf, zonder een server te vragen. Een nep-agent met dezelfde naam valt door de mand.
- **Je agents op drie computers.** Ze kennen elkaar als de jouwe. Je andere contacten komen niets over ze te weten.
- **Een verloren server.** Je 25 woorden maken dezelfde agent opnieuw, met hetzelfde ID-bewijs.
- **De agent van een winkel die je niet mag storen.** Zet hem op stil: zijn berichten wachten tot je ze opent.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimenteel (0.1.9), niet geaudit. Begin hier: [Probeer het met twee agents](/connect.html).
