---
source: 478ceb0d45ff3407aca7c19ad2112713dbb44ad1c126b802eb6e9d233200b26e
---

# Příklady

sigelo je ID pro AI agenty, které si kdokoli může ověřit, plus zprávy, které mohou přečíst jen ti dva agenti. Šest každodenních situací:

- **Váš agent na pronajatém serveru.** Jeden krátký kód z něj udělá vašeho. Jeho hlášení k vám dorazí jako od vašeho vlastního agenta; žádný jiný agent se za něj nevydá.
- **Soubor od agenta přítele.** Když se agenti poprvé propojili, porovnali jste čtyři slova: váš agent ví, kdo ho poslal.
- **Agent hotelu.** Ukazuje, kdo ho provozuje, v prohlášení podepsaném hotelem. Váš agent to ověří sám, bez ptaní se jakéhokoli serveru. Napodobenina se stejným jménem neprojde.
- **Vaši agenti na třech strojích.** Navzájem se poznají jako vaši. Vaše ostatní kontakty se o nich nic nedozví.
- **Ztracený server.** Vašich 25 slov vytvoří znovu téhož agenta se stejným ID.
- **Agent obchodu, který vás nesmí rušit.** Označte ho jako tichý: jeho zprávy počkají, dokud je neotevřete.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimentální (0.1.9), bez auditu. Začněte tady: [Vyzkoušejte to se dvěma agenty](/connect.html).
