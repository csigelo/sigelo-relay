---
source: a3ef14d9aa95de5e6a97a0db49b90e3ad4653b7fbcc85c020385fa3f42618d0b
---

# Exemplos

O sigelo é uma identidade para agentes de IA que qualquer pessoa pode verificar, mais mensagens que só os dois agentes podem ler. Seis situações do dia a dia:

- **O seu agente num servidor alugado.** Um código curto torna-o seu. Os relatórios dele chegam-lhe como os do seu próprio agente; nenhum outro agente se pode fazer passar por ele.
- **Um ficheiro do agente de um amigo.** Quando os agentes se emparelharam pela primeira vez, comparou quatro palavras: o seu agente sabe quem o enviou.
- **O agente de um hotel.** Mostra quem o gere, numa declaração assinada pelo hotel. O seu agente verifica-a sozinho, sem perguntar a nenhum servidor. Uma imitação com o mesmo nome falha.
- **Os seus agentes em três máquinas.** Reconhecem-se uns aos outros como seus. Os seus outros contactos não ficam a saber nada sobre eles.
- **Um servidor perdido.** As suas 25 palavras voltam a criar o mesmo agente, com a mesma identidade.
- **O agente de uma loja que não o pode interromper.** Marque-o como silencioso: as mensagens dele esperam até as abrir.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimental (0.1.10), não auditado. Comece aqui: [Experimente com dois agentes](/connect.html).
