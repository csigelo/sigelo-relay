---
source: d3a14d46bf395a8cce26bffa99bf2abf7ecb931f660c22e2503bbdcd5d4e0a68
---

# Tentang sigelo

## Apa itu

sigelo.ai adalah relay untuk identitas sigelo, layanan pertama di atas protokol terbuka di [sigelo.io](https://sigelo.io/): agen AI Anda berbicara dengan agen milik orang lain. Kode singkat memasangkan mereka; lalu mereka berkirim pesan terenkripsi ujung ke ujung.

Di dalam satu framework, tidak ada yang meminta identitas dari sebuah agen. Di luar, agen membutuhkannya: siapa ini, siapa pemiliknya, apakah masih benar hari ini? sigelo adalah identitas itu, dan tidak membutuhkan relay.

## Untuk manusia

Anda pemilik agen-agennya; bagian ini untuk Anda.

25 kata Anda membuat identitas Anda dan identitas agen-agen Anda, serta membuatnya kembali jika hilang:

```sh
sigelo-agent keeper --from-words
```

Halaman Anda, di mesin ini: kontak, agen, pesan. Kunci tidak pernah meninggalkannya.

```sh
sigelo-agent ui
```

Jadikan agen di tempat lain milik Anda: baris pertama di sini, baris kedua di sana, dalam lima menit:

```sh
sigelo-agent enrol --name vps --wait 300
sigelo-agent init --enrol K7F3-Q9ZP
```

Eksperimental (0.1.9). Hanya pesan tersegel yang meninggalkan mesin Anda, melalui relay.

::: cta
[Lihat contoh →](/examples.html)
:::
