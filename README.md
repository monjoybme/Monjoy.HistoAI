---
title: Monjoy HistoAI
emoji: 🔬
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
license: mit
---

<div align="center">

<img src="https://img.shields.io/badge/Platform-Browser--based-00d4ff?style=flat-square"/>
<img src="https://img.shields.io/badge/Runtime-Node.js%2020-339933?style=flat-square&logo=node.js"/>
<img src="https://img.shields.io/badge/OpenSlide-FFI%20%2F%20koffi-a78bfa?style=flat-square"/>
<img src="https://img.shields.io/badge/Data-NCI%20GDC%20%2F%20TCGA-22c55e?style=flat-square"/>
<img src="https://img.shields.io/badge/License-MIT-f97316?style=flat-square"/>

</div>

---

# Monjoy.HistoAI — Whole Slide Image Annotation Platform

**Monjoy.HistoAI** is a browser-based annotation platform for Whole Slide Images (WSI) in computational pathology. It provides direct streaming access to the NCI GDC / TCGA repository without requiring full file downloads, combined with a complete set of annotation, analysis, and patch extraction tools — all running as a single Node.js application with zero Python dependencies.

---

## Key Features

### 🧬 TCGA / NCI GDC Integration
- Direct streaming of SVS slides from all 33 TCGA cancer projects via HTTP Range requests — no full download required
- Open-access slides load instantly; controlled-access slides supported with GDC authentication token
- Built-in project browser, case ID search, and pagination across thousands of slides
- Fallback download mode for offline use

### ✏️ Annotation Tools
- **Polygon** — arbitrary boundary tracing with vertex editing
- **Rectangle** — bounding box annotation
- **Ellipse** — elliptical region marking
- **Freehand** — continuous brush-style drawing
- **Point** — single-point markers for cell-level annotation
- **Select / Erase** — annotation selection, editing, and deletion
- Full undo/redo stack, keyboard shortcuts, and per-class colour coding

### 📁 Slide Loading
- Browser-based file picker — works on local deployments and cloud (HF Spaces)
- Folder browse — loads all WSIs from a selected directory at once
- HTTP URL streaming — stream any remote SVS/TIFF without downloading
- Google Drive, Box, OneDrive shared-link download
- Drag-and-drop support

### 📊 Export & Import
| Format | Use Case |
|--------|----------|
| **JSON** | Full round-trip re-import; preserves classes, colours, notes |
| **GeoJSON** | Compatible with QuPath, ASAP, PathML |
| **CSV** | Bounding boxes and metadata for downstream analysis |

### 🔲 Patch Extraction
- Extracts image patches from annotated regions at any resolution level
- Configurable patch size (32–4096 px), overlap threshold, and output subfolder
- Organised by annotation class in subdirectories
- **ZIP download** — download all extracted patches directly to local machine via browser Save dialog
- **Open Folder** — reveal patch output in Finder / File Explorer (local deployments)

### 🔍 Blurriness Detection
- Laplacian variance analysis at configurable threshold
- Identifies out-of-focus regions before annotation or extraction

---

## Supported File Formats

`.svs` · `.ndpi` · `.tiff` / `.tif` · `.mrxs` · `.czi` · `.scn` · `.vms` · `.vmu` · `.svslide`

---

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Server | Node.js 20 / Express |
| Slide rendering | OpenSlide C library via koffi FFI (zero Python) |
| Image processing | sharp (libvips) |
| Tile viewer | OpenSeadragon 4.1 |
| TCGA streaming | HTTP Range requests / BigTIFF parser |
| Deployment | Docker · Hugging Face Spaces · Render |

---

## Quick Start (Local)

**Prerequisites:** Node.js 20+, OpenSlide C library

```bash
# macOS
brew install openslide

# Ubuntu / Debian
sudo apt install libopenslide0

# Clone and run
git clone https://github.com/monjoybme/Monjoy.HistoAI.git
cd Monjoy.HistoAI
npm install
node app.js
# → http://localhost:7860
```

---

## Docker

```bash
docker build -t monjoy-histoai .
docker run -p 7860:7860 monjoy-histoai
```

---

## Usage Guide

### Streaming TCGA Slides
1. Open the **🧬 TCGA** tab in the left sidebar
2. Select a cancer project from the dropdown (e.g. `TCGA-BRCA — Breast Invasive Carcinoma`)
3. Browse or search by case ID / file name
4. Click **▶ Stream** — the slide opens immediately with no download

> Open-access slides require no authentication. For controlled-access files, paste your GDC token (obtainable at [portal.gdc.cancer.gov](https://portal.gdc.cancer.gov)) into the token field.

### Annotating a Slide
1. Select an annotation class from the right sidebar (or add a custom class)
2. Choose a drawing tool from the toolbar or use keyboard shortcuts:
   `V` Pan · `P` Polygon · `R` Rectangle · `E` Ellipse · `F` Freehand · `T` Point · `S` Select · `X` Erase
3. Draw on the slide — annotations auto-save every 800 ms
4. Export via **↑ Export** in the top bar

### Extracting Patches
1. Draw annotations on a loaded slide
2. In the right sidebar under **Patch Extraction**, configure patch size and resolution level
3. Click **⬇ Extract Patches**
4. When complete, click **⬇ Download ZIP** to save all patches to your local machine

---

## TCGA Cancer Projects

All 33 TCGA projects are supported, including:

`TCGA-BRCA` · `TCGA-LUAD` · `TCGA-LUSC` · `TCGA-COAD` · `TCGA-GBM` · `TCGA-OV` · `TCGA-KIRC` · `TCGA-HNSC` · `TCGA-LGG` · `TCGA-THCA` · `TCGA-PRAD` · `TCGA-STAD` · `TCGA-SKCM` · `TCGA-BLCA` · `TCGA-LIHC` · and 18 more

Full project list available in the TCGA tab within the application.

---

## Architecture

```
Monjoy.HistoAI
├── app.js                  Single-file Node.js/Express server
├── annotations/            JSON annotation files (per slide)
├── patches/                Extracted patch images (organised by class)
├── static/thumbnails/      Cached slide thumbnails
└── ~/.monjoyai/cache/      Downloaded TCGA / cloud slides
```

- **Zero-copy slide access** — local WSI files are never moved or duplicated; registered by path reference only
- **Streaming engine** — custom BigTIFF IFD parser fetches individual tile byte ranges (~50 KB per tile) rather than downloading full slide files (often 500 MB–2 GB)
- **LRU tile cache** — 600-tile in-memory cache minimises repeat range requests during pan/zoom

---

## Contributing

Issues and pull requests are welcome at [github.com/monjoybme/Monjoy.HistoAI](https://github.com/monjoybme/Monjoy.HistoAI).

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Acknowledgements

- [OpenSlide](https://openslide.org) — C library for reading whole-slide images
- [NCI Genomic Data Commons](https://gdc.cancer.gov) — TCGA data access
- [OpenSeadragon](https://openseadragon.github.io) — deep zoom tile viewer
- [sharp](https://sharp.pixelplumbing.com) — high-performance image processing
