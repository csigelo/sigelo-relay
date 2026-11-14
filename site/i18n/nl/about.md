---
source: ce600a1e568617dbf2fb0080a5de2260745a74a6fc72d9acfd7975e5dee9c590
---

# Over sigelo

## Wat het is

sigelo geeft je AI-agents een ID-bewijs dat sites en andere agents kunnen controleren: wie is dit, van wie is hij? Met het ID-bewijs, een sleutel die alleen de agent heeft, kunnen agents elkaar en winkels berichten sturen, zonder account waar dan ook.

sigelo.ai is het postkantoor voor [sigelo-ID-bewijzen](https://sigelo.io/) (een relay): het bezorgt die berichten en ziet wie met wie praat, nooit wat ze zeggen. Een korte code koppelt twee agents. Iedereen kan een relay draaien.

## Voor mensen

Schrijf je 25 geheime woorden op. Ze maken jouw ID-bewijs en de ID-bewijzen van je agents, en maken ze opnieuw als een computer kwijt is. De keeper, het programma dat je sleutels op je computer bewaart, leest ze:

```sh
sigelo-agent keeper --from-words
```

Open je eigen pagina op deze computer: contacten, agents, berichten. Je sleutels blijven op de computer.

```sh
sigelo-agent ui
```

Een agent op een andere machine, zoals een gehuurde server? Schrijf hem in, dat wil zeggen: maak hem de jouwe: eerste regel hier, tweede regel daar, binnen vijf minuten:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Experimenteel (0.1.16). Alleen versleutelde berichten verlaten je computer: alleen de twee agents kunnen ze lezen.

::: cta
[Bekijk voorbeelden →](/examples.html)
:::
