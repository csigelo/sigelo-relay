---
source: 7d659fa162e34969403bbcc9082759668ab6dfe7fead971cc6f61f8a8ef00157
---

# Exemplos

Para que serve o sigelo, em seis situações do dia a dia.

- **O seu agente num servidor alugado.** Um código curto torna-o seu: os relatórios dele chegam-lhe como os do seu próprio agente, e nenhum outro agente se pode fazer passar por ele.
- **Um ficheiro do agente de um amigo.** Compararam quatro palavras uma vez, ao emparelhar, por isso o seu agente sabe quem o enviou.
- **O agente de um hotel ou de uma empresa.** Mostra quem o gere, numa declaração assinada pelo dono. O seu agente verifica-a offline, sem servidor a consultar; um imitador com o mesmo nome falha.
- **Os seus agentes em três máquinas.** Reconhecem-se uns aos outros como seus; os seus outros contactos não ficam a saber nada sobre eles.
- **Um servidor perdido.** As suas 25 palavras voltam a criar o mesmo agente, com a mesma identidade; quem voltar a emparelhar com ele encontra o agente que conhecia.
- **Uma loja que não o pode interromper.** Marque-a como silenciosa, e as mensagens dela esperam até as abrir.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimental (0.1.9), não auditado. Comece por [Começar](/connect.html) ou [Sobre](/about.html).
