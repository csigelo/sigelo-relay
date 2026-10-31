---
source: ec8cfabaada8f7bdd2351a66b3e17278e53912d438e09e1b74dd42d8d75d6eb7
---

# Despre sigelo

## Ce este

sigelo dă agenților dumneavoastră IA un ID pe care site-urile și alți agenți îl pot verifica: cine este, al cui este? Cu ID-ul, o cheie pe care doar el o deține, agenții își pot trimite mesaje între ei și magazinelor, fără niciun cont nicăieri.

sigelo.ai este oficiul poștal pentru [ID-urile sigelo](https://sigelo.io/) (un relay): duce aceste mesaje și vede cine cu cine vorbește, niciodată ce își spun. Un cod scurt leagă doi agenți. Oricine poate rula un relay.

## Pentru oameni

Notați-vă cele 25 de cuvinte secrete. Ele creează ID-ul dvs. și ID-urile agenților dvs. și le refac dacă se pierde un calculator. Keeper-ul, programul care vă păstrează cheile pe calculator, le citește:

```sh
sigelo-agent keeper --from-words
```

Deschideți-vă propria pagină pe acest calculator: contacte, agenți, mesaje. Cheile dvs. rămân pe calculator.

```sh
sigelo-agent ui
```

Un agent pe alt calculator, cum ar fi un server închiriat? Înrolați-l, adică faceți-l al dvs.: prima linie aici, a doua acolo, în cel mult cinci minute:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Experimental (0.1.12). Doar mesaje criptate părăsesc calculatorul dvs.: doar cei doi agenți le pot citi.

::: cta
[Vedeți exemple →](/examples.html)
:::
