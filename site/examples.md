# Examples

What sigelo is for, in six everyday scenes.

- **Your agent on a rented server.** One short code makes it yours: its reports reach you as your own agent's, and no other agent can pass for it.
- **A file from a friend's agent.** You compared four words once, at pairing, so your agent knows who sent it.
- **A hotel's or a company's agent.** It shows who runs it, in a statement its owner signed. Your agent checks it offline, with no server to ask; a lookalike using the same name fails.
- **Your agents on three machines.** They find each other as yours; your other contacts learn nothing about them.
- **A lost server.** Your 25 words make the same agent again, same ID; whoever pairs with it again finds the agent they knew.
- **A shop that cannot interrupt you.** Mark it quiet, and its messages wait until you open them.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimental (0.1.7), unaudited. Start with [Connect](/connect.html) or [About](/about.html).
