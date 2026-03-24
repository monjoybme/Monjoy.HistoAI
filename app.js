#!/usr/bin/env node
/**
 * Monjoy.AI — WSI Annotation Platform  (Node.js / Express)
 * =========================================================
 * Fully JavaScript-based replacement of the Python/Flask version.
 * Zero Python dependency — uses koffi to call libOpenSlide natively.
 *
 * Quick Start
 * -----------
 *   npm install
 *   node app.js  →  http://localhost:5000
 *
 * OpenSlide C library must be installed:
 *   macOS:  brew install openslide
 *   Linux:  sudo apt install openslide-tools
 *   conda:  conda install -c conda-forge openslide
 *
 * Features
 * --------
 *  · Zero-copy slide access — originals never moved
 *  · All annotation tools (Polygon, Rectangle, Ellipse, Freehand, Point)
 *  · JSON annotation export/import (QuPath / ASAP / PathML compatible)
 *  · Patch extraction with ROI overlap enforcement
 *  · Blurriness detection
 *  · Native OS file-picker (osascript on macOS, tkinter subprocess on Linux/Win)
 *  · Cloud: Google Drive / Box / OneDrive shared-link download
 *  · TCGA / NCI GDC direct data access with project browser & download manager
 */
'use strict';

const express     = require('express');
const fs          = require('fs');
const fsp         = fs.promises;
const path        = require('path');
const os          = require('os');
const crypto      = require('crypto');
const multer      = require('multer');
const { execFile, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const http        = require('http');
const https       = require('https');
const { v4: uuidv4 } = require('uuid');

// ── sharp ────────────────────────────────────────────────────────────────────
let sharp = null;
try { sharp = require('sharp'); }
catch(e) { console.warn('  sharp: ✗  npm install sharp'); }

// Remote registry defined below after BASE_DIR

// ── Simple BigTIFF Range-request tile fetcher ─────────────────────────────────
// Fetches ~50 KB per visible tile instead of downloading the full file.
const _streamCache = new Map();  // sid → {offsets, counts, dims, levels, tileW, tileH, jpegTables}
const _tileCache   = new Map();  // 'sid:lv:c:r' → jpeg Buffer  (LRU max 600)
const _TILE_LRU_MAX = 600;

async function _rangeGet(url, start, end, token) {
  const headers = { Range: `bytes=${start}-${end}`, 'User-Agent': 'Monjoy.HistoAI/2.0' };
  if (token) headers['X-Auth-Token'] = token;
  const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (r.status !== 206 && r.status !== 200)
    throw new Error(`HTTP ${r.status} for range request`);
  return Buffer.from(await r.arrayBuffer());
}

function _u16LE(b, o) { return b[o] | (b[o+1]<<8); }
function _u32LE(b, o) { return (b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0; }
function _u64LE(b, o) { return _u32LE(b,o) + _u32LE(b,o+4)*0x100000000; }

async function openRemote(sid, url, token) {
  if (_streamCache.has(sid)) return _streamCache.get(sid);
  // Fetch first 4 MB — enough for IFDs in typical SVS
  const hdr = await _rangeGet(url, 0, 4*1024*1024-1, token);
  const magic = _u16LE(hdr, 0);
  if (magic !== 0x4949 && magic !== 0x4D4D) throw new Error('Not a TIFF/BigTIFF file');
  const le = magic === 0x4949;
  const u16 = (o) => le ? _u16LE(hdr,o) : hdr.readUInt16BE(o);
  const u32 = (o) => le ? _u32LE(hdr,o) : hdr.readUInt32BE(o);
  const u64 = (o) => le ? _u64LE(hdr,o) : (hdr.readUInt32BE(o)*0x100000000+hdr.readUInt32BE(o+4));
  const ver = u16(2);
  const big = ver === 43;
  if (ver !== 42 && ver !== 43) throw new Error(`Unknown TIFF version ${ver}`);
  let ifdOff = big ? u64(8) : u32(4);
  const TYPE_SZ = [0,1,1,2,4,8,1,1,2,4,8,4,8];

  const levels = [];
  while (ifdOff && ifdOff < hdr.length - 8) {
    const nE = big ? u64(ifdOff) : u16(ifdOff);
    const eBase = ifdOff + (big ? 8 : 2);
    const eSz = big ? 20 : 12;
    if (eBase + nE * eSz > hdr.length) break;
    const tags = {};
    for (let i = 0; i < nE; i++) {
      const p = eBase + i*eSz;
      const tag = u16(p), type = u16(p+2);
      const cnt = big ? u64(p+4) : u32(p+4);
      const vp = p + (big ? 12 : 8);
      const tsz = TYPE_SZ[type]||4;
      let val;
      if (cnt === 1 && tsz <= (big?8:4)) {
        val = type===3 ? u16(vp) : type===16 ? u64(vp) : u32(vp);
      } else {
        val = { off: big?u64(vp):u32(vp), cnt, type };
      }
      tags[tag] = val;
    }
    const nxtPos = eBase + nE*eSz;
    const nextIfd = big ? u64(nxtPos) : u32(nxtPos);

    const W = typeof tags[256]==='number'?tags[256]:0;
    const H = typeof tags[257]==='number'?tags[257]:0;
    const tW = typeof tags[322]==='number'?tags[322]:256;
    const tH = typeof tags[323]==='number'?tags[323]:256;
    const offRef = tags[324], cntRef = tags[325];

    if (W && H && offRef) {
      const readArr = (ref, n) => {
        if (typeof ref === 'number') return [ref];
        const { off, type } = ref;
        const tsz2 = TYPE_SZ[type]||4;
        if (off + n*tsz2 > hdr.length) return null;
        const a = [];
        for (let i=0;i<n;i++) {
          const p2 = off+i*tsz2;
          a.push(type===16?u64(p2):type===4?u32(p2):u16(p2));
        }
        return a;
      };
      const nTiles = typeof offRef==='object'?Number(offRef.cnt):1;
      const offs = readArr(offRef, nTiles);
      const cnts = cntRef ? readArr(cntRef, nTiles) : null;
      if (offs) {
        let jpegTables = null;
        const jt = tags[347];
        if (jt && typeof jt==='object' && jt.off+jt.cnt <= hdr.length)
          jpegTables = hdr.slice(jt.off, jt.off+jt.cnt);
        levels.push({ W, H, tW, tH, offs, cnts, jpegTables });
      }
    }
    ifdOff = nextIfd;
  }
  if (!levels.length) throw new Error('No tiled pyramid levels found in BigTIFF');
  levels.sort((a,b)=>b.W-a.W);

  // Count DZ levels
  let w=levels[0].W, h=levels[0].H, nDz=1;
  while(w>1||h>1){w=Math.max(1,Math.ceil(w/2));h=Math.max(1,Math.ceil(h/2));nDz++;}

  const meta = { levels, nDz, W:levels[0].W, H:levels[0].H, url, token };
  _streamCache.set(sid, meta);
  return meta;
}

async function getStreamTile(sid, url, token, dzLv, col, row) {
  const ck = `${sid}:${dzLv}:${col}:${row}`;
  if (_tileCache.has(ck)) return _tileCache.get(ck);

  const meta = await openRemote(sid, url, token);
  const { levels, nDz, W, H } = meta;

  // Map DZ level to image dimension
  const dzW = Math.max(1, Math.ceil(W / Math.pow(2, nDz-1-dzLv)));
  let best = levels[0];
  for (const lv of levels) { if (Math.abs(lv.W-dzW) < Math.abs(best.W-dzW)) best=lv; }

  const scale = best.W/Math.max(1,dzW);
  const tilesX = Math.ceil(best.W/best.tW);
  const tilesY = Math.ceil(best.H/best.tH);
  const svsCol = Math.min(tilesX-1, Math.floor(col*scale));
  const svsRow = Math.min(tilesY-1, Math.floor(row*scale));
  const idx = svsRow*tilesX+svsCol;

  const white1x1 = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAACBP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AoABn/9k=','base64');

  if (!best.offs||idx>=best.offs.length||!best.offs[idx]) {
    _tileCache.set(ck, white1x1);
    return white1x1;
  }

  const byteOff = best.offs[idx];
  const byteCnt = best.cnts ? best.cnts[idx] : 65536;
  if (!byteOff || !byteCnt) { _tileCache.set(ck,white1x1); return white1x1; }

  let tileBuf = await _rangeGet(url, byteOff, byteOff+byteCnt-1, token);

  // Inject JPEG tables if needed
  if (best.jpegTables && tileBuf[0]===0xFF && tileBuf[1]!==0xD8)
    tileBuf = Buffer.concat([best.jpegTables.slice(0,-2), tileBuf]);

  if (_tileCache.size >= _TILE_LRU_MAX) _tileCache.delete(_tileCache.keys().next().value);
  _tileCache.set(ck, tileBuf);
  return tileBuf;
}

// ── koffi + OpenSlide FFI ────────────────────────────────────────────────────
let OSL = null;   // OpenSlide function table (populated below)

function findOpenSlideLib() {
  const plat   = process.platform;
  const conda  = process.env.CONDA_PREFIX || '';
  const brew   = '/opt/homebrew';

  if (plat === 'darwin') {
    return [
      conda && path.join(conda, 'lib/libopenslide.dylib'),
      brew + '/lib/libopenslide.dylib',
      '/usr/local/lib/libopenslide.dylib',
      '/opt/local/lib/libopenslide.dylib',
    ].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch{ return false; }})
     || (brew + '/lib/libopenslide.dylib');
  }
  if (plat === 'linux') {
    return [
      conda && path.join(conda, 'lib/libopenslide.so.0'),
      '/usr/lib/x86_64-linux-gnu/libopenslide.so.0',
      '/usr/lib/libopenslide.so.0',
      '/usr/local/lib/libopenslide.so.0',
      'libopenslide.so.0',
    ].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch{ return false; }})
     || 'libopenslide.so.0';
  }
  // Windows
  return ['openslide-0.dll',
          'C:\\Program Files\\OpenSlide\\bin\\openslide-0.dll']
    .find(p => { try { return fs.existsSync(p); } catch{ return false; }}) || 'openslide-0.dll';
}

try {
  const koffi   = require('koffi');
  const libPath = findOpenSlideLib();
  const lib     = koffi.load(libPath);

  OSL = {
    open:      lib.func('void* openslide_open(const char* filename)'),
    close:     lib.func('void  openslide_close(void* osr)'),
    getError:  lib.func('const char* openslide_get_error(void* osr)'),
    levelCount:lib.func('int32 openslide_get_level_count(void* osr)'),
    levelDims: lib.func('void  openslide_get_level_dimensions(void* osr, int32 level, _Out_ int64* w, _Out_ int64* h)'),
    levelDS:   lib.func('double openslide_get_level_downsample(void* osr, int32 level)'),
    bestLevel: lib.func('int32 openslide_get_best_level_for_downsample(void* osr, double ds)'),
    readRegion:lib.func('void  openslide_read_region(void* osr, uint8* dest, int64 x, int64 y, int32 level, int64 w, int64 h)'),
    getProp:   lib.func('const char* openslide_get_property_value(void* osr, const char* name)'),
    detectVendor: lib.func('const char* openslide_detect_vendor(const char* filename)'),
  };
  console.log(`  openslide: ✓  (${libPath})`);
} catch(e) {
  console.warn(`  openslide: ✗  ${e.message}`);
  console.warn('    Install: brew install openslide  OR  conda install -c conda-forge openslide');
}

// ── Directories & Config ─────────────────────────────────────────────────────
const BASE_DIR        = __dirname;
const ANNOTATIONS_DIR = path.join(BASE_DIR, 'annotations');
const PATCHES_DIR     = path.join(BASE_DIR, 'patches');
const THUMBNAILS_DIR  = path.join(BASE_DIR, 'static', 'thumbnails');
const CACHE_DIR       = path.join(os.homedir(), '.monjoyai', 'cache');  // cloud + TCGA downloads
const REGISTRY_FILE   = path.join(BASE_DIR, 'slide_registry.json');
const CONFIG_FILE     = path.join(BASE_DIR, 'config.json');

[ANNOTATIONS_DIR, PATCHES_DIR, THUMBNAILS_DIR, CACHE_DIR].forEach(d => {
  fs.mkdirSync(d, { recursive: true });
});

// ── Remote (URL-based streaming) registry ─────────────────────────────────────
const REMOTE_REG_FILE = path.join(BASE_DIR, 'remote_slide_registry.json');
function loadRemoteReg() { try { return JSON.parse(fs.readFileSync(REMOTE_REG_FILE,'utf8')); } catch { return {}; } }
function saveRemoteReg(r) { fs.writeFileSync(REMOTE_REG_FILE, JSON.stringify(r,null,2)); }
function remoteId(url) { return require('crypto').createHash('sha256').update(url).digest('hex').slice(0,12); }

const SUPPORTED_EXT = new Set(['.svs','.ndpi','.scn','.czi','.tiff','.tif','.mrxs','.vms','.vmu','.svslide']);
const TILE_SIZE     = 254;
const TILE_OVERLAP  = 1;

const DEFAULT_CLASSES = [
  { id:'nuclei',   name:'Nuclei',   color:'#7c3aed', shortcut:'1' },
  { id:'stroma',   name:'Stroma',   color:'#3b82f6', shortcut:'2' },
  { id:'fat',      name:'Fat',      color:'#fbbf24', shortcut:'3' },
  { id:'necrosis', name:'Necrosis', color:'#f97316', shortcut:'4' },
  { id:'mitosis',  name:'Mitosis',  color:'#f59e0b', shortcut:'5' },
  { id:'other',    name:'Other',    color:'#10b981', shortcut:'6' },
];

// ── Config & Registry helpers ────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { watch_dirs: [] }; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); }
  catch { return {}; }
}
function saveRegistry(reg) { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2)); }

function pathToId(filePath) {
  return crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 12);
}

// ── Slide discovery ──────────────────────────────────────────────────────────
function discoverSlides() {
  const slides = {};

  // 1. Registered files
  const reg = loadRegistry();
  for (const [sid, info] of Object.entries(reg)) {
    try {
      if (fs.existsSync(info.path) && SUPPORTED_EXT.has(path.extname(info.path).toLowerCase())) {
        slides[sid] = { id: sid, name: info.name || path.basename(info.path),
                        path: info.path, source: info.source || 'local' };
      }
    } catch {}
  }

  // 2. Watch directories
  const cfg = loadConfig();
  for (const wd of (cfg.watch_dirs || [])) {
    try {
      for (const f of fs.readdirSync(wd).sort()) {
        const fp = path.join(wd, f);
        if (SUPPORTED_EXT.has(path.extname(f).toLowerCase()) && fs.statSync(fp).isFile()) {
          const sid = pathToId(fp);
          if (!slides[sid]) slides[sid] = { id: sid, name: f, path: fp, source: 'watch_dir' };
        }
      }
    } catch {}
  }

  // 3. Cloud/TCGA cache
  try {
    for (const f of fs.readdirSync(CACHE_DIR).sort()) {
      const fp = path.join(CACHE_DIR, f);
      if (SUPPORTED_EXT.has(path.extname(f).toLowerCase()) && fs.statSync(fp).isFile()) {
        const sid = pathToId(fp);
        if (!slides[sid]) slides[sid] = { id: sid, name: f, path: fp, source: 'cloud_cache' };
      }
    }
  } catch {}

  // Remote (streaming) slides
  try {
    const rem = loadRemoteReg();
    for (const [sid, info] of Object.entries(rem)) {
      if (!slides[sid]) {
        slides[sid] = { id: sid, name: info.name, path: info.url,
                        source: info.source||'stream', is_remote: true, url: info.url };
      }
    }
  } catch(e) {}
  return Object.values(slides);
}

function resolveSlide(sid) {
  const reg = loadRegistry();
  if (reg[sid] && fs.existsSync(reg[sid].path)) return reg[sid].path;

  const cfg = loadConfig();
  for (const wd of (cfg.watch_dirs || [])) {
    try {
      for (const f of fs.readdirSync(wd)) {
        const fp = path.join(wd, f);
        if (SUPPORTED_EXT.has(path.extname(f).toLowerCase()) && pathToId(fp) === sid)
          return fp;
      }
    } catch {}
  }

  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      if (SUPPORTED_EXT.has(path.extname(f).toLowerCase()) && pathToId(fp) === sid)
        return fp;
    }
  } catch {}

  return null;
}

// ── Slide cache (open handles) ───────────────────────────────────────────────
const _slideCache = new Map();   // sid → { osr, meta, dz }

function openOsr(sid) {
  if (_slideCache.has(sid)) return _slideCache.get(sid);
  if (!OSL) throw new Error('OpenSlide C library not loaded');
  const filePath = resolveSlide(sid);
  if (!filePath) throw new Error(`Slide not found: ${sid}`);
  const osr = OSL.open(filePath);
  if (!osr) throw new Error(`openslide_open failed for ${filePath}`);
  const err = OSL.getError(osr);
  if (err) throw new Error(`OpenSlide error: ${err}`);

  const meta = buildMeta(sid, osr, filePath);
  const dz   = new DeepZoomGen(meta);
  _slideCache.set(sid, { osr, meta, dz });
  return { osr, meta, dz };
}

function closeOsr(sid) {
  if (_slideCache.has(sid)) {
    try { OSL && OSL.close(_slideCache.get(sid).osr); } catch {}
    _slideCache.delete(sid);
  }
}

// ── Slide metadata ───────────────────────────────────────────────────────────
const KNOWN_PROPS = {
  mpp_x:           'openslide.mpp-x',
  mpp_y:           'openslide.mpp-y',
  objective_power: 'openslide.objective-power',
  vendor:          'openslide.vendor',
};

function buildMeta(sid, osr, filePath) {
  const nLevels = OSL.levelCount(osr);
  const levelDims = [], levelDS = [];
  for (let i = 0; i < nLevels; i++) {
    const w = [0n], h = [0n];
    OSL.levelDims(osr, i, w, h);
    levelDims.push([Number(w[0]), Number(h[0])]);
    levelDS.push(OSL.levelDS(osr, i));
  }

  const props = {};
  for (const [k, pname] of Object.entries(KNOWN_PROPS)) {
    try { props[k] = OSL.getProp(osr, pname); } catch {}
  }

  const stat    = fs.statSync(filePath);
  const annData = loadAnn(sid);

  return {
    id: sid,
    name: loadRegistry()[sid]?.name || path.basename(filePath),
    dimensions:        levelDims[0] || [0, 0],
    level_count:       nLevels,
    level_dimensions:  levelDims,
    level_downsamples: levelDS,
    mpp_x:  props.mpp_x  || null,
    mpp_y:  props.mpp_y  || null,
    objective_power: props.objective_power || null,
    vendor: props.vendor || 'unknown',
    annotation_count: (annData.annotations || []).length,
    file_size_mb: Math.round(stat.size / 1048576 * 10) / 10,
    real_path: filePath,
    source: loadRegistry()[sid]?.source || 'local',
  };
}

// ── DeepZoom generator ───────────────────────────────────────────────────────
// Mirrors openslide-python's DeepZoomGenerator logic exactly.
class DeepZoomGen {
  constructor(meta) {
    const [w0, h0] = meta.dimensions;
    this.w0 = w0; this.h0 = h0;
    this.levelDims   = meta.level_dimensions;
    this.levelDS     = meta.level_downsamples;
    this.tileSize    = TILE_SIZE;
    this.overlap     = TILE_OVERLAP;

    // Build DZ level list: halve until 1×1
    const zDims = [];
    let zw = w0, zh = h0;
    while (zw > 1 || zh > 1) {
      zDims.push([zw, zh]);
      zw = Math.max(1, Math.ceil(zw / 2));
      zh = Math.max(1, Math.ceil(zh / 2));
    }
    zDims.push([1, 1]);
    this._zDims = zDims.reverse();         // index 0 = 1×1 thumbnail
    this.nLevels = this._zDims.length;

    // For each DZ level, map to best native slide level
    this._slideLevel = this._zDims.map(([zw, zh]) => {
      const ds = Math.max(w0 / zw, h0 / zh);
      return this._bestLevel(ds);
    });
  }

  _bestLevel(ds) {
    let best = 0;
    for (let i = 0; i < this.levelDS.length; i++) {
      if (this.levelDS[i] <= ds + 0.001) best = i;
    }
    return best;
  }

  getDziXml() {
    return `<?xml version="1.0" encoding="UTF-8"?><Image xmlns="http://schemas.microsoft.com/deepzoom/2008" Format="jpeg" Overlap="${this.overlap}" TileSize="${this.tileSize}"><Size Width="${this.w0}" Height="${this.h0}"/></Image>`;
  }

  // Returns {l0x, l0y, slideLevel, readW, readH, outW, outH}
  getTileInfo(dzLevel, col, row) {
    const [dzW, dzH] = this._zDims[dzLevel];
    const ts = this.tileSize;

    // Tile bounds in DZ space (no overlap for edge math)
    const x0 = col * ts, y0 = row * ts;
    const x1 = Math.min(x0 + ts, dzW);
    const y1 = Math.min(y0 + ts, dzH);
    const outW = x1 - x0, outH = y1 - y0;

    // Map to level-0 coordinates
    const l0Scale = this.w0 / dzW;
    const l0x = Math.round(x0 * l0Scale);
    const l0y = Math.round(y0 * l0Scale);

    // Native slide level to read from
    const slideLevel = this._slideLevel[dzLevel];
    const nativeDS   = this.levelDS[slideLevel];
    const dzDS       = l0Scale;             // how many l0 px per DZ px

    // Read size at native level
    const readW = Math.max(1, Math.round(outW * dzDS / nativeDS));
    const readH = Math.max(1, Math.round(outH * dzDS / nativeDS));

    return { l0x, l0y, slideLevel, readW, readH, outW, outH };
  }
}

// ── Tile rendering ───────────────────────────────────────────────────────────
async function renderTile(sid, dzLevel, col, row) {
  if (!OSL) throw new Error('OpenSlide not available');
  if (!sharp) throw new Error('sharp not available');

  const { osr, dz } = openOsr(sid);
  const { l0x, l0y, slideLevel, readW, readH, outW, outH } = dz.getTileInfo(dzLevel, col, row);

  // Read raw ARGB pixels from OpenSlide
  const nPx  = readW * readH;
  const buf  = Buffer.alloc(nPx * 4, 0xff);
  OSL.readRegion(osr, buf, BigInt(l0x), BigInt(l0y), slideLevel, BigInt(readW), BigInt(readH));

  // Check error
  const err = OSL.getError(osr);
  if (err) throw new Error(`OpenSlide: ${err}`);

  // Convert premultiplied ARGB (LE: B G R A) → RGB for JPEG
  const rgb = Buffer.allocUnsafe(nPx * 3);
  for (let i = 0; i < nPx; i++) {
    const b = buf[i*4];
    const g = buf[i*4+1];
    const r = buf[i*4+2];
    const a = buf[i*4+3];
    // Unpremultiply; transparent → white
    const inv = a === 0 ? 0 : 255 / a;
    rgb[i*3]   = Math.min(255, Math.round(r * inv));
    rgb[i*3+1] = Math.min(255, Math.round(g * inv));
    rgb[i*3+2] = Math.min(255, Math.round(b * inv));
  }

  // Resize to output dimensions if needed, then encode JPEG
  let img = sharp(rgb, { raw: { width: readW, height: readH, channels: 3 } });
  if (readW !== outW || readH !== outH) {
    img = img.resize(outW, outH, { fit: 'fill', kernel: 'lanczos2' });
  }
  return img.jpeg({ quality: 85 }).toBuffer();
}

// ── Thumbnail ────────────────────────────────────────────────────────────────
async function getThumbnail(sid, sz = 256) {
  if (!OSL || !sharp) throw new Error('OpenSlide or sharp unavailable');
  const safe  = sid.replace(/[/\\]/g, '_');
  const thumb = path.join(THUMBNAILS_DIR, `${safe}_${sz}.jpg`);
  if (fs.existsSync(thumb)) return thumb;

  const { osr, meta } = openOsr(sid);
  // Find level whose smaller dim is closest to sz
  let bestLv = meta.level_count - 1;
  for (let i = 0; i < meta.level_count; i++) {
    const [w, h] = meta.level_dimensions[i];
    if (Math.min(w, h) <= sz * 2) { bestLv = i; break; }
  }
  const [lw, lh]  = meta.level_dimensions[bestLv];
  const rW = Math.min(lw, 2048), rH = Math.min(lh, 2048);
  const nPx = rW * rH;
  const buf  = Buffer.alloc(nPx * 4, 0xff);
  OSL.readRegion(osr, buf, 0n, 0n, bestLv, BigInt(rW), BigInt(rH));

  const rgb = Buffer.allocUnsafe(nPx * 3);
  for (let i = 0; i < nPx; i++) {
    const a = buf[i*4+3];
    const inv = a === 0 ? 0 : 255 / a;
    rgb[i*3]   = Math.min(255, Math.round(buf[i*4+2] * inv));
    rgb[i*3+1] = Math.min(255, Math.round(buf[i*4+1] * inv));
    rgb[i*3+2] = Math.min(255, Math.round(buf[i*4]   * inv));
  }
  await sharp(rgb, { raw: { width: rW, height: rH, channels: 3 } })
    .resize(sz, sz, { fit: 'inside' })
    .jpeg({ quality: 85 })
    .toFile(thumb);
  return thumb;
}

// ── Annotations I/O ──────────────────────────────────────────────────────────
function annFile(sid) {
  return path.join(ANNOTATIONS_DIR, sid.replace(/[/\\]/g, '_') + '.json');
}
function loadAnn(sid) {
  try {
    const data = JSON.parse(fs.readFileSync(annFile(sid), 'utf8'));
    data.classes = data.classes || DEFAULT_CLASSES;
    return data;
  } catch {
    return { slide_id: sid, annotations: [], classes: DEFAULT_CLASSES };
  }
}
function saveAnn(sid, data) {
  fs.writeFileSync(annFile(sid), JSON.stringify(data, null, 2));
}

// ── GeoJSON export ───────────────────────────────────────────────────────────
function toGeoJson(annData) {
  const feats = (annData.annotations || []).map(a => {
    const coords = a.coordinates || [];
    if (!coords.length) return null;
    let geom;
    if (a.type === 'point') {
      geom = { type: 'Point', coordinates: coords[0] };
    } else if (a.type === 'rectangle' && a.rect) {
      const [x, y, w, h] = a.rect;
      geom = { type: 'Polygon', coordinates: [[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]] };
    } else {
      const ring = coords.map(c => [c[0], c[1]]);
      if (ring[0][0] !== ring[ring.length-1][0] || ring[0][1] !== ring[ring.length-1][1])
        ring.push(ring[0]);
      geom = { type: 'Polygon', coordinates: [ring] };
    }
    return { type: 'Feature', geometry: geom,
             properties: { id: a.id, label: a.label, color: a.color,
                           area_px: a.area_px || 0, notes: a.notes || '',
                           created: a.created || '' }};
  }).filter(Boolean);
  return { type: 'FeatureCollection', features: feats };
}

// ── Blur detection ───────────────────────────────────────────────────────────
async function checkBlur(sid, threshold = 100) {
  if (!OSL || !sharp) return { error: 'OpenSlide or sharp unavailable' };
  const { osr, meta } = openOsr(sid);
  const lv = Math.min(2, meta.level_count - 1);
  const [lw, lh] = meta.level_dimensions[lv];
  const MAX = 2048;
  const scale = Math.min(1, MAX / Math.max(lw, lh));
  const rW = Math.max(1, Math.round(lw * scale));
  const rH = Math.max(1, Math.round(lh * scale));
  const nPx = rW * rH;
  const buf  = Buffer.alloc(nPx * 4, 0xff);
  OSL.readRegion(osr, buf, 0n, 0n, lv, BigInt(rW), BigInt(rH));

  // Convert to greyscale
  const gray = Buffer.allocUnsafe(nPx);
  for (let i = 0; i < nPx; i++) {
    gray[i] = Math.round(0.299 * buf[i*4+2] + 0.587 * buf[i*4+1] + 0.114 * buf[i*4]);
  }

  // Laplacian variance
  let sum = 0, sum2 = 0;
  for (let y = 1; y < rH - 1; y++) {
    for (let x = 1; x < rW - 1; x++) {
      const idx = y * rW + x;
      const lap = (4 * gray[idx]
        - gray[idx-1] - gray[idx+1]
        - gray[idx-rW] - gray[idx+rW]);
      sum  += lap;
      sum2 += lap * lap;
    }
  }
  const n    = (rH - 2) * (rW - 2);
  const mean = sum / n;
  const variance = sum2 / n - mean * mean;

  return { variance: Math.round(variance * 100) / 100, threshold,
           is_blurry: variance < threshold,
           quality: variance < threshold ? 'BLURRY' : 'SHARP',
           level_used: lv };
}

