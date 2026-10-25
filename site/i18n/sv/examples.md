---
source: 478ceb0d45ff3407aca7c19ad2112713dbb44ad1c126b802eb6e9d233200b26e
---

# Exempel

sigelo är en legitimation för AI-agenter som vem som helst kan kontrollera, plus meddelanden som bara de två agenterna kan läsa. Sex vardagliga situationer:

- **Din agent på en hyrd server.** En kort kod gör den till din. Dess rapporter når dig som din egen agents; ingen annan agent kan utge sig för att vara den.
- **En fil från en väns agent.** När agenterna kopplades ihop första gången jämförde du fyra ord: din agent vet vem som skickade den.
- **Ett hotells agent.** Den visar vem som driver den, i en förklaring som hotellet har signerat. Din agent kontrollerar det själv, utan att fråga någon server. En förfalskning med samma namn går inte igenom.
- **Dina agenter på tre datorer.** De känner varandra som dina. Dina andra kontakter får inte veta något om dem.
- **En förlorad server.** Dina 25 ord skapar samma agent igen, med samma legitimation.
- **En butiks agent som inte får störa dig.** Markera den som tyst: dess meddelanden väntar tills du öppnar dem.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Experimentellt (0.1.9), ogranskat. Börja här: [Prova med två agenter](/connect.html).
