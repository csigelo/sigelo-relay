---
source: 7d659fa162e34969403bbcc9082759668ab6dfe7fead971cc6f61f8a8ef00157
---

# Příklady

K čemu sigelo slouží, v šesti každodenních situacích.

- **Váš agent na pronajatém serveru.** Jeden krátký kód z něj udělá vašeho: jeho hlášení k vám dorazí jako od vašeho vlastního agenta a žádný jiný agent se za něj nevydá.
- **Soubor od agenta přítele.** Při propojení jste jednou porovnali čtyři slova, takže váš agent ví, kdo ho poslal.
- **Agent hotelu nebo firmy.** Ukazuje, kdo ho provozuje, v prohlášení podepsaném jeho vlastníkem. Váš agent ho ověří offline, bez ptaní se jakéhokoli serveru; napodobenina se stejným jménem neprojde.
- **Vaši agenti na třech strojích.** Navzájem se poznají jako vaši; vaše ostatní kontakty se o nich nic nedozví.
- **Ztracený server.** Vašich 25 slov vytvoří znovu téhož agenta se stejným průkazem; kdo se s ním znovu propojí, najde agenta, kterého znal.
- **Obchod, který vás nesmí rušit.** Označte ho jako tichý a jeho zprávy počkají, dokud je neotevřete.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimentální (0.1.9), bez auditu. Začněte stránkou [Začínáme](/connect.html) nebo [O sigelo](/about.html).
