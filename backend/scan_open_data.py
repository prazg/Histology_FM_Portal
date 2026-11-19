"""Scan public open-access repositories (Zenodo, Nature Scientific Data via Europe PMC, and Hugging Face Datasets)
for oncology-focused histology, spatial omics, multiplex immunofluorescence, and transcriptomic datasets.

Supports organ-specific priority cancers (Brain, Lung, Breast, Prostate) and Pan-Cancer queries.

Usage (from backend/ or project root):
    python backend/scan_open_data.py                                      # scan priority cancers (Brain, Lung, Breast, Prostate, Pan-Cancer)
    python backend/scan_open_data.py --cancer brain                       # scan Brain cancer (GBM / glioma) datasets
    python backend/scan_open_data.py --cancer prostate                    # scan Prostate cancer (PRAD / Gleason) datasets
    python backend/scan_open_data.py --preset matched_he_if               # scan cancer H&E + multiplex IF / IHC
    python backend/scan_open_data.py --all-priority --out cancer_data.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

try:
    import certs  # noqa: F401 — enables OS trust store when truststore is installed
except Exception:
    pass

USER_AGENT = "Histology-FM-Portal-OncologyScanner/1.3 (+https://github.com/mahmoodlab/TRIDENT)"

CANCER_QUERIES: Dict[str, str] = {
    "brain": "glioblastoma OR glioma OR brain tumor histopathology spatial transcriptomics H&E",
    "lung": "lung cancer OR NSCLC OR lung adenocarcinoma histopathology spatial transcriptomics immunofluorescence",
    "breast": "breast cancer OR breast carcinoma histopathology spatial transcriptomics immunofluorescence H&E",
    "prostate": "prostate cancer OR Gleason histopathology spatial transcriptomics immunohistochemistry",
    "pan_cancer": "pan-cancer histopathology spatial transcriptomics whole slide single-cell",
}

PRESET_QUERIES: Dict[str, str] = {
    "matched_he_spatial": "cancer spatial transcriptomics H&E whole slide histopathology",
    "matched_he_if": "cancer multiplex immunofluorescence H&E histopathology co-registered",
    "matched_other": "cancer histopathology RNA-seq multimodal pathology report VQA",
    "unmatched_he": "cancer histopathology whole slide image H&E dataset",
    "unmatched_spatial": "tumor spatial transcriptomics MERFISH Xenium CODEX IMC single-cell",
    "unmatched_tx": "cancer single-cell RNA-seq tumor microenvironment atlas AnnData",
}

CANCER_RE = re.compile(
    r"cancer|carcinoma|tumou?r|oncolog|glioblastoma|\bgbm\b|glioma|astrocytoma|oligodendroglioma|"
    r"medulloblastoma|meningioma|adenocarcinoma|sarcoma|melanoma|lymphoma|leukemia|neoplasm|malignan|"
    r"metasta|\bnsclc\b|\bluad\b|\blusc\b|\bbrca\b|\bprad\b|\bdcis\b|\btnbc\b|gleason|her2|tcga|cptac",
    re.IGNORECASE,
)


def is_cancer_related(text: str) -> bool:
    return bool(CANCER_RE.search(text or ""))


def classify_cancer_site(text: str) -> str:
    """Classify dataset description into priority organ site (brain, lung, breast, prostate), pan_cancer, or other_cancer."""
    t = (text or "").lower()
    hits = []
    if re.search(r"glioblastoma|\bgbm\b|glioma|astrocytoma|oligodendroglioma|medulloblastoma|meningioma|brain tumou?r|neuro-oncol|\bcns tumou?r", t):
        hits.append("brain")
    if re.search(r"lung cancer|lung adenocarcinoma|lung squamous|\bnsclc\b|\bsclc\b|\bluad\b|\blusc\b|thoracic tumou?r|pulmonary carcinoma", t):
        hits.append("lung")
    if re.search(r"breast cancer|breast carcinoma|mammary carcinoma|\bbrca\b|\bdcis\b|\btnbc\b|her2[\s+-]*positive breast|metabric", t):
        hits.append("breast")
    if re.search(r"prostate cancer|prostate adenocarcinoma|prostatic carcinoma|\bprad\b|gleason|prostatectomy|\bcrpc\b", t):
        hits.append("prostate")
    if re.search(r"pan[- ]?cancer|multi[- ]?organ cancer|33 cancer|across cancer types|multiple cancer", t) or len(hits) > 1:
        return "pan_cancer"
    return hits[0] if hits else "other_cancer"


def classify_modality(text: str) -> str:
    """Heuristic classifier mapping dataset title/description into one of the portal's 6 modality groups."""
    t = (text or "").lower()
    has_he = bool(re.search(r"\bh\s*&\s*e\b|\bh&e\b|hematoxylin|haematoxylin|histopatholog|whole[- ]slide|\bwsi\b|brightfield", t))
    has_spatial_tx = bool(re.search(r"spatial transcriptom|visium|xenium|merfish|cosmx|slide-seq|stereo-seq|st-seq|10x spatial", t))
    has_if = bool(re.search(r"immunofluorescen|\bmif\b|cycif|codex|phenocycler|multiplex ihc|\bmihc\b|immunohistochem|\bihc\b|\bimc\b|imaging mass cytometry", t))
    has_tx = bool(re.search(r"rna-seq|rnaseq|scrna|snrna|transcriptom|gene expression|single-cell rna|perturbation atlas", t))
    has_text = bool(re.search(r"image-text|vision-language|\bvqa\b|caption|pathology report", t))

    if has_he and has_spatial_tx and has_if:
        return "matched_other"
    if has_he and has_spatial_tx:
        return "matched_he_spatial"
    if has_he and has_if:
        return "matched_he_if"
    if has_he and (has_tx or has_text):
        return "matched_other"
    if has_spatial_tx or (has_if and not has_he):
        return "unmatched_spatial"
    if has_tx and not has_he:
        return "unmatched_tx"
    return "unmatched_he"


