[English](README.md) | Bahasa Indonesia

# Web Asset Studio

Membuat **set aset gambar yang konsisten** (stiker dari foto wajah, banyak ekspresi satu karakter, sprite pixel art, animasi game, ikon pixel untuk web) dengan **akun ChatGPT web Anda sendiri** di chatgpt.com, tanpa OpenAI API berbayar.

Isinya dua bagian:

| Bagian | Tugas |
|---|---|
| **Browser MCP** (Claude in Chrome, atau Agent360 `browser-mcp`) | Mengendalikan chatgpt.com di Chrome yang sudah login: upload referensi, ketik prompt, tunggu, download gambar |
| **MCP `web-asset-studio`** (repo ini) | Semua yang harus pasti benar: folder project, *style bible*, penyusun prompt, ambil file dari Downloads, hapus background, pixel art asli, outline stiker, potong grid, sprite sheet + JSON + GIF |
| **Skill `asset-studio`** | Prosedur untuk agent: kunci karakter (anchor), generate dalam grid, QA tiap hasil, regenerate bila melenceng |

```
foto wajah ──► add_reference ──► project_create (bible) ──► build_prompt
                                                               │
     ┌──────────── browser MCP di chatgpt.com ◄────────────────┘
     │  upload anchor + referensi, ketik prompt, tunggu, download
     ▼
  ingest ──► (agent cek preview) ──► slice_grid ──► process ──► build_spritesheet
                                                       │
                                     raw/ frames/ processed/ sheets/  + project.json
```

**Kenapa hasilnya konsisten:** deskripsi subjek yang sangat detail diulang di setiap prompt, gambar *anchor* yang sudah disetujui selalu ikut di-upload, banyak variasi dibuat dalam **satu gambar grid** (satu kali proses model), satu percakapan ChatGPT per set, dan semua sel diproses dengan langkah yang sama (palet warna dikunci untuk pixel art).

## Perlu diketahui dulu

- **Ketentuan OpenAI.** Terms of Use OpenAI melarang mengambil output layanan secara otomatis/programatik. Mengotomasi chatgpt.com memakai akun Anda adalah area abu-abu, dan risikonya (pembatasan atau penangguhan akun) ada pada Anda. Skill ini sengaja berjalan pelan: satu gambar sekali jalan, berhenti saat kena limit, dan tidak pernah melewati login/CAPTCHA (itu diserahkan ke Anda).
- **Limit.** Akun gratis punya kuota gambar harian yang kecil; akun Plus jauh lebih longgar. Grid 3x3 = 9 aset per satu kuota gambar, jadi pakai grid.
- **Privasi.** Foto wajah Anda dikirim ke OpenAI saat di-upload ke ChatGPT.
- **Video** (Sora) tergantung paket akun Anda dan UI-nya berbeda; repo ini menyimpan video dan memecahnya jadi frame (perlu ffmpeg), tapi alur browser-nya belum diuji.

## Instalasi

Prasyarat: **Node.js 18.17+**, Google Chrome yang sudah login chatgpt.com, dan **salah satu** browser MCP.

### 1. Browser MCP (pilih satu)

**Claude in Chrome** (untuk Claude Code / Claude Desktop): pasang ekstensi Claude in Chrome dan hubungkan ke Claude.

**Agent360 Browser MCP** (untuk Claude Code, Cursor, Codex, VS Code, dll):
```bash
claude mcp add --scope user browser-mcp -- npx @agent360/browser-mcp@latest
```
lalu pasang ekstensinya dari Chrome Web Store ("Agent360 Browser MCP"). Untuk upload foto referensi, buka `chrome://extensions` → Agent360 Browser MCP → Details → aktifkan **Allow access to file URLs**.

### 2a. Claude Code: pasang sebagai plugin (MCP + skill sekaligus)

```bash
claude plugin marketplace add EgiStr/web-asset-studio
```
```bash
claude plugin install web-asset-studio@web-asset-studio
```
Restart Claude Code. 
Tidak perlu `npm install`: server sudah dibundle jadi satu file `dist/server.mjs` tanpa dependency native.

### 2b. Klien MCP lain (Claude Desktop, Cursor, Codex, VS Code, Windsurf)

Tambahkan server ini ke konfigurasi MCP klien Anda (sesuaikan path):
```json
{
  "mcpServers": {
    "web-asset-studio": {
      "command": "node",
      "args": ["/path/to/web-asset-studio/dist/server.mjs"],
      "env": { "ASSET_STUDIO_ROOT": "/path/to/your/project/asset-studio" }
    }
  }
}
```
Klien tanpa sistem skill bisa memanggil MCP prompt **`asset_studio_workflow`**: isinya prosedur lengkap yang sama dengan skill.

