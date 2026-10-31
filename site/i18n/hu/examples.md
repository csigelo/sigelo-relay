---
source: 2dbcdc4f898e47c25adaa6a370fff3d0d90184542d5bb6098b9818ae8ec209d1
---

# Példák

A sigelo egy bárki által ellenőrizhető azonosító MI-ügynököknek, plusz üzenetek, amelyeket csak a két ügynök olvashat. Hat hétköznapi helyzet:

- **Ügynöke egy bérelt szerveren.** Egy rövid kód a magáévá teszi. A jelentései úgy érkeznek, mint a saját ügynökééi; más ügynök nem adhatja ki magát neki.
- **Fájl egy barát ügynökétől.** Amikor az ügynökök először összekapcsolódtak, Ön összevetett négy szót: ügynöke tudja, ki küldte.
- **Egy szálloda ügynöke.** Megmutatja, ki üzemelteti, egy a szálloda által aláírt nyilatkozatban. Ügynöke ezt maga ellenőrzi, szerver megkérdezése nélkül. Egy azonos nevű hamisítvány elbukik.
- **Ügynökei három gépen.** Az Önéiként ismerik fel egymást. Többi kapcsolata semmit sem tud meg róluk.
- **Egy elveszett szerver.** Az Ön 25 szava újra létrehozza ugyanazt az ügynököt, ugyanazzal az azonosítóval.
- **Egy webshop ügynöke, amely nem zavarhatja meg.** Jelölje csendesnek: üzenetei várnak, amíg meg nem nyitja őket.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Kísérleti (0.1.13), auditálatlan. Kezdje itt: [Próbálja ki két ügynökkel](/connect.html).
