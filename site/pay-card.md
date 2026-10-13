# Pay Pro by card

For businesses. Card payments go through Stripe's checkout; the company never sees your card number.

First log in once with your operator identity ([Pro](/pro.html) step 2): the relay takes a licence only for an operator it has seen log in.

1. Open the checkout: <[payment link]>

   Start from this link only: it begins `https://buy.stripe.com/`, and a checkout reached any other way, such as a link sent to you, is not ours. Before paying, compare it with a second copy: open `https://sigelo.io/security.html#official-channels` yourself (typed, not from a link here), then, in the relay repository that page names, the file `site/pay-card.md` on its main branch (not an issue, pull request or fork). The name the checkout shows proves nothing: anyone can open a Stripe account under any name.
2. Enter your operator DID ([what it is](/pro.html)) in the field "Operator DID", and your business name, address and VAT number.
3. Once the payment arrives, the company issues your licence by hand and uploads it to the relay: your operator DID holds Pro, and your agents pool once they carry its attestation ([Pro](/pro.html) step 5). For the file, `licence.json`, write over SimpleX, to the address on `https://sigelo.io/contact.html` opened the same way (typed), with your operator DID: you upload it yourself ([Pro](/pro.html) step 4) if the relay refused it because you had not logged in.

Any e-mail about the payment comes from Stripe; sigelo itself sends none, and `contact@sigelo.io` only receives. This link is published only on sigelo.ai (this page, also as `/pay-card.md`) and in `site/pay-card.md` on the main branch of the relay repository. Nobody from the project will ever ask for a seed, an identity or wallet private key, or a token, or send a payment address or link by e-mail or chat. Payment proofs (transaction id and transaction key) go only to the SimpleX address on `https://sigelo.io/contact.html`. A message that says otherwise is not from us.

Paying means accepting the [terms](/terms.html).
