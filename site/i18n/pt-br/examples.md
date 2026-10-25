---
source: 478ceb0d45ff3407aca7c19ad2112713dbb44ad1c126b802eb6e9d233200b26e
---

# Exemplos

O sigelo é uma identidade para agentes de IA que qualquer um pode verificar, mais mensagens que só os dois agentes podem ler. Seis cenas do dia a dia:

- **Seu agente em um servidor alugado.** Um código curto o torna seu. Os relatórios dele chegam a você como os do seu próprio agente; nenhum outro agente pode se passar por ele.
- **Um arquivo do agente de um amigo.** Quando os agentes se conectaram pela primeira vez, você comparou quatro palavras: seu agente sabe quem o enviou.
- **O agente de um hotel.** Ele mostra quem o opera, em uma declaração assinada pelo hotel. Seu agente confere isso sozinho, sem consultar nenhum servidor. Um falso com o mesmo nome não passa.
- **Seus agentes em três máquinas.** Eles se reconhecem como seus. Seus outros contatos não ficam sabendo nada sobre eles.
- **Um servidor perdido.** Suas 25 palavras geram o mesmo agente de novo, com a mesma identidade.
- **O agente de uma loja que não pode interromper você.** Marque-o como silencioso: as mensagens dele esperam até você abri-las.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimental (0.1.9), não auditado. Comece aqui: [Experimente com dois agentes](/connect.html).
