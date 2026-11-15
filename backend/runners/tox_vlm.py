"""Toxicologic & preclinical VLM decision QA runner (TissueDecision-9B — lighteternal/tissuedecision-9b).

Supports two execution modes in real inference:
1. OpenAI-compatible multimodal vLLM endpoint (`vllm_url` in config.yaml, e.g. `vllm serve lighteternal/tissuedecision-9b`).
2. Local Hugging Face `transformers` multimodal inference (`AutoProcessor` + `AutoModelForImageTextToText`).
"""
from __future__ import annotations

import base64
import csv
import io
import json
import urllib.request
from typing import List, Tuple

import numpy as np

from .common import MockImageEncoder, l2n, load_tiles, mock_text, save_thumbs, softmax
from .zeroshot import parse_classes

DEFAULT_TOX_CLASSES = (
    "no abnormality: normal rodent parenchyma within normal limits | unremarkable control tissue\n"
    "hepatocellular hypertrophy: centrilobular hepatocellular hypertrophy | enlarged eosinophilic hepatocytes\n"
    "single-cell necrosis: hepatocellular necrosis | pyknosis karyorrhexis acidophilic bodies\n"
    "vacuolation / steatosis: microvesicular or macrovesicular cytoplasmic vacuolation | lipid droplets\n"
    "inflammatory infiltrate: mixed mononuclear or neutrophilic portal and lobular inflammation\n"
    "bile duct hyperplasia: biliary hyperplasia and oval cell proliferation"
)

_vlm_cache = {}


def _build_prompt(organ: str, class_names: List[str], class_prompts: List[List[str]]) -> str:
    rubric = "\n".join(f"- {c}: {'; '.join(ps)}" for c, ps in zip(class_names, class_prompts))
    ctx_str = f" ({organ})" if organ else ""
    return (
        f"You are an expert preclinical toxicologic pathologist reviewing a rodent H&E tile{ctx_str}.\n"
        f"Evaluate the image against these candidate INHAND/toxicologic findings:\n{rubric}\n\n"
        "Respond strictly as compact JSON with keys:\n"
        '{"scores": {<finding_name>: <probability 0..1 summing to 1>}, "rationale": "<concise 1-sentence morphological evidence>"}'
    )


def _parse_vlm_json(text: str, class_names: List[str]) -> Tuple[np.ndarray, str]:
    raw = text.strip()
    s_idx, e_idx = raw.find("{"), raw.rfind("}")
    if 0 <= s_idx < e_idx:
        try:
            obj = json.loads(raw[s_idx:e_idx + 1])
            sc = obj.get("scores") or {}
            vals = np.array([float(sc.get(c, 0.0)) for c in class_names], dtype=np.float32)
            if vals.sum() > 0:
                vals = vals / vals.sum()
                return vals, str(obj.get("rationale") or raw[:180]).strip()
        except Exception:
            pass
    # Fallback keyword calibration if free-text was returned
    low = raw.lower()
    logits = np.array([1.8 if c.lower() in low else 0.0 for c in class_names], dtype=np.float32)
    probs = softmax(logits[None, :])[0]
    rationale = " ".join(raw.split())[:220] or "Grounded VLM assessment completed."
    return probs, rationale


