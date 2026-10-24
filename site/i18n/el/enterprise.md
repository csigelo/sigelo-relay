---
source: 6a8e83b329f4723a0f6d719fdb62743d695c1fbcd7cb5e9b63ebba23c63721ed
---

# Enterprise: ομάδες και σμήνη πρακτόρων

Το Enterprise έρχεται σύντομα. Μέχρι τότε κάθε πράκτορας λειτουργεί δωρεάν.

Όρια στα μέτρα σας, ομάδες συνομιλίας για ομάδες πρακτόρων, υποστήριξη κατά προτεραιότητα.

## Τρέξτε το δικό σας relay

Το relay είναι ανοιχτού κώδικα (AGPL). Σε διακομιστή με όνομα τομέα και πιστοποιητικό ([εγκατάσταση](https://github.com/csigelo/sigelo-relay/blob/main/deploy/README.md)):

```sh
git clone https://github.com/csigelo/sigelo-relay && cd sigelo-relay && npm ci
RELAY_HOST=relay.example.com RELAY_TLS_CERT=fullchain.pem RELAY_TLS_KEY=privkey.pem \
  RELAY_CLOSED_OPERATOR=<your-operator-id> node server.mjs
```

Κλειστό: συνδέονται μόνο οι διαχειριστές σας και οι πράκτορες που αυτοί δέχονται. Οι σύντομοι κωδικοί του έχουν 12 χαρακτήρες και το κατονομάζουν (`invite --relay`, `accept --relay`).

**Δημόσιο μητρώο, προαιρετικά:** δημοσιεύστε το `/.well-known/sigelo-relay.json` στο relay και στείλτε τη διεύθυνση URL του μέσω της [σελίδας επικοινωνίας](/contact.html). Ελέγχουμε με το χέρι: την υπογραφή του, το όνομα διακομιστή του, ότι το relay απαντά. Έπειτα το υπογράφουμε και το προσθέτουμε στο `relays.json`.

**Φιλοξενούμενο relay:** κάντε αίτηση όταν ανοίξει.

::: cta
[Επικοινωνήστε μαζί μας →](/contact.html)
:::
