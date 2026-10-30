"""Vision–language zero-shot: CONCH, MUSK, KEEP (via TRIDENT encoders) and PLIP, QuiltNet.

Each adapter returns L2-normalised image and text embeddings in the shared space.
Loading/encoding calls follow each model's own README (see docs/models.json notes)."""
from __future__ import annotations

from typing import List, Tuple

import numpy as np

from .common import (MockImageEncoder, autocast, batched, l2n, load_tiles, mock_text, prepare_slide,
                     read_patches, save_thumbs, slide_features, softmax)

DEFAULT_SCALE = 100.0  # used only where a model does not document its logit scale


def parse_classes(raw) -> Tuple[List[str], List[List[str]]]:
    """Accepts [{"name": .., "prompts": [..]}] or text lines 'name: prompt | prompt'."""
    names, prompts = [], []
    if isinstance(raw, str):
        raw = [ln for ln in raw.splitlines() if ln.strip()]
        items = []
        for ln in raw:
            name, _, rest = ln.partition(":")
            ps = [p.strip() for p in rest.split("|") if p.strip()] or [name.strip()]
            items.append({"name": name.strip(), "prompts": ps})
        raw = items
    for c in raw or []:
        names.append(c["name"])
        prompts.append(list(c.get("prompts") or [c["name"]]))
    if len(names) < 2:
        raise ValueError("Zero-shot needs at least two classes.")
    return names, prompts


class Adapter:
    scale = DEFAULT_SCALE
    scale_documented = False

    def __init__(self, ctx):
        self.ctx = ctx

    def class_embeddings(self, prompts: List[List[str]]) -> np.ndarray:
        """Prompt ensembling: mean of normalised prompt embeddings per class, renormalised."""
        flat = [p for ps in prompts for p in ps]
        t = l2n(self.encode_text(flat))
        out, i = [], 0
        for ps in prompts:
            out.append(l2n(t[i:i + len(ps)].mean(0)))
            i += len(ps)
        return np.stack(out)


class MockAdapter(Adapter):
    def __init__(self, ctx, dim=512):
        super().__init__(ctx)
        self.dim = dim
        self.img = MockImageEncoder(ctx.model["id"] + ":vl", dim)

    def encode_images(self, imgs):
        return l2n(self.img(imgs))

    def encode_text(self, prompts):
        return mock_text(self.ctx.model["id"], prompts, self.dim)

    def trident_encoder(self):
        return None


class TridentVL(Adapter):
    """Shared base for VL models that TRIDENT can load with a projection head."""
    trident_name = ""
    build_kw: dict = {}

    def __init__(self, ctx):
        super().__init__(ctx)
        from trident.patch_encoder_models import encoder_factory
        ctx.progress(0.02, f"Loading {self.trident_name} (projected, normalised) via TRIDENT")
        self.enc = encoder_factory(self.trident_name, **self.build_kw).eval().to(ctx.device)

    def encode_images(self, imgs):
        import torch
        out = []
        for _, chunk in batched(imgs, 64):
            x = torch.stack([self.enc.eval_transforms(im) for im in chunk]).to(self.ctx.device)
            with torch.inference_mode(), autocast(self.ctx, self.enc.precision):
                out.append(self.enc(x).float().cpu().numpy())
        return l2n(np.concatenate(out))

    def trident_encoder(self):
        return self.enc


class ConchAdapter(TridentVL):
    trident_name = "conch_v1"
    build_kw = {"with_proj": True, "normalize": True}
    scale_documented = True

    def __init__(self, ctx):
        super().__init__(ctx)
        self.scale = float(self.enc.model.logit_scale.exp().item())

    def encode_text(self, prompts):
        import torch
        from conch.open_clip_custom import get_tokenizer, tokenize
        toks = tokenize(texts=prompts, tokenizer=get_tokenizer()).to(self.ctx.device)
        with torch.inference_mode():
            return self.enc.model.encode_text(toks).float().cpu().numpy()


class MuskAdapter(TridentVL):
    trident_name = "musk"
    build_kw = {"with_proj": True, "out_norm": True, "inference_aug": False}

    def encode_text(self, prompts):
        import os
        import musk
        import torch
        from musk import utils
        from transformers import XLMRobertaTokenizer
        tok = XLMRobertaTokenizer(os.path.join(os.path.dirname(musk.__file__), "models", "tokenizer.spm"))
        ids, pads = zip(*[utils.xlm_tokenizer(p, tok, max_len=100) for p in prompts])
        ids = torch.tensor(ids).to(self.ctx.device)
        pads = torch.tensor(pads).to(self.ctx.device)
        with torch.inference_mode(), autocast(self.ctx, self.enc.precision):
            t = self.enc.model(text_description=ids, padding_mask=pads, with_head=True, out_norm=True,
                               ms_aug=False, return_global=True)[1]
        return t.float().cpu().numpy()


