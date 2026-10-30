/* Result panel renderers. Each takes (panel, ctx) and returns a DOM node.
   ctx.file(name) → URL of an output file; ctx.channel(panelId, idx) → Promise<{values,min,max}>. */
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
    }
    kids.flat().forEach(c => c != null && el.append(c.nodeType ? c : document.createTextNode(c)));
    return el;
  };
  const s = (tag, attrs = {}) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // Same inferno-like ramp as the backend PNGs.
  const ANCH = [[0,0,4],[40,11,84],[101,21,110],[159,42,99],[212,72,66],[245,125,21],[250,193,39],[252,255,164]];
  function ramp(t) {
    t = Math.min(1, Math.max(0, t)) * (ANCH.length - 1);
    const i = Math.min(ANCH.length - 2, Math.floor(t)), f = t - i, a = ANCH[i], b = ANCH[i + 1];
    return [0, 1, 2].map(c => Math.round(a[c] + (b[c] - a[c]) * f));
  }
  const rgb = a => `rgb(${a[0]},${a[1]},${a[2]})`;
  const RAMP_CSS = `linear-gradient(90deg, ${[0, .15, .3, .45, .6, .75, .9, 1].map(t => rgb(ramp(t))).join(",")})`;
  // 12 categorical colours, distinguishable in both themes
  const CAT = ["#4e79a7", "#e15759", "#59a14f", "#f28e2b", "#b07aa1", "#76b7b2", "#edc948", "#ff9da7", "#9c755f", "#2f4b7c", "#a0cbe8", "#8cd17d"];
  const fmt = v => (typeof v === "number" ? (Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v * 100) / 100) : v.toPrecision(3)) : String(v));

  function tipFor(container) {
    let t = container.querySelector(".tip");
    if (!t) { t = h("div", { class: "tip", hidden: true }); container.append(t); }
    return {
      show(x, y, content) {
        t.replaceChildren(...[].concat(content)); t.hidden = false;
        const r = container.getBoundingClientRect();
        const left = Math.min(x, r.width - 160);
        t.style.left = left + "px"; t.style.top = y + "px";
      },
      hide() { t.hidden = true; }
    };
  }

  function panelShell(p) {
    return h("div", { class: "panel" }, p.title ? h("h3", { text: p.title }) : null);
  }

  // ── scatter ────────────────────────────────────────────────────────────
  function scatter(p, ctx) {
    const box = panelShell(p);
    const viz = h("div", { class: "viz" });
    const W = 900, H = 400, m = { l: 48, r: 16, t: 12, b: 40 };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": p.title });
    const xs = p.x, ys = p.y;
    const pad = (lo, hi) => { const d = (hi - lo) * .06 || 1; return [lo - d, hi + d]; };
    const [xmin, xmax] = pad(Math.min(...xs), Math.max(...xs)), [ymin, ymax] = pad(Math.min(...ys), Math.max(...ys));
    const sx = v => m.l + (xmax === xmin ? .5 : (v - xmin) / (xmax - xmin)) * (W - m.l - m.r);
    const sy = v => H - m.b - (ymax === ymin ? .5 : (v - ymin) / (ymax - ymin)) * (H - m.t - m.b);
    const ax = s("g", { stroke: css("--line"), "stroke-width": 1 });
    ax.append(s("line", { x1: m.l, y1: H - m.b, x2: W - m.r, y2: H - m.b }), s("line", { x1: m.l, y1: m.t, x2: m.l, y2: H - m.b }));
    svg.append(ax);
    const lx = s("text", { x: (W + m.l) / 2, y: H - 10, "text-anchor": "middle", "font-size": 13, fill: css("--ink-2") }); lx.textContent = p.xlabel || "";
    const ly = s("text", { x: 14, y: (H - m.b) / 2, transform: `rotate(-90 14 ${(H - m.b) / 2})`, "text-anchor": "middle", "font-size": 13, fill: css("--ink-2") }); ly.textContent = p.ylabel || "";
    svg.append(lx, ly);
    const tip = tipFor(viz);
    xs.forEach((x, i) => {
      const c = s("circle", { cx: sx(x), cy: sy(ys[i]), r: xs.length > 400 ? 3 : 6, fill: CAT[(p.group[i] || 0) % CAT.length],
        "fill-opacity": .85, stroke: css("--paper"), "stroke-width": 1.2, tabindex: xs.length <= 200 ? 0 : -1 });
      const show = ev => {
        const r = viz.getBoundingClientRect(), b = c.getBoundingClientRect();
        const kids = [];
        if (p.thumbs && p.thumbs[i]) kids.push(h("img", { src: ctx.file(p.thumbs[i]), alt: "" }));
        kids.push(`${p.names[i]} · ${p.legend[p.group[i]] || ""}`);
        tip.show(b.left - r.left + 6, b.top - r.top + 6, kids);
      };
      c.addEventListener("mouseenter", show); c.addEventListener("focus", show);
      c.addEventListener("mouseleave", () => tip.hide()); c.addEventListener("blur", () => tip.hide());
      svg.append(c);
    });
    viz.append(svg);
    box.append(viz, h("div", { class: "legend" }, p.legend.map((l, i) => h("span", {}, h("i", { style: `background:${CAT[i % CAT.length]}` }), l))));
    return box;
  }

  // ── matrix heatmap ─────────────────────────────────────────────────────
  function matrix(p) {
    const box = panelShell(p);
    const R = p.rows.length, C = p.cols.length;
    const cell = Math.max(4, Math.min(44, Math.floor(640 / Math.max(C, 1))));
    const showRow = R <= 60, showCol = C <= 60;
    const labW = showRow ? 150 : 8, labH = showCol ? 110 : 8;
    const ch = Math.max(4, Math.min(28, cell));
    const W = labW + C * cell + (showCol ? 90 : 4), H = labH + R * ch;
    const cv = h("canvas", { width: W * 2, height: H * 2, style: `width:${W}px;max-width:100%;`, role: "img", "aria-label": p.title });
    const g = cv.getContext("2d");
    g.scale(2, 2);
    const vmin = p.vmin ?? Math.min(...p.values.flat()), vmax = p.vmax ?? Math.max(...p.values.flat());
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
      g.fillStyle = rgb(ramp((p.values[i][j] - vmin) / ((vmax - vmin) || 1)));
      g.fillRect(labW + j * cell, labH + i * ch, cell - (cell > 6 ? 1 : 0), ch - (ch > 6 ? 1 : 0));
    }
    g.fillStyle = css("--ink-2"); g.font = "11px " + css("--font-ui");
    if (showRow) { g.textAlign = "right"; p.rows.forEach((r, i) => g.fillText(String(r).slice(0, 22), labW - 6, labH + i * ch + ch * .7)); }
    if (showCol) p.cols.forEach((c, j) => { g.save(); g.translate(labW + j * cell + cell * .65, labH - 6); g.rotate(-Math.PI / 3); g.textAlign = "left"; g.fillText(String(c).slice(0, 18), 0, 0); g.restore(); });
    const viz = h("div", { class: "viz", style: "overflow:auto" }, cv);
    const tip = tipFor(viz);
    cv.addEventListener("mousemove", ev => {
      const r = cv.getBoundingClientRect(), k = r.width / W;
      const j = Math.floor(((ev.clientX - r.left) / k - labW) / cell), i = Math.floor(((ev.clientY - r.top) / k - labH) / ch);
      if (i >= 0 && j >= 0 && i < R && j < C) tip.show(ev.clientX - r.left, ev.clientY - r.top, `${p.rows[i]} × ${p.cols[j]}: ${fmt(p.values[i][j])}`);
      else tip.hide();
    });
    cv.addEventListener("mouseleave", () => tip.hide());
    box.append(viz, colorbar(vmin, vmax));
    return box;
  }

  function colorbar(lo, hi, fixed) {
    return h("div", { class: "cbar-row" }, fmt(lo), h("span", { class: "cbar", style: `background:${RAMP_CSS}` }), fmt(hi), fixed ? h("span", { text: "(fixed scale)" }) : null);
  }

  // ── bars (one row at a time) ───────────────────────────────────────────
  function bars(p, ctx) {
    const box = panelShell(p);
    const tools = h("div", { class: "panel-tools" });
    const viz = h("div", { class: "viz" });
    let sel = null;
    if (p.rows.length > 1) {
      sel = h("select", { "aria-label": "Row" }, p.rows.map((r, i) => h("option", { value: i, text: r })));
      tools.append(h("label", {}, p.thumbs ? "Tile" : "Show", sel));
    }
    const draw = () => {
      const i = sel ? +sel.value : 0;
      const vals = p.values[i];
      let order = vals.map((_, k) => k);
      if (!p.categorical && vals.length > 12) order.sort((a, b) => vals[b] - vals[a]);
      const max = Math.max(...vals.map(Math.abs), 1e-9);
      const longest = Math.max(...p.labels.map(l => String(l).length));
      const rowH = 22, labW = Math.min(280, Math.max(80, longest * 7 + 16)), W = 720, H = order.length * rowH + 6;
      const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": `${p.title}: ${p.rows[i]}` });
      order.forEach((k, r) => {
        const y = r * rowH + 3, w = Math.max(1, (W - labW - 70) * Math.abs(vals[k]) / max);
        const t = s("text", { x: labW - 8, y: y + 15, "text-anchor": "end", "font-size": 12.5, fill: css("--ink-2") }); t.textContent = p.labels[k];
        const best = k === vals.indexOf(Math.max(...vals));
        const b = s("rect", { x: labW, y: y + 3, width: w, height: rowH - 8, rx: 2, fill: p.categorical ? CAT[k % CAT.length] : (best ? css("--eosin") : css("--haem")), "fill-opacity": best || p.categorical ? 1 : .55 });
        const v = s("text", { x: labW + w + 6, y: y + 15, "font-size": 12, fill: css("--ink") });
        v.textContent = p.percent ? (vals[k] * 100).toFixed(1) + "%" : fmt(vals[k]);
        svg.append(t, b, v);
      });
      const kids = [];
      if (p.thumbs && p.thumbs[i]) kids.push(h("img", { src: ctx.file(p.thumbs[i]), alt: p.rows[i], style: "width:120px;height:120px;object-fit:cover;border-radius:4px;border:1px solid var(--line)" }));
      kids.push(h("div", { style: "flex:1;min-width:0" }, svg));
      viz.replaceChildren(h("div", { style: "display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap" }, kids));
    };
    sel && sel.addEventListener("change", draw);
    draw();
    if (sel) box.append(tools);
    box.append(viz);
    return box;
  }

  // ── spatial map over the slide thumbnail ───────────────────────────────
  function spatial(p, ctx) {
    const box = panelShell(p);
    const tools = h("div", { class: "panel-tools" });
    const chSel = h("select", { "aria-label": "Channel" }, p.channels.map((c, i) => h("option", { value: i, text: c.name })));
    chSel.value = p.default || 0;
    const modeSel = p.rgb ? h("select", { "aria-label": "Mode" }, h("option", { value: "ch", text: "Single channel" }), h("option", { value: "rgb", text: "PCA as RGB" })) : null;
    const op = h("input", { type: "range", min: 0, max: 100, value: 70, "aria-label": "Overlay opacity" });
    tools.append(h("label", {}, "Show", chSel));
    if (modeSel) tools.append(h("label", {}, "Mode", modeSel));
    tools.append(h("label", {}, "Opacity", op));
    const viz = h("div", { class: "viz" });
    const cv = h("canvas", { role: "img", "aria-label": p.title });
    const legend = h("div");
    viz.append(cv);
    box.append(tools, viz, legend);
    const tip = tipFor(viz);
    const img = new Image();
    const cache = {};
    let cur = null;
    const get = i => cache[i] || (cache[i] = ctx.channel(p.id, i));

    async function draw() {
      if (!img.complete || !img.naturalWidth) return;
      const W = img.naturalWidth, H = img.naturalHeight;
      cv.width = W; cv.height = H; cv.style.maxWidth = "100%"; cv.style.maxHeight = "72vh";
      const g = cv.getContext("2d");
      g.drawImage(img, 0, 0);
      const alpha = op.value / 100;
      const sz = Math.max(1, p.patch * p.scale);
      const isRgb = modeSel && modeSel.value === "rgb";
      chSel.disabled = !!isRgb;
      let colours;
      if (isRgb) {
        const [r, gg, b] = await Promise.all(p.rgb.map(get));
        colours = r.values.map((_, k) => `rgb(${Math.round(r.values[k] * 255)},${Math.round(gg.values[k] * 255)},${Math.round(b.values[k] * 255)})`);
        cur = { kind: "rgb" };
        legend.replaceChildren(h("p", { class: "small muted", style: "margin-top:10px", text: "First three principal components mapped to red, green and blue — similar colours mean similar embeddings." }));
      } else {
        const ci = +chSel.value, meta = p.channels[ci], d = await get(ci);
        cur = { kind: meta.kind, meta, d };
        if (meta.kind === "categorical") {
          colours = d.values.map(v => CAT[Math.round(v) % CAT.length]);
          legend.replaceChildren(h("div", { class: "legend" }, meta.labels.map((l, k) => h("span", {}, h("i", { style: `background:${CAT[k % CAT.length]}` }), l))));
        } else {
          const [lo, hi] = meta.fixed || [d.min, d.max];
          colours = d.values.map(v => rgb(ramp((v - lo) / ((hi - lo) || 1))));
          legend.replaceChildren(colorbar(lo, hi, !!meta.fixed));
        }
      }
      g.globalAlpha = alpha;
      p.coords.forEach((c, k) => { g.fillStyle = colours[k]; g.fillRect(c[0] * p.scale, c[1] * p.scale, Math.ceil(sz), Math.ceil(sz)); });
      g.globalAlpha = 1;
    }
    cv.addEventListener("mousemove", ev => {
      if (!cur || cur.kind === "rgb") return tip.hide();
      const r = cv.getBoundingClientRect(), k = cv.width / r.width;
      const x = (ev.clientX - r.left) * k / p.scale, y = (ev.clientY - r.top) * k / p.scale;
      const i = p.coords.findIndex(c => x >= c[0] && x < c[0] + p.patch && y >= c[1] && y < c[1] + p.patch);
      if (i < 0) return tip.hide();
      const v = cur.d.values[i];
      tip.show(ev.clientX - r.left, ev.clientY - r.top, `${cur.meta.kind === "categorical" ? cur.meta.labels[Math.round(v)] : `${cur.meta.name}: ${fmt(v)}`}  ·  (${p.coords[i][0]}, ${p.coords[i][1]})`);
    });
    cv.addEventListener("mouseleave", () => tip.hide());
    [chSel, op].forEach(e => e.addEventListener("input", draw));
    modeSel && modeSel.addEventListener("change", draw);
    img.onload = draw;
    img.src = ctx.file(p.thumb);
    return box;
  }

  // ── virtual-mIF channel grid ───────────────────────────────────────────
  function channels(p, ctx) {
    const box = panelShell(p);
    const tools = h("div", { class: "panel-tools" });
    const sel = h("select", { "aria-label": "Tile" }, p.tiles.map((t, i) => h("option", { value: i, text: t.name })));
    tools.append(h("label", {}, "Tile", sel));
    const grid = h("div", { class: "ch-grid" });
    const draw = () => {
      const t = p.tiles[+sel.value];
      grid.replaceChildren(
        h("figure", {}, h("img", { src: ctx.file(t.thumb), alt: `H&E ${t.name}`, style: "background:var(--glass-2)" }), h("figcaption", {}, h("strong", { text: "H&E" }))),
        ...t.images.map(c => h("figure", {}, h("img", { src: ctx.file(c.src), alt: `${c.name} map`, loading: "lazy" }),
          h("figcaption", {}, h("span", { text: c.name }), h("span", { class: "muted", text: c.mean.toFixed(3) }))))
      );
    };
    sel.addEventListener("change", draw);
    draw();
    box.append(p.tiles.length > 1 ? tools : "", grid, colorbar(0, 1, true));
    return box;
  }

  function vector(p) {
    const box = panelShell(p);
    const v = p.values, W = 720, H = 120, n = v.length;
    const max = Math.max(...v.map(Math.abs), 1e-9);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img", "aria-label": p.title });
    svg.append(s("line", { x1: 0, x2: W, y1: H / 2, y2: H / 2, stroke: css("--line") }));
    const bw = W / n;
    v.forEach((x, i) => svg.append(s("rect", { x: i * bw, width: Math.max(bw - .3, .6), y: x >= 0 ? H / 2 - (x / max) * (H / 2 - 4) : H / 2, height: Math.abs(x / max) * (H / 2 - 4), fill: x >= 0 ? css("--haem") : css("--eosin") })));
    box.append(svg, h("p", { class: "small muted", style: "margin-top:8px", text: `${n} dimensions · max |value| ${fmt(max)} · download the .h5 or .csv below for analysis.` }));
    return box;
  }

  function table(p) {
    const box = panelShell(p);
    let rows = p.rows.slice(), sortCol = -1, dir = 1;
    const isNum = j => rows.every(r => typeof r[j] === "number");
    const tb = h("tbody");
    const fill = () => tb.replaceChildren(...rows.map(r => h("tr", {}, r.map((c, j) => h("td", { class: isNum(j) ? "num" : "", text: fmt(c) })))));
    const head = h("tr", {}, p.columns.map((c, j) => h("th", { class: isNum(j) ? "num" : "", scope: "col", tabindex: 0, text: c,
      onclick: () => { dir = sortCol === j ? -dir : 1; sortCol = j; rows.sort((a, b) => (a[j] > b[j] ? 1 : a[j] < b[j] ? -1 : 0) * dir); fill(); } })));
    fill();
    box.append(h("div", { class: "table-wrap" }, h("table", { class: "data" }, h("thead", {}, head), tb)));
    return box;
  }

  function image(p, ctx) {
    const box = panelShell(p);
    box.append(h("img", { src: ctx.file(p.src), alt: p.title || "", style: "max-width:100%;border-radius:4px;display:block" }));
    return box;
  }

  function note(p) {
    return h("div", { class: "notice " + (p.tone === "warn" ? "" : "info"), text: p.text });
  }

  window.Viewers = {
    render(p, ctx) {
      const f = { scatter, matrix, bars, spatial, channels, vector, table, image, note }[p.type];
      return f ? f(p, ctx) : h("div", { class: "notice", text: `Unknown panel type ${p.type}` });
    },
    h, ramp, CAT
  };
})();
