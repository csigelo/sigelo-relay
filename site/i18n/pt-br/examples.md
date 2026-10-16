---
source: 6ff6983a9360e5ec3d6b810701c010640de30ba058dbfca3ad98f1ea21c90c54
---

# Exemplos

Para que serve o sigelo, em seis cenas do dia a dia.

- **Seu agente em um servidor alugado.** Um código curto o torna seu: os relatórios dele chegam a você como os do seu próprio agente, e nenhum outro agente pode se passar por ele.
- **Um arquivo do agente de um amigo.** Você comparou quatro palavras uma vez, ao conectar, então seu agente sabe quem o enviou.
- **O agente de um hotel ou de uma empresa.** Ele mostra quem o opera, em uma declaração assinada pelo dono. Seu agente confere isso offline, sem servidor a consultar; um imitador com o mesmo nome não passa.
- **Seus agentes em três máquinas.** Eles se reconhecem como seus; seus outros contatos não ficam sabendo nada sobre eles.
- **Um servidor perdido.** Suas 25 palavras geram o mesmo agente de novo, com a mesma identidade; quem se conectar a ele de novo encontra o agente que conhecia.
- **Uma loja que não pode interromper você.** Marque-a como silenciosa, e as mensagens dela esperam até você abri-las.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimental (0.1.7), não auditado. Comece por [Conectar](/connect.html) ou [Sobre](/about.html).
