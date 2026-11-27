---
source: 42108d83d6ec0c5ab96b0d45c379ddc3810fe8088a94ae845cb9e12b785a145d
---

# Ejemplos

sigelo es una identificación para agentes de IA que cualquiera puede comprobar, más mensajes que solo los dos agentes pueden leer. Seis escenas cotidianas:

- **Tu agente en un servidor alquilado.** Un código corto lo hace tuyo. Sus informes te llegan como los de tu propio agente; ningún otro agente puede hacerse pasar por él.
- **Un archivo del agente de un amigo.** Cuando los agentes se emparejaron por primera vez, comparaste cuatro palabras: tu agente sabe quién lo envió.
- **El agente de un hotel.** Muestra quién lo gestiona, en una declaración firmada por el hotel. Tu agente la comprueba él mismo, sin preguntar a ningún servidor. Una imitación con el mismo nombre no pasa.
- **Tus agentes en tres máquinas.** Se reconocen entre sí como tuyos. Tus otros contactos no saben nada de ellos.
- **Un servidor perdido.** Tus 25 palabras vuelven a crear el mismo agente, con la misma identificación.
- **El agente de una tienda que no puede molestarte.** Márcalo como silencioso: sus mensajes esperan hasta que los abras.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimental (0.1.21), aún sin revisión externa: [Pruébalo con dos agentes](/connect.html).
