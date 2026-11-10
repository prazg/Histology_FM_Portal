"""Shared helpers: tiles, slides (TRIDENT or mock), maths, images."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # mock-mode slides can be large flat images

# ── tiles ─────────────────────────────────────────────────────────────────────

def load_tiles(paths: Sequence[str]) -> Tuple[List[str], List[Image.Image]]:
    names, imgs = [], []
    for p in paths:
        names.append(Path(p).name.split("_", 1)[-1])
        imgs.append(Image.open(p).convert("RGB"))
    return names, imgs


def batched(seq, n):
    for i in range(0, len(seq), n):
        yield i, seq[i:i + n]


def save_thumbs(ctx, names, imgs, size=160) -> List[str]:
    out = []
    for i, im in enumerate(imgs):
        t = im.copy()
        t.thumbnail((size, size))
        fn = f"tile_{i:04d}.jpg"
        t.save(ctx.out_path(fn), quality=85)
        out.append(fn)
    return out

# ── maths ─────────────────────────────────────────────────────────────────────

def l2n(x: np.ndarray) -> np.ndarray:
    return x / (np.linalg.norm(x, axis=-1, keepdims=True) + 1e-8)


def softmax(z: np.ndarray, axis=-1) -> np.ndarray:
    z = z - z.max(axis=axis, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=axis, keepdims=True)


def pca(x: np.ndarray, k: int = 3) -> Tuple[np.ndarray, np.ndarray]:
    """Returns (scores N×k, explained variance ratio k)."""
    x = np.asarray(x, dtype=np.float64)
    xc = x - x.mean(0, keepdims=True)
    if len(x) < 2:
        return np.zeros((len(x), k)), np.zeros(k)
    u, s, _ = np.linalg.svd(xc, full_matrices=False)
    k_eff = min(k, s.size)
    scores = np.zeros((len(x), k))
    scores[:, :k_eff] = u[:, :k_eff] * s[:k_eff]
    var = s ** 2
    ratio = np.zeros(k)
    ratio[:k_eff] = var[:k_eff] / var.sum() if var.sum() > 0 else 0
    return scores, ratio


def kmeans(x: np.ndarray, k: int, seed: int = 0, iters: int = 60) -> np.ndarray:
    """k-means++ on L2-normalised features (cosine geometry). Returns labels."""
    x = l2n(np.asarray(x, dtype=np.float64))
    n = len(x)
    k = max(1, min(k, n))
    rng = np.random.default_rng(seed)
    centres = [x[rng.integers(n)]]
    for _ in range(1, k):
        d = np.min(((x[:, None, :] - np.array(centres)[None]) ** 2).sum(-1), axis=1) if n <= 20000 else \
            np.min(np.stack([((x - c) ** 2).sum(-1) for c in centres], 1), axis=1)
        p = d / d.sum() if d.sum() > 0 else None
        centres.append(x[rng.choice(n, p=p)])
    c = np.array(centres)
    labels = np.zeros(n, dtype=int)
    for _ in range(iters):
        sims = x @ c.T
        new = sims.argmax(1)
        if np.array_equal(new, labels) and _ > 0:
            break
        labels = new
        for j in range(k):
            m = x[labels == j]
            c[j] = l2n(m.mean(0)) if len(m) else x[rng.integers(n)]
    return labels


def unit_rgb(scores: np.ndarray) -> np.ndarray:
    """Robustly scale 3 PCA components to [0,1] for an RGB composite."""
    lo, hi = np.percentile(scores, 2, axis=0), np.percentile(scores, 98, axis=0)
    return np.clip((scores - lo) / np.where(hi - lo > 0, hi - lo, 1), 0, 1)

# ── images ────────────────────────────────────────────────────────────────────

_ANCHORS = np.array([  # perceptually ordered dark→bright, close to "inferno"
    [0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]
], dtype=np.float64)
LUT = np.stack([np.interp(np.linspace(0, 1, 256), np.linspace(0, 1, len(_ANCHORS)), _ANCHORS[:, c]) for c in range(3)], 1).astype(np.uint8)


def to_png(arr: np.ndarray, path: Path, vmin: float = 0.0, vmax: float = 1.0, size: Optional[int] = 256) -> None:
    a = np.clip((np.asarray(arr, dtype=np.float32) - vmin) / max(vmax - vmin, 1e-8), 0, 1)
    im = Image.fromarray(LUT[(a * 255).astype(np.uint8)])
    if size:
        im = im.resize((size, size), Image.BILINEAR)
    im.save(path)

# ── mock encoders (wiring tests only — NOT model output) ──────────────────────

def _seed(s: str) -> int:
    return int(hashlib.sha1(s.encode()).hexdigest()[:8], 16)


class MockImageEncoder:
    """Deterministic image → R^dim: 8×8 colour thumbnail through a fixed random projection."""

    def __init__(self, key: str, dim: int):
        rng = np.random.default_rng(_seed(key))
        self.dim = dim
        self.w = rng.standard_normal((8 * 8 * 3 + 3, dim)) / 14.0

    def __call__(self, imgs: Sequence[Image.Image]) -> np.ndarray:
        feats = []
        for im in imgs:
            a = np.asarray(im.convert("RGB").resize((8, 8), Image.BILINEAR), dtype=np.float32) / 255.0
            hsv = np.asarray(im.convert("HSV").resize((1, 1)), dtype=np.float32).ravel() / 255.0
            feats.append(np.concatenate([a.ravel() - 0.5, hsv]))
        return np.tanh(np.array(feats) @ self.w).astype(np.float32)


def mock_text(key: str, prompts: Sequence[str], dim: int) -> np.ndarray:
    return np.stack([np.random.default_rng(_seed(key + p)).standard_normal(dim) for p in prompts]).astype(np.float32)

# ── slides ────────────────────────────────────────────────────────────────────

@dataclass
class SlidePrep:
    name: str
    coords: np.ndarray          # N×2 level-0 top-left (x, y)
    patch0: float               # patch side at level 0, px
    thumb: str                  # file name in out/
    scale: float                # thumb px per level-0 px
    coords_path: Optional[str]  # TRIDENT coords h5 (real mode)
    slide: object               # TRIDENT WSI or MockSlide
    mpp: Optional[float]
    contours: Optional[str] = None   # contour overlay jpg in out/
    geojson: Optional[str] = None


class MockSlide:
    """A plain image treated as a slide (mock mode). mpp defaults to 0.5 (20x)."""

    def __init__(self, path: str, mpp: float = 0.5):
        self.img = Image.open(path).convert("RGB")
        self.width, self.height = self.img.size
        self.mpp = mpp
        self.mag = int(round(10.0 / mpp))
        self.name = Path(path).stem

    def read_region(self, loc, level, size, read_as="pil"):
        x, y = loc
        return self.img.crop((x, y, x + size[0], y + size[1]))

    def get_thumbnail(self, size):
        t = self.img.copy()
        t.thumbnail(size)
        return t

    def tissue_mask(self) -> Tuple[np.ndarray, float]:
        t = self.get_thumbnail((1024, 1024))
        hsv = np.asarray(t.convert("HSV"), dtype=np.float32)
        return (hsv[..., 1] > 30) & (hsv[..., 2] < 245), t.size[0] / self.width


def prepare_slide(ctx, mag: int, patch_size: int, segmenter: Optional[str] = None,
                  min_tissue: Optional[float] = None, max_patches: Optional[int] = None) -> SlidePrep:
    """Tissue segmentation + patch grid. Real mode delegates to TRIDENT's documented Python API."""
    wsi_path = ctx.inputs["wsi"]
    p = ctx.params
    segmenter = segmenter or p.get("segmenter", "hest")
    min_tissue = float(p.get("min_tissue", 0.5) if min_tissue is None else min_tissue)
    mpp = p.get("mpp")
    job_dir = str(ctx.scratch)

    if ctx.mock:
        slide = MockSlide(wsi_path, float(mpp or 0.5))
        ctx.progress(0.05, f"[mock] Reading image as a slide ({slide.width}×{slide.height}, {slide.mpp} µm/px)")
        mask, ms = slide.tissue_mask()
        p0 = patch_size * slide.mag / mag
        xs, ys = np.arange(0, slide.width - p0 + 1, p0), np.arange(0, slide.height - p0 + 1, p0)
        keep = []
        for y in ys:
            for x in xs:
                m = mask[int(y * ms):int((y + p0) * ms) + 1, int(x * ms):int((x + p0) * ms) + 1]
                if m.size and m.mean() >= min_tissue:
                    keep.append((int(x), int(y)))
        coords = np.array(keep, dtype=np.int64).reshape(-1, 2)
        coords_path = None
        contours = None
    else:
        from trident import load_wsi
        from trident.segmentation_models import segmentation_model_factory
        kw = {"mpp": float(mpp)} if mpp else {}
        slide = load_wsi(slide_path=wsi_path, lazy_init=False, **kw)
        ctx.progress(0.03, f"Loaded {Path(wsi_path).name}: {slide.width}×{slide.height}, mpp={slide.mpp}, mag={slide.mag}")
        ctx.progress(0.06, f"Segmenting tissue ({segmenter})")
        seg = segmentation_model_factory(segmenter)
        slide.segment_tissue(segmentation_model=seg, target_mag=10, job_dir=job_dir, device=ctx.device)
        ctx.progress(0.15, f"Patching at {mag}x, {patch_size} px, min tissue {min_tissue}")
        coords_path = slide.extract_tissue_coords(target_mag=mag, patch_size=patch_size, save_coords=job_dir,
                                                  overlap=0, min_tissue_proportion=min_tissue)
        import h5py
        with h5py.File(coords_path, "r") as f:
            coords = f["coords"][:]
            p0 = float(f["coords"].attrs["patch_size_level0"])
        c_src = Path(job_dir) / "contours" / f"{slide.name}.jpg"
        contours = None
        if c_src.exists():
            contours = "contours.jpg"
            ctx.out_path(contours).write_bytes(c_src.read_bytes())

    if max_patches and len(coords) > max_patches:
        step = int(np.ceil(len(coords) / max_patches))
        coords = coords[::step]
        ctx.log(f"Kept every {step}th patch ({len(coords)} of the tissue grid) — raise 'max patches' for full coverage.")
        if coords_path:  # rewrite a subsampled TRIDENT coords file so features match
            coords_path = _subsample_coords_h5(coords_path, step)

    thumb = slide.get_thumbnail((1600, 1600)) if ctx.mock else _trident_thumb(slide)
    thumb.save(ctx.out_path("thumb.jpg"), quality=88)
    ctx.log(f"{len(coords)} patches · level-0 patch {p0:.0f} px")
    if len(coords) == 0:
        raise RuntimeError("No tissue patches found. Lower 'min tissue', or check the slide's mpp.")
    return SlidePrep(slide.name, np.asarray(coords), p0, "thumb.jpg", thumb.size[0] / slide.width,
                     coords_path, slide, getattr(slide, "mpp", None), contours)


