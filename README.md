# Histology FM Portal

A graphical front end for open-weight histology foundation models. It is a static site that can be hosted on GitHub Pages (`docs/`), plus a small FastAPI inference server (`backend/`) that you run on a GPU machine.

Choose a model, give it tiles or a whole slide, and the portal returns outputs that match the model type:

| Model family | Outputs in the portal |
|---|---|
| Patch encoders (UNI, Virchow2, Prov-GigaPath, H-optimus, Phikon, Kaiko, …) | Embeddings (.h5); PCA scatter coloured by k-means cluster; cosine-similarity matrix. On a slide: spatial cluster map and a PCA-as-RGB map |
| Vision–language (CONCH, MUSK, KEEP, PLIP, QuiltNet) | Zero-shot classification from your own prompts: per-tile probabilities, per-class heatmaps over the slide, slide-level scores |
| Slide encoders (TITAN, PRISM, CHIEF, GigaPath slide, MADELEINE, FEATHER, CARE) | One embedding per slide; TITAN also does slide-level zero-shot classification |
| Virtual multiplex (GigaTIME 23-ch, HEX 48-marker) | Marker maps per tile; per-marker spatial maps over the slide; marker summary tables |
| Spatial transcriptomics (STPath) | Predicted log1p expression per spot (.h5ad) and gene maps |
| Tissue segmentation (HEST, GrandQC, Otsu) | Contour overlay; GeoJSON that opens in QuPath |

```
GitHub Pages (docs/)  ──HTTPS/localhost──▶  backend/server.py (your GPU)
  catalogue, forms,                            TRIDENT: WSI reading, segmentation,
  result viewers                               patching, 33 patch + slide encoders
  (no images leave                             + runners: CONCH/MUSK/KEEP/PLIP/QuiltNet
   your network)                               zero-shot, TITAN zero-shot, GigaTIME,
                                               HEX, STPath
```

GitHub Pages cannot run Python or a GPU, so the page itself never runs a model. Images and slides go only from your browser to *your* server.

## Quick start

### 1. Publish the portal
Push this folder to a GitHub repository. Then go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, and select `main` and `/docs`. The site appears at `https://<user>.github.io/<repo>/`.

To preview locally, run `cd docs && python -m http.server 8080` and open http://localhost:8080. (Opening `index.html` directly from disk does not work, because the page loads `models.json` over HTTP.)

### 2. Try it without a GPU
Open **Connect → Demo**. This generates synthetic outputs in the browser so you can explore every viewer. The results are clearly labelled as synthetic.

To exercise the real API end to end without weights, run the server in mock mode:
```bash
cd backend
pip install fastapi "uvicorn[standard]" python-multipart numpy pillow pyyaml h5py
PORTAL_MOCK=1 python -m uvicorn server:app --port 8000
python tests/test_api_mock.py        # runs every model × task (95 runs) through the API
```

### 3. Run real models
```bash
cd backend
pip install -r requirements.txt                        # install torch/torchvision for your CUDA first
git clone https://github.com/mahmoodlab/TRIDENT external/TRIDENT
pip install -e "external/TRIDENT[patch-encoders,slide-encoders]"
trident-doctor --profile patch-encoders --check-gated  # tells you which gated models you can access
# optional runners
pip install git+https://github.com/Mahmoodlab/CONCH.git                      # CONCH zero-shot
git clone https://github.com/prov-gigatime/GigaTIME external/GigaTIME        # GigaTIME
git clone https://github.com/lilab-stanford/HEX external/HEX                 # HEX (+ MUSK package)
git clone https://github.com/Graph-and-Geometric-Learning/STPath external/STPath
cp config.example.yaml config.yaml                     # set origins, portal_key, slide folders, repo paths
hf auth login                                          # once; accept each gated model's terms on its HF page first
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```
In the portal, open **Connect → My server**, enter `http://127.0.0.1:8000` and your portal key, then click **Connect**. The status card shows which models are ready and, for any that aren't, what is missing.

**Remote GPU (HPC node or cloud):** forward the port with `ssh -L 8000:127.0.0.1:8000 <gpu-node>` and keep the URL as `http://127.0.0.1:8000`. Alternatively, put the server behind an HTTPS tunnel. A page served over HTTPS (GitHub Pages) can call `http://127.0.0.1`, but not plain-HTTP remote hosts. Chromium may ask you once for permission to reach the local network. The server sends `Access-Control-Allow-Private-Network: true` for browsers that check that header.

## Security
- **Always set `portal_key`** before the server can be reached by anything other than your own machine. Every API call requires the key.
- `origins` limits which web pages can call the server. Set it to your Pages origin.
- Slides can be read by server path only from folders listed in `allowed_wsi_roots`. Paths are resolved, and anything outside those folders is refused.
- A Hugging Face token entered in the portal stays in that browser tab (sessionStorage). It is attached to each job and cleared from the job when the job finishes. Logging in on the server (`hf auth login`) avoids sending a token at all.

