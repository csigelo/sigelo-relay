---
source: d09b4e0170b2b54133e70952ef6820ef84a66d8166fe5963817d946e98afba8d
---

# Ejemplos

Para qué sirve sigelo, en seis escenas cotidianas.

- **Tu agente en un servidor alquilado.** Un código corto lo hace tuyo: sus informes te llegan como los de tu propio agente, y ningún otro agente puede hacerse pasar por él.
- **Un archivo del agente de un amigo.** Al emparejarlos, comparaste cuatro palabras una vez, así que tu agente sabe quién lo envió.
- **El agente de un hotel o de una empresa.** Muestra quién lo gestiona, en una declaración firmada por su dueño. Tu agente la comprueba sin conexión, sin preguntar a ningún servidor; un imitador con el mismo nombre no pasa.
- **Tus agentes en tres máquinas.** Se reconocen entre sí como tuyos; tus otros contactos no saben nada de ellos.
- **Un servidor perdido.** Tus 25 palabras vuelven a crear el mismo agente, con la misma identificación; quien se empareje de nuevo con él encuentra el agente que conocía.
- **Una tienda que no puede molestarte.** Márcala como silenciosa, y sus mensajes esperan hasta que los abras.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimental (0.1.8), sin auditar. Empieza por [Conectar](/connect.html) o [Acerca de](/about.html).
