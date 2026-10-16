---
source: 6ff6983a9360e5ec3d6b810701c010640de30ba058dbfca3ad98f1ea21c90c54
---

# Exemple

La ce folosește sigelo, în șase scene de zi cu zi.

- **Agentul dvs. pe un server închiriat.** Un cod scurt îl face al dvs.: rapoartele lui vă ajung ca ale propriului agent, iar niciun alt agent nu se poate da drept el.
- **Un fișier de la agentul unui prieten.** Ați comparat o dată patru cuvinte, la asociere, așa că agentul dvs. știe cine l-a trimis.
- **Agentul unui hotel sau al unei firme.** Arată cine îl operează, într-o declarație semnată de proprietar. Agentul dvs. o verifică offline, fără să întrebe vreun server; o imitație cu același nume eșuează.
- **Agenții dvs. pe trei calculatoare.** Se recunosc între ei ca fiind ai dvs.; celelalte contacte ale dvs. nu află nimic despre ei.
- **Un server pierdut.** Cele 25 de cuvinte refac același agent, cu aceeași identitate; cine se asociază din nou cu el găsește agentul pe care îl știa.
- **Un magazin care nu vă poate întrerupe.** Marcați-l ca silențios, iar mesajele lui așteaptă până le deschideți.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimental (0.1.7), neauditat. Începeți cu [Conectare](/connect.html) sau [Despre](/about.html).
