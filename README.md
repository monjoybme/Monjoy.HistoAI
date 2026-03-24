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

# Monjoy HistoAI
### Browser-based whole-slide image review, annotation, metadata inspection, and patch generation for computational pathology

[![Open Live Application](https://img.shields.io/badge/Open-Live%20Application-111827?style=for-the-badge&logo=huggingface&logoColor=white)](https://huggingface.co/spaces/monjoybme/Monjoy-HistoAI)

<img src="https://img.shields.io/badge/Platform-Browser--based-00d4ff?style=flat-square"/>
<img src="https://img.shields.io/badge/Runtime-Node.js%2020-339933?style=flat-square&logo=node.js"/>
<img src="https://img.shields.io/badge/Viewer-OpenSeadragon-1d4ed8?style=flat-square"/>
<img src="https://img.shields.io/badge/Image%20I%2FO-OpenSlide%20%2B%20sharp-a78bfa?style=flat-square"/>
<img src="https://img.shields.io/badge/Data-NCI%20GDC%20%2F%20TCGA-22c55e?style=flat-square"/>
<img src="https://img.shields.io/badge/Deployment-Docker%20%7C%20HF%20Spaces%20%7C%20Render-f97316?style=flat-square"/>
<img src="https://img.shields.io/badge/License-MIT-64748b?style=flat-square"/>

</div>

---

## Live Application

**Direct access:** https://huggingface.co/spaces/monjoybme/Monjoy-HistoAI

Monjoy HistoAI is a web-deployed digital pathology workspace for reviewing whole-slide images (WSI), creating structured annotations, inspecting slide metadata, and generating image patches for downstream AI/ML pipelines. The application is designed for research, education, dataset curation, and workflow prototyping in computational pathology.

---

## Product Overview

Monjoy HistoAI brings together the core tasks typically spread across multiple tools:

- **Whole-slide viewing** with deep zoom and responsive pan/zoom navigation
- **Structured annotation** for ROI creation and review
- **Metadata visibility** for slide-level context during curation
- **Patch extraction** from annotated regions for model development and validation
- **Direct TCGA / NCI GDC access** for public pathology data exploration
- **Local and cloud-friendly deployment** without requiring a separate Python stack

The platform is implemented as a **single Node.js application** and is suitable for teams that want a lightweight, browser-first workflow for pathology image operations.

---

## Who It Is For

- **Computational pathology teams** building training and validation datasets
- **Academic and translational research labs** curating WSI cohorts and annotations
- **Bioinformatics and AI engineers** preparing ROI-based patch datasets
- **Digital pathology evaluators** who need rapid browser-based review without heavyweight desktop setup

---

## Core Capabilities

| Capability Area | What Monjoy HistoAI Provides | Operational Value |
|---|---|---|
| **WSI access** | Load local slides, browse folders, stream remote URLs, and access TCGA/GDC slides | Reduces friction when assembling pathology cohorts from multiple sources |
| **Annotation workspace** | Polygon, rectangle, ellipse, freehand, point, select, and erase tools with editable classes and colour coding | Supports ROI delineation, region labeling, and structured review workflows |
| **Slide management** | Searchable slide list, collapsible data browser, and slide-focused navigation | Improves usability when working with multi-slide studies |
| **Batch extraction** | Extract annotated regions from one or more selected slides into organized output folders | Accelerates dataset generation for model training and QC review |
| **Patch export** | Save extracted tiles as **JPG/JPEG** with ZIP download and manifest export | Simplifies local download and downstream pipeline integration |
| **Metadata visibility** | Display slide metadata alongside the viewer | Preserves context during review, annotation, and export |
| **Interoperability** | Export annotations to JSON, GeoJSON, and CSV | Supports handoff to analytics, GIS-like workflows, and external tooling |
| **Deployment** | Run locally, in Docker, on Hugging Face Spaces, or on Render | Enables both personal and shared access models |

---

## Access Modes

### 1) Local Whole-Slide Files
- Open slides directly from local storage
- Browse a folder and register multiple slides at once
- Use browser-based slide loading for local or hosted deployments

### 2) Remote Slide Streaming
- Stream supported remote SVS/TIFF resources by URL
- Avoid mandatory full-file download when byte-range access is available
- Useful for remote datasets, staging buckets, or hosted slide repositories

### 3) TCGA / NCI GDC Integration
- Browse pathology slides from **all 33 TCGA projects** through the integrated data browser
- Stream open-access WSI content directly from GDC endpoints
- Use a **user-supplied GDC token** for controlled-access workflows where permitted

### 4) Shared Cloud Links
- Supports common shared-link ingestion patterns such as Google Drive, Box, and OneDrive download links where accessible

---

## Annotation and Review Workflow

Monjoy HistoAI is designed around a practical digital pathology workflow:

1. **Load a slide** from local storage, a folder, a remote URL, or TCGA/GDC
2. **Review the image** with deep zoom, pan, and navigable slide lists
3. **Create annotations** using ROI tools such as polygon, rectangle, ellipse, freehand, and point
4. **Inspect slide metadata** in-context during review
5. **Select one slide or multiple slides** for patch extraction
6. **Extract JPG patches** from annotated regions at the desired pyramid level and patch size
7. **Download outputs** as ZIP archives and manifest files for downstream processing

This workflow supports both single-slide review and multi-slide dataset generation.

---

## User Experience Highlights

- **Light theme by default** with user-selectable theme options
- **Collapsible data browser** to maximize viewer space
- **Improved slide panel** with search and clearer slide selection behavior
- **Slide selection controls** for extracting only the slides the user explicitly chooses
- **In-view metadata panel** to surface slide context without leaving the workspace

These additions make the interface more suitable for longer annotation sessions and higher-volume slide handling.

---

## Patch Extraction and Output Structure

Patch extraction is designed for dataset curation and model-development workflows.

### Extraction Controls
- Configurable patch size
- Configurable pyramid level / resolution level
- Annotation-based filtering by class label
- Overlap threshold control
- Single-slide and multi-slide extraction modes

### Output Behavior
- Extracted image patches are saved as **`.jpg`**
- Multi-slide extraction stores each slide in its **own subfolder** within the selected output directory
- A **manifest JSON** is generated to preserve extraction settings and traceability
- ZIP download is available for browser-based local saving

### Example Output Layout

```text
patches/
└── project_batch_01/
    ├── slide_A/
    │   ├── tumor/
    │   │   ├── slide_A_x1024_y2048_s256_L0_tumor.jpg
    │   │   └── ...
    │   └── stroma/
    ├── slide_B/
    ├── batch_manifest.json
    └── ...
```

---

## Annotation Export and Interoperability

| Format | Purpose |
|---|---|
| **JSON** | Full round-trip export for re-import and internal workflow preservation |
| **GeoJSON** | Interoperability with geospatial-style annotation consumers and pathology tooling |
| **CSV** | Lightweight tabular export for indexing, QA, or downstream analysis |

This makes the platform suitable for research pipelines that require annotation portability and traceability.

---

## Supported Whole-Slide Formats

`.svs` · `.ndpi` · `.tiff` / `.tif` · `.mrxs` · `.czi` · `.scn` · `.vms` · `.vmu` · `.svslide`

Support depends on the underlying OpenSlide-compatible read path and file accessibility in the selected deployment environment.

---

## Technical Architecture

| Layer | Technology |
|---|---|
| **Server runtime** | Node.js 20 / Express |
| **WSI read path** | OpenSlide C library via `koffi` FFI |
| **Image processing** | `sharp` / libvips |
| **Viewer** | OpenSeadragon |
| **Remote streaming** | HTTP Range requests with BigTIFF-aware tile access |
| **Deployment** | Docker, Hugging Face Spaces, Render |

### Design Notes
- **Single-service architecture:** no separate Python application is required
- **Browser-first access model:** users interact through a standard web browser
- **Tile-oriented rendering:** optimized for large pyramidal pathology images
- **Disk-backed outputs:** annotations, thumbnails, and extracted patches can persist locally depending on deployment mode

---

## Application Structure

```text
Monjoy.HistoAI/
├── app.js                  Single-file Node.js / Express application
├── annotations/            Saved annotation files
├── patches/                Extracted JPG patches and manifests
├── static/thumbnails/      Cached slide thumbnails
└── ~/.monjoyai/cache/      Cached remote / streamed slide assets
```

---

## Quick Start (Local)

**Prerequisites**
- Node.js 20+
- OpenSlide runtime library installed on the host

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
# Open http://localhost:7860
```

---

## Docker Deployment

```bash
docker build -t monjoy-histoai .
docker run -p 7860:7860 monjoy-histoai
```

For persistent outputs in local Docker deployments, mount host directories for annotation and patch storage as needed.

---

## Typical Usage

### Stream TCGA Slides
1. Open the **TCGA** section in the data browser
2. Select a project (for example, `TCGA-BRCA`)
3. Search by case or file name
4. Stream the slide directly into the viewer

### Annotate a Slide
1. Choose or create an annotation class
2. Select a drawing tool
3. Create ROI annotations on the slide
4. Save or export annotations as required

### Generate Patch Datasets
1. Select the slides to include in extraction
2. Configure patch size, level, and overlap threshold
3. Start extraction
4. Download the resulting JPG patches and manifest ZIP

---

## Data Handling and Access Control

- **Open-access TCGA/GDC slides** can be used without authentication where permitted by GDC
- **Controlled-access content** requires a user-provided token
- **Local deployments** can keep generated annotations and extracted patches on the local machine
- **Remote or hosted deployments** should be reviewed in the context of the hosting platform's storage, security, and access configuration

Monjoy HistoAI does **not** claim clinical, regulatory, or compliance validation by default. Deployment owners are responsible for the governance posture of their environment.

---

## Research-Use Note

This software is intended for **research, education, evaluation, and workflow development**. It is **not validated for primary clinical diagnosis**.

---

## Contributing

Issues and pull requests are welcome at:

**GitHub:** https://github.com/monjoybme/Monjoy.HistoAI

---

## License

MIT License. See `LICENSE` for details.

---

## Acknowledgements

- **OpenSlide** — whole-slide image reading
- **OpenSeadragon** — deep zoom visualization
- **sharp / libvips** — high-performance image processing
- **NCI Genomic Data Commons (GDC)** — TCGA data access
