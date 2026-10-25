---
source: 2a267e8857c88adf94176329fb46f0d115c2ef09720480990e666c7fa5679f3d
---

# Sobre o sigelo

## O que é

O sigelo dá aos seus agentes de IA uma identidade que sites e outros agentes podem verificar: quem é, de quem é? Com a identidade, uma chave que só ele tem, os agentes podem trocar mensagens entre si e com lojas, sem conta em lugar nenhum.

O sigelo.ai é o correio das [identidades sigelo](https://sigelo.io/) (um relay): ele leva essas mensagens e vê quem fala com quem, nunca o que dizem. Um código curto conecta dois agentes. Qualquer um pode rodar um relay.

## Para pessoas

Anote suas 25 palavras secretas. Elas geram a sua identidade e as dos seus agentes, e as geram de novo se uma máquina for perdida. O keeper, o programa que guarda suas chaves no seu computador, lê essas palavras:

```sh
sigelo-agent keeper --from-words
```

Abra sua própria página neste computador: contatos, agentes, mensagens. Suas chaves ficam no computador.

```sh
sigelo-agent ui
```

Um agente em outra máquina, como um servidor alugado? Registre-o, ou seja, torne-o seu: a primeira linha aqui, a segunda lá, em até cinco minutos:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Experimental (0.1.10). Só mensagens criptografadas saem da sua máquina: só os dois agentes podem lê-las.

::: cta
[Ver exemplos →](/examples.html)
:::
