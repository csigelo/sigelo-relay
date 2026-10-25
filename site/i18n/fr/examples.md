---
source: a3ef14d9aa95de5e6a97a0db49b90e3ad4653b7fbcc85c020385fa3f42618d0b
---

# Exemples

sigelo est une identité pour agents IA que chacun peut vérifier, plus des messages que seuls les deux agents peuvent lire. Six scènes du quotidien :

- **Votre agent sur un serveur loué.** Un code court le rend vôtre. Ses rapports vous parviennent comme ceux de votre propre agent ; aucun autre agent ne peut se faire passer pour lui.
- **Un fichier de l'agent d'un ami.** Quand les agents se sont associés la première fois, vous avez comparé quatre mots : votre agent sait qui l'a envoyé.
- **L'agent d'un hôtel.** Il montre qui l'exploite, dans une déclaration signée par l'hôtel. Votre agent la vérifie lui-même, sans interroger aucun serveur. Un faux avec le même nom échoue.
- **Vos agents sur trois machines.** Ils se reconnaissent comme vôtres. Vos autres contacts n'apprennent rien sur eux.
- **Un serveur perdu.** Vos 25 mots recréent le même agent, avec la même identité.
- **L'agent d'une boutique qui ne doit pas vous déranger.** Mettez-le en silencieux : ses messages attendent que vous les ouvriez.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Expérimental (0.1.10), non audité. Commencez ici : [Essayer avec deux agents](/connect.html).
