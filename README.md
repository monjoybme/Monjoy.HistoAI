# 🔬 Monjoy.HistoAI — WSI Annotation Platform

[![Deploy to Railway](https://railway.app/button.svg)](https://railway.app/template/monjoy-histoai)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/YOUR_USERNAME/monjoy-histoai)

A browser-based Whole Slide Image (WSI) annotation and visualization platform.

**Key capability: Stream TCGA/GDC slides directly — no download needed.**
Uses HTTP Range requests to fetch only the tiles you're currently viewing
(~50 KB per tile vs ~500 MB for a full SVS download).

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔬 WSI Viewer | OpenSeadragon-based pan/zoom viewer for gigapixel slides |
| ✏️ Annotation Tools | Polygon, Rectangle, Ellipse, Freehand, Point |
| 🧬 TCGA Direct Access | Stream any of 11,000+ TCGA open-access SVS files — no download |
| ☁️ Cloud Streaming | Stream SVS files via HTTP URL without downloading |
| 📁 Local Files | Register local WSI files by path (never copied) |
| ↓ Patch Extraction | Export annotated regions as PNG patches |
| 📊 Export | JSON (re-importable), GeoJSON (QuPath/ASAP), CSV |
| 🔒 Auth Gate | GitHub-based access control |

---

## 🚀 Quick Start (Local)

### Prerequisites

```bash
# macOS
brew install openslide node

# Linux (Ubuntu/Debian)
sudo apt install openslide-tools nodejs npm

# Conda (recommended — fixes library conflicts)
conda install -c conda-forge openslide nodejs
```

### Run

```bash
# 1. Fork this repo, then clone your fork
git clone https://github.com/YOUR_USERNAME/monjoy-histoai
cd monjoy-histoai

# 2. Install dependencies
npm install

# 3. Start
node app.js
# → Open http://localhost:5000
```

On first launch, click **▶ Load Demo Slide** to load a sample H&E slide (7.6 MB, auto-downloads once).

---

## 🧬 Using TCGA Data (No Download Required)

The **🧬 TCGA** tab gives direct access to the NCI Genomic Data Commons:

1. Click the **🧬 TCGA** tab in the left sidebar
2. Select a project (e.g., `TCGA-BRCA — Breast Invasive Carcinoma`)
3. Browse the slide list — each SVS file shows size and case barcode
4. Click **▶ Stream** — the slide opens in the viewer **immediately** using HTTP Range requests (fetches only ~2 MB of metadata, then ~50 KB per visible tile)
5. Click **↓** only if you need the full file locally for offline use

**Open-access slides** (most H&E diagnostics) require no token.
**Controlled-access** slides: paste your [GDC token](https://portal.gdc.cancer.gov) in the token field.

---

## 🌐 Hosting on GitHub + Render (Free, Public URL)

### Step 1 — Fork this repository

Click **Fork** at the top of this page. This creates your own copy at
`https://github.com/YOUR_USERNAME/monjoy-histoai`.

### Step 2 — Deploy to Render (free tier)

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub account and select your fork
3. Render auto-detects `render.yaml` and configures everything
4. Click **Deploy** — your app appears at `https://monjoy-histoai-XXXX.onrender.com`

Or click the button at the top of this README.

### Step 3 — Share your URL

Your live tool URL is:
```
https://monjoy-histoai-XXXX.onrender.com
```

Anyone can visit this URL and use the tool. The app auto-updates when you push changes to your fork.

> **Note:** Render's free tier sleeps after 15 minutes of inactivity. The first request after sleep takes ~30 seconds. Upgrade to Starter ($7/mo) for always-on.

---

## 🚂 Hosting on Railway

Railway offers $5/month free credit (enough for continuous uptime):

1. Fork this repo
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select your fork
4. Railway auto-detects the Dockerfile and deploys
5. Go to **Settings** → **Domains** → **Generate Domain**

To enable auto-deploy on push, add `RAILWAY_TOKEN` to your GitHub repo secrets:
- Settings → Secrets → Actions → `RAILWAY_TOKEN`

---

## 🐳 Docker

```bash
# Build and run locally
docker compose up --build

# Or pull and run (if you've pushed to Docker Hub)
docker run -p 5000:5000 \
  -v $(pwd)/annotations:/app/annotations \
  YOUR_DOCKERHUB_USERNAME/monjoy-histoai:latest
```

---

## 📁 Adding Local Slides

**Option 1 — Browse (macOS native picker):**
Click the **📁 Local** tab → **Browse WSI File**. Native macOS file dialog opens — select your `.svs` / `.ndpi` / `.tiff` file. Original file stays in place.

**Option 2 — Manual path:**
Click **✏ Path** tab → paste the full path, e.g., `/data/slides/tumor.svs`

**Option 3 — Watch folder:**
Click **📁 Local** → **Watch Folder**. All WSI files in that folder become available automatically.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| V | Pan tool |
| P | Polygon |
| R | Rectangle |
| E | Ellipse |
| F | Freehand |
| T | Point |
| S | Select |
| X | Erase |
| 1–6 | Select annotation class |
| Ctrl+Z | Undo |
| Ctrl+Y | Redo |
| Ctrl+S | Save |
| Delete | Delete selected annotation |
| Esc | Cancel drawing |

---

## 📄 Annotation Formats

| Format | Use case |
|--------|----------|
| **JSON** | Re-importable, preserves all data (colors, notes, classes) |
| **GeoJSON** | QuPath, ASAP, PathML compatible |
| **CSV** | Bounding boxes + metadata for ML pipelines |

---

## 🔧 Configuration

| File | Purpose |
|------|---------|
| `slide_registry.json` | Local slide registrations |
| `remote_slide_registry.json` | Streaming (URL-based) slide registrations |
| `config.json` | Watch directories |
| `annotations/*.json` | Annotation data (one file per slide) |

---

## 🧪 Technical Architecture

```
Browser (OpenSeadragon) 
    ↕ WebSocket/HTTP
Node.js (Express)
    ├── Local slides  → OpenSlide (koffi FFI) → libopenslide
    ├── Streaming     → HTTP Range requests → remote SVS/BigTIFF parser
    └── TCGA          → GDC API (search) + Range requests (tiles)
```

**Streaming tile flow:**
1. `/api/tcga/stream` → fetch first 2 MB of GDC file → parse BigTIFF IFDs → extract tile offset table
2. For each viewer tile: `Range: bytes=offset-offset+tileSize` → returns ~50 KB
3. LRU cache (600 tiles) prevents re-fetching during pan/zoom

---

## 📦 Dependencies

```json
{
  "express":  "^4.18",   // HTTP server
  "koffi":    "^2.8",    // FFI for libOpenSlide (local files)
  "sharp":    "^0.33",   // Image encoding (JPEG tiles)
  "multer":   "^1.4",    // File upload handling
  "uuid":     "^9.0"     // Unique ID generation
}
```

System dependency: **OpenSlide** (`brew install openslide` / `apt install libopenslide0`)

---

## 📝 License

MIT — free for academic and commercial use.

---

## 🙏 Acknowledgements

- [OpenSlide](https://openslide.org) — C library for reading WSI formats
- [OpenSeadragon](https://openseadragon.github.io) — deep zoom viewer
- [NCI GDC](https://gdc.cancer.gov) — TCGA data repository and API
- [Carnegie Mellon University](https://openslide.cs.cmu.edu) — OpenSlide test slides
