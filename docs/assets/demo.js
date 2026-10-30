/* Demo mode: synthetic outputs generated in the browser, in exactly the backend's result schema.
   Nothing here is model output — it exists so the interface can be explored without a GPU server. */
(function () {
  "use strict";
  const store = {};           // jobId → { files: {name: url}, spatial: {panelId: Float32Array[]} }
  let seq = 0;

  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const hash = str => [...str].reduce((a, c) => (Math.imul(a, 31) + c.charCodeAt(0)) | 0, 7);

  // smooth 2-D field from a few random gaussian bumps
  function field(r, n = 6) {
    const bumps = Array.from({ length: n }, () => [r(), r(), .08 + r() * .22, r() * 2 - .6]);
    return (x, y) => bumps.reduce((s, [bx, by, w, a]) => s + a * Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * w * w)), 0);
  }

  function tissueThumb(seed, W = 900, H = 620) {
    const r = rng(seed), cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    g.fillStyle = "#f4f2f6"; g.fillRect(0, 0, W, H);
    const shape = (x, y) => { const dx = (x / W - .52) / .38, dy = (y / H - .5) / .36; return dx * dx + dy * dy + .25 * Math.sin(x / 70) * Math.cos(y / 55) < 1; };
    const eos = field(r, 5);
    for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
      if (!shape(x, y)) continue;
      const e = eos(x / W, y / H);
      g.fillStyle = `rgb(${226 + e * 10 | 0},${150 - e * 30 | 0},${190 - e * 10 | 0})`; g.fillRect(x, y, 3, 3);
    }
    for (let i = 0; i < 5200; i++) {
      const x = r() * W, y = r() * H;
      if (!shape(x, y)) continue;
      g.fillStyle = `rgba(${70 + r() * 40 | 0},${40 + r() * 30 | 0},${120 + r() * 50 | 0},.75)`;
      g.beginPath(); g.ellipse(x, y, 1.5 + r() * 2.5, 1.2 + r() * 2, r() * 3, 0, 7); g.fill();
    }
    return { url: cv.toDataURL("image/jpeg", .86), shape, W, H };
  }

  function grid(th, step) {
    const coords = [];
    for (let y = 0; y + step <= th.H; y += step) for (let x = 0; x + step <= th.W; x += step)
      if (th.shape(x + step / 2, y + step / 2)) coords.push([x, y]);
    return coords;
  }

  async function tileImages(files, n = 8) {
    if (files && files.length) {
      return Promise.all([...files].map(f => new Promise(res => {
        const im = new Image(); im.onload = () => res({ name: f.name, img: im, url: im.src }); im.src = URL.createObjectURL(f);
      })));
    }
    const th = tissueThumb(11, 900, 620);
    const base = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = th.url; });
    return Array.from({ length: n }, (_, i) => {
      const cv = document.createElement("canvas"); cv.width = cv.height = 160;
      cv.getContext("2d").drawImage(base, 260 + (i % 4) * 90, 170 + Math.floor(i / 4) * 140, 110, 110, 0, 0, 160, 160);
      const url = cv.toDataURL("image/jpeg", .9);
      const im = new Image(); im.src = url;
      return { name: `synthetic_tile_${i + 1}.jpg`, img: im, url };
    });
  }

  function colourStats(img) {
    const cv = document.createElement("canvas"); cv.width = cv.height = 16;
    const g = cv.getContext("2d"); g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data; let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4; return [r / n / 255, gg / n / 255, b / n / 255];
  }

  function kmeans2(points, k, r) {
    const c = Array.from({ length: k }, () => points[Math.floor(r() * points.length)].slice());
    let lab = new Array(points.length).fill(0);
    for (let it = 0; it < 20; it++) {
      lab = points.map(p => c.reduce((best, cc, j) => { const d = (p[0] - cc[0]) ** 2 + (p[1] - cc[1]) ** 2; return d < best[1] ? [j, d] : best; }, [0, Infinity])[0]);
      c.forEach((cc, j) => { const m = points.filter((_, i) => lab[i] === j); if (m.length) { cc[0] = m.reduce((s, p) => s + p[0], 0) / m.length; cc[1] = m.reduce((s, p) => s + p[1], 0) / m.length; } });
    }
    return lab;
  }

  function channelImage(img, fn) {
    const cv = document.createElement("canvas"); cv.width = cv.height = 128;
    const g = cv.getContext("2d"); g.drawImage(img, 0, 0, 128, 128);
    const id = g.getImageData(0, 0, 128, 128), d = id.data; let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.min(1, Math.max(0, fn(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255))); sum += v;
      const c = Viewers.ramp(v); d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
    }
    g.putImageData(id, 0, 0);
    return { url: cv.toDataURL("image/png"), mean: sum / (d.length / 4) };
  }

  function parseClasses(txt) {
    const names = String(txt || "").split("\n").map(l => l.split(":")[0].trim()).filter(Boolean);
    return names.length >= 2 ? names : ["class A", "class B"];
  }
  const softmax = a => { const m = Math.max(...a), e = a.map(x => Math.exp(x - m)), s = e.reduce((p, q) => p + q, 0); return e.map(x => x / s); };

  async function build(model, task, params, tiles, wsi) {
    const id = "demo" + (++seq);
    const S = store[id] = { files: {}, spatial: {} };
    const r = rng(hash(model.id + task));
    const file = (name, url) => (S.files[name] = url, name);
    const panels = [], summary = [];
    const isTiles = task.endsWith("_tiles");
    const thumbFiles = [];

    if (isTiles) {
      const T = await tileImages(tiles);
      await Promise.all(T.map(t => t.img.decode ? t.img.decode().catch(() => {}) : null));
      T.forEach((t, i) => thumbFiles.push(file(`tile_${i}.jpg`, t.url)));
      const names = T.map(t => t.name), stats = T.map(t => colourStats(t.img));
      summary.push({ label: "Tiles", value: T.length });
      if (task === "embed_tiles") {
        const pts = stats.map(([a, b, c]) => [(a - c) * 10 + r() * .3, (b - (a + c) / 2) * 10 + r() * .3]);
        const k = Math.min(4, T.length), lab = kmeans2(pts, k, r);
        panels.push({ type: "scatter", title: `PCA of ${model.name} embeddings`, x: pts.map(p => p[0]), y: pts.map(p => p[1]), group: lab,
          names, thumbs: thumbFiles, xlabel: "PC1", ylabel: "PC2", legend: Array.from({ length: k }, (_, i) => `Cluster ${i + 1}`) });
        const sim = pts.map(p => pts.map(q => Math.max(-1, 1 - Math.hypot(p[0] - q[0], p[1] - q[1]) / 4)));
        panels.push({ type: "matrix", title: "Cosine similarity", rows: names, cols: names, values: sim, vmin: Math.min(...sim.flat()), vmax: 1 });
        summary.push({ label: "Embedding dim", value: model.embed_dim || 512 });
      } else if (task === "zeroshot_tiles") {
        const cls = parseClasses(params.classes);
        const P = stats.map(st => softmax(cls.map((_, j) => 4 * Math.sin(j * 2.1 + st[0] * 7 + st[2] * 3) + r())));
        panels.push({ type: "bars", title: "Class probabilities", labels: cls, rows: names, values: P, thumbs: thumbFiles, percent: true });
        panels.push({ type: "matrix", title: "Probability matrix (tiles × classes)", rows: names, cols: cls, values: P, vmin: 0, vmax: 1 });
      } else if (task === "vmif_tiles") {
        const ch = (model.channels || []).filter(c => !(model.background_channels || []).includes(c));
        const tilesOut = T.slice(0, 8).map((t, i) => ({ name: t.name, thumb: thumbFiles[i], images: ch.map((c, j) => {
          const w = Math.sin(j * 1.7) * .5, out = channelImage(t.img, (R, G, B) => (1 - B) * (.6 + w) + (R - G) * (.4 - w) + .05 * Math.sin(j));
          return { name: c, src: file(`ch_${i}_${j}.png`, out.url), mean: out.mean };
        }) }));
        panels.push({ type: "channels", title: "Virtual marker maps", tiles: tilesOut });
        panels.push({ type: "matrix", title: "Mean marker signal (tiles × markers)", rows: tilesOut.map(t => t.name), cols: ch,
          values: tilesOut.map(t => t.images.map(x => x.mean)), vmin: 0, vmax: 1 });
      }
    } else {
      const th = tissueThumb(hash(model.id), 900, 620);
      const thumb = file("thumb.jpg", th.url);
      const step = 14, coords = grid(th, step);
      const spatial = (pid, title, chans, cols, extra = {}) => {
        S.spatial[pid] = cols;
        panels.push(Object.assign({ type: "spatial", id: pid, title, coords, patch: step, scale: 1, thumb, channels: chans, default: 0 }, extra));
      };
      const fld = k => { const f = field(rng(hash(model.id) + k)); return coords.map(([x, y]) => f(x / th.W, y / th.H)); };
      summary.push({ label: "Slide", value: wsi ? wsi.name || "slide" : "synthetic slide" }, { label: "Patches", value: coords.length });
      if (task === "embed_wsi") {
        const a = fld(1), b = fld(2), c = fld(3), k = 6;
        const lab = coords.map((_, i) => Math.min(k - 1, Math.floor(((a[i] - Math.min(...a)) / (Math.max(...a) - Math.min(...a) + 1e-9)) * k)));
        const n01 = v => { const lo = Math.min(...v), hi = Math.max(...v); return v.map(x => (x - lo) / (hi - lo || 1)); };
        spatial("embed", `${model.name} patch embeddings on the slide`,
          [{ name: "k-means cluster", kind: "categorical", labels: Array.from({ length: k }, (_, i) => `Cluster ${i + 1}`) },
           { name: "PC1 (red)", kind: "continuous" }, { name: "PC2 (green)", kind: "continuous" }, { name: "PC3 (blue)", kind: "continuous" }],
          [lab, n01(a), n01(b), n01(c)], { rgb: [1, 2, 3] });
        panels.push({ type: "bars", title: "Patches per cluster", labels: Array.from({ length: k }, (_, i) => `Cluster ${i + 1}`), rows: ["Patches"],
          values: [Array.from({ length: k }, (_, j) => lab.filter(l => l === j).length)], categorical: true });
      } else if (task === "zeroshot_wsi") {
        const cls = parseClasses(params.classes), F = cls.map((_, j) => fld(10 + j));
        const P = coords.map((_, i) => softmax(F.map(f => 3 * f[i])));
        spatial("zs", "Zero-shot map", [{ name: "Predicted class", kind: "categorical", labels: cls }, ...cls.map(c => ({ name: `P(${c})`, kind: "continuous", fixed: [0, 1] }))],
          [P.map(p => p.indexOf(Math.max(...p))), ...cls.map((_, j) => P.map(p => p[j]))]);
        panels.push({ type: "bars", title: "Slide-level scores", labels: cls, rows: ["Mean of all patches"], values: [cls.map((_, j) => P.reduce((s, p) => s + p[j], 0) / P.length)], percent: true });
      } else if (task === "vmif_wsi" || task === "st_wsi") {
        const names = task === "st_wsi" ? String(params.genes || "GFAP,SOX2,OLIG2,EGFR,CD44,CHI3L1,VIM,MKI67,PTPRC,CD68,CD163,PECAM1,VEGFA,COL4A1,FN1,POSTN").split(/[,\n]/).map(x => x.trim()).filter(Boolean)
          : (model.channels || []).filter(c => !(model.background_channels || []).includes(c));
        const cols = names.map((_, j) => fld(20 + j).map(v => Math.max(0, v * .4 + .3)));
        spatial(task === "st_wsi" ? "st" : "vmif", task === "st_wsi" ? "Predicted expression (log1p)" : "Virtual multiplex", names.map(n => ({ name: n, kind: "continuous" })), cols);
        panels.push({ type: "table", title: "Ranked by spatial variability", columns: ["Name", "Mean", "SD"],
          rows: names.map((n, j) => { const v = cols[j], m = v.reduce((a, b) => a + b, 0) / v.length; return [n, +m.toFixed(4), +Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length).toFixed(4)]; }).sort((a, b) => b[2] - a[2]) });
      } else if (task === "slide_embed" || task === "slide_zeroshot") {
        if (task === "slide_zeroshot") {
          const cls = parseClasses(params.classes);
          panels.push({ type: "bars", title: "Zero-shot scores", labels: cls, rows: ["Slide"], values: [softmax(cls.map(() => r() * 4))], percent: true });
        }
        panels.push({ type: "vector", title: `${model.name} slide embedding (768-d)`, values: Array.from({ length: 768 }, () => (r() - .5) * 2 * Math.exp(-r() * 2)) });
        panels.push({ type: "image", title: "Slide thumbnail", src: thumb });
      } else if (task === "segment_wsi") {
        panels.push({ type: "image", title: "Tissue segmentation", src: thumb });
      }
    }
    return { id, model_id: model.id, task, status: "done", progress: 1, stage: "Finished", created: Date.now() / 1000, params,
      log: ["Demo mode: synthetic output generated in the browser."],
      result: { demo: true, summary, panels, files: [] } };
  }

  window.Demo = {
    run: build,
    file: (jobId, name) => (store[jobId] && store[jobId].files[name]) || "",
    channel: async (jobId, pid, idx) => {
      const v = store[jobId].spatial[pid][idx];
      return { values: v, min: Math.min(...v), max: Math.max(...v) };
    },
  };
})();