def _infer_vllm(ctx, imgs, organ: str, class_names: List[str], class_prompts: List[List[str]]):
    prompt = _build_prompt(organ, class_names, class_prompts)
    base = ctx.settings.vllm_url.rstrip("/")
    repo = ctx.model.get("hf_repo") or "lighteternal/tissuedecision-9b"
    probs, rationales = [], []
    for i, im in enumerate(imgs):
        buf = io.BytesIO()
        im.resize((384, 384)).save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        payload = {
            "model": repo,
            "temperature": 0.0,
            "max_tokens": 256,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }],
        }
        req = urllib.request.Request(
            f"{base}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=180) as resp:
            out = json.loads(resp.read().decode("utf-8"))
        txt = out["choices"][0]["message"]["content"]
        p, rat = _parse_vlm_json(txt, class_names)
        probs.append(p)
        rationales.append(rat)
        ctx.progress(0.15 + 0.8 * (i + 1) / len(imgs), f"Scored tile {i + 1}/{len(imgs)} via vLLM")
    return np.stack(probs), rationales


def _infer_transformers(ctx, imgs, organ: str, class_names: List[str], class_prompts: List[List[str]]):
    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor

    repo = ctx.model.get("hf_repo") or "lighteternal/tissuedecision-9b"
    key = (repo, ctx.device)
    if key not in _vlm_cache:
        _vlm_cache.clear()
        ctx.progress(0.05, f"Loading {repo} via transformers on {ctx.device}")
        dtype = torch.bfloat16 if ctx.device.startswith("cuda") else torch.float32
        proc = AutoProcessor.from_pretrained(repo, trust_remote_code=True)
        model = AutoModelForImageTextToText.from_pretrained(
            repo, torch_dtype=dtype, trust_remote_code=True
        ).eval().to(ctx.device)
        _vlm_cache[key] = (proc, model)
    proc, model = _vlm_cache[key]
    prompt = _build_prompt(organ, class_names, class_prompts)
    probs, rationales = [], []
    for i, im in enumerate(imgs):
        messages = [{"role": "user", "content": [{"type": "image", "image": im}, {"type": "text", "text": prompt}]}]
        if hasattr(proc, "apply_chat_template"):
            text_in = proc.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = proc(text=[text_in], images=[im], return_tensors="pt").to(ctx.device)
        else:
            inputs = proc(text=prompt, images=im, return_tensors="pt").to(ctx.device)
        with torch.inference_mode():
            gen = model.generate(**inputs, max_new_tokens=220, do_sample=False)
        gen_trimmed = gen[:, inputs["input_ids"].shape[1]:] if "input_ids" in inputs else gen
        txt = proc.batch_decode(gen_trimmed, skip_special_tokens=True)[0]
        p, rat = _parse_vlm_json(txt, class_names)
        probs.append(p)
        rationales.append(rat)
        ctx.progress(0.15 + 0.8 * (i + 1) / len(imgs), f"Evaluated tile {i + 1}/{len(imgs)}")
    return np.stack(probs), rationales


def run_tox_vqa(ctx) -> dict:
    raw_classes = ctx.params.get("classes") or DEFAULT_TOX_CLASSES
    names_c, prompts = parse_classes(raw_classes)
    organ = (ctx.params.get("organ") or "Rodent liver / preclinical tissue").strip()
    names, imgs = load_tiles(ctx.inputs["tiles"])
    thumbs = save_thumbs(ctx, names, imgs)

    if ctx.mock:
        enc = MockImageEncoder(ctx.model["id"] + ":tox", 512)
        I = l2n(enc(imgs))
        flat = [p for ps in prompts for p in ps]
        t_all = l2n(mock_text(ctx.model["id"], flat, 512))
        T, idx = [], 0
        for ps in prompts:
            T.append(l2n(t_all[idx:idx + len(ps)].mean(0)))
            idx += len(ps)
        T = np.stack(T)
        P = softmax(30.0 * (I @ T.T))
        rationales = [
            f"[Mock rationale · {organ}] Dominant feature pattern aligns with '{names_c[int(p.argmax())]}' "
            f"(confidence {float(p.max()) * 100:.1f}%)."
            for p in P
        ]
    elif ctx.settings.vllm_url:
        P, rationales = _infer_vllm(ctx, imgs, organ, names_c, prompts)
    else:
        P, rationales = _infer_transformers(ctx, imgs, organ, names_c, prompts)

    pred = P.argmax(1)
    counts = np.bincount(pred, minlength=len(names_c))

    with open(ctx.out_path("tox_decisions.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["tile", "organ_context", "primary_finding", "confidence", "rationale"] + [f"p_{c}" for c in names_c])
        for i, n in enumerate(names):
            w.writerow([n, organ, names_c[pred[i]], f"{P[i, pred[i]]:.4f}", rationales[i]] + [f"{v:.5f}" for v in P[i]])
    ctx.register("tox_decisions.csv", "Structured toxicologic findings, probabilities, and morphological rationales")

    table_rows = [
        [names[i], names_c[pred[i]], f"{P[i, pred[i]] * 100:.1f}%", rationales[i]]
        for i in range(len(names))
    ]
    return {
        "summary": [
            {"label": "Tiles evaluated", "value": len(imgs)},
            {"label": "Candidate findings", "value": len(names_c)},
            {"label": "Organ context", "value": organ or "—"},
            {"label": "Most frequent call", "value": names_c[int(counts.argmax())]},
        ],
        "panels": [
            {
                "type": "bars",
                "title": "Finding / decision scores per tile",
                "labels": names_c,
                "rows": names,
                "values": P.round(4).tolist(),
                "thumbs": thumbs,
                "percent": True,
            },
            {
                "type": "matrix",
                "title": "Finding probability matrix (tiles × findings)",
                "rows": names,
                "cols": names_c,
                "values": P.round(3).tolist(),
                "vmin": 0.0,
                "vmax": 1.0,
            },
            {
                "type": "table",
                "title": "Structured morphological decisions & rationales",
                "columns": ["Tile", "Primary finding", "Confidence", "Morphological rationale"],
                "rows": table_rows,
            },
        ],
    }
