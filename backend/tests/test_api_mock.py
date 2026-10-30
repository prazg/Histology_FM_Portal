"""End-to-end API test in mock mode: every model × task, no weights or GPU needed.

    cd backend && PORTAL_MOCK=1 python -m pytest -q tests     (or: python tests/test_api_mock.py)
"""
import io
import json
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ["PORTAL_MOCK"] = "1"
os.environ.setdefault("PORTAL_WORK_DIR", tempfile.mkdtemp(prefix="fmportal_"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from fastapi.testclient import TestClient

import server  # noqa: E402

client = TestClient(server.app)


def fake_he(w, h, seed=0) -> bytes:
    """Pink/purple blobs on white — enough for the mock tissue detector."""
    rng = np.random.default_rng(seed)
    im = Image.new("RGB", (w, h), (246, 244, 248))
    d = ImageDraw.Draw(im)
    for _ in range(int(w * h / 500)):
        x, y, r = rng.integers(0, w), rng.integers(0, h), rng.integers(6, 30)
        col = (int(rng.integers(150, 230)), int(rng.integers(60, 130)), int(rng.integers(150, 210)))
        d.ellipse((x - r, y - r, x + r, y + r), fill=col)
    d.rectangle((0, 0, w // 5, h), fill=(246, 244, 248))  # background strip
    buf = io.BytesIO()
    im.filter(ImageFilter.GaussianBlur(1.2)).save(buf, "PNG")
    return buf.getvalue()


CLASSES = "tumour: glioblastoma | high-grade glioma\nnecrosis: necrotic tissue\nnormal: normal brain parenchyma"


def wait(job_id, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.05)
    raise TimeoutError(job_id)


def submit(model_id, task, tiles=0, wsi=None, params=None):
    files = [("tiles", (f"t{i}.png", fake_he(224, 224, i), "image/png")) for i in range(tiles)]
    if wsi:
        files.append(("wsi", ("slide.png", wsi, "image/png")))
    r = client.post("/api/jobs", data={"model_id": model_id, "task": task, "params": json.dumps(params or {})}, files=files)
    assert r.status_code == 200, r.text
    return wait(r.json()["id"])


def check_result(job):
    assert job["status"] == "done", (job["model_id"], job["task"], job["error"], job["log"][-5:])
    res = job["result"]
    assert res["mock"] is True and res["panels"]
    for p in res["panels"]:
        if p["type"] == "spatial":
            v = client.get(f"/api/jobs/{job['id']}/spatial/{p['id']}/0").json()
            assert len(v["values"]) == len(p["coords"])
        if p["type"] == "image":
            assert client.get(f"/api/jobs/{job['id']}/files/{p['src']}").status_code == 200
    for f in res["files"]:
        assert client.get(f"/api/jobs/{job['id']}/files/{f['name']}").status_code == 200


def test_health_and_models():
    h = client.get("/api/health").json()
    assert h["ok"] and h["mock"]
    m = client.get("/api/models").json()
    assert m["gigatime-flash"]["ready"] is False
    assert all(v["ready"] for k, v in m.items() if k != "gigatime-flash")


def test_all_models_all_tasks():
    reg = json.loads(server.REGISTRY_PATH.read_text())
    wsi = fake_he(1400, 1000, 99)
    n = 0
    for m in reg["models"]:
        for task in m["tasks"]:
            params = {"classes": CLASSES, "mpp": 0.5, "max_patches": 60, "max_spots": 60, "k": 4}
            if reg["tasks"][task]["input"] == "tiles":
                job = submit(m["id"], task, tiles=5, params=params)
            else:
                job = submit(m["id"], task, wsi=wsi, params=params)
            check_result(job)
            n += 1
    print(f"{n} model×task runs passed")


def test_rejects_bad_requests():
    assert client.post("/api/jobs", data={"model_id": "nope", "task": "embed_tiles"}).status_code == 404
    assert client.post("/api/jobs", data={"model_id": "uni_v1", "task": "st_wsi"}).status_code == 400
    assert client.post("/api/jobs", data={"model_id": "uni_v1", "task": "embed_tiles"}).status_code == 400
    r = client.post("/api/jobs", data={"model_id": "uni_v1", "task": "embed_wsi", "wsi_path": "/etc/passwd"})
    assert r.status_code in (400, 403)


if __name__ == "__main__":
    test_health_and_models()
    test_all_models_all_tasks()
    test_rejects_bad_requests()
    print("OK")