class KeepAdapter(TridentVL):
    trident_name = "keep"

    def encode_text(self, prompts):
        import torch
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained("Astaxanthin/KEEP", trust_remote_code=True)
        t = tok(prompts, max_length=256, padding="max_length", truncation=True, return_tensors="pt").to(self.ctx.device)
        with torch.inference_mode():
            return self.enc.model.encode_text(t).float().cpu().numpy()


class _ImageModule:
    """nn.Module wrapper so TRIDENT's CustomInferenceEncoder can drive a CLIP image tower on slides."""

    @staticmethod
    def make(fn):
        import torch

        class M(torch.nn.Module):
            def __init__(self, inner):
                super().__init__()
                self.inner = inner

            def forward(self, x):
                return torch.nn.functional.normalize(fn(self.inner, x).float(), dim=-1)
        return M


class PlipAdapter(Adapter):
    scale_documented = True

    def __init__(self, ctx):
        super().__init__(ctx)
        from transformers import CLIPModel, CLIPProcessor
        ctx.progress(0.02, "Loading vinid/plip (transformers CLIPModel)")
        self.model = CLIPModel.from_pretrained("vinid/plip").eval().to(ctx.device)
        self.proc = CLIPProcessor.from_pretrained("vinid/plip")
        self.scale = float(self.model.logit_scale.exp().item())

    def _tf(self, im):
        return self.proc(images=im, return_tensors="pt")["pixel_values"][0]

    def encode_images(self, imgs):
        import torch
        out = []
        for _, chunk in batched(imgs, 64):
            x = torch.stack([self._tf(im) for im in chunk]).to(self.ctx.device)
            with torch.inference_mode():
                out.append(self.model.get_image_features(pixel_values=x).float().cpu().numpy())
        return l2n(np.concatenate(out))

    def encode_text(self, prompts):
        import torch
        t = self.proc(text=prompts, return_tensors="pt", padding=True, truncation=True).to(self.ctx.device)
        with torch.inference_mode():
            return self.model.get_text_features(input_ids=t["input_ids"], attention_mask=t["attention_mask"]).float().cpu().numpy()

    def trident_encoder(self):
        import torch
        from trident.patch_encoder_models import CustomInferenceEncoder
        M = _ImageModule.make(lambda m, x: m.get_image_features(pixel_values=x))
        return CustomInferenceEncoder("plip", M(self.model), self._tf, torch.float32)


class QuiltAdapter(Adapter):
    scale_documented = True
    HUB = "hf-hub:wisdomik/QuiltNet-B-32"

    def __init__(self, ctx):
        super().__init__(ctx)
        import open_clip
        ctx.progress(0.02, f"Loading {self.HUB} (open_clip)")
        self.model, self.preprocess = open_clip.create_model_from_pretrained(self.HUB)
        self.model = self.model.eval().to(ctx.device)
        self.tok = open_clip.get_tokenizer(self.HUB)
        self.scale = float(self.model.logit_scale.exp().item())

    def encode_images(self, imgs):
        import torch
        out = []
        for _, chunk in batched(imgs, 64):
            x = torch.stack([self.preprocess(im) for im in chunk]).to(self.ctx.device)
            with torch.inference_mode():
                out.append(self.model.encode_image(x).float().cpu().numpy())
        return l2n(np.concatenate(out))

    def encode_text(self, prompts):
        import torch
        with torch.inference_mode():
            return self.model.encode_text(self.tok(prompts).to(self.ctx.device)).float().cpu().numpy()

    def trident_encoder(self):
        import torch
        from trident.patch_encoder_models import CustomInferenceEncoder
        M = _ImageModule.make(lambda m, x: m.encode_image(x))
        return CustomInferenceEncoder("quiltnet_b32", M(self.model), self.preprocess, torch.float32)


ADAPTERS = {"conch": ConchAdapter, "musk": MuskAdapter, "keep": KeepAdapter, "plip": PlipAdapter, "quiltnet": QuiltAdapter}
_cache = {}


def get_adapter(ctx) -> Adapter:
    m = ctx.model
    if ctx.mock:
        return MockAdapter(ctx, int(m.get("embed_dim") or 512))
    key = (m["zeroshot_adapter"], ctx.device)
    if key not in _cache:  # keep one VL model warm between jobs
        _cache.clear()
        _cache[key] = ADAPTERS[m["zeroshot_adapter"]](ctx)
    ad = _cache[key]
    ad.ctx = ctx
    return ad