### Variabel lingkungan (opsional)

| Variabel | Default | Fungsi |
|---|---|---|
| `ASSET_STUDIO_ROOT` | `<folder project>/asset-studio` | Tempat semua aset disimpan |
| `ASSET_STUDIO_DOWNLOADS` | `~/Downloads` | Folder download Chrome yang dipantau |
| `ASSET_STUDIO_FFMPEG` | `ffmpeg` dari PATH | Untuk `video_to_frames` |

Di Chrome, matikan **"Ask where to save each file before downloading"** (Settings → Downloads), dan klik **Allow** saat Chrome bertanya "Download multiple files".

## Cara pakai (contoh perintah ke Claude)

> Pakai asset-studio. Ini foto saya: `D:/foto/saya.jpg`. Buatkan 18 stiker chibi dengan ekspresi berbeda, background transparan, outline putih, ukuran 512 px.

> Buat karakter pixel art 48 px dari foto saya, lalu animasi idle 4 frame dan walk cycle 8 frame ke kanan, jadikan sprite sheet untuk Phaser.

> Buat 16 ikon pixel 32 px untuk website game bertani: koin, benih, penyiram, cangkul, ... dengan palet yang sama.

Agent akan: menulis style bible dari foto → membuat satu gambar anchor dan meminta persetujuan Anda → generate grid → mengecek tiap hasil → memotong, membersihkan, dan mengemas.

Hasil di `asset-studio/<project>/`:
```
project.json   bible, palet, anchor, semua aset beserta prompt + link chat ChatGPT
refs/          foto referensi
raw/           hasil download ChatGPT, asli
frames/        sel hasil potong grid / frame video
processed/     PNG final (transparan, rapi, ukuran seragam)
sheets/        sprite sheet .png + atlas .json + preview .gif
video/         video hasil download
```

## Daftar tool MCP

| Tool | Fungsi |
|---|---|
| `studio_info` | Lokasi root, folder Downloads, ffmpeg, daftar project |
| `project_create` / `project_get` / `project_update` | Project + style bible (subjek, gaya, palet, background, aturan), setting pixel |
| `add_reference` | Salin foto/gaya referensi ke `refs/` |
| `set_anchor` | Tandai aset yang disetujui sebagai referensi wajib untuk generate berikutnya |
| `build_prompt` | Susun prompt `single` / `grid` / `animation` / `variation` + daftar file yang harus di-upload; memberi `prompt_one_line` agar Enter tidak terkirim di tengah prompt |
| `ingest` | Simpan hasil dari download Chrome (dipindah dari Downloads), URL, atau path lokal; mengembalikan preview |
| `slice_grid` | Potong gambar grid jadi sel-sel bernama |
| `process` | Langkah berurutan pada file raw: `remove_bg` (flood fill dari tepi, aman untuk putih mata; mendeteksi checkerboard palsu), `trim` (termasuk `group` untuk animasi), `crop`, `resize`, `fit`, `scale`, `pixelate` (downscale area ke grid asli + palet terkunci/bersama), `outline` (border stiker) |
| `build_spritesheet` | Sprite sheet sel seragam + atlas JSON (format TexturePacker hash, untuk Phaser/Pixi; frameWidth/Height untuk Godot/Unity) + GIF |
| `video_to_frames` | Pecah video jadi frame PNG (perlu ffmpeg) |

## Pengembangan

```bash
npm install
```
```bash
npm test
```
```bash
npm run build
```

`npm test` (otomatis build dulu) menjalankan 18 test: pengolahan gambar dengan gambar sintetis (background checkerboard, pixel art yang tidak sejajar grid, subjek yang terpotong di tepi, sheet grid), pipeline lengkap dari folder Downloads palsu, dan server hasil bundle yang dijalankan tanpa `node_modules` lewat client MCP sungguhan. Setelah mengubah `src/`, jalankan `npm run build` dan commit `dist/server.mjs` (plugin memakai file itu langsung).

Bagian yang belum bisa diuji otomatis adalah halaman chatgpt.com itu sendiri: selector di `skills/asset-studio/references/chatgpt-web.md` hanya petunjuk, dan agent diminta mencari elemen di halaman yang sebenarnya. Kalau UI ChatGPT berubah, yang perlu diperbarui hanya file markdown itu.

## Lisensi

MIT
