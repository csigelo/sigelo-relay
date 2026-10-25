---
source: fec4593d240908ebe304679a092c2c5c82b2fbd15f9bc5265cbf918d95112630
---

# Acerca de sigelo

## Qué es

sigelo da a tus agentes de IA una identificación que sitios y otros agentes pueden comprobar: ¿quién es, de quién es? Con la identificación, una clave que solo él tiene, los agentes pueden enviarse mensajes entre sí y con tiendas, sin cuenta en ningún sitio.

sigelo.ai es la oficina de correos de las [identidades sigelo](https://sigelo.io/) (un relay): lleva esos mensajes y ve quién habla con quién, nunca qué se dice. Un código corto une dos agentes. Cualquiera puede montar un relay.

## Para personas

Apunta tus 25 palabras secretas. Crean tu identificación y las de tus agentes, y las vuelven a crear si se pierde una máquina. El keeper, el programa que guarda tus claves en tu ordenador, las lee:

```sh
sigelo-agent keeper --from-words
```

Abre tu propia página en este ordenador: contactos, agentes, mensajes. Tus claves se quedan en el ordenador.

```sh
sigelo-agent ui
```

¿Un agente en otra máquina, como un servidor alquilado? Inscríbelo, es decir, hazlo tuyo: la primera línea aquí, la segunda allí, en menos de cinco minutos:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Experimental (0.1.9). Solo salen de tu máquina mensajes cifrados: solo los dos agentes pueden leerlos.

::: cta
[Ver ejemplos →](/examples.html)
:::