function sanitizeOutputSubdir(name, fallback = 'patches') {
  const cleaned = path.basename(String(name || '').trim().replace(/\\/g, '/'))
    .replace(/\.\.+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function sanitizePatchImageFormat(fmt) {
  const v = String(fmt || 'jpg').trim().toLowerCase();
  return (v === 'jpg' || v === 'jpeg') ? 'jpg' : 'jpg';
}

function getSlideLabel(sid) {
  try {
    const rem = loadRemoteReg();
    if (rem[sid]) return rem[sid].name || sid;
  } catch {}
  try {
    const found = discoverSlides().find(s => s.id === sid);
    if (found) return found.name || sid;
  } catch {}
  return sid;
}

// ── Patch extraction ─────────────────────────────────────────────────────────
async function extractPatches(sid, {
  patch_size = 256,
  level = 0,
  out_subdir = null,
  output_dir = null,
  label_filter = null,
  overlap_threshold = 0.3,
  slide_subdir = null,
  image_format = 'jpg',
  jpeg_quality = 92,
} = {}) {
  if (!OSL || !sharp) return { error: 'OpenSlide or sharp unavailable' };
  const remoteReg = loadRemoteReg();
  if (remoteReg[sid]) {
    return { error: 'Patch extraction is currently available for local or cached slides only. Please download/cache the slide first.' };
  }

  const { osr, meta } = openOsr(sid);
  const ann = loadAnn(sid);
  let anns = ann.annotations || [];
  if (label_filter && label_filter.length) anns = anns.filter(a => label_filter.includes(a.label));

  const safeLv = Math.min(Math.max(parseInt(level, 10) || 0, 0), meta.level_count - 1);
  const ds = meta.level_downsamples[safeLv];
  const stepL0 = Math.max(1, Math.round(patch_size * ds));
  const mpp = meta.mpp_x ? parseFloat(meta.mpp_x) : null;
  const objPow = meta.objective_power || null;
  const patchFormat = sanitizePatchImageFormat(image_format);
  const jpegQuality = Math.max(1, Math.min(100, parseInt(jpeg_quality, 10) || 92));

  const slideBase = (meta.name || sid)
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 32) || 'slide';

  const safeOutSubdir = sanitizeOutputSubdir(out_subdir || output_dir || 'patches');
  const rootOutDir = path.join(PATCHES_DIR, safeOutSubdir);
  const safeSlideSubdir = slide_subdir ? sanitizeOutputSubdir(slide_subdir, slideBase) : null;
  const outDir = safeSlideSubdir ? path.join(rootOutDir, safeSlideSubdir) : rootOutDir;
  fs.mkdirSync(outDir, { recursive: true });

  let count = 0;
  let skippedAnnotations = 0;
  const errors = [];
  const manifestPatches = [];

  for (const annItem of anns.filter(a => a.coordinates && a.coordinates.length)) {
    const coords = annItem.coordinates;
    const xs = coords.map(p => p[0]);
    const ys = coords.map(p => p[1]);
    const xMin = Math.round(Math.min(...xs));
    const yMin = Math.round(Math.min(...ys));
    const xMax = Math.round(Math.max(...xs));
    const yMax = Math.round(Math.max(...ys));
    const label = annItem.label || 'unknown';
    const safeLabel = sanitizeOutputSubdir(label, 'unknown');
    const lDir = path.join(outDir, safeLabel);
    fs.mkdirSync(lDir, { recursive: true });

    const maskH = yMax - yMin + stepL0;
    const maskW = xMax - xMin + stepL0;
    const mask = new Uint8Array(maskH * maskW);
    fillPoly(mask, maskW, coords, xMin, yMin);

    let savedForAnnotation = 0;
    try {
      for (let y0 = yMin; y0 < yMax; y0 += stepL0) {
        for (let x0 = xMin; x0 < xMax; x0 += stepL0) {
          const ly = y0 - yMin;
          const lx = x0 - xMin;
          let covered = 0;
          let total = 0;
          for (let dy = 0; dy < stepL0 && ly + dy < maskH; dy++) {
            for (let dx = 0; dx < stepL0 && lx + dx < maskW; dx++) {
              if (mask[(ly + dy) * maskW + (lx + dx)]) covered++;
              total++;
            }
          }
          if (total === 0 || covered / total < overlap_threshold) continue;

          const nPx = patch_size * patch_size;
          const buf = Buffer.alloc(nPx * 4, 0xff);
          OSL.readRegion(osr, buf, BigInt(x0), BigInt(y0), safeLv,
                         BigInt(patch_size), BigInt(patch_size));
          const rgb = Buffer.allocUnsafe(nPx * 3);
          for (let i = 0; i < nPx; i++) {
            const a = buf[i*4+3];
            const inv = a === 0 ? 0 : 255 / a;
            rgb[i*3]   = Math.min(255, Math.round(buf[i*4+2] * inv));
            rgb[i*3+1] = Math.min(255, Math.round(buf[i*4+1] * inv));
            rgb[i*3+2] = Math.min(255, Math.round(buf[i*4]   * inv));
          }

          const fname = `${slideBase}_x${x0}_y${y0}_s${patch_size}_L${safeLv}_${safeLabel}.jpg`;
          const fpath = path.join(lDir, fname);
          await sharp(rgb, { raw: { width: patch_size, height: patch_size, channels: 3 }})
            .jpeg({ quality: jpegQuality, mozjpeg: true })
            .toFile(fpath);

          manifestPatches.push({
            filename: fname,
            relative_path: path.posix.join(safeSlideSubdir || '', safeLabel, fname).replace(/^\/+/, ''),
            slide_name: meta.name || sid,
            slide_id: sid,
            annotation_id: annItem.id,
            annotation_type: annItem.type,
            annotation_label: annItem.label_name || annItem.label,
            annotation_color: annItem.color,
            annotation_notes: annItem.notes || '',
            annotation_coordinates: annItem.coordinates,
            annotation_area_px2: annItem.area_px || 0,
            x_topleft: x0,
            y_topleft: y0,
            patch_size_px: patch_size,
            resolution_level: safeLv,
            downsample_factor: ds,
            mpp_x: mpp,
            objective_power: objPow,
            image_format: patchFormat,
            extracted_at: new Date().toISOString(),
          });

          count++;
          savedForAnnotation++;
        }
      }
      if (!savedForAnnotation) skippedAnnotations++;
    } catch (e) {
      errors.push(`${String(annItem.id || 'annotation').slice(0, 12)}: ${e.message}`);
    }
  }

  const manifest = {
    monjoy_histoai_version: '2.1',
    generated_at: new Date().toISOString(),
    image_format: patchFormat,
    slide: {
      name: meta.name || sid,
      id: sid,
      dimensions: meta.dimensions,
      level_count: meta.level_count,
      level_dimensions: meta.level_dimensions,
      level_downsamples: meta.level_downsamples,
      mpp_x: meta.mpp_x,
      mpp_y: meta.mpp_y,
      objective_power: meta.objective_power,
      vendor: meta.vendor,
      source: meta.source,
      real_path: meta.real_path,
    },
    extraction_params: {
      patch_size_px: patch_size,
      resolution_level: safeLv,
      downsample_factor: ds,
      overlap_threshold,
      label_filter: label_filter || 'all',
      output_directory: outDir,
      output_root_directory: rootOutDir,
      slide_output_subdir: safeSlideSubdir,
      image_format: patchFormat,
      jpeg_quality: jpegQuality,
    },
    annotations: anns.map(a => ({
      id: a.id,
      type: a.type,
      label: a.label,
      label_name: a.label_name,
      color: a.color,
      coordinates: a.coordinates,
      area_px2: a.area_px,
      notes: a.notes,
      created: a.created,
    })),
    patches: manifestPatches,
    total_patches_extracted: count,
    skipped_annotations: skippedAnnotations,
    errors,
  };

  const manifestPath = path.join(outDir, `${slideBase}_manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    extracted: count,
    skipped: skippedAnnotations,
    errors,
    output_dir: rootOutDir,
    slide_output_dir: outDir,
    output_subdir: safeOutSubdir,
    slide_subdir: safeSlideSubdir,
    manifest_file: manifestPath,
    annotations_processed: anns.length,
    image_format: patchFormat,
  };
}

async function extractPatchesBatch(slideIds, opts = {}) {
  const ids = Array.from(new Set((Array.isArray(slideIds) ? slideIds : []).filter(Boolean)));
  if (!ids.length) return { error: 'No slides selected' };

  const safeOutSubdir = sanitizeOutputSubdir(opts.out_subdir || opts.output_dir || 'patches');
  const batchRoot = path.join(PATCHES_DIR, safeOutSubdir);
  fs.mkdirSync(batchRoot, { recursive: true });

  const results = [];
  const batchErrors = [];
  let totalExtracted = 0;
  let totalSkipped = 0;

  for (let i = 0; i < ids.length; i++) {
    const sid = ids[i];
    const slideName = getSlideLabel(sid);
    const slideStem = String(slideName || sid).replace(/\.[^.]+$/, '');
    const safeSlideDir = `${String(i + 1).padStart(2, '0')}_${sanitizeOutputSubdir(slideStem, 'slide_' + (i + 1))}`;
    try {
      const one = await extractPatches(sid, {
        ...opts,
        out_subdir: safeOutSubdir,
        output_dir: safeOutSubdir,
        slide_subdir: safeSlideDir,
        image_format: 'jpg',
      });
      if (one && one.error) throw new Error(one.error);

      totalExtracted += one.extracted || 0;
      totalSkipped += one.skipped || 0;
      if (Array.isArray(one.errors) && one.errors.length) {
        batchErrors.push(...one.errors.map(e => `${slideName}: ${e}`));
      }

      results.push({
        slide_id: sid,
        slide_name: slideName,
        slide_subdir: one.slide_subdir || safeSlideDir,
        output_dir: one.slide_output_dir || one.output_dir,
        extracted: one.extracted || 0,
        skipped: one.skipped || 0,
        annotations_processed: one.annotations_processed || 0,
        manifest_file: one.manifest_file,
        errors: one.errors || [],
        image_format: one.image_format || 'jpg',
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      batchErrors.push(`${slideName}: ${msg}`);
      results.push({
        slide_id: sid,
        slide_name: slideName,
        slide_subdir: safeSlideDir,
        output_dir: path.join(batchRoot, safeSlideDir),
        extracted: 0,
        skipped: 0,
        annotations_processed: 0,
        manifest_file: null,
        error: msg,
        errors: [msg],
        image_format: 'jpg',
      });
    }
  }

  const batchManifest = {
    monjoy_histoai_version: '2.1',
    generated_at: new Date().toISOString(),
    image_format: 'jpg',
    output_directory: batchRoot,
    output_subdir: safeOutSubdir,
    selected_slide_ids: ids,
    extraction_params: {
      patch_size_px: opts.patch_size || 256,
      resolution_level: opts.level || 0,
      overlap_threshold: opts.overlap_threshold == null ? 0.3 : opts.overlap_threshold,
      label_filter: opts.label_filter || 'all',
      image_format: 'jpg',
      jpeg_quality: opts.jpeg_quality || 92,
    },
    totals: {
      slides_selected: ids.length,
      slides_processed: results.length,
      slides_with_errors: results.filter(r => r.error).length,
      total_patches_extracted: totalExtracted,
      total_skipped_annotations: totalSkipped,
    },
    slides: results.map(r => ({
      slide_id: r.slide_id,
      slide_name: r.slide_name,
      slide_subdir: r.slide_subdir,
      output_dir: r.output_dir,
      extracted: r.extracted,
      skipped: r.skipped,
      annotations_processed: r.annotations_processed,
      manifest_file: r.manifest_file,
      error: r.error || null,
      errors: r.errors || [],
      image_format: r.image_format || 'jpg',
    })),
    errors: batchErrors,
  };

  const batchManifestPath = path.join(batchRoot, 'batch_manifest.json');
  fs.writeFileSync(batchManifestPath, JSON.stringify(batchManifest, null, 2));

  return {
    extracted: totalExtracted,
    skipped: totalSkipped,
    output_dir: batchRoot,
    output_subdir: safeOutSubdir,
    manifest_file: batchManifestPath,
    slides_processed: results.length,
    results,
    errors: batchErrors,
    image_format: 'jpg',
  };
}

function fillPoly(mask, maskW, coords, xOff, yOff) {
  const pts = coords.map(([x, y]) => [x - xOff, y - yOff]);
  const maskH = Math.floor(mask.length / maskW);
  const n = pts.length;
  for (let y = 0; y < maskH; y++) {
    const xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[j];
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
        xs.push(Math.round(x0 + (y - y0) * (x1 - x0) / (y1 - y0)));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k < xs.length - 1; k += 2) {
      const x0 = Math.max(0, xs[k]), x1 = Math.min(maskW, xs[k+1]);
      for (let x = x0; x < x1; x++) mask[y * maskW + x] = 1;
    }
  }
}

// ── Native OS file picker ────────────────────────────────────────────────────
function runPicker(mode) {  // mode: 'file' | 'dir'
  const plat = process.platform;
  if (plat === 'darwin') {
    const script = mode === 'file'
      ? 'try\nset f to choose file with prompt "Select WSI slide — original stays in place" of type {"svs","ndpi","tiff","tif","mrxs","czi","scn","vms","vmu"}\nPOSIX path of f\non error\n""\nend try'
      : 'try\nset f to choose folder with prompt "Select folder containing WSI slides"\nPOSIX path of f\non error\n""\nend try';
    const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 300000 });
    const p = (r.stdout || '').trim().replace(/\/$/, '');
    return p || null;
  }
  // Linux / Windows: tkinter in a subprocess
  const tkScript = mode === 'file'
    ? `import sys\ntry:\n import tkinter as tk\n from tkinter import filedialog\n root = tk.Tk(); root.withdraw()\n try: root.wm_attributes('-topmost', True)\n except: pass\n p = filedialog.askopenfilename(title='Select WSI file',filetypes=[('WSI','*.svs *.ndpi *.tiff *.tif *.mrxs *.czi'),('All','*.*')])\n root.destroy(); print(p or '',end='')\nexcept: print('',end='')`
    : `import sys\ntry:\n import tkinter as tk\n from tkinter import filedialog\n root = tk.Tk(); root.withdraw()\n try: root.wm_attributes('-topmost', True)\n except: pass\n p = filedialog.askdirectory(title='Select folder with WSI slides')\n root.destroy(); print(p or '',end='')\nexcept: print('',end='')`;
  const pyBin = process.env.CONDA_PREFIX
    ? path.join(process.env.CONDA_PREFIX, 'bin', 'python')
    : 'python3';
  const r = spawnSync(pyBin, ['-c', tkScript], { encoding: 'utf8', timeout: 300000 });
  return (r.stdout || '').trim() || null;
}

// ── Cloud download ────────────────────────────────────────────────────────────
const _cloudJobs  = new Map();
const GDC_API = 'https://api.gdc.cancer.gov';

function parseCloudUrl(url) {
  url = url.trim();
  // Google Drive
  const gdPats = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
    /docs\.google\.com\/[^/]+\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/uc\?.*?id=([a-zA-Z0-9_-]+)/,
  ];
  for (const p of gdPats) {
    const m = url.match(p);
    if (m) return { provider: 'Google Drive',
      downloadUrl: `https://drive.google.com/uc?export=download&confirm=t&id=${m[1]}`,
      hint: `gdrive_${m[1].slice(0,8)}.svs` };
  }
  // Box
  const bm = url.match(/box\.com\/s\/([a-zA-Z0-9]+)/);
  if (bm) return { provider: 'Box',
    downloadUrl: `https://app.box.com/shared/static/${bm[1]}`,
    hint: `box_${bm[1].slice(0,8)}.svs` };
  // OneDrive
  if (url.includes('1drv.ms') || url.includes('sharepoint.com') || url.includes('onedrive.live.com')) {
    const sep = url.includes('?') ? '&' : '?';
    return { provider: 'OneDrive', downloadUrl: url + sep + 'download=1', hint: 'onedrive_slide.svs' };
  }
  throw new Error('Unrecognised cloud URL. Supported: Google Drive, Box, OneDrive.');
}

async function downloadFile(url, dest, jobId, provider, authToken = null) {
  const job = _cloudJobs.get(jobId);
  if (job) job.status = 'downloading';

  const headers = { 'User-Agent': 'Mozilla/5.0 Chrome/120' };
  if (authToken) headers['X-Auth-Token'] = authToken;

  // Google Drive confirmation
  let dlUrl = url;
  if (url.includes('google')) {
    const r0 = await fetch(url, { headers, redirect: 'follow' });
    if ((r0.headers.get('content-type') || '').includes('text/html')) {
      const html = await r0.text();
      const m = html.match(/name="confirm"\s+value="([^"]+)"/);
      const cookie = r0.headers.get('set-cookie') || '';
      const cm = cookie.match(/download_warning=([^;]+)/);
      const tok = (m && m[1]) || (cm && cm[1]);
      if (tok) dlUrl = url + (url.includes('?') ? '&' : '?') + 'confirm=' + tok;
    }
  }

  const r = await fetch(dlUrl, { headers, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  if ((r.headers.get('content-type') || '').includes('text/html'))
    throw new Error('Got HTML page — check share link is public (Anyone with link)');

  const total = parseInt(r.headers.get('content-length') || '0', 10);
  let done = 0;

  const ws = fs.createWriteStream(dest);
  const reader = r.body.getReader();
  while (true) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    ws.write(Buffer.from(value));
    done += value.length;
    if (total && _cloudJobs.has(jobId)) {
      _cloudJobs.get(jobId).progress = Math.round(done / total * 100);
      _cloudJobs.get(jobId).bytes_done = done;
    }
  }
  await new Promise((res, rej) => ws.end(err => err ? rej(err) : res()));

  const size = fs.statSync(dest).size;
  if (size < 10000) {
    fs.unlinkSync(dest);
    throw new Error(`Downloaded only ${size} bytes — not a valid WSI. Check share link.`);
  }

  const sid = pathToId(dest);
  const name = path.basename(dest);
  const reg = loadRegistry();
  reg[sid] = { name, path: dest, source: `cloud_${provider.toLowerCase().replace(' ','_')}` };
  saveRegistry(reg);

  if (_cloudJobs.has(jobId))
    Object.assign(_cloudJobs.get(jobId), { status: 'done', progress: 100, slide_id: sid, name,
                                           size_mb: Math.round(size / 1048576 * 10) / 10 });
}

// ── TCGA / NCI GDC helpers ──────────────────────────────────────────────────
// All queries use the official GDC REST API: https://api.gdc.cancer.gov
// Documentation: https://docs.gdc.cancer.gov/API/Users_Guide/Getting_Started/
//
// Key rules discovered from GDC docs:
//  - GET is fine for simple single-field queries (projects, status)
//  - POST to /files and /cases is required for complex multi-field filter payloads
//    (GET has URL length limits that break complex filter JSON)
//  - Filters use { op, content } structure — wildcards (*) are NOT supported
//    with the "=" operator; use "in" for lists or fetch more + client-filter
//  - Slide images: data_type="Slide Image", data_format="SVS", data_category="Biospecimen"
//  - Download: GET https://api.gdc.cancer.gov/data/{uuid}  (+ X-Auth-Token for controlled)
//  - Auth: X-Auth-Token header, token obtained from portal.gdc.cancer.gov

// GDC_API already declared above (const GDC_API = 'https://api.gdc.cancer.gov')
let   _gdcToken = '';            // session-only, never written to disk
const _tcgaJobs = new Map();     // jobId → download status

/** GET helper — for lightweight queries (status, projects, single-item lookups) */
async function gdcGet(endpoint, params = {}) {
  const url = new URL(GDC_API + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json' };
  if (_gdcToken) headers['X-Auth-Token'] = _gdcToken;
  const r = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`GDC ${r.status}: ${(txt || r.statusText).slice(0, 300)}`);
  }
  return r.json();
}

/** POST helper — required for files/cases with complex filter payloads */
async function gdcPost(endpoint, payload = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (_gdcToken) headers['X-Auth-Token'] = _gdcToken;
  const r = await fetch(GDC_API + endpoint, {
    method:  'POST',
    headers,
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(60000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`GDC ${r.status}: ${(txt || r.statusText).slice(0, 300)}`);
  }
  return r.json();
}

// ── Express app ──────────────────────────────────────────────────────────────
const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/static', express.static(path.join(BASE_DIR, 'static')));

// ── Frontend ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.type('html').send(HTML));

// ── Slide registry ────────────────────────────────────────────────────────────
app.post('/api/registry/add-file', (req, res) => {
  const p = (req.body.path || '').trim();
  if (!p) return res.status(400).json({ error: 'path required' });
  if (!fs.existsSync(p)) return res.status(404).json({ error: `File not found: ${p}` });
  const ext = path.extname(p).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) return res.status(400).json({ error: `Unsupported: ${ext}` });
  const sid = pathToId(p);
  const reg = loadRegistry();
  reg[sid]  = { name: path.basename(p), path: path.resolve(p), source: 'local' };
  saveRegistry(reg);
  res.json({ id: sid, name: path.basename(p), path: path.resolve(p) });
});

app.post('/api/registry/add-dir', (req, res) => {
  const p = (req.body.path || '').trim();
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory())
    return res.status(404).json({ error: `Not a directory: ${p}` });
  const cfg = loadConfig();
  const abs = path.resolve(p);
  if (!cfg.watch_dirs.includes(abs)) { cfg.watch_dirs.push(abs); saveConfig(cfg); }
  const found = fs.readdirSync(p).filter(f => SUPPORTED_EXT.has(path.extname(f).toLowerCase()));
  res.json({ dir: abs, found: found.length, files: found.slice(0, 20) });
});

// ── Slides ────────────────────────────────────────────────────────────────────
app.get('/api/slides', async (req, res) => {
  if (!OSL) return res.json({ error: 'OpenSlide not loaded', slides: [] });
  const remoteReg = loadRemoteReg();
  const slides = discoverSlides();
  const out = [];

  for (const s of slides) {
    if (remoteReg[s.id] || s.is_remote) {
      const ann = loadAnn(s.id);
      const cached = _streamCache.get(s.id);
      out.push({
        id: s.id,
        name: s.name,
        source: s.source || 'stream',
        real_path: s.path,
        remote_url: s.url || s.path,
        is_remote: true,
        dimensions: cached ? [cached.W, cached.H] : undefined,
        level_count: cached && cached.levels ? cached.levels.length : undefined,
        annotation_count: (ann.annotations || []).length,
        file_size_mb: null,
      });
      continue;
    }

    try {
      out.push(buildMeta(s.id, openOsr(s.id).osr, s.path));
    } catch (e) {
      out.push({
        id: s.id,
        name: s.name,
        real_path: s.path,
        error: e.message,
        annotation_count: 0,
        file_size_mb: (() => {
          try { return Math.round(fs.statSync(s.path).size / 1048576 * 10) / 10; }
          catch { return 0; }
        })(),
      });
    }
  }

  res.json(out);
});

app.get('/api/slides/:id/info', async (req, res) => {
  const sid = req.params.id;
  const rem = loadRemoteReg();
  if (rem[sid]) {
    try {
      const m = await openRemote(sid, rem[sid].url, rem[sid].token || _gdcToken || null);
      const annData = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(ANNOTATIONS_DIR, sid + '.json'), 'utf8')); }
        catch { return { annotations: [] }; }
      })();
      return res.json({
        id: sid,
        name: rem[sid].name,
        source: rem[sid].source || 'stream',
        dimensions: [m.W, m.H],
        level_count: m.levels.length,
        level_dimensions: m.levels.map(l => [l.W, l.H]),
        level_downsamples: m.levels.map(l => m.W / l.W),
        is_remote: true,
        annotation_count: (annData.annotations || []).length,
        vendor: 'remote-stream',
        mpp_x: null,
        mpp_y: null,
        objective_power: null,
        file_size_mb: null,
        real_path: rem[sid].url,
        remote_url: rem[sid].url,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  try {
    const { meta } = openOsr(sid);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/slides/:id/thumbnail', async (req, res) => {
  try {
    const sz   = parseInt(req.query.size || '256', 10);
    const file = await getThumbnail(req.params.id, sz);
    res.set('Cache-Control', 'public, max-age=3600');
    res.sendFile(file);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/slides/:id', (req, res) => {
  const sid = req.params.id;
  closeOsr(sid);
  const reg = loadRegistry();
  const info = reg[sid];
  delete reg[sid];
  saveRegistry(reg);
  // Only delete file if it was a cloud/TCGA download
  if (info && (info.source || '').startsWith('cloud_') || (info?.source || '').startsWith('tcga')) {
    try { fs.unlinkSync(info.path); } catch {}
  }
  try { fs.unlinkSync(annFile(sid)); } catch {}
  try { fs.unlinkSync(path.join(THUMBNAILS_DIR, `${sid.replace(/[/\\]/g,'_')}_256.jpg`)); } catch {}
  res.json({ status: 'removed' });
});

// ── DZI + Tiles ───────────────────────────────────────────────────────────────
app.get('/api/slides/:id/dzi', async (req, res) => {
  const sid = req.params.id;
  const rem = loadRemoteReg();
  if (rem[sid]) {
    try {
      const m = await openRemote(sid, rem[sid].url, rem[sid].token || _gdcToken || null);
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Image xmlns="http://schemas.microsoft.com/deepzoom/2008" Format="jpeg" Overlap="1" TileSize="254"><Size Width="${m.W}" Height="${m.H}"/></Image>`;
      return res.set('Content-Type','application/xml').set('Cache-Control','public,max-age=300').send(xml);
    } catch(e) { return res.status(500).send('Error: '+e.message); }
  }
  try { const { dz } = openOsr(sid); res.set('Content-Type','application/xml').set('Cache-Control','public,max-age=3600').send(dz.getDziXml()); }
  catch(e) { res.status(500).send('Error: '+e.message); }
});

app.get('/api/slides/:id/tiles/:level/:col/:row', async (req, res) => {
  const sid = req.params.id;
  const rem = loadRemoteReg();
  if (rem[sid]) {
    try {
      const tok = rem[sid].token || _gdcToken || null;
      const jpg = await getStreamTile(sid, rem[sid].url, tok,
        parseInt(req.params.level), parseInt(req.params.col), parseInt(req.params.row));
      return res.set('Content-Type','image/jpeg').set('Cache-Control','public,max-age=3600').send(jpg);
    } catch(e) { return res.status(404).end(); }
  }
  try {
    const jpg = await renderTile(sid, parseInt(req.params.level), parseInt(req.params.col), parseInt(req.params.row));
    res.set('Content-Type','image/jpeg').set('Cache-Control','public,max-age=3600').send(jpg);
  } catch(e) { res.status(404).end(); }
});

// ── Annotations ───────────────────────────────────────────────────────────────
app.get('/api/annotations/:id',  (req, res) => res.json(loadAnn(req.params.id)));

app.post('/api/annotations/:id', (req, res) => {
  if (!req.body) return res.status(400).json({ error: 'No data' });
  saveAnn(req.params.id, req.body);
  res.json({ status: 'saved', count: (req.body.annotations || []).length });
});

app.post('/api/annotations/:id/import', upload.single('file'), (req, res) => {
  const mode = req.query.mode || 'replace';
  let imported;
  try { imported = JSON.parse(req.file ? req.file.buffer.toString() : JSON.stringify(req.body)); }
  catch(e) { return res.status(400).json({ error: `Invalid JSON: ${e.message}` }); }

  const importedAnns = imported.annotations || (Array.isArray(imported) ? imported : []);
  const importedCls  = imported.classes || [];
  const current      = loadAnn(req.params.id);

  if (mode === 'merge') {
    const existIds = new Set(current.annotations.map(a => a.id));
    const newAnns  = importedAnns.filter(a => !existIds.has(a.id));
    current.annotations.push(...newAnns);
    const existCls = new Set(current.classes.map(c => c.id));
    importedCls.filter(c => !existCls.has(c.id)).forEach(c => current.classes.push(c));
    saveAnn(req.params.id, current);
    res.json({ status: 'imported', mode, added: newAnns.length,
               total: current.annotations.length, classes: current.classes.length });
  } else {
    current.annotations = importedAnns;
    if (importedCls.length) current.classes = importedCls;
    saveAnn(req.params.id, current);
    res.json({ status: 'imported', mode, added: importedAnns.length,
               total: importedAnns.length, classes: current.classes.length });
  }
});

app.get('/api/annotations/:id/export', (req, res) => {
  const fmt  = (req.query.format || 'json').toLowerCase();
  const data = loadAnn(req.params.id);
  const name = (loadRegistry()[req.params.id]?.name || req.params.id).replace(/\.[^.]+$/, '');

  if (fmt === 'geojson') {
    res.set('Content-Disposition', `attachment; filename="${name}.geojson"`)
       .json(toGeoJson(data));
  } else if (fmt === 'csv') {
    const rows = ['id,type,label,color,area_px,x_min,y_min,x_max,y_max,notes,created'];
    for (const a of (data.annotations || [])) {
      const coords = a.coordinates || [];
      const xs = coords.map(p => p[0]), ys = coords.map(p => p[1]);
      rows.push([a.id, a.type, a.label, a.color, a.area_px || 0,
        xs.length ? Math.round(Math.min(...xs)) : 0,
        ys.length ? Math.round(Math.min(...ys)) : 0,
        xs.length ? Math.round(Math.max(...xs)) : 0,
        ys.length ? Math.round(Math.max(...ys)) : 0,
        `"${(a.notes || '').replace(/"/g,'""')}"`, a.created || ''].join(','));
    }
    res.set('Content-Disposition', `attachment; filename="${name}_annotations.csv"`)
       .type('text/csv').send(rows.join('\n'));
  } else {
    res.set('Content-Disposition', `attachment; filename="${name}_annotations.json"`)
       .json(data);
  }
});

