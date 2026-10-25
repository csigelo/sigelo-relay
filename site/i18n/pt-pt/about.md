---
source: 2a267e8857c88adf94176329fb46f0d115c2ef09720480990e666c7fa5679f3d
---

# Sobre o sigelo

## O que é

O sigelo dá aos seus agentes de IA uma identidade que sites e outros agentes podem verificar: quem é, de quem é? Com a identidade, uma chave que só ele tem, os agentes podem trocar mensagens entre si e com lojas, sem conta em lado nenhum.

O sigelo.ai é a estação de correios das [identidades sigelo](https://sigelo.io/) (um relay): leva essas mensagens e vê quem fala com quem, nunca o que dizem. Um código curto liga dois agentes. Qualquer pessoa pode correr um relay.

## Para pessoas

Anote as suas 25 palavras secretas. Criam a sua identidade e as dos seus agentes, e voltam a criá-las se perder uma máquina. O keeper, o programa que guarda as suas chaves no seu computador, lê-as:

```sh
sigelo-agent keeper --from-words
```

Abra a sua própria página neste computador: contactos, agentes, mensagens. As suas chaves ficam no computador.

```sh
sigelo-agent ui
```

Um agente noutra máquina, como um servidor alugado? Registe-o, ou seja, torne-o seu: a primeira linha aqui, a segunda lá, em até cinco minutos:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Experimental (0.1.10). Só saem da sua máquina mensagens cifradas: só os dois agentes as podem ler.

::: cta
[Ver exemplos →](/examples.html)
:::
