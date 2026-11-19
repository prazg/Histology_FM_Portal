/* Histology FM Portal — static front end. Talks to backend/server.py, or runs in demo mode. */
(function () {
  "use strict";
  const { h } = Viewers;
  const $ = s => document.querySelector(s);
  const FAM_ORDER = ["patch", "vl", "slide", "vmif", "st", "seg"];
  const DATA_CANCER_ORDER = ["brain", "lung", "breast", "prostate", "pan_cancer", "other_cancer"];
  const DATA_MOD_ORDER = ["matched_he_spatial", "matched_he_if", "matched_other", "unmatched_he", "unmatched_spatial", "unmatched_tx"];
  const DATA_HUB_ORDER = ["huggingface", "zenodo", "scientific_data", "portal"];
  const SPECIES_ORDER = ["rodent", "multi-species", "human"];
  const SPECIES_META = {
    rodent: { label: "Rodent / Preclinical", badge: "Rodent / Preclinical", cls: "sp-rodent", sw: "var(--eosin)" },
    "multi-species": { label: "Multi-species & Vet", badge: "Multi-species", cls: "sp-multi", sw: "var(--haem)" },
    human: { label: "Human clinical", badge: null, cls: "", sw: "var(--ink-3)" },
  };
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v, session) { try { (session ? sessionStorage : localStorage).setItem(k, v); (session ? localStorage : sessionStorage).removeItem(k); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* */ } },
  };

  const S = {
    reg: null, byId: {}, dataById: {}, conn: { mode: store.get("fm.mode", "auto"), url: store.get("fm.url", "http://127.0.0.1:8000"), key: store.get("fm.key", ""), hf: "" },
    health: null, ready: {}, connected: false, jobs: [], demoJobs: [], selJob: null, poll: null,
    bhw: null, weights: {}, perf: {}, wPoll: null, drawerModel: null, serverFound: null,
    filt: { fam: null, species: null, q: "", commercial: false, ungated: false, ready: false, hw: false },
    papers: { q: "", species: null },
    data: {
      q: "", cancer: "", mod: "", hub: "", species: "", commercial: false, ungated: false, view: "table",
      liveQ: "glioblastoma OR lung OR breast OR prostate cancer spatial transcriptomics H&E",
      liveHubs: { huggingface: true, zenodo: true, scientific_data: true },
      liveCancerOnly: true, liveItems: null, liveErrors: [], liveBusy: false,
    },
    run: { model: null, task: null, src: "path", tiles: [] },
  };
  try { S.conn.hf = sessionStorage.getItem("fm.hf") || ""; } catch { /* */ }

  // ── API ──────────────────────────────────────────────────────────────
  const base = () => S.conn.url.replace(/\/+$/, "");
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (S.conn.key) headers["X-Portal-Key"] = S.conn.key;
    let r, timer;
    const ctl = opts.timeout ? new AbortController() : null;
    if (ctl) timer = setTimeout(() => ctl.abort(), opts.timeout);
    try { r = await fetch(base() + path, Object.assign({}, opts, { headers }, ctl ? { signal: ctl.signal } : {})); }
    catch (e) { throw new Error(`Cannot reach ${base()}. Is the server running, and is this page's origin listed in 'origins'?`); }
    finally { clearTimeout(timer); }
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

  // ── copy & citation helpers ──────────────────────────────────────────
  function copyText(txt, btn) {
    const done = () => { if (!btn) return; const old = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = old), 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(() => {});
    else { const ta = h("textarea", { style: "position:fixed;opacity:0" }); ta.value = txt; document.body.append(ta); ta.select(); try { document.execCommand("copy"); done(); } catch { /* */ } ta.remove(); }
  }
  function cliBlock(code) {
    const btn = h("button", { type: "button", class: "cli-copy", onclick: () => copyText(code, btn) }, "Copy");
    return h("div", { class: "cli-wrap" }, h("pre", { class: "cli", text: code }), btn);
  }
  function bibtexFor(m) {
    const key = m.id.replace(/[^a-zA-Z0-9_]/g, "_");
    const yr = ((m.citation || m.paper_label || "").match(/\b(19|20)\d{2}\b/) || ["2025"])[0];
    const cite = m.citation || `${m.developer}, ${m.name}`;
    const [authPart, ...rest] = cite.split(",");
    const titlePart = rest.length ? rest.join(",").replace(/\(\d{4}\)\s*$/, "").trim() : m.name;
    return `@article{${key}_${yr},\n  author  = {${(authPart || m.developer).trim()}},\n  title   = {${titlePart}},\n  journal = {${m.paper_label || "Preprint"}},\n  year    = {${yr}},\n  url     = {${m.paper_url || m.link || ""}}\n}`;
  }
  function bibtexForDataset(d) {
    const key = "data_" + d.id.replace(/[^a-zA-Z0-9_]/g, "_");
    const yr = ((d.citation || d.paper_label || "").match(/\b(19|20)\d{2}\b/) || ["2025"])[0];
    const cite = d.citation || `${d.developer}, ${d.name}`;
    const [authPart, ...rest] = cite.split(",");
    const titlePart = rest.length ? rest.join(",").replace(/\(\d{4}\)\s*$/, "").trim() : d.name;
    return `@misc{${key}_${yr},\n  author       = {${(authPart || d.developer).trim()}},\n  title        = {${titlePart}},\n  howpublished = {${d.source_label}: ${d.data_url}},\n  note         = {${d.paper_label || "Open dataset"}},\n  year         = {${yr}},\n  url          = {${d.paper_url || d.data_url}}\n}`;
  }

  // ── routing ──────────────────────────────────────────────────────────
  function route() {
    const [view, arg] = (location.hash.slice(1) || "models").split("/");
    const v = ["models", "run", "results", "papers", "data", "connect"].includes(view) ? view : "models";
    document.querySelectorAll("main > section").forEach(s => (s.hidden = s.id !== "view-" + v));
    document.querySelectorAll("nav.tabs button").forEach(b => b.dataset.view === v ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
    if (v === "run") { if (arg && S.byId[decodeURIComponent(arg)]) selectModel(decodeURIComponent(arg)); else if (!S.run.model) selectModel(S.reg.models.find(m => m.runner)?.id); }
    if (v === "results") { if (arg) S.selJob = decodeURIComponent(arg); refreshJobs(); }
    if (v === "papers") renderPapers();
    if (v === "data") { renderData(); if (arg && S.dataById[decodeURIComponent(arg)]) openDatasetDrawer(S.dataById[decodeURIComponent(arg)]); }
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
  const serverHW = () => (S.connected && S.health && S.health.hardware) ? S.health.hardware : null;
  const fitFor = m => HW.fit(m, S.reg.hardware_rules, serverHW(), S.bhw, S.perf[m.id]);
  const hwBadge = m => { const f = fitFor(m); return h("span", { class: "badge hw-" + f.level, title: f.text }, f.badge); };

  function outputSummary(m) {
    if (m.runner === "tox_vlm") return "Structured VLM decisions & scores";
    if (m.runner === "tisam") return "52 mouse tissue classes";
    if (m.runner === "deepspotm") return "Mouse gene expression / spot";
    if (m.category === "vmif") return `${(m.channels || []).length} markers`;
    if (m.category === "st") return "Gene expression per spot";
    if (m.category === "seg") return "Tissue contours";
    if (m.category === "slide") return `1 vector / slide (from ${m.patch_encoder})`;
    return m.embed_dim ? `${m.embed_dim}-d embedding` : "Embedding";
  }
  function inputSummary(m) {
    if (m.id === "hex_nolan48") return "56 µm patches → 384 px";
    if (m.id === "stpath" || m.id === "deepspot_m") return "55 µm spots, 100 µm pitch";
    if (m.category === "seg") return "Whole slide";
    return m.patch_size ? `${m.patch_size} px @ ${m.mag}x` : "—";
  }
  function licenceBadge(m) {
    return h("span", { class: "badge " + (commercial(m) ? "free" : "nc"), title: m.licence }, commercial(m) ? m.licence : "Non-commercial");
  }
  function speciesBadge(m) {
    const sp = SPECIES_META[m.species];
    if (!sp || !sp.badge) return null;
    return h("span", { class: "badge " + sp.cls, title: m.species_note || sp.label }, sp.badge);
  }

  function slideCard(m) {
    const ready = S.connected || S.conn.mode === "demo" ? isReady(m) : null;
    const tasks = (m.tasks || []).map(t => S.reg.tasks[t].label).join(" · ") || "Catalogue entry — no runner yet";
    const el = h("button", { class: `slide fam-${m.category}`, type: "button", "data-ready": ready === false ? "no" : "yes", "aria-label": `${m.name} — details` },
      h("span", { class: "label" },
        h("span", { class: "nm", text: m.name }), h("span", { class: "dev", text: m.developer }),
        h("span", { class: "badges" }, speciesBadge(m), licenceBadge(m), m.gated ? h("span", { class: "badge", title: "Request access on Hugging Face" }, "Access request") : null,
          ready && S.conn.mode === "server" ? h("span", { class: "badge ready" }, "Ready") : null)),
      h("span", { class: "specimen" },
        h("dl", {}, h("dt", { text: "Output" }), h("dd", { text: outputSummary(m) }), h("dt", { text: "Input" }), h("dd", { text: inputSummary(m) }),
          h("dt", { text: "Hardware" }), h("dd", {}, hwBadge(m))),
        h("span", { class: "tasks", text: m.paper_label ? `${tasks} · ${m.paper_label}` : tasks })));
    el.addEventListener("click", () => openDrawer(m));
    return el;
  }

  function filtered() {
    const f = S.filt, q = f.q.toLowerCase();
    return S.reg.models.filter(m =>
      (!f.fam || m.category === f.fam) && (!f.species || m.species === f.species) &&
      (!f.commercial || commercial(m)) && (!f.ungated || !m.gated) && (!f.ready || isReady(m)) && (!f.hw || ["good", "ok"].includes(fitFor(m).level)) &&
      (!q || [m.name, m.developer, m.licence, m.hf_repo, m.id, m.species, m.species_note, m.paper_label, m.citation].join(" ").toLowerCase().includes(q)));
  }

  function renderFamilies() {
    const counts = Object.fromEntries(FAM_ORDER.map(c => [c, S.reg.models.filter(m => m.category === c).length]));
    $("#famList").replaceChildren(
      h("li", {}, h("button", { "aria-pressed": String(!S.filt.fam), onclick: () => { S.filt.fam = null; renderFamilies(); renderRack(); } },
        h("span", { class: "sw", style: "background:linear-gradient(135deg,var(--haem),var(--eosin))" }), "All families", h("span", { class: "n", text: S.reg.models.length }))),
      ...FAM_ORDER.map(c => h("li", {}, h("button", { "aria-pressed": String(S.filt.fam === c), onclick: () => { S.filt.fam = S.filt.fam === c ? null : c; renderFamilies(); renderRack(); } },
        h("span", { class: "sw", style: `background:var(--c-${c})` }), famLabel(c), h("span", { class: "n", text: counts[c] })))));
  }

  function renderSpecies() {
    const box = $("#spList");
    if (!box) return;
    const counts = Object.fromEntries(SPECIES_ORDER.map(s => [s, S.reg.models.filter(m => m.species === s).length]));
    box.replaceChildren(
      h("li", {}, h("button", { "aria-pressed": String(!S.filt.species), onclick: () => { S.filt.species = null; renderSpecies(); renderRack(); } },
        h("span", { class: "sw", style: "background:linear-gradient(135deg,var(--eosin),var(--haem))" }), "All scopes", h("span", { class: "n", text: S.reg.models.length }))),
      ...SPECIES_ORDER.map(s => h("li", {}, h("button", { "aria-pressed": String(S.filt.species === s), onclick: () => { S.filt.species = S.filt.species === s ? null : s; renderSpecies(); renderRack(); } },
        h("span", { class: "sw", style: `background:${SPECIES_META[s].sw}` }), SPECIES_META[s].label, h("span", { class: "n", text: counts[s] })))));
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
    Object.assign(S.filt, { fam: null, species: null, q: "", commercial: false, ungated: false, ready: false, hw: false });
    $("#q").value = ""; ["#fCommercial", "#fUngated", "#fReady", "#fHw"].forEach(s => ($(s).checked = false));
    renderFamilies(); renderSpecies(); renderRack();
  }
  $("#q").addEventListener("input", e => { S.filt.q = e.target.value; renderRack(); });
  $("#fCommercial").addEventListener("change", e => { S.filt.commercial = e.target.checked; renderRack(); });
  $("#fUngated").addEventListener("change", e => { S.filt.ungated = e.target.checked; renderRack(); });
  $("#fReady").addEventListener("change", e => { S.filt.ready = e.target.checked; renderRack(); });
  $("#fHw").addEventListener("change", e => { S.filt.hw = e.target.checked; renderRack(); });

  function renderCounts() {
    const M = S.reg.models;
    $("#counts").replaceChildren(
      h("div", {}, h("b", { text: M.filter(m => m.runner).length }), "runnable models"),
      h("div", {}, h("b", { text: M.filter(m => m.species !== "human").length }), "animal & cross-species"),
      h("div", {}, h("b", { text: M.filter(m => !m.gated).length }), "no access request"),
      h("div", {}, h("b", { text: M.filter(commercial).length }), "commercial-use licences"));
    $("#regDate").textContent = S.reg.version;
  }

  // ── drawer ───────────────────────────────────────────────────────────
  function openDrawer(m, keepOpen) {
    const d = $("#drawer");
    S.drawerModel = m;
    const st = S.ready[m.id];
    const spLabel = (SPECIES_META[m.species] || SPECIES_META.human).label;
    const bibBtn = h("button", { type: "button", class: "btn ghost small", style: "margin-left:8px", onclick: () => copyText(bibtexFor(m), bibBtn) }, "Copy BibTeX");
    const cli = m.tasks && m.tasks.length ? cliFor(m, m.tasks[0]) : null;
    const rows = [
      ["Family", famLabel(m.category)], ["Developer", m.developer],
      ["Species & scope", m.species_note ? `${spLabel} — ${m.species_note}` : spLabel],
      ["Output", outputSummary(m)], ["Input", inputSummary(m)],
      ["Licence", m.licence], ["Access", m.gated ? "Gated — request access on Hugging Face, then log in on the server" : "Open download"],
      m.paper_url ? ["Paper / preprint", h("span", {}, h("a", { href: m.paper_url, target: "_blank", rel: "noopener", text: m.paper_label || m.paper_url }), bibBtn,
        m.citation ? h("span", { class: "paper-cite", text: m.citation }) : null)] : null,
      ["Weights / code", m.link ? h("a", { href: m.link, target: "_blank", rel: "noopener" }, m.hf_repo || m.link) : "—"],
      m.trident_name ? ["TRIDENT name", h("code", { text: m.trident_name })] : null,
      m.patch_encoder ? ["Patch encoder", h("code", { text: m.patch_encoder })] : null,
      ["Verified against", [...(m.source || "").split("+"), ...(m.weights && m.weights.length ? ["HFsize"] : [])].map(k => S.reg.verified_against[k] || k).join("; ")],
      S.connected ? ["On your server", st ? (st.ready ? "Ready" : st.reason) : "—"] : null,
    ].filter(Boolean);
    d.replaceChildren(
      h("div", { class: `drawer-head fam-${m.category}` },
        h("p", { class: "small muted", style: "margin:0 0 4px", text: `${famLabel(m.category)} · ${spLabel}` }), h("h2", { id: "drawerTitle", text: m.name }),
        h("button", { class: "icon-btn close-x", "aria-label": "Close", onclick: () => d.close() }, "✕")),
      h("div", { class: "drawer-body" },
        h("dl", { class: "kv" }, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)])),
        hwSection(m),
        m.notes ? h("div", { class: "notice info", text: m.notes }) : null,
        m.channels ? h("details", {}, h("summary", { text: `${m.channels.length} output channels` }), h("p", { class: "small", text: m.channels.join(", ") })) : null,
        (m.tasks || []).length ? h("div", {}, h("h3", { text: "Tasks and outputs", style: "margin-bottom:8px" }),
          h("ul", { class: "small", style: "margin:0;padding-left:1.1em" }, m.tasks.map(t => h("li", {}, h("strong", { text: S.reg.tasks[t].label }), " — ", S.reg.tasks[t].outputs.join("; "))))) : null,
        (() => {
          const compat = (S.reg.open_datasets || []).filter(ds => (ds.compatible_models || []).includes(m.id));
          if (!compat.length) return null;
          return h("div", {}, h("h3", { text: "Compatible open-access oncology datasets", style: "margin-bottom:8px" }),
            h("div", { class: "chips", style: "margin-bottom:0" }, compat.map(ds => h("button", {
              type: "button", class: "btn ghost small",
              onclick: () => { d.close(); go("data/" + encodeURIComponent(ds.id)); }
            }, `${ds.name} · ${(S.reg.dataset_cancer_sites && S.reg.dataset_cancer_sites[ds.cancer_site] ? S.reg.dataset_cancer_sites[ds.cancer_site].short + " · " : "")}${(S.reg.dataset_modalities[ds.modality_group] || {}).short || ds.regime}`))));
        })(),
        cli ? h("details", {}, h("summary", { class: "small", text: "Python / CLI quickstart" }), cliBlock(cli)) : null,
        m.runner ? h("div", { style: "display:flex;gap:10px;flex-wrap:wrap" },
          h("button", { class: "btn", onclick: () => { d.close(); go("run/" + encodeURIComponent(m.id)); } }, `Run ${m.name}`),
          m.paper_url ? h("a", { class: "btn ghost", href: m.paper_url, target: "_blank", rel: "noopener" }, "Read paper") : null) : null));
    if (!d.open && !keepOpen) d.showModal();
  }
  $("#drawer").addEventListener("click", e => { if (e.target.id === "drawer") e.target.close(); });
  $("#drawer").addEventListener("close", () => { S.drawerModel = null; });

  // ── run form ─────────────────────────────────────────────────────────
  const PRESETS = {
    "Glioblastoma regions (Ivy GAP-style)": "cellular tumour: densely cellular glioblastoma | hypercellular glioma tissue\nnecrosis: necrotic tissue | pseudopalisading necrosis\nmicrovascular proliferation: microvascular proliferation | glomeruloid blood vessels\ninfiltrating tumour: tumour cells infiltrating brain parenchyma\nnormal brain: normal brain tissue | normal cerebral cortex",
    "Tumour microenvironment compartments": "tumour: tumour cells\nstroma: fibrous stroma | extracellular matrix\nimmune infiltrate: lymphocytes | immune cell infiltrate\nmacrophages: macrophages | foamy histiocytes\nnecrosis: necrosis\nvessels: blood vessels",
    "Rodent liver toxicology (TG-GATEs / VIPER)": "no abnormality: normal rodent hepatic parenchyma within normal limits | unremarkable control liver\nhepatocellular hypertrophy: centrilobular hepatocellular hypertrophy | enlarged eosinophilic hepatocytes\nsingle-cell necrosis: hepatocellular necrosis | pyknosis karyorrhexis acidophilic bodies\nvacuolation / steatosis: microvesicular or macrovesicular cytoplasmic vacuolation | lipid droplets\ninflammatory infiltrate: mixed mononuclear or neutrophilic portal and lobular inflammation\nbile duct hyperplasia: biliary hyperplasia and oval cell proliferation",
    "Rodent renal tubular injury (rat/mouse)": "normal cortex: unremarkable renal glomeruli and proximal convoluted tubules\ntubular degeneration / necrosis: proximal tubular epithelial necrosis sloughing and hyaline casts\ntubular basophilia / regeneration: basophilic regenerating renal tubules with crowded nuclei\ninterstitial nephritis: mononuclear interstitial inflammatory infiltrate and fibrosis",
    "Mouse GEMM lung oncology": "normal lung: normal mouse alveolar parenchyma and bronchiolar epithelium\nhyperplasia / adenoma: atypical adenomatous hyperplasia or pulmonary adenoma\nadenocarcinoma: invasive murine lung adenocarcinoma with nuclear atypia\nimmune stroma: perivascular and peribronchiolar lymphoid infiltrate",
    "Tumour vs normal": "tumour: malignant tumour tissue\nnormal: normal tissue",
  };
  const MOUSE_GENES_DEF = "Alb, Cyp2e1, Glul, Ass1, Pecam1, Col1a1, Ptprc, Adgre1, Acta2, Mki67, Havcr1, Lcn2, Slc34a1, Sftpc, Gfap, Sox2";
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
    genes: { label: "Genes to map", type: "textarea", def: "GFAP, SOX2, OLIG2, EGFR, CD44, CHI3L1, VIM, MKI67, PTPRC, CD68, CD163, AIF1, CD3E, CD8A, PECAM1, VEGFA, COL1A1, COL4A1, FN1, POSTN", hint: "HGNC (human) or MGI (mouse) gene symbols; the full prediction is in the .h5ad." },
    organ: { label: "Organ / study context", type: "text", def: "Brain", hint: "For STPath: organ vocabulary (blank = unknown). For TissueDecision-9B: preclinical organ/species context." },
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
      case "tox_vqa": return ["classes", "organ"];
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
        ta.value = (t === "tox_vqa" || m.species === "rodent")
          ? PRESETS["Rodent liver toxicology (TG-GATEs / VIPER)"]
          : PRESETS["Glioblastoma regions (Ivy GAP-style)"];
        kids.push(h("div", { class: "field" }, h("label", { for: "p_classes", text: t === "tox_vqa" ? "Candidate findings & morphological criteria" : "Classes and prompts" }),
          h("div", { class: "chips" }, Object.keys(PRESETS).map(p => h("button", { type: "button", class: "btn ghost small", onclick: () => (ta.value = PRESETS[p]) }, p))),
          ta, h("span", { class: "hint", id: "p_classes_h", text: "One class/finding per line: name: description | synonym. Presets cover both human oncology and rodent preclinical toxicology." })));
        continue;
      }
      const d = PARAMS[k];
      let def = d.def;
      if (k === "mag") def = m.mag; if (k === "patch_size") def = m.patch_size;
      if (k === "genes" && m.runner === "deepspotm") def = MOUSE_GENES_DEF;
      if (k === "organ" && (t === "tox_vqa" || m.species === "rodent")) def = m.runner === "deepspotm" ? "Mouse liver" : "Rat liver (Open TG-GATEs / INHAND)";
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
    const wsi = t && S.reg.tasks[t] && S.reg.tasks[t].input === "wsi";
    if (m.runner === "tox_vlm") return `# Serve TissueDecision-9B via vLLM (or run directly via transformers)\nvllm serve ${m.hf_repo} --port 8001 --dtype bfloat16\n# Or in Python with transformers:\nfrom transformers import AutoProcessor, AutoModelForImageTextToText\nproc = AutoProcessor.from_pretrained("${m.hf_repo}", trust_remote_code=True)\nmodel = AutoModelForImageTextToText.from_pretrained("${m.hf_repo}", torch_dtype="auto", device_map="auto")`;
    if (m.id === "loki") return `import open_clip\nfrom huggingface_hub import hf_hub_download\nckpt = hf_hub_download("WangGuangyuLab/Loki", "checkpoint.pt")\nmodel, _, preprocess = open_clip.create_model_and_transforms("coca_ViT-L-14", pretrained=ckpt)\ntok = open_clip.get_tokenizer("coca_ViT-L-14")`;
    if (m.id === "plip") return `from transformers import CLIPModel, CLIPProcessor\nmodel = CLIPModel.from_pretrained("vinid/plip").eval().to("cuda")\nproc = CLIPProcessor.from_pretrained("vinid/plip")`;
    if (m.id === "quiltnet_b32") return `import open_clip\nmodel, preprocess = open_clip.create_model_from_pretrained("hf-hub:wisdomik/QuiltNet-B-32")\ntok = open_clip.get_tokenizer("hf-hub:wisdomik/QuiltNet-B-32")`;
    if (m.runner === "tisam") return `git clone https://github.com/Kiemen-Lab/tisam\n# Segment 52 MegaMouse mouse compartments over UNI2-h features:\npython -m tisam.infer --wsi mouse_slide.svs --out_dir ./megamouse_out`;
    if (m.runner === "deepspotm") return `git clone https://github.com/ratschlab/DeepSpotM\n# Predict virtual Mus musculus spatial gene expression from H&E:\npython -m deepspot.predict --wsi mouse_slide.ndpi --backbone uni_v1 --out deepspotm.h5ad`;
    if (m.runner === "stpath") return `from stpath.app.pipeline.inference import STPathInference\nagent = STPathInference(gene_voc_path="utils_data/symbol2ensembl.json", model_weight_path="stfm.pth", device=0)\nadata = agent.inference(coords=centres, img_features=gigapath_feats, organ_type="Brain", tech_type="Visium")`;
    if (m.runner === "gigatime") return `# Clone https://github.com/prov-gigatime/GigaTIME and load prov-gigatime/GigaTIME:\nfrom huggingface_hub import hf_hub_download\nckpt = hf_hub_download("prov-gigatime/GigaTIME", "model.pt")`;
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
      hwSection(m, t),
      h("div", { class: "card" }, h("h3", { text: "What you'll get" }), h("ul", { class: "small" }, S.reg.tasks[t].outputs.map(o => h("li", { text: o })))),
      h("div", { class: commercial(m) ? "notice info" : "notice" },
        h("strong", { text: m.licence + ". " }), commercial(m) ? "Check the model card for attribution terms." : "Academic, non-commercial use only. ",
        m.gated ? h("span", {}, "You need approved access to ", h("a", { href: m.link, target: "_blank", rel: "noopener", text: m.hf_repo }), " on Hugging Face.") : null),
    ];
    if (m.paper_url) kids.push(h("div", { class: "card small" }, h("h3", { text: "Publication" }),
      h("p", { style: "margin:0" }, h("a", { href: m.paper_url, target: "_blank", rel: "noopener", text: m.paper_label || m.paper_url }),
        m.citation ? h("span", { class: "paper-cite", text: m.citation }) : null)));
    if (m.notes) kids.push(h("div", { class: "card small" }, h("h3", { text: "Model notes" }), h("p", { style: "margin:0", text: m.notes })));
    if (cli) kids.push(h("div", { class: "card" }, h("h3", { text: "Reproduce outside the portal" }), cliBlock(cli)));
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
    renderStatus(); renderLaunch(); renderWeightsCard();
  }
  document.querySelectorAll("#connForm [name=mode]").forEach(r => r.addEventListener("change", () => { $("#serverFields").hidden = r.value !== "server" || !r.checked; }));

  function renderStatus() {
    const box = $("#serverStatus");
    if (S.conn.mode === "demo") { box.replaceChildren(h("h3", { text: "Demo mode" }), h("p", { class: "small muted", text: "Outputs are generated in the browser and clearly marked as synthetic. Switch to My server for real inference." })); return; }
    if (!S.health) { box.replaceChildren(h("h3", { text: "Server status" }), h("p", { class: "muted small", text: "Connect to see GPU, packages and which models are ready." })); return; }
    const H = S.health, ready = Object.entries(S.ready);
    const notReady = ready.filter(([, v]) => !v.ready);
    box.replaceChildren(h("h3", { text: "Server status" }),
      ...hwDetails(H),
      h("dl", { class: "kv small" }, h("dt", { text: "Runs on" }), h("dd", { text: H.gpu ? `${H.device} — ${H.gpu}` : H.device }),
        h("dt", { text: "Mode" }), h("dd", { text: H.mock ? "Mock (synthetic outputs)" : "Real inference" }),
        h("dt", { text: "Models ready" }), h("dd", { text: `${ready.length - notReady.length} of ${ready.length}` }),
        h("dt", { text: "Slide folders" }), h("dd", { text: H.wsi_roots.length ? H.wsi_roots.join(", ") : "None — uploads only" })),
      h("div", { class: "status-grid", style: "margin-top:12px" }, Object.entries(H.packages).map(([k, v]) => h("span", {}, h("span", { class: "dot " + (v ? "ok" : "warn") }), k))),
      notReady.length ? h("details", { style: "margin-top:12px" }, h("summary", { text: `${notReady.length} ${notReady.length === 1 ? "model needs" : "models need"} setup` }),
        h("ul", { class: "small", style: "padding-left:1.1em" }, notReady.map(([id, v]) => h("li", {}, h("strong", { text: (S.byId[id] || {}).name || id }), ": ", v.reason)))) : null);
  }

  function hwDetails(H) {
    const X = H.hardware;
    if (!X) return [];
    const rows = [["CPU", `${X.cpu_cores || "?"} cores · ${X.machine}`], ["RAM", X.ram_total_gb ? `${HW.gbFmt(X.ram_total_gb)} total${X.ram_available_gb ? `, ${HW.gbFmt(X.ram_available_gb)} free` : ""}` : "unknown"],
      ["PyTorch", X.torch ? `${X.torch}${X.torch_cuda ? ` (CUDA ${X.torch_cuda})` : " (CPU build)"}` : "not installed"],
      ...(X.gpus.length ? X.gpus.map(g => [`GPU ${g.index}`, `${g.name} · ${HW.gbFmt(g.vram_total_gb)}${g.vram_free_gb != null ? ` (${HW.gbFmt(g.vram_free_gb)} free)` : ""}`])
        : [["GPU", X.driver_gpus.length ? `${X.driver_gpus[0].name} (not usable by PyTorch)` : X.mps_available ? "Apple GPU (MPS) — not used" : "none"]]),
      ["Hugging Face", H.hf_logged_in ? "logged in" : "not logged in"]];
    return [h("dl", { class: "kv small", style: "margin-bottom:10px" }, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])),
      ...(X.warnings || []).map(w => h("div", { class: "notice small", style: "margin-bottom:10px", text: w }))];
  }

  async function connect() {
    if (S.conn.mode === "demo") { S.connected = false; S.health = null; S.ready = {}; setPill("warn", "Demo mode"); renderHwBar(); return true; }
    setPill("", "Connecting…");
    try {
      S.health = await api("/api/health", { timeout: 15000 });
      S.ready = await api("/api/models");
      S.connected = true;
      await refreshWeights(true);
      try { S.perf = await api("/api/perf"); } catch { S.perf = {}; }
      const n = Object.values(S.ready).filter(v => v.ready).length;
      const g = S.health.hardware && S.health.hardware.gpus && S.health.hardware.gpus[0];
      setPill(S.health.mock ? "warn" : "ok", `${S.health.mock ? "Mock server" : g ? g.name.replace(/^NVIDIA /, "") : "CPU server"} · ${n} ready`);
      renderHwBar();
      return true;
    } catch (e) {
      S.connected = false; S.health = null; S.ready = {}; S.weights = {}; S.perf = {};
      setPill("err", "Not connected");
      renderHwBar();
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
    renderStatus(); renderWeightsCard(); renderRack(); if (S.run.model) selectModel(S.run.model.id);
  });


  // ── hardware & weights ───────────────────────────────────────────────
  const onLocalhost = () => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  async function autoConnect() {
    if (S.conn.mode === "demo") return connect();
    if (S.conn.mode === "server") { try { await connect(); } catch { /* pill shows it */ } return; }
    // First visit: probe automatically only when the page itself is served from this computer.
    // From GitHub Pages, probing localhost can trigger a browser permission prompt, so it waits for a click.
    if (onLocalhost()) { await findServer(true); return; }
    S.conn.mode = "demo"; await connect(); setPill("warn", "Demo mode — no server connected");
  }

  async function findServer(silent) {
    setPill("", "Looking for a server…");
    try {
      await api("/api/health", { timeout: 2500 });
      S.conn.mode = "server"; store.set("fm.mode", "server"); S.serverFound = "ok";
      await connect();
    } catch (e) {
      if (/^401/.test(e.message)) { S.conn.mode = "server"; S.serverFound = "key"; setPill("warn", "Server found — enter its key"); if (!silent) go("connect"); }
      else { S.serverFound = "none"; S.conn.mode = "demo"; await connect(); setPill("warn", "No server found — demo mode"); }
    }
    renderHwBar(); renderRack(); renderStatus(); renderWeightsCard();
    if (S.run.model) selectModel(S.run.model.id);
  }

  function renderHwBar() {
    const bar = $("#hwBar");
    if (!bar || !S.reg) return;
    const H = serverHW();
    const kids = [];
    if (H) {
      const g = (H.gpus || [])[0];
      const gpuTxt = g ? `${g.name} · ${HW.gbFmt(g.vram_total_gb)} GPU memory${H.gpus.length > 1 ? ` (+${H.gpus.length - 1} more)` : ""}` : "No usable GPU — models run on the CPU";
      kids.push(h("div", { class: "hw-src" }, h("span", { class: "dot " + (g ? "ok" : "warn") }), h("strong", { text: "Models run on your server" })),
        h("div", { class: "hw-specs" }, h("span", { text: gpuTxt }), h("span", { text: `${H.cpu_cores || "?"} CPU cores` }),
          H.ram_total_gb ? h("span", { text: `${HW.gbFmt(H.ram_total_gb)} RAM` }) : null,
          h("button", { class: "btn ghost small", onclick: () => go("connect") }, "Server details")));
      (H.warnings || []).forEach(w => kids.push(h("div", { class: "notice", style: "margin-top:8px", text: w })));
    } else {
      const b = S.bhw;
      const gpuTxt = !b ? "Detecting…" : b.gpuShort ? b.gpuShort : "GPU not exposed by this browser";
      kids.push(h("div", { class: "hw-src" }, h("span", { class: "dot" }), h("strong", { text: "This computer" }), h("span", { class: "muted small", text: "detected by your browser" })),
        h("div", { class: "hw-specs" }, h("span", { text: gpuTxt }),
          b && b.cores ? h("span", { text: `${b.cores} CPU threads` }) : null,
          b && b.memGB ? h("span", { text: `≥ ${b.memGB} GB memory (browser-rounded)` }) : null,
          h("button", { class: "btn small", onclick: () => window.Wizard && Wizard.open() }, "Set up a server on this computer"),
          h("button", { class: "btn ghost small", onclick: () => findServer(false) }, "I already have one running")),
        h("p", { class: "small muted", style: "margin:6px 0 0", text: b && b.kind === "nvidia"
          ? "An NVIDIA GPU is visible, so a server on this computer can use CUDA. GPU memory and CUDA can only be checked by the server — connect one for exact advice."
          : "The badges on each model assume the server runs on this computer. Connect a server for exact GPU-memory checks." }));
    }
    bar.replaceChildren(...kids);
  }

  function hfCommands(m) {
    const comps = [m, ...(m.requires_models || []).map(id => S.byId[id])];
    const lines = [];
    comps.forEach(c => c.weights.forEach(w => {
      if (w.via === "hf") lines.push(`hf download ${w.repo} ${w.files.join(" ")}${w.type === "dataset" ? " --repo-type dataset" : ""}`);
      else if (w.via === "trident-seg") lines.push(`# ${c.name}: downloaded automatically by TRIDENT on first use`);
      else if (w.via === "external") lines.push(`# ${c.name}: ${w.note}`);
    }));
    return lines.join("\n");
  }

  function weightsRow(m) {
    const w = S.weights[m.id];
    if (!w) return null;
    const noAccess = w.parts.filter(p => p.access === "no-access");
    const missing = w.parts.filter(p => p.cached === false);
    const row = h("div", { class: "wrow" });
    if (w.download === "queued" || w.download === "downloading") {
      row.append(h("div", { class: "small", text: `Downloading ${w.message || ""}` }),
        h("div", { class: "progress" }, h("i", { style: `width:${Math.max(3, w.progress * 100)}%` })));
    } else if (w.overall === "cached") {
      row.append(h("p", { class: "small ok-text", text: "Weights are already on your server." }));
    } else if (w.overall === "manual") {
      const ext = w.parts.find(p => p.via === "external");
      row.append(h("p", { class: "small", text: ext.note + " " }), ext.url ? h("a", { href: ext.url, target: "_blank", rel: "noopener", class: "small", text: "Open instructions" }) : null);
    } else if (w.overall !== "none") {
      const what = w.overall === "unknown" ? "Not sure whether the weights are cached yet." : missing.length ? `${HW.gbFmt(w.missing_gb)} still to download.` : "Some weights are missing.";
      row.append(h("p", { class: "small", text: what + " Downloading now saves waiting at your first run." }),
        h("button", { class: "btn small", onclick: () => downloadWeights(m.id) }, w.download === "error" ? "Retry download" : "Download to server"));
      if (w.download === "error") row.append(h("div", { class: "notice err small", style: "margin-top:8px", text: w.message }));
    }
    if (noAccess.length) row.append(h("p", { class: "small", style: "margin-top:6px" }, "No access yet to ",
      ...noAccess.map((p, i) => [i ? ", " : "", h("a", { href: `https://huggingface.co/${p.repo}`, target: "_blank", rel: "noopener", text: p.repo })]).flat(),
      ". Request access on Hugging Face, then retry."));
    return row;
  }

  function hwSection(m, task) {
    const f = fitFor(m);
    const box = h("div", { class: `card hw-card hw-${f.level}` },
      h("div", { class: "hw-head" }, h("h3", { text: "Hardware" }), h("span", { class: "badge hw-" + f.level, text: f.badge })),
      h("p", { class: "small", style: "margin-bottom:6px", text: f.text }));
    const comps = [m, ...(m.requires_models || []).map(id => S.byId[id])];
    if (m.runtime_weights_gb) box.append(h("p", { class: "small muted", style: "margin-bottom:6px",
      text: `Weights: ${HW.gbFmt(m.runtime_weights_gb)}` + (comps.length > 1 ? ` — ${comps.map(c => `${c.name} ${HW.gbFmt(c.weights_gb)}`).join(" + ")}` : "") }));
    if (task) {
      const tiles = S.reg.tasks[task].input === "tiles";
      const sp = HW.speedText(S.perf[m.id], task, tiles ? "tiles" : "patches");
      if (sp) box.append(h("p", { class: "small", style: "margin-bottom:6px", text: "Measured on your server: " + sp }));
      const best = S.perf[m.id] && S.perf[m.id][task] && Object.values(S.perf[m.id][task]).map(d => d.items_per_s).filter(Boolean)[0];
      if (tiles && best && S.run.tiles.length) box.append(h("p", { class: "small", text: `About ${Math.max(1, Math.round(S.run.tiles.length / best))} s for your ${S.run.tiles.length} tiles.` }));
    }
    if (S.connected && S.conn.mode === "server") { const r = weightsRow(m); if (r) box.append(r); }
    const cmds = hfCommands(m);
    if (cmds) box.append(h("details", {}, h("summary", { class: "small", text: "Download weights by hand" }), cliBlock(cmds),
      h("p", { class: "small muted", style: "margin-top:6px", text: "Run on the server machine after hf auth login. Files land in the Hugging Face cache, where the portal finds them." })));
    return box;
  }

  async function refreshWeights(quiet) {
    if (!(S.connected && S.conn.mode === "server")) return;
    try { S.weights = await api("/api/weights"); } catch { return; }
    clearTimeout(S.wPoll);
    const busy = Object.values(S.weights).some(w => w.download === "queued" || w.download === "downloading");
    if (busy) S.wPoll = setTimeout(() => refreshWeights(false), 1500);
    if (!quiet) {
      if (S.drawerModel) openDrawer(S.drawerModel, true);
      if (!$("#view-run").hidden && S.run.model) renderAside(S.run.model, S.run.task);
      if (!$("#view-connect").hidden) renderWeightsCard();
    }
  }

  async function downloadWeights(id) {
    const headers = S.conn.hf ? { "X-HF-Token": S.conn.hf } : {};
    try { await api(`/api/weights/${encodeURIComponent(id)}/download`, { method: "POST", headers }); }
    catch (e) { alertInline(e.message); }
    refreshWeights(false);
  }
  function alertInline(msg) { const m = $("#connMsg"); if (m) { m.textContent = msg; m.style.color = "var(--err)"; } }

  function renderWeightsCard() {
    const box = $("#weightsCard");
    if (!box) return;
    if (!(S.connected && S.conn.mode === "server")) { box.hidden = true; return; }
    box.hidden = false;
    const W = S.weights, H = S.health || {};
    const runnable = S.reg.models.filter(m => m.runner && W[m.id]);
    const cached = runnable.filter(m => W[m.id].overall === "cached");
    const accessKnown = Object.values(W).some(w => w.parts.some(p => p.access !== "unknown"));
    const canGet = runnable.filter(m => ["missing", "partial", "unknown"].includes(W[m.id].overall) &&
      W[m.id].parts.filter(p => p.via === "hf").every(p => p.access === "ok"));
    const sizeOf = list => { const seen = new Set();   // shared weights (e.g. GigaPath inside STPath, Virchow2 in both variants) count once
      return list.reduce((a, m) => a + W[m.id].parts.filter(p => p.cached !== true && !seen.has(p.repo || p.model) && seen.add(p.repo || p.model)).reduce((x, p) => x + (p.gb || 0), 0), 0); };
    const canGetFit = canGet.filter(m => ["good", "ok"].includes(fitFor(m).level));
    const needGb = sizeOf(canGet), needFitGb = sizeOf(canGetFit);
    const free = H.hardware && H.hardware.weights_disk_free_gb;
    const msg = h("span", { class: "small", role: "status" });
    const rows = runnable.map(m => {
      const w = W[m.id];
      const st = w.download === "queued" ? "Queued" : w.download === "downloading" ? `Downloading ${Math.round(w.progress * 100)}%`
        : { cached: "On server", missing: "Not downloaded", partial: "Partly downloaded", unknown: "Unknown", manual: "Manual download", none: "No weights" }[w.overall];
      const blocked = w.parts.some(p => p.access === "no-access");
      return h("tr", {}, h("td", { text: m.name }), h("td", { class: "num", text: HW.gbFmt(m.runtime_weights_gb) }),
        h("td", {}, h("span", { class: "dot " + (w.overall === "cached" ? "ok" : blocked ? "err" : w.download === "downloading" ? "run" : "") }), " ", blocked ? "No access" : st),
        h("td", {}, ["missing", "partial", "unknown"].includes(w.overall) && !["queued", "downloading"].includes(w.download) && !blocked
          ? h("button", { class: "btn ghost small", onclick: () => downloadWeights(m.id) }, "Download") : ""));
    });
    box.replaceChildren(
      h("h3", { text: "Model weights on your server" }),
      h("p", { class: "small muted", text: `${cached.length} of ${runnable.length} runnable models are ready to go. Weights are stored in ${H.hf_cache || "the Hugging Face cache"}${free != null ? ` (${HW.gbFmt(free)} free)` : ""} — never in the git repository.` }),
      H.hf_logged_in === false && !S.conn.hf ? h("div", { class: "notice", style: "margin-bottom:10px", text: "The server is not logged in to Hugging Face, so gated models can't be downloaded. Run hf auth login on the server, or add a token above." }) : null,
      h("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px" },
        h("button", { class: "btn ghost small", onclick: async () => {
          msg.textContent = "Checking access to every repository…";
          try { await api("/api/weights/access", { method: "POST", headers: S.conn.hf ? { "X-HF-Token": S.conn.hf } : {} }); msg.textContent = ""; }
          catch (e) { msg.textContent = e.message; }
          await refreshWeights(true); renderWeightsCard(); renderRack(); } }, accessKnown ? "Re-check access" : "Check my access"),
        ...[[canGetFit, needFitGb, "Download the ones that suit this hardware"], [canGet, needGb, "Download all I can access"]].map(([list, gb, label], i) =>
          accessKnown && list.length && !(i === 1 && list.length === canGetFit.length) ? h("button", { class: i === 0 ? "btn small" : "btn ghost small", onclick: async () => {
            if (free != null && gb > free) { msg.textContent = `Needs ${HW.gbFmt(gb)} but only ${HW.gbFmt(free)} is free on the server.`; return; }
            for (const m of list) await api(`/api/weights/${encodeURIComponent(m.id)}/download`, { method: "POST", headers: S.conn.hf ? { "X-HF-Token": S.conn.hf } : {} });
            refreshWeights(false); } }, `${label} (${list.length} models, ${HW.gbFmt(gb)})`) : null),
        msg),
      h("div", { class: "table-wrap" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, ["Model", "Size", "Status", ""].map((c, i) => h("th", { class: i === 1 ? "num" : "", text: c })))),
        h("tbody", {}, rows))));
  }

  function renderLaunch() {
    const box = $("#launchCard");
    if (!box) return;
    const os = (S.bhw && S.bhw.os) || "Unknown";
    const tabs = [["win", "Windows"], ["nix", "macOS / Linux"], ["hpc", "HPC (Slurm)"]];
    let cur = box.dataset.tab || (os === "Windows" ? "win" : "nix");
    const cmd = {
      win: "cd path\\to\\fm_portal\\backend\n.\\start_server.ps1\n# try it without any weights first:\n.\\start_server.ps1 -Mock",
      nix: "cd path/to/fm_portal/backend\nbash start_server.sh\n# try it without any weights first:\nMOCK=1 bash start_server.sh",
      hpc: "# on the login node, from fm_portal/backend:\nsbatch hpc/serve_slurm.sbatch\n# then follow the ssh -L line printed in the job's log file",
    };
    const note = {
      win: "The script checks Python, installs the server packages if they are missing, prints your hardware and which models are ready, then starts the server on 127.0.0.1:8000.",
      nix: "The script checks Python, installs the server packages if they are missing, prints your hardware and which models are ready, then starts the server on 127.0.0.1:8000.",
      hpc: "Edit the partition, GPU and environment lines at the top of the script first. Keep the server behind the SSH tunnel and set portal_key, because a compute node is shared.",
    };
    const draw = () => {
      box.dataset.tab = cur;
      box.replaceChildren(h("h3", { text: "Start the server" }),
        h("p", { class: "small" }, "New here? ", h("button", { class: "btn small", type: "button", onclick: () => window.Wizard && Wizard.open() }, "Open guided setup"),
          " walks you through installing and connecting a server, one step at a time."),
        h("p", { class: "small muted", text: os !== "Unknown" ? `Your browser reports ${os}.` : "" }),
        h("div", { class: "seg-ctl", role: "group", "aria-label": "Platform" }, tabs.map(([k, l]) => h("button", { type: "button", "aria-pressed": String(k === cur), onclick: () => { cur = k; draw(); } }, l))),
        cliBlock(cmd[cur]), h("p", { class: "small", style: "margin-top:8px", text: note[cur] }),
        h("details", {}, h("summary", { class: "small", text: "First-time install for real models" }),
          h("ol", { class: "setup small" },
            h("li", {}, "Install PyTorch with CUDA for your GPU from pytorch.org (CPU-only PyTorch leaves the GPU unused — the portal warns you if this happens)."),
            h("li", {}, "pip install -r requirements.txt, then clone and install TRIDENT as described in that file."),
            h("li", {}, "Copy config.example.yaml to config.yaml: add this page's origin, a portal key, slide folders and the GigaTIME / HEX / STPath clones."),
            h("li", {}, "hf auth login, after requesting access on each gated model's Hugging Face page."),
            h("li", {}, "Back here: Connect, then Download weights so the first run doesn't wait on downloads."))));
    };
    draw();
  }

  // ── papers & benchmarks ──────────────────────────────────────────────
  function renderPapers() {
    const box = $("#papersView");
    if (!box || !S.reg) return;
    const tbody = h("tbody");
    const copyAllBtn = h("button", { type: "button", class: "btn ghost small" });
    const searchIn = h("input", { class: "search", type: "search", value: S.papers.q, placeholder: "Filter by model, author, journal, DOI or organ…" });
    const spTabs = [["", "All (" + S.reg.models.length + ")"], ...SPECIES_ORDER.map(k => [k, `${SPECIES_META[k].label} (${S.reg.models.filter(m => m.species === k).length})`])];
    const spWrap = h("div", { class: "seg-ctl", role: "group", "aria-label": "Species scope" });

    const drawRows = () => {
      const q = S.papers.q.toLowerCase();
      const sp = S.papers.species;
      const list = S.reg.models.filter(m =>
        (!sp || m.species === sp) &&
        (!q || [m.name, m.developer, m.paper_label, m.citation, m.hf_repo, m.species_note, famLabel(m.category)].join(" ").toLowerCase().includes(q)));
      copyAllBtn.textContent = `Copy BibTeX (${list.length})`;
      copyAllBtn.onclick = () => copyText(list.map(bibtexFor).join("\n\n"), copyAllBtn);
      spWrap.replaceChildren(...spTabs.map(([k, l]) => h("button", { type: "button", "aria-pressed": String((S.papers.species || "") === k),
        onclick: () => { S.papers.species = k || null; drawRows(); } }, l)));
      tbody.replaceChildren(...(list.length ? list.map(m => {
        const bBtn = h("button", { type: "button", class: "btn ghost small", onclick: () => copyText(bibtexFor(m), bBtn) }, "BibTeX");
        return h("tr", {},
          h("td", {}, h("button", { type: "button", class: "btn ghost small", style: "font-weight:700;padding:2px 6px", onclick: () => openDrawer(m) }, m.name),
            h("span", { class: "paper-cite", text: m.developer })),
          h("td", { text: famLabel(m.category) }),
          h("td", {}, speciesBadge(m) || h("span", { class: "small muted", text: "Human clinical" })),
          h("td", {}, m.paper_url ? h("a", { href: m.paper_url, target: "_blank", rel: "noopener", text: m.paper_label || "Paper" }) : "—",
            m.citation ? h("span", { class: "paper-cite", text: m.citation }) : null),
          h("td", {}, m.link ? h("a", { href: m.link, target: "_blank", rel: "noopener", text: m.hf_repo || "Repository" }) : "—"),
          h("td", {}, bBtn));
      }) : [h("tr", {}, h("td", { colspan: 6, class: "small muted", text: "No models match this search." }))]));
    };
    searchIn.addEventListener("input", e => { S.papers.q = e.target.value; drawRows(); });
    drawRows();

    const benches = (S.reg.benchmarks || []).map(b => h("div", { class: "bench-card" },
      h("div", { style: "display:flex;justify-content:space-between;gap:8px;align-items:baseline" },
        h("h4", { text: b.name }), h("span", { class: "badge", text: b.species })),
      h("p", { text: b.scope }),
      h("div", { class: "bench-links" },
        b.paper_url ? h("a", { href: b.paper_url, target: "_blank", rel: "noopener", text: `Paper (${b.paper_label})` }) : null,
        b.data_url ? h("a", { href: b.data_url, target: "_blank", rel: "noopener", text: "Dataset / code" }) : null)));

    const refs = (S.reg.literature_references || []).map(r => h("div", { class: "bench-card" },
      h("div", { style: "display:flex;justify-content:space-between;gap:8px;align-items:baseline" },
        h("h4", { text: r.name }), h("span", { class: "badge", text: r.status })),
      h("span", { class: "small muted", text: r.developer }),
      h("p", { text: r.scope }),
      h("div", { class: "bench-links" },
        r.paper_url ? h("a", { href: r.paper_url, target: "_blank", rel: "noopener", text: r.paper_label }) : null)));

    box.replaceChildren(
      h("div", { class: "papers-toolbar" }, searchIn, spWrap, copyAllBtn),
      h("div", { class: "card", style: "padding:0;overflow:hidden" },
        h("div", { class: "table-wrap", style: "max-height:560px" },
          h("table", { class: "data" },
            h("thead", {}, h("tr", {}, ["Model", "Family", "Scope", "Paper / preprint", "Weights / repo", "Cite"].map(c => h("th", { text: c })))),
            tbody))),
      benches.length ? h("div", { style: "margin-top:32px" },
        h("h3", { text: "Clinical & preclinical pathology benchmarks" }),
        h("p", { class: "small muted", text: "Standardized evaluation suites for human clinical slides, rodent toxicologic pathology (rat/mouse), multi-organ mouse segmentation, and spatial transcriptomics." }),
        h("div", { class: "bench-grid" }, benches)) : null,
      refs.length ? h("div", { style: "margin-top:32px" },
        h("h3", { text: "Closed-weight preclinical references & ecosystem papers" }),
        h("p", { class: "small muted", text: "Proprietary pharmaceutical rodent toxicology foundation models and domain-adaptation frameworks cited alongside open-weight alternatives." }),
        h("div", { class: "bench-grid" }, refs)) : null);
  }

  // ── open data catalogue & live repository scanner (oncology) ─────────
  const SCAN_PRESETS = [
    ["★ Brain (GBM / Glioma)", "glioblastoma OR glioma histopathology spatial transcriptomics H&E"],
    ["★ Lung (NSCLC / LUAD)", "lung cancer OR NSCLC histopathology spatial transcriptomics immunofluorescence"],
    ["★ Breast (BRCA / HER2 / TNBC)", "breast cancer histopathology spatial transcriptomics immunofluorescence H&E"],
    ["★ Prostate (PRAD / Gleason)", "prostate cancer histopathology Gleason spatial transcriptomics IHC"],
    ["Pan-Cancer Spatial + H&E", "pan-cancer spatial transcriptomics H&E whole slide"],
    ["Cancer H&E + Multiplex IF", "cancer tumor multiplex immunofluorescence H&E co-registered"],
  ];

  const modMeta = k => (S.reg && S.reg.dataset_modalities && S.reg.dataset_modalities[k]) || { label: k, short: k, regime: "unmatched", blurb: "" };
  const modBadge = k => h("span", { class: `mod-badge mod-${k}`, title: modMeta(k).blurb }, h("i"), modMeta(k).short || modMeta(k).label);
  const cancerMeta = k => (S.reg && S.reg.dataset_cancer_sites && S.reg.dataset_cancer_sites[k]) || { label: k, short: k, scope: "organ_specific", priority: false, blurb: "" };
  const cancerBadge = k => h("span", { class: `cancer-badge site-${k}`, title: cancerMeta(k).blurb }, h("i"), cancerMeta(k).short || cancerMeta(k).label);

  function isCancerRelatedLive(txt) {
    return /cancer|carcinoma|tumou?r|oncolog|glioblastoma|\bgbm\b|glioma|adenocarcinoma|sarcoma|melanoma|lymphoma|leukemia|neoplasm|malignan|metasta|\bnsclc\b|\bluad\b|\blusc\b|\bbrca\b|\bprad\b|\bddcis\b|\bdcis\b|\btnbc\b|gleason|her2|tcga|cptac/i.test(String(txt || ""));
  }

  function classifyCancerSiteLive(txt) {
    const t = String(txt || "").toLowerCase();
    const hits = [];
    if (/glioblastoma|\bgbm\b|glioma|astrocytoma|oligodendroglioma|medulloblastoma|meningioma|brain tumou?r|neuro-oncol|\bcns tumou?r/.test(t)) hits.push("brain");
    if (/lung cancer|lung adenocarcinoma|lung squamous|\bnsclc\b|\bsclc\b|\bluad\b|\blusc\b|thoracic tumou?r|pulmonary carcinoma/.test(t)) hits.push("lung");
    if (/breast cancer|breast carcinoma|mammary carcinoma|\bbrca\b|\bdcis\b|\btnbc\b|her2[\s+-]*positive breast|metabric/.test(t)) hits.push("breast");
    if (/prostate cancer|prostate adenocarcinoma|prostatic carcinoma|\bprad\b|gleason|prostatectomy|\bcrpc\b/.test(t)) hits.push("prostate");
    if (/pan[- ]?cancer|multi[- ]?organ cancer|33 cancer|across cancer types|multiple cancer/.test(t) || hits.length > 1) return "pan_cancer";
    return hits[0] || "other_cancer";
  }

  function classifyModalityLive(txt) {
    const t = String(txt || "").toLowerCase();
    const he = /\bh\s*&\s*e\b|\bh&e\b|hematoxylin|haematoxylin|histopatholog|whole[- ]slide|\bwsi\b|brightfield/.test(t);
    const st = /spatial transcriptom|visium|xenium|merfish|cosmx|slide-seq|stereo-seq|st-seq|10x spatial/.test(t);
    const mif = /immunofluorescen|\bmif\b|cycif|codex|phenocycler|multiplex ihc|\bmihc\b|immunohistochem|\bihc\b|\bimc\b|mass cytometry/.test(t);
    const tx = /rna-seq|rnaseq|scrna|snrna|transcriptom|gene expression|single-cell rna|perturbation atlas/.test(t);
    const vqa = /image-text|vision-language|\bvqa\b|caption|pathology report/.test(t);
    if (he && st && mif) return "matched_other";
    if (he && st) return "matched_he_spatial";
    if (he && mif) return "matched_he_if";
    if (he && (tx || vqa)) return "matched_other";
    if (st || (mif && !he)) return "unmatched_spatial";
    if (tx && !he) return "unmatched_tx";
    return "unmatched_he";
  }

  function matchesCancerFilter(d, cf) {
    if (!cf) return true;
    if (cf === "organ_specific") return d.cancer_scope === "organ_specific";
    if (cf === "pan_cancer") return d.cancer_scope === "pan_cancer";
    return d.cancer_site === cf;
  }

  function openDatasetDrawer(ds, keepOpen) {
    const d = $("#drawer");
    S.drawerModel = null;
    const mm = modMeta(ds.modality_group);
    const cm = cancerMeta(ds.cancer_site);
    const spLabel = (SPECIES_META[ds.species] || SPECIES_META.human).label;
    const bibBtn = h("button", { type: "button", class: "btn ghost small", style: "margin-left:8px", onclick: () => copyText(bibtexForDataset(ds), bibBtn) }, "Copy BibTeX");
    const compatModels = (ds.compatible_models || []).map(id => S.byId[id]).filter(Boolean);
    const rows = [
      ["Cancer scope", `${ds.cancer_scope === "pan_cancer" ? "Pan-Cancer" : "Organ-Specific"} — ${cm.label}`],
      ["Tumour entities", ds.tumor_types || ds.organs],
      ["Modality group", mm.label],
      ["Regime", ds.regime === "matched" ? "Matched / paired multimodal" : "Unmatched single-modality"],
      ["Assays & channels", (ds.modalities || []).join(" · ")],
      ["Co-registration", ds.pairing],
      ["Scale", ds.scale],
      ["Species & cohort", `${spLabel} — ${ds.organs}`],
      ["Originating group", ds.developer],
      ["Primary deposit", h("span", {}, h("a", { href: ds.data_url, target: "_blank", rel: "noopener", text: `${ds.source_label} (${ds.data_url.replace(/^https?:\/\//, "").slice(0, 48)})` }))],
      ["Paper / descriptor", h("span", {}, h("a", { href: ds.paper_url, target: "_blank", rel: "noopener", text: ds.paper_label }), bibBtn,
        ds.citation ? h("span", { class: "paper-cite", text: ds.citation }) : null)],
      ["Licence", `${ds.licence} (${ds.commercial_use ? "commercial use allowed" : "academic / non-commercial terms"})`],
      ["Access", ds.gated ? "Terms / DUA acceptance required on host repository" : "Open direct download"],
    ];
    d.replaceChildren(
      h("div", { class: `drawer-head site-${ds.cancer_site}` },
        h("p", { class: "small muted", style: "margin:0 0 4px", text: `${cm.short} · ${mm.label} · ${ds.source_label}` }),
        h("h2", { id: "drawerTitle", text: ds.name }),
        h("button", { class: "icon-btn close-x", "aria-label": "Close", onclick: () => d.close() }, "✕")),
      h("div", { class: "drawer-body" },
        h("dl", { class: "kv" }, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)])),
        ds.description ? h("div", { class: "notice info", text: ds.description }) : null,
        ds.cli ? h("div", {}, h("h3", { text: "Download / Python quickstart", style: "margin-bottom:8px" }), cliBlock(ds.cli)) : null,
        compatModels.length ? h("div", {},
          h("h3", { text: "Use with models in this portal", style: "margin-bottom:6px" }),
          h("p", { class: "small muted", style: "margin-bottom:8px", text: "Click a model to inspect its requirements or launch local inference on downloaded cancer tiles/slides." }),
          h("div", { class: "chips", style: "margin-bottom:0" }, compatModels.map(m =>
            h("button", { type: "button", class: "btn ghost small", onclick: () => openDrawer(m, d.open) }, `${m.name} (${famLabel(m.category)})`)))) : null,
        h("div", { style: "display:flex;gap:10px;flex-wrap:wrap" },
          h("a", { class: "btn", href: ds.data_url, target: "_blank", rel: "noopener", style: "text-decoration:none" }, "Open data deposit ↗"),
          h("a", { class: "btn ghost", href: ds.paper_url, target: "_blank", rel: "noopener", style: "text-decoration:none" }, `Read ${ds.paper_label} ↗`))));
    if (!d.open && !keepOpen) d.showModal();
  }

  function exportDatasetsJson(list) {
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "oncology_open_datasets.json" });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  async function fetchJsonTimeout(url, ms = 12000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async function liveScanRepositories(onUpdate) {
    const q = (S.data.liveQ || "").trim();
    if (!q || S.data.liveBusy) return;
    const hubs = S.data.liveHubs;
    if (!hubs.huggingface && !hubs.zenodo && !hubs.scientific_data) {
      S.data.liveErrors = ["Select at least one repository hub to scan."]; onUpdate(); return;
    }
    S.data.liveBusy = true; S.data.liveErrors = []; onUpdate();
    const tasks = [];
    if (hubs.huggingface) {
      tasks.push(fetchJsonTimeout(`https://huggingface.co/api/datasets?search=${encodeURIComponent(q)}&limit=10&sort=downloads&direction=-1&full=true`)
        .then(arr => (Array.isArray(arr) ? arr : []).map(it => {
          const card = it.cardData || {};
          const desc = String(it.description || card.pretty_name || "").replace(/\s+/g, " ").trim().slice(0, 260);
          const tags = it.tags || [];
          const fullTxt = `${it.id} ${desc} ${tags.join(" ")}`;
          const lic = card.license || (tags.find(t => t.startsWith("license:")) || "").slice(8) || "See card";
          return {
            hub: "Hugging Face", mod: classifyModalityLive(fullTxt), site: classifyCancerSiteLive(fullTxt),
            cancerOk: isCancerRelatedLive(fullTxt), title: card.pretty_name || it.id, sub: it.id,
            url: `https://huggingface.co/datasets/${it.id}`,
            licence: Array.isArray(lic) ? lic.join(", ") : String(lic),
            metric: `${(it.downloads || 0).toLocaleString()} downloads · ${it.likes || 0} likes`,
            date: String(it.lastModified || "").slice(0, 10), desc,
          };
        })).catch(e => { S.data.liveErrors.push(`Hugging Face: ${e.message}`); return []; }));
    }
    if (hubs.zenodo) {
      tasks.push(fetchJsonTimeout(`https://zenodo.org/api/records?q=${encodeURIComponent(q)}&type=dataset&size=10&sort=bestmatch`)
        .then(res => (((res || {}).hits || {}).hits || []).filter(x => ((x.metadata || {}).access_right || "open") === "open").map(x => {
          const m = x.metadata || {};
          const raw = String(m.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 260);
          const fullTxt = `${m.title || ""} ${raw} ${(m.keywords || []).join(" ")}`;
          const doi = x.doi || m.doi || `10.5281/zenodo.${x.id}`;
          return {
            hub: "Zenodo", mod: classifyModalityLive(fullTxt), site: classifyCancerSiteLive(fullTxt),
            cancerOk: isCancerRelatedLive(fullTxt), title: m.title || x.title || `Zenodo ${x.id}`,
            sub: ((m.creators || []).slice(0, 2).map(c => c.name).join(", ")) || doi,
            url: String(doi).startsWith("http") ? doi : `https://doi.org/${doi}`,
            licence: (m.license && m.license.id) || "Open Access",
            metric: `DOI ${doi}`, date: String(m.publication_date || x.created || "").slice(0, 10), desc: raw,
          };
        })).catch(e => { S.data.liveErrors.push(`Zenodo: ${e.message}`); return []; }));
    }
    if (hubs.scientific_data) {
      const eq = `ISSN:"2052-4463" AND (${q}) AND OPEN_ACCESS:Y`;
      tasks.push(fetchJsonTimeout(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(eq)}&format=json&pageSize=10&resultType=core`)
        .then(res => (((res || {}).resultList || {}).result || []).map(r => {
          const title = String(r.title || "").replace(/<[^>]+>/g, "").trim();
          const desc = String(r.abstractText || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 260);
          const fullTxt = `${title} ${desc}`;
          const doi = r.doi || "";
          return {
            hub: "Scientific Data", mod: classifyModalityLive(fullTxt), site: classifyCancerSiteLive(fullTxt),
            cancerOk: isCancerRelatedLive(fullTxt), title, sub: `${String(r.authorString || "").slice(0, 48)} (${r.pubYear || ""})`,
            url: doi ? `https://doi.org/${doi}` : `https://europepmc.org/article/${r.source || "MED"}/${r.id || ""}`,
            licence: "CC-BY-4.0", metric: `${doi || r.id} · cited ${r.citedByCount || 0}`,
            date: r.firstPublicationDate || String(r.pubYear || ""), desc,
          };
        })).catch(e => { S.data.liveErrors.push(`Scientific Data (Europe PMC): ${e.message}`); return []; }));
    }
    const settled = await Promise.all(tasks);
    const rawItems = settled.flat();
    S.data.liveItems = S.data.liveCancerOnly ? rawItems.filter(x => x.cancerOk) : rawItems;
    S.data.liveBusy = false;
    onUpdate();
  }

  function renderDatasetCard(d) {
    const bBtn = h("button", { type: "button", class: "btn ghost small", onclick: () => copyText(bibtexForDataset(d), bBtn) }, "BibTeX");
    return h("div", { class: `data-card site-${d.cancer_site}` },
      h("div", { class: "data-card-head" },
        h("div", {}, h("h4", {}, h("button", { type: "button", onclick: () => openDatasetDrawer(d) }, d.name)),
          h("span", { class: "small muted", text: d.developer })),
        h("span", { class: "hub-badge", text: d.source_label })),
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;align-items:center" },
        cancerBadge(d.cancer_site), modBadge(d.modality_group)),
      h("div", { class: "assay-tags" }, (d.modalities || []).map(a => h("span", { class: "assay-tag", text: a }))),
      h("p", { text: d.description }),
      h("div", { class: "data-meta" },
        h("span", {}, h("strong", { text: "Tumours: " }), d.tumor_types || d.organs),
        h("span", {}, h("strong", { text: "Pairing: " }), d.pairing),
        h("span", {}, h("strong", { text: "Scale: " }), d.scale)),
      h("div", { style: "display:flex;gap:5px;flex-wrap:wrap" },
        speciesBadge(d) || h("span", { class: "badge", text: "Human oncology" }),
        h("span", { class: "badge " + (d.commercial_use ? "free" : "nc"), text: d.commercial_use ? d.licence : "Non-commercial" }),
        d.gated ? h("span", { class: "badge", text: "Terms / DUA" }) : null),
      h("div", { class: "data-foot" },
        h("a", { href: d.data_url, target: "_blank", rel: "noopener", style: "font-weight:700", text: "Deposit ↗" }),
        h("a", { href: d.paper_url, target: "_blank", rel: "noopener", text: d.paper_label + " ↗" }),
        h("span", { style: "margin-left:auto;display:flex;gap:6px" },
          h("button", { type: "button", class: "btn ghost small", onclick: () => openDatasetDrawer(d) }, "CLI & Models"),
          bBtn)));
  }

  function renderData() {
    const box = $("#dataView");
    if (!box || !S.reg) return;
    const all = S.reg.open_datasets || [];
    const countsBox = $("#dataCounts");
    if (countsBox) {
      const prioCount = all.filter(d => ["brain", "lung", "breast", "prostate"].includes(d.cancer_site)).length;
      countsBox.replaceChildren(
        h("div", {}, h("b", { text: all.length }), "cancer datasets"),
        h("div", {}, h("b", { text: all.filter(d => d.cancer_scope === "pan_cancer").length }), "pan-cancer cohorts"),
        h("div", {}, h("b", { text: prioCount }), "Brain · Lung · Breast · Prostate"),
        h("div", {}, h("b", { text: all.filter(d => d.regime === "matched").length }), "matched multimodal"));
    }

    const cancerBar = h("div", { class: "cancer-bar", role: "group", "aria-label": "Cancer scope and priority organ filter" });
    const searchIn = h("input", { class: "search", type: "search", value: S.data.q,
      placeholder: "Search tumour type (GBM, LUAD, HER2, TNBC, Gleason), assay (Visium, Xenium, CyCIF, IMC, scRNA) or DOI…" });
    const hubWrap = h("div", { class: "seg-ctl", role: "group", "aria-label": "Repository hub" });
    const modStrip = h("div", { class: "mod-strip", role: "group", "aria-label": "Modality and pairing regime" });
    const viewWrap = h("div", { class: "seg-ctl", role: "group", "aria-label": "Layout" });
    const copyBibBtn = h("button", { type: "button", class: "btn ghost small" });
    const exportBtn = h("button", { type: "button", class: "btn ghost small" }, "Export JSON");
    const chkComm = h("input", { type: "checkbox" }); chkComm.checked = S.data.commercial;
    const chkOpen = h("input", { type: "checkbox" }); chkOpen.checked = S.data.ungated;
    const resultsHolder = h("div");

    const filterData = () => {
      const f = S.data, q = f.q.toLowerCase();
      return all.filter(d => {
        if (!matchesCancerFilter(d, f.cancer)) return false;
        if (f.mod === "matched" && d.regime !== "matched") return false;
        if (f.mod === "unmatched" && d.regime !== "unmatched") return false;
        if (f.mod && !["matched", "unmatched"].includes(f.mod) && d.modality_group !== f.mod) return false;
        if (f.hub && !(d.hubs || [d.source_hub]).includes(f.hub)) return false;
        if (f.species && d.species !== f.species) return false;
        if (f.commercial && !d.commercial_use) return false;
        if (f.ungated && d.gated) return false;
        if (!q) return true;
        const modelNames = (d.compatible_models || []).map(id => (S.byId[id] || {}).name || id).join(" ");
        const hay = [d.name, d.developer, cancerMeta(d.cancer_site).label, d.cancer_scope, d.tumor_types,
          modMeta(d.modality_group).label, d.regime, (d.modalities || []).join(" "),
          d.pairing, d.source_label, d.organs, d.scale, d.licence, d.paper_label, d.citation, d.description, d.data_url, modelNames].join(" ").toLowerCase();
        return hay.includes(q);
      });
    };

    const drawCatalogue = () => {
      const list = filterData();
      const cancerScoped = all.filter(d => matchesCancerFilter(d, S.data.cancer));
      copyBibBtn.textContent = `Copy BibTeX (${list.length})`;
      copyBibBtn.onclick = () => copyText(list.map(bibtexForDataset).join("\n\n"), copyBibBtn);
      exportBtn.onclick = () => exportDatasetsJson(list);

      const mkCancerPill = (key, label, count, cls = "", isPrio = false) => h("button", {
        type: "button", class: `cancer-pill ${cls}${isPrio ? " priority" : ""}`.trim(),
        "aria-pressed": String(S.data.cancer === key),
        onclick: () => { S.data.cancer = S.data.cancer === key && key ? "" : key; drawCatalogue(); }
      }, cls ? h("span", { class: "sw" }) : null, label, h("span", { class: "n", text: String(count) }));

      cancerBar.replaceChildren(
        h("span", { class: "cancer-bar-label", text: "Scope" }),
        mkCancerPill("", "All Cancers", all.length),
        mkCancerPill("pan_cancer", "Pan-Cancer", all.filter(d => d.cancer_scope === "pan_cancer").length, "site-pan_cancer", true),
        mkCancerPill("organ_specific", "Organ-Specific", all.filter(d => d.cancer_scope === "organ_specific").length),
        h("span", { class: "cancer-sep", "aria-hidden": "true" }),
        h("span", { class: "cancer-bar-label", text: "Priority Organs" }),
        ...["brain", "lung", "breast", "prostate"].map(s =>
          mkCancerPill(s, `★ ${cancerMeta(s).short}`, all.filter(d => d.cancer_site === s).length, `site-${s}`, true)),
        h("span", { class: "cancer-sep", "aria-hidden": "true" }),
        mkCancerPill("other_cancer", cancerMeta("other_cancer").short, all.filter(d => d.cancer_site === "other_cancer").length, "site-other_cancer"));

      const hubTabs = [["", `All hubs (${cancerScoped.length})`], ...DATA_HUB_ORDER.map(k => [
        k, `${S.reg.dataset_hubs[k]} (${cancerScoped.filter(d => (d.hubs || [d.source_hub]).includes(k)).length})`])];
      hubWrap.replaceChildren(...hubTabs.map(([k, l]) => h("button", { type: "button", "aria-pressed": String(S.data.hub === k),
        onclick: () => { S.data.hub = k; drawCatalogue(); } }, l)));

      const modOptions = [
        ["", "All modalities", cancerScoped.length, "linear-gradient(135deg,var(--haem),var(--eosin))"],
        ["matched", "All Matched", cancerScoped.filter(d => d.regime === "matched").length, "var(--eosin)"],
        ["unmatched", "All Unmatched", cancerScoped.filter(d => d.regime === "unmatched").length, "var(--haem)"],
        ...DATA_MOD_ORDER.map(k => [k, modMeta(k).short || modMeta(k).label, cancerScoped.filter(d => d.modality_group === k).length, `var(--d-${k})`]),
      ];
      modStrip.replaceChildren(...modOptions.map(([k, l, n, sw]) => h("button", {
        type: "button", class: "mod-pill", "aria-pressed": String(S.data.mod === k),
        onclick: () => { S.data.mod = S.data.mod === k && k ? "" : k; drawCatalogue(); }
      }, h("span", { class: "sw", style: `background:${sw}` }), l, h("span", { class: "n", text: String(n) }))));

      viewWrap.replaceChildren(...[["table", "Table"], ["by_site", "By Cancer Site"], ["by_mod", "By Modality"]].map(([k, l]) => h("button", {
        type: "button", "aria-pressed": String(S.data.view === k),
        onclick: () => { S.data.view = k; drawCatalogue(); } }, l)));

      if (!list.length) {
        resultsHolder.replaceChildren(h("div", { class: "empty" }, "No cancer datasets match these filters. ",
          h("button", { type: "button", class: "btn ghost small", onclick: () => {
            Object.assign(S.data, { q: "", cancer: "", mod: "", hub: "", species: "", commercial: false, ungated: false });
            searchIn.value = ""; chkComm.checked = false; chkOpen.checked = false; drawCatalogue();
          } }, "Clear filters")));
        return;
      }

      if (S.data.view === "table") {
        const rows = list.map(d => {
          const bBtn = h("button", { type: "button", class: "btn ghost small", onclick: () => copyText(bibtexForDataset(d), bBtn) }, "BibTeX");
          const cliBtn = h("button", { type: "button", class: "btn ghost small", onclick: () => openDatasetDrawer(d) }, "CLI / Info");
          return h("tr", {},
            h("td", {},
              h("button", { type: "button", class: "btn ghost small", style: "font-weight:700;padding:2px 6px;text-align:left", onclick: () => openDatasetDrawer(d) }, d.name),
              h("span", { class: "paper-cite", text: d.developer })),
            h("td", {}, cancerBadge(d.cancer_site), h("span", { class: "paper-cite", text: d.tumor_types || d.organs })),
            h("td", {}, modBadge(d.modality_group), h("span", { class: "paper-cite", text: d.pairing })),
            h("td", {}, h("div", { class: "assay-tags" }, (d.modalities || []).map(a => h("span", { class: "assay-tag", text: a })))),
            h("td", {},
              h("a", { href: d.data_url, target: "_blank", rel: "noopener", style: "font-weight:700", text: d.source_label + " ↗" }),
              h("span", { class: "paper-cite" }, h("a", { href: d.paper_url, target: "_blank", rel: "noopener", text: d.paper_label }))),
            h("td", {},
              h("div", { style: "display:flex;gap:4px;flex-wrap:wrap;margin-bottom:3px" },
                h("span", { class: "badge " + (d.commercial_use ? "free" : "nc"), title: d.licence, text: d.commercial_use ? d.licence : "Non-commercial" }),
                d.gated ? h("span", { class: "badge", text: "DUA / Gated" }) : null),
              h("span", { class: "paper-cite", text: d.scale })),
            h("td", {}, h("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, cliBtn, bBtn)));
        });
        resultsHolder.replaceChildren(
          h("div", { class: "card", style: "padding:0;overflow:hidden" },
            h("div", { class: "table-wrap", style: "max-height:640px" },
              h("table", { class: "data" },
                h("thead", {}, h("tr", {}, ["Dataset", "Cancer site & subtype", "Modality & pairing", "Assays", "Deposit & paper", "Scale & licence", "Actions"].map(c => h("th", { text: c })))),
                h("tbody", {}, rows)))));
      } else if (S.data.view === "by_site") {
        resultsHolder.replaceChildren(...DATA_CANCER_ORDER.filter(k => list.some(d => d.cancer_site === k)).map(k => {
          const cm = cancerMeta(k);
          return h("div", { class: "fam-block" },
            h("div", { class: "fam-head" }, h("span", { class: "sw", style: `background:var(--cs-${k});border-radius:50%` }),
              h("h2", { text: (cm.priority && k !== "pan_cancer" ? "★ " : "") + cm.label }), h("p", { text: cm.blurb })),
            h("div", { class: "data-grid" }, list.filter(d => d.cancer_site === k).map(renderDatasetCard)));
        }));
      } else {
        resultsHolder.replaceChildren(...DATA_MOD_ORDER.filter(k => list.some(d => d.modality_group === k)).map(k => {
          const mm = modMeta(k);
          return h("div", { class: "fam-block" },
            h("div", { class: "fam-head" }, h("span", { class: "sw", style: `background:var(--d-${k})` }), h("h2", { text: mm.label }), h("p", { text: mm.blurb })),
            h("div", { class: "data-grid" }, list.filter(d => d.modality_group === k).map(renderDatasetCard)));
        }));
      }
    };

    searchIn.addEventListener("input", e => { S.data.q = e.target.value; drawCatalogue(); });
    chkComm.addEventListener("change", () => { S.data.commercial = chkComm.checked; drawCatalogue(); });
    chkOpen.addEventListener("change", () => { S.data.ungated = chkOpen.checked; drawCatalogue(); });
    drawCatalogue();

    // Live oncology repository scanner (Zenodo + Scientific Data + Hugging Face)
    const liveBox = h("div", { class: "card scan-panel" });
    const drawScanner = () => {
      const qIn = h("input", { class: "search", type: "search", value: S.data.liveQ, placeholder: "Query oncology datasets on Zenodo, Scientific Data & Hugging Face…" });
      qIn.addEventListener("input", e => { S.data.liveQ = e.target.value; });
      qIn.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); liveScanRepositories(drawScanner); } });
      const hubChecks = [["huggingface", "Hugging Face"], ["zenodo", "Zenodo"], ["scientific_data", "Scientific Data"]].map(([k, lbl]) => {
        const c = h("input", { type: "checkbox" }); c.checked = !!S.data.liveHubs[k];
        c.addEventListener("change", () => { S.data.liveHubs[k] = c.checked; });
        return h("label", { class: "check", style: "padding:0" }, c, lbl);
      });
      const cancerChk = h("input", { type: "checkbox" }); cancerChk.checked = !!S.data.liveCancerOnly;
      cancerChk.addEventListener("change", () => { S.data.liveCancerOnly = cancerChk.checked; });
      const scanBtn = h("button", { type: "button", class: "btn small", onclick: () => liveScanRepositories(drawScanner) },
        S.data.liveBusy ? "Scanning APIs…" : "Scan live");
      scanBtn.disabled = S.data.liveBusy;

      let liveOut = null;
      if (S.data.liveItems) {
        liveOut = S.data.liveItems.length
          ? h("div", { class: "bench-grid", style: "margin-top:12px" }, S.data.liveItems.map(it =>
              h("div", { class: "bench-card" },
                h("div", { style: "display:flex;justify-content:space-between;gap:6px;align-items:flex-start;flex-wrap:wrap" },
                  h("span", { style: "display:flex;gap:5px;flex-wrap:wrap" }, cancerBadge(it.site), modBadge(it.mod)),
                  h("span", { class: "hub-badge", text: it.hub })),
                h("h4", { style: "margin-top:4px" }, h("a", { href: it.url, target: "_blank", rel: "noopener", text: it.title })),
                it.sub ? h("span", { class: "small muted", text: it.sub }) : null,
                it.desc ? h("p", { text: it.desc }) : null,
                h("div", { class: "bench-links", style: "justify-content:space-between" },
                  h("span", { class: "small muted", text: `${it.metric}${it.date ? " · " + it.date : ""}` }),
                  h("span", { class: "badge", text: it.licence })))))
          : h("p", { class: "small muted", style: "margin-top:10px", text: "No open-access cancer datasets returned for this query." });
      }

      liveBox.replaceChildren(
        h("div", { style: "display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline" },
          h("h3", { text: "Live oncology repository scanner — Zenodo · Scientific Data · Hugging Face" }),
          h("span", { class: "small muted", text: "Queries public CORS APIs directly from your browser" })),
        h("p", { class: "small muted", style: "margin-bottom:8px",
          text: "Scan for newly deposited Brain, Lung, Breast, Prostate, or Pan-Cancer histopathology, spatial omics, mIF, and transcriptomic datasets." }),
        h("div", { class: "chips" }, SCAN_PRESETS.map(([lbl, pq]) => h("button", { type: "button", class: "btn ghost small",
          onclick: () => { S.data.liveQ = pq; liveScanRepositories(drawScanner); } }, lbl))),
        h("div", { class: "scan-form" }, qIn, ...hubChecks, h("label", { class: "check", style: "padding:0" }, cancerChk, "Cancer-only filter"), scanBtn),
        S.data.liveErrors.length ? h("div", { class: "notice small", style: "margin-bottom:10px",
          text: "Some endpoints could not be reached from this network: " + S.data.liveErrors.join("; ") }) : null,
        liveOut,
        h("details", { style: "margin-top:12px" },
          h("summary", { class: "small", text: "Run the oncology scanner from the command line" }),
          cliBlock(`python backend/scan_open_data.py --cancer brain\npython backend/scan_open_data.py --cancer lung\npython backend/scan_open_data.py --cancer breast\npython backend/scan_open_data.py --cancer prostate\npython backend/scan_open_data.py --all-priority --out cancer_data_candidates.json`)));
    };
    drawScanner();

    box.replaceChildren(
      h("div", { class: "data-controls" },
        cancerBar,
        h("div", { class: "data-toprow" }, searchIn, hubWrap, h("div", { class: "data-actions" }, viewWrap, copyBibBtn, exportBtn)),
        modStrip,
        h("div", { class: "data-subrow" },
          h("label", { class: "check" }, chkComm, "Commercial use allowed"),
          h("label", { class: "check" }, chkOpen, "No access gate / DUA"))),
      resultsHolder,
      liveBox);
  }

  // ── boot ─────────────────────────────────────────────────────────────
  (async function boot() {
    try { S.reg = await (await fetch("models.json", { cache: "no-cache" })).json(); }
    catch (e) { $("#rack").replaceChildren(h("div", { class: "notice err", text: "Could not load models.json. Serve this folder over HTTP (GitHub Pages, or python -m http.server) rather than opening the file directly." })); return; }
    S.reg.models.forEach(m => (S.byId[m.id] = m));
    (S.reg.open_datasets || []).forEach(d => (S.dataById[d.id] = d));
    renderCounts(); renderFamilies(); renderSpecies(); fillModelSelect();
    renderHwBar();
    HW.detectBrowser().then(b => { S.bhw = b; renderHwBar(); renderRack(); if (S.run.model && !$("#view-run").hidden) renderAside(S.run.model, S.run.task); if (!$("#view-connect").hidden) renderLaunch(); });
    // Arriving from the installer: #setup&url=…&key=… (the fragment never leaves the browser)
    let wizardFrom = null;
    if (location.hash.startsWith("#setup")) {
      const q = new URLSearchParams(location.hash.slice(1).replace(/^setup&?/, ""));
      if (q.get("url")) { S.conn.url = q.get("url"); store.set("fm.url", S.conn.url); }
      if (q.get("key")) { S.conn.key = q.get("key"); store.set("fm.key", S.conn.key); }
      S.conn.mode = "server"; store.set("fm.mode", "server");
      history.replaceState(null, "", location.pathname + location.search + "#models");
      wizardFrom = "installer";
    }
    await autoConnect();
    renderRack();
    window.addEventListener("hashchange", route);
    route();
    window.Portal = { S, api, connect, go, fitFor, refreshWeights, setPill, renderHwBar, renderRack, renderWeightsCard, store,
      findServer, base, onLocalhost };
    window.dispatchEvent(new CustomEvent("portal-ready", { detail: { wizardFrom } }));
  })();
})();
