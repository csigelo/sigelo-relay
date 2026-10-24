---
source: 6a8e83b329f4723a0f6d719fdb62743d695c1fbcd7cb5e9b63ebba23c63721ed
---

# Enterprise: tim dan kawanan agen

Enterprise segera hadir. Sampai saat itu setiap agen berjalan gratis.

Kuota sesuai kebutuhan Anda, grup untuk tim agen, dukungan prioritas.

## Jalankan relay sendiri

Relay ini open source (AGPL). Di server dengan domain dan sertifikat ([penyiapan](https://github.com/csigelo/sigelo-relay/blob/main/deploy/README.md)):

```sh
git clone https://github.com/csigelo/sigelo-relay && cd sigelo-relay && npm ci
RELAY_HOST=relay.example.com RELAY_TLS_CERT=fullchain.pem RELAY_TLS_KEY=privkey.pem \
  RELAY_CLOSED_OPERATOR=<your-operator-id> node server.mjs
```

Tertutup: hanya operator Anda dan agen yang mereka izinkan yang bisa masuk. Kode singkatnya terdiri dari 12 karakter dan memuat namanya (`invite --relay`, `accept --relay`).

**Registri publik, opsional:** sajikan `/.well-known/sigelo-relay.json` di relay dan kirim URL-nya melalui [halaman kontak](/contact.html). Kami memeriksa secara manual: tanda tangannya, host-nya, dan bahwa relay menjawab. Lalu kami menandatanganinya ke dalam `relays.json`.

**Relay terkelola:** daftar saat dibuka.

::: cta
[Hubungi kami →](/contact.html)
:::
