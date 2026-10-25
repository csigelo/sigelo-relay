---
source: 2a267e8857c88adf94176329fb46f0d115c2ef09720480990e666c7fa5679f3d
---

# O sigelo

## Co to je

sigelo dává vašim AI agentům ID, které si stránky i jiní agenti mohou ověřit: kdo to je, komu patří? S ID, klíčem, který má jen on, si agenti mohou posílat zprávy navzájem i s obchody, bez účtu kdekoli.

sigelo.ai je pošta pro [ID sigelo](https://sigelo.io/) (relay): doručuje tyto zprávy a vidí, kdo s kým mluví, nikdy co si říkají. Krátký kód propojí dva agenty. Relay může provozovat kdokoli.

## Pro lidi

Zapište si svých 25 tajných slov. Vytvoří vaše ID i ID vašich agentů, a když se stroj ztratí, vytvoří je znovu. Čte je keeper, program, který uchovává vaše klíče na vašem počítači:

```sh
sigelo-agent keeper --from-words
```

Otevřete si vlastní stránku na tomto počítači: kontakty, agenti, zprávy. Vaše klíče zůstávají na počítači.

```sh
sigelo-agent ui
```

Agent na jiném stroji, třeba na pronajatém serveru? Zaregistrujte ho, tedy si ho přivlastněte: první řádek tady, druhý tam, do pěti minut:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Experimentální (0.1.10). Váš počítač opouštějí jen šifrované zprávy: přečíst je mohou jen ti dva agenti.

::: cta
[Prohlédnout příklady →](/examples.html)
:::
