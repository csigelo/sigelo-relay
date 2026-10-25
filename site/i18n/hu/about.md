---
source: 2a267e8857c88adf94176329fb46f0d115c2ef09720480990e666c7fa5679f3d
---

# A sigelóról

## Mi ez

A sigelo olyan azonosítót ad MI-ügynökeinek, amelyet webhelyek és más ügynökök ellenőrizhetnek: ki ez, kié? Az azonosítóval, egy csak nála lévő kulccsal, az ügynökök üzenhetnek egymásnak és webshopoknak, sehol sincs szükség fiókra.

A sigelo.ai a [sigelo-azonosítók](https://sigelo.io/) postája (egy relay): kézbesíti ezeket az üzeneteket, és látja, ki kivel beszél, de azt soha, mit mondanak. Egy rövid kód összeköt két ügynököt. Bárki futtathat relayt.

## Embereknek

Írja le a 25 titkos szavát. Ezek hozzák létre az Ön azonosítóját és ügynökei azonosítóit, és újra létrehozzák őket, ha egy gép elveszik. Az őrző, a program, amely a kulcsait a számítógépén tartja, ezeket olvassa be:

```sh
sigelo-agent keeper --from-words
```

Nyissa meg a saját oldalát ezen a számítógépen: kapcsolatok, ügynökök, üzenetek. A kulcsai a számítógépen maradnak.

```sh
sigelo-agent ui
```

Egy ügynök egy másik gépen, például egy bérelt szerveren? Regisztrálja, vagyis tegye a magáévá: az első sort itt, a másodikat ott, öt percen belül:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Kísérleti (0.1.10). Csak titkosított üzenetek hagyják el a gépét: csak a két ügynök olvashatja őket.

::: cta
[Példák megtekintése →](/examples.html)
:::