def _get_json(url: str, timeout: int = 15):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _annotate_record(rec: dict, full_text: str) -> dict:
    site = classify_cancer_site(full_text)
    mod = classify_modality(full_text)
    rec["cancer_site"] = site
    rec["cancer_scope"] = "pan_cancer" if site == "pan_cancer" else "organ_specific"
    rec["cancer_related"] = is_cancer_related(full_text)
    rec["modality_group"] = mod
    rec["regime"] = "matched" if mod.startswith("matched_") else "unmatched"
    return rec


def scan_huggingface(query: str, limit: int = 10) -> List[dict]:
    q = urllib.parse.urlencode({"search": query, "limit": limit, "sort": "downloads", "direction": "-1", "full": "true"})
    data = _get_json(f"https://huggingface.co/api/datasets?{q}")
    out = []
    for item in data if isinstance(data, list) else []:
        repo_id = item.get("id", "")
        card = item.get("cardData") or {}
        desc = (item.get("description") or card.get("pretty_name") or "")[:360]
        tags = item.get("tags") or []
        lic = card.get("license") or next((t.split(":", 1)[1] for t in tags if t.startswith("license:")), "See dataset card")
        rec = {
            "source_hub": "huggingface",
            "source_label": "Hugging Face",
            "title": card.get("pretty_name") or repo_id,
            "id_or_doi": repo_id,
            "url": f"https://huggingface.co/datasets/{repo_id}",
            "licence": lic if isinstance(lic, str) else ", ".join(lic),
            "gated": bool(item.get("gated")),
            "metric": f"{item.get('downloads', 0):,} downloads · {item.get('likes', 0)} likes",
            "updated": (item.get("lastModified") or "")[:10],
            "summary": re.sub(r"\s+", " ", desc).strip(),
        }
        out.append(_annotate_record(rec, f"{repo_id} {desc} {' '.join(tags)}"))
    return out


def scan_zenodo(query: str, limit: int = 10) -> List[dict]:
    q = urllib.parse.urlencode({"q": query, "type": "dataset", "status": "published", "size": limit, "sort": "bestmatch"})
    data = _get_json(f"https://zenodo.org/api/records?{q}")
    hits = (data.get("hits") or {}).get("hits") or []
    out = []
    for h in hits:
        meta = h.get("metadata") or {}
        if meta.get("access_right", "open") not in ("open",):
            continue
        title = meta.get("title") or h.get("title") or f"Zenodo {h.get('id')}"
        raw_desc = re.sub(r"<[^>]+>", " ", meta.get("description") or "")
        desc = re.sub(r"\s+", " ", raw_desc).strip()[:360]
        doi = h.get("doi") or meta.get("doi") or f"10.5281/zenodo.{h.get('id')}"
        lic = (meta.get("license") or {}).get("id") or "Open Access"
        kw = " ".join(meta.get("keywords") or [])
        creators = ", ".join((c.get("name") or "") for c in (meta.get("creators") or [])[:3])
        rec = {
            "source_hub": "zenodo",
            "source_label": "Zenodo",
            "title": title,
            "id_or_doi": doi,
            "url": f"https://doi.org/{doi}" if not str(doi).startswith("http") else doi,
            "licence": lic,
            "gated": False,
            "metric": creators or "Zenodo open record",
            "updated": (meta.get("publication_date") or h.get("created") or "")[:10],
            "summary": desc,
        }
        out.append(_annotate_record(rec, f"{title} {desc} {kw}"))
    return out