## How the registry was verified
`docs/models.json` is the single source of truth for both the portal and the server. It was checked on 2026-10-29 against:
- **TRIDENT README encoder tables**: names, embedding dimensions, patch size and magnification, licence, gating.
- **Model cards and READMEs**: CONCH, MUSK, KEEP, PLIP, QuiltNet, TITAN, GigaTIME, HEX, STPath. These cover loading calls, text-encoding APIs, preprocessing and channel order.

Where a source is silent, the registry says so in `notes`. For example, PLIP and STPath state no licence on their model cards; MUSK and KEEP document no logit scale, so the portal uses 100 and labels the resulting probabilities as uncalibrated; and the slide patch size/magnification for PLIP and QuiltNet are portal defaults.

## Testing status — please read
- **Tested here:** the API and every model × task combination in mock mode (95 runs); every viewer in a headless browser (desktop and mobile, light and dark); no console errors.
- **Not tested here:** real inference. The build environment had no GPU, PyTorch or gated weights. Every real-mode call follows the model's own documented API (listed above), but the first real run of each runner should be checked against the model's reference notebook. Start with one slide at a low `max patches`.
- **GigaTIME-Flash** is catalogue-only. Its model class is defined inside a notebook, not an importable module.

## Model coverage

| Family | Model | Registry id | Output | Licence | Gated | Tasks |
|---|---|---|---|---|---|---|
| Patch encoders | UNI | `uni_v1` | 1024-d | CC-BY-NC-ND-4.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | UNI2-h | `uni_v2` | 1536-d | CC-BY-NC-ND-4.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | CONCH v1.5 | `conch_v15` | 768-d | CC-BY-NC-ND-4.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | Virchow | `virchow` | 2560-d | Apache-2.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | Virchow2 | `virchow2` | 2560-d | CC-BY-NC-ND-4.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | Virchow2 (CLS only) | `virchow2-cls` | 1280-d | CC-BY-NC-ND-4.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | Phikon | `phikon` | 768-d | Owkin non-commercial | no | Embed tiles, Embed a slide |
| Patch encoders | Phikon-v2 | `phikon_v2` | 1024-d | Owkin non-commercial | no | Embed tiles, Embed a slide |
| Patch encoders | Prov-GigaPath (tile) | `gigapath` | 1536-d | Apache-2.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | Prov-GigaPath-Flash (tile) | `gigapath-flash` | 384-d | Apache-2.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | H-optimus-0 | `hoptimus0` | 1536-d | Apache-2.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | H-optimus-1 | `hoptimus1` | 1536-d | CC-BY-NC-ND-4.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | H0-mini | `h0-mini` | 768 / 1536-d | CC-BY-NC-ND-4.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | Midnight-12k | `midnight12k` | 3072-d | MIT | no | Embed tiles, Embed a slide |
| Patch encoders | OpenMidnight | `openmidnight` | 1536-d | Apache-2.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | GPFM | `gpfm` | 1024-d | MIT | no | Embed tiles, Embed a slide |
| Patch encoders | GenBio-PathFM | `genbio-pathfm` | 4608-d | GenBio AI Community | no | Embed tiles, Embed a slide |
| Patch encoders | Hibou-L | `hibou_l` | 1024-d | Apache-2.0 | yes | Embed tiles, Embed a slide |
| Patch encoders | Phaet | `phaet` | 1024-d | Waiv non-commercial | yes | Embed tiles, Embed a slide |
| Patch encoders | Mascaret | `mascaret` | 1536 / 3072-d | Waiv non-commercial | yes | Embed tiles, Embed a slide |
| Patch encoders | Lunit DINO ViT-S/8 | `lunit-vits8` | 384-d | Lunit non-commercial | no | Embed tiles, Embed a slide |
| Patch encoders | Kaiko ViT-S/8 | `kaiko-vits8` | 384-d | Kaiko non-commercial | no | Embed tiles, Embed a slide |
| Patch encoders | Kaiko ViT-S/16 | `kaiko-vits16` | 384-d | Kaiko non-commercial | no | Embed tiles, Embed a slide |
| Patch encoders | Kaiko ViT-B/8 | `kaiko-vitb8` | 768-d | Kaiko non-commercial | no | Embed tiles, Embed a slide |
| Patch encoders | Kaiko ViT-B/16 | `kaiko-vitb16` | 768-d | Kaiko non-commercial | no | Embed tiles, Embed a slide |
| Patch encoders | Kaiko ViT-L/14 | `kaiko-vitl14` | 1024-d | Kaiko non-commercial | no | Embed tiles, Embed a slide |
| Patch encoders | CTransPath (CHIEF weights) | `ctranspath` | 768-d | GPL-3.0 | no | Embed tiles, Embed a slide |
| Patch encoders | ResNet-50 (ImageNet) | `resnet50` | 1024-d | BSD-3-Clause | no | Embed tiles, Embed a slide |
| Vision–language | CONCH | `conch_v1` | 512-d | CC-BY-NC-ND-4.0 | yes | Zero-shot classify tiles, Zero-shot map a slide, Embed tiles, Embed a slide |
| Vision–language | MUSK | `musk` | 1024-d | CC-BY-NC-ND-4.0 | yes | Zero-shot classify tiles, Zero-shot map a slide, Embed tiles, Embed a slide |
| Vision–language | KEEP | `keep` | 768-d | MIT | no | Zero-shot classify tiles, Zero-shot map a slide, Embed tiles, Embed a slide |
| Vision–language | PLIP | `plip` | 512-d | Not stated on model card | no | Zero-shot classify tiles, Zero-shot map a slide, Embed tiles, Embed a slide |
| Vision–language | QuiltNet-B-32 | `quiltnet_b32` | 512-d | MIT | no | Zero-shot classify tiles, Zero-shot map a slide, Embed tiles, Embed a slide |
| Slide encoders | TITAN | `slide:titan` | — | CC-BY-NC-ND-4.0 | yes | Slide embedding, Zero-shot classify a slide |
| Slide encoders | PRISM | `slide:prism` | — | CC-BY-NC-ND-4.0 | yes | Slide embedding |
| Slide encoders | PRISM2 | `slide:prism2` | — | CC-BY-NC-ND-4.0 | yes | Slide embedding |
| Slide encoders | CHIEF | `slide:chief` | — | AGPL-3.0 | no | Slide embedding |
| Slide encoders | Prov-GigaPath (slide) | `slide:gigapath` | — | Apache-2.0 | yes | Slide embedding |
| Slide encoders | Prov-GigaPath-Flash (slide) | `slide:gigapath-flash` | — | Apache-2.0 | yes | Slide embedding |
| Slide encoders | MADELEINE | `slide:madeleine` | — | MIT | yes | Slide embedding |
| Slide encoders | FEATHER (CONCH v1.5) | `slide:feather` | — | CC-BY-NC-ND-4.0 | yes | Slide embedding |
| Slide encoders | FEATHER (UNI2-h) | `slide:feather_uni_v2` | — | CC-BY-NC-ND-4.0 | yes | Slide embedding |
| Slide encoders | CARE | `slide:care` | — | CC-BY-NC-4.0 | yes | Slide embedding |
| Virtual multiplex | GigaTIME | `gigatime` | 23 markers | Apache-2.0 (GitHub); HF terms must be accepted | yes | Virtual multiplex on tiles, Virtual multiplex on a slide |
| Virtual multiplex | GigaTIME-Flash | `gigatime-flash` | 23 markers | Apache-2.0 (GitHub) | yes | catalogue only |
| Virtual multiplex | HEX (nolan48) | `hex_nolan48` | 48 markers | CC-BY-NC-ND-4.0 | no | Virtual multiplex on tiles, Virtual multiplex on a slide |
| Spatial transcriptomics | STPath | `stpath` | — | Not stated on model card | no | Predict spatial expression |
| Tissue segmentation | HEST tissue segmenter | `seg:hest` | — | CC-BY-NC-SA-4.0 | no | Segment tissue |
| Tissue segmentation | GrandQC tissue segmenter | `seg:grandqc` | — | CC-BY-NC-SA-4.0 | no | Segment tissue |
| Tissue segmentation | Otsu threshold | `seg:otsu` | — | No weights | no | Segment tissue |
## Adding a model
1. Add an entry to `docs/models.json` with `id`, `category`, `runner`, `tasks` and licence fields. The portal picks it up automatically.
2. If TRIDENT already supports it, set `runner: "trident_patch"` (or `"trident_slide"`) and `trident_name`. Nothing else is needed.
3. Otherwise, add a module under `backend/runners/` that returns `{"summary": [...], "panels": [...]}` using the existing panel types (`scatter`, `matrix`, `bars`, `spatial`, `channels`, `vector`, `table`, `image`, `note`), and register it in `runners/__init__.py`.

## Licence and use
This portal's code is MIT licence. Each model keeps its own licence, and most are **non-commercial** (CC-BY-NC-ND-4.0 and similar). TRIDENT itself is CC-BY-NC-ND-4.0. For research use only; not for clinical decision-making. Copyright @Prajwal Ghimire.
