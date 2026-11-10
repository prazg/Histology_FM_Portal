/* Guided setup wizard.
   Part 1 (browser only): explain, then hand the user a one-line installer for their OS — a web page cannot
   install software itself. Part 2: once the installer has started the server, every remaining step is done
   by that server on the user's click (/api/setup/*), one step at a time. */
(function () {
  "use strict";
  const { h } = Viewers;
  let P = null;                       // window.Portal, set on portal-ready
  let cur = 0, timer = null, lastStatus = null, busy = false;
  const dlg = () => document.getElementById("wizard");
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } } };

  const STEPS = [
    { id: "welcome", title: "Welcome" },
    { id: "install", title: "Run the installer" },
    { id: "test", title: "Test the connection" },
    { id: "torch", title: "PyTorch" },
    { id: "trident", title: "TRIDENT and encoders" },
    { id: "extras", title: "Extra models" },
    { id: "real", title: "Switch to real models" },
    { id: "hf", title: "Hugging Face" },
    { id: "access", title: "Model access" },
    { id: "slides", title: "Slide folders" },
    { id: "weights", title: "Download weights" },
    { id: "done", title: "Finish" },
  ];
  const idx = id => STEPS.findIndex(s => s.id === id);

  // ── helpers ────────────────────────────────────────────────────────────
  const portalUrl = () => location.origin + location.pathname.replace(/index\.html$/, "");
  function repoGuess() {
    const host = location.hostname, seg = location.pathname.split("/").filter(Boolean)[0];
    if (host.endsWith(".github.io")) {
      const owner = host.split(".")[0];
      return `https://github.com/${owner}/${seg || host}`;
    }
    return store.get("fm.repo") || "";
  }
  function os() { return (P && P.S.bhw && P.S.bhw.os) || (/win/i.test(navigator.platform) ? "Windows" : /mac/i.test(navigator.platform) ? "macOS" : "Linux"); }
  const connected = () => P && P.S.connected && P.S.conn.mode === "server";
  const clean = e => new Error(String(e.message || e).replace(/^\d{3}: /, ""));
  async function setupApi(path, opts) { try { return await P.api("/api/setup" + path, opts); } catch (e) { throw clean(e); } }
  const json = body => ({ method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  function copyBtn(text) {
    const b = h("button", { class: "btn ghost small", type: "button" }, "Copy");
    b.onclick = async () => { try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { b.textContent = "Select and copy"; } setTimeout(() => (b.textContent = "Copy"), 1800); };
    return b;
  }
  const tick = ok => h("span", { class: "dot " + (ok ? "ok" : ""), "aria-hidden": "true" });
  function stopPoll() { clearTimeout(timer); timer = null; }

  async function refreshStatus() {
    try { lastStatus = await setupApi("/status"); }
    catch (e) { lastStatus = { error: e.message }; }
    return lastStatus;
  }

  // ── chrome ─────────────────────────────────────────────────────────────
  function frame(body, nav) {
    const d = dlg();
    const doneMap = completion();
    d.replaceChildren(
      h("div", { class: "wz" },
        h("aside", { class: "wz-rail", "aria-label": "Setup steps" },
          h("p", { class: "wz-brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), " Server setup"),
          h("ol", {}, STEPS.map((s, i) => h("li", { class: (i === cur ? "cur " : "") + (doneMap[s.id] ? "done" : "") },
            h("button", { type: "button", disabled: i > cur && !doneMap[STEPS[i - 1] && STEPS[i - 1].id] && !doneMap[s.id], onclick: () => show(i) },
              h("span", { class: "n", text: doneMap[s.id] ? "✓" : String(i + 1) }), s.title))))),
        h("section", { class: "wz-main" },
          h("button", { class: "icon-btn close-x", type: "button", "aria-label": "Close setup", onclick: close }, "✕"),
          body,
          nav ? h("div", { class: "wz-nav" }, nav) : null)));
  }
  function completion() {
    const st = lastStatus && !lastStatus.error ? lastStatus : null;
    const step = id => st && st.steps && (st.steps.find(s => s.id === id) || {}).done;
    return {
      welcome: cur > 0, install: connected(), test: connected() && !!store.get("fm.wz.tested"),
      torch: step("torch"), trident: step("trident"),
      extras: st && ["gigatime", "hex", "stpath"].some(step) || !!store.get("fm.wz.extras"),
      real: connected() && P.S.health && !P.S.health.mock,
      hf: st && !!st.hf_user, access: !!store.get("fm.wz.access"),
      slides: st && st.wsi_roots && st.wsi_roots.length > 0 || !!store.get("fm.wz.slides"),
      weights: !!store.get("fm.wz.weights"), done: !!store.get("fm.wz.finished"),
    };
  }
  const nextBtn = (label, fn, primary = true) => h("button", { class: primary ? "btn" : "btn ghost", type: "button", onclick: fn }, label);
  const back = () => cur > 0 ? nextBtn("Back", () => show(cur - 1), false) : null;
  const next = (label = "Next") => nextBtn(label, () => show(cur + 1));
  const skip = (label = "Skip this step") => nextBtn(label, () => show(cur + 1), false);

  // ── steps ──────────────────────────────────────────────────────────────
  const render = {
    welcome() {
      frame([h("h2", { text: "Run the models on your own computer or server" }),
        h("p", { text: "This page is only the interface. The models run in a small Python server on your machine, so your slides never leave it. This guide sets that server up one step at a time; you confirm each step." }),
        h("ul", { class: "wz-list" },
          h("li", {}, h("strong", { text: "About 15–40 minutes, " }), "mostly downloads. PyTorch is roughly 1–3 GB; each model is 0.1–5 GB."),
          h("li", {}, h("strong", { text: "No admin rights needed, " }), "except for installing Git if you don't have it."),
          h("li", {}, h("strong", { text: "Works on " }), "Windows, macOS and Linux, with or without an NVIDIA GPU. On a cluster, use the Slurm script in SETUP.md instead.")),
        h("div", { class: "wz-choices" },
          h("button", { class: "btn", type: "button", onclick: () => show(idx("install")) }, "Set up a server on this computer"),
          h("button", { class: "btn ghost", type: "button", onclick: async () => { await P.findServer(true); if (connected()) show(idx("test")); else show(idx("install")); } }, "I already started one"),
          h("button", { class: "btn ghost", type: "button", onclick: () => { store.set("fm.wz.seen", "1"); close(); } }, "Just explore with demo data"))]);
    },

    install() {
      let tab = /Windows/.test(os()) ? "win" : "nix";
      const repoIn = h("input", { type: "url", value: repoGuess(), "aria-label": "Repository URL", placeholder: "https://github.com/<user>/<repo>" });
      const out = h("div");
      const status = h("p", { class: "small", role: "status" });
      const repoBox = h("details", {}, h("summary", { class: "small", text: "Repository being installed" }), h("div", { class: "field", style: "margin-top:8px" }, repoIn,
        h("span", { class: "hint", text: "Filled in from this page's address. Change it if you host the portal elsewhere." })));
      const draw = () => {
        const repo = repoIn.value.trim(), portal = portalUrl();
        store.set("fm.repo", repo);
        if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(repo)) {
          repoBox.open = true;
          out.replaceChildren(h("div", { class: "notice small", text: "Enter the GitHub address of the portal's repository below (https://github.com/<user>/<repo>) to get the install command." }));
          return;
        }
        const cmd = tab === "win"
          ? `powershell -ExecutionPolicy Bypass -NoProfile -Command "& ([scriptblock]::Create((irm '${portal}install/setup.ps1'))) -Repo '${repo}' -Portal '${portal}'"`
          : `curl -fsSL ${portal}install/setup.sh | bash -s -- --repo ${repo} --portal ${portal}`;
        out.replaceChildren(
          h("div", { class: "seg-ctl", role: "group", "aria-label": "Operating system" },
            [["win", "Windows"], ["nix", "macOS / Linux"]].map(([k, l]) => h("button", { type: "button", "aria-pressed": String(k === tab), onclick: () => { tab = k; draw(); } }, l))),
          h("p", { class: "small", text: tab === "win" ? "Open PowerShell (Start menu → type PowerShell), paste this and press Enter:" : "Open Terminal, paste this and press Enter:" }),
          h("div", { class: "wz-cmd" }, h("pre", { class: "cli", text: cmd }), copyBtn(cmd)),
          h("p", { class: "small muted" }, "Prefer to read it first? ", h("a", { href: `${portal}install/${tab === "win" ? "setup.ps1" : "setup.sh"}`, target: "_blank", rel: "noopener", text: "View the installer script" }), "."));
      };
      repoIn.addEventListener("input", draw);
      draw();
      frame([h("h2", { text: "Run the installer" }),
        h("p", { text: "A web page can't install software, so this one command does the computer-side steps. It asks before each one:" }),
        h("ol", { class: "wz-list small" },
          h("li", { text: "checks for Git and offers to install it;" }),
          h("li", { text: "installs uv, which gets Python 3.11 into your user folder;" }),
          h("li", { text: "downloads the portal code and creates its Python environment;" }),
          h("li", { text: "writes the server config with a new private portal key;" }),
          h("li", { text: "optionally saves your Hugging Face token (never your password);" }),
          h("li", { text: "starts the server in test mode and reopens this page, already connected." })),
        out,
        repoBox,
        h("div", { class: "notice info small" }, "Keep the installer's window open — it becomes the server. Waiting for it here… ", status)],
        [back(), skip("I've set it up another way")]);
      // Look for the server while the user runs the installer
      const look = async () => {
        if (!dlg().open || STEPS[cur].id !== "install") return;
        try { await P.api("/api/health", { timeout: 2000 }); status.textContent = "server found."; await P.findServer(true); if (connected()) return show(idx("test")); }
        catch (e) { status.textContent = /^401/.test(e.message) ? "server found — finishing in the tab the installer opens." : "not running yet."; }
        timer = setTimeout(look, 3000);
      };
      stopPoll(); timer = setTimeout(look, 1500);
    },

    async test() {
      if (!connected()) return render.install();
      const H = P.S.health.hardware || {};
      const g = (H.gpus || [])[0];
      const res = h("div", { role: "status" });
      const run = async () => {
        res.replaceChildren(h("p", { class: "small", text: "Sending a small test image to your server…" }));
        try {
          const cv = document.createElement("canvas"); cv.width = cv.height = 224;
          const c = cv.getContext("2d"); c.fillStyle = "#e6a3c4"; c.fillRect(0, 0, 224, 224);
          for (let i = 0; i < 300; i++) { c.fillStyle = "#5b3f8f"; c.beginPath(); c.arc(Math.random() * 224, Math.random() * 224, 3 + Math.random() * 4, 0, 7); c.fill(); }
          const blob = await new Promise(r => cv.toBlob(r, "image/png"));
          const fd = new FormData();
          fd.append("model_id", "phikon"); fd.append("task", "embed_tiles"); fd.append("params", "{}");
          fd.append("tiles", blob, "test.png"); fd.append("tiles", blob, "test2.png");
          const { id } = await P.api("/api/jobs", { method: "POST", body: fd });
          for (let i = 0; i < 60; i++) {
            const j = await P.api(`/api/jobs/${id}`);
            if (j.status === "done") { store.set("fm.wz.tested", "1"); res.replaceChildren(h("p", { class: "ok-text", text: `✓ Your server ran a test job${j.result && j.result.mock ? " in test mode" : ""}. The page and server can talk to each other.` })); frameNav(); return; }
            if (j.status === "error") throw new Error(j.error);
            await new Promise(r => setTimeout(r, 700));
          }
          throw new Error("The test job did not finish in time.");
        } catch (e) { res.replaceChildren(h("div", { class: "notice err small", text: clean(e).message })); }
      };
      const frameNav = () => frame(body, [back(), next()]);
      const body = [h("h2", { text: "Your server is connected" }),
        h("dl", { class: "kv small" },
          h("dt", { text: "Computer" }), h("dd", { text: `${H.os || "?"} · ${H.cpu_cores || "?"} CPU cores · ${H.ram_total_gb ? HW.gbFmt(H.ram_total_gb) + " RAM" : ""}` }),
          h("dt", { text: "GPU" }), h("dd", { text: g ? `${g.name} (${HW.gbFmt(g.vram_total_gb)})` : (H.driver_gpus || []).length ? `${H.driver_gpus[0].name} — PyTorch will be set up to use it` : "None found — models will run on the CPU" }),
          h("dt", { text: "Mode" }), h("dd", { text: P.S.health.mock ? "Test mode (synthetic outputs)" : "Real models" })),
        h("p", { text: "Next, a quick round trip to prove the page can send work to your server and read the result." }),
        h("button", { class: "btn", type: "button", onclick: run }, "Run a test job"), res];
      frame(body, [back(), store.get("fm.wz.tested") ? next() : skip()]);
      if (!store.get("fm.wz.tested")) run();
    },

    torch() { serverStep("torch", "PyTorch", "The deep-learning library every model needs. The installer matches it to this computer: the CUDA build if an NVIDIA driver is present, otherwise the CPU build.", gpuNote()); },
    trident() { serverStep("trident", "TRIDENT and the model encoders", "Mahmood Lab's toolkit for reading slides, finding tissue and loading the patch and slide encoders, plus CONCH, MUSK, GigaPath and OpenCLIP. Git is required for this step.", gitNote()); },

    async extras() {
      const st = await guardStatus(); if (!st) return;
      const opts = [["gigatime", "GigaTIME", "23-channel virtual immunofluorescence from H&E."],
        ["hex", "HEX", "48-marker virtual CODEX (uses MUSK)."], ["stpath", "STPath", "Predicted spatial gene expression (installs scanpy)."]];
      const boxes = opts.map(([id, name, d]) => {
        const done = (st.steps.find(s => s.id === id) || {}).done;
        return h("label", { class: "check" }, h("input", { type: "checkbox", value: id, checked: !done, disabled: done }), h("span", {}, h("strong", { text: name }), ` — ${d}`, done ? " ✓ installed" : ""));
      });
      const log = h("div");
      const runSel = async () => {
        const ids = boxes.map(b => b.querySelector("input")).filter(i => i.checked && !i.disabled).map(i => i.value);
        for (const id of ids) { const ok = await runTask(id, log); if (!ok) return; }
        store.set("fm.wz.extras", "1"); show(cur);
      };
      frame([h("h2", { text: "Extra models (optional)" }),
        h("p", { text: "These come from their own GitHub repositories. Pick the ones you'll use; you can add others later by reopening setup." }),
        h("div", { class: "wz-checks" }, boxes), log],
        [back(), nextBtn("Install selected", runSel), nextBtn("Skip", () => { store.set("fm.wz.extras", "1"); show(cur + 1); }, false)]);
    },

    async real() {
      const st = await guardStatus(); if (!st) return;
      const msg = h("div", { role: "status" });
      const go = async () => {
        busy = true;
        msg.replaceChildren(h("p", { class: "small", text: "Switching off test mode and restarting the server to load the new packages…" }));
        try {
          await setupApi("/mode", json({ mock: false }));
          await setupApi("/restart", { method: "POST" });
        } catch (e) { msg.replaceChildren(h("div", { class: "notice err small", text: e.message })); busy = false; return; }
        await new Promise(r => setTimeout(r, 2500));
        for (let i = 0; i < 60; i++) {
          try { await P.connect(); break; } catch { await new Promise(r => setTimeout(r, 1500)); }
        }
        busy = false;
        if (!connected()) return msg.replaceChildren(h("div", { class: "notice err small", text: "The server didn't come back. Look at its window for an error, then start it again with the start_server script." }));
        await refreshStatus();
        const ready = Object.values(P.S.ready).filter(v => v.ready).length;
        msg.replaceChildren(h("p", { class: "ok-text", text: `✓ Real models on. ${ready} of ${Object.keys(P.S.ready).length} models are ready on this server.` }),
          ready === 0 ? h("div", { class: "notice small", text: "None are ready yet — most models need step 5 (TRIDENT). Go back and install it, then switch again." }) : null);
        frame(body, [back(), next()]);
      };
      const missing = st.steps.filter(s => !s.optional && !s.done).map(s => s.title);
      const body = [h("h2", { text: "Switch to real models" }),
        missing.length ? h("div", { class: "notice small", text: `Still missing: ${missing.join(", ")}. You can switch anyway; those models stay unavailable.` }) : null,
        h("p", { text: "The server leaves test mode and restarts once so it picks up everything just installed. Its window shows the restart; this page reconnects by itself." }),
        h("button", { class: "btn", type: "button", onclick: go }, "Switch and restart"), msg];
      frame(body, [back(), P.S.health && !P.S.health.mock ? next() : skip()]);
    },

    async hf() {
      const st = await guardStatus(); if (!st) return;
      const tok = h("input", { type: "password", placeholder: "hf_…", autocomplete: "off", "aria-label": "Hugging Face access token" });
      const msg = h("div", { role: "status" });
      const save = async () => {
        msg.textContent = "Checking the token with Hugging Face…";
        try { const r = await setupApi("/hf_token", json({ token: tok.value })); tok.value = ""; await refreshStatus(); msg.replaceChildren(h("p", { class: "ok-text", text: `✓ Logged in as ${r.user}. The token is saved on your server, not in this page.` })); frame(body, [back(), next()]); }
        catch (e) { msg.replaceChildren(h("div", { class: "notice err small", text: e.message })); }
      };
      const body = [h("h2", { text: "Connect your Hugging Face account" }),
        st.hf_user ? h("p", { class: "ok-text", text: `✓ Your server is logged in as ${st.hf_user}.` }) : null,
        h("p", { text: "Most models are hosted on Hugging Face, and many are gated: you agree to their terms once, then your server downloads them with your token." }),
        h("ol", { class: "wz-list" },
          h("li", {}, "No account? ", h("a", { href: "https://huggingface.co/join", target: "_blank", rel: "noopener", text: "Create a free one" }), "."),
          h("li", {}, "Create a ", h("strong", { text: "Read" }), " token at ", h("a", { href: "https://huggingface.co/settings/tokens", target: "_blank", rel: "noopener", text: "huggingface.co/settings/tokens" }), "."),
          h("li", {}, "Paste it here. Never enter your Hugging Face password anywhere in this portal.")),
        h("div", { class: "wz-row" }, tok, h("button", { class: "btn", type: "button", onclick: save }, "Save token")), msg];
      frame(body, [back(), st.hf_user ? next() : skip("Skip for now")]);
    },

    async access() {
      if (!connected()) return render.install();
      await P.refreshWeights(true);
      const W = P.S.weights;
      const suit = P.S.reg.models.filter(m => m.runner && m.gated && ["good", "ok"].includes(P.fitFor(m).level));
      const repos = [...new Map(suit.flatMap(m => (W[m.id] ? W[m.id].parts : []).filter(p => p.repo && p.via === "hf").map(p => [p.repo, p]))).values()];
      const list = h("ul", { class: "wz-access" }, repos.map(p => h("li", {}, tick(p.access === "ok"), " ",
        h("a", { href: `https://huggingface.co/${p.repo}`, target: "_blank", rel: "noopener", text: p.repo }),
        h("span", { class: "small muted", text: p.access === "ok" ? " — access granted" : p.access === "no-access" ? " — request access" : "" }))));
      const msg = h("span", { class: "small", role: "status" });
      const check = async () => {
        msg.textContent = "Checking…";
        try { await P.api("/api/weights/access", { method: "POST" }); store.set("fm.wz.access", "1"); msg.textContent = ""; show(cur); }
        catch (e) { msg.textContent = e.message; }
      };
      frame([h("h2", { text: "Request access to gated models" }),
        h("p", { text: `${repos.length} gated repositories hold models that suit this computer. Open each link, sign in, and accept the terms — approval is usually instant, but some publishers review requests. Then check your access.` }),
        list, h("div", { class: "wz-row" }, h("button", { class: "btn ghost", type: "button", onclick: () => repos.filter(p => p.access !== "ok").slice(0, 8).forEach(p => window.open(`https://huggingface.co/${p.repo}`, "_blank", "noopener")) }, "Open the pages I still need"),
          h("button", { class: "btn", type: "button", onclick: check }, "Check my access"), msg)],
        [back(), store.get("fm.wz.access") ? next() : skip()]);
    },

    async slides() {
      const st = await guardStatus(); if (!st) return;
      const ta = h("textarea", { rows: 4, placeholder: /Windows/.test(st.os) ? "C:\\Users\\me\\Slides\nD:\\TCGA-GBM" : "/data/slides\n/home/me/TCGA-GBM", "aria-label": "Slide folders" });
      ta.value = (st.wsi_roots || []).join("\n");
      const msg = h("div", { role: "status" });
      const save = async () => {
        try { const r = await setupApi("/wsi_roots", json({ paths: ta.value.split("\n").map(s => s.trim()).filter(Boolean) })); store.set("fm.wz.slides", "1");
          msg.replaceChildren(h("p", { class: "ok-text", text: `✓ ${r.wsi_roots.length} folder${r.wsi_roots.length === 1 ? "" : "s"} allowed.` })); frame(body, [back(), next()]); }
        catch (e) { msg.replaceChildren(h("div", { class: "notice err small", text: e.message })); }
      };
      const body = [h("h2", { text: "Where are your slides?" }),
        h("p", { text: "Whole-slide images are often several GB, so instead of uploading them the server reads them from folders you allow here. Anything outside these folders stays off-limits." }),
        h("div", { class: "field" }, h("label", { text: "One folder per line, on the computer running the server" }), ta), h("button", { class: "btn", type: "button", onclick: save }, "Save folders"), msg];
      frame(body, [back(), skip()]);
    },

    async weights() {
      if (!connected()) return render.install();
      await P.refreshWeights(true);
      const W = P.S.weights;
      const pick = P.S.reg.models.filter(m => m.runner && W[m.id] && ["good", "ok"].includes(P.fitFor(m).level) &&
        ["missing", "partial", "unknown"].includes(W[m.id].overall) && W[m.id].parts.filter(p => p.via === "hf").every(p => p.access === "ok" || p.access === "unknown"));
      const seen = new Set();
      const gb = pick.reduce((a, m) => a + W[m.id].parts.filter(p => p.cached !== true && !seen.has(p.repo || p.model) && seen.add(p.repo || p.model)).reduce((x, p) => x + (p.gb || 0), 0), 0);
      const free = P.S.health.hardware && P.S.health.hardware.weights_disk_free_gb;
      const prog = h("div", { role: "status" });
      const start = async () => {
        if (free != null && gb > free) return prog.replaceChildren(h("div", { class: "notice err small", text: `Needs ${HW.gbFmt(gb)} but only ${HW.gbFmt(free)} is free.` }));
        for (const m of pick) await P.api(`/api/weights/${encodeURIComponent(m.id)}/download`, { method: "POST" });
        store.set("fm.wz.weights", "1");
        const poll = async () => {
          await P.refreshWeights(true);
          const all = pick.map(m => P.S.weights[m.id]);
          const doneN = all.filter(w => w.overall === "cached" || w.download === "done").length, errs = all.filter(w => w.download === "error");
          prog.replaceChildren(h("p", { class: "small", text: `${doneN} of ${pick.length} models downloaded${errs.length ? ` · ${errs.length} failed (see Connect → Model weights)` : ""}.` }),
            h("div", { class: "progress" }, h("i", { style: `width:${Math.max(3, doneN / Math.max(1, pick.length) * 100)}%` })));
          if (doneN + errs.length < pick.length && dlg().open) timer = setTimeout(poll, 2000);
        };
        poll();
      };
      frame([h("h2", { text: "Download model weights now" }),
        h("p", { text: pick.length ? `${pick.length} models suit this computer and you have access to them: ${HW.gbFmt(gb)} in total${free != null ? `, with ${HW.gbFmt(free)} free on the server` : ""}. Downloading now means your first run doesn't wait. Downloads continue if you close this window.` : "Nothing to download: either the weights are already here, or you still need access to the gated models." }),
        pick.length ? h("button", { class: "btn", type: "button", onclick: start }, `Download ${pick.length} models`) : null, prog],
        [back(), next()]);
    },

    async done() {
      const st = await refreshStatus();
      const msg = h("div", { role: "status" });
      const lock = async () => {
        try { await setupApi("/finish", { method: "POST" }); store.set("fm.wz.finished", "1"); msg.replaceChildren(h("p", { class: "ok-text", text: "✓ Setup locked. Reopen it any time by setting setup_enabled: true in config.yaml." })); }
        catch (e) { msg.replaceChildren(h("div", { class: "notice err small", text: e.message })); }
      };
      frame([h("h2", { text: "You're set up" }),
        h("p", { text: "Pick a model on the Models page, or go straight to Run. To start the server again later, run the start_server script in the backend folder (the installer printed the exact command)." }),
        h("p", { class: "small", text: "Locking setup turns off the install buttons on the server, so nothing can change its packages or config from a browser. Recommended once you're happy." }),
        h("div", { class: "wz-row" }, st && !st.error ? h("button", { class: "btn ghost", type: "button", onclick: lock }, "Lock setup") : null,
          h("button", { class: "btn", type: "button", onclick: () => { store.set("fm.wz.finished", "1"); close(); P.go("run"); } }, "Run a model")), msg]);
    },
  };

  function gpuNote() {
    const H = P && P.S.health && P.S.health.hardware;
    if (!H) return null;
    if ((H.driver_gpus || []).length) return `NVIDIA GPU found: ${H.driver_gpus[0].name}. The CUDA build will be installed.`;
    if (H.mps_available) return "Apple GPU found; the portal runs models on the CPU on Macs.";
    return "No NVIDIA GPU found, so the CPU build will be installed.";
  }
  function gitNote() { return lastStatus && !lastStatus.git ? "Git was not found on the server. Install it (git-scm.com), restart the server, then come back to this step." : null; }

  async function guardStatus() {
    if (!connected()) { render.install(); return null; }
    const st = await refreshStatus();
    if (st.error) {
      const off = /setup is off|403/.test(st.error);
      frame([h("h2", { text: STEPS[cur].title }),
        h("div", { class: "notice" + (off ? "" : " err"), text: off ? "Guided setup is turned off on this server. To use it, add  setup_enabled: true  to backend/config.yaml and restart the server — or follow SETUP.md by hand." : st.error })],
        [back(), skip()]);
      return null;
    }
    return st;
  }

  async function runTask(stepId, logBox) {
    const pre = h("div", { class: "log", "aria-live": "polite" });
    const head = h("p", { class: "small", text: `Running ${stepId}…` });
    logBox.replaceChildren(head, pre);
    try { await setupApi(`/run/${stepId}`, { method: "POST" }); }
    catch (e) { head.replaceChildren(h("span", { class: "notice err small", text: e.message })); return false; }
    busy = true;
    for (;;) {
      await new Promise(r => setTimeout(r, 1000));
      let t; try { t = await setupApi("/task"); } catch { continue; }
      pre.textContent = t.log.join("\n"); pre.scrollTop = pre.scrollHeight;
      if (t.status === "done") { head.textContent = `✓ ${stepId} installed.`; head.className = "small ok-text"; busy = false; return true; }
      if (t.status === "error") { head.textContent = `${stepId} failed — the log shows why. Fix it and press Install again.`; head.className = "small err-text"; busy = false; return false; }
    }
  }

  async function serverStep(id, title, what, note) {
    const st = await guardStatus(); if (!st) return;
    const s = st.steps.find(x => x.id === id);
    const log = h("div");
    const go = async () => { if (await runTask(id, log)) { await refreshStatus(); frame(body(true), [back(), next()]); } };
    const body = done => [h("h2", { text: title }), h("p", { text: what }),
      note ? h("div", { class: "notice info small", text: note }) : null,
      done ? h("p", { class: "ok-text", text: "✓ Installed on your server." }) : null,
      h("button", { class: done ? "btn ghost" : "btn", type: "button", onclick: go }, done ? "Reinstall / update" : `Install ${title.split(" ")[0]}`),
      h("p", { class: "small muted", text: `Runs on your server, inside its own Python environment (${st.python_path}). The full log appears below.` }), log];
    frame(body(s.done), [back(), s.done ? next() : skip()]);
  }

  // ── open / close ───────────────────────────────────────────────────────
  async function show(i) {
    stopPoll();
    cur = Math.max(0, Math.min(STEPS.length - 1, i));
    store.set("fm.wz.step", String(cur));
    if (!dlg().open) dlg().showModal();
    await render[STEPS[cur].id]();
  }
  function close() {
    if (busy && !confirm("A step is still running on your server. Close this window anyway? It keeps running there.")) return;
    stopPoll(); dlg().close();
  }
  async function open(fromInstaller) {
    if (connected()) {
      await refreshStatus();
      const c = completion();
      const first = STEPS.findIndex((s, i) => i >= idx("test") && !c[s.id]);
      return show(fromInstaller ? idx("test") : first < 0 ? idx("done") : first);
    }
    show(0);
  }

  window.addEventListener("portal-ready", e => {
    P = window.Portal;
    const from = e.detail && e.detail.wizardFrom;
    if (from === "installer") { open(true); return; }
    // First visit with no server: offer setup once, gently.
    if (!store.get("fm.wz.seen") && !connected() && !store.get("fm.mode")) {
      store.set("fm.wz.seen", "1");
      setTimeout(() => { if (!document.querySelector("dialog[open]")) show(0); }, 1200);
    }
  });
  window.Wizard = { open: () => open(false) };
})();
