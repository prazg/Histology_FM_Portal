/* Histology FM Portal — static front end. Talks to backend/server.py, or runs in demo mode. */
(function () {
  "use strict";
  const { h } = Viewers;
  const $ = s => document.querySelector(s);
  const FAM_ORDER = ["patch", "vl", "slide", "vmif", "st", "seg"];
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); (session ? localStorage : sessionStorage).removeItem(k); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* */ } },
  };

  const S = {
    reg: null, byId: {}, conn: { mode: store.get("fm.mode", "demo"), url: store.get("fm.url", "http://127.0.0.1:8000"), key: store.get("fm.key", ""), hf: "" },
    health: null, ready: {}, connected: false, jobs: [], demoJobs: [], selJob: null, poll: null,
    filt: { fam: null, q: "", commercial: false, ungated: false, ready: false },
    run: { model: null, task: null, src: "path", tiles: [] },
  };
  try { S.conn.hf = sessionStorage.getItem("fm.hf") || ""; } catch { /* */ }

  // ── API ──────────────────────────────────────────────────────────────
  const base = () => S.conn.url.replace(/\/+$/, "");
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (S.conn.key) headers["X-Portal-Key"] = S.conn.key;
    let r;
    try { r = await fetch(base() + path, Object.assign({}, opts, { headers })); }
    catch (e) { throw new Error(`Cannot reach ${base()}. Is the server running, and is this page's origin listed in 'origins'?`); }
    if (!r.ok) {
      let msg = r.statusText;
      try { const j = await r.json(); msg = j.detail || msg; } catch { /* */ }
      throw new Error(`${r.status}: ${msg}`);
    }
    return r.json();
  }
  const fileUrl = (jobId, name) => {
    if (String(jobId).startsWith("demo")) return Demo.file(jobId, name);
    const q = S.conn.key ? `?key=${encodeURIComponent(S.conn.key)}` : "";
    return `${base()}/api/jobs/${jobId}/files/${encodeURIComponent(name)}${q}`;
  };
  const channel = (jobId, pid, idx) => {
    if (String(jobId).startsWith("demo")) return Demo.channel(jobId, pid, idx);
    return api(`/api/jobs/${jobId}/spatial/${pid}/${idx}`);
  };

  // ── routing ──────────────────────────────────────────────────────────
  function route() {
    const [view, arg] = (location.hash.slice(1) || "models").split("/");
    const v = ["models", "run", "results", "connect"].includes(view) ? view : "models";
    document.querySelectorAll("main > section").forEach(s => (s.hidden = s.id !== "view-" + v));
    document.querySelectorAll("nav.tabs button").forEach(b => b.dataset.view === v ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
    if (v === "run") { if (arg && S.byId[decodeURIComponent(arg)]) selectModel(decodeURIComponent(arg)); else if (!S.run.model) selectModel(S.reg.models.find(m => m.runner)?.id); }
    if (v === "results") { if (arg) S.selJob = decodeURIComponent(arg); refreshJobs(); }
    if (v === "connect") renderConnect();
    window.scrollTo({ top: 0 });
  }
  const go = (hash) => { if (location.hash === "#" + hash) route(); else location.hash = hash; };
  document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => go(b.dataset.view)));

  // ── theme ────────────────────────────────────────────────────────────
  const savedTheme = store.get("fm.theme", "");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("#themeBtn").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    store.set("fm.theme", document.documentElement.dataset.theme);
    route();
    if (!$("#view-models").hidden) renderRack();
  });

  // ── catalogue ────────────────────────────────────────────────────────
  const famLabel = c => S.reg.categories[c].label;
  const commercial = m => !!m.commercial_use;
  const isReady = m => S.conn.mode === "demo" ? !!m.runner : !!(S.ready[m.id] && S.ready[m.id].ready);

  function outputSummary(m) {
    if (m.category === "vmif") return `${(m.channels || []).length} markers`;
    if (m.category === "st") return "Gene expression per spot";
    if (m.category === "seg") return "Tissue contours";
    if (m.category === "slide") return `1 vector / slide (from ${m.patch_encoder})`;
    return m.embed_dim ? `${m.embed_dim}-d embedding` : "Embedding";
  }
  function inputSummary(m) {
    if (m.id === "hex_nolan48") return "56 µm patches → 384 px";
    if (m.id === "stpath") return "55 µm spots, 100 µm pitch";
    if (m.category === "seg") return "Whole slide";
    return m.patch_size ? `${m.patch_size} px @ ${m.mag}x` : "—";
  }
  function licenceBadge(m) {
    return h("span", { class: "badge " + (commercial(m) ? "free" : "nc"), title: m.licence }, commercial(m) ? m.licence : "Non-commercial");
  }

  function slideCard(m) {
    const ready = S.connected || S.conn.mode === "demo" ? isReady(m) : null;
    const tasks = (m.tasks || []).map(t => S.reg.tasks[t].label).join(" · ") || "Catalogue entry — no runner yet";
    const el = h("button", { class: `slide fam-${m.category}`, type: "button", "data-ready": ready === false ? "no" : "yes", "aria-label": `${m.name} — details` },
      h("span", { class: "label" },
        h("span", { class: "nm", text: m.name }), h("span", { class: "dev", text: m.developer }),
        h("span", { class: "badges" }, licenceBadge(m), m.gated ? h("span", { class: "badge", title: "Request access on Hugging Face" }, "Access request") : null,
          ready && S.conn.mode === "server" ? h("span", { class: "badge ready" }, "Ready") : null)),
      h("span", { class: "specimen" },
        h("dl", {}, h("dt", { text: "Output" }), h("dd", { text: outputSummary(m) }), h("dt", { text: "Input" }), h("dd", { text: inputSummary(m) })),
        h("span", { class: "tasks", text: tasks })));
    el.addEventListener("click", () => openDrawer(m));
    return el;
  }

  function filtered() {
    const f = S.filt, q = f.q.toLowerCase();
    return S.reg.models.filter(m =>
      (!f.fam || m.category === f.fam) && (!f.commercial || commercial(m)) && (!f.ungated || !m.gated) && (!f.ready || isReady(m)) &&
      (!q || [m.name, m.developer, m.licence, m.hf_repo, m.id].join(" ").toLowerCase().includes(q)));
  }

  function renderFamilies() {
    const counts = Object.fromEntries(FAM_ORDER.map(c => [c, S.reg.models.filter(m => m.category === c).length]));
    $("#famList").replaceChildren(
      h("li", {}, h("button", { "aria-pressed": String(!S.filt.fam), onclick: () => { S.filt.fam = null; renderFamilies(); renderRack(); } },
        h("span", { class: "sw", style: "background:linear-gradient(135deg,var(--haem),var(--eosin))" }), "All families", h("span", { class: "n", text: S.reg.models.length }))),
      ...FAM_ORDER.map(c => h("li", {}, h("button", { "aria-pressed": String(S.filt.fam === c), onclick: () => { S.filt.fam = S.filt.fam === c ? null : c; renderFamilies(); renderRack(); } },
        h("span", { class: "sw", style: `background:var(--c-${c})` }), famLabel(c), h("span", { class: "n", text: counts[c] })))));
  }

  function renderRack() {
    const list = filtered();
    const rack = $("#rack");
    if (!list.length) { rack.replaceChildren(h("div", { class: "empty" }, "No models match these filters. ", h("button", { class: "btn ghost small", onclick: resetFilters }, "Clear filters"))); return; }
    rack.replaceChildren(...FAM_ORDER.filter(c => list.some(m => m.category === c)).map(c =>
      h("div", { class: "fam-block" },
        h("div", { class: "fam-head" }, h("span", { class: "sw", style: `background:var(--c-${c})` }), h("h2", { text: famLabel(c) }), h("p", { text: S.reg.categories[c].blurb })),
        h("div", { class: "rack" }, list.filter(m => m.category === c).map(slideCard)))));
  }
  function resetFilters() {
    Object.assign(S.filt, { fam: null, q: "", commercial: false, ungated: false, ready: false });
    $("#q").value = ""; ["#fCommercial", "#fUngated", "#fReady"].forEach(s => ($(s).checked = false));
    renderFamilies(); renderRack();
  }
  $("#q").addEventListener("input", e => { S.filt.q = e.target.value; renderRack(); });
  $("#fCommercial").addEventListener("change", e => { S.filt.commercial = e.target.checked; renderRack(); });
  $("#fUngated").addEventListener("change", e => { S.filt.ungated = e.target.checked; renderRack(); });
  $("#fReady").addEventListener("change", e => { S.filt.ready = e.target.checked; renderRack(); });

  function renderCounts() {
    const M = S.reg.models;
    $("#counts").replaceChildren(
      h("div", {}, h("b", { text: M.filter(m => m.runner).length }), "runnable models"),
      h("div", {}, h("b", { text: M.filter(m => !m.gated).length }), "no access request"),
      h("div", {}, h("b", { text: M.filter(commercial).length }), "commercial-use licences"));
    $("#regDate").textContent = S.reg.version;
  }

  // ── drawer ───────────────────────────────────────────────────────────
  function openDrawer(m) {
    const d = $("#drawer");
    const st = S.ready[m.id];
    const rows = [
      ["Family", famLabel(m.category)], ["Developer", m.developer], ["Output", outputSummary(m)], ["Input", inputSummary(m)],
      ["Licence", m.licence], ["Access", m.gated ? "Gated — request access on Hugging Face, then log in on the server" : "Open download"],
      ["Weights", m.link ? h("a", { href: m.link, target: "_blank", rel: "noopener" }, m.hf_repo || m.link) : "—"],
      m.trident_name ? ["TRIDENT name", h("code", { text: m.trident_name })] : null,
      m.patch_encoder ? ["Patch encoder", h("code", { text: m.patch_encoder })] : null,
      ["Verified against", (m.source || "").split("+").map(k => S.reg.verified_against[k] || k).join("; ")],
      S.connected ? ["On your server", st ? (st.ready ? "Ready" : st.reason) : "—"] : null,
    ].filter(Boolean);
    d.replaceChildren(
      h("div", { class: `drawer-head fam-${m.category}` },
        h("p", { class: "small muted", style: "margin:0 0 4px", text: famLabel(m.category) }), h("h2", { id: "drawerTitle", text: m.name }),
        h("button", { class: "icon-btn close-x", "aria-label": "Close", onclick: () => d.close() }, "✕")),
      h("div", { class: "drawer-body" },
        h("dl", { class: "kv" }, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)])),
        m.notes ? h("div", { class: "notice info", text: m.notes }) : null,
        m.channels ? h("details", {}, h("summary", { text: `${m.channels.length} output channels` }), h("p", { class: "small", text: m.channels.join(", ") })) : null,
        (m.tasks || []).length ? h("div", {}, h("h3", { text: "Tasks and outputs", style: "margin-bottom:8px" }),
          h("ul", { class: "small", style: "margin:0;padding-left:1.1em" }, m.tasks.map(t => h("li", {}, h("strong", { text: S.reg.tasks[t].label }), " — ", S.reg.tasks[t].outputs.join("; "))))) : null,
        m.runner ? h("div", {}, h("button", { class: "btn", onclick: () => { d.close(); go("run/" + encodeURIComponent(m.id)); } }, `Run ${m.name}`)) : null));
    d.showModal();
  }
  $("#drawer").addEventListener("click", e => { if (e.target.id === "drawer") e.target.close(); });

  // ── run form ─────────────────────────────────────────────────────────
  const PRESETS = {
    "Glioblastoma regions (Ivy GAP-style)": "cellular tumour: densely cellular glioblastoma | hypercellular glioma tissue\nnecrosis: necrotic tissue | pseudopalisading necrosis\nmicrovascular proliferation: microvascular proliferation | glomeruloid blood vessels\ninfiltrating tumour: tumour cells infiltrating brain parenchyma\nnormal brain: normal brain tissue | normal cerebral cortex",
    "Tumour microenvironment compartments": "tumour: tumour cells\nstroma: fibrous stroma | extracellular matrix\nimmune infiltrate: lymphocytes | immune cell infiltrate\nmacrophages: macrophages | foamy histiocytes\nnecrosis: necrosis\nvessels: blood vessels",
    "Tumour vs normal": "tumour: malignant tumour tissue\nnormal: normal tissue",
  };
  const PARAMS = {
    k: { label: "Clusters (k-means)", type: "number", min: 2, max: 12, def: 6 },
    mag: { label: "Magnification", type: "number", min: 5, max: 40, hint: "Model default shown. Changing it usually degrades features." },
    patch_size: { label: "Patch size (px)", type: "number", min: 64, max: 1024 },
    min_tissue: { label: "Min tissue per patch", type: "number", min: 0, max: 1, step: .05, def: .5 },
    max_patches: { label: "Max patches (0 = all)", type: "number", min: 0, def: 0, hint: "Subsamples the grid evenly for a quick look." },
    segmenter: { label: "Tissue segmenter", type: "select", options: ["hest", "grandqc", "otsu"], def: "hest" },
    mpp: { label: "µm per pixel override", type: "number", step: .0001, hint: "Only if the slide lacks mpp metadata." },
    batch_size: { label: "Batch size", type: "number", min: 1, def: 64 },
    topk_frac: { label: "Top-k fraction for slide score", type: "number", min: .01, max: 1, step: .01, def: .05 },
    max_tile_maps: { label: "Tiles with full maps", type: "number", min: 1, max: 64, def: 12 },
    footprint_um: { label: "Patch footprint (µm)", type: "number", min: 20, max: 200, def: 56, hint: "Physical size of each HEX patch at level 0." },
    genes: { label: "Genes to map", type: "textarea", def: "GFAP, SOX2, OLIG2, EGFR, CD44, CHI3L1, VIM, MKI67, PTPRC, CD68, CD163, AIF1, CD3E, CD8A, PECAM1, VEGFA, COL1A1, COL4A1, FN1, POSTN", hint: "HGNC symbols; the full prediction is in the .h5ad." },
    organ: { label: "Organ", type: "text", def: "Brain", hint: "Must match STPath's organ vocabulary (stpath/utils/constants.py); blank = unknown." },
    tech: { label: "Technology", type: "text", def: "Visium", hint: "From STPath's tech vocabulary; blank = unknown." },
    pitch_um: { label: "Spot pitch (µm)", type: "number", def: 100 }, spot_um: { label: "Spot diameter (µm)", type: "number", def: 55 },
    max_spots: { label: "Max spots", type: "number", def: 3000 },
  };
  const WSI_COMMON = ["segmenter", "min_tissue", "max_patches", "mpp"];
  function taskParams(m, t) {
    switch (t) {
      case "embed_tiles": return ["k"];
      case "embed_wsi": return ["mag", "patch_size", "k", ...WSI_COMMON, "batch_size"];
      case "zeroshot_tiles": return ["classes"];
      case "zeroshot_wsi": return ["classes", "mag", "patch_size", "topk_frac", ...WSI_COMMON];
      case "slide_embed": return WSI_COMMON;
      case "slide_zeroshot": return ["classes", ...WSI_COMMON];
      case "vmif_tiles": return m.runner === "gigatime" ? ["max_tile_maps"] : [];
      case "vmif_wsi": return m.runner === "hex" ? ["footprint_um", ...WSI_COMMON, "batch_size"] : ["mag", ...WSI_COMMON];
      case "st_wsi": return ["genes", "organ", "tech", "pitch_um", "spot_um", "max_spots", "segmenter", "min_tissue", "mpp"];
      case "segment_wsi": return ["mpp"];
      default: return [];
    }
  }

  function fillModelSelect() {
    const sel = $("#rModel");
    sel.replaceChildren(...FAM_ORDER.map(c => h("optgroup", { label: famLabel(c) },
      S.reg.models.filter(m => m.category === c && m.runner).map(m => h("option", { value: m.id, text: m.name })))));
    sel.addEventListener("change", () => selectModel(sel.value));
  }

  function selectModel(id) {
    if (!id) return;
    const m = S.byId[id];
    S.run.model = m;
    $("#rModel").value = id;
    if (!m.tasks.includes(S.run.task)) S.run.task = m.tasks[0];
    const st = S.ready[id];
    $("#rModelHint").textContent = S.conn.mode === "demo" ? "Demo mode — output will be synthetic."
      : !S.connected ? "Not connected — open Connect first." : st && !st.ready ? `Not ready on your server: ${st.reason}` : "Ready on your server.";
    $("#rTasks").replaceChildren(...m.tasks.map(t => h("button", { type: "button", "aria-pressed": String(t === S.run.task), onclick: () => { S.run.task = t; selectModel(id); } }, S.reg.tasks[t].label)));
    const task = S.reg.tasks[S.run.task];
    $("#rTaskDesc").textContent = "You get: " + task.outputs.join(" · ");
    const tiles = task.input === "tiles";
    $("#tileInput").hidden = !tiles; $("#wsiInput").hidden = tiles;
    $("#rInputTitle").textContent = tiles ? "Tiles" : "Whole slide";
    renderParams(m, S.run.task);
    renderAside(m, S.run.task);
  }

  function renderParams(m, t) {
    const box = $("#rParams");
    const keys = taskParams(m, t);
    if (!keys.length) { box.replaceChildren(h("p", { class: "muted small", text: "No settings — this model's preprocessing is fixed." })); return; }
    const kids = [];
    for (const k of keys) {
      if (k === "classes") {
        const ta = h("textarea", { id: "p_classes", spellcheck: "false", "aria-describedby": "p_classes_h" });
        ta.value = PRESETS["Glioblastoma regions (Ivy GAP-style)"];
        kids.push(h("div", { class: "field" }, h("label", { for: "p_classes", text: "Classes and prompts" }),
          h("div", { class: "chips" }, Object.keys(PRESETS).map(p => h("button", { type: "button", class: "btn ghost small", onclick: () => (ta.value = PRESETS[p]) }, p))),
          ta, h("span", { class: "hint", id: "p_classes_h", text: "One class per line: name: prompt | another prompt. Prompts per class are averaged. Wording changes results — try a few." })));
        continue;
      }
      const d = PARAMS[k];
      let def = d.def;
      if (k === "mag") def = m.mag; if (k === "patch_size") def = m.patch_size;
      if (k === "max_patches" && t === "vmif_wsi" && m.runner === "gigatime") def = 3000;
      const id = "p_" + k;
      let input;
      if (d.type === "select") input = h("select", { id }, d.options.map(o => h("option", { value: o, text: o })));
      else if (d.type === "textarea") input = h("textarea", { id, style: "min-height:70px" });
      else input = h("input", { id, type: d.type, min: d.min, max: d.max, step: d.step || "any" });
      if (def !== undefined && def !== null) input.value = def;
      input.dataset.param = k;
      kids.push(h("div", { class: "field" }, h("label", { for: id, text: d.label }), input, d.hint ? h("span", { class: "hint", text: d.hint }) : null));
    }
    const main = kids.filter((_, i) => ["classes", "genes", "k", "footprint_um", "organ", "tech", "max_tile_maps", "max_patches"].includes(keys[i]));
    const adv = kids.filter(x => !main.includes(x));
    box.replaceChildren(...main, adv.length ? h("details", {}, h("summary", { text: "Slide processing settings" }), h("div", { class: "row2", style: "margin-top:10px" }, adv)) : "");
  }

  function collectParams() {
    const p = {};
    document.querySelectorAll("#rParams [data-param]").forEach(el => {
      if (el.value === "") return;
      p[el.dataset.param] = el.type === "number" ? Number(el.value) : el.value;
    });
    const c = $("#p_classes"); if (c) p.classes = c.value;
    return p;
  }

  function cliFor(m, t) {
    const wsi = S.reg.tasks[t].input === "wsi";
    if (m.category === "slide") return `python run_batch_of_slides.py --task all --wsi_dir ./wsis --job_dir ./out \\\n  --slide_encoder ${m.trident_name} --patch_size ${m.patch_size} --mag ${m.mag}`;
    if (m.runner === "trident_patch" && wsi) return `python run_batch_of_slides.py --task all --wsi_dir ./wsis --job_dir ./out \\\n  --patch_encoder ${m.trident_name} --patch_size ${m.patch_size} --mag ${m.mag}`;
    if (m.runner === "trident_patch") return `from trident.patch_encoder_models import encoder_factory\nenc = encoder_factory("${m.trident_name}").eval().to("cuda")\nx = torch.stack([enc.eval_transforms(im) for im in tiles]).to("cuda")\nwith torch.inference_mode():\n    feats = enc(x)   # [N, ${m.embed_dim}]`;
    if (m.runner === "trident_seg") return `python run_batch_of_slides.py --task seg --wsi_dir ./wsis --job_dir ./out --segmenter ${m.trident_name}`;
    if (m.runner === "hex") return `python hex/infer_slide_h5_nolan48.py --wsi slide.svs --coord-h5 coords.h5 \\\n  --checkpoint hex_nolan48.pt --output-h5 hex_pred.h5`;
    return null;
  }

  function renderAside(m, t) {
    const cli = cliFor(m, t);
    const kids = [
      h("div", { class: "card" }, h("h3", { text: "What you'll get" }), h("ul", { class: "small" }, S.reg.tasks[t].outputs.map(o => h("li", { text: o })))),
      h("div", { class: commercial(m) ? "notice info" : "notice" },
        h("strong", { text: m.licence + ". " }), commercial(m) ? "Check the model card for attribution terms." : "Academic, non-commercial use only. ",
        m.gated ? h("span", {}, "You need approved access to ", h("a", { href: m.link, target: "_blank", rel: "noopener", text: m.hf_repo }), " on Hugging Face.") : null),
    ];
    if (m.notes) kids.push(h("div", { class: "card small" }, h("h3", { text: "Model notes" }), h("p", { style: "margin:0", text: m.notes })));
    if (cli) kids.push(h("div", { class: "card" }, h("h3", { text: "Reproduce outside the portal" }), h("pre", { class: "cli", text: cli })));
    $("#runAside").replaceChildren(...kids);
  }

  // inputs
  const drop = $("#drop"), tf = $("#tileFiles");
  function setTiles(files) {
    S.run.tiles = [...files].filter(f => /^image\//.test(f.type) || /\.(tif|tiff)$/i.test(f.name));
    $("#tileThumbs").replaceChildren(...S.run.tiles.slice(0, 40).map(f => h("img", { src: URL.createObjectURL(f), alt: f.name, title: f.name })),
      S.run.tiles.length > 40 ? h("span", { class: "small muted", text: `+${S.run.tiles.length - 40} more` }) : "");
  }
  tf.addEventListener("change", () => setTiles(tf.files));
  drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tf.click(); } });
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => setTiles(e.dataTransfer.files));
  document.querySelectorAll("#wsiInput [data-src]").forEach(b => b.addEventListener("click", () => {
    S.run.src = b.dataset.src;
    document.querySelectorAll("#wsiInput [data-src]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    $("#wsiPathField").hidden = S.run.src !== "path"; $("#wsiUploadField").hidden = S.run.src !== "upload";
  }));

  $("#runForm").addEventListener("submit", async e => {
    e.preventDefault();
    const m = S.run.model, t = S.run.task, msg = $("#runMsg"), btn = $("#runBtn");
    const tiles = S.reg.tasks[t].input === "tiles";
    msg.textContent = ""; msg.style.color = "";
    const params = collectParams();
    const fail = text => { msg.textContent = text; msg.style.color = "var(--err)"; };
    if (S.conn.mode === "demo") {
      btn.disabled = true; msg.textContent = "Generating synthetic output…";
      try {
        const job = await Demo.run(m, t, params, tiles ? S.run.tiles : null, tiles ? null : $("#wsiFile").files[0]);
        S.demoJobs.unshift(job); msg.textContent = ""; go("results/" + job.id);
      } catch (err) { fail(err.message); } finally { btn.disabled = false; }
      return;
    }
    if (!S.connected) return fail("Connect to a backend first (or switch to demo mode).");
    const fd = new FormData();
    fd.append("model_id", m.id); fd.append("task", t); fd.append("params", JSON.stringify(params));
    if (tiles) { if (!S.run.tiles.length) return fail("Add at least one tile."); S.run.tiles.forEach(f => fd.append("tiles", f, f.name)); }
    else if (S.run.src === "path") { const p = $("#wsiPath").value.trim(); if (!p) return fail("Enter a slide path on the server."); fd.append("wsi_path", p); }
    else { const f = $("#wsiFile").files[0]; if (!f) return fail("Choose a slide file."); fd.append("wsi", f, f.name); }
    btn.disabled = true; msg.textContent = tiles ? "Uploading tiles…" : "Submitting…";
    try {
      const headers = S.conn.hf ? { "X-HF-Token": S.conn.hf } : {};
      const r = await api("/api/jobs", { method: "POST", body: fd, headers });
      msg.textContent = "Queued."; go("results/" + r.id);
    } catch (err) { fail(err.message); } finally { btn.disabled = false; }
  });

  // ── results ──────────────────────────────────────────────────────────
  const taskLabel = t => (S.reg.tasks[t] || {}).label || t;
  const dotFor = st => st === "done" ? "ok" : st === "error" ? "err" : st === "running" ? "run" : "";
  const when = ts => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  async function refreshJobs() {
    if (S.conn.mode === "server" && S.connected) {
      try { S.jobs = await api("/api/jobs"); } catch (e) { S.jobs = []; }
    }
    const all = S.conn.mode === "demo" ? S.demoJobs : S.jobs;
    if (!S.selJob && all[0]) S.selJob = all[0].id;
    $("#jobList").replaceChildren(...(all.length ? all.map(j => h("li", {}, h("button", { "aria-current": String(j.id === S.selJob), onclick: () => go("results/" + j.id) },
      h("span", { class: "dot " + dotFor(j.status) }), h("span", { class: "t", text: (S.byId[j.model_id] || {}).name || j.model_id }),
      h("span", { class: "s", text: `${taskLabel(j.task)} · ${j.status} · ${when(j.created)}` })))) :
      [h("li", { class: "small muted", style: "padding:8px 10px" }, "No jobs yet. ", h("a", { href: "#run", text: "Run a model" }))]));
    showJob();
    const running = all.some(j => j.status === "queued" || j.status === "running");
    clearTimeout(S.poll);
    if (running && !$("#view-results").hidden) S.poll = setTimeout(refreshJobs, 1500);
  }
  $("#refreshJobs").addEventListener("click", refreshJobs);

  let shownKey = "";
  async function showJob() {
    const box = $("#jobView");
    if (!S.selJob) { box.replaceChildren(h("div", { class: "empty" }, "Results appear here after you run a model.")); shownKey = ""; return; }
    let j;
    if (String(S.selJob).startsWith("demo")) j = S.demoJobs.find(x => x.id === S.selJob);
    else { try { j = await api(`/api/jobs/${S.selJob}`); } catch (e) { box.replaceChildren(h("div", { class: "notice err", text: e.message })); return; } }
    if (!j) { box.replaceChildren(h("div", { class: "empty", text: "That job is not on this server (jobs are kept until the server restarts)." })); return; }
    const key = `${j.id}:${j.status}:${j.status === "running" || j.status === "queued" ? j.progress + j.stage : ""}`;
    if (key === shownKey) return;
    shownKey = key;
    const m = S.byId[j.model_id] || { name: j.model_id, category: "patch" };
    const head = h("div", { class: "job-head" }, h("h2", { text: m.name }), h("span", { class: "muted", text: taskLabel(j.task) }),
      h("span", { class: "small muted", text: `Job ${j.id} · ${when(j.created)}` }),
      !String(j.id).startsWith("demo") && j.status !== "running" ? h("button", { class: "btn ghost small", style: "margin-left:auto", onclick: async () => {
        await api(`/api/jobs/${j.id}`, { method: "DELETE" }); S.selJob = null; refreshJobs(); } }, "Delete job") : null);
    const kids = [head];
    if (j.status === "queued" || j.status === "running") {
      kids.push(h("div", { class: "progress", role: "progressbar", "aria-valuenow": Math.round(j.progress * 100), "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: `width:${Math.max(3, j.progress * 100)}%` })),
        h("p", { class: "muted", text: j.stage }), h("div", { class: "log", text: j.log.slice(-12).join("\n") }));
    } else if (j.status === "error") {
      kids.push(h("div", { class: "notice err" }, h("strong", { text: "The job failed. " }), j.error), h("details", { open: true }, h("summary", { text: "Server log" }), h("div", { class: "log", text: j.log.join("\n") })));
    } else if (j.result) {
      const r = j.result;
      if (r.demo) kids.push(h("div", { class: "demo-banner" }, h("strong", { text: "Synthetic demo output. " }), "Generated in your browser to show the layout. No model ran — connect a backend for real results."));
      else if (r.mock) kids.push(h("div", { class: "demo-banner" }, h("strong", { text: "Mock server output. " }), "The backend is in mock mode (deterministic stand-ins, no weights). Not model output."));
      kids.push(h("div", { class: "summary" }, r.summary.map(s => h("div", {}, h("b", { text: String(s.value) }), s.label))));
      const ctx = { file: name => fileUrl(j.id, name), channel: (pid, i) => channel(j.id, pid, i) };
      kids.push(h("div", { class: "panels" }, r.panels.map(p => Viewers.render(p, ctx))));
      if (r.files && r.files.length) kids.push(h("div", { style: "margin-top:22px" }, h("h3", { text: "Downloads", style: "margin-bottom:8px" }),
        h("div", { class: "files" }, r.files.map(f => h("a", { href: fileUrl(j.id, f.name), download: f.name }, h("strong", { text: f.name }), h("span", { text: `${f.label} · ${(f.size / 1048576).toFixed(f.size > 1048576 ? 1 : 3)} MB` }))))));
      kids.push(h("details", { style: "margin-top:16px" }, h("summary", { text: "Run log and parameters" }), h("div", { class: "log", text: j.log.join("\n") + "\n\nparams: " + JSON.stringify(j.params, null, 1) })));
    }
    box.replaceChildren(...kids);
  }

  // ── connect ──────────────────────────────────────────────────────────
  function setPill(state, text) { $("#connDot").className = "dot " + state; $("#connText").textContent = text; }
  function renderConnect() {
    document.querySelectorAll("#connForm [name=mode]").forEach(r => (r.checked = r.value === S.conn.mode));
    $("#serverFields").hidden = S.conn.mode !== "server";
    $("#cUrl").value = S.conn.url; $("#cKey").value = S.conn.key; $("#cHf").value = S.conn.hf;
    $("#cRemember").checked = (() => { try { return !!localStorage.getItem("fm.key"); } catch { return false; } })();
    renderStatus();
  }
  document.querySelectorAll("#connForm [name=mode]").forEach(r => r.addEventListener("change", () => { $("#serverFields").hidden = r.value !== "server" || !r.checked; }));

  function renderStatus() {
    const box = $("#serverStatus");
    if (S.conn.mode === "demo") { box.replaceChildren(h("h3", { text: "Demo mode" }), h("p", { class: "small muted", text: "Outputs are generated in the browser and clearly marked as synthetic. Switch to My server for real inference." })); return; }
    if (!S.health) { box.replaceChildren(h("h3", { text: "Server status" }), h("p", { class: "muted small", text: "Connect to see GPU, packages and which models are ready." })); return; }
    const H = S.health, ready = Object.entries(S.ready);
    const notReady = ready.filter(([, v]) => !v.ready);
    box.replaceChildren(h("h3", { text: "Server status" }),
      h("dl", { class: "kv small" }, h("dt", { text: "Device" }), h("dd", { text: H.gpu ? `${H.device} — ${H.gpu}` : H.device }),
        h("dt", { text: "Mode" }), h("dd", { text: H.mock ? "Mock (synthetic outputs)" : "Real inference" }),
        h("dt", { text: "Models ready" }), h("dd", { text: `${ready.length - notReady.length} of ${ready.length}` }),
        h("dt", { text: "Slide folders" }), h("dd", { text: H.wsi_roots.length ? H.wsi_roots.join(", ") : "None — uploads only" })),
      h("div", { class: "status-grid", style: "margin-top:12px" }, Object.entries(H.packages).map(([k, v]) => h("span", {}, h("span", { class: "dot " + (v ? "ok" : "warn") }), k))),
      notReady.length ? h("details", { style: "margin-top:12px" }, h("summary", { text: `${notReady.length} models need setup` }),
        h("ul", { class: "small", style: "padding-left:1.1em" }, notReady.map(([id, v]) => h("li", {}, h("strong", { text: (S.byId[id] || {}).name || id }), ": ", v.reason)))) : null);
  }

  async function connect() {
    if (S.conn.mode === "demo") { S.connected = false; S.health = null; S.ready = {}; setPill("warn", "Demo mode"); return true; }
    setPill("", "Connecting…");
    try {
      S.health = await api("/api/health");
      S.ready = await api("/api/models");
      S.connected = true;
      const n = Object.values(S.ready).filter(v => v.ready).length;
      setPill(S.health.mock ? "warn" : "ok", `${S.health.mock ? "Mock server" : S.health.gpu ? "GPU server" : "CPU server"} · ${n} ready`);
      return true;
    } catch (e) {
      S.connected = false; S.health = null; S.ready = {};
      setPill("err", "Not connected");
      throw e;
    }
  }
  $("#connForm").addEventListener("submit", async e => {
    e.preventDefault();
    S.conn.mode = document.querySelector("#connForm [name=mode]:checked").value;
    S.conn.url = $("#cUrl").value.trim() || "http://127.0.0.1:8000";
    S.conn.key = $("#cKey").value; S.conn.hf = $("#cHf").value.trim();
    store.set("fm.mode", S.conn.mode); store.set("fm.url", S.conn.url);
    if (S.conn.key) store.set("fm.key", S.conn.key, !$("#cRemember").checked); else store.del("fm.key");
    try { S.conn.hf ? sessionStorage.setItem("fm.hf", S.conn.hf) : sessionStorage.removeItem("fm.hf"); } catch { /* */ }
    const msg = $("#connMsg"); msg.style.color = "";
    msg.textContent = S.conn.mode === "demo" ? "" : "Checking…";
    try { await connect(); msg.textContent = S.conn.mode === "demo" ? "Demo mode on." : "Connected."; }
    catch (err) { msg.textContent = err.message; msg.style.color = "var(--err)"; }
    renderStatus(); renderRack(); if (S.run.model) selectModel(S.run.model.id);
  });

  // ── boot ─────────────────────────────────────────────────────────────
  (async function boot() {
    try { S.reg = await (await fetch("models.json", { cache: "no-cache" })).json(); }
    catch (e) { $("#rack").replaceChildren(h("div", { class: "notice err", text: "Could not load models.json. Serve this folder over HTTP (GitHub Pages, or python -m http.server) rather than opening the file directly." })); return; }
    S.reg.models.forEach(m => (S.byId[m.id] = m));
    renderCounts(); renderFamilies(); fillModelSelect();
    try { await connect(); } catch { /* shown in pill */ }
    renderRack();
    window.addEventListener("hashchange", route);
    route();
  })();
})();
