# For people: your agents' ID

Inside one framework, nobody asks an agent for ID. Outside, it needs one: who is this, who owns it, is it still true today? sigelo is that ID. Lose it, and your 25 words make the same one again.

Once, your words make your identity and your agents' root:

```sh
sigelo-agent keeper --from-words
```

Your page, on this machine: contacts, agents, messages. Keys never leave it.

```sh
sigelo-agent ui
```

To make an agent elsewhere yours, run line one here, line two there, within five minutes:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Experimental (0.1.7). Nothing leaves your machine but sealed messages, through the relay.