def _trident_thumb(slide) -> Image.Image:
    w, h = slide.width, slide.height
    s = 1600 / max(w, h)
    return slide.get_thumbnail((max(1, int(w * s)), max(1, int(h * s)))).convert("RGB")


def _subsample_coords_h5(path: str, step: int) -> str:
    import h5py
    out = str(Path(path).with_name(Path(path).stem + f"_every{step}.h5"))
    with h5py.File(path, "r") as src, h5py.File(out, "w") as dst:
        for k in src.keys():
            data = src[k][:]
            ds = dst.create_dataset(k, data=data[::step] if k == "coords" else data)
            for a, v in src[k].attrs.items():
                ds.attrs[a] = v
        for a, v in src.attrs.items():
            dst.attrs[a] = v
    return out


def read_patches(sp: SlidePrep, idx: Sequence[int], out_px: int) -> List[Image.Image]:
    """Read level-0 squares of side patch0 and resize to out_px (used by non-TRIDENT runners)."""
    s0 = int(round(sp.patch0))
    return [sp.slide.read_region((int(sp.coords[i][0]), int(sp.coords[i][1])), 0, (s0, s0)).convert("RGB")
            .resize((out_px, out_px), Image.BILINEAR) for i in idx]


def slide_features(ctx, sp: SlidePrep, encoder, enc_name: str, mock_dim: int, out_px: int,
                   mock_encoder: Optional[Callable] = None) -> Tuple[np.ndarray, Optional[str]]:
    """Patch features for every coordinate. Real mode: TRIDENT extract_patch_features → h5."""
    if ctx.mock:
        enc = mock_encoder or MockImageEncoder(enc_name, mock_dim)
        feats = []
        n = len(sp.coords)
        for i, chunk in batched(list(range(n)), 64):
            feats.append(enc(read_patches(sp, chunk, out_px)))
            ctx.progress(0.2 + 0.6 * (i + len(chunk)) / n)
        return np.concatenate(feats), None
    ctx.progress(0.25, f"Extracting {enc_name} features for {len(sp.coords)} patches")
    path = sp.slide.extract_patch_features(patch_encoder=encoder, coords_path=sp.coords_path,
                                           save_features=str(ctx.scratch / f"features_{enc_name}"),
                                           device=ctx.device, batch_limit=int(ctx.params.get("batch_size", 256)))
    import h5py
    with h5py.File(path, "r") as f:
        feats = f["features"][:]
        coords = f["coords"][:]
    if len(coords) != len(sp.coords) or not np.array_equal(coords, sp.coords):
        sp.coords = coords
    return np.asarray(feats, dtype=np.float32), path


def autocast(ctx, dtype):
    import contextlib
    import torch
    dev = ctx.device.split(":")[0]
    if dev != "cuda" or dtype == torch.float32:
        return contextlib.nullcontext()
    return torch.autocast(device_type="cuda", dtype=dtype)
