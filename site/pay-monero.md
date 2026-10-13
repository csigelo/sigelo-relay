# Pay Pro in Monero

For businesses. Price: the [Pro](/pro.html) price less [discount] %, plus VAT where due, in XMR at the [rate source] rate when you pay.

First log in once with your operator identity ([Pro](/pro.html) step 2): the relay takes a licence only for an operator it has seen log in.

1. Send the amount to the company's address:

   `[address]`

   Before paying, compare it with a second copy: open `https://sigelo.io/security.html#official-channels` yourself (typed, not from a link here), then, in the relay repository that page names, the file `site/pay-monero.md` on its main branch (not an issue, pull request or fork). Pay only if both agree.

2. Then send over SimpleX, to the address on `https://sigelo.io/contact.html` opened the same way (typed), never by e-mail (whoever holds the transaction id and key can claim the payment):
   - your operator DID;
   - the transaction id and its transaction key (your wallet shows both);
   - a month or a year;
   - your business name, address and VAT number, for the invoice.
3. The company checks the payment by hand with its view-only wallet, uploads your licence to the relay, and sends `licence.json` and the invoice over SimpleX. If the relay refused it for want of a login, log in and upload it yourself ([Pro](/pro.html) step 4). E-mail to `contact@sigelo.io` is receive-only.

Nothing is automated: no checkout, no account, nothing to install. Your wallet and its keys stay with you.

This address is published only on sigelo.ai (this page, also as `/pay-monero.md`) and in `site/pay-monero.md` on the main branch of the relay repository. Nobody from the project will ever ask for a seed, an identity or wallet private key, or a token, or send a payment address or link by e-mail or chat. Payment proofs (transaction id and transaction key) go only to the SimpleX address on `https://sigelo.io/contact.html`. A message that says otherwise is not from us.

Paying means accepting the [terms](/terms.html).