def scan_scientific_data(query: str, limit: int = 10) -> List[dict]:
    epmc_q = f'ISSN:"2052-4463" AND ({query}) AND OPEN_ACCESS:Y'
    q = urllib.parse.urlencode({"query": epmc_q, "format": "json", "pageSize": limit, "resultType": "core"})
    data = _get_json(f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?{q}")
    results = ((data.get("resultList") or {}).get("result")) or []
    out = []
    for r in results:
        title = re.sub(r"<[^>]+>", "", r.get("title") or "").strip()
        abstract = re.sub(r"<[^>]+>", " ", r.get("abstractText") or "")
        desc = re.sub(r"\s+", " ", abstract).strip()[:360]
        doi = r.get("doi") or ""
        url = f"https://doi.org/{doi}" if doi else f"https://europepmc.org/article/{r.get('source', 'MED')}/{r.get('id', '')}"
        rec = {
            "source_hub": "scientific_data",
            "source_label": "Scientific Data",
            "title": title,
            "id_or_doi": doi or r.get("pmid") or r.get("id", ""),
            "url": url,
            "licence": "CC-BY-4.0 (Nature Scientific Data)",
            "gated": False,
            "metric": f"{r.get('authorString', '')[:48]} ({r.get('pubYear', '')}) · cited {r.get('citedByCount', 0)}",
            "updated": r.get("firstPublicationDate") or str(r.get("pubYear") or ""),
            "summary": desc,
        }
        out.append(_annotate_record(rec, f"{title} {desc}"))
    return out


def run_scan(queries: List[str], hubs: List[str], limit: int = 8, cancer_only: bool = True) -> dict:
    seen = set()
    items: List[dict] = []
    errors: List[str] = []
    scanners = {
        "huggingface": scan_huggingface,
        "zenodo": scan_zenodo,
        "scientific_data": scan_scientific_data,
    }
    for q in queries:
        for hub in hubs:
            fn = scanners.get(hub)
            if not fn:
                continue
            try:
                for rec in fn(q, limit=limit):
                    if cancer_only and not rec.get("cancer_related"):
                        continue
                    key = (rec["source_hub"], rec["id_or_doi"] or rec["url"])
                    if key not in seen:
                        seen.add(key)
                        items.append(rec)
            except Exception as exc:
                errors.append(f"{hub} ({q!r}): {exc}")
    return {"count": len(items), "cancer_only": cancer_only, "queries": queries, "hubs": hubs, "errors": errors, "results": items}


def main() -> int:
    ap = argparse.ArgumentParser(description="Scan Zenodo, Scientific Data & Hugging Face for open oncology datasets.")
    ap.add_argument("--query", "-q", help="Custom search string")
    ap.add_argument("--cancer", choices=list(CANCER_QUERIES), help="Priority cancer cohort (brain, lung, breast, prostate, pan_cancer)")
    ap.add_argument("--all-priority", action="store_true", help="Scan Brain, Lung, Breast, Prostate & Pan-Cancer queries")
    ap.add_argument("--preset", choices=list(PRESET_QUERIES), help="Predefined oncology modality query preset")
    ap.add_argument("--all-presets", action="store_true", help="Scan all 6 oncology modality presets")
    ap.add_argument("--include-non-cancer", action="store_true", help="Disable strict oncology keyword filter")
    ap.add_argument("--hubs", nargs="+", default=["huggingface", "zenodo", "scientific_data"],
                    choices=["huggingface", "zenodo", "scientific_data"], help="Repositories to query")
    ap.add_argument("--limit", type=int, default=6, help="Max results per hub per query")
    ap.add_argument("--out", type=Path, help="Optional JSON output file")
    args = ap.parse_args()

    if args.all_priority:
        queries = list(CANCER_QUERIES.values())
    elif args.cancer:
        queries = [CANCER_QUERIES[args.cancer]]
    elif args.all_presets:
        queries = list(PRESET_QUERIES.values())
    elif args.preset:
        queries = [PRESET_QUERIES[args.preset]]
    elif args.query:
        queries = [args.query]
    else:
        queries = list(CANCER_QUERIES.values())

    report = run_scan(queries, args.hubs, limit=args.limit, cancer_only=not args.include_non_cancer)
    for r in report["results"]:
        print(f"[{r['source_label']:15s}] [{r['cancer_site']:12s}] [{r['modality_group']:18s}] {r['title'][:60]}")
        print(f"    URL: {r['url']}  |  {r['licence']}  |  {r['metric']}")
    if report["errors"]:
        print("\nWarnings / unreachable endpoints:", file=sys.stderr)
        for e in report["errors"]:
            print(f"  - {e}", file=sys.stderr)
    if args.out:
        args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"\nSaved {report['count']} oncology records to {args.out}")
    else:
        print(f"\nFound {report['count']} unique open-access oncology records across {', '.join(args.hubs)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
