/*
 * PhotoDraw painting engine.
 *
 * Turns a photo into an ordered list of brush strokes (coarse to fine), and
 * renders those strokes in one of several media. Planning is error-driven: each
 * layer only paints where the canvas still differs from the photo, so simple
 * photos need few strokes and busy photos need many.
 */
(function (global) {
  'use strict';

  /* ---------- media ---------- */

  // kind: how a stroke is drawn.
  //   bristle - opaque bundle of bristle lines (oil)
  //   wash    - a soft-edged, translucent wash that bleeds outwards while it
  //             is wet (watercolor)
  //   line    - one drawn line per stroke; tone comes from hatching a patch
  //             line after line (pencils, ink)
  //   hatch   - a bundle of thin, evenly spaced lines (charcoal)
  var STYLES = {
    oil:        { name: 'Oil paint',      kind: 'bristle', ground: [232, 223, 204], tex: 'weave', sat: 1.14, fillAll: true },
    watercolor: { name: 'Watercolor',     kind: 'wash',    ground: [251, 248, 241], tex: 'paper', sat: 1.2, fillAll: true, alpha: [0.10, 0.42], pool: 0.93, bleed: 0.6, dryTime: 0.9 },
    colorpencil:{ name: 'Colored pencil', kind: 'line',    ground: [248, 244, 235], tex: 'tooth', sat: 1.1, t0: 14, lw: 1.3, alpha: 0.5, spacing: 3.6, shade: 18, smooth: true, gridMul: 1.1 },
    graphite:   { name: 'Graphite',       kind: 'line',    ground: [246, 243, 236], tex: 'tooth', mono: true, t0: 12, lw: 1.1, alpha: 0.42, spacing: 3.8, shade: 22, smooth: true, gridMul: 1.1 },
    charcoal:   { name: 'Charcoal',       kind: 'hatch',   ground: [240, 236, 228], tex: 'grain', mono: true, t0: 10, lw: 3.4, alpha: 0.26, spacing: 4.6, shade: 30, smooth: true, gridMul: 1.1 },
    ink:        { name: 'Pen & ink',      kind: 'line',  ground: [251, 249, 243], tex: 'tooth', mono: true, fixed: [22, 28, 50], t0: 22, lw: 1.0, alpha: 0.85, spacing: 4.6, shade: 0, smooth: true, gridMul: 1.2 }
  };
  var STYLE_ORDER = ['oil', 'watercolor', 'colorpencil', 'graphite', 'charcoal', 'ink'];

  // Longer animations use more, smaller strokes, so they show finer detail.
  var LENGTHS = [
    { id: 'short',    name: 'Short',    mult: 0.5 },
    { id: 'standard', name: 'Standard', mult: 1 },
    { id: 'long',     name: 'Long',     mult: 2 },
    { id: 'epic',     name: 'Epic',     mult: 3.5 }
  ];

  var BASE_LAYERS = [
    { name: 'Blocking in',    size: 0.110, thresh: 0,  minSteps: 2, maxSteps: 6, cap: Infinity },
    { name: 'Building forms', size: 0.050, thresh: 15, minSteps: 2, maxSteps: 8, cap: Infinity },
    { name: 'Shaping',        size: 0.024, thresh: 17, minSteps: 2, maxSteps: 8, cap: 6000 },
    { name: 'Refining',       size: 0.012, thresh: 19, minSteps: 2, maxSteps: 7, cap: 10000 },
    { name: 'Fine details',   size: 0.006, thresh: 21, minSteps: 1, maxSteps: 5, cap: 14000 }
  ];
  var EXTRA_LAYERS = [
    { min: 1.5, name: 'Micro detail',      size: 0.0035, thresh: 16, minSteps: 1, maxSteps: 4, cap: 18000 },
    { min: 3,   name: 'Finishing touches', size: 0.0028, thresh: 13, minSteps: 1, maxSteps: 4, cap: 24000 }
  ];

  function layersFor(detail) {
    var sk = Math.pow(detail, -0.25), tk = Math.pow(detail, -0.35);
    var out = BASE_LAYERS.map(function (l, i) {
      return {
        name: l.name, minSteps: l.minSteps, maxSteps: l.maxSteps,
        size: i ? l.size * sk : l.size,
        thresh: i ? l.thresh * tk : 0,
        cap: l.cap * detail
      };
    });
    EXTRA_LAYERS.forEach(function (l) { if (detail >= l.min) out.push(l); });
    return out;
  }

  var LIGHT = [-0.6, -0.8]; // light direction for the impasto shading

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function nextFrame() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function clampInt(v, n) { v = v | 0; return v < 0 ? 0 : v >= n ? n - 1 : v; }

  /* ---------- image helpers ---------- */

  function blurLine(src, dst, off, stride, n, r) {
    var win = 2 * r + 1, acc = 0, last = n - 1, k, i, a, b;
    for (k = -r; k <= r; k++) acc += src[off + (k < 0 ? 0 : k > last ? last : k) * stride];
    for (i = 0; i < n; i++) {
      dst[off + i * stride] = acc / win;
      a = i - r; b = i + r + 1;
      acc += src[off + (b > last ? last : b) * stride] - src[off + (a < 0 ? 0 : a) * stride];
    }
  }

  // Box blur repeated twice, which is close enough to a gaussian here.
  function blur(src, w, h, r) {
    r = Math.round(r);
    var out = new Float32Array(src);
    if (r < 1) return out;
    var tmp = new Float32Array(src.length), pass, x, y;
    for (pass = 0; pass < 2; pass++) {
      for (y = 0; y < h; y++) blurLine(out, tmp, y * w, 1, w, r);
      for (x = 0; x < w; x++) blurLine(tmp, out, x, w, h, r);
    }
    return out;
  }

  /* ---------- complexity ---------- */

  function norm(v, lo, hi) {
    return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  }

  /**
   * Scores how visually complex a photo is, 0 (flat) to 1 (very busy), from
   * edge density, gradient energy and colour variety. Resolution independent:
   * the photo is measured at a fixed small size.
   */
  function analyzeComplexity(source) {
    var S = 256;
    var sw = source.width, sh = source.height;
    var k = S / Math.max(sw, sh);
    var w = Math.max(8, Math.round(sw * k)), h = Math.max(8, Math.round(sh * k));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(source, 0, 0, w, h);
    var d = cx.getImageData(0, 0, w, h).data;

    var lum = new Float32Array(w * h), hist = new Uint32Array(4096), i, p;
    for (i = 0, p = 0; i < lum.length; i++, p += 4) {
      lum[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      hist[((d[p] >> 4) << 8) | ((d[p + 1] >> 4) << 4) | (d[p + 2] >> 4)]++;
    }

    var edges = 0, gradSum = 0, count = 0, x, y, gx, gy, m;
    for (y = 1; y < h - 1; y++) {
      for (x = 1; x < w - 1; x++) {
        i = y * w + x;
        gx = lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1];
        gy = lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1];
        m = Math.sqrt(gx * gx + gy * gy) / 4;
        gradSum += m; count++;
        if (m > 20) edges++;
      }
    }

    var entropy = 0, n = lum.length, f;
    for (i = 0; i < 4096; i++) {
      if (hist[i]) { f = hist[i] / n; entropy -= f * Math.log2(f); }
    }

    var edgeDensity = edges / count, meanGrad = gradSum / count;
    var score = 0.5 * norm(edgeDensity, 0.02, 0.40) +
                0.25 * norm(meanGrad, 3, 26) +
                0.25 * norm(entropy, 4.5, 10);
    return { score: score, edgeDensity: edgeDensity, meanGradient: meanGrad, colorEntropy: entropy };
  }

  /** Animation length in seconds for a complexity score and a length multiplier. */
  function durationFor(score, mult) {
    return Math.max(5, Math.round((8 + 34 * score) * (mult || 1)));
  }

  /* ---------- stroke rendering ---------- */

  // Adds the part of a stroke's path between positions a and b (in point
  // units, 0 .. n-1), shifted sideways by off, to the current path.
  function pathTo(ctx, s, a, b, off) {
    var i;
    ctx.beginPath();
    edge(ctx, s, a, off, true);
    for (i = Math.floor(a) + 1; i < b; i++) {
      ctx.lineTo(s.pts[2 * i] + off * s.nrm[2 * i], s.pts[2 * i + 1] + off * s.nrm[2 * i + 1]);
    }
    edge(ctx, s, b, off, false);
  }

  function edge(ctx, s, u, off, first) {
    var p = s.pts, q = s.nrm, i = Math.min(s.n - 2, Math.floor(u)), t = u - i;
    var x = p[2 * i] + (p[2 * i + 2] - p[2 * i]) * t + off * (q[2 * i] + (q[2 * i + 2] - q[2 * i]) * t);
    var y = p[2 * i + 1] + (p[2 * i + 3] - p[2 * i + 1]) * t + off * (q[2 * i + 1] + (q[2 * i + 3] - q[2 * i + 1]) * t);
    if (first) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }

  function rgb(r, g, b) {
    return 'rgb(' + Math.round(clamp255(r)) + ',' + Math.round(clamp255(g)) + ',' + Math.round(clamp255(b)) + ')';
  }

  // A bundle of bristle/pencil lines. Drawing a stroke in several partial
  // calls gives the same result as drawing it at once.
  function drawBundle(ctx, s, u0, u1) {
    var rnd = mulberry32(s.seed), last = s.n - 1;
    var nb = s.nb, w = s.w, j, f, off, lw, shade, bs, be, a, b, e;
    ctx.lineCap = s.alpha < 1 ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = s.alpha;

    for (j = 0; j < nb; j++) {
      f = nb === 1 ? 0 : (j / (nb - 1)) * 2 - 1;
      off = f * w * 0.43 + (rnd() - 0.5) * (w / nb) * 0.6;
      lw = s.lw0 + rnd() * (s.lw1 - s.lw0);
      shade = (rnd() - 0.5) * s.shade + f * s.lit * 8;
      // Outer lines start late and run dry early, which rounds the ends.
      e = 0.35 + Math.abs(f);
      bs = rnd() * rnd() * Math.min(1.2, last * 0.3) * e;
      be = last - rnd() * rnd() * Math.min(1.5, last * 0.35) * e;
      a = u0 > bs ? u0 : bs;
      b = u1 < be ? u1 : be;
      if (b <= a) continue;
      pathTo(ctx, s, a, b, off);
      ctx.lineWidth = lw;
      ctx.strokeStyle = rgb(s.r + shade, s.g + shade, s.b + shade);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // A single pencil line: light where the point lands and lifts, firmer in
  // between. Drawing it in several partial calls gives the same result as
  // drawing it at once.
  function drawLine(ctx, s, u0, u1) {
    var rnd = mulberry32(s.seed), last = s.n - 1;
    var lw = s.lw0 + rnd() * (s.lw1 - s.lw0);
    var shade = (rnd() - 0.5) * s.shade;
    var press = 0.75 + rnd() * 0.5;
    var ta = last * (0.06 + rnd() * 0.14), tb = last * (0.72 + rnd() * 0.2);
    var z, a, b;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgb(s.r + shade, s.g + shade, s.b + shade);
    for (z = 0; z < 3; z++) {
      a = z === 0 ? 0 : z === 1 ? ta : tb;
      b = z === 0 ? ta : z === 1 ? tb : last;
      if (a < u0) a = u0;
      if (b > u1) b = u1;
      if (b <= a) continue;
      pathTo(ctx, s, a, b, 0);
      ctx.globalAlpha = Math.min(1, s.alpha * press * (z === 1 ? 1 : 0.5));
      ctx.lineWidth = lw * (z === 1 ? 1 : 0.72);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // A watercolor wash, drawn from its start up to position u1. Nested
  // translucent ribbons, widest and faintest first, give it a soft edge, and a
  // few blooms let the pigment creep out unevenly. While the wash is wet (time
  // is the playback time) the edge and the blooms keep spreading; with no time
  // given the wash is drawn fully dried.
  var WASH_PASSES = 6;
  function drawWash(ctx, s, u1, time) {
    var last = s.n - 1;
    if (u1 > last) u1 = last;
    if (u1 <= 0) return;
    var rnd = mulberry32(s.seed), w = s.w, wet = time !== undefined;
    var g = 1, k, f, off, m, nb, ub, d, r, gb, i, t, x, y, grad;
    if (wet) {
      g = (time - s.t0) / (s.t1 - s.t0 + s.dry);
      g = g < 0 ? 0 : g > 1 ? 1 : g;
      g = 1 - (1 - g) * (1 - g);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (k = 0; k < WASH_PASSES; k++) {
      f = k / (WASH_PASSES - 1); // 0 = outer edge, 1 = core
      off = (rnd() - 0.5) * w * 0.12;
      m = s.pool + (1.03 - s.pool) * f; // pigment settles a little darker at the edge
      ctx.globalAlpha = s.alpha * (0.3 + 0.3 * f);
      ctx.lineWidth = w * (0.4 + 0.65 * (1 - f)) * (1 + s.bleed * g * (1 - f));
      ctx.strokeStyle = rgb(s.r * m, s.g * m, s.b * m);
      pathTo(ctx, s, 0, u1, off);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (w < 6) return;

    // Blooms: pigment carried sideways out of the wash by the water.
    nb = 2 + Math.floor(rnd() * 3);
    for (k = 0; k < nb; k++) {
      ub = rnd() * last;
      d = (rnd() < 0.5 ? -1 : 1) * w * (0.2 + rnd() * 0.45) * (1 + s.bleed);
      r = w * (0.4 + rnd() * 0.45) * (1 + s.bleed);
      if (ub > u1) continue;
      gb = 1;
      if (wet) {
        gb = (time - (s.t0 + ub / last * (s.t1 - s.t0))) / s.dry;
        if (gb <= 0) continue;
        if (gb > 1) gb = 1;
        gb = 1 - (1 - gb) * (1 - gb);
      }
      i = Math.min(s.n - 2, Math.floor(ub)); t = ub - i;
      x = s.pts[2 * i] + (s.pts[2 * i + 2] - s.pts[2 * i]) * t + s.nrm[2 * i] * d * gb;
      y = s.pts[2 * i + 1] + (s.pts[2 * i + 3] - s.pts[2 * i + 1]) * t + s.nrm[2 * i + 1] * d * gb;
      r *= 0.25 + 0.75 * gb;
      grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rgba(s.r, s.g, s.b, s.alpha * 0.55));
      grad.addColorStop(0.5, rgba(s.r, s.g, s.b, s.alpha * 0.22));
      grad.addColorStop(1, rgba(s.r, s.g, s.b, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  }

  function rgba(r, g, b, a) {
    return 'rgba(' + Math.round(clamp255(r)) + ',' + Math.round(clamp255(g)) + ',' + Math.round(clamp255(b)) + ',' + a.toFixed(3) + ')';
  }

  // Washes are always drawn whole (u0 is ignored); see Player for how they
  // are animated.
  function drawStroke(ctx, s, u0, u1) {
    if (s.kind === 'wash') { drawWash(ctx, s, u1); return; }
    if (u1 <= u0) return;
    if (s.kind === 'line') drawLine(ctx, s, u0, u1);
    else drawBundle(ctx, s, u0, u1);
  }

  function catmull(a, b, c, d, t) {
    return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  }

  // Rounds a traced polyline into a smooth curve with points about seg apart.
  function smoothPath(xs, ys, seg) {
    var n = xs.length, ox = [xs[0]], oy = [ys[0]], i, j, m, a, d, t;
    for (i = 0; i < n - 1; i++) {
      a = i > 0 ? i - 1 : i; d = i < n - 2 ? i + 2 : i + 1;
      m = Math.sqrt((xs[i + 1] - xs[i]) * (xs[i + 1] - xs[i]) + (ys[i + 1] - ys[i]) * (ys[i + 1] - ys[i]));
      m = Math.max(1, Math.min(12, Math.ceil(m / seg)));
      for (j = 1; j <= m; j++) {
        t = j / m;
        ox.push(catmull(xs[a], xs[i], xs[i + 1], xs[d], t));
        oy.push(catmull(ys[a], ys[i], ys[i + 1], ys[d], t));
      }
    }
    return [ox, oy];
  }

  function makeStroke(xs, ys, w, r, g, b, seed, layer, nLayers, st, L) {
    var i, a, c, dx, dy, len, total = 0, px = Math.min(1, L / 1024), sm;
    if (st.kind === 'line' || st.kind === 'wash') {
      if (st.kind === 'line') {
        // The slight bow of a line drawn from the wrist.
        var jr = mulberry32(seed ^ 0x5bd1e995), m = xs.length - 1;
        dx = xs[m] - xs[0]; dy = ys[m] - ys[0];
        var bow = (jr() - 0.5) * 0.09;
        for (i = 1; i < m; i++) {
          a = Math.sin(Math.PI * i / m) * bow + (jr() - 0.5) * 0.012;
          xs[i] -= dy * a; ys[i] += dx * a;
        }
      }
      sm = smoothPath(xs, ys, st.kind === 'line' ? 5 : Math.max(3, w * 0.15));
      xs = sm[0]; ys = sm[1];
    }
    var n = xs.length, pts = new Float32Array(2 * n), nrm = new Float32Array(2 * n);
    for (i = 0; i < n; i++) { pts[2 * i] = xs[i]; pts[2 * i + 1] = ys[i]; }
    for (i = 0; i < n; i++) {
      a = i > 0 ? i - 1 : 0; c = i < n - 1 ? i + 1 : n - 1;
      dx = xs[c] - xs[a]; dy = ys[c] - ys[a];
      len = Math.sqrt(dx * dx + dy * dy) || 1;
      nrm[2 * i] = -dy / len; nrm[2 * i + 1] = dx / len;
      if (i > 0) total += Math.sqrt((xs[i] - xs[i - 1]) * (xs[i] - xs[i - 1]) + (ys[i] - ys[i - 1]) * (ys[i] - ys[i - 1]));
    }
    dx = xs[n - 1] - xs[0]; dy = ys[n - 1] - ys[0];
    len = Math.sqrt(dx * dx + dy * dy) || 1;

    var s = {
      pts: pts, nrm: nrm, n: n, w: w, r: r, g: g, b: b, seed: seed, layer: layer, kind: st.kind,
      lit: 0, alpha: 1, nb: 1, lw0: 1, lw1: 1, shade: 0, len: total, t0: 0, t1: 0
    };
    if (st.kind === 'bristle') {
      s.nb = Math.max(3, Math.min(16, Math.round(Math.sqrt(w) * 1.5)));
      s.lw0 = (w / s.nb) * 1.3; s.lw1 = (w / s.nb) * 2.0;
      s.shade = 13;
      s.lit = (-dy / len) * LIGHT[0] + (dx / len) * LIGHT[1];
    } else if (st.kind === 'hatch') {
      var sp = Math.max(st.spacing * px, w / 28);
      s.nb = Math.max(2, Math.round(w * 0.9 / sp));
      s.lw0 = st.lw * px * 0.8; s.lw1 = st.lw * px * 1.25;
      s.alpha = st.alpha;
      s.shade = st.shade;
    } else if (st.kind === 'line') {
      s.w = st.lw * px; // a line has no brush width; this only feeds the timing
      s.lw0 = st.lw * px * 0.8; s.lw1 = st.lw * px * 1.25;
      s.alpha = st.alpha;
      s.shade = st.shade;
    } else {
      var late = layer / Math.max(1, nLayers - 1);
      s.alpha = st.alpha[0] + (st.alpha[1] - st.alpha[0]) * late;
      s.pool = st.pool;
      // Early washes go on wet and spread; later ones go on drier paper, so
      // they bleed less and dry faster.
      s.bleed = st.bleed * (1 - 0.65 * late);
      s.dry = st.dryTime * Math.max(0.15, Math.min(1.3, w / (0.05 * L)));
    }
    return s;
  }

  function fillGround(ctx, W, H, st) {
    ctx.fillStyle = rgb(st.ground[0], st.ground[1], st.ground[2]);
    ctx.fillRect(0, 0, W, H);
  }

  /* ---------- planning ---------- */

  /**
   * Plans the whole painting for a reference image (ImageData).
   * opts: { style, detail, cancelled }.
   * Returns { width, height, strokes, layers, duration, style } or null if cancelled.
   */
  async function planPainting(ref, duration, onProgress, opts) {
    opts = opts || {};
    var st = STYLES[opts.style] || STYLES.oil;
    var detail = opts.detail || 1;
    var cancelled = opts.cancelled || function () { return false; };
    var LAYERS = layersFor(detail);

    var W = ref.width, H = ref.height, N = W * H, L = Math.max(W, H);
    var src = ref.data, i, p;
    var rnd = mulberry32(0x9E3779B1);

    // Reference colour planes, with a mild saturation and contrast lift so the
    // result reads as a painting rather than as a filtered photo.
    var R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), l, v, sat = st.sat || 1;
    for (i = 0, p = 0; i < N; i++, p += 4) {
      l = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
      if (st.mono) {
        R[i] = G[i] = B[i] = clamp255((l - 128) * 1.08 + 128);
      } else {
        R[i] = clamp255((l + (src[p] - l) * sat - 128) * 1.05 + 128);
        G[i] = clamp255((l + (src[p + 1] - l) * sat - 128) * 1.05 + 128);
        B[i] = clamp255((l + (src[p + 2] - l) * sat - 128) * 1.05 + 128);
      }
    }

    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    fillGround(ctx, W, H, st);

    var strokes = [], layerInfo = [];

    for (var li = 0; li < LAYERS.length; li++) {
      var layer = LAYERS[li];
      if (onProgress) onProgress(li / LAYERS.length, layer.name);
      await nextFrame();
      if (cancelled()) return null;

      var w = Math.max(3, L * layer.size);
      var step = Math.max(2, w * 0.5);
      var grid = Math.max(2, Math.round(w * (st.gridMul || 0.5)));
      var br = blur(R, W, H, w * 0.25), bg = blur(G, W, H, w * 0.25), bb = blur(B, W, H, w * 0.25);

      // Smoothed structure tensor: strokes follow edges instead of crossing them.
      var lum = new Float32Array(N);
      for (i = 0; i < N; i++) lum[i] = 0.299 * br[i] + 0.587 * bg[i] + 0.114 * bb[i];
      var jxx = new Float32Array(N), jxy = new Float32Array(N), jyy = new Float32Array(N), x, y, gx, gy;
      for (y = 1; y < H - 1; y++) {
        for (x = 1; x < W - 1; x++) {
          i = y * W + x;
          gx = (lum[i - W + 1] + 2 * lum[i + 1] + lum[i + W + 1] - lum[i - W - 1] - 2 * lum[i - 1] - lum[i + W - 1]) / 8;
          gy = (lum[i + W - 1] + 2 * lum[i + W] + lum[i + W + 1] - lum[i - W - 1] - 2 * lum[i - W] - lum[i - W + 1]) / 8;
          jxx[i] = gx * gx; jxy[i] = gx * gy; jyy[i] = gy * gy;
        }
      }
      var tr = Math.max(2, w * 0.5);
      jxx = blur(jxx, W, H, tr); jxy = blur(jxy, W, H, tr); jyy = blur(jyy, W, H, tr);
      await nextFrame();
      if (cancelled()) return null;

      // The canvas as it is now. Thin-line media are compared blurred, because
      // what the eye sees there is the average tone, not single pixels.
      var cd = ctx.getImageData(0, 0, W, H).data;
      var kr = new Float32Array(N), kg = new Float32Array(N), kb = new Float32Array(N);
      for (i = 0, p = 0; i < N; i++, p += 4) { kr[i] = cd[p]; kg[i] = cd[p + 1]; kb[i] = cd[p + 2]; }
      if (st.smooth) {
        var kbr = Math.max(2, w * 0.3);
        kr = blur(kr, W, H, kbr); kg = blur(kg, W, H, kbr); kb = blur(kb, W, H, kbr);
      }

      // Find the cells that still need paint, and the worst pixel in each.
      var fill = li === 0 && st.fillAll;
      var thr = li === 0 ? (st.fillAll ? -1 : st.t0) : layer.thresh;
      var cells = [], sub = Math.max(1, grid >> 3), cx, cy, x1, y1, sum, cnt, best, bx, by, e;
      for (cy = 0; cy < H; cy += grid) {
        for (cx = 0; cx < W; cx += grid) {
          x1 = Math.min(W, cx + grid); y1 = Math.min(H, cy + grid);
          sum = 0; cnt = 0; best = -1; bx = cx; by = cy;
          for (y = cy; y < y1; y += sub) {
            for (x = cx; x < x1; x += sub) {
              i = y * W + x;
              e = (Math.abs(br[i] - kr[i]) + Math.abs(bg[i] - kg[i]) + Math.abs(bb[i] - kb[i])) / 3;
              sum += e; cnt++;
              if (e > best) { best = e; bx = x; by = y; }
            }
          }
          e = sum / cnt;
          if (fill) {
            cells.push({ x: cx + grid * (0.3 + rnd() * 0.4), y: cy + grid * (0.3 + rnd() * 0.4), e: e });
          } else if (e > thr) {
            cells.push({ x: bx, y: by, e: e });
          }
        }
      }
      if (cells.length > layer.cap) {
        cells.sort(function (a, b) { return b.e - a.e; });
        cells.length = layer.cap;
      }

      // One group of strokes per cell: a single brush stroke, or for pencils
      // the lines of one hatched patch, which stay together in drawing order.
      var groups = [], layerStrokes = [];
      for (var ci = 0; ci < cells.length; ci++) {
        groups.push(st.kind === 'line' ? hatchPatch(cells[ci]) : [trace(cells[ci].x, cells[ci].y)]);
      }
      // Loosely dark-to-light, the way an artist builds a layer.
      groups.forEach(function (g) { var s = g[0]; g.key = rnd() + 0.6 * (0.299 * s.r + 0.587 * s.g + 0.114 * s.b) / 255; });
      groups.sort(function (a, b) { return a.key - b.key; });
      groups.forEach(function (g) { for (var j = 0; j < g.length; j++) layerStrokes.push(g[j]); });

      for (i = 0; i < layerStrokes.length; i++) {
        drawStroke(ctx, layerStrokes[i], 0, layerStrokes[i].n - 1);
        strokes.push(layerStrokes[i]);
      }
      layerInfo.push({ name: layer.name, count: layerStrokes.length, start: 0, end: 0 });
    }

    assignTimes(strokes, layerInfo, duration);
    if (onProgress) onProgress(1, 'Ready');
    return { width: W, height: H, strokes: strokes, layers: layerInfo, duration: duration, style: opts.style || 'oil' };

    // Stroke direction at pixel k: along the edge where there is one, else a
    // loose, slowly turning hatch.
    function dirAt(k, px, py) {
      var a = jxx[k] - jyy[k], b = 2 * jxy[k], th;
      if (Math.sqrt(a * a + b * b) > 1.5) {
        th = 0.5 * Math.atan2(b, a);              // dominant gradient direction
        return [-Math.sin(th), Math.cos(th)];     // draw along the edge
      }
      th = -0.7 + 0.8 * Math.sin(px / L * 5.1 + 1.3) * Math.cos(py / L * 4.3 + 0.7);
      return [Math.cos(th), Math.sin(th)];
    }

    // Pencil: shade a patch the way a hand does, one line after another,
    // mostly back and forth, each with its own start, length and slant.
    function hatchPatch(c) {
      var d = dirAt(clampInt(c.y, H) * W + clampInt(c.x, W), c.x, c.y), tx = d[0], ty = d[1];
      var sp = Math.max(st.spacing * Math.min(1, L / 1024), w / 28);
      var n = Math.max(1, Math.round(w * 0.9 / sp));
      var sgn = rnd() < 0.5 ? 1 : -1, out = [], j, f, off, steps, back;
      for (j = 0; j < n; j++) {
        f = n === 1 ? 0 : (j / (n - 1)) * 2 - 1;
        off = f * w * 0.43 + (rnd() - 0.5) * sp * 0.9;
        steps = layer.minSteps + Math.round(rnd() * (layer.maxSteps - layer.minSteps));
        back = (0.15 + rnd() * 0.35) * steps * step;
        out.push(trace(c.x - ty * off - sgn * tx * back, c.y + tx * off - sgn * ty * back,
          { dx: sgn * tx, dy: sgn * ty, steps: steps, rot: (rnd() - 0.5) * 0.14 }));
        if (rnd() < 0.85) sgn = -sgn;
      }
      return out;
    }

    function trace(x0, y0, hint) {
      var maxSteps = hint ? hint.steps : layer.maxSteps;
      var rc = hint ? Math.cos(hint.rot) : 1, rs = hint ? Math.sin(hint.rot) : 0, d;
      var xi = clampInt(x0, W), yi = clampInt(y0, H), k = yi * W + xi;
      var lj = (rnd() - 0.5) * 9, cr, cg, cb;
      if (st.fixed) {
        cr = st.fixed[0]; cg = st.fixed[1]; cb = st.fixed[2];
      } else {
        cr = br[k] + lj + (rnd() - 0.5) * 5;
        cg = bg[k] + lj + (rnd() - 0.5) * 5;
        cb = bb[k] + lj + (rnd() - 0.5) * 5;
      }
      var xs = [x0], ys = [y0], px = x0, py = y0, ldx = 0, ldy = 0;
      var tx, ty, n, dc, ds, margin = w * 0.5;

      for (var s = 1; s <= maxSteps; s++) {
        xi = clampInt(px, W); yi = clampInt(py, H); k = yi * W + xi;
        if (s > layer.minSteps) {
          // Stop once the canvas already matches the photo better than this colour would.
          dc = Math.abs(br[k] - kr[k]) + Math.abs(bg[k] - kg[k]) + Math.abs(bb[k] - kb[k]);
          ds = Math.abs(br[k] - cr) + Math.abs(bg[k] - cg) + Math.abs(bb[k] - cb);
          if (dc < ds) break;
        }
        d = dirAt(k, px, py);
        tx = d[0] * rc - d[1] * rs; ty = d[0] * rs + d[1] * rc;
        if (s === 1) {
          if (hint ? tx * hint.dx + ty * hint.dy < 0 : rnd() < 0.5) { tx = -tx; ty = -ty; }
        } else {
          if (tx * ldx + ty * ldy < 0) { tx = -tx; ty = -ty; }
          tx = 0.7 * tx + 0.3 * ldx; ty = 0.7 * ty + 0.3 * ldy;
          n = Math.sqrt(tx * tx + ty * ty) || 1; tx /= n; ty /= n;
        }
        px += tx * step; py += ty * step;
        if (px < -margin || px > W + margin || py < -margin || py > H + margin) break;
        xs.push(px); ys.push(py);
        ldx = tx; ldy = ty;
      }
      if (xs.length < 2) { xs.push(x0 + step * 0.6); ys.push(y0 - step * 0.3); }
      return makeStroke(xs, ys, w, cr, cg, cb, (rnd() * 4294967296) >>> 0, li, LAYERS.length, st, L);
    }
  }

  // Spread the strokes over the animation. Early layers have few strokes but
  // get a generous share of time so the block-in is watchable; within a layer
  // longer strokes take longer.
  function assignTimes(strokes, layers, duration) {
    var shareSum = 0, i, k = 0, t = 0;
    layers.forEach(function (l) { l.share = l.count ? Math.pow(l.count, 0.55) : 0; shareSum += l.share; });
    layers.forEach(function (l) {
      var span = shareSum ? duration * l.share / shareSum : 0, weight = 0, s;
      for (i = 0; i < l.count; i++) { s = strokes[k + i]; weight += s.len + s.w * 1.5; }
      l.start = t;
      for (i = 0; i < l.count; i++) {
        s = strokes[k + i];
        s.t0 = t;
        t += span * (s.len + s.w * 1.5) / weight;
        s.t1 = t;
      }
      l.end = t;
      k += l.count;
    });
  }

  /* ---------- surface textures ---------- */

  function makeWeave(W, H) {
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var cx = c.getContext('2d'), img = cx.createImageData(W, H), d = img.data;
    var rnd = mulberry32(7), x, y, p = 0, v;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++, p += 4) {
        v = 236 + 10 * Math.sin(x * 1.9) * Math.sin(y * 1.9) + 7 * Math.sin((x + y) * 0.9) + (rnd() - 0.5) * 14;
        v = v > 255 ? 255 : v;
        d[p] = v; d[p + 1] = v; d[p + 2] = v - 3; d[p + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    return c;
  }

  // Paper surfaces: soft blotches (coarse) plus per-pixel grain (fine).
  var PAPER = {
    paper: { base: 249, fine: 5,  coarse: 7,  cs: 3 },
    tooth: { base: 246, fine: 11, coarse: 5,  cs: 2 },
    grain: { base: 238, fine: 28, coarse: 12, cs: 2 }
  };

  function makeTexture(kind, W, H) {
    if (kind === 'weave') return makeWeave(W, H);
    var P = PAPER[kind] || PAPER.paper, rnd = mulberry32(21), i, p, v;
    var cw = Math.ceil(W / P.cs), ch = Math.ceil(H / P.cs);
    var small = document.createElement('canvas');
    small.width = cw; small.height = ch;
    var sx = small.getContext('2d'), si = sx.createImageData(cw, ch), sd = si.data;
    for (i = 0, p = 0; i < cw * ch; i++, p += 4) {
      v = P.base + (rnd() - 0.5) * 2 * P.coarse;
      sd[p] = sd[p + 1] = sd[p + 2] = v; sd[p + 3] = 255;
    }
    sx.putImageData(si, 0, 0);
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = true;
    cx.drawImage(small, 0, 0, W, H);
    var img = cx.getImageData(0, 0, W, H), d = img.data;
    for (i = 0, p = 0; i < W * H; i++, p += 4) {
      v = clamp255(d[p] + (rnd() - 0.5) * P.fine);
      d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    return c;
  }

  /* ---------- playback ---------- */

  var MAX_WET = 120; // most washes kept wet (redrawn per frame) at once

  /** Plays a plan onto a visible canvas in real time. */
  function Player(display, plan) {
    this.display = display;
    this.plan = plan;
    this.style = STYLES[plan.style] || STYLES.oil;
    this.wet = this.style.kind === 'wash';
    this.dctx = display.getContext('2d');
    this.paint = document.createElement('canvas');
    this.paint.width = plan.width; this.paint.height = plan.height;
    this.pctx = this.paint.getContext('2d');
    this.texture = makeTexture(this.style.tex, plan.width, plan.height);
    this.speed = 1;
    // Snapshots of the painting every so often, so scrubbing backwards only
    // has to repaint a small part of it.
    this.cps = [];
    this.cpEvery = Math.max(1, Math.ceil(plan.strokes.length / 12));
    this.onFrame = null;
    this.onEnd = null;
    this.playing = false;
    this._raf = 0;
    this._tick = this._tick.bind(this);
    this.reset();
  }

  Player.prototype.reset = function () {
    this.time = 0;
    this.cur = 0;
    this.drawn = 0;
    this.ended = false;
    fillGround(this.pctx, this.plan.width, this.plan.height, this.style);
    this.composite();
  };

  Player.prototype.composite = function () {
    var c = this.dctx;
    c.globalCompositeOperation = 'source-over';
    c.drawImage(this.paint, 0, 0);
    if (this.wet) {
      // Washes that are still wet are redrawn every frame so they can spread.
      var strokes = this.plan.strokes, i, s;
      for (i = this.cur; i < strokes.length && strokes[i].t0 < this.time; i++) {
        s = strokes[i];
        drawWash(c, s, (this.time - s.t0) / (s.t1 - s.t0) * (s.n - 1), this.time);
      }
    }
    c.globalCompositeOperation = 'multiply';
    c.drawImage(this.texture, 0, 0);
    c.globalCompositeOperation = 'source-over';
  };

  Player.prototype.advanceTo = function (t) {
    var strokes = this.plan.strokes, s, u;
    this.time = Math.min(t, this.plan.duration);
    if (this.wet) {
      // A wash only goes onto the painting once it has dried, always whole
      // and in order, so the painting is the same however it was reached.
      var done = this.time >= this.plan.duration, live = this.cur;
      while (live < strokes.length && strokes[live].t0 < this.time) live++;
      while (this.cur < live) {
        s = strokes[this.cur];
        if (!done && live - this.cur <= MAX_WET && this.time < s.t1 + s.dry) break;
        drawWash(this.pctx, s, s.n - 1);
        this.cur++;
        if (this.cur % this.cpEvery === 0 && !this.cps[this.cur / this.cpEvery]) this._snap();
      }
    }
    while (!this.wet && this.cur < strokes.length) {
      s = strokes[this.cur];
      if (this.time >= s.t1) {
        drawStroke(this.pctx, s, this.drawn, s.n - 1);
        this.cur++; this.drawn = 0;
        if (this.cur % this.cpEvery === 0 && !this.cps[this.cur / this.cpEvery]) this._snap();
      } else if (this.time > s.t0) {
        u = (this.time - s.t0) / (s.t1 - s.t0) * (s.n - 1);
        drawStroke(this.pctx, s, this.drawn, u);
        this.drawn = u;
        break;
      } else break;
    }
    this.composite();
    var finishing = this.time >= this.plan.duration && !this.ended;
    if (finishing) { this.ended = true; this.playing = false; }
    if (this.onFrame) this.onFrame(this);
    if (finishing && this.onEnd) this.onEnd(this);
  };

  Player.prototype._snap = function () {
    var c = document.createElement('canvas');
    c.width = this.plan.width; c.height = this.plan.height;
    c.getContext('2d').drawImage(this.paint, 0, 0);
    this.cps[this.cur / this.cpEvery] = c;
  };

  /** Jumps to time t (seconds), forwards or backwards, without changing play state. */
  Player.prototype.seek = function (t) {
    t = Math.max(0, Math.min(this.plan.duration, t));
    if (t < this.time) {
      var strokes = this.plan.strokes, lo = 0, hi = strokes.length, mid, k;
      while (lo < hi) { // first stroke that is not finished at t
        mid = (lo + hi) >> 1;
        if (strokes[mid].t1 > t) hi = mid; else lo = mid + 1;
      }
      k = Math.floor(lo / this.cpEvery);
      while (k > 0 && !this.cps[k]) k--;
      if (k > 0) {
        this.pctx.drawImage(this.cps[k], 0, 0);
        this.cur = k * this.cpEvery;
      } else {
        fillGround(this.pctx, this.plan.width, this.plan.height, this.style);
        this.cur = 0;
      }
      this.drawn = 0;
      this.ended = false;
    }
    this.advanceTo(t);
  };

  Player.prototype._tick = function (now) {
    if (!this.playing) return;
    var dt = Math.min(100, now - this._last);
    this._last = now;
    this.advanceTo(this.time + dt / 1000 * this.speed);
    if (this.playing) this._raf = requestAnimationFrame(this._tick);
  };

  Player.prototype.play = function () {
    if (this.playing) return;
    if (this.ended) this.reset();
    this.playing = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  };

  Player.prototype.pause = function () {
    this.playing = false;
    cancelAnimationFrame(this._raf);
  };

  Player.prototype.finish = function () {
    this.pause();
    this.advanceTo(this.plan.duration);
  };

  Player.prototype.stageName = function () {
    var layers = this.plan.layers, i;
    if (this.ended) return 'Finished';
    for (i = layers.length - 1; i >= 0; i--) {
      if (layers[i].count && this.time >= layers[i].start) return layers[i].name;
    }
    return layers[0].name;
  };

  Player.prototype.destroy = function () {
    this.pause();
    this.onFrame = this.onEnd = null;
  };

  global.PhotoDraw = {
    STYLES: STYLES,
    STYLE_ORDER: STYLE_ORDER,
    LENGTHS: LENGTHS,
    analyzeComplexity: analyzeComplexity,
    durationFor: durationFor,
    planPainting: planPainting,
    Player: Player
  };
})(window);
