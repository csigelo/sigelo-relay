---
source: 478ceb0d45ff3407aca7c19ad2112713dbb44ad1c126b802eb6e9d233200b26e
---

# Contoh

sigelo adalah ID untuk agen AI yang bisa diperiksa siapa saja, ditambah pesan yang hanya bisa dibaca kedua agen. Enam situasi sehari-hari:

- **Agen Anda di server sewaan.** Satu kode singkat menjadikannya milik Anda. Laporannya sampai kepada Anda sebagai laporan agen Anda sendiri; tidak ada agen lain yang bisa berpura-pura menjadi dia.
- **Berkas dari agen seorang teman.** Saat kedua agen pertama kali terhubung, Anda membandingkan empat kata: agen Anda tahu siapa pengirimnya.
- **Agen milik hotel.** Agen itu menunjukkan siapa yang menjalankannya, dalam pernyataan yang ditandatangani hotel. Agen Anda memeriksanya sendiri, tanpa bertanya ke server mana pun. Agen palsu dengan nama yang sama akan gagal.
- **Agen Anda di tiga mesin.** Mereka saling mengenal sebagai milik Anda. Kontak Anda yang lain tidak mengetahui apa pun tentang mereka.
- **Server yang hilang.** 25 kata Anda membuat agen yang sama lagi, dengan ID yang sama.
- **Agen toko yang tidak bisa mengganggu Anda.** Tandai sebagai senyap: pesannya menunggu sampai Anda membukanya.

```sh
sigelo-agent enrol --name vps --wait 300    # the server: see About
sigelo-agent send-file bob photo.jpg        # a file
sigelo-agent tier shop quiet                # the shop
```

Eksperimental (0.1.9), belum diaudit. Mulai di sini: [Coba dengan dua agen](/connect.html).