// ── Extraction ────────────────────────────────────────────────────────────────
app.post('/api/slides/:id/extract/validate', (req, res) => {
  try {
    const { patch_size = 256, level = 0, label_filter = null } = req.body;
    const { meta } = openOsr(req.params.id);
    const ann = loadAnn(req.params.id);
    let anns = ann.annotations || [];
    if (label_filter && label_filter.length) anns = anns.filter(a => label_filter.includes(a.label));
    const safeLv = Math.min(level, meta.level_count - 1);
    const ds = meta.level_downsamples[safeLv];
    const step = patch_size * ds;
    let ok = 0, too_small = 0;
    const out = anns.map(a => {
      const coords = a.coordinates || [];
      if (!coords.length) return { ...a, status: 'skip', roi_area_px2: 0 };
      const xs = coords.map(p => p[0]), ys = coords.map(p => p[1]);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      const area = w * h;
      if (area < step * step) {
        too_small++;
        const sps = Math.round(Math.min(w, h) / ds);
        const rec = sps >= 32 ? { suggest_patch_size: Math.floor(sps / 32) * 32 }
                               : { suggest_level: Math.min(level + 1, meta.level_count - 1) };
        return { ...a, status: 'too_small', roi_area_px2: area, recommendation: rec };
      }
      ok++;
      return { ...a, status: 'ok', roi_area_px2: area };
    });
    res.json({ annotations: out, summary: { total: anns.length, ok, too_small },
               patch_size, level });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/slides/:id/extract', async (req, res) => {
  try {
    const result = await extractPatches(req.params.id, req.body);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/slides/extract-batch', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.slide_ids) ? req.body.slide_ids : [];
    const result = await extractPatchesBatch(ids, req.body || {});
    if (result && result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Blurriness ────────────────────────────────────────────────────────────────
app.get('/api/slides/:id/blurriness', async (req, res) => {
  try {
    const t = parseFloat(req.query.threshold || '100');
    res.json(await checkBlur(req.params.id, t));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const slides = discoverSlides().length;
  let ann = 0;
  try { ann = fs.readdirSync(ANNOTATIONS_DIR).filter(f => f.endsWith('.json')).length; } catch {}
  res.json({ slides, annotated_slides: ann, openslide: !!OSL, cache_dir: CACHE_DIR });
});

// ── Browse ────────────────────────────────────────────────────────────────────
// ── Cloud/headless detection ─────────────────────────────────────────────────
function isHeadless() {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return true;
  if (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME) return true;
  return false;
}
const CLOUD_MSG = 'File browser not available on cloud. Use the TCGA tab to stream slides, or paste a path in the Path tab.';

app.get('/api/browse', (req, res) => {
  if (isHeadless()) return res.json({ error: CLOUD_MSG, fallback: true });
  try {
    const p = runPicker('file');
    res.json(p ? { path: p, name: path.basename(p) } : { path: null });
  } catch(e) { res.json({ error: e.message, fallback: true }); }
});

app.get('/api/browse-dir', (req, res) => {
  if (isHeadless()) return res.json({ error: CLOUD_MSG, fallback: true });
  try {
    const p = runPicker('dir');
    res.json(p ? { path: p } : { path: null });
  } catch(e) { res.json({ error: e.message, fallback: true }); }
});

// ── Cloud download ─────────────────────────────────────────────────────────────
app.post('/api/cloud/add', async (req, res) => {
  const url = (req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });
  let info;
  try { info = parseCloudUrl(url); }
  catch(e) { return res.status(400).json({ error: e.message }); }

  const jobId = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
  const ex    = _cloudJobs.get(jobId);
  if (ex && ['downloading', 'done'].includes(ex.status))
    return res.json({ ...ex, job_id: jobId });

  const dest = path.join(CACHE_DIR, info.hint);
  _cloudJobs.set(jobId, { status: 'queued', progress: 0, name: info.hint, provider: info.provider });
  res.json({ job_id: jobId, status: 'queued', provider: info.provider, name: info.hint });

  downloadFile(info.downloadUrl, dest, jobId, info.provider)
    .catch(e => {
      console.error('  Cloud download error:', e.message);
      const j = _cloudJobs.get(jobId);
      if (j) j.status = 'error', j.error = e.message;
    });
});

app.get('/api/cloud/status/:id', (req, res) => {
  const job = _cloudJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json({ ...job, job_id: req.params.id });
});

// ── Hardcoded TCGA project list (fallback when GDC API is slow/unreachable) ──
// All 33 TCGA projects as of GDC Data Release 43.0
const TCGA_PROJECTS_FALLBACK = [
  {id:'TCGA-ACC',  name:'Adrenocortical Carcinoma',                        cases:92},
  {id:'TCGA-BLCA', name:'Bladder Urothelial Carcinoma',                    cases:412},
  {id:'TCGA-BRCA', name:'Breast Invasive Carcinoma',                       cases:1098},
  {id:'TCGA-CESC', name:'Cervical Squamous Cell Carcinoma & Adenocarcinoma',cases:307},
  {id:'TCGA-CHOL', name:'Cholangiocarcinoma',                              cases:51},
  {id:'TCGA-COAD', name:'Colon Adenocarcinoma',                            cases:461},
  {id:'TCGA-DLBC', name:'Lymphoid Neoplasm Diffuse Large B-cell Lymphoma', cases:58},
  {id:'TCGA-ESCA', name:'Esophageal Carcinoma',                            cases:185},
  {id:'TCGA-GBM',  name:'Glioblastoma Multiforme',                        cases:617},
  {id:'TCGA-HNSC', name:'Head & Neck Squamous Cell Carcinoma',             cases:528},
  {id:'TCGA-KICH', name:'Kidney Chromophobe',                              cases:113},
  {id:'TCGA-KIRC', name:'Kidney Renal Clear Cell Carcinoma',               cases:537},
  {id:'TCGA-KIRP', name:'Kidney Renal Papillary Cell Carcinoma',           cases:291},
  {id:'TCGA-LAML', name:'Acute Myeloid Leukemia',                          cases:200},
  {id:'TCGA-LGG',  name:'Brain Lower Grade Glioma',                        cases:516},
  {id:'TCGA-LIHC', name:'Liver Hepatocellular Carcinoma',                  cases:377},
  {id:'TCGA-LUAD', name:'Lung Adenocarcinoma',                             cases:585},
  {id:'TCGA-LUSC', name:'Lung Squamous Cell Carcinoma',                    cases:504},
  {id:'TCGA-MESO', name:'Mesothelioma',                                    cases:87},
  {id:'TCGA-OV',   name:'Ovarian Serous Cystadenocarcinoma',               cases:608},
  {id:'TCGA-PAAD', name:'Pancreatic Adenocarcinoma',                       cases:185},
  {id:'TCGA-PCPG', name:'Pheochromocytoma & Paraganglioma',                cases:179},
  {id:'TCGA-PRAD', name:'Prostate Adenocarcinoma',                         cases:500},
  {id:'TCGA-READ', name:'Rectum Adenocarcinoma',                           cases:172},
  {id:'TCGA-SARC', name:'Sarcoma',                                         cases:261},
  {id:'TCGA-SKCM', name:'Skin Cutaneous Melanoma',                         cases:470},
  {id:'TCGA-STAD', name:'Stomach Adenocarcinoma',                          cases:443},
  {id:'TCGA-TGCT', name:'Testicular Germ Cell Tumors',                     cases:150},
  {id:'TCGA-THCA', name:'Thyroid Carcinoma',                               cases:507},
  {id:'TCGA-THYM', name:'Thymoma',                                         cases:124},
  {id:'TCGA-UCEC', name:'Uterine Corpus Endometrial Carcinoma',            cases:560},
  {id:'TCGA-UCS',  name:'Uterine Carcinosarcoma',                          cases:57},
  {id:'TCGA-UVM',  name:'Uveal Melanoma',                                  cases:80},
];


// ── /api/tcga/token  (store session token) ────────────────────────────────────
app.post('/api/tcga/token', (req, res) => {
  _gdcToken = (req.body.token || '').trim();
  res.json({ status: _gdcToken ? 'saved' : 'cleared',
             message: _gdcToken ? 'Token active for this session' : 'Token cleared' });
});

// ── /api/tcga/status  (ping GDC API & report version) ────────────────────────
app.get('/api/tcga/status', async (req, res) => {
  try {
    const d = await gdcGet('/status');
    res.json({ ok: true, status: d.status, version: d.tag, commit: d.commit,
               auth: !!_gdcToken });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── /api/tcga/projects  (list all TCGA projects) ─────────────────────────────
// Uses GET — the filter is small enough.
// GDC filter operators: =, !=, in, exclude, is, not, and, or
app.get('/api/tcga/projects', async (req, res) => {
  try {
    // Fetch ALL projects (no filter — the program.name filter can fail silently on some GDC versions).
    // We then filter client-side in the frontend for project_ids starting with "TCGA-".
    // This guarantees all 33 TCGA projects appear even if the API filter misbehaves.
    const data = await gdcGet('/projects', {
      fields: 'project_id,name,primary_site,disease_type,summary.case_count,summary.file_count',
      format: 'json',
      size:   '200',    // GDC has ~60 projects total; 200 ensures we get everything
      sort:   'project_id:asc',
    });

    // Filter to TCGA projects only (project_id starts with "TCGA-")
    if (data && data.data && data.data.hits) {
      data.data.hits = data.data.hits.filter(p =>
        p.project_id && p.project_id.startsWith('TCGA-')
      );
      // If the live API returns nothing (network issue etc.), fall back to hardcoded list
      if (!data.data.hits.length) {
        console.warn('  GDC API returned no TCGA projects — using hardcoded fallback list');
        data.data.hits = TCGA_PROJECTS_FALLBACK.map(p => ({ project_id: p.id, name: p.name, summary: { case_count: p.cases } }));
      }
    }
    res.json(data);
  } catch(e) {
    // On any network error, return the hardcoded fallback list so the UI still works
    console.warn('  GDC /projects error, using fallback:', e.message);
    res.json({
      data: {
        hits: TCGA_PROJECTS_FALLBACK.map(p => ({ project_id: p.id, name: p.name, summary: { case_count: p.cases } })),
        pagination: { total: TCGA_PROJECTS_FALLBACK.length }
      }
    });
  }
});

// ── /api/tcga/files  (search SVS slide images) ───────────────────────────────
// Uses POST — complex filter + pagination would break URL length limit with GET.
//
// GDC slide image fields:
//   data_category = "Biospecimen"
//   data_type     = "Slide Image"
//   data_format   = "SVS"
//
// Wildcards (*) are NOT supported by GDC's "=" operator.
// For partial-name search we fetch a larger set and filter client-side.
app.get('/api/tcga/files', async (req, res) => {
  try {
    const project = (req.query.project || '').trim();
    const search  = (req.query.search  || '').trim().toLowerCase();
    const page    = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = 50;                  // files per page
    // When searching, fetch more so client-side filter still fills a page
    const fetchSize = search ? 200 : pageSize;
    const fetchFrom = search ? 0 : (page - 1) * pageSize;

    if (!project) {
      return res.json({ data: { hits: [], pagination: { total: 0, count: 0, page: 1, pages: 0 } },
                        message: 'Select a TCGA project to browse slide images.' });
    }

    // Build filter conditions
    const conditions = [
      { op: '=', content: { field: 'data_category', value: 'Biospecimen'  } },
      { op: '=', content: { field: 'data_type',     value: 'Slide Image'  } },
      { op: '=', content: { field: 'data_format',   value: 'SVS'          } },
      { op: '=', content: { field: 'cases.project.project_id', value: project } },
    ];

    // If search looks like an exact TCGA barcode, use the `in` operator for precision
    if (search && /^tcga-[a-z0-9-]+$/i.test(search)) {
      conditions.push({
        op:      'in',
        content: { field: 'cases.submitter_id', value: [search.toUpperCase()] },
      });
    }

    const payload = {
      filters: { op: 'and', content: conditions },
      fields:  [
        'file_id', 'file_name', 'file_size', 'data_format',
        'access', 'state', 'created_datetime', 'updated_datetime',
        'cases.submitter_id', 'cases.case_id',
        'cases.project.project_id', 'cases.disease_type',
        'cases.primary_site',
      ].join(','),
      format: 'json',
      size:   fetchSize,
      from:   fetchFrom,
      sort:   'file_name:asc',
    };

    const data = await gdcPost('/files', payload);

    // Client-side substring filter when search term is a partial name
    if (search && !/^tcga-[a-z0-9-]+$/i.test(search) && data.data && data.data.hits) {
      data.data.hits = data.data.hits.filter(f =>
        f.file_name.toLowerCase().includes(search) ||
        (f.cases || []).some(c => (c.submitter_id || '').toLowerCase().includes(search))
      );
      // Paginate client-filtered results
      const total  = data.data.hits.length;
      const pages  = Math.ceil(total / pageSize) || 1;
      const start  = (page - 1) * pageSize;
      data.data.hits = data.data.hits.slice(start, start + pageSize);
      data.data.pagination = { total, count: data.data.hits.length,
                               page, pages, size: pageSize };
    }

    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── /api/tcga/file/:id  (metadata for a single file) ─────────────────────────
app.get('/api/tcga/file/:id', async (req, res) => {
  try {
    const data = await gdcGet(`/files/${req.params.id}`, {
      fields: 'file_id,file_name,file_size,data_format,access,state,md5sum,cases.submitter_id,cases.project.project_id',
      format: 'json',
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── /api/tcga/cases  (case metadata for a project) ───────────────────────────
app.get('/api/tcga/cases', async (req, res) => {
  try {
    const project = (req.query.project || '').trim();
    if (!project) return res.json({ data: { hits: [] } });

    const data = await gdcPost('/cases', {
      filters: {
        op:      '=',
        content: { field: 'project.project_id', value: project },
      },
      fields: 'case_id,submitter_id,disease_type,primary_site,diagnoses.primary_diagnosis,demographic.gender',
      format: 'json',
      size:   50,
      sort:   'submitter_id:asc',
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── /api/tcga/download  (stream file from GDC to local cache) ─────────────────
// GDC download endpoint: GET https://api.gdc.cancer.gov/data/{file_uuid}
// For open-access files: no token needed.
// For controlled-access: X-Auth-Token header required.
app.post('/api/tcga/download', async (req, res) => {
  const { file_id, file_name, access, project } = req.body;
  if (!file_id) return res.status(400).json({ error: 'file_id required' });

  // Reject controlled-access if no token configured
  if (access === 'controlled' && !_gdcToken) {
    return res.status(403).json({
      error: 'This file requires controlled access. Paste your GDC authentication token in the TCGA panel first.',
    });
  }

  const jobId  = 'tcga_' + crypto.createHash('sha256').update(file_id).digest('hex').slice(0, 12);
  const fname  = file_name || `${file_id}.svs`;
  const dest   = path.join(CACHE_DIR, fname);

  // De-duplicate: return existing job if already running or done
  const ex = _tcgaJobs.get(jobId);
  if (ex && ['queued', 'downloading', 'done'].includes(ex.status)) {
    return res.json({ ...ex, job_id: jobId });
  }

  // If file already exists and is valid, register and return immediately
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) {
    const sid = pathToId(dest);
    const reg = loadRegistry();
    if (!reg[sid]) {
      reg[sid] = { name: fname, path: dest, source: 'tcga', file_id, project: project || '' };
      saveRegistry(reg);
    }
    const job = { status: 'done', progress: 100, name: fname, file_id, slide_id: sid,
                  size_mb: Math.round(fs.statSync(dest).size / 1048576 * 10) / 10 };
    _tcgaJobs.set(jobId, job);
    return res.json({ ...job, job_id: jobId });
  }

  // Queue new download
  const job = { status: 'queued', progress: 0, name: fname, file_id,
                access: access || 'open', project: project || '' };
  _tcgaJobs.set(jobId, job);
  res.json({ job_id: jobId, status: 'queued', name: fname });

  // ── Background download ──────────────────────────────────────────────────
  setImmediate(async () => {
    job.status = 'downloading';
    const ws = fs.createWriteStream(dest);
    try {
      const headers = {
        'User-Agent': 'Monjoy.AI/2.0 (WSI Annotation Tool)',
        Accept:       'application/octet-stream',
      };
      if (_gdcToken) headers['X-Auth-Token'] = _gdcToken;

      // GDC data endpoint: GET /data/{uuid}
      const r = await fetch(`${GDC_API}/data/${file_id}`, {
        method:   'GET',
        headers,
        redirect: 'follow',
        signal:   AbortSignal.timeout(3600000),  // 1 hour max
      });

      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`GDC returned ${r.status}: ${(txt || r.statusText).slice(0, 200)}`);
      }

      // Verify we didn't get an HTML error page
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        const preview = await r.text().catch(() => '');
        throw new Error(
          'GDC returned HTML instead of binary data. ' +
          (access === 'controlled' ? 'Your token may have expired.' : 'The file may not be open-access.') +
          ' Preview: ' + preview.replace(/<[^>]+>/g, ' ').trim().slice(0, 120)
        );
      }

      const total = parseInt(r.headers.get('content-length') || '0', 10);
      let done = 0;

      // Try to get real filename from Content-Disposition header
      const cd = r.headers.get('content-disposition') || '';
      const fnMatch = cd.match(/filename[*]?=["']?([^"';\r\n]+)/i);
      if (fnMatch) {
        const suggested = fnMatch[1].trim().replace(/['"]/g, '');
        if (/\.(svs|ndpi|tiff?|mrxs|czi|scn)$/i.test(suggested)) {
          // Use the server-suggested filename if it looks like a WSI
          // (dest stays the same, we just note the real name)
          job.real_name = suggested;
        }
      }

      // Stream body to disk
      const reader = r.body.getReader();
      let lastPct  = 0;
      while (true) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        ws.write(Buffer.from(value));
        done += value.length;
        if (total) {
          const pct = Math.min(99, Math.round(done / total * 100));
          if (pct !== lastPct) { job.progress = pct; job.bytes_done = done; lastPct = pct; }
        } else {
          job.bytes_done = done;  // unknown total — just show bytes
        }
      }

      await new Promise((ok, fail) => ws.end(err => err ? fail(err) : ok()));

      const size = fs.statSync(dest).size;
      if (size < 50000) {
        // File too small — almost certainly an error page or auth redirect HTML
        const preview = fs.readFileSync(dest, 'utf8').slice(0, 200);
        fs.unlinkSync(dest);
        throw new Error(
          `Downloaded file is only ${size} bytes (expected MB-range WSI). ` +
          'GDC may require a token for this file. ' +
          'Content preview: ' + preview.replace(/<[^>]+>/g, ' ').slice(0, 100)
        );
      }

      // Register in slide registry
      const sid = pathToId(dest);
      const reg = loadRegistry();
      reg[sid] = {
        name:    fname,
        path:    dest,
        source:  'tcga',
        file_id,
        project: project || '',
      };
      saveRegistry(reg);

      Object.assign(job, {
        status:   'done',
        progress: 100,
        slide_id: sid,
        size_mb:  Math.round(size / 1048576 * 10) / 10,
      });
      console.log(`  TCGA download done: ${fname} (${job.size_mb} MB)`);

    } catch(e) {
      try { ws.destroy(); fs.unlinkSync(dest); } catch {}
      job.status = 'error';
      job.error  = e.message;
      console.error('  TCGA download error:', e.message);
    }
  });
});

// ── /api/tcga/status/:id  (poll a download job) ───────────────────────────────
app.get('/api/tcga/status/:id', (req, res) => {
  const job = _tcgaJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json({ ...job, job_id: req.params.id });
});

// ── /api/tcga/manifest  (download manifest for GDC Data Transfer Tool) ────────
// Returns a GDC manifest TSV for selected file IDs — can be used with gdc-client
app.post('/api/tcga/manifest', async (req, res) => {
  const ids = req.body.ids || [];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  try {
    const r = await fetch(`${GDC_API}/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) throw new Error(`GDC ${r.status}`);
    const tsv = await r.text();
    res.set('Content-Type', 'text/tab-separated-values');
    res.set('Content-Disposition', 'attachment; filename="gdc_manifest.txt"');
    res.send(tsv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── /api/paths ────────────────────────────────────────────────────────────────
app.get('/api/paths', (req, res) => {
  res.json({ patches_dir: PATCHES_DIR, annotations_dir: ANNOTATIONS_DIR,
             cache_dir: CACHE_DIR, base_dir: BASE_DIR, is_headless: isHeadless() });
});

// ── Upload WSI via browser ────────────────────────────────────────────────────
app.post('/api/slides/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const fname = req.file.originalname;
  const ext   = path.extname(fname).toLowerCase();
  if (!SUPPORTED_EXT.has(ext))
    return res.status(400).json({ error: `Unsupported format: ${ext}` });
  const dest = path.join(CACHE_DIR, fname);
  try {
    fs.writeFileSync(dest, req.file.buffer);
    const sid = pathToId(dest);
    const reg = loadRegistry();
    if (!reg[sid]) { reg[sid]={name:fname,path:dest,source:'uploaded'}; saveRegistry(reg); }
    res.json({ id:sid, name:fname, path:dest, size_mb:Math.round(req.file.size/1048576*10)/10 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Download patches as ZIP ───────────────────────────────────────────────────
app.get('/api/patches/zip/:subdir', (req, res) => {
  const sub=sanitizeOutputSubdir(req.params.subdir);
  const dir=path.join(PATCHES_DIR,sub);
  if (!fs.existsSync(dir)) return res.status(404).json({ error:'Folder not found: '+dir });
  const files=[];
  const walk=(d,pfx)=>{
    for(const f of fs.readdirSync(d)){
      const full=path.join(d,f),rel=pfx?pfx+'/'+f:f;
      if(fs.statSync(full).isDirectory()) walk(full,rel); else files.push({full,rel});
    }
  };
  walk(dir,sub);
  if(!files.length) return res.status(404).json({ error:'No files found' });
  res.set('Content-Type','application/zip');
  res.set('Content-Disposition',`attachment; filename="${sub}_patches.zip"`);
  const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n,0);return b;};
  const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n,0);return b;};
  const chunks=[],cd=[];
  let off=0;
  for(const{full,rel}of files){
    const data=fs.readFileSync(full),name=Buffer.from(rel,'utf8');
    let c=~0;
    for(let i=0;i<data.length;i++){c^=data[i];for(let j=0;j<8;j++)c=(c>>>1)^(0xEDB88320&-(c&1));}
    const crc=(~c)>>>0;
    const lh=Buffer.concat([Buffer.from([0x50,0x4B,0x03,0x04]),u16(20),u16(0x800),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name]);
    cd.push({off,name,crc,size:data.length}); chunks.push(lh,data); off+=lh.length+data.length;
  }
  const cdStart=off;
  for(const e of cd){
    const c2=Buffer.concat([Buffer.from([0x50,0x4B,0x01,0x02]),u16(20),u16(20),u16(0x800),u16(0),u16(0),u16(0),u32(e.crc),u32(e.size),u32(e.size),u16(e.name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(e.off),e.name]);
    chunks.push(c2); off+=c2.length;
  }
  chunks.push(Buffer.concat([Buffer.from([0x50,0x4B,0x05,0x06]),u16(0),u16(0),u16(cd.length),u16(cd.length),u32(off-cdStart),u32(cdStart),u16(0)]));
  res.send(Buffer.concat(chunks));
});

// ── Reveal patch folder ───────────────────────────────────────────────────────
app.get('/api/patches/reveal/:subdir', (req, res) => {
  if (isHeadless()) return res.json({ error:'Not available on server' });
  const sub=sanitizeOutputSubdir(req.params.subdir);
  const dir=path.join(PATCHES_DIR,sub);
  if (!fs.existsSync(dir)) return res.status(404).json({ error:'Not found: '+dir });
  try {
    const cmd=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open';
    spawnSync(cmd,[dir],{detached:true}); res.json({status:'opened',path:dir});
  } catch(e){res.json({error:e.message});}
});

// ── Download patch manifest JSON ──────────────────────────────────────────────
app.get('/api/patches/manifest/:subdir', (req, res) => {
  const sub = sanitizeOutputSubdir(req.params.subdir);
  const dir = path.join(PATCHES_DIR, sub);
  let mf = null;
  try {
    const files = fs.readdirSync(dir);
    mf = files.find(f => f === 'batch_manifest.json')
      || files.find(f => f.endsWith('_batch_manifest.json'))
      || files.find(f => f.endsWith('_manifest.json'));
  } catch (e) {
    return res.status(404).json({ error: 'Folder not found' });
  }
  if (!mf) return res.status(404).json({ error: 'No manifest found — re-extract patches to generate one' });
  res.set('Content-Disposition', 'attachment; filename="' + mf + '"');
  res.sendFile(path.join(dir, mf));
});


// ── HTML (inline template) ────────────────────────────────────────────────────
const HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\"/>\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\"/>\n<title>Monjoy.HistoAI — WSI Annotation Platform</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"/>\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin/>\n<link href=\"https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=DM+Mono:wght@400;500&display=swap\" rel=\"stylesheet\"/>\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/openseadragon.min.js\"></script>\n<style>\n:root{\n  --bg:#f7f9fc;--surface:#ffffff;--panel:#ffffffee;\n  --panel-s:#ffffff;--panel-hi:#f2f6fb;\n  --border:#d7e0ec;--border-hi:#c3d0e2;\n  --cyan:#0ea5e9;--cyan-dim:#e0f2fe;--cyan-glow:rgba(14,165,233,.08);\n  --violet:#7c3aed;--orange:#ea580c;\n  --success:#16a34a;--danger:#e11d48;--warning:#d97706;\n  --text:#0f172a;--text-muted:#64748b;--text-dim:#334155;\n  --viewer-bg:#eef2f7;--badge-bg:rgba(255,255,255,.92);\n  --radius:6px;--font:'DM Sans',sans-serif;--mono:'DM Mono',monospace;\n}\n*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}\nhtml,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);\n  font-family:var(--font);font-size:13px}\nbutton{font-family:var(--font);cursor:pointer;border:none;outline:none}\ninput,select,textarea{font-family:var(--font);color:var(--text);outline:none}\ninput:focus,select:focus,textarea:focus{border-color:var(--cyan-dim)}\n::-webkit-scrollbar{width:4px;height:4px}\n::-webkit-scrollbar-track{background:transparent}\n::-webkit-scrollbar-thumb{background:var(--border-hi);border-radius:2px}\n\n/* ── Layout ── */\n#app{display:flex;flex-direction:column;height:100vh}\n#topbar{display:flex;align-items:center;height:46px;background:var(--panel-s);\n  border-bottom:1px solid var(--border);padding:0 10px;gap:5px;\n  flex-shrink:0;z-index:100}\n#workspace{display:flex;flex:1;overflow:hidden}\n#sidebar-left{width:210px;display:flex;flex-direction:column;\n  background:var(--surface);border-right:1px solid var(--border);\n  overflow:hidden;flex-shrink:0}\n#viewer-wrap{flex:1;position:relative;background:var(--viewer-bg,#eef2f7);overflow:hidden}\n#sidebar-right{width:258px;display:flex;flex-direction:column;\n  background:var(--surface);border-left:1px solid var(--border);\n  overflow-y:auto;overflow-x:hidden;flex-shrink:0}\n#statusbar{height:24px;background:var(--panel-s);border-top:1px solid var(--border);\n  display:flex;align-items:center;padding:0 12px;gap:16px;\n  font-size:10.5px;color:var(--text-muted);font-family:var(--mono);flex-shrink:0}\n\n/* ── Logo ── */\n.logo{display:flex;align-items:center;gap:9px;text-decoration:none;flex-shrink:0}\n.logo-mark{width:28px;height:28px;flex-shrink:0}\n.logo-text{font-size:14.5px;font-weight:700;letter-spacing:-.3px;color:var(--text)}\n.logo-text em{color:var(--cyan);font-style:normal}\n.logo-text sup{font-size:8px;color:var(--cyan);vertical-align:super;margin-left:1px;\n  font-weight:600;letter-spacing:.5px}\n\n/* ── Topbar ── */\n.tb-div{width:1px;height:20px;background:var(--border);margin:0 1px;flex-shrink:0}\n.tool-btn{width:29px;height:29px;border-radius:var(--radius);background:transparent;\n  color:var(--text-dim);display:flex;align-items:center;justify-content:center;\n  font-size:15px;transition:all .15s;flex-shrink:0;position:relative}\n.tool-btn:hover{background:var(--panel-hi);color:var(--text)}\n.tool-btn.active{background:var(--cyan-dim);color:var(--cyan)}\n.tool-btn[data-tip]:hover::after{content:attr(data-tip);position:absolute;\n  top:34px;left:50%;transform:translateX(-50%);background:var(--panel-hi);\n  color:var(--text);padding:3px 7px;border-radius:4px;font-size:10px;\n  white-space:nowrap;pointer-events:none;z-index:999;border:1px solid var(--border-hi)}\n.cls-dot-tb{width:8px;height:8px;border-radius:50%;flex-shrink:0}\n.cls-sel{background:var(--panel-hi);border:1px solid var(--border-hi);\n  color:var(--text);padding:3px 20px 3px 7px;border-radius:var(--radius);\n  font-size:11.5px;min-width:110px;appearance:none;cursor:pointer;\n  background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%234a5a7a'/%3E%3C/svg%3E\");\n  background-repeat:no-repeat;background-position:right 6px center}\n.tb-spacer{flex:1}\n.tb-btn{padding:5px 11px;border-radius:var(--radius);font-size:11px;\n  font-weight:600;transition:all .15s;flex-shrink:0}\n.tb-btn.ghost{background:transparent;color:var(--text-dim);\n  border:1px solid var(--border-hi)}\n.tb-btn.ghost:hover{background:var(--panel-hi);color:var(--text)}\n.tb-btn.primary{background:var(--cyan-dim);color:var(--cyan);border:none}\n.tb-btn.primary:hover{background:var(--cyan);color:#000}\n\n/* ── Section headers ── */\n.ph{padding:7px 12px;font-size:9px;font-weight:700;letter-spacing:1.5px;\n  color:var(--text-muted);text-transform:uppercase;\n  border-bottom:1px solid var(--border);display:flex;align-items:center;\n  justify-content:space-between;flex-shrink:0}\n.ph-btn{width:20px;height:20px;border-radius:3px;background:transparent;\n  color:var(--text-muted);display:flex;align-items:center;\n  justify-content:center;font-size:12px;cursor:pointer}\n.ph-btn:hover{background:var(--border);color:var(--text)}\n.rs{border-bottom:1px solid var(--border);padding:9px 12px}\n.sec{font-size:9px;font-weight:700;letter-spacing:1.3px;\n  text-transform:uppercase;color:var(--text-muted);margin-bottom:7px}\n\n/* ── Slide list ── */\n#slide-list{flex:1;overflow-y:auto;padding:4px}\n.slide-item{display:flex;align-items:center;gap:7px;padding:5px 7px;\n  border-radius:var(--radius);cursor:pointer;border:1px solid transparent;\n  transition:all .15s;margin-bottom:2px}\n.slide-item:hover{background:var(--panel-s);border-color:var(--border)}\n.slide-item.active{background:var(--panel-hi);border-color:var(--cyan-dim)}\n.slide-thumb{width:40px;height:40px;border-radius:4px;object-fit:cover;\n  flex-shrink:0;border:1px solid var(--border);background:var(--panel-s)}\n.slide-th-ph{width:40px;height:40px;border-radius:4px;background:var(--panel-s);\n  display:flex;align-items:center;justify-content:center;\n  font-size:16px;flex-shrink:0;border:1px solid var(--border)}\n.slide-meta{flex:1;min-width:0}\n.slide-name{font-size:11px;font-weight:600;color:var(--text);\n  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.slide-det{font-size:9.5px;color:var(--text-muted);font-family:var(--mono);margin-top:1px}\n.slide-badge{font-size:9px;padding:1px 5px;border-radius:10px;\n  background:var(--cyan-dim);color:var(--cyan);font-weight:700}\n.source-badge{font-size:8.5px;padding:1px 4px;border-radius:3px;\n  background:var(--panel-hi);color:var(--text-muted)}\n\n/* ── Upload / Add ── */\n.add-panel{padding:6px;display:flex;flex-direction:column;gap:4px;flex-shrink:0;\n  border-top:1px solid var(--border)}\n.add-tab-row{display:flex;gap:3px;margin-bottom:3px}\n.add-tab{flex:1;padding:4px;font-size:10.5px;font-weight:600;\n  border-radius:4px;background:transparent;color:var(--text-muted);\n  border:1px solid var(--border);transition:all .15s}\n.add-tab.active{background:var(--cyan-dim);color:var(--cyan);border-color:var(--cyan-dim)}\n.add-pane{display:none}\n.add-pane.show{display:block}\n.upload-area{border:1.5px dashed var(--border-hi);border-radius:var(--radius);\n  padding:10px 6px;text-align:center;cursor:pointer;transition:all .2s}\n.upload-area:hover,.upload-area.dv{border-color:var(--cyan);background:var(--cyan-glow)}\n.upload-area input{display:none}\n.up-icon{font-size:18px;margin-bottom:3px}\n.up-txt{font-size:9.5px;color:var(--text-muted);line-height:1.4}\n.up-txt strong{color:var(--cyan)}\n.path-row{display:flex;gap:3px}\n.path-in{flex:1;padding:4px 7px;background:var(--panel-s);border:1px solid var(--border);\n  border-radius:var(--radius);font-size:11px;color:var(--text)}\n.path-in:focus{border-color:var(--cyan-dim)}\n.path-btn{padding:4px 7px;background:var(--cyan-dim);color:var(--cyan);\n  border-radius:var(--radius);font-size:11px;font-weight:600;white-space:nowrap}\n.path-btn:hover{background:var(--cyan);color:#000}\n#up-prog{display:none;margin:3px 0;padding:6px 8px;\n  background:var(--panel-s);border-radius:var(--radius);border:1px solid var(--border)}\n.prog-bar{height:3px;background:var(--border-hi);border-radius:2px;margin-top:4px}\n.prog-fill{height:100%;background:linear-gradient(90deg,var(--cyan),var(--violet));\n  border-radius:2px;transition:width .3s;width:0}\n\n/* ── Viewer ── */\n#osd-viewer{width:100%;height:100%}\n#ann-canvas{position:absolute;top:0;left:0;pointer-events:none;z-index:10}\n#ann-canvas.drawing,#ann-canvas.freehand,\n#ann-canvas.select,#ann-canvas.eraser{pointer-events:all}\n#ann-canvas.drawing{cursor:crosshair}\n#ann-canvas.freehand{cursor:cell}\n.vbadge{position:absolute;padding:3px 8px;\n  background:var(--badge-bg,rgba(255,255,255,.92));backdrop-filter:blur(4px);\n  border:1px solid var(--border);border-radius:4px;\n  font-size:10px;font-family:var(--mono);color:var(--text-dim)}\n#zoom-badge{top:8px;right:8px}\n#coord-badge{bottom:8px;left:8px}\n.no-slide{position:absolute;inset:0;display:flex;flex-direction:column;\n  align-items:center;justify-content:center;gap:8px;\n  color:var(--text-muted);pointer-events:none}\n.no-sl-icon{font-size:48px;opacity:.15}\n.no-sl-h{font-size:14px;font-weight:600;opacity:.4}\n.no-sl-p{font-size:10.5px;opacity:.3;text-align:center;max-width:200px}\n\n/* ── Tool grid ── */\n.tool-grid{display:flex;flex-wrap:wrap;gap:3px}\n.rt-btn{display:flex;align-items:center;gap:4px;padding:4px 7px;\n  border-radius:var(--radius);background:var(--panel-s);color:var(--text-dim);\n  font-size:10.5px;font-weight:600;border:1px solid var(--border);\n  transition:all .15s;flex:1 1 calc(50% - 2px);min-width:0}\n.rt-btn:hover{border-color:var(--border-hi);color:var(--text)}\n.rt-btn.active{background:var(--cyan-dim);border-color:var(--cyan-dim);color:var(--cyan)}\n.rt-btn .ico{font-size:12px;flex-shrink:0}\n.rt-btn .key{margin-left:auto;font-size:9px;background:var(--border-hi);\n  padding:1px 3px;border-radius:2px;font-family:var(--mono)}\n\n/* ── Classes ── */\n.cls-list{display:flex;flex-direction:column;gap:2px}\n.cls-row{display:flex;align-items:center;gap:5px;padding:4px 6px;\n  border-radius:var(--radius);cursor:pointer;border:1px solid transparent;transition:all .15s}\n.cls-row:hover{background:var(--panel-s)}\n.cls-row.active{background:var(--panel-s);border-color:var(--border-hi)}\n.cls-cd{width:8px;height:8px;border-radius:50%;flex-shrink:0}\n.cls-nm{flex:1;font-size:11px;font-weight:500}\n.cls-ct{font-size:9.5px;color:var(--text-muted);font-family:var(--mono);\n  background:var(--panel-hi);padding:1px 4px;border-radius:8px}\n.cls-k{font-size:9px;color:var(--text-muted);font-family:var(--mono);width:12px}\n.cls-add{width:100%;padding:4px;background:transparent;\n  border:1.5px dashed var(--border-hi);border-radius:var(--radius);\n  color:var(--text-muted);font-size:10.5px;font-weight:600;transition:all .15s;margin-top:2px}\n.cls-add:hover{border-color:var(--cyan-dim);color:var(--cyan)}\n\n/* ── Annotation list ── */\n#ann-list{max-height:190px;overflow-y:auto;display:flex;flex-direction:column;gap:1px}\n.ann-item{display:flex;align-items:center;gap:5px;padding:4px 6px;\n  border-radius:var(--radius);border:1px solid transparent;\n  cursor:pointer;transition:all .12s;font-size:10.5px}\n.ann-item:hover{background:var(--panel-s);border-color:var(--border)}\n.ann-item.selected{background:var(--panel-hi);border-color:var(--cyan-dim)}\n.ann-sw{width:7px;height:7px;border-radius:50%;flex-shrink:0}\n.ann-lbl{flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.ann-tp{color:var(--text-muted);font-size:8.5px;font-family:var(--mono)}\n.ann-del{opacity:0;width:15px;height:15px;border-radius:3px;\n  background:transparent;color:var(--danger);font-size:10px;\n  display:flex;align-items:center;justify-content:center;transition:all .12s}\n.ann-item:hover .ann-del{opacity:1}\n.ann-del:hover{background:rgba(244,63,94,.15)}\n\n/* ── Properties ── */\n.prop-row{margin-bottom:6px}\n.prop-lbl{font-size:9px;color:var(--text-muted);text-transform:uppercase;\n  letter-spacing:.9px;margin-bottom:2px}\n.prop-val{font-size:11px;font-family:var(--mono);color:var(--text)}\n.prop-val.area{color:var(--cyan)}\n.notes-in{width:100%;padding:4px 7px;background:var(--panel-s);\n  border:1px solid var(--border);border-radius:var(--radius);\n  color:var(--text);font-size:10.5px;resize:vertical;min-height:44px}\n\n/* ── Stats ── */\n.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px}\n.stat-card{background:var(--panel-s);border:1px solid var(--border);\n  border-radius:var(--radius);padding:6px 8px}\n.stat-val{font-size:16px;font-weight:700;color:var(--cyan);font-family:var(--mono)}\n.stat-lbl{font-size:8.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.9px}\n\n/* ── Forms ── */\n.form-row{display:flex;flex-direction:column;gap:2px;margin-bottom:5px}\n.form-lbl{font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.8px}\n.form-in{padding:4px 7px;font-size:11.5px;border-radius:var(--radius);\n  border:1px solid var(--border);background:var(--panel-s);color:var(--text);width:100%}\n.form-in:focus{border-color:var(--cyan-dim)}\n.hint{font-size:9.5px;color:var(--text-muted);line-height:1.4;margin-top:2px}\n\n/* ── Class filter ── */\n.cls-filter-wrap{max-height:120px;overflow-y:auto;\n  background:var(--panel-s);border:1px solid var(--border);\n  border-radius:var(--radius);padding:3px;margin-bottom:4px}\n.cls-frow{display:flex;align-items:center;gap:5px;padding:3px 4px;\n  border-radius:3px;cursor:pointer}\n.cls-frow:hover{background:var(--panel-hi)}\n.cls-frow input[type=checkbox]{accent-color:var(--cyan);width:12px;height:12px}\n.cls-fdot{width:7px;height:7px;border-radius:50%;flex-shrink:0}\n.cls-fnm{font-size:10.5px;flex:1}\n.cls-fct{font-size:9.5px;color:var(--text-muted);font-family:var(--mono)}\n.filter-all{font-size:9.5px;color:var(--cyan);background:none;\n  border:none;cursor:pointer;padding:0}\n.filter-all:hover{text-decoration:underline}\n\n/* ── Validation result ── */\n.val-box{padding:7px 9px;border-radius:var(--radius);margin-top:4px;font-size:10.5px;\n  border:1px solid var(--border)}\n.val-ok{background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.2)}\n.val-warn{background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.22)}\n.val-err{background:rgba(244,63,94,.08);border-color:rgba(244,63,94,.22)}\n.val-row{display:flex;justify-content:space-between;margin-bottom:2px}\n.val-ann-warn{font-size:9.5px;color:var(--warning);margin-top:3px;line-height:1.4}\n\n/* ── Buttons ── */\n.extract-btn{padding:6px 10px;background:var(--success);color:#fff;\n  border-radius:var(--radius);font-size:11.5px;font-weight:700;\n  transition:all .15s;width:100%;margin-top:4px}\n.extract-btn:hover{filter:brightness(1.1)}\n.extract-btn:disabled{opacity:.4;cursor:not-allowed}\n.exp-btn{padding:5px 8px;border-radius:var(--radius);font-size:10.5px;\n  font-weight:600;border:1px solid var(--border-hi);background:var(--panel-s);\n  color:var(--text-dim);display:flex;align-items:center;gap:5px;transition:all .15s}\n.exp-btn:hover{border-color:var(--cyan-dim);color:var(--cyan);background:var(--panel-hi)}\n.import-btn{padding:5px 8px;border-radius:var(--radius);font-size:10.5px;\n  font-weight:600;border:1px solid rgba(167,139,250,.25);background:var(--panel-s);\n  color:var(--violet);display:flex;align-items:center;gap:5px;transition:all .15s;\n  width:100%;justify-content:center}\n.import-btn:hover{background:rgba(167,139,250,.1)}\n.del-btn{padding:5px 8px;border-radius:var(--radius);font-size:10.5px;\n  font-weight:600;border:1px solid rgba(244,63,94,.22);background:var(--panel-s);\n  color:var(--danger);width:100%;justify-content:center;\n  display:flex;align-items:center;gap:5px;transition:all .15s}\n.del-btn:hover{background:rgba(244,63,94,.1)}\n\n/* ── Blur ── */\n.blur-res{padding:6px 8px;border-radius:var(--radius);margin-top:4px;\n  font-size:11.5px;font-weight:600;text-align:center}\n.blur-res.sharp{background:rgba(34,197,94,.1);color:var(--success);border:1px solid rgba(34,197,94,.2)}\n.blur-res.blurry{background:rgba(244,63,94,.1);color:var(--danger);border:1px solid rgba(244,63,94,.2)}\n\n/* ── Modals ── */\n.mo{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;display:none;align-items:center;justify-content:center}\n.mo.show{display:flex}\n.modal{background:var(--panel-s);border:1px solid var(--border-hi);\n  border-radius:10px;padding:22px;min-width:300px;max-width:480px;\n  box-shadow:0 20px 60px rgba(0,0,0,.75);width:90vw}\n.modal-title{font-size:14px;font-weight:700;margin-bottom:14px;color:var(--text)}\n.modal-sub{font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.5}\n.mo-in{width:100%;padding:7px 10px;background:var(--panel-hi);\n  border:1px solid var(--border-hi);border-radius:var(--radius);\n  color:var(--text);font-size:12px;margin-bottom:8px}\n.mo-in:focus{border-color:var(--cyan-dim)}\n.mo-btns{display:flex;gap:6px;justify-content:flex-end;margin-top:10px}\n.mo-btn{padding:6px 14px;border-radius:var(--radius);font-size:11.5px;font-weight:700;transition:all .15s}\n.mo-btn.cancel{background:transparent;border:1px solid var(--border-hi);color:var(--text-dim)}\n.mo-btn.cancel:hover{background:var(--panel-hi);color:var(--text)}\n.mo-btn.confirm{background:var(--cyan);color:#000}\n.mo-btn.confirm:hover{filter:brightness(1.1)}\n\n/* ── Toasts ── */\n#toasts{position:fixed;bottom:32px;right:10px;z-index:2000;\n  display:flex;flex-direction:column-reverse;gap:4px;pointer-events:none}\n.toast{background:var(--panel-hi);border:1px solid var(--border-hi);\n  border-left:3px solid var(--cyan);border-radius:var(--radius);\n  padding:8px 12px;font-size:11.5px;color:var(--text);\n  box-shadow:0 6px 20px rgba(0,0,0,.5);animation:tIn .2s ease;max-width:280px}\n.toast.success{border-left-color:var(--success)}\n.toast.error{border-left-color:var(--danger)}\n.toast.warning{border-left-color:var(--warning)}\n@keyframes tIn{from{transform:translateX(14px);opacity:0}to{transform:none;opacity:1}}\n@keyframes tOut{from{opacity:1}to{opacity:0;transform:translateX(14px)}}\n.spinner{display:inline-block;width:12px;height:12px;\n  border:2px solid var(--border-hi);border-top-color:var(--cyan);\n  border-radius:50%;animation:spin .7s linear infinite}\n@keyframes spin{to{transform:rotate(360deg)}}\n.empty-st{text-align:center;padding:16px 8px;color:var(--text-muted);font-size:10.5px}\n.empty-st .ei{font-size:22px;opacity:.3;display:block;margin-bottom:4px}\n.divider{height:1px;background:var(--border);margin:5px 0}\n\n/* ── AI Panel ── */\n.ai-run-btn{width:100%;padding:7px 10px;background:linear-gradient(135deg,#003a4a,#2d1b69);\n  color:var(--cyan);border:1px solid var(--cyan-dim);border-radius:var(--radius);\n  font-size:11.5px;font-weight:700;transition:all .2s;display:flex;\n  align-items:center;justify-content:center;gap:6px;margin-top:4px}\n.ai-run-btn:hover{background:linear-gradient(135deg,#004d66,#3d2490);\n  border-color:var(--cyan);box-shadow:0 0 12px rgba(0,212,255,.2)}\n.ai-run-btn:disabled{opacity:.4;cursor:not-allowed}\n.ai-status-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;display:inline-block}\n.ai-status-dot.ok{background:var(--success)}\n.ai-status-dot.warn{background:var(--warning)}\n.ai-cap-badge{font-size:8.5px;padding:1px 5px;border-radius:8px;\n  background:rgba(0,212,255,.1);border:1px solid var(--cyan-dim);\n  color:var(--cyan);font-family:var(--mono)}\n.ai-chip-grid{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}\n.ai-chip{padding:3px 8px;border-radius:10px;font-size:10px;font-weight:600;\n  border:1px solid var(--border-hi);background:var(--panel-s);color:var(--text-dim);\n  cursor:pointer;transition:all .15s;user-select:none;display:flex;align-items:center;gap:4px}\n.ai-chip input[type=checkbox]{accent-color:var(--cyan);width:11px;height:11px}\n.ai-chip:has(input:checked){border-color:var(--cyan-dim);color:var(--cyan);\n  background:var(--cyan-glow)}\n/* fallback for browsers without :has() */\n.ai-chip.chip-on{border-color:var(--cyan-dim);color:var(--cyan);background:var(--cyan-glow)}\n\n/* ── AI Modal specific ── */\n.ai-modal-desc{font-size:10px;color:var(--text-muted);line-height:1.55;\n  margin-bottom:12px;padding:8px 10px;background:var(--panel-hi);\n  border:1px solid var(--border);border-radius:var(--radius)}\n.ai-section-hdr{font-size:9px;color:var(--text-muted);text-transform:uppercase;\n  letter-spacing:1px;font-weight:700;margin:10px 0 5px}\n.ai-task-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:10px}\n.ai-task-card{padding:8px 6px;border-radius:var(--radius);border:1.5px solid var(--border);\n  background:var(--panel-s);cursor:pointer;transition:all .15s;text-align:center;\n  font-size:10.5px;font-weight:600;color:var(--text-dim)}\n.ai-task-card:hover{border-color:var(--border-hi);color:var(--text)}\n.ai-task-card.selected{border-color:var(--cyan-dim);background:var(--cyan-glow);\n  color:var(--cyan)}\n.ai-task-icon{font-size:18px;display:block;margin-bottom:3px}\n.ai-prog-wrap{margin:10px 0;padding:10px;background:var(--panel-hi);\n  border-radius:var(--radius);border:1px solid var(--border)}\n.ai-prog-label{font-size:10.5px;color:var(--text-dim);margin-bottom:6px;\n  display:flex;align-items:center;gap:6px}\n.ai-result-box{padding:9px 11px;border-radius:var(--radius);font-size:10.5px;\n  margin:6px 0;line-height:1.5}\n.ai-result-box.ok{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.25);\n  color:var(--success)}\n.ai-result-box.err{background:rgba(244,63,94,.08);border:1px solid rgba(244,63,94,.25);\n  color:var(--danger)}\n.ai-class-pill{display:inline-flex;align-items:center;gap:3px;padding:2px 6px;\n  border-radius:8px;background:var(--panel-hi);font-size:9.5px;margin:1px}\n</style>\n</head>\n<body>\n<div id=\"app\">\n\n<!-- ── Topbar ── -->\n<div id=\"topbar\">\n  <a class=\"logo\" href=\"#\" onclick=\"return false\" title=\"Monjoy.HistoAI\">\n    <svg class=\"logo-mark\" viewBox=\"0 0 28 28\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n      <defs>\n        <linearGradient id=\"mg\" x1=\"0\" y1=\"0\" x2=\"28\" y2=\"28\" gradientUnits=\"userSpaceOnUse\">\n          <stop offset=\"0%\" stop-color=\"#00d4ff\"/>\n          <stop offset=\"60%\" stop-color=\"#a78bfa\"/>\n          <stop offset=\"100%\" stop-color=\"#22c55e\"/>\n        </linearGradient>\n      </defs>\n      <rect width=\"28\" height=\"28\" rx=\"6\" fill=\"#00131a\"/>\n      <path d=\"M14 3 L24 8.5 L24 19.5 L14 25 L4 19.5 L4 8.5 Z\"\n            fill=\"none\" stroke=\"url(#mg)\" stroke-width=\"1.2\" opacity=\".7\"/>\n      <path d=\"M8 20 L8 10 L14 17 L20 10 L20 20\"\n            stroke=\"url(#mg)\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"/>\n      <circle cx=\"14\" cy=\"14\" r=\"1.5\" fill=\"url(#mg)\"/>\n    </svg>\n    <span class=\"logo-text\">Monjoy.<em>HistoAI</em></span>\n  </a>\n  <div class=\"tb-div\"></div>\n\n  <!-- Drawing tools -->\n  <button class=\"tool-btn active\" id=\"tb-pan\"       data-tip=\"Pan (V)\"       onclick=\"setTool('pan')\">⊹</button>\n  <div class=\"tb-div\"></div>\n  <button class=\"tool-btn\" id=\"tb-polygon\"   data-tip=\"Polygon (P)\"   onclick=\"setTool('polygon')\">⬡</button>\n  <button class=\"tool-btn\" id=\"tb-rectangle\" data-tip=\"Rectangle (R)\" onclick=\"setTool('rectangle')\">▭</button>\n  <button class=\"tool-btn\" id=\"tb-ellipse\"   data-tip=\"Ellipse (E)\"   onclick=\"setTool('ellipse')\">⬭</button>\n  <button class=\"tool-btn\" id=\"tb-freehand\"  data-tip=\"Freehand (F)\"  onclick=\"setTool('freehand')\">✏</button>\n  <button class=\"tool-btn\" id=\"tb-point\"     data-tip=\"Point (T)\"     onclick=\"setTool('point')\">⊕</button>\n  <div class=\"tb-div\"></div>\n  <button class=\"tool-btn\" id=\"tb-select\"    data-tip=\"Select (S)\"    onclick=\"setTool('select')\">↖</button>\n  <button class=\"tool-btn\" id=\"tb-eraser\"    data-tip=\"Erase (X)\"     onclick=\"setTool('eraser')\">⌫</button>\n  <div class=\"tb-div\"></div>\n  <button class=\"tool-btn\" data-tip=\"Undo (Ctrl+Z)\" onclick=\"undo()\">↩</button>\n  <button class=\"tool-btn\" data-tip=\"Redo (Ctrl+Y)\" onclick=\"redo()\">↪</button>\n  <div class=\"tb-div\"></div>\n  <span class=\"cls-dot-tb\" id=\"tb-cls-dot\" style=\"background:#ef4444\"></span>\n  <select class=\"cls-sel\" id=\"tb-cls-sel\" onchange=\"onClsChange(this.value)\"></select>\n\n  <div class=\"tb-spacer\"></div>\n  <button class=\"tb-btn ghost\" onclick=\"doSave()\">💾 Save</button>\n  <button class=\"tb-btn ghost\" onclick=\"showImportModal()\" style=\"margin-left:3px\">📂 Import Ann.</button>\n  <button class=\"tb-btn primary\" onclick=\"showExportModal()\" style=\"margin-left:3px\">↑ Export</button>\n</div>\n\n<!-- ── Workspace ── -->\n<div id=\"workspace\">\n\n<!-- ── Left sidebar ── -->\n<div id=\"sidebar-left\">\n  <div class=\"ph\">Slides\n    <button class=\"ph-btn\" title=\"Refresh\" onclick=\"loadSlides()\">↻</button>\n  </div>\n  <div id=\"slide-list\">\n    <div class=\"empty-st\" id=\"slide-empty\">\n      <span class=\"ei\">🔬</span>No slides loaded.\n    </div>\n  </div>\n\n  <!-- Add slide panel -->\n  <div class=\"add-panel\">\n    <div class=\"add-tab-row\">\n      <button class=\"add-tab active\" id=\"tab-upload\" onclick=\"switchAddTab('upload')\">📁 Local</button>\n      <button class=\"add-tab\" id=\"tab-cloud\" onclick=\"switchAddTab('cloud')\">☁ Cloud</button>\n      <button class=\"add-tab\" id=\"tab-tcga\" onclick=\"switchAddTab('tcga')\">🧬 TCGA</button>\n    </div>\n\n    <!-- Local tab — browser file picker works on local AND cloud -->\n    <div class=\"add-pane show\" id=\"pane-upload\">\n\n      <!-- Hidden browser file inputs -->\n      <input type=\"file\" id=\"file-input-single\"\n             accept=\".svs,.ndpi,.tiff,.tif,.mrxs,.czi,.scn,.vms,.vmu\"\n             style=\"display:none\" onchange=\"handleFileInput(this)\"/>\n      <input type=\"file\" id=\"file-input-folder\"\n             webkitdirectory mozdirectory multiple\n             accept=\".svs,.ndpi,.tiff,.tif,.mrxs,.czi,.scn,.vms,.vmu\"\n             style=\"display:none\" onchange=\"handleFolderInput(this)\"/>\n\n      <!-- Browse single file -->\n      <div class=\"upload-area\" id=\"up-area\" style=\"margin-bottom:4px\"\n           onclick=\"document.getElementById('file-input-single').click()\">\n        <div class=\"up-icon\">🔬</div>\n        <div class=\"up-txt\">\n          <strong>Browse &amp; Open WSI File</strong><br/>\n          .svs · .ndpi · .tiff · .mrxs · .czi…<br/>\n          <span style=\"font-size:8.5px;opacity:.65\">Click to open a file picker</span>\n        </div>\n      </div>\n\n      <!-- Browse folder -->\n      <div class=\"upload-area\" id=\"up-folder-area\" style=\"padding:8px;display:flex;align-items:center;gap:8px\"\n           onclick=\"document.getElementById('file-input-folder').click()\">\n        <span style=\"font-size:20px\">📂</span>\n        <div class=\"up-txt\" style=\"text-align:left;flex:1\">\n          <strong>Browse WSI Folder</strong>\n          <div style=\"font-size:8.5px;opacity:.65\">Select folder — all WSIs inside load instantly</div>\n          <div id=\"up-folder-path\" style=\"display:none;font-size:8px;color:var(--cyan);\n               margin-top:2px;word-break:break-all;font-family:var(--mono)\"></div>\n        </div>\n      </div>\n\n      <!-- Upload progress (for cloud upload) -->\n      <div id=\"up-prog\" style=\"display:none;margin-top:4px;padding:6px 8px;\n           background:var(--panel-s);border-radius:var(--radius);border:1px solid var(--border)\">\n        <div style=\"display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-dim)\">\n          <div class=\"spinner\"></div>\n          <span id=\"up-msg\">Processing…</span>\n          <span id=\"up-pct\" style=\"margin-left:auto;font-family:var(--mono);font-size:9px\"></span>\n        </div>\n        <div class=\"prog-bar\"><div class=\"prog-fill\" id=\"up-fill\"></div></div>\n      </div>\n\n      <!-- Info box -->\n      <div id=\"local-path-info\" style=\"display:none;margin-top:3px;padding:4px 6px;\n           background:var(--panel-s);border-radius:var(--radius);font-size:8px;\n           color:var(--text-muted);font-family:var(--mono);word-break:break-all;line-height:1.5\">\n      </div>\n    </div>\n\n    <!-- Cloud tab -->\n    <div class=\"add-pane\" id=\"pane-cloud\">\n      <div style=\"font-size:8.5px;color:var(--text-muted);line-height:1.5;margin-bottom:4px\">\n        <strong style=\"color:var(--cyan)\">▶ Stream</strong> any direct SVS URL (no download):\n      </div>\n      <div class=\"path-row\" style=\"margin-bottom:5px\">\n        <input type=\"text\" class=\"path-in\" id=\"remote-url-in\"\n               placeholder=\"https://server.com/slide.svs\"\n               onkeydown=\"if(event.key==='Enter') addRemoteUrl(this.value)\"/>\n        <button class=\"path-btn\" onclick=\"addRemoteUrl(document.getElementById('remote-url-in').value)\"\n                title=\"Stream without downloading\">▶</button>\n      </div>\n      <div style=\"font-size:8.5px;color:var(--text-muted);margin-bottom:3px\">Or download from cloud storage:</div>\n      <div class=\"path-row\">\n        <input type=\"text\" class=\"path-in\" id=\"cloud-url-in\"\n               placeholder=\"https://drive.google.com/file/d/…\"\n               onkeydown=\"if(event.key==='Enter') addCloudUrl()\"/>\n        <button class=\"path-btn\" onclick=\"addCloudUrl()\">↓</button>\n      </div>\n      <div id=\"cloud-prog\" style=\"display:none;margin-top:4px;padding:6px 8px;\n           background:var(--panel-s);border-radius:var(--radius);border:1px solid var(--border)\">\n        <div style=\"display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-dim)\">\n          <div class=\"spinner\"></div>\n          <span id=\"cloud-prog-msg\">Connecting…</span>\n          <span id=\"cloud-pct\" style=\"margin-left:auto;font-family:var(--mono);font-size:9px\"></span>\n        </div>\n        <div class=\"prog-bar\"><div class=\"prog-fill\" id=\"cloud-fill\"></div></div>\n      </div>\n      <div id=\"cloud-error\" style=\"display:none;margin-top:4px;padding:5px 7px;font-size:9px;\n           color:var(--danger);background:rgba(244,63,94,.08);border:1px solid rgba(244,63,94,.2);\n           border-radius:var(--radius);line-height:1.4;word-break:break-all\"></div>\n    </div>\n\n    <!-- TCGA / NCI GDC tab -->\n    <div class=\"add-pane\" id=\"pane-tcga\">\n\n      <!-- GDC API status pill -->\n      <div id=\"gdc-api-status\" style=\"display:none;margin-bottom:5px;padding:4px 7px;\n           border-radius:var(--radius);font-size:8.5px;font-weight:600;\n           background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);color:var(--success)\">\n        ✓ GDC API connected\n      </div>\n\n      <!-- Token section -->\n      <div style=\"margin-bottom:6px\">\n        <div style=\"font-size:8.5px;color:var(--text-muted);line-height:1.5;margin-bottom:3px\">\n          <strong style=\"color:var(--cyan)\">NCI GDC / TCGA Repository</strong><br/>\n          Open-access slides: no token needed.<br/>\n          Controlled-access:\n          <a href=\"https://portal.gdc.cancer.gov\" target=\"_blank\"\n             style=\"color:var(--cyan)\">get token at portal.gdc.cancer.gov ↗</a>\n        </div>\n        <div class=\"path-row\" style=\"margin-bottom:2px\">\n          <input type=\"password\" class=\"path-in\" id=\"gdc-token-in\"\n                 placeholder=\"Paste GDC auth token (optional)\"\n                 style=\"font-size:10px\"/>\n          <button class=\"path-btn\" onclick=\"saveGdcToken()\">Set</button>\n        </div>\n        <div id=\"gdc-token-status\" style=\"font-size:8px;color:var(--text-muted);min-height:12px\"></div>\n      </div>\n\n      <!-- Project selector -->\n      <div style=\"margin-bottom:4px\">\n        <select class=\"path-in\" id=\"tcga-project\" onchange=\"tcgaLoadFiles()\"\n                style=\"width:100%;font-size:10px;cursor:pointer\">\n          <option value=\"\">— Select TCGA Project —</option>\n        </select>\n      </div>\n\n      <!-- Search box -->\n      <div class=\"path-row\" style=\"margin-bottom:4px\">\n        <input type=\"text\" class=\"path-in\" id=\"tcga-search\"\n               placeholder=\"Filter by case ID or file name…\"\n               oninput=\"tcgaSearchDebounce()\"\n               style=\"font-size:10px\"/>\n        <button class=\"path-btn\" onclick=\"tcgaLoadFiles()\" title=\"Refresh\" style=\"padding:4px 7px\">↻</button>\n      </div>\n\n      <!-- File list -->\n      <div id=\"tcga-file-list\" style=\"max-height:210px;overflow-y:auto;\n           border:1px solid var(--border);border-radius:var(--radius);background:var(--panel-s)\">\n        <div class=\"empty-st\" id=\"tcga-empty-msg\" style=\"padding:12px 8px\">\n          <span class=\"ei\">🧬</span>Select a TCGA project above\n        </div>\n      </div>\n\n      <!-- Pagination row -->\n      <div style=\"display:flex;align-items:center;gap:4px;margin-top:4px\">\n        <button class=\"path-btn\" id=\"tcga-prev\" onclick=\"tcgaPageNav(-1)\"\n                style=\"padding:2px 7px;font-size:9px\" disabled>◀</button>\n        <span id=\"tcga-page-info\" style=\"flex:1;text-align:center;font-size:8.5px;\n              color:var(--text-muted);font-family:var(--mono)\">—</span>\n        <button class=\"path-btn\" id=\"tcga-next\" onclick=\"tcgaPageNav(1)\"\n                style=\"padding:2px 7px;font-size:9px\" disabled>▶</button>\n      </div>\n\n      <!-- Download queue -->\n      <div id=\"tcga-dl-queue\" style=\"margin-top:4px\"></div>\n    </div>\n\n  </div></div>\n\n<!-- ── Viewer ── -->\n<div id=\"viewer-wrap\">\n  <div id=\"osd-viewer\"></div>\n  <canvas id=\"ann-canvas\"></canvas>\n  <div style=\"position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:20\">\n    <div class=\"vbadge\" id=\"zoom-badge\">Zoom: —</div>\n    <div class=\"vbadge\" id=\"coord-badge\">x: — y: —</div>\n  </div>\n  <div class=\"no-slide\" id=\"no-slide\">\n    <div class=\"no-sl-icon\">🔬</div>\n    <div class=\"no-sl-h\" style=\"font-size:15px;font-weight:700;opacity:1\">Monjoy.HistoAI</div>\n    <div class=\"no-sl-p\" style=\"opacity:.65;text-align:center;line-height:1.7;max-width:280px\">\n      Stream TCGA slides instantly — no download needed.\n    </div>\n    <div style=\"display:flex;flex-direction:column;gap:5px;margin-top:10px;pointer-events:all;width:240px\">\n      <button onclick=\"switchAddTab('tcga')\" style=\"padding:7px 14px;border-radius:6px;\n        background:linear-gradient(135deg,rgba(0,212,255,.15),rgba(167,139,250,.12));\n        color:var(--cyan);border:1px solid rgba(0,212,255,.25);font-size:11px;font-weight:700;cursor:pointer;text-align:left\">\n        🧬 Browse TCGA Slides &nbsp;<span style=\"font-size:9px;opacity:.8\">▶ stream instantly</span>\n      </button>\n      <button onclick=\"loadDemoSlide()\" style=\"padding:6px 14px;border-radius:6px;\n        background:var(--panel-s);color:var(--text-dim);border:1px solid var(--border);\n        font-size:10.5px;font-weight:600;cursor:pointer;text-align:left\">\n        ▶ Load Demo Slide &nbsp;<span style=\"font-size:9px;opacity:.6\">CMU-1 H&amp;E, 7 MB</span>\n      </button>\n    </div>\n  </div>\n</div>\n\n<!-- ── Right sidebar ── -->\n<div id=\"sidebar-right\">\n\n  <!-- Tools -->\n  <div class=\"rs\">\n    <div class=\"sec\">Drawing Tools</div>\n    <div class=\"tool-grid\">\n      <button class=\"rt-btn active\" id=\"rt-pan\"       onclick=\"setTool('pan')\">       <span class=\"ico\">⊹</span>Pan       <span class=\"key\">V</span></button>\n      <button class=\"rt-btn\"        id=\"rt-polygon\"   onclick=\"setTool('polygon')\">   <span class=\"ico\">⬡</span>Polygon   <span class=\"key\">P</span></button>\n      <button class=\"rt-btn\"        id=\"rt-rectangle\" onclick=\"setTool('rectangle')\"> <span class=\"ico\">▭</span>Rectangle <span class=\"key\">R</span></button>\n      <button class=\"rt-btn\"        id=\"rt-ellipse\"   onclick=\"setTool('ellipse')\">   <span class=\"ico\">⬭</span>Ellipse   <span class=\"key\">E</span></button>\n      <button class=\"rt-btn\"        id=\"rt-freehand\"  onclick=\"setTool('freehand')\">  <span class=\"ico\">✏</span>Freehand  <span class=\"key\">F</span></button>\n      <button class=\"rt-btn\"        id=\"rt-point\"     onclick=\"setTool('point')\">     <span class=\"ico\">⊕</span>Point     <span class=\"key\">T</span></button>\n      <button class=\"rt-btn\"        id=\"rt-select\"    onclick=\"setTool('select')\">    <span class=\"ico\">↖</span>Select    <span class=\"key\">S</span></button>\n      <button class=\"rt-btn\"        id=\"rt-eraser\"    onclick=\"setTool('eraser')\">    <span class=\"ico\">⌫</span>Erase     <span class=\"key\">X</span></button>\n    </div>\n  </div>\n\n  <!-- Classes -->\n  <div class=\"rs\">\n    <div class=\"sec\">Annotation Classes</div>\n    <div class=\"cls-list\" id=\"class-list\"></div>\n    <button class=\"cls-add\" onclick=\"showAddClassModal()\">+ Add Class</button>\n  </div>\n\n  <!-- Annotations -->\n  <div class=\"rs\">\n    <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:6px\">\n      <div class=\"sec\" style=\"margin:0\">Annotations</div>\n      <span id=\"ann-cnt\" style=\"font-size:9.5px;color:var(--text-muted);font-family:var(--mono)\">0</span>\n    </div>\n    <div id=\"ann-list\">\n      <div class=\"empty-st\" id=\"ann-empty\"><span class=\"ei\">◎</span>No annotations yet.</div>\n    </div>\n  </div>\n\n  <!-- Properties -->\n  <div class=\"rs\" id=\"props-sec\" style=\"display:none\">\n    <div class=\"sec\">Properties</div>\n    <div class=\"prop-row\"><div class=\"prop-lbl\">Type</div><div class=\"prop-val\" id=\"p-type\">—</div></div>\n    <div class=\"prop-row\"><div class=\"prop-lbl\">Class</div><div class=\"prop-val\" id=\"p-class\">—</div></div>\n    <div class=\"prop-row\"><div class=\"prop-lbl\">Area (px²)</div><div class=\"prop-val area\" id=\"p-area\">—</div></div>\n    <div class=\"prop-row\"><div class=\"prop-lbl\">Bounding Box</div><div class=\"prop-val\" id=\"p-bbox\" style=\"font-size:10px\">—</div></div>\n    <div class=\"prop-row\"><div class=\"prop-lbl\">Notes</div>\n      <textarea class=\"notes-in\" id=\"p-notes\" placeholder=\"Add notes…\" oninput=\"updateNotes(this.value)\"></textarea>\n    </div>\n    <button class=\"del-btn\" onclick=\"deleteSelected()\">🗑 Delete Selected</button>\n  </div>\n\n  <!-- Stats -->\n  <div class=\"rs\">\n    <div class=\"sec\">Statistics</div>\n    <div class=\"stat-grid\">\n      <div class=\"stat-card\"><div class=\"stat-val\" id=\"st-total\">0</div><div class=\"stat-lbl\">Annotations</div></div>\n      <div class=\"stat-card\"><div class=\"stat-val\" id=\"st-classes\">0</div><div class=\"stat-lbl\">Classes used</div></div>\n      <div class=\"stat-card\"><div class=\"stat-val\" id=\"st-area\">0</div><div class=\"stat-lbl\">Total area</div></div>\n      <div class=\"stat-card\"><div class=\"stat-val\" id=\"st-slides\">0</div><div class=\"stat-lbl\">Slides</div></div>\n    </div>\n  </div>\n\n\n  <!-- Patch Extraction -->\n  <div class=\"rs\">\n    <div class=\"sec\">Patch Extraction</div>\n\n    <div class=\"form-row\">\n      <div style=\"display:flex;justify-content:space-between;align-items:center\">\n        <div class=\"form-lbl\">Extract from Classes</div>\n        <span>\n          <button class=\"filter-all\" onclick=\"filterAll(true)\">All</button>\n          &nbsp;/&nbsp;\n          <button class=\"filter-all\" onclick=\"filterAll(false)\">None</button>\n        </span>\n      </div>\n      <div class=\"cls-filter-wrap\" id=\"cls-filter-grid\">\n        <div class=\"empty-st\" style=\"padding:6px;font-size:9.5px\">Load a slide first</div>\n      </div>\n    </div>\n\n    <div class=\"form-row\">\n      <div class=\"form-lbl\">Patch Size (px at target level)</div>\n      <input type=\"number\" class=\"form-in\" id=\"ext-size\" value=\"256\"\n             min=\"32\" max=\"4096\" step=\"32\" oninput=\"scheduleValidate()\"/>\n    </div>\n    <div class=\"form-row\">\n      <div class=\"form-lbl\">Resolution Level</div>\n      <select class=\"form-in\" id=\"ext-level\" onchange=\"scheduleValidate()\">\n        <option value=\"0\">Level 0 (Highest res)</option>\n      </select>\n    </div>\n\n    <!-- Validation panel — filled after validate() -->\n    <div id=\"val-panel\"></div>\n\n    <div class=\"form-row\">\n      <div class=\"form-lbl\">Min. Overlap Threshold (0–1)</div>\n      <input type=\"number\" class=\"form-in\" id=\"ext-overlap\" value=\"0.3\"\n             min=\"0.01\" max=\"1\" step=\"0.05\"/>\n      <div class=\"hint\">Fraction of the patch that must lie inside the ROI (e.g. 0.3 = 30%). Edge patches below this are skipped.</div>\n    </div>\n    <div class=\"form-row\">\n      <div class=\"form-lbl\">Output Folder Name</div>\n      <input type=\"text\" class=\"form-in\" id=\"ext-out\" value=\"patches\"/>\n    </div>\n    <button class=\"extract-btn\" id=\"ext-btn\" onclick=\"startExtraction()\" disabled>⬇ Extract Patches</button>\n    <div id=\"ext-result\" style=\"display:none;margin-top:5px;font-size:10.5px;line-height:1.5\"></div>\n  </div>\n\n  <!-- Blurriness -->\n  <div class=\"rs\">\n    <div class=\"sec\">Blurriness Detection</div>\n    <div class=\"form-row\">\n      <div class=\"form-lbl\">Variance Threshold</div>\n      <input type=\"number\" class=\"form-in\" id=\"blur-thr\" value=\"100\" min=\"1\" max=\"2000\"/>\n    </div>\n    <button class=\"exp-btn\" style=\"width:100%;justify-content:center\" onclick=\"checkBlur()\">🔍 Analyze Slide</button>\n    <div id=\"blur-res\"></div>\n  </div>\n\n  <!-- Export / Import -->\n  <div class=\"rs\">\n    <div class=\"sec\">Annotations Export / Import</div>\n    <div style=\"display:flex;flex-direction:column;gap:3px\">\n      <button class=\"exp-btn\" onclick=\"exportAnn('json')\">📄 JSON (re-importable)</button>\n      <button class=\"exp-btn\" onclick=\"exportAnn('geojson')\">🌐 GeoJSON (QuPath / ASAP)</button>\n      <button class=\"exp-btn\" onclick=\"exportAnn('csv')\">📊 CSV Spreadsheet</button>\n      <div class=\"divider\"></div>\n      <button class=\"import-btn\" onclick=\"showImportModal()\">📂 Import Annotation JSON</button>\n    </div>\n  </div>\n\n</div><!-- /sidebar-right -->\n</div><!-- /workspace -->\n\n<div id=\"statusbar\">\n  <span id=\"sb-slide\">No slide loaded</span>\n  <span id=\"sb-dims\"></span>\n  <span id=\"sb-tool\">Pan</span>\n  <div style=\"flex:1\"></div>\n  <span id=\"sb-status\">Ready</span>\n</div>\n</div><!-- /app -->\n\n<!-- ── Modals ── -->\n<div class=\"mo\" id=\"add-cls-modal\">\n  <div class=\"modal\">\n    <div class=\"modal-title\">Add Annotation Class</div>\n    <input type=\"text\" class=\"mo-in\" id=\"new-cls-name\" placeholder=\"Class name\"/>\n    <div style=\"display:flex;gap:8px;align-items:center;margin-bottom:8px\">\n      <div style=\"font-size:10px;color:var(--text-muted);flex:1\">Color</div>\n      <input type=\"color\" id=\"new-cls-color\" value=\"#ef4444\"\n        style=\"width:36px;height:28px;border-radius:4px;cursor:pointer\"/>\n    </div>\n    <input type=\"text\" class=\"mo-in\" id=\"new-cls-key\" placeholder=\"Keyboard shortcut (optional)\" maxlength=\"1\"/>\n    <div class=\"mo-btns\">\n      <button class=\"mo-btn cancel\" onclick=\"closeMo()\">Cancel</button>\n      <button class=\"mo-btn confirm\" onclick=\"addCls()\">Add</button>\n    </div>\n  </div>\n</div>\n\n<div class=\"mo\" id=\"export-modal\">\n  <div class=\"modal\">\n    <div class=\"modal-title\">Export Annotations</div>\n    <div class=\"modal-sub\">\n      <strong>JSON</strong> is the recommended format — it contains all annotation data\n      (classes, colours, notes) and can be re-imported to restore annotations on any\n      corresponding slide.\n    </div>\n    <div style=\"display:flex;flex-direction:column;gap:3px\">\n      <button class=\"exp-btn\" style=\"width:100%\" onclick=\"exportAnn('json');closeMo()\">📄 JSON — full data, re-importable</button>\n      <button class=\"exp-btn\" style=\"width:100%\" onclick=\"exportAnn('geojson');closeMo()\">🌐 GeoJSON — QuPath / ASAP / PathML</button>\n      <button class=\"exp-btn\" style=\"width:100%\" onclick=\"exportAnn('csv');closeMo()\">📊 CSV — bounding boxes &amp; metadata</button>\n    </div>\n    <div class=\"mo-btns\"><button class=\"mo-btn cancel\" onclick=\"closeMo()\">Close</button></div>\n  </div>\n</div>\n\n<div class=\"mo\" id=\"import-modal\">\n  <div class=\"modal\">\n    <div class=\"modal-title\">📂 Import Annotation JSON</div>\n    <div class=\"modal-sub\">\n      Upload a previously exported annotation JSON file. The annotations will be\n      restored on the currently loaded slide. Choose whether to <em>replace</em>\n      existing annotations or <em>merge</em> (adds new annotations, keeps existing ones).\n    </div>\n    <div style=\"display:flex;gap:6px;margin-bottom:10px\">\n      <label style=\"display:flex;align-items:center;gap:5px;font-size:11.5px;cursor:pointer\">\n        <input type=\"radio\" name=\"import-mode\" value=\"replace\" checked style=\"accent-color:var(--cyan)\"/> Replace all\n      </label>\n      <label style=\"display:flex;align-items:center;gap:5px;font-size:11.5px;cursor:pointer\">\n        <input type=\"radio\" name=\"import-mode\" value=\"merge\" style=\"accent-color:var(--cyan)\"/> Merge\n      </label>\n    </div>\n    <div class=\"upload-area\" id=\"import-drop\" style=\"margin-bottom:8px\"\n         onclick=\"document.getElementById('import-file-in').click()\">\n      <input type=\"file\" id=\"import-file-in\" accept=\".json\" onchange=\"doImport(this.files[0])\"/>\n      <div class=\"up-icon\">📄</div>\n      <div class=\"up-txt\"><strong>Click or drag</strong> annotation JSON here</div>\n    </div>\n    <div id=\"import-result\" style=\"display:none;font-size:10.5px;margin-bottom:6px\"></div>\n    <div class=\"mo-btns\"><button class=\"mo-btn cancel\" onclick=\"closeMo()\">Close</button></div>\n  </div>\n</div>\n\n<div id=\"toasts\"></div>\n\n<!-- ── JavaScript ── -->\n<script>\n'use strict';\n// ── State ────────────────────────────────────────────────────────────────────\nlet viewer=null, currentSlide=null, currentTool='pan';\nlet currentCls=null, annotations=[], classes=[], selectedAnn=null;\nlet undoStack=[], redoStack=[];\nlet isDrawing=false, drawPts=[], rectStart=null;\nconst canvas=document.getElementById('ann-canvas');\nconst ctx=canvas.getContext('2d');\nlet _valTimer=null;\n\n// ── Init ─────────────────────────────────────────────────────────────────────\ndocument.addEventListener('DOMContentLoaded',()=>{\n  initViewer(); loadStats(); setupDD(); setupKeys();\n  classes=defaultClasses(); currentCls=classes[0];\n  renderClasses(); selCls(currentCls);\n  // Auto-open first slide if available\n  loadSlides().then(slides=>{\n    if(slides&&slides.length>0){\n      const first=document.querySelector('.slide-item');\n      if(first) setTimeout(()=>first.click(),200);\n    }\n  });\n  // Show local paths info (local deployment only)\n  fetch('/api/paths').then(r=>r.json()).then(p=>{\n    const el=document.getElementById('local-path-info');\n    if(el&&p.patches_dir&&!p.is_headless){\n      el.style.display='block';\n      el.innerHTML='<strong style=\"color:var(--text-dim)\">Patches saved to:</strong><br/>'+p.patches_dir+\n                    '<br/><strong style=\"color:var(--text-dim)\">Slides cached at:</strong><br/>'+p.cache_dir;\n    }\n  }).catch(()=>{});\n});\n\nfunction initViewer(){\n  viewer=OpenSeadragon({\n    id:'osd-viewer',\n    prefixUrl:'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',\n    showNavigator:true, navigatorPosition:'BOTTOM_RIGHT',\n    navigatorHeight:72, navigatorWidth:100,\n    showRotationControl:true, animationTime:.35, blendTime:.1,\n    constrainDuringPan:true, maxZoomPixelRatio:8, visibilityRatio:.5,\n    zoomPerScroll:1.5, timeout:90000,\n    gestureSettingsMouse:{scrollToZoom:true,clickToZoom:false},\n  });\n  viewer.addHandler('open',()=>{resizeCv();redraw();updateZoom()});\n  viewer.addHandler('animation',()=>{redraw();updateZoom()});\n  viewer.addHandler('resize',()=>{resizeCv();redraw()});\n  viewer.addHandler('update-viewport',()=>{redraw();updateZoom()});\n  canvas.addEventListener('mousemove',onMove);\n  new ResizeObserver(()=>{resizeCv();redraw()})\n    .observe(document.getElementById('viewer-wrap'));\n}\n\n// ── Coord conversion ─────────────────────────────────────────────────────────\nfunction cvToImg(cx,cy){\n  if(!viewer||!viewer.world.getItemCount()) return null;\n  try{\n    const cr=viewer.element.getBoundingClientRect();\n    const vp=viewer.viewport.windowToViewportCoordinates(\n      new OpenSeadragon.Point(cx+cr.left,cy+cr.top));\n    const ip=viewer.viewport.viewportToImageCoordinates(vp);\n    return{x:ip.x,y:ip.y};\n  }catch{return null}\n}\nfunction imgToCv(ix,iy){\n  if(!viewer||!viewer.world.getItemCount()) return null;\n  try{\n    const vp=viewer.viewport.imageToViewportCoordinates(new OpenSeadragon.Point(ix,iy));\n    const win=viewer.viewport.viewportToWindowCoordinates(vp);\n    const cr=viewer.element.getBoundingClientRect();\n    return{x:win.x-cr.left,y:win.y-cr.top};\n  }catch{return null}\n}\nfunction resizeCv(){\n  const w=document.getElementById('viewer-wrap');\n  canvas.width=w.clientWidth; canvas.height=w.clientHeight;\n}\n\n// ── Slides ───────────────────────────────────────────────────────────────────\nasync function loadSlides(){\n  try{\n    const slides=await(await fetch('/api/slides')).json();\n    renderSlides(Array.isArray(slides)?slides:[]);\n    document.getElementById('st-slides').textContent=\n      Array.isArray(slides)?slides.length:0;\n  }catch(e){console.error(e)}\n}\nfunction renderSlides(slides){\n  const el=document.getElementById('slide-list');\n  el.querySelectorAll('.slide-item').forEach(n=>n.remove());\n  const empty=document.getElementById('slide-empty');\n  if(!slides.length){empty.style.display='';return}\n  empty.style.display='none';\n  slides.forEach(s=>{\n    const item=document.createElement('div');\n    item.className='slide-item'+(currentSlide?.id===s.id?' active':'');\n    item.dataset.id=s.id;\n    const dim=s.dimensions?`${(s.dimensions[0]/1000).toFixed(1)}k×${(s.dimensions[1]/1000).toFixed(1)}k`:'';\n    const badge=s.annotation_count>0?`<span class=\"slide-badge\">${s.annotation_count}</span>`:'';\n    const src=s.source?`<span class=\"source-badge\">${s.source}</span>`:'';\n    item.innerHTML=`\n      <img class=\"slide-thumb\"\n           src=\"/api/slides/${encodeURIComponent(s.id)}/thumbnail?size=80\"\n           onerror=\"this.style.display='none';this.nextElementSibling.style.display='flex'\" alt=\"\"/>\n      <div class=\"slide-th-ph\" style=\"display:none\">🔬</div>\n      <div class=\"slide-meta\">\n        <div class=\"slide-name\">${s.name||s.id} ${badge}</div>\n        <div class=\"slide-det\">${dim} · ${s.file_size_mb||'?'} MB ${src}</div>\n        ${s.error?`<div style=\"color:var(--danger);font-size:9px\">${s.error.substring(0,45)}</div>`:''}\n      </div>`;\n    item.addEventListener('click',()=>openSlide(s.id));\n    el.insertBefore(item,empty);\n  });\n}\n\nasync function openSlide(slideId){\n  setStatus('Loading…');\n  document.getElementById('no-slide').style.display='none';\n  try{\n    const info=await(await fetch(`/api/slides/${encodeURIComponent(slideId)}/info`)).json();\n    if(info.error) throw new Error(info.error);\n    currentSlide=info;\n    document.querySelectorAll('.slide-item').forEach(el=>\n      el.classList.toggle('active',el.dataset.id===slideId));\n\n    if(viewer.world.getItemCount()) viewer.world.removeAll();\n    const dziResp=await fetch(`/api/slides/${encodeURIComponent(slideId)}/dzi`);\n    if(!dziResp.ok) throw new Error(`DZI error ${dziResp.status}`);\n    const doc=new DOMParser().parseFromString(await dziResp.text(),'application/xml');\n    const imgEl=doc.querySelector('Image'), szEl=doc.querySelector('Size');\n    if(!imgEl||!szEl) throw new Error('Invalid DZI XML');\n    viewer.open({\n      width:    parseInt(szEl.getAttribute('Width')),\n      height:   parseInt(szEl.getAttribute('Height')),\n      tileSize: parseInt(imgEl.getAttribute('TileSize')||'254'),\n      tileOverlap: parseInt(imgEl.getAttribute('Overlap')||'1'),\n      minLevel: 8,\n      getTileUrl:(level,x,y)=>\n        `/api/slides/${encodeURIComponent(slideId)}/tiles/${level}/${x}/${y}`,\n    });\n\n    // Level dropdown\n    const lvlSel=document.getElementById('ext-level');\n    lvlSel.innerHTML='';\n    (info.level_dimensions||[[0,0]]).forEach((dim,i)=>{\n      const ds=info.level_downsamples?.[i]||Math.pow(2,i);\n      const o=document.createElement('option');\n      o.value=i;\n      o.textContent=`Level ${i} — ${dim[0].toLocaleString()}×${dim[1].toLocaleString()} (×${ds.toFixed(1)})`;\n      lvlSel.appendChild(o);\n    });\n\n    await loadAnnotations(slideId);\n    renderClassFilter();\n    scheduleValidate();\n\n    document.getElementById('sb-slide').textContent=info.name||slideId;\n    document.getElementById('sb-dims').textContent=\n      info.dimensions?`${info.dimensions[0].toLocaleString()}×${info.dimensions[1].toLocaleString()}px`:'';\n    document.getElementById('ext-btn').disabled=false;\n    document.getElementById('ext-out').value=(info.name||slideId).replace(/\\.[^.]+$/,'');\n    setStatus('Ready');\n    toast(`Opened: ${info.name||slideId}`,'success');\n  }catch(e){\n    toast(`Failed: ${e.message}`,'error');\n    setStatus('Error');\n    document.getElementById('no-slide').style.display='';\n  }\n}\n\n// ── Upload / Add by path ──────────────────────────────────────────────────────\nfunction switchAddTab(tab){\n  ['upload','cloud','tcga'].forEach(t=>{\n    document.getElementById(`tab-${t}`)?.classList.toggle('active',t===tab);\n    document.getElementById(`pane-${t}`)?.classList.toggle('show',t===tab);\n  });\n  if(tab==='tcga') tcgaInit();\n}\n\n// ── Browse (native OS picker) ─────────────────────────────────────────────────\n// browseFile is now handled by <input type=file> — kept for compatibility\nfunction browseFile(){\n  document.getElementById('file-input-single')?.click();\n}\n\n// Handle single file selected via browser picker\nasync function handleFileInput(input){\n  const files = Array.from(input.files||[]);\n  if(!files.length) return;\n  const prog=document.getElementById('up-prog');\n  const msg=document.getElementById('up-msg');\n  const fill=document.getElementById('up-fill');\n  const pct=document.getElementById('up-pct');\n  // Check if running locally (server has file path access) or cloud (need upload)\n  const isCld = window.location.hostname.includes('hf.space') ||\n                window.location.hostname.includes('huggingface') ||\n                window.location.hostname === 'localhost' && false;\n  for(const file of files){\n    const ext='.'+file.name.split('.').pop().toLowerCase();\n    if(!['.svs','.ndpi','.tiff','.tif','.mrxs','.czi','.scn','.vms','.vmu'].includes(ext)){\n      toast('Skipped: '+file.name+' (unsupported format)','warning'); continue;\n    }\n    prog.style.display='block'; msg.textContent='Uploading '+file.name+'…';\n    if(fill) fill.style.width='5%'; if(pct) pct.textContent='';\n    try{\n      const fd=new FormData(); fd.append('file',file);\n      const xhr=new XMLHttpRequest();\n      await new Promise((ok,fail)=>{\n        xhr.upload.onprogress=e=>{\n          if(e.lengthComputable&&fill&&pct){\n            const p=Math.round(e.loaded/e.total*100);\n            fill.style.width=p+'%'; pct.textContent=p+'%';\n          }\n        };\n        xhr.onload=()=>ok(xhr);\n        xhr.onerror=()=>fail(new Error('Upload failed'));\n        xhr.open('POST','/api/slides/upload');\n        xhr.send(fd);\n      });\n      const d=JSON.parse(xhr.responseText);\n      prog.style.display='none';\n      if(d.error){toast('✗ '+d.error,'error');continue;}\n      toast('✓ Loaded: '+d.name+(d.size_mb?' ('+d.size_mb+' MB)':''),'success');\n      await loadSlides();\n      openSlide(d.id);\n    }catch(e){\n      prog.style.display='none';\n      toast('✗ '+e.message,'error');\n    }\n  }\n  input.value=''; // reset so same file can be re-selected\n}\n// browseDir is now handled by <input webkitdirectory> — kept for compatibility\nfunction browseDir(){\n  document.getElementById('file-input-folder')?.click();\n}\n\n// Handle folder selected via browser picker\nasync function handleFolderInput(input){\n  const files=Array.from(input.files||[]).filter(f=>{\n    const ext='.'+f.name.split('.').pop().toLowerCase();\n    return ['.svs','.ndpi','.tiff','.tif','.mrxs','.czi','.scn','.vms','.vmu'].includes(ext);\n  });\n  if(!files.length){toast('No WSI files found in selected folder','warning');return;}\n  const folderPath=document.getElementById('up-folder-path');\n  // Show folder name from first file path\n  const folderName=files[0].webkitRelativePath.split('/')[0]||'folder';\n  if(folderPath){folderPath.textContent=`📂 ${folderName} — ${files.length} WSI file(s) found`;folderPath.style.display='';}\n  toast(`Found ${files.length} WSI file(s) in ${folderName}…`,'info');\n  const prog=document.getElementById('up-prog');\n  const msg=document.getElementById('up-msg');\n  const fill=document.getElementById('up-fill');\n  const pct=document.getElementById('up-pct');\n  let loaded=0;\n  for(const file of files){\n    prog.style.display='block';\n    msg.textContent=`Uploading ${loaded+1}/${files.length}: ${file.name}`;\n    if(fill) fill.style.width=Math.round(loaded/files.length*100)+'%';\n    try{\n      const fd=new FormData(); fd.append('file',file);\n      const r=await fetch('/api/slides/upload',{method:'POST',body:fd});\n      const d=await r.json();\n      if(d.error){toast('✗ '+file.name+': '+d.error,'error');}\n      else loaded++;\n    }catch(e){toast('✗ '+file.name+': '+e.message,'error');}\n  }\n  prog.style.display='none';\n  if(loaded>0){\n    toast(`✓ Loaded ${loaded} of ${files.length} slides`,'success');\n    loadSlides();\n  }\n  input.value='';\n}\nasync function _addFile(path){\n  try{\n    const d=await(await fetch('/api/registry/add-file',{\n      method:'POST',headers:{'Content-Type':'application/json'},\n      body:JSON.stringify({path}),\n    })).json();\n    if(d.error){toast(d.error,'error');return}\n    toast('Added: '+d.name,'success');\n    await loadSlides();\n    openSlide(d.id);\n  }catch(e){toast(e.message,'error')}\n}\nasync function _addDir(path){\n  try{\n    const d=await(await fetch('/api/registry/add-dir',{\n      method:'POST',headers:{'Content-Type':'application/json'},\n      body:JSON.stringify({path}),\n    })).json();\n    if(d.error){toast(d.error,'error');return}\n    toast('Watching '+d.dir+' — '+d.found+' slides found','success');\n    loadSlides();\n  }catch(e){toast(e.message,'error')}\n}\n\n// ── Cloud download ─────────────────────────────────────────────────────────────\nlet _cloudPollTimer=null;\nasync function addCloudUrl(){\n  const urlIn=document.getElementById('cloud-url-in');\n  const url=urlIn.value.trim();\n  if(!url){toast('Paste a cloud shared link','warning');return}\n  const prog=document.getElementById('cloud-prog');\n  const fill=document.getElementById('cloud-fill');\n  const msgEl=document.getElementById('cloud-prog-msg');\n  const pctEl=document.getElementById('cloud-pct');\n  const errEl=document.getElementById('cloud-error');\n  errEl.style.display='none';\n  prog.style.display='block'; fill.style.width='3%'; pctEl.textContent='';\n  msgEl.textContent='Connecting…';\n  clearInterval(_cloudPollTimer);\n  try{\n    const d=await(await fetch('/api/cloud/add',{\n      method:'POST',headers:{'Content-Type':'application/json'},\n      body:JSON.stringify({url}),\n    })).json();\n    if(d.error){\n      prog.style.display='none';\n      errEl.textContent='✗ '+d.error; errEl.style.display='';\n      return;\n    }\n    if(d.status==='done'){\n      prog.style.display='none';\n      toast('Already downloaded: '+d.name,'success');\n      urlIn.value=''; loadSlides(); return;\n    }\n    msgEl.textContent=(d.provider||'Cloud')+': '+d.name;\n    urlIn.value='';\n    _cloudPollTimer=setInterval(async()=>{\n      try{\n        const st=await(await fetch('/api/cloud/status/'+d.job_id)).json();\n        const p=st.progress||0;\n        fill.style.width=Math.max(p,3)+'%'; pctEl.textContent=p+'%';\n        if(st.bytes_done) msgEl.textContent=(d.provider||'Cloud')+': '+(st.bytes_done/1048576).toFixed(1)+' MB';\n        if(st.status==='done'){\n          clearInterval(_cloudPollTimer);\n          prog.style.display='none'; fill.style.width='0';\n          toast('Downloaded: '+st.name+(st.size_mb?' ('+st.size_mb+' MB)':''),'success');\n          loadSlides();\n        }else if(st.status==='error'){\n          clearInterval(_cloudPollTimer); prog.style.display='none';\n          errEl.textContent='✗ '+st.error; errEl.style.display='';\n        }\n      }catch(ignored){}\n    },1200);\n  }catch(e){\n    prog.style.display='none';\n    errEl.textContent='✗ '+e.message; errEl.style.display='';\n  }\n}\n\nasync function addByFilePath(){\n  const path=document.getElementById('file-path-in').value.trim();\n  if(!path){toast('Enter a file path','warning');return}\n  try{\n    const d=await(await fetch('/api/registry/add-file',{\n      method:'POST',headers:{'Content-Type':'application/json'},\n      body:JSON.stringify({path}),\n    })).json();\n    if(d.error){toast(d.error,'error');return}\n    toast(`Registered: ${d.name}`,'success');\n    document.getElementById('file-path-in').value='';\n    loadSlides();\n  }catch(e){toast(e.message,'error')}\n}\nasync function addByDirPath(){\n  const path=document.getElementById('dir-path-in').value.trim();\n  if(!path){toast('Enter a directory path','warning');return}\n  try{\n    const d=await(await fetch('/api/registry/add-dir',{\n      method:'POST',headers:{'Content-Type':'application/json'},\n      body:JSON.stringify({path}),\n    })).json();\n    if(d.error){toast(d.error,'error');return}\n    toast(`Watching ${d.dir} — ${d.found} slides found`,'success');\n    document.getElementById('dir-path-in').value='';\n    loadSlides();\n  }catch(e){toast(e.message,'error')}\n}\nfunction setupDD(){\n  const area=document.getElementById('up-area');\n  ['dragenter','dragover'].forEach(ev=>area.addEventListener(ev,e=>{\n    e.preventDefault();area.classList.add('dv')}));\n  ['dragleave','drop'].forEach(ev=>area.addEventListener(ev,e=>{\n    e.preventDefault();area.classList.remove('dv')}));\n  area.addEventListener('drop',e=>uploadFiles(e.dataTransfer.files));\n  const vw=document.getElementById('viewer-wrap');\n  vw.addEventListener('dragover',e=>e.preventDefault());\n  vw.addEventListener('drop',e=>{e.preventDefault();uploadFiles(e.dataTransfer.files)});\n  // Import drop\n  const id=document.getElementById('import-drop');\n  ['dragenter','dragover'].forEach(ev=>id.addEventListener(ev,e=>{\n    e.preventDefault();id.classList.add('dv')}));\n  ['dragleave','drop'].forEach(ev=>id.addEventListener(ev,e=>{\n    e.preventDefault();id.classList.remove('dv')}));\n  id.addEventListener('drop',e=>doImport(e.dataTransfer.files[0]));\n}\n\n// ── Annotations CRUD ─────────────────────────────────────────────────────────\nasync function loadAnnotations(sid){\n  try{\n    const d=await(await fetch(`/api/annotations/${encodeURIComponent(sid)}`)).json();\n    annotations=d.annotations||[];\n    if(d.classes?.length) classes=d.classes;\n    else classes=defaultClasses();\n    if(!classes.find(c=>c.id===currentCls?.id)) currentCls=classes[0];\n    renderClasses(); renderAnnList(); redraw(); updateStats();\n  }catch(e){console.error(e)}\n}\nasync function saveAnnotations(){\n  if(!currentSlide) return;\n  try{\n    await fetch(`/api/annotations/${encodeURIComponent(currentSlide.id)}`,{\n      method:'POST',headers:{'Content-Type':'application/json'},\n      body:JSON.stringify({slide_id:currentSlide.id,annotations,classes}),\n    });\n  }catch(e){console.error(e)}\n}\nfunction defaultClasses(){\n  return[\n    {id:'nuclei',   name:'Nuclei',   color:'#7c3aed',shortcut:'1'},\n    {id:'stroma',   name:'Stroma',   color:'#3b82f6',shortcut:'2'},\n    {id:'fat',      name:'Fat',      color:'#fbbf24',shortcut:'3'},\n    {id:'necrosis', name:'Necrosis', color:'#f97316',shortcut:'4'},\n    {id:'mitosis',  name:'Mitosis',  color:'#f59e0b',shortcut:'5'},\n    {id:'other',    name:'Other',    color:'#10b981',shortcut:'6'},\n  ];\n}\nfunction addAnn(ann){\n  undoStack.push(JSON.stringify(annotations));redoStack=[];\n  annotations.push(ann);renderAnnList();updateStats();autoSave();\n}\nfunction deleteAnn(id){\n  undoStack.push(JSON.stringify(annotations));redoStack=[];\n  annotations=annotations.filter(a=>a.id!==id);\n  if(selectedAnn?.id===id){selectedAnn=null;updateProps()}\n  renderAnnList();redraw();updateStats();autoSave();\n}\nfunction deleteSelected(){if(selectedAnn) deleteAnn(selectedAnn.id)}\nlet _saveTimer=null;\nfunction autoSave(){clearTimeout(_saveTimer);_saveTimer=setTimeout(saveAnnotations,800)}\nfunction doSave(){saveAnnotations();toast('Saved','success')}\n\n// ── Import annotations ────────────────────────────────────────────────────────\nfunction showImportModal(){\n  if(!currentSlide){toast('Load a slide first','warning');return}\n  document.getElementById('import-result').style.display='none';\n  document.getElementById('import-modal').classList.add('show');\n}\nasync function doImport(file){\n  if(!file||!currentSlide) return;\n  const mode=document.querySelector('input[name=\"import-mode\"]:checked')?.value||'replace';\n  const fd=new FormData(); fd.append('file',file);\n  try{\n    const r=await fetch(\n      `/api/annotations/${encodeURIComponent(currentSlide.id)}/import?mode=${mode}`,\n      {method:'POST',body:fd});\n    const d=await r.json();\n    const res=document.getElementById('import-result');\n    if(d.error){\n      res.style.cssText='display:block;color:var(--danger)';\n      res.textContent='✗ '+d.error;\n    }else{\n      res.style.cssText='display:block;color:var(--success)';\n      res.textContent=`✓ ${mode==='merge'?'Merged':'Replaced'} — ${d.added} annotations, ${d.classes} classes`;\n      await loadAnnotations(currentSlide.id);\n      toast(`Imported: ${d.added} annotations`,'success');\n    }\n  }catch(e){toast(e.message,'error')}\n}\n\n// ── Tools ────────────────────────────────────────────────────────────────────\nconst TOOLS=['pan','polygon','rectangle','ellipse','freehand','point','select','eraser'];\nfunction setTool(t){\n  currentTool=t;\n  TOOLS.forEach(n=>{\n    document.getElementById(`tb-${n}`)?.classList.toggle('active',n===t);\n    document.getElementById(`rt-${n}`)?.classList.toggle('active',n===t);\n  });\n  if(!viewer) return;\n  if(t==='pan'){\n    viewer.setMouseNavEnabled(true);\n    canvas.className='';\n  }else{\n    viewer.setMouseNavEnabled(false);\n    canvas.className=`drawing ${t}`;\n  }\n  document.getElementById('sb-tool').textContent=t[0].toUpperCase()+t.slice(1);\n  isDrawing=false;drawPts=[];redraw();\n}\n\n// ── Canvas events ─────────────────────────────────────────────────────────────\ncanvas.addEventListener('mousedown',onDown);\ncanvas.addEventListener('mouseup',onUp);\ncanvas.addEventListener('dblclick',onDbl);\ncanvas.addEventListener('contextmenu',e=>{e.preventDefault();cancelDraw()});\n\nfunction onDown(e){\n  if(currentTool==='pan') return;\n  e.preventDefault();\n  const r=canvas.getBoundingClientRect();\n  const cx=e.clientX-r.left,cy=e.clientY-r.top;\n  const ip=cvToImg(cx,cy); if(!ip) return;\n  if(currentTool==='select'){\n    selectedAnn=hitTest(cx,cy);updateProps();redraw();return;\n  }\n  if(currentTool==='eraser'){\n    const h=hitTest(cx,cy);if(h) deleteAnn(h.id);return;\n  }\n  if(currentTool==='polygon'){\n    if(!isDrawing){isDrawing=true;drawPts=[]}\n    drawPts.push([ip.x,ip.y]);redraw();return;\n  }\n  if(currentTool==='point'){\n    addAnn(mkAnn('point',[[ip.x,ip.y]]));redraw();return;\n  }\n  isDrawing=true;rectStart={x:ip.x,y:ip.y};\n  if(currentTool==='freehand') drawPts=[[ip.x,ip.y]];\n}\nfunction onMove(e){\n  const r=canvas.getBoundingClientRect();\n  const cx=e.clientX-r.left,cy=e.clientY-r.top;\n  const ip=cvToImg(cx,cy);\n  if(ip) document.getElementById('coord-badge').textContent=\n    `x:${Math.round(ip.x).toLocaleString()}  y:${Math.round(ip.y).toLocaleString()}`;\n  if(!isDrawing) return;\n  if(currentTool==='freehand'&&ip){\n    const last=drawPts[drawPts.length-1];\n    if(Math.hypot(ip.x-last[0],ip.y-last[1])>4) drawPts.push([ip.x,ip.y]);\n  }\n  redraw(cx,cy);\n}\nfunction onUp(e){\n  if(!isDrawing||currentTool==='polygon') return;\n  const r=canvas.getBoundingClientRect();\n  const ip=cvToImg(e.clientX-r.left,e.clientY-r.top);\n  if(!ip){isDrawing=false;return}\n  if(currentTool==='freehand'){\n    if(drawPts.length>2) addAnn(mkAnn('freehand',drawPts));\n    isDrawing=false;drawPts=[];\n  }else if(currentTool==='rectangle'&&rectStart){\n    const x=Math.min(rectStart.x,ip.x),y=Math.min(rectStart.y,ip.y);\n    const w=Math.abs(ip.x-rectStart.x),h=Math.abs(ip.y-rectStart.y);\n    if(w>5&&h>5){const a=mkAnn('rectangle',[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]);a.rect=[x,y,w,h];addAnn(a)}\n    isDrawing=false;rectStart=null;\n  }else if(currentTool==='ellipse'&&rectStart){\n    const ecx=(rectStart.x+ip.x)/2,ecy=(rectStart.y+ip.y)/2;\n    const rx=Math.abs(ip.x-rectStart.x)/2,ry=Math.abs(ip.y-rectStart.y)/2;\n    if(rx>3&&ry>3){\n      const pts=[],steps=64;\n      for(let i=0;i<steps;i++){\n        const a=(i/steps)*2*Math.PI;pts.push([ecx+rx*Math.cos(a),ecy+ry*Math.sin(a)]);\n      }\n      const ann=mkAnn('ellipse',pts);ann.ellipse={cx:ecx,cy:ecy,rx,ry};addAnn(ann);\n    }\n    isDrawing=false;rectStart=null;\n  }\n  redraw();\n}\nfunction onDbl(e){\n  if(currentTool!=='polygon'||!isDrawing) return;\n  if(drawPts.length<3){cancelDraw();return}\n  addAnn(mkAnn('polygon',drawPts));\n  isDrawing=false;drawPts=[];redraw();\n}\nfunction cancelDraw(){isDrawing=false;drawPts=[];rectStart=null;redraw()}\nfunction mkAnn(type,coords){\n  const cls=currentCls||classes[0]||{id:'other',name:'Other',color:'#10b981'};\n  return{id:'ann_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),\n    type,label:cls.id,label_name:cls.name,color:cls.color,\n    coordinates:coords,area_px:Math.round(polyArea(coords)),\n    notes:'',created:new Date().toISOString()};\n}\nfunction polyArea(pts){\n  if(!pts||pts.length<3) return 0;\n  let a=0;\n  for(let i=0;i<pts.length;i++){const j=(i+1)%pts.length;a+=pts[i][0]*pts[j][1]-pts[j][0]*pts[i][1]}\n  return Math.abs(a)/2;\n}\n\n// ── Rendering ─────────────────────────────────────────────────────────────────\nfunction redraw(mx,my){\n  if(!canvas.width) return;\n  ctx.clearRect(0,0,canvas.width,canvas.height);\n  if(!viewer||!viewer.world.getItemCount()) return;\n  annotations.forEach(a=>drawAnn(a,a===selectedAnn));\n  if(isDrawing&&drawPts.length>0) drawInProgress(mx,my);\n}\nfunction annToCv(ann){\n  return ann.coordinates.map(([ix,iy])=>imgToCv(ix,iy)).filter(Boolean);\n}\nfunction drawAnn(ann,sel){\n  const pts=annToCv(ann);if(!pts.length) return;\n  const col=ann.color||'#00d4ff';\n  ctx.save();\n  if(ann.type==='point'){\n    const p=pts[0];\n    ctx.beginPath();ctx.arc(p.x,p.y,sel?7:5,0,Math.PI*2);\n    ctx.fillStyle=col;ctx.fill();\n    ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();\n  }else if(ann.type==='ellipse'&&ann.ellipse){\n    const{cx,cy,rx,ry}=ann.ellipse;\n    const c=imgToCv(cx,cy),r=imgToCv(cx+rx,cy+ry);\n    if(!c||!r){ctx.restore();return}\n    ctx.beginPath();ctx.ellipse(c.x,c.y,Math.abs(r.x-c.x),Math.abs(r.y-c.y),0,0,Math.PI*2);\n    ctx.fillStyle=hexRgba(col,sel?.5:.2);ctx.fill();\n    ctx.strokeStyle=col;ctx.lineWidth=sel?2:1.5;ctx.stroke();\n  }else{\n    ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);\n    for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x,pts[i].y);\n    ctx.closePath();\n    ctx.fillStyle=hexRgba(col,sel?.5:.2);ctx.fill();\n    ctx.strokeStyle=col;ctx.lineWidth=sel?2.5:1.5;\n    ctx.setLineDash(sel?[6,3]:[]);ctx.stroke();ctx.setLineDash([]);\n  }\n  // Label\n  const lx=pts.reduce((s,p)=>s+p.x,0)/pts.length;\n  const ly=pts.reduce((s,p)=>s+p.y,0)/pts.length;\n  const lbl=ann.label_name||ann.label||'';\n  ctx.font='bold 10px DM Mono,monospace';ctx.textAlign='center';ctx.textBaseline='middle';\n  const tw=ctx.measureText(lbl).width+8;\n  ctx.fillStyle='rgba(7,9,15,.8)';ctx.fillRect(lx-tw/2,ly-7,tw,14);\n  ctx.fillStyle='#fff';ctx.fillText(lbl,lx,ly+1);\n  if(sel) pts.forEach(p=>{\n    ctx.beginPath();ctx.arc(p.x,p.y,3.5,0,Math.PI*2);\n    ctx.fillStyle='#fff';ctx.fill();ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.stroke();\n  });\n  ctx.restore();\n}\nfunction drawInProgress(mx,my){\n  const col=currentCls?.color||'#00d4ff';\n  ctx.save();ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.setLineDash([5,3]);\n  ctx.fillStyle=hexRgba(col,.12);\n  if(currentTool==='polygon'||currentTool==='freehand'){\n    const pts=drawPts.map(([ix,iy])=>imgToCv(ix,iy)).filter(Boolean);\n    if(!pts.length){ctx.restore();return}\n    ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);\n    pts.forEach((p,i)=>{if(i>0)ctx.lineTo(p.x,p.y)});\n    if(mx!==undefined) ctx.lineTo(mx,my);\n    ctx.stroke();ctx.setLineDash([]);\n    if(currentTool==='polygon'&&pts.length>1){\n      ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);\n      pts.forEach((p,i)=>{if(i>0)ctx.lineTo(p.x,p.y)});\n      ctx.closePath();ctx.fill();\n    }\n    pts.forEach((p,i)=>{\n      ctx.beginPath();ctx.arc(p.x,p.y,i===0?4.5:3,0,Math.PI*2);\n      ctx.fillStyle=i===0?'#fff':col;ctx.fill();\n    });\n  }else if(currentTool==='rectangle'&&rectStart&&mx!==undefined){\n    const s=imgToCv(rectStart.x,rectStart.y);\n    if(s){ctx.beginPath();ctx.rect(s.x,s.y,mx-s.x,my-s.y);ctx.fill();ctx.stroke()}\n  }else if(currentTool==='ellipse'&&rectStart&&mx!==undefined){\n    const s=imgToCv(rectStart.x,rectStart.y);\n    if(s){ctx.beginPath();ctx.ellipse((s.x+mx)/2,(s.y+my)/2,Math.abs(mx-s.x)/2,Math.abs(my-s.y)/2,0,0,Math.PI*2);ctx.fill();ctx.stroke()}\n  }\n  ctx.restore();\n}\n\n// ── Hit test ─────────────────────────────────────────────────────────────────\nfunction hitTest(cx,cy){\n  for(let i=annotations.length-1;i>=0;i--){\n    const a=annotations[i],pts=annToCv(a);if(!pts.length) continue;\n    if(a.type==='point'){if(Math.hypot(cx-pts[0].x,cy-pts[0].y)<10) return a}\n    else{if(ptInPoly(cx,cy,pts)) return a}\n  }\n  return null;\n}\nfunction ptInPoly(x,y,pts){\n  let inside=false;\n  for(let i=0,j=pts.length-1;i<pts.length;j=i++){\n    const xi=pts[i].x,yi=pts[i].y,xj=pts[j].x,yj=pts[j].y;\n    if(((yi>y)!=(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;\n  }\n  return inside;\n}\n\n// ── Classes ───────────────────────────────────────────────────────────────────\nfunction renderClasses(){\n  const el=document.getElementById('class-list');el.innerHTML='';\n  const sel=document.getElementById('tb-cls-sel');sel.innerHTML='';\n  classes.forEach(cls=>{\n    const cnt=annotations.filter(a=>a.label===cls.id).length;\n    const row=document.createElement('div');\n    row.className='cls-row'+(currentCls?.id===cls.id?' active':'');\n    row.innerHTML=`<span class=\"cls-k\">${cls.shortcut||''}</span>\n      <span class=\"cls-cd\" style=\"background:${cls.color}\"></span>\n      <span class=\"cls-nm\">${cls.name}</span>\n      <span class=\"cls-ct\">${cnt}</span>`;\n    row.addEventListener('click',()=>selCls(cls));\n    el.appendChild(row);\n    const opt=document.createElement('option');\n    opt.value=cls.id;opt.textContent=cls.name;sel.appendChild(opt);\n  });\n  if(currentCls) sel.value=currentCls.id;\n}\nfunction selCls(cls){\n  currentCls=cls;renderClasses();\n  document.getElementById('tb-cls-dot').style.background=cls.color;\n  document.getElementById('tb-cls-sel').value=cls.id;\n}\nfunction onClsChange(id){const c=classes.find(c=>c.id===id);if(c) selCls(c)}\n\n// ── Class filter ──────────────────────────────────────────────────────────────\nfunction renderClassFilter(){\n  const el=document.getElementById('cls-filter-grid');el.innerHTML='';\n  if(!classes.length){\n    el.innerHTML='<div class=\"empty-st\" style=\"padding:5px;font-size:9.5px\">No classes</div>';\n    return;\n  }\n  classes.forEach(cls=>{\n    const cnt=annotations.filter(a=>a.label===cls.id).length;\n    const row=document.createElement('label');\n    row.className='cls-frow';\n    row.innerHTML=`<input type=\"checkbox\" checked data-cls-id=\"${cls.id}\"/>\n      <span class=\"cls-fdot\" style=\"background:${cls.color}\"></span>\n      <span class=\"cls-fnm\">${cls.name}</span>\n      <span class=\"cls-fct\">${cnt}</span>`;\n    row.querySelector('input').addEventListener('change',scheduleValidate);\n    el.appendChild(row);\n  });\n}\nfunction filterAll(checked){\n  document.querySelectorAll('#cls-filter-grid input[type=checkbox]')\n    .forEach(cb=>{cb.checked=checked});\n  scheduleValidate();\n}\nfunction getSelectedLabels(){\n  return Array.from(\n    document.querySelectorAll('#cls-filter-grid input[type=checkbox]:checked')\n  ).map(cb=>cb.dataset.clsId);\n}\n\n// ── Pre-extraction validation ─────────────────────────────────────────────────\nfunction scheduleValidate(){\n  clearTimeout(_valTimer);\n  _valTimer=setTimeout(runValidate,400);\n}\nasync function runValidate(){\n  if(!currentSlide) return;\n  const labels=getSelectedLabels();\n  const size=parseInt(document.getElementById('ext-size').value)||256;\n  const level=parseInt(document.getElementById('ext-level').value)||0;\n  try{\n    const d=await(await fetch(\n      `/api/slides/${encodeURIComponent(currentSlide.id)}/extract/validate`,{\n        method:'POST',headers:{'Content-Type':'application/json'},\n        body:JSON.stringify({patch_size:size,level,label_filter:labels.length?labels:null}),\n      })).json();\n    renderValidation(d);\n  }catch(e){console.error('validate:',e)}\n}\nfunction renderValidation(d){\n  const panel=document.getElementById('val-panel');\n  if(!d||!d.summary){panel.innerHTML='';return}\n  const s=d.summary;\n  if(!s.total){panel.innerHTML='';return}\n\n  const cls=s.too_small>0&&s.ok===0?'val-err':s.too_small>0?'val-warn':'val-ok';\n  const icon=s.too_small>0&&s.ok===0?'⛔':s.too_small>0?'⚠️':'✅';\n\n  let warningsHtml='';\n  d.annotations.filter(a=>a.status==='too_small').forEach(a=>{\n    const rec=a.recommendation;\n    let suggHtml='';\n    if(rec){\n      const parts=[];\n      if(rec.suggest_patch_size) parts.push(`patch_size → <strong>${rec.suggest_patch_size}</strong>`);\n      if(rec.suggest_level!=null) parts.push(`level → <strong>${rec.suggest_level}</strong>`);\n      if(parts.length) suggHtml=`<br/>💡 Try: ${parts.join(' or ')}`;\n    }\n    warningsHtml+=`<div class=\"val-ann-warn\">⚠ ${a.label_name} (${(a.roi_area_px2/1e6).toFixed(2)}M px²): \n      ROI smaller than patch footprint (${(d.patch_size)}px at L${d.level}).${suggHtml}</div>`;\n  });\n\n  panel.innerHTML=`<div class=\"val-box ${cls}\" style=\"margin-bottom:5px\">\n    <div style=\"font-weight:700;font-size:11px;margin-bottom:4px\">\n      ${icon} Pre-extraction check\n    </div>\n    <div class=\"val-row\">\n      <span style=\"color:var(--text-dim);font-size:10px\">Annotations OK</span>\n      <span style=\"font-family:var(--mono);font-size:10px;color:var(--success)\">${s.ok}</span>\n    </div>\n    <div class=\"val-row\">\n      <span style=\"color:var(--text-dim);font-size:10px\">Too small / skipped</span>\n      <span style=\"font-family:var(--mono);font-size:10px;color:${s.too_small?'var(--warning)':'var(--text-muted)'}\">${s.too_small}</span>\n    </div>\n    ${warningsHtml}\n  </div>`;\n}\n\n// ── Annotation list ───────────────────────────────────────────────────────────\nfunction renderAnnList(){\n  const el=document.getElementById('ann-list');\n  el.querySelectorAll('.ann-item').forEach(n=>n.remove());\n  document.getElementById('ann-cnt').textContent=annotations.length;\n  const empty=document.getElementById('ann-empty');\n  if(!annotations.length){empty.style.display='';return}\n  empty.style.display='none';\n  [...annotations].reverse().forEach(a=>{\n    const item=document.createElement('div');\n    item.className='ann-item'+(a===selectedAnn?' selected':'');\n    item.innerHTML=`<span class=\"ann-sw\" style=\"background:${a.color}\"></span>\n      <span class=\"ann-lbl\">${a.label_name||a.label}</span>\n      <span class=\"ann-tp\">${a.type}</span>\n      <button class=\"ann-del\" onclick=\"event.stopPropagation();deleteAnn('${a.id}')\">✕</button>`;\n    item.addEventListener('click',()=>{selectedAnn=a;renderAnnList();updateProps();redraw()});\n    el.insertBefore(item,empty);\n  });\n}\nfunction updateProps(){\n  const sec=document.getElementById('props-sec');\n  if(!selectedAnn){sec.style.display='none';return}\n  sec.style.display='';\n  const a=selectedAnn;\n  document.getElementById('p-type').textContent=a.type;\n  document.getElementById('p-class').textContent=a.label_name||a.label;\n  document.getElementById('p-area').textContent=(a.area_px?.toLocaleString()+'px²')||'—';\n  if(a.coordinates?.length){\n    const xs=a.coordinates.map(p=>p[0]),ys=a.coordinates.map(p=>p[1]);\n    document.getElementById('p-bbox').textContent=\n      `${Math.round(Math.min(...xs))},${Math.round(Math.min(...ys))} → `+\n      `${Math.round(Math.max(...xs))},${Math.round(Math.max(...ys))}`;\n  }\n  document.getElementById('p-notes').value=a.notes||'';\n}\nfunction updateNotes(v){if(selectedAnn){selectedAnn.notes=v;autoSave()}}\n\n// ── Undo/Redo ─────────────────────────────────────────────────────────────────\nfunction undo(){\n  if(!undoStack.length) return;\n  redoStack.push(JSON.stringify(annotations));\n  annotations=JSON.parse(undoStack.pop());\n  selectedAnn=null;renderAnnList();updateProps();redraw();updateStats();autoSave();toast('Undo');\n}\nfunction redo(){\n  if(!redoStack.length) return;\n  undoStack.push(JSON.stringify(annotations));\n  annotations=JSON.parse(redoStack.pop());\n  selectedAnn=null;renderAnnList();updateProps();redraw();updateStats();autoSave();toast('Redo');\n}\n\n// ── Stats ─────────────────────────────────────────────────────────────────────\nfunction updateStats(){\n  document.getElementById('st-total').textContent=annotations.length;\n  document.getElementById('st-classes').textContent=new Set(annotations.map(a=>a.label)).size;\n  const ta=annotations.reduce((s,a)=>s+(a.area_px||0),0);\n  document.getElementById('st-area').textContent=\n    ta>1e6?(ta/1e6).toFixed(1)+'M':ta>1e3?(ta/1e3).toFixed(1)+'K':ta.toLocaleString();\n  renderClassFilter();scheduleValidate();\n}\nasync function loadStats(){\n  try{const d=await(await fetch('/api/stats')).json();\n    document.getElementById('st-slides').textContent=d.slides||0;\n  }catch{}\n}\nfunction updateZoom(){\n  if(!viewer||!viewer.world.getItemCount()) return;\n  const z=viewer.viewport.getZoom();\n  const mag=currentSlide?.objective_power;\n  document.getElementById('zoom-badge').textContent=mag\n    ?`${(z*parseFloat(mag)).toFixed(1)}× (${z.toFixed(2)} vp)`:`Zoom: ${z.toFixed(3)}`;\n}\n\n// ── Extraction ────────────────────────────────────────────────────────────────\nasync function startExtraction(){\n  if(!currentSlide){toast('No slide loaded','warning');return}\n  const labels=getSelectedLabels();\n  const matching=annotations.filter(a=>!labels.length||labels.includes(a.label));\n  if(!matching.length){toast('No annotations match selected classes','warning');return}\n  const btn=document.getElementById('ext-btn');\n  const res=document.getElementById('ext-result');\n  btn.disabled=true;btn.textContent='⏳ Extracting…';res.style.display='none';\n  try{\n    const outName=(document.getElementById('ext-out').value||'patches').trim()||'patches';\n    const d=await(await fetch(\n      `/api/slides/${encodeURIComponent(currentSlide.id)}/extract`,{\n        method:'POST',headers:{'Content-Type':'application/json'},\n        body:JSON.stringify({\n          patch_size:  parseInt(document.getElementById('ext-size').value)||256,\n          level:       parseInt(document.getElementById('ext-level').value)||0,\n          out_subdir:  outName,\n          overlap_threshold: parseFloat(document.getElementById('ext-overlap').value)||0.3,\n          label_filter: labels.length?labels:null,\n        }),\n      })).json();\n    if(d.error){\n      res.style.cssText='display:block;color:var(--danger)';\n      res.textContent='✗ '+d.error;\n    }else{\n      // Build result HTML with Download ZIP + Open Folder buttons\n      const downloadSubdir=d.output_subdir||outName;\n      const encName=encodeURIComponent(downloadSubdir);\n      const safeJsSubdir=JSON.stringify(downloadSubdir);\n      res.style.display='block';\n      let warn='';\n      if(d.skipped>0) warn+=`<div style=\"color:var(--warning);margin-top:3px\">⚠ ${d.skipped} annotation(s) skipped (ROI too small)</div>`;\n\n      res.innerHTML=`\n        <div style=\"color:var(--success);font-weight:600;margin-bottom:4px\">\n          ✓ ${d.extracted} patches extracted\n        </div>\n        <div style=\"font-size:8.5px;color:var(--text-muted);margin-bottom:4px;\n             word-break:break-all;padding:3px 6px;background:var(--panel-hi);\n             border-radius:3px;font-family:var(--mono)\">${d.output_dir}</div>\n        <div style=\"font-size:8px;color:var(--text-muted);margin-bottom:5px;line-height:1.5\">\n          📄 Naming: <span style=\"font-family:var(--mono);color:var(--text-dim)\">&lt;slide13&gt;_x&lt;X&gt;_y&lt;Y&gt;_s&lt;size&gt;_L&lt;lvl&gt;_&lt;class&gt;.png</span>\n        </div>\n        ${warn}\n        <div style=\"display:flex;gap:4px;margin-top:5px;flex-direction:column\">\n          <div style=\"display:flex;gap:4px\">\n            <a href=\"/api/patches/zip/${encName}\"\n               download=\"${downloadSubdir}_patches.zip\"\n               style=\"flex:1;padding:6px 8px;border-radius:var(--radius);\n                 background:var(--cyan-dim);color:var(--cyan);border:1px solid rgba(0,212,255,.3);\n                 font-size:10px;font-weight:700;text-decoration:none;text-align:center;\n                 display:flex;align-items:center;justify-content:center;gap:3px\"\n               onclick=\"toast('Preparing ZIP…','info')\">\n              ⬇ Download ZIP\n            </a>\n            <button onclick='revealPatches(${safeJsSubdir})'\n               style=\"padding:6px 8px;border-radius:var(--radius);\n                 background:var(--panel-s);color:var(--text-dim);\n                 border:1px solid var(--border);font-size:10px;font-weight:600\"\n               title=\"Open folder in Finder (local only)\">\n              📂 Folder\n            </button>\n          </div>\n          <a href=\"/api/patches/manifest/${encName}\"\n             style=\"width:100%;padding:5px 8px;border-radius:var(--radius);\n               background:var(--panel-s);color:var(--violet);\n               border:1px solid rgba(167,139,250,.25);font-size:10px;font-weight:700;\n               text-decoration:none;text-align:center;display:block\"\n             onclick=\"toast('Downloading annotation manifest JSON…','info')\">\n            📋 Download Annotation Manifest JSON\n          </a>\n        </div>`;\n      toast(`✓ ${d.extracted} patches — download ZIP or manifest JSON`,'success');\n    }\n  }catch(e){toast(`Extraction failed: ${e.message}`,'error')}\n  btn.disabled=false;btn.textContent='⬇ Extract Patches';\n}\n\n// Reveal patch folder in OS file browser (local macOS/Linux/Windows only)\nasync function revealPatches(subdir){\n  try{\n    const d=await(await fetch('/api/patches/reveal/'+encodeURIComponent(subdir))).json();\n    if(d.error) toast('Open folder: '+d.error,'warning');\n  }catch(e){toast(e.message,'error');}\n}\n\n// ── Blurriness ────────────────────────────────────────────────────────────────\nasync function checkBlur(){\n  if(!currentSlide){toast('No slide loaded','warning');return}\n  const el=document.getElementById('blur-res');\n  el.innerHTML='<div style=\"text-align:center;padding:7px\"><div class=\"spinner\"></div></div>';\n  try{\n    const t=parseFloat(document.getElementById('blur-thr').value)||100;\n    const d=await(await fetch(\n      `/api/slides/${encodeURIComponent(currentSlide.id)}/blurriness?threshold=${t}`)).json();\n    if(d.error){el.innerHTML=`<div style=\"color:var(--danger);font-size:10.5px\">${d.error}</div>`;return}\n    el.innerHTML=`\n      <div class=\"blur-res ${d.is_blurry?'blurry':'sharp'}\">${d.is_blurry?'⚠ BLURRY':'✓ SHARP'}</div>\n      <div style=\"font-size:9.5px;color:var(--text-muted);text-align:center;\n        margin-top:3px;font-family:var(--mono)\">\n        Variance: ${d.variance.toFixed(2)} · threshold: ${d.threshold}\n      </div>`;\n  }catch(e){el.innerHTML=`<div style=\"color:var(--danger);font-size:10.5px\">${e.message}</div>`}\n}\n\n// ── Export ────────────────────────────────────────────────────────────────────\nfunction exportAnn(fmt){\n  if(!currentSlide){toast('No slide loaded','warning');return}\n  window.open(`/api/annotations/${encodeURIComponent(currentSlide.id)}/export?format=${fmt}`,'_blank');\n}\nfunction showExportModal(){document.getElementById('export-modal').classList.add('show')}\n\n// ── Modals ────────────────────────────────────────────────────────────────────\nfunction closeMo(){document.querySelectorAll('.mo').forEach(m=>m.classList.remove('show'))}\ndocument.querySelectorAll('.mo').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeMo()}));\nfunction showAddClassModal(){\n  document.getElementById('add-cls-modal').classList.add('show');\n  setTimeout(()=>document.getElementById('new-cls-name').focus(),50);\n}\nfunction addCls(){\n  const name=document.getElementById('new-cls-name').value.trim();\n  if(!name) return;\n  const color=document.getElementById('new-cls-color').value;\n  const key=document.getElementById('new-cls-key').value.trim();\n  classes.push({id:name.toLowerCase().replace(/\\s+/g,'_')+'_'+Date.now(),\n    name,color,shortcut:key||''});\n  closeMo();\n  document.getElementById('new-cls-name').value='';\n  document.getElementById('new-cls-key').value='';\n  selCls(classes[classes.length-1]);\n  renderClassFilter();autoSave();\n}\n\n// ── Keyboard ──────────────────────────────────────────────────────────────────\nfunction setupKeys(){\n  document.addEventListener('keydown',e=>{\n    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;\n    if(e.ctrlKey||e.metaKey){\n      if(e.key==='z'){e.preventDefault();undo();return}\n      if(e.key==='y'){e.preventDefault();redo();return}\n      if(e.key==='s'){e.preventDefault();doSave();return}\n    }\n    const map={v:'pan',p:'polygon',r:'rectangle',e:'ellipse',\n               f:'freehand',t:'point',s:'select',x:'eraser'};\n    if(map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);\n    else if(e.key==='Escape'){cancelDraw();setTool('pan')}\n    else if(e.key==='Delete'||e.key==='Backspace') deleteSelected();\n    else{const c=classes.find(c=>c.shortcut===e.key);if(c) selCls(c)}\n  });\n}\n\n// ── Toasts ────────────────────────────────────────────────────────────────────\nfunction toast(msg,type='info'){\n  const c=document.getElementById('toasts');\n  const t=document.createElement('div');\n  t.className=`toast ${type}`;t.textContent=msg;c.appendChild(t);\n  setTimeout(()=>{t.style.animation='tOut .2s ease forwards';\n    setTimeout(()=>t.remove(),220)},2800);\n}\nfunction setStatus(msg){document.getElementById('sb-status').textContent=msg}\nfunction hexRgba(hex,a){\n  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);\n  return `rgba(${r},${g},${b},${a})`;\n}\n\n\n// ══════════════════════════════════════════════════════════════════════════════\n// TCGA / NCI GDC Data Repository\n// API docs: https://docs.gdc.cancer.gov/API/Users_Guide/Getting_Started/\n// ══════════════════════════════════════════════════════════════════════════════\n\nlet _tcgaPage       = 1;\nlet _tcgaTotal      = 0;\nlet _tcgaPages      = 1;\nlet _tcgaPageSize   = 50;\nlet _tcgaInited     = false;\nlet _gdcTokenSet    = false;\nlet _tcgaDlJobs     = new Map();   // client-side tracking\nlet _tcgaSearchTimer = null;\n\n// Called once when the TCGA tab is first opened\nasync function tcgaInit() {\n  if (_tcgaInited) return;\n  _tcgaInited = true;\n\n  // 1. Ping GDC API to verify connectivity\n  try {\n    const st = await fetch('/api/tcga/status').then(r => r.json());\n    const pill = document.getElementById('gdc-api-status');\n    if (st.ok) {\n      pill.style.display = '';\n      pill.textContent = `✓ GDC API connected  v${st.version || ''}`;\n    } else {\n      pill.style.display = '';\n      pill.style.cssText = pill.style.cssText.replace('success', 'warning')\n        .replace('34,197,94', '251,191,36');\n      pill.textContent = `⚠ GDC API: ${st.error || 'unreachable'}`;\n    }\n  } catch(e) {\n    const pill = document.getElementById('gdc-api-status');\n    pill.style.display = '';\n    pill.style.background = 'rgba(244,63,94,.1)';\n    pill.style.borderColor = 'rgba(244,63,94,.2)';\n    pill.style.color = 'var(--danger)';\n    pill.textContent = '✗ Cannot reach GDC API';\n  }\n\n  // 2. Load TCGA project list\n  const sel = document.getElementById('tcga-project');\n  sel.innerHTML = '<option value=\"\">Loading TCGA projects…</option>';\n  try {\n    const d = await fetch('/api/tcga/projects').then(r => r.json());\n    const hits = (d.data && d.data.hits) || [];\n    if (!hits.length) {\n      sel.innerHTML = '<option value=\"\">No projects returned from GDC</option>';\n      return;\n    }\n    sel.innerHTML = '<option value=\"\">— Select TCGA Project (' + hits.length + ' available) —</option>';\n    hits.forEach(p => {\n      const o = document.createElement('option');\n      o.value = p.project_id;\n      const cases = p.summary && p.summary.case_count ? ` · ${p.summary.case_count} cases` : '';\n      o.textContent = `${p.project_id} — ${p.name || p.primary_site || ''}${cases}`;\n      sel.appendChild(o);\n    });\n  } catch(e) {\n    sel.innerHTML = '<option value=\"\">Error loading projects: ' + e.message + '</option>';\n    toast('TCGA: could not load projects — ' + e.message, 'error');\n  }\n}\n\n// Load (or reload) files for the currently selected project + page\nasync function tcgaLoadFiles() {\n  _tcgaPage = 1;\n  await _tcgaFetch();\n}\n\nfunction tcgaSearchDebounce() {\n  clearTimeout(_tcgaSearchTimer);\n  _tcgaSearchTimer = setTimeout(tcgaLoadFiles, 400);\n}\n\nfunction tcgaPageNav(dir) {\n  const newPage = _tcgaPage + dir;\n  if (newPage < 1 || newPage > _tcgaPages) return;\n  _tcgaPage = newPage;\n  _tcgaFetch();\n}\n\nasync function _tcgaFetch() {\n  const project = (document.getElementById('tcga-project').value || '').trim();\n  const search  = (document.getElementById('tcga-search').value  || '').trim();\n  const list    = document.getElementById('tcga-file-list');\n\n  if (!project) {\n    list.innerHTML = '<div class=\"empty-st\" style=\"padding:12px 8px\"><span class=\"ei\">🧬</span>Select a TCGA project above</div>';\n    _tcgaUpdatePager(0, 0);\n    return;\n  }\n\n  list.innerHTML = '<div style=\"padding:12px;text-align:center\"><div class=\"spinner\" style=\"display:inline-block;margin-right:6px\"></div><span style=\"font-size:10px;color:var(--text-muted)\">Querying GDC…</span></div>';\n  document.getElementById('tcga-prev').disabled = true;\n  document.getElementById('tcga-next').disabled = true;\n\n  try {\n    const params = new URLSearchParams({ page: _tcgaPage, size: _tcgaPageSize });\n    if (project) params.set('project', project);\n    if (search)  params.set('search', search);\n\n    const d = await fetch('/api/tcga/files?' + params).then(r => r.json());\n\n    if (d.error) {\n      list.innerHTML = `<div style=\"padding:8px;color:var(--danger);font-size:9.5px\">✗ ${d.error}</div>`;\n      return;\n    }\n\n    const hits  = (d.data && d.data.hits)  || [];\n    const pag   = (d.data && d.data.pagination) || {};\n    _tcgaTotal  = pag.total  || hits.length;\n    _tcgaPages  = pag.pages  || Math.ceil(_tcgaTotal / _tcgaPageSize) || 1;\n\n    if (!hits.length) {\n      const msg = search ? `No SVS slides matching \"${search}\" in ${project}`\n                         : `No open SVS slide images found in ${project}`;\n      list.innerHTML = `<div class=\"empty-st\" style=\"padding:12px 8px\"><span class=\"ei\">🔬</span>${msg}</div>`;\n      _tcgaUpdatePager(0, 0);\n      return;\n    }\n\n    _tcgaRenderFiles(hits);\n    _tcgaUpdatePager(_tcgaTotal, _tcgaPages);\n\n  } catch(e) {\n    list.innerHTML = `<div style=\"padding:8px;color:var(--danger);font-size:9.5px\">✗ ${e.message}</div>`;\n  }\n}\n\nfunction _tcgaRenderFiles(files) {\n  const list = document.getElementById('tcga-file-list');\n  list.innerHTML = '';\n\n  files.forEach(f => {\n    const sz    = f.file_size ? _fmtBytes(f.file_size) : '? MB';\n    const caseId = (f.cases && f.cases[0] && f.cases[0].submitter_id) || '—';\n    const proj   = (f.cases && f.cases[0] && f.cases[0].project && f.cases[0].project.project_id) || '';\n    const access = (f.access || 'open').toLowerCase();\n    const state  = (f.state  || '').toLowerCase();\n    const isOpen = access === 'open';\n    const canDl  = isOpen || _gdcTokenSet;\n\n    const item = document.createElement('div');\n    item.style.cssText = 'padding:5px 8px;border-bottom:1px solid var(--border);' +\n                         'transition:background .1s';\n    item.onmouseenter = () => { item.style.background = 'var(--panel-hi)'; };\n    item.onmouseleave = () => { item.style.background = ''; };\n\n    const accessBadge = isOpen\n      ? '<span style=\"font-size:7.5px;padding:1px 4px;border-radius:3px;background:rgba(34,197,94,.15);color:#22c55e;flex-shrink:0\">open</span>'\n      : '<span style=\"font-size:7.5px;padding:1px 4px;border-radius:3px;background:rgba(251,191,36,.12);color:#fbbf24;flex-shrink:0\">🔒 ctrl</span>';\n\n    const stateNote = state && state !== 'released'\n      ? `<span style=\"font-size:7.5px;color:var(--warning)\">${state}</span>` : '';\n\n    const dlBtn = `<button onclick=\"tcgaDl('${f.file_id}','${f.file_name}','${access}','${proj}')\"\n      title=\"${canDl ? 'Download to local cache' : 'Requires GDC token'}\"\n      style=\"padding:2px 8px;border-radius:3px;font-size:8.5px;font-weight:700;flex-shrink:0;\n        background:${canDl ? 'var(--cyan-dim)' : 'var(--border)'};\n        color:${canDl ? 'var(--cyan)' : 'var(--text-muted)'};\n        cursor:${canDl ? 'pointer' : 'not-allowed'}\"\n      ${canDl ? '' : 'disabled'}>↓ Get</button>`;\n\n    const gdcLink = `<a href=\"https://portal.gdc.cancer.gov/files/${f.file_id}\" target=\"_blank\"\n      title=\"View on GDC Portal\"\n      style=\"font-size:8.5px;color:var(--text-muted);text-decoration:none;flex-shrink:0\">↗</a>`;\n\n    item.innerHTML = `\n      <div style=\"font-size:9.5px;font-weight:600;color:var(--text);\n                  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px\"\n           title=\"${f.file_name}\">${f.file_name}</div>\n      <div style=\"display:flex;align-items:center;gap:5px;flex-wrap:wrap\">\n        <span style=\"font-size:8.5px;color:var(--text-muted);font-family:var(--mono)\">${sz}</span>\n        <span style=\"font-size:8.5px;color:var(--text-muted)\">${caseId}</span>\n        ${stateNote}\n        ${accessBadge}\n        <div style=\"flex:1\"></div>\n        ${gdcLink}\n        ${dlBtn}\n      </div>`;\n    list.appendChild(item);\n  });\n}\n\nfunction _tcgaUpdatePager(total, pages) {\n  const info = document.getElementById('tcga-page-info');\n  const prev = document.getElementById('tcga-prev');\n  const next = document.getElementById('tcga-next');\n  if (!total) {\n    info.textContent = '—';\n    prev.disabled = next.disabled = true;\n    return;\n  }\n  info.textContent = `Page ${_tcgaPage} / ${pages}  (${total.toLocaleString()} files)`;\n  prev.disabled = _tcgaPage <= 1;\n  next.disabled = _tcgaPage >= pages;\n}\n\nfunction _fmtBytes(bytes) {\n  if (!bytes) return '?';\n  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';\n  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(1)    + ' MB';\n  return (bytes / 1024).toFixed(0) + ' KB';\n}\n\n// Save GDC authentication token (session only)\nfunction saveGdcToken() {\n  const t = (document.getElementById('gdc-token-in').value || '').trim();\n  fetch('/api/tcga/token', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ token: t }),\n  });\n  _gdcTokenSet = !!t;\n  const el = document.getElementById('gdc-token-status');\n  el.textContent  = t ? '✓ Token active (session only — not stored to disk)' : 'Token cleared';\n  el.style.color  = t ? 'var(--success)' : 'var(--text-muted)';\n  if (t) toast('GDC token saved for this session', 'success');\n  // Re-render file list so controlled-access buttons activate\n  if (_tcgaInited && document.getElementById('tcga-project').value) tcgaLoadFiles();\n}\n\n// Start a download (queues on server, polls for progress)\nasync function tcgaDl(fileId, fileName, access, project) {\n  if (access === 'controlled' && !_gdcTokenSet) {\n    toast('Set a GDC authentication token first for controlled-access files', 'warning');\n    document.getElementById('gdc-token-in').focus();\n    return;\n  }\n\n  const jobKey = 'tcga_' + fileId.slice(0, 8);\n  if (_tcgaDlJobs.has(jobKey) && _tcgaDlJobs.get(jobKey).status === 'downloading') {\n    toast('Already downloading: ' + fileName, 'warning');\n    return;\n  }\n\n  _tcgaDlJobs.set(jobKey, { name: fileName, status: 'queued', progress: 0 });\n  _tcgaRenderQueue();\n\n  try {\n    const d = await fetch('/api/tcga/download', {\n      method:  'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body:    JSON.stringify({ file_id: fileId, file_name: fileName, access, project }),\n    }).then(r => r.json());\n\n    if (d.error) {\n      _tcgaDlJobs.get(jobKey).status = 'error';\n      _tcgaDlJobs.get(jobKey).error  = d.error;\n      _tcgaRenderQueue();\n      toast('✗ ' + d.error, 'error');\n      return;\n    }\n\n    if (d.status === 'done') {\n      // Already cached\n      Object.assign(_tcgaDlJobs.get(jobKey), d);\n      _tcgaRenderQueue();\n      toast('Already cached: ' + fileName + (d.size_mb ? ` (${d.size_mb} MB)` : ''), 'success');\n      loadSlides();\n      return;\n    }\n\n    toast('Download started: ' + fileName, 'info');\n\n    // Poll for progress\n    const pollId = d.job_id;\n    const timer  = setInterval(async () => {\n      try {\n        const st = await fetch('/api/tcga/status/' + pollId).then(r => r.json());\n        const j  = _tcgaDlJobs.get(jobKey);\n        if (j) Object.assign(j, st);\n        _tcgaRenderQueue();\n\n        if (st.status === 'done') {\n          clearInterval(timer);\n          toast(`✓ Downloaded: ${fileName}${st.size_mb ? ' (' + st.size_mb + ' MB)' : ''}`, 'success');\n          loadSlides();\n        } else if (st.status === 'error') {\n          clearInterval(timer);\n          toast('✗ Download failed: ' + st.error, 'error');\n        }\n      } catch(e) { /* poll silently */ }\n    }, 1500);\n\n  } catch(e) {\n    const j = _tcgaDlJobs.get(jobKey);\n    if (j) { j.status = 'error'; j.error = e.message; }\n    _tcgaRenderQueue();\n    toast('✗ ' + e.message, 'error');\n  }\n}\n\nfunction _tcgaRenderQueue() {\n  const el = document.getElementById('tcga-dl-queue');\n  el.innerHTML = '';\n  _tcgaDlJobs.forEach((job) => {\n    if (!job.name) return;\n    const div = document.createElement('div');\n    div.style.cssText = 'margin-top:2px;padding:4px 7px;border-radius:var(--radius);' +\n                        'background:var(--panel-s);border:1px solid var(--border)';\n    const pct   = job.status === 'done'  ? '✓'\n                : job.status === 'error' ? '✗'\n                : job.progress ? job.progress + '%' : '…';\n    const col   = job.status === 'done'  ? 'var(--success)'\n                : job.status === 'error' ? 'var(--danger)'  : 'var(--cyan)';\n    const bytes = job.bytes_done\n      ? ' · ' + _fmtBytes(job.bytes_done) + (job.size_mb ? ' / ' + job.size_mb + ' MB' : '')\n      : '';\n    div.innerHTML = `\n      <div style=\"display:flex;justify-content:space-between;align-items:center;gap:6px\">\n        <span style=\"font-size:9px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;\n                     white-space:nowrap;flex:1\" title=\"${job.name}\">${job.name}</span>\n        <span style=\"font-size:9px;font-family:var(--mono);color:${col};flex-shrink:0\">${pct}</span>\n      </div>\n      ${job.status === 'error'\n        ? `<div style=\"font-size:8px;color:var(--danger);line-height:1.3;margin-top:2px\">${job.error}</div>`\n        : ''}\n      ${job.status === 'downloading' && job.progress\n        ? `<div style=\"font-size:8px;color:var(--text-muted)\">${bytes}</div>\n           <div class=\"prog-bar\" style=\"margin-top:3px\">\n             <div class=\"prog-fill\" style=\"width:${job.progress}%\"></div>\n           </div>`\n        : ''}`;\n    el.appendChild(div);\n  });\n}\n\n// ── Stream TCGA slide (no download) ──────────────────────────────────────────\nasync function tcgaStream(fileId, fileName, access, project) {\n  if (access === 'controlled' && !_gdcTokenSet) {\n    toast('Set a GDC token first for controlled access files', 'warning');\n    document.getElementById('gdc-token-in').focus(); return;\n  }\n  setStatus('Connecting to GDC…');\n  toast('▶ Streaming: ' + fileName, 'info');\n  try {\n    const d = await fetch('/api/tcga/stream', {\n      method: 'POST', headers: {'Content-Type':'application/json'},\n      body: JSON.stringify({file_id:fileId, file_name:fileName, access, project})\n    }).then(r=>r.json());\n    if (d.error) { toast('✗ Stream failed: '+d.error, 'error'); setStatus('Error'); return; }\n    await loadSlides();\n    openSlide(d.id);\n    toast('▶ Streaming: '+fileName, 'success');\n    setStatus('Ready');\n  } catch(e) { toast('✗ '+e.message, 'error'); setStatus('Error'); }\n}\n\n// ── Stream any HTTP URL (no download) ─────────────────────────────────────────\nasync function addRemoteUrl(url) {\n  url = (url||'').trim(); if (!url) return;\n  setStatus('Connecting…');\n  try {\n    const d = await fetch('/api/remote/add', {\n      method: 'POST', headers: {'Content-Type':'application/json'},\n      body: JSON.stringify({url})\n    }).then(r=>r.json());\n    if (d.error) { toast('✗ '+d.error, 'error'); setStatus('Error'); return; }\n    document.getElementById('remote-url-in').value = '';\n    await loadSlides(); openSlide(d.id);\n    toast('▶ Streaming: '+d.name, 'success'); setStatus('Ready');\n  } catch(e) { toast('✗ '+e.message, 'error'); setStatus('Error'); }\n}\n\n// ── Demo slide loader ─────────────────────────────────────────────────────────\nasync function loadDemoSlide() {\n  setStatus('Downloading demo…'); toast('Loading CMU-1 H&E…','info');\n  try {\n    const d = await fetch('/api/demo/load', {method:'POST'}).then(r=>r.json());\n    if (d.status==='exists') {\n      await loadSlides();\n      const item = document.querySelector('.slide-item'); if(item) item.click(); return;\n    }\n    if (d.job_id) {\n      const t = setInterval(async()=>{\n        try {\n          const st = await fetch('/api/cloud/status/'+d.job_id).then(r=>r.json());\n          if (st.status==='done') {\n            clearInterval(t); await loadSlides();\n            const item=document.querySelector('.slide-item'); if(item) item.click();\n            toast('Demo slide loaded','success');\n          } else if(st.status==='error') { clearInterval(t); toast('✗ '+st.error,'error'); }\n        }catch(e){}\n      }, 1200);\n    }\n  } catch(e) { toast('✗ '+e.message,'error'); }\n}\nfunction checkAIStatus(){}\n\n\n\n// ── UX Enhancements: light theme, metadata, batch extraction, collapsible panes ──\nlet _slidesCache = [];\nlet _extractSlideIds = new Set();\n\nconst THEME_PRESETS = {\n  light: {\n    '--bg': '#f7f9fc',\n    '--surface': '#ffffff',\n    '--panel': '#ffffffee',\n    '--panel-s': '#ffffff',\n    '--panel-hi': '#f2f6fb',\n    '--border': '#d7e0ec',\n    '--border-hi': '#c3d0e2',\n    '--cyan': '#0ea5e9',\n    '--cyan-dim': '#e0f2fe',\n    '--cyan-glow': 'rgba(14,165,233,.08)',\n    '--violet': '#7c3aed',\n    '--orange': '#ea580c',\n    '--success': '#16a34a',\n    '--danger': '#e11d48',\n    '--warning': '#d97706',\n    '--text': '#0f172a',\n    '--text-muted': '#64748b',\n    '--text-dim': '#334155',\n    '--viewer-bg': '#eef2f7',\n    '--badge-bg': 'rgba(255,255,255,.92)'\n  },\n  dark: {\n    '--bg': '#07090f',\n    '--surface': '#0c0f1a',\n    '--panel': '#10142040',\n    '--panel-s': '#111525',\n    '--panel-hi': '#161c2e',\n    '--border': '#1a2035',\n    '--border-hi': '#253050',\n    '--cyan': '#00d4ff',\n    '--cyan-dim': '#003a4a',\n    '--cyan-glow': 'rgba(0,212,255,.12)',\n    '--violet': '#a78bfa',\n    '--orange': '#f97316',\n    '--success': '#22c55e',\n    '--danger': '#f43f5e',\n    '--warning': '#fbbf24',\n    '--text': '#cdd6f0',\n    '--text-muted': '#4a5a7a',\n    '--text-dim': '#7a8aaa',\n    '--viewer-bg': '#000000',\n    '--badge-bg': 'rgba(7,9,15,.82)'\n  },\n  midnight: {\n    '--bg': '#081019',\n    '--surface': '#0b1624',\n    '--panel': '#0f172240',\n    '--panel-s': '#102033',\n    '--panel-hi': '#162942',\n    '--border': '#1c3550',\n    '--border-hi': '#274766',\n    '--cyan': '#38bdf8',\n    '--cyan-dim': '#0c3348',\n    '--cyan-glow': 'rgba(56,189,248,.12)',\n    '--violet': '#c084fc',\n    '--orange': '#fb923c',\n    '--success': '#22c55e',\n    '--danger': '#fb7185',\n    '--warning': '#facc15',\n    '--text': '#dbe7f5',\n    '--text-muted': '#7c96b4',\n    '--text-dim': '#9cb3cf',\n    '--viewer-bg': '#06111b',\n    '--badge-bg': 'rgba(8,16,25,.88)'\n  }\n};\n\nfunction escHtml(v) {\n  return String(v == null ? '' : v)\n    .replace(/&/g, '&amp;')\n    .replace(/</g, '&lt;')\n    .replace(/>/g, '&gt;')\n    .replace(/\"/g, '&quot;')\n    .replace(/'/g, '&#39;');\n}\n\nfunction readUiPref(key, fallback) {\n  try {\n    const v = localStorage.getItem(key);\n    return v == null ? fallback : v;\n  } catch {\n    return fallback;\n  }\n}\n\nfunction writeUiPref(key, value) {\n  try { localStorage.setItem(key, String(value)); } catch {}\n}\n\nfunction injectEnhancementStyles() {\n  if (document.getElementById('monjoy-ux-enhance-style')) return;\n  const st = document.createElement('style');\n  st.id = 'monjoy-ux-enhance-style';\n  st.textContent = [\n    '#sidebar-left{width:240px}',\n    '#sidebar-right{width:300px}',\n    '.theme-wrap{display:flex;align-items:center;gap:6px;flex-shrink:0;margin-right:6px}',\n    '.theme-lbl{font-size:9px;letter-spacing:.9px;text-transform:uppercase;color:var(--text-muted);font-weight:700}',\n    '.left-pane-body{display:flex;flex-direction:column;flex:1;min-height:0}',\n    '.slide-search-wrap{padding:6px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:4px;background:var(--surface)}',\n    '.slide-summary{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:8.5px;color:var(--text-muted);font-family:var(--mono)}',\n    '.pane-hint{font-size:8.3px;line-height:1.45;color:var(--text-muted)}',\n    '.pane-collapsed{display:none !important}',\n    '#data-browser-wrap{border-top:none;max-height:46%;overflow-y:auto;overflow-x:hidden}',\n    '.slide-batch-toggle{width:22px;height:22px;border-radius:50%;background:var(--panel-s);border:1px solid var(--border);color:var(--text-muted);display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;margin-left:auto;transition:all .15s}',\n    '.slide-batch-toggle:hover{border-color:var(--cyan);color:var(--cyan)}',\n    '.slide-item.batch-selected{border-color:rgba(14,165,233,.35) !important;box-shadow:inset 0 0 0 1px rgba(14,165,233,.18)}',\n    '.slide-item.batch-selected .slide-batch-toggle{background:var(--cyan-dim);color:var(--cyan);border-color:rgba(14,165,233,.35)}',\n    '#batch-slide-preview{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}',\n    '.batch-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border-radius:999px;background:var(--panel-s);border:1px solid var(--border);font-size:9px;color:var(--text-dim);max-width:100%}',\n    '.batch-chip.current{border-color:rgba(14,165,233,.35);color:var(--cyan)}',\n    '.batch-chip .mono{font-family:var(--mono);font-size:8.5px;color:var(--text-muted)}',\n    '.batch-empty,.meta-empty{padding:8px;border:1px dashed var(--border-hi);border-radius:var(--radius);font-size:10px;color:var(--text-muted);text-align:center;line-height:1.5}',\n    '.ext-slide-actions{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}',\n    '.meta-actions{display:flex;justify-content:flex-end;margin-bottom:6px}',\n    '.meta-grid{display:grid;grid-template-columns:88px 1fr;gap:6px 8px}',\n    '.meta-key{font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.8px}',\n    '.meta-val{font-size:10.5px;color:var(--text);word-break:break-word;line-height:1.45}',\n    '.meta-raw{margin-top:8px}',\n    '.meta-raw summary{cursor:pointer;font-size:9.5px;color:var(--violet);font-weight:700}',\n    '.meta-pre{margin-top:6px;max-height:180px;overflow:auto;background:var(--panel-s);padding:8px;border-radius:var(--radius);border:1px solid var(--border);font-size:9px;color:var(--text-dim);font-family:var(--mono);white-space:pre-wrap}',\n    '.batch-res-box{display:flex;flex-direction:column;gap:3px;margin-top:6px}',\n    '.batch-res-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 6px;background:var(--panel-s);border:1px solid var(--border);border-radius:var(--radius);font-size:9.5px}',\n    '.batch-res-row .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',\n    '.batch-res-row .stat{font-family:var(--mono);flex-shrink:0}',\n    '.meta-note{font-size:8.5px;color:var(--text-muted);line-height:1.45;margin-top:6px}',\n    '.slide-search-wrap .path-in{font-size:10px}',\n    '.slide-search-wrap .path-btn{padding:4px 8px;font-size:10px}'\n  ].join('\\n');\n  document.head.appendChild(st);\n}\n\nfunction applyTheme(name) {\n  const theme = THEME_PRESETS[name] || THEME_PRESETS.light;\n  Object.keys(theme).forEach(function (k) {\n    document.documentElement.style.setProperty(k, theme[k]);\n  });\n  document.documentElement.setAttribute('data-theme', name);\n  const sel = document.getElementById('theme-select');\n  if (sel && sel.value !== name) sel.value = name;\n  writeUiPref('monjoy_theme', name);\n}\n\nfunction setupThemeControls() {\n  const topbar = document.getElementById('topbar');\n  const spacer = topbar ? topbar.querySelector('.tb-spacer') : null;\n  if (!topbar || !spacer || document.getElementById('theme-select')) {\n    applyTheme(readUiPref('monjoy_theme', 'light') || 'light');\n    return;\n  }\n  const wrap = document.createElement('div');\n  wrap.className = 'theme-wrap';\n\n  const lbl = document.createElement('span');\n  lbl.className = 'theme-lbl';\n  lbl.textContent = 'Theme';\n\n  const sel = document.createElement('select');\n  sel.id = 'theme-select';\n  sel.className = 'cls-sel';\n  sel.style.minWidth = '112px';\n  [['light', 'Light'], ['dark', 'Dark'], ['midnight', 'Midnight']].forEach(function (it) {\n    const opt = document.createElement('option');\n    opt.value = it[0];\n    opt.textContent = it[1];\n    sel.appendChild(opt);\n  });\n  sel.addEventListener('change', function () { applyTheme(this.value); });\n\n  wrap.appendChild(lbl);\n  wrap.appendChild(sel);\n  topbar.insertBefore(wrap, spacer);\n  applyTheme(readUiPref('monjoy_theme', 'light') || 'light');\n}\n\nfunction setPaneCollapsed(id, btn, collapsed) {\n  const el = document.getElementById(id);\n  if (!el) return;\n  el.classList.toggle('pane-collapsed', !!collapsed);\n  if (btn) btn.textContent = collapsed ? '▸' : '▾';\n}\n\nfunction togglePane(id, btn, prefKey) {\n  const el = document.getElementById(id);\n  if (!el) return;\n  const next = !el.classList.contains('pane-collapsed');\n  setPaneCollapsed(id, btn, next);\n  if (prefKey) writeUiPref(prefKey, next ? '1' : '0');\n}\n\nfunction updateVisibleSlideSummary(visibleCount, totalCount) {\n  const visibleEl = document.getElementById('slide-visible-summary');\n  if (visibleEl) visibleEl.textContent = visibleCount + ' / ' + totalCount + ' shown';\n  const selectEl = document.getElementById('slide-select-summary');\n  if (!selectEl) return;\n  const explicitIds = getSelectedSlideIds(false);\n  if (explicitIds.length) selectEl.textContent = explicitIds.length + ' selected';\n  else if (currentSlide && currentSlide.id) selectEl.textContent = 'Current slide';\n  else selectEl.textContent = '0 selected';\n}\n\nfunction setupLeftSidebarUX() {\n  const left = document.getElementById('sidebar-left');\n  if (!left) return;\n\n  const slideHeader = left.querySelector('.ph');\n  const slideList = document.getElementById('slide-list');\n  if (slideHeader && slideList && !document.getElementById('slide-panel-body')) {\n    slideHeader.innerHTML = '';\n    const title = document.createElement('span');\n    title.textContent = 'Slides';\n    const actions = document.createElement('span');\n    actions.style.cssText = 'display:flex;align-items:center;gap:4px';\n\n    const toggleBtn = document.createElement('button');\n    toggleBtn.className = 'ph-btn';\n    toggleBtn.title = 'Collapse slide panel';\n    toggleBtn.textContent = '▾';\n    toggleBtn.addEventListener('click', function (e) {\n      e.stopPropagation();\n      togglePane('slide-panel-body', toggleBtn, 'monjoy_pane_slides');\n    });\n\n    const refreshBtn = document.createElement('button');\n    refreshBtn.className = 'ph-btn';\n    refreshBtn.title = 'Refresh slides';\n    refreshBtn.textContent = '↻';\n    refreshBtn.addEventListener('click', function (e) {\n      e.stopPropagation();\n      loadSlides();\n    });\n\n    actions.appendChild(toggleBtn);\n    actions.appendChild(refreshBtn);\n    slideHeader.appendChild(title);\n    slideHeader.appendChild(actions);\n\n    const panel = document.createElement('div');\n    panel.id = 'slide-panel-body';\n    panel.className = 'left-pane-body';\n\n    const searchWrap = document.createElement('div');\n    searchWrap.className = 'slide-search-wrap';\n    searchWrap.innerHTML = [\n      '<div class=\"path-row\">',\n      '  <input id=\"slide-search\" class=\"path-in\" type=\"text\" autocomplete=\"off\" placeholder=\"Search slides, source, dimensions…\"/>',\n      '  <button id=\"slide-search-clear\" class=\"path-btn\" type=\"button\" title=\"Clear search\">✕</button>',\n      '</div>',\n      '<div class=\"slide-summary\"><span id=\"slide-visible-summary\">0 / 0 shown</span><span id=\"slide-select-summary\">0 selected</span></div>',\n      '<div class=\"pane-hint\">Use the + button on any slide card to include it in batch extraction.</div>'\n    ].join('');\n\n    slideList.parentNode.insertBefore(panel, slideList);\n    panel.appendChild(searchWrap);\n    panel.appendChild(slideList);\n\n    const searchInput = document.getElementById('slide-search');\n    const searchClear = document.getElementById('slide-search-clear');\n    if (searchInput) searchInput.addEventListener('input', applySlideSearch);\n    if (searchClear) searchClear.addEventListener('click', function () {\n      if (searchInput) searchInput.value = '';\n      applySlideSearch();\n    });\n\n    if (readUiPref('monjoy_pane_slides', '0') === '1') setPaneCollapsed('slide-panel-body', toggleBtn, true);\n  }\n\n  const addPanel = left.querySelector('.add-panel');\n  if (addPanel && !document.getElementById('data-browser-header')) {\n    addPanel.id = 'data-browser-wrap';\n    const hdr = document.createElement('div');\n    hdr.className = 'ph';\n    hdr.id = 'data-browser-header';\n    const title = document.createElement('span');\n    title.textContent = 'Data Browser';\n    const btn = document.createElement('button');\n    btn.className = 'ph-btn';\n    btn.title = 'Collapse data browser';\n    btn.textContent = '▾';\n    btn.addEventListener('click', function (e) {\n      e.stopPropagation();\n      togglePane('data-browser-wrap', btn, 'monjoy_pane_data');\n    });\n    hdr.appendChild(title);\n    hdr.appendChild(btn);\n    left.insertBefore(hdr, addPanel);\n    if (readUiPref('monjoy_pane_data', '0') === '1') setPaneCollapsed('data-browser-wrap', btn, true);\n  }\n}\n\nfunction getSlideInfoById(id) {\n  for (let i = 0; i < _slidesCache.length; i++) {\n    if (_slidesCache[i].id === id) return _slidesCache[i];\n  }\n  if (currentSlide && currentSlide.id === id) return currentSlide;\n  return null;\n}\n\nfunction getSelectedSlideIds(useFallback) {\n  const available = new Set(_slidesCache.map(function (s) { return s.id; }));\n  const explicitIds = Array.from(_extractSlideIds).filter(function (id) { return available.has(id); });\n  _extractSlideIds = new Set(explicitIds);\n  if (!explicitIds.length && useFallback && currentSlide && currentSlide.id) return [currentSlide.id];\n  return explicitIds;\n}\n\nfunction toggleSlideForBatch(id) {\n  if (!id) return;\n  if (_extractSlideIds.has(id)) _extractSlideIds.delete(id);\n  else _extractSlideIds.add(id);\n  refreshBatchSelectionUI();\n}\n\nfunction selectCurrentSlideForBatch() {\n  _extractSlideIds.clear();\n  if (currentSlide && currentSlide.id) _extractSlideIds.add(currentSlide.id);\n  refreshBatchSelectionUI();\n}\n\nfunction selectAnnotatedSlidesForBatch() {\n  const ids = _slidesCache.filter(function (s) { return (s.annotation_count || 0) > 0; }).map(function (s) { return s.id; });\n  _extractSlideIds = new Set(ids);\n  refreshBatchSelectionUI();\n}\n\nfunction selectAllSlidesForBatch() {\n  _extractSlideIds = new Set(_slidesCache.map(function (s) { return s.id; }));\n  refreshBatchSelectionUI();\n}\n\nfunction clearBatchSelection() {\n  _extractSlideIds.clear();\n  refreshBatchSelectionUI();\n}\n\nfunction refreshSlideCardSelections() {\n  const items = document.querySelectorAll('#slide-list .slide-item');\n  items.forEach(function (item) {\n    const sid = item.dataset.id;\n    const selected = _extractSlideIds.has(sid);\n    item.classList.toggle('batch-selected', selected);\n    const btn = item.querySelector('.slide-batch-toggle');\n    if (btn) {\n      btn.textContent = selected ? '✓' : '+';\n      btn.title = selected ? 'Remove from batch extraction' : 'Add to batch extraction';\n      btn.setAttribute('aria-pressed', selected ? 'true' : 'false');\n    }\n  });\n}\n\nfunction refreshBatchSelectionUI() {\n  const explicitIds = getSelectedSlideIds(false);\n  const ids = getSelectedSlideIds(true);\n  const countEl = document.getElementById('batch-slide-count');\n  const preview = document.getElementById('batch-slide-preview');\n  const selectSummary = document.getElementById('slide-select-summary');\n\n  if (countEl) {\n    if (explicitIds.length) countEl.textContent = explicitIds.length + ' selected';\n    else if (currentSlide && currentSlide.id) countEl.textContent = 'Current slide';\n    else countEl.textContent = '0 selected';\n  }\n  if (selectSummary) {\n    if (explicitIds.length) selectSummary.textContent = explicitIds.length + ' selected';\n    else if (currentSlide && currentSlide.id) selectSummary.textContent = 'Current slide';\n    else selectSummary.textContent = '0 selected';\n  }\n  if (preview) {\n    if (!ids.length) {\n      preview.innerHTML = '<div class=\"batch-empty\">Open or select at least one slide to extract.</div>';\n    } else {\n      const chips = [];\n      const maxShow = 8;\n      ids.slice(0, maxShow).forEach(function (id) {\n        const info = getSlideInfoById(id) || { id: id, name: id };\n        const count = info.annotation_count != null ? info.annotation_count : (currentSlide && currentSlide.id === id ? annotations.length : 0);\n        const cls = currentSlide && currentSlide.id === id ? 'batch-chip current' : 'batch-chip';\n        chips.push('<span class=\"' + cls + '\" title=\"' + escHtml(info.name || info.id) + '\">' +\n          '<span>' + escHtml(info.name || info.id) + '</span>' +\n          '<span class=\"mono\">' + count + ' ann.</span></span>');\n      });\n      if (ids.length > maxShow) chips.push('<span class=\"batch-chip\">+' + (ids.length - maxShow) + ' more</span>');\n      preview.innerHTML = chips.join('');\n    }\n  }\n  refreshSlideCardSelections();\n  applySlideSearch();\n}\n\nfunction enhanceSlideCards() {\n  const items = document.querySelectorAll('#slide-list .slide-item');\n  items.forEach(function (item) {\n    if (item.querySelector('.slide-batch-toggle')) return;\n    const sid = item.dataset.id;\n    const btn = document.createElement('button');\n    btn.type = 'button';\n    btn.className = 'slide-batch-toggle';\n    btn.textContent = '+';\n    btn.title = 'Add to batch extraction';\n    btn.addEventListener('click', function (e) {\n      e.preventDefault();\n      e.stopPropagation();\n      toggleSlideForBatch(sid);\n    });\n    item.appendChild(btn);\n  });\n  refreshSlideCardSelections();\n}\n\nfunction applySlideSearch() {\n  const input = document.getElementById('slide-search');\n  const q = (input ? input.value : '').trim().toLowerCase();\n  const items = Array.from(document.querySelectorAll('#slide-list .slide-item'));\n  const empty = document.getElementById('slide-empty');\n  let visible = 0;\n  items.forEach(function (item) {\n    const txt = (item.textContent || '').toLowerCase();\n    const show = !q || txt.indexOf(q) !== -1;\n    item.style.display = show ? '' : 'none';\n    if (show) visible++;\n  });\n  if (empty) {\n    if (!items.length) {\n      empty.style.display = '';\n      empty.innerHTML = '<span class=\"ei\">🔬</span>No slides loaded.';\n    } else if (!visible) {\n      empty.style.display = '';\n      empty.innerHTML = '<span class=\"ei\">🔎</span>No matching slides.';\n    } else {\n      empty.style.display = 'none';\n      empty.innerHTML = '<span class=\"ei\">🔬</span>No slides loaded.';\n    }\n  }\n  updateVisibleSlideSummary(visible, items.length);\n}\n\nfunction setupMetadataPanel() {\n  if (document.getElementById('meta-sec')) return;\n  const statsCell = document.getElementById('st-total');\n  const statsSec = statsCell ? statsCell.closest('.rs') : null;\n  if (!statsSec) return;\n\n  const sec = document.createElement('div');\n  sec.className = 'rs';\n  sec.id = 'meta-sec';\n\n  const head = document.createElement('div');\n  head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px';\n  const title = document.createElement('div');\n  title.className = 'sec';\n  title.style.margin = '0';\n  title.textContent = 'Slide Metadata';\n  const btn = document.createElement('button');\n  btn.className = 'ph-btn';\n  btn.title = 'Collapse metadata';\n  btn.textContent = '▾';\n  btn.addEventListener('click', function (e) {\n    e.stopPropagation();\n    togglePane('meta-panel', btn, 'monjoy_pane_meta');\n  });\n  head.appendChild(title);\n  head.appendChild(btn);\n\n  const panel = document.createElement('div');\n  panel.id = 'meta-panel';\n  panel.className = 'meta-empty';\n  panel.textContent = 'Load a slide first';\n\n  sec.appendChild(head);\n  sec.appendChild(panel);\n  statsSec.insertAdjacentElement('afterend', sec);\n  if (readUiPref('monjoy_pane_meta', '0') === '1') setPaneCollapsed('meta-panel', btn, true);\n}\n\nfunction formatDims(dims) {\n  return dims && dims.length >= 2 ? Number(dims[0]).toLocaleString() + ' × ' + Number(dims[1]).toLocaleString() : '—';\n}\n\nfunction formatMpp(info) {\n  if (info && info.mpp_x && info.mpp_y) return Number(info.mpp_x).toFixed(3) + ' / ' + Number(info.mpp_y).toFixed(3) + ' µm';\n  if (info && info.mpp_x) return Number(info.mpp_x).toFixed(3) + ' µm';\n  return '—';\n}\n\nfunction metaRow(label, value) {\n  return '<div class=\"meta-key\">' + escHtml(label) + '</div><div class=\"meta-val\">' + escHtml(value || '—') + '</div>';\n}\n\nfunction copyCurrentMetadata() {\n  if (!currentSlide) {\n    toast('Load a slide first', 'warning');\n    return;\n  }\n  const txt = JSON.stringify(currentSlide, null, 2);\n  if (navigator.clipboard && navigator.clipboard.writeText) {\n    navigator.clipboard.writeText(txt).then(function () {\n      toast('Metadata copied', 'success');\n    }).catch(function () {\n      toast('Unable to copy metadata', 'warning');\n    });\n  } else {\n    toast('Clipboard not available', 'warning');\n  }\n}\n\nfunction renderMetadataPanel(info) {\n  const panel = document.getElementById('meta-panel');\n  if (!panel) return;\n  if (!info) {\n    panel.classList.add('meta-empty');\n    panel.innerHTML = 'Load a slide first';\n    return;\n  }\n  panel.classList.remove('meta-empty');\n\n  const levelDims = Array.isArray(info.level_dimensions)\n    ? info.level_dimensions.slice(0, 4).map(function (d, i) { return 'L' + i + ': ' + formatDims(d); }).join(' · ')\n    : '—';\n  const downsamples = Array.isArray(info.level_downsamples)\n    ? info.level_downsamples.slice(0, 6).map(function (d, i) { return 'L' + i + ': ×' + Number(d).toFixed(1); }).join(' · ')\n    : '—';\n  const pathOrUrl = info.real_path || info.remote_url || info.path || '—';\n  const rows = [\n    metaRow('Name', info.name || info.id),\n    metaRow('ID', info.id || '—'),\n    metaRow('Source', info.source || (info.is_remote ? 'stream' : 'local')),\n    metaRow('Vendor', info.vendor || (info.is_remote ? 'remote' : '—')),\n    metaRow('Dimensions', formatDims(info.dimensions) + ' px'),\n    metaRow('Levels', info.level_count != null ? String(info.level_count) : '—'),\n    metaRow('MPP', formatMpp(info)),\n    metaRow('Objective', info.objective_power ? String(info.objective_power) + '×' : '—'),\n    metaRow('Annotations', info.annotation_count != null ? String(info.annotation_count) : String(annotations.length || 0)),\n    metaRow('File size', info.file_size_mb ? String(info.file_size_mb) + ' MB' : '—'),\n    metaRow('Level sizes', levelDims),\n    metaRow('Downsamples', downsamples),\n    metaRow('Path / URL', pathOrUrl)\n  ];\n\n  panel.innerHTML = [\n    '<div class=\"meta-actions\"><button class=\"filter-all\" type=\"button\" onclick=\"copyCurrentMetadata()\">Copy JSON</button></div>',\n    '<div class=\"meta-grid\">', rows.join(''), '</div>',\n    '<div class=\"meta-note\">Metadata updates when you switch slides. Validation and patch settings below still apply to the currently open slide.</div>',\n    '<details class=\"meta-raw\"><summary>Raw metadata JSON</summary><pre class=\"meta-pre\">', escHtml(JSON.stringify(info, null, 2)), '</pre></details>'\n  ].join('');\n}\n\nfunction setupExtractionBatchUI() {\n  const extBtn = document.getElementById('ext-btn');\n  const extSec = extBtn ? extBtn.closest('.rs') : null;\n  if (!extSec || document.getElementById('batch-slide-row')) return;\n  const firstFormRow = extSec.querySelector('.form-row');\n  const row = document.createElement('div');\n  row.className = 'form-row';\n  row.id = 'batch-slide-row';\n  row.innerHTML = [\n    '<div style=\"display:flex;justify-content:space-between;align-items:center\">',\n    '  <div class=\"form-lbl\">Slides to Extract</div>',\n    '  <span id=\"batch-slide-count\" style=\"font-size:9px;color:var(--text-muted);font-family:var(--mono)\">0 selected</span>',\n    '</div>',\n    '<div class=\"ext-slide-actions\">',\n    '  <button class=\"filter-all\" type=\"button\" onclick=\"selectCurrentSlideForBatch()\">Current</button>',\n    '  <button class=\"filter-all\" type=\"button\" onclick=\"selectAnnotatedSlidesForBatch()\">Annotated</button>',\n    '  <button class=\"filter-all\" type=\"button\" onclick=\"selectAllSlidesForBatch()\">All</button>',\n    '  <button class=\"filter-all\" type=\"button\" onclick=\"clearBatchSelection()\">Clear</button>',\n    '</div>',\n    '<div id=\"batch-slide-preview\"></div>',\n    '<div class=\"hint\">Use the small button on each slide card to include multiple slides in one extraction batch. Each selected slide is saved into its own subfolder inside the output folder.</div>',\n    '<div class=\"hint\">Pre-extraction validation below applies to the currently open slide.</div>'\n  ].join('');\n  extSec.insertBefore(row, firstFormRow || extBtn);\n  refreshBatchSelectionUI();\n}\n\nfunction updateCurrentSlideCard() {\n  if (!currentSlide || !currentSlide.id) return;\n  for (let i = 0; i < _slidesCache.length; i++) {\n    if (_slidesCache[i].id === currentSlide.id) {\n      _slidesCache[i].annotation_count = annotations.length;\n      break;\n    }\n  }\n  const items = document.querySelectorAll('#slide-list .slide-item');\n  items.forEach(function (item) {\n    if (item.dataset.id !== currentSlide.id) return;\n    const slide = getSlideInfoById(currentSlide.id) || currentSlide;\n    const nameEl = item.querySelector('.slide-name');\n    if (nameEl) {\n      nameEl.innerHTML = escHtml(slide.name || slide.id) + (annotations.length > 0 ? ' <span class=\"slide-badge\">' + annotations.length + '</span>' : '');\n    }\n  });\n}\n\nconst _origRenderSlides = renderSlides;\nrenderSlides = function (slides) {\n  _slidesCache = Array.isArray(slides) ? slides : [];\n  _origRenderSlides(_slidesCache);\n  enhanceSlideCards();\n  applySlideSearch();\n  refreshBatchSelectionUI();\n};\n\nloadSlides = async function () {\n  try {\n    const slides = await (await fetch('/api/slides')).json();\n    const list = Array.isArray(slides) ? slides : [];\n    renderSlides(list);\n    const stat = document.getElementById('st-slides');\n    if (stat) stat.textContent = list.length;\n    return list;\n  } catch (e) {\n    console.error(e);\n    return [];\n  }\n};\n\nconst _origOpenSlide = openSlide;\nopenSlide = async function (slideId) {\n  await _origOpenSlide(slideId);\n  if (currentSlide && currentSlide.id === slideId) {\n    if (!_extractSlideIds.size) _extractSlideIds.add(slideId);\n    renderMetadataPanel(currentSlide);\n    refreshBatchSelectionUI();\n  }\n};\n\nconst _origUpdateStats = updateStats;\nupdateStats = function () {\n  _origUpdateStats();\n  if (currentSlide) {\n    currentSlide.annotation_count = annotations.length;\n    updateCurrentSlideCard();\n    renderMetadataPanel(currentSlide);\n    refreshBatchSelectionUI();\n  }\n};\n\nfunction renderSingleExtractionResult(d, outName) {\n  const res = document.getElementById('ext-result');\n  const downloadSubdir = d.output_subdir || outName;\n  const encName = encodeURIComponent(downloadSubdir);\n  const safeJsSubdir = JSON.stringify(downloadSubdir);\n  const warn = d.skipped > 0\n    ? '<div style=\"color:var(--warning);margin-top:3px\">⚠ ' + d.skipped + ' annotation(s) produced no saved patch at the chosen settings.</div>'\n    : '';\n  const fmt = String(d.image_format || 'jpg').toUpperCase();\n  res.style.display = 'block';\n  res.innerHTML = [\n    '<div style=\"color:var(--success);font-weight:600;margin-bottom:4px\">✓ ', d.extracted, ' ', fmt, ' patches extracted</div>',\n    '<div style=\"font-size:8.5px;color:var(--text-muted);margin-bottom:4px;word-break:break-all;padding:3px 6px;background:var(--panel-hi);border-radius:3px;font-family:var(--mono)\">', escHtml(d.output_dir), '</div>',\n    '<div style=\"font-size:8px;color:var(--text-muted);margin-bottom:5px;line-height:1.5\">🖼 Format: <span style=\"font-family:var(--mono);color:var(--text-dim)\">JPG</span> &nbsp;·&nbsp; 📄 Naming: <span style=\"font-family:var(--mono);color:var(--text-dim)\">&lt;slide13&gt;_x&lt;X&gt;_y&lt;Y&gt;_s&lt;size&gt;_L&lt;lvl&gt;_&lt;class&gt;.jpg</span></div>',\n    warn,\n    '<div style=\"display:flex;gap:4px;margin-top:5px;flex-direction:column\">',\n    '  <div style=\"display:flex;gap:4px\">',\n    '    <a href=\"/api/patches/zip/', encName, '\" download=\"', escHtml(downloadSubdir), '_patches.zip\" style=\"flex:1;padding:6px 8px;border-radius:var(--radius);background:var(--cyan-dim);color:var(--cyan);border:1px solid rgba(14,165,233,.3);font-size:10px;font-weight:700;text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;gap:3px\" onclick=\"toast(\\'Preparing ZIP…\\',\\'info\\')\">⬇ Download ZIP</a>',\n    '    <button onclick=\"revealPatches(', safeJsSubdir, ')\" style=\"padding:6px 8px;border-radius:var(--radius);background:var(--panel-s);color:var(--text-dim);border:1px solid var(--border);font-size:10px;font-weight:600\" title=\"Open folder in Finder (local only)\">📂 Folder</button>',\n    '  </div>',\n    '  <a href=\"/api/patches/manifest/', encName, '\" style=\"width:100%;padding:5px 8px;border-radius:var(--radius);background:var(--panel-s);color:var(--violet);border:1px solid rgba(167,139,250,.25);font-size:10px;font-weight:700;text-decoration:none;text-align:center;display:block\" onclick=\"toast(\\'Downloading annotation manifest JSON…\\',\\'info\\')\">📋 Download Annotation Manifest JSON</a>',\n    '</div>'\n  ].join('');\n}\n\nfunction renderBatchExtractionResult(d, outName) {\n  const res = document.getElementById('ext-result');\n  const downloadSubdir = d.output_subdir || outName;\n  const encName = encodeURIComponent(downloadSubdir);\n  const safeJsSubdir = JSON.stringify(downloadSubdir);\n  const rows = [];\n  const results = Array.isArray(d.results) ? d.results : [];\n  results.slice(0, 8).forEach(function (r) {\n    const stat = r.error ? ('✗ ' + escHtml(r.error)) : ((r.extracted || 0) + ' JPG');\n    rows.push('<div class=\"batch-res-row\"><span class=\"name\" title=\"' + escHtml(r.slide_name || r.slide_id) + '\">' + escHtml(r.slide_name || r.slide_id) + '</span><span class=\"stat\">' + stat + '</span></div>');\n  });\n  if (results.length > 8) rows.push('<div class=\"batch-res-row\"><span class=\"name\">Additional slides</span><span class=\"stat\">+' + (results.length - 8) + ' more</span></div>');\n  const errorNote = d.errors && d.errors.length\n    ? '<div style=\"color:var(--warning);margin-top:4px\">⚠ Some slides reported issues. Review the batch manifest for details.</div>'\n    : '';\n  res.style.display = 'block';\n  res.innerHTML = [\n    '<div style=\"color:var(--success);font-weight:600;margin-bottom:4px\">✓ ', d.extracted, ' JPG patches extracted from ', d.slides_processed || results.length, ' slide(s)</div>',\n    '<div style=\"font-size:8.5px;color:var(--text-muted);margin-bottom:4px;word-break:break-all;padding:3px 6px;background:var(--panel-hi);border-radius:3px;font-family:var(--mono)\">', escHtml(d.output_dir), '</div>',\n    '<div style=\"font-size:8px;color:var(--text-muted);line-height:1.5\">Each selected slide is saved inside its own subfolder within the batch output folder. Patch files are exported as JPG.</div>',\n    errorNote,\n    rows.length ? '<div class=\"batch-res-box\">' + rows.join('') + '</div>' : '',\n    '<div style=\"display:flex;gap:4px;margin-top:6px;flex-direction:column\">',\n    '  <div style=\"display:flex;gap:4px\">',\n    '    <a href=\"/api/patches/zip/', encName, '\" download=\"', escHtml(downloadSubdir), '_patches.zip\" style=\"flex:1;padding:6px 8px;border-radius:var(--radius);background:var(--cyan-dim);color:var(--cyan);border:1px solid rgba(14,165,233,.3);font-size:10px;font-weight:700;text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;gap:3px\" onclick=\"toast(\\'Preparing batch ZIP…\\',\\'info\\')\">⬇ Download ZIP</a>',\n    '    <button onclick=\"revealPatches(', safeJsSubdir, ')\" style=\"padding:6px 8px;border-radius:var(--radius);background:var(--panel-s);color:var(--text-dim);border:1px solid var(--border);font-size:10px;font-weight:600\">📂 Folder</button>',\n    '  </div>',\n    '  <a href=\"/api/patches/manifest/', encName, '\" style=\"width:100%;padding:5px 8px;border-radius:var(--radius);background:var(--panel-s);color:var(--violet);border:1px solid rgba(167,139,250,.25);font-size:10px;font-weight:700;text-decoration:none;text-align:center;display:block\" onclick=\"toast(\\'Downloading batch manifest JSON…\\',\\'info\\')\">📋 Download Batch Manifest JSON</a>',\n    '</div>'\n  ].join('');\n}\n\nstartExtraction = async function () {\n  if (!currentSlide) { toast('No slide loaded', 'warning'); return; }\n  const slideIds = getSelectedSlideIds(true);\n  if (!slideIds.length) { toast('Select at least one slide to extract', 'warning'); return; }\n\n  const labels = getSelectedLabels();\n  const outName = (document.getElementById('ext-out').value || 'patches').trim() || 'patches';\n  const btn = document.getElementById('ext-btn');\n  const res = document.getElementById('ext-result');\n  const payload = {\n    slide_ids: slideIds,\n    patch_size: parseInt(document.getElementById('ext-size').value, 10) || 256,\n    level: parseInt(document.getElementById('ext-level').value, 10) || 0,\n    out_subdir: outName,\n    overlap_threshold: parseFloat(document.getElementById('ext-overlap').value) || 0.3,\n    label_filter: labels.length ? labels : null\n  };\n\n  btn.disabled = true;\n  btn.textContent = '⏳ Extracting…';\n  res.style.display = 'none';\n\n  try {\n    const useSingleRoute = slideIds.length === 1 && slideIds[0] === currentSlide.id;\n    const endpoint = useSingleRoute\n      ? '/api/slides/' + encodeURIComponent(currentSlide.id) + '/extract'\n      : '/api/slides/extract-batch';\n    const d = await (await fetch(endpoint, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify(payload)\n    })).json();\n\n    if (d.error) {\n      res.style.cssText = 'display:block;color:var(--danger)';\n      res.textContent = '✗ ' + d.error;\n      toast(d.error, 'error');\n    } else if (useSingleRoute) {\n      renderSingleExtractionResult(d, outName);\n      toast('✓ ' + d.extracted + ' JPG patches ready', 'success');\n    } else {\n      renderBatchExtractionResult(d, outName);\n      toast('✓ Batch extraction finished — ' + d.extracted + ' JPG patches', 'success');\n    }\n  } catch (e) {\n    toast('Extraction failed: ' + e.message, 'error');\n  }\n\n  btn.disabled = false;\n  btn.textContent = '⬇ Extract Patches';\n};\n\ndocument.addEventListener('keydown', function (e) {\n  if (e.target && e.target.tagName === 'SELECT') e.stopPropagation();\n}, true);\n\ndocument.addEventListener('DOMContentLoaded', function () {\n  injectEnhancementStyles();\n  setupThemeControls();\n  setupLeftSidebarUX();\n  setupMetadataPanel();\n  setupExtractionBatchUI();\n  renderMetadataPanel(currentSlide || null);\n  refreshBatchSelectionUI();\n  applySlideSearch();\n});\n\n\n</script>\n</body>\n</html>";



// ── /api/paths ────────────────────────────────────────────────────────────────
app.get('/api/paths', (req, res) => {
  res.json({ patches_dir: PATCHES_DIR, annotations_dir: ANNOTATIONS_DIR,
             cache_dir: CACHE_DIR, base_dir: BASE_DIR, is_headless: isHeadless() });
});

// ── Upload WSI via browser (works on cloud) ───────────────────────────────────
app.post('/api/slides/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const fname = req.file.originalname;
  const ext   = path.extname(fname).toLowerCase();
  if (!SUPPORTED_EXT.has(ext))
    return res.status(400).json({ error: `Unsupported format: ${ext}` });
  const dest = path.join(CACHE_DIR, fname);
  try {
    fs.writeFileSync(dest, req.file.buffer);
    const sid = pathToId(dest);
    const reg = loadRegistry();
    if (!reg[sid]) { reg[sid] = { name: fname, path: dest, source: 'uploaded' }; saveRegistry(reg); }
    res.json({ id: sid, name: fname, path: dest,
               size_mb: Math.round(req.file.size/1048576*10)/10 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Download patches as ZIP ───────────────────────────────────────────────────
app.get('/api/patches/zip/:subdir', (req, res) => {
  const sub = sanitizeOutputSubdir(req.params.subdir);
  const dir = path.join(PATCHES_DIR, sub);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Folder not found: '+dir });
  const files = [];
  const walk = (d, pfx) => {
    for (const f of fs.readdirSync(d)) {
      const full=path.join(d,f), rel=pfx?pfx+'/'+f:f;
      if (fs.statSync(full).isDirectory()) walk(full,rel); else files.push({full,rel});
    }
  };
  walk(dir, sub);
  if (!files.length) return res.status(404).json({ error: 'No files found' });
  res.set('Content-Type','application/zip');
  res.set('Content-Disposition',`attachment; filename="${sub}_patches.zip"`);
  const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n,0);return b;};
  const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n,0);return b;};
  const chunks=[],cd=[];
  let off=0;
  for(const{full,rel}of files){
    const data=fs.readFileSync(full),name=Buffer.from(rel,'utf8');
    let c=~0;
    for(let i=0;i<data.length;i++){c^=data[i];for(let j=0;j<8;j++)c=(c>>>1)^(0xEDB88320&-(c&1));}
    const crc=(~c)>>>0;
    const lh=Buffer.concat([Buffer.from([0x50,0x4B,0x03,0x04]),u16(20),u16(0x800),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name]);
    cd.push({off,name,crc,size:data.length});
    chunks.push(lh,data);off+=lh.length+data.length;
  }
  const cdStart=off;
  for(const e of cd){
    const c2=Buffer.concat([Buffer.from([0x50,0x4B,0x01,0x02]),u16(20),u16(20),u16(0x800),u16(0),u16(0),u16(0),u32(e.crc),u32(e.size),u32(e.size),u16(e.name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(e.off),e.name]);
    chunks.push(c2);off+=c2.length;
  }
  chunks.push(Buffer.concat([Buffer.from([0x50,0x4B,0x05,0x06]),u16(0),u16(0),u16(cd.length),u16(cd.length),u32(off-cdStart),u32(cdStart),u16(0)]));
  res.send(Buffer.concat(chunks));
});

// ── Reveal patch folder in OS file manager ────────────────────────────────────
app.get('/api/patches/reveal/:subdir', (req, res) => {
  if (isHeadless()) return res.json({ error: 'Not available on server deployment' });
  const sub=sanitizeOutputSubdir(req.params.subdir);
  const dir=path.join(PATCHES_DIR,sub);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found: '+dir });
  try {
    const cmd=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open';
    spawnSync(cmd,[dir],{detached:true});
    res.json({status:'opened',path:dir});
  } catch(e){res.json({error:e.message});}
});

// ── Download patch manifest JSON ──────────────────────────────────────────────
app.get('/api/patches/manifest/:subdir', (req, res) => {
  const sub = sanitizeOutputSubdir(req.params.subdir);
  const dir = path.join(PATCHES_DIR, sub);
  let mf = null;
  try {
    const files = fs.readdirSync(dir);
    mf = files.find(f => f === 'batch_manifest.json')
      || files.find(f => f.endsWith('_batch_manifest.json'))
      || files.find(f => f.endsWith('_manifest.json'));
  } catch (e) {
    return res.status(404).json({ error: 'Folder not found' });
  }
  if (!mf) return res.status(404).json({ error: 'No manifest found — re-extract patches to generate one' });
  res.set('Content-Disposition', 'attachment; filename="' + mf + '"');
  res.sendFile(path.join(dir, mf));
});

// ── Server startup ────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '7860', 10);
const HOST = process.env.HOST || '0.0.0.0';
const args = process.argv.slice(2);
const DEBUG    = args.includes('--debug');
const NO_BROWSER = args.includes('--no-browser');

const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log('='.repeat(62));
  console.log('  Monjoy.AI — WSI Annotation Platform (Node.js)');
  console.log('='.repeat(62));
  console.log(`  openslide: ${OSL ? '✓' : '✗  brew install openslide'}`);
  console.log(`  sharp:     ${sharp ? '✓' : '✗  npm install sharp'}`);
  console.log(`  cache:     ${CACHE_DIR}  (cloud + TCGA downloads)`);
  console.log(`  patches:   ${PATCHES_DIR}`);
  console.log(`  annotations: ${ANNOTATIONS_DIR}`);
  console.log(`  → ${url}`);
  console.log('='.repeat(62));
  console.log('  NOTE: Slides are NEVER copied into this folder.');
  console.log('        Register by local path, cloud link, or TCGA download.');
  console.log('        Annotations are JSON only — WSI files never modified.');
  console.log('='.repeat(62));

  if (!NO_BROWSER) {
    setTimeout(() => {
      const open = process.platform === 'darwin' ? 'open'
                 : process.platform === 'win32'  ? 'start'
                 : 'xdg-open';
      require('child_process').spawn(open, [url], { detached: true, stdio: 'ignore' }).unref();
    }, 1500);
  }
});
