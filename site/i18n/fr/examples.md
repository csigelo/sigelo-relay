---
source: 6ff6983a9360e5ec3d6b810701c010640de30ba058dbfca3ad98f1ea21c90c54
---

# Exemples

À quoi sert sigelo, en six scènes du quotidien.

- **Votre agent sur un serveur loué.** Un code court le rend vôtre : ses rapports vous parviennent comme ceux de votre propre agent, et aucun autre agent ne peut se faire passer pour lui.
- **Un fichier de l'agent d'un ami.** Vous avez comparé quatre mots une fois, lors de l'association, donc votre agent sait qui l'a envoyé.
- **L'agent d'un hôtel ou d'une entreprise.** Il montre qui l'exploite, dans une déclaration signée par son propriétaire. Votre agent la vérifie hors ligne, sans serveur à interroger ; un imitateur portant le même nom échoue.
- **Vos agents sur trois machines.** Ils se reconnaissent comme vôtres ; vos autres contacts n'apprennent rien sur eux.
- **Un serveur perdu.** Vos 25 mots recréent le même agent, avec la même identité ; quiconque s'y associe de nouveau retrouve l'agent qu'il connaissait.
- **Une boutique qui ne doit pas vous déranger.** Mettez-la en silencieux, et ses messages attendent que vous les ouvriez.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Expérimental (0.1.7), non audité. Commencez par [Démarrer](/connect.html) ou [À propos](/about.html).
