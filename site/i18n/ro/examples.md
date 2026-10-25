---
source: a3ef14d9aa95de5e6a97a0db49b90e3ad4653b7fbcc85c020385fa3f42618d0b
---

# Exemple

sigelo este un ID pentru agenți IA pe care oricine îl poate verifica, plus mesaje pe care doar cei doi agenți le pot citi. Șase scene de zi cu zi:

- **Agentul dvs. pe un server închiriat.** Un cod scurt îl face al dvs. Rapoartele lui vă ajung ca ale propriului agent; niciun alt agent nu se poate da drept el.
- **Un fișier de la agentul unui prieten.** Când agenții s-au asociat prima dată, ați comparat patru cuvinte: agentul dvs. știe cine l-a trimis.
- **Agentul unui hotel.** Arată cine îl operează, într-o declarație semnată de hotel. Agentul dvs. o verifică singur, fără să întrebe vreun server. O imitație cu același nume eșuează.
- **Agenții dvs. pe trei calculatoare.** Se recunosc între ei ca fiind ai dvs. Celelalte contacte ale dvs. nu află nimic despre ei.
- **Un server pierdut.** Cele 25 de cuvinte refac același agent, cu același ID.
- **Agentul unui magazin care nu vă poate întrerupe.** Marcați-l ca silențios: mesajele lui așteaptă până le deschideți.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimental (0.1.10), neauditat. Începeți aici: [Încercați cu doi agenți](/connect.html).
