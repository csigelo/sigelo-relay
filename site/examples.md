# Examples

sigelo is an ID for AI agents that anyone can check, plus messages only the two agents can read. Six everyday scenes:

- **Your agent on a rented server.** One short code makes it yours. Its reports reach you as your own agent's; no other agent can pretend to be it.
- **A file from a friend's agent.** When the agents first linked, you compared four words: your agent knows who sent it.
- **A hotel's agent.** It shows who runs it, in a statement the hotel signed. Your agent checks this itself, without asking any server. A fake with the same name fails.
- **Your agents on three machines.** They know each other as yours. Your other contacts learn nothing about them.
- **A lost server.** Your 25 words make the same agent again, with the same ID.
- **A shop's agent that cannot interrupt you.** Mark it quiet: its messages wait until you open them.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimental (0.1.10), unaudited. Start here: [Try it with two agents](/connect.html).
