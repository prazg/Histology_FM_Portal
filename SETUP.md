# Setting up your own server

The portal website only shows the interface. Models run in a small Python server on **your** computer, workstation or cluster, and your slides never leave it. You don't need your own copy of the website: open the portal and connect it to your server.

Pick one route:

| Route | Best for | Time |
|---|---|---|
| [A. Guided setup](#a-guided-setup-recommended) | Laptops and workstations (Windows, macOS, Linux) | 15–40 min, mostly downloads |
| [B. Manual setup](#b-manual-setup) | People who prefer the terminal, or locked-down machines | 20–60 min |
| [C. HPC / Slurm cluster](#c-hpc--slurm-cluster) | GPU nodes you reach over SSH | 20–60 min |

**You'll need:** about 5 GB of free disk space for the software, plus the weights of the models you use (0.1–5 GB each, about 18 GB for PRISM2, about 77 GB for every model). You'll also need a free [Hugging Face](https://huggingface.co/join) account for the gated models. An NVIDIA GPU is optional: without one, the small models run on the CPU, and each model card says what suits your hardware.

---

## A. Guided setup (recommended)

1. **Open the portal.** On a first visit it offers *Set up a server on this computer*. You can also find it under **Connect → Open guided setup**, or as the button in the hardware bar on the Models page.
2. **Copy the one-line installer** the portal shows for your system and paste it into **PowerShell** (Windows) or **Terminal** (macOS/Linux). A web page can't install software, so this command does the computer-side steps. It asks before each one:
   1. checks for Git and offers to install it (winget, Homebrew/Xcode tools, or apt/dnf);
   2. installs [uv](https://docs.astral.sh/uv/), which fetches **Python 3.11** into your user folder (no admin rights needed);
   3. downloads the portal code into `~/histology-fm-portal` (you can change the folder);
   4. creates the server's Python environment (`backend/.venv`);
   5. writes `backend/config.yaml` with a new private **portal key**, your portal's address, and test mode switched on;
   6. asks *Add your Hugging Face token now? [y/N]*: **y** lets you paste a Read **access token** (hidden as you paste it; never your password), **n** skips straight to starting the server. You can add the token later in the wizard. This step never stops the installer: if the token is rejected you can try again or skip, and if huggingface.co can't be reached (e.g. a university proxy) the token is saved and checked later;
   7. starts the server and reopens the portal, already connected.

   Keep that window open: it *is* the server. To read the script before running it, open `install/setup.ps1` or `install/setup.sh` on the portal site.
3. **Follow the wizard in the portal.** Each step runs on your server when you click it, and you watch its log as it goes:

   | Step | What happens |
   |---|---|
   | Test the connection | A tiny test job goes to your server and comes back (test mode, no weights) |
   | PyTorch | Installed to match your machine: the CUDA build if an NVIDIA driver is found, else the CPU build |
   | TRIDENT and encoders | TRIDENT plus CONCH, MUSK, GigaPath and OpenCLIP (needs Git) |
   | Extra models | Optional: GigaTIME, HEX, STPath, each cloned from its own repository |
   | Switch to real models | Leaves test mode and restarts the server so it loads the new packages |
   | Hugging Face | Paste a **Read** token from [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) |
   | Model access | Links to each gated model that suits your hardware, so you can request access; then *Check my access* |
   | Slide folders | Folders the server may read slides from (no multi-GB uploads) |
   | Download weights | Fetches the models that suit your hardware into the Hugging Face cache |
   | Finish | **Lock setup** turns off the install buttons for good (recommended) |

**Starting the server again later:** in the install folder, run
```powershell
powershell -ExecutionPolicy Bypass -File .\backend\start_server.ps1     # Windows
```
```bash
bash backend/start_server.sh                                            # macOS / Linux
```
Then open the portal; it reconnects by itself.

---

## B. Manual setup

```bash
# 1. Code and Python (3.10 or 3.11)
git clone https://github.com/<user>/<repo>.git histology-fm-portal
cd histology-fm-portal/backend
python -m venv .venv            # or: conda create -n fmportal python=3.10 && conda activate fmportal
source .venv/bin/activate       # Windows: .venv\Scripts\activate

# 2. Server packages, then check the connection in test mode
pip install -r requirements-server.txt
MOCK=1 bash start_server.sh     # Windows: .\start_server.ps1 -Mock
#   → portal → Connect → My server → http://127.0.0.1:8000 → Connect.   Ctrl+C when done.

# 3. Models: PyTorch first (pytorch.org/get-started/locally: CUDA build for NVIDIA GPUs, else CPU)
pip install torch torchvision   # replace with the command pytorch.org gives you
git clone https://github.com/mahmoodlab/TRIDENT external/TRIDENT
pip install -e "external/TRIDENT[patch-encoders,slide-encoders]"
pip install open_clip_torch transformers
#    optional extras
git clone https://github.com/prov-gigatime/GigaTIME external/GigaTIME
git clone https://github.com/lilab-stanford/HEX external/HEX
git clone https://github.com/Graph-and-Geometric-Learning/STPath external/STPath && pip install anndata scanpy

# 4. Config, Hugging Face, check, start
cp config.example.yaml config.yaml   # set origins, portal_key, allowed_wsi_roots, and the three repo paths above
hf auth login                        # paste a Read token
python check_setup.py                # hardware, what's missing, which models suit this machine
bash start_server.sh                 # Windows: .\start_server.ps1
```
In the portal, go to **Connect**, enter your portal key, click **Connect**, then use **Download the ones that suit this hardware**.

**Make a portal key** with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Put the same value in `config.yaml` and in the portal.

---

## C. HPC / Slurm cluster

1. On the login node, follow **B, steps 1 and 3–4**, in your usual environment (conda or venv). Set `HF_HOME` to shared lab storage so each model is downloaded once for the whole group.
2. Edit the `CHANGE_ME` lines in `backend/hpc/serve_slurm.sbatch`: the partition, the GPU request syntax, and the line that loads your environment.
3. Submit it: `sbatch hpc/serve_slurm.sbatch`. The script won't start without a `portal_key`, because compute nodes are shared.
4. Open the job's log file. It prints a line like `ssh -N -L 8000:<node>:8000 you@LOGIN`. Run that on your laptop, then connect the portal to `http://127.0.0.1:8000`.

Guided setup is deliberately unavailable on clusters: it only accepts requests from the machine the server runs on.

---

## Troubleshooting

| Message | Fix |
|---|---|
| *Cannot reach http://127.0.0.1:8000* | The server window isn't running, or `origins` in `config.yaml` doesn't exactly match the portal's address (scheme and host, no path). |
| *Missing or wrong portal key* | The key in the portal must match `portal_key` in `config.yaml`. Restart the server after editing the file. |
| *CERTIFICATE_VERIFY_FAILED* | A university/NHS network proxy re-signs HTTPS. Run `pip install truststore` in the server's environment and restart (the installer does this already). |
| GPU present but models run on the CPU | PyTorch is a CPU-only build, and `check_setup.py` warns about this. Reinstall PyTorch with CUDA (wizard: *PyTorch → Reinstall*). |
| *No access … gated* | Request access on the model's Hugging Face page, wait for approval, then *Check my access*. |
| The browser asks to allow access to devices on your local network | Allow it. That's the page reaching your own server on 127.0.0.1. |
| PowerShell says scripts are disabled | Use the commands exactly as shown, including `-ExecutionPolicy Bypass`. This applies to that one run only. |

## Security and privacy
- The server listens only on `127.0.0.1` (this computer) unless you change it. Every request needs the portal key.
- Guided setup only works from the same computer, only runs a fixed list of install steps (the browser can't send commands), and is switched off by **Lock setup** or `setup_enabled: false`.
- Your Hugging Face token is stored by `huggingface_hub` on the server. It is never kept by the portal page or sent to GitHub.
- Weights live in the Hugging Face cache on your server. Never commit them to a repository: most are licensed non-commercial/no-derivatives (CC-BY-NC-ND or similar) and too large for GitHub.

## Removing it
Stop the server (Ctrl+C) and delete the install folder. Downloaded weights are in the Hugging Face cache (`~/.cache/huggingface` by default); `hf cache delete` lets you remove individual models. Uninstall uv with `uv self uninstall` if you no longer need it.
