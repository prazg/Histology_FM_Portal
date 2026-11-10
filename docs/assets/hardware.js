/* Hardware detection + "can this model run here?" advice.
   Two sources:
   - the SERVER (authoritative): /api/health → hardware{} — the machine that actually runs the models;
   - this BROWSER (a hint): cores, approximate memory and GPU name — useful when the server will run on this computer.
   Browsers cannot see GPU memory or CUDA, so browser-only advice is always worded as "likely". */
(function () {
  "use strict";

  async function detectBrowser() {
    const hw = { cores: navigator.hardwareConcurrency || null, memGB: navigator.deviceMemory || null,
      os: osName(), gpu: null, gpuVendor: null, webgpu: false };
    // GPU name via WebGL (most browsers expose the unmasked renderer; some return a generic string)
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (gl) {
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        hw.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        hw.gpuVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        const lose = gl.getExtension("WEBGL_lose_context"); lose && lose.loseContext();
      }
    } catch { /* WebGL disabled */ }
    // WebGPU adapter info, where available (Chromium)
    try {
      if (navigator.gpu) {
        const ad = await Promise.race([navigator.gpu.requestAdapter(), new Promise(r => setTimeout(() => r(null), 1500))]);
        if (ad) {
          hw.webgpu = true;
          const info = ad.info || (ad.requestAdapterInfo ? await ad.requestAdapterInfo() : null);
          if (info) {
            hw.webgpuInfo = { vendor: info.vendor, architecture: info.architecture, description: info.description };
            if (!hw.gpu && info.description) hw.gpu = info.description;
            if (!hw.gpuVendor && info.vendor) hw.gpuVendor = info.vendor;
          }
        }
      }
    } catch { /* not exposed */ }
    const s = `${hw.gpu || ""} ${hw.gpuVendor || ""} ${(hw.webgpuInfo && hw.webgpuInfo.vendor) || ""}`.toLowerCase();
    hw.kind = /nvidia|geforce|quadro|rtx|tesla/.test(s) ? "nvidia" : /apple|m1|m2|m3|m4/.test(s) && /mac/i.test(hw.os) ? "apple"
      : /amd|radeon/.test(s) ? "amd" : /intel/.test(s) ? "intel" : /swiftshader|llvmpipe|software|basic render/.test(s) ? "software" : s.trim() ? "other" : "unknown";
    hw.gpuShort = hw.kind === "software" ? null : shortGpu(hw.gpu);
    return hw;
  }

  function osName() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent;
    return /win/i.test(p) ? "Windows" : /mac/i.test(p) ? "macOS" : /linux|x11/i.test(p) ? "Linux" : /android/i.test(p) ? "Android" : /iphone|ipad|ios/i.test(p) ? "iOS" : "Unknown";
  }
  function shortGpu(r) {
    if (!r) return null;
    let x = r;
    const a = r.match(/^ANGLE \((.*)\)$/);           // "ANGLE (Vendor, Device …, Backend)"
    if (a) { const parts = a[1].split(/,\s*/); x = parts.length >= 2 ? parts[1] : parts[0]; }
    x = x.replace(/ANGLE Metal Renderer:\s*/i, "").replace(/\s*(Direct3D|vs_\d|ps_\d|OpenGL|\(0x[0-9a-f]+\)).*$/i, "").replace(/\/PCIe.*$/i, "").replace(/\s+/g, " ").trim();
    return x || r;
  }

  // ── advice ─────────────────────────────────────────────────────────────
  function tier(model, rules) {
    const gb = model.runtime_weights_gb;
    if (gb == null) return { id: "unknown", label: "Size unknown", cpu: "Weight size is not published, so no estimate." };
    return rules.tiers.find(t => gb <= t.max_gb) || rules.tiers[rules.tiers.length - 1];
  }
  const gbFmt = g => g == null ? "?" : g < 0.1 ? `${Math.round(g * 1000)} MB` : `${g.toFixed(g < 1 ? 2 : 1)} GB`;

  /* Returns {level, badge, text}. level: good | ok | warn | bad | info.
     server: /api/health.hardware or null; browser: detectBrowser() result; perf: measured rows for this model (or null). */
  function fit(model, rules, server, browser, perf) {
    const t = tier(model, rules), W = model.runtime_weights_gb;
    if (!model.runner) return { level: "info", badge: "Not runnable", text: "Catalogue entry only." };
    if (W === 0) return { level: "good", badge: "CPU OK", text: "No neural network weights — runs anywhere." };
    const measured = perf ? bestPerf(perf) : null;
    if (server) {
      const gpus = server.gpus || [];
      const vram = gpus.length ? Math.max(...gpus.map(g => g.vram_total_gb)) : null;
      const ram = server.ram_total_gb;
      const ramWarn = ram && W && ram < W * rules.ram_factor ? ` The server has ${gbFmt(ram)} RAM; loading ${gbFmt(W)} of weights may fail.` : "";
      if (measured && measured.peak_vram_gb != null && vram) {
        const ok = measured.peak_vram_gb <= vram * 0.95;
        return { level: ok ? "good" : "bad", badge: ok ? "Fits your GPU" : "Too big for your GPU",
          text: `Measured on this server: peak GPU memory ${gbFmt(measured.peak_vram_gb)} of ${gbFmt(vram)}.${ramWarn}` };
      }
      if (vram) {
        if (W == null) return { level: "warn", badge: "GPU: unknown fit", text: `Your GPU has ${gbFmt(vram)}; this model's weight size is not published.` };
        const need = W + rules.vram_headroom_gb;
        if (vram >= need) return { level: "good", badge: "Fits your GPU", text: `${gbFmt(W)} of weights + working memory fits in ${gbFmt(vram)} of GPU memory.${ramWarn}` };
        if (vram >= W + 0.5) return { level: "warn", badge: "Tight on your GPU", text: `${gbFmt(W)} of weights leaves little room in ${gbFmt(vram)} — lower the batch size if it runs out of memory.${ramWarn}` };
        return { level: t.id === "small" || t.id === "medium" ? "warn" : "bad", badge: "Too big for your GPU",
          text: `Needs about ${gbFmt(need)} of GPU memory; your GPU has ${gbFmt(vram)}. ${t.id === "small" ? "It can run on the CPU instead." : "Use a larger GPU."}${ramWarn}` };
      }
      // CPU-only server
      const lvl = { small: "good", medium: "ok", large: "warn", xlarge: "bad", unknown: "warn" }[t.id];
      const badge = { small: "CPU OK", medium: "CPU: tiles only", large: "Slow on CPU", xlarge: "Needs a GPU", unknown: "Unknown" }[t.id];
      return { level: lvl, badge, text: `Your server has no usable GPU. ${t.cpu}${ramWarn}` };
    }
    // No server: describe the requirement, adding a browser-based hint
    let hint = "";
    if (browser) {
      if (browser.kind === "nvidia") hint = ` This computer has an NVIDIA GPU (${browser.gpuShort}) — run the server here with CUDA PyTorch to use it.`;
      else if (browser.kind === "apple") hint = " This Mac's GPU is not used by the portal (CUDA only); models run on its CPU.";
      else if (browser.kind !== "unknown") hint = " No NVIDIA GPU detected on this computer, so a server here would run on the CPU.";
    }
    return { level: { small: "good", medium: "ok", large: "warn", xlarge: "bad", unknown: "info" }[t.id], badge: t.label,
      text: `${gbFmt(W)} of weights. ${t.cpu}${hint}` };
  }

  function bestPerf(perf) {
    let best = null;
    for (const task of Object.values(perf)) for (const [dev, d] of Object.entries(task)) {
      if (!best || (d.peak_vram_gb || 0) > (best.peak_vram_gb || 0)) best = Object.assign({ device: dev }, d);
    }
    return best;
  }

  function speedText(perf, task, unit) {
    const t = perf && perf[task];
    if (!t) return null;
    return Object.entries(t).filter(([, d]) => d.items_per_s).map(([dev, d]) =>
      `${dev === "cuda" ? (d.gpu || "GPU") : "CPU"}: ${d.items_per_s >= 1 ? d.items_per_s.toFixed(1) : d.items_per_s.toFixed(2)} ${unit}/s (median of ${d.runs} run${d.runs > 1 ? "s" : ""})`).join(" · ") || null;
  }

  window.HW = { detectBrowser, fit, tier, gbFmt, speedText };
})();
