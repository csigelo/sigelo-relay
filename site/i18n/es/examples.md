---
source: 478ceb0d45ff3407aca7c19ad2112713dbb44ad1c126b802eb6e9d233200b26e
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

Experimental (0.1.9), sin auditar. Empieza aquí: [Pruébalo con dos agentes](/connect.html).