def _scale_note(ad) -> dict:
    if ad.scale_documented:
        return {"type": "note", "text": f"Probabilities = softmax(logit_scale × cosine), logit_scale = {ad.scale:.1f} from the model."}
    return {"type": "note", "tone": "warn",
            "text": f"This model does not document a logit scale; probabilities use softmax({ad.scale:.0f} × cosine). "
                    "Rankings are reliable; absolute probabilities are not calibrated."}


def run_zeroshot_tiles(ctx) -> dict:
    names_c, prompts = parse_classes(ctx.params.get("classes"))
    names, imgs = load_tiles(ctx.inputs["tiles"])
    ad = get_adapter(ctx)
    ctx.progress(0.1, f"Encoding {sum(map(len, prompts))} prompts for {len(names_c)} classes")
    T = ad.class_embeddings(prompts)
    ctx.progress(0.2, f"Encoding {len(imgs)} tiles")
    I = ad.encode_images(imgs)
    sims = I @ T.T
    P = softmax(ad.scale * sims)
    pred = P.argmax(1)
    thumbs = save_thumbs(ctx, names, imgs)
    import csv
    with open(ctx.out_path("zeroshot.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["tile", "predicted"] + [f"p_{c}" for c in names_c] + [f"cos_{c}" for c in names_c])
        for i, n in enumerate(names):
            w.writerow([n, names_c[pred[i]]] + [f"{v:.5f}" for v in P[i]] + [f"{v:.5f}" for v in sims[i]])
    ctx.register("zeroshot.csv", "Probabilities and cosine similarities per tile")
    counts = np.bincount(pred, minlength=len(names_c))
    return {"summary": [{"label": "Tiles", "value": len(imgs)}, {"label": "Classes", "value": len(names_c)},
                        {"label": "Most frequent prediction", "value": names_c[int(counts.argmax())]}],
            "panels": [
                {"type": "bars", "title": "Class probabilities", "labels": names_c, "rows": names,
                 "values": P.round(4).tolist(), "thumbs": thumbs, "percent": True},
                {"type": "matrix", "title": "Probability matrix (tiles × classes)", "rows": names, "cols": names_c,
                 "values": P.round(3).tolist(), "vmin": 0.0, "vmax": 1.0},
                {"type": "bars", "title": "Predicted class counts", "labels": names_c, "rows": ["Tiles"],
                 "values": [counts.tolist()], "categorical": True},
                _scale_note(ad)]}


def run_zeroshot_wsi(ctx) -> dict:
    m = ctx.model
    names_c, prompts = parse_classes(ctx.params.get("classes"))
    mag = int(ctx.params.get("mag", m["mag"]))
    ps = int(ctx.params.get("patch_size", m["patch_size"]))
    sp = prepare_slide(ctx, mag, ps, max_patches=int(ctx.params.get("max_patches", 0)) or None)
    ad = get_adapter(ctx)
    T = ad.class_embeddings(prompts)
    if ctx.mock:
        feats = np.concatenate([ad.encode_images(read_patches(sp, ch, ps)) for _, ch in batched(list(range(len(sp.coords))), 64)])
    else:
        feats, _ = slide_features(ctx, sp, ad.trident_encoder(), m["id"] + "_proj", 0, ps)
        feats = l2n(feats)
    ctx.progress(0.88, "Scoring patches against prompts")
    P = softmax(ad.scale * (feats @ T.T))
    pred = P.argmax(1)
    topk = max(1, int(round(len(P) * float(ctx.params.get("topk_frac", 0.05)))))
    slide_top = np.sort(P, axis=0)[-topk:].mean(0)
    slide_mean = P.mean(0)
    np.savetxt(ctx.out_path("patch_probabilities.csv"), np.column_stack([sp.coords, P]), delimiter=",",
               header="x,y," + ",".join(names_c), comments="", fmt="%.5g")
    ctx.register("patch_probabilities.csv", "Per-patch class probabilities with level-0 coordinates")
    chans = [{"name": "Predicted class", "kind": "categorical", "labels": names_c}] + \
            [{"name": f"P({c})", "kind": "continuous", "fixed": [0, 1]} for c in names_c]
    vals = np.column_stack([pred, P])
    return {"summary": [{"label": "Slide", "value": sp.name}, {"label": "Patches", "value": int(len(P))},
                        {"label": "Top class (top-k mean)", "value": names_c[int(slide_top.argmax())]}],
            "panels": [ctx.spatial_panel("zs", "Zero-shot map", sp.coords, sp.patch0, vals, chans, sp.thumb, sp.scale),
                       {"type": "bars", "title": "Slide-level scores", "labels": names_c,
                        "rows": [f"Mean of top {topk} patches", "Mean of all patches"],
                        "values": [slide_top.round(4).tolist(), slide_mean.round(4).tolist()], "percent": True},
                       _scale_note(ad)]}
