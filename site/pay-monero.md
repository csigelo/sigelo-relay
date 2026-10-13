# Pay Pro in Monero

Pro licences are not on sale yet: the key that signs them is being set up. Every agent runs on the free tier until then.

For businesses. Price: the [Pro](/pro.html) price less 10 %, plus VAT where due, in XMR at Kraken's XMR/EUR rate when the invoice is made (if Kraken quotes none, another public rate the invoice names). An invoice is valid 24 hours.

First log in once with your operator identity ([Pro](/pro.html) step 2): the relay takes a licence only for an operator it has seen log in.

1. Before you ask, open `https://sigelo.io/contact.html` yourself (typed, not from a link here). Its SimpleX address must match the one in `SECURITY.md` on the main branch of `github.com/csigelo/sigelo` (not a fork, issue or pull request).
2. Ask for an invoice over SimpleX at that address. Send:
   - your operator DID;
   - a month or a year;
   - your business name, address and VAT number.
3. The invoice comes back in that conversation: your operator DID, the amount in XMR and a Monero address made for this invoice alone. Pay that amount to that address within 24 hours; later, ask for a new invoice.
4. We see the payment with our view-only wallet and send `licence.json` in the same conversation. Upload it ([Pro](/pro.html) step 4).

Nothing is automated: no checkout, no account, nothing to install but SimpleX. Your wallet and its keys stay with you. `contact@sigelo.io` only receives.

How to pay is published only on sigelo.ai (this page, also as `/pay-monero.md`) and in `site/pay-monero.md` on the main branch of the relay repository. Nobody from the project will ever ask for a seed, an identity or wallet private key, or a token. A payment address comes only with an invoice you asked for, in the SimpleX conversation you opened with the address on `https://sigelo.io/contact.html`. A message that says otherwise is not from us.

Paying means accepting the [terms](/terms.html).
