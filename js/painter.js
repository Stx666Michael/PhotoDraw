/*
 * PhotoDraw painting engine.
 *
 * Turns a photo into an ordered list of brush strokes (coarse to fine), and
 * renders those strokes with a bristle brush. Planning is error-driven: each
 * layer only paints where the canvas still differs from the photo, so simple
 * photos need few strokes and busy photos need many.
 */
(function (global) {
  'use strict';

  var LAYERS = [
    { name: 'Blocking in',    size: 0.110, thresh: 0,  minSteps: 2, maxSteps: 6, cap: Infinity },
    { name: 'Building forms', size: 0.050, thresh: 15, minSteps: 2, maxSteps: 8, cap: Infinity },
    { name: 'Shaping',        size: 0.024, thresh: 17, minSteps: 2, maxSteps: 8, cap: 6000 },
    { name: 'Refining',       size: 0.012, thresh: 19, minSteps: 2, maxSteps: 7, cap: 10000 },
    { name: 'Fine details',   size: 0.006, thresh: 21, minSteps: 1, maxSteps: 5, cap: 14000 }
  ];

  var GROUND = [232, 223, 204]; // primed linen
  var LIGHT = [-0.6, -0.8];     // light direction for the impasto shading

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

  /** Animation length in seconds for a complexity score. */
  function durationFor(score) {
    return Math.round(8 + 34 * score);
  }

  /* ---------- brush ---------- */

  /**
   * Draws the part of a stroke between path positions u0 and u1 (in point
   * units, 0 .. n-1). A stroke is a bundle of opaque bristle lines; drawing it
   * in several partial calls gives the same result as drawing it at once.
   */
  function drawStroke(ctx, s, u0, u1) {
    var pts = s.pts, nrm = s.nrm, last = s.n - 1;
    var rnd = mulberry32(s.seed);
    var nb = s.nb, w = s.w, j, f, off, lw, shade, bs, be, a, b, i, t, edge;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (j = 0; j < nb; j++) {
      f = nb === 1 ? 0 : (j / (nb - 1)) * 2 - 1;
      off = f * w * 0.43 + (rnd() - 0.5) * (w / nb) * 0.6;
      lw = (w / nb) * (1.3 + rnd() * 0.7);
      shade = (rnd() - 0.5) * 13 + f * s.lit * 8;
      // Outer bristles start late and run dry early, which rounds the ends.
      edge = 0.35 + Math.abs(f);
      bs = rnd() * rnd() * Math.min(1.2, last * 0.3) * edge;
      be = last - rnd() * rnd() * Math.min(1.5, last * 0.35) * edge;
      a = u0 > bs ? u0 : bs;
      b = u1 < be ? u1 : be;
      if (b <= a) continue;

      ctx.beginPath();
      i = Math.min(last - 1, Math.floor(a)); t = a - i;
      ctx.moveTo(
        pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * t + off * (nrm[2 * i] + (nrm[2 * i + 2] - nrm[2 * i]) * t),
        pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * t + off * (nrm[2 * i + 1] + (nrm[2 * i + 3] - nrm[2 * i + 1]) * t)
      );
      for (i = Math.floor(a) + 1; i < b; i++) {
        ctx.lineTo(pts[2 * i] + off * nrm[2 * i], pts[2 * i + 1] + off * nrm[2 * i + 1]);
      }
      i = Math.min(last - 1, Math.floor(b)); t = b - i;
      ctx.lineTo(
        pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * t + off * (nrm[2 * i] + (nrm[2 * i + 2] - nrm[2 * i]) * t),
        pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * t + off * (nrm[2 * i + 1] + (nrm[2 * i + 3] - nrm[2 * i + 1]) * t)
      );
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgb(' +
        Math.max(0, Math.min(255, Math.round(s.r + shade))) + ',' +
        Math.max(0, Math.min(255, Math.round(s.g + shade))) + ',' +
        Math.max(0, Math.min(255, Math.round(s.b + shade))) + ')';
      ctx.stroke();
    }
  }

  function makeStroke(xs, ys, w, r, g, b, seed, layer) {
    var n = xs.length, pts = new Float32Array(2 * n), nrm = new Float32Array(2 * n);
    var i, a, c, dx, dy, len, total = 0;
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
    return {
      pts: pts, nrm: nrm, n: n, w: w, r: r, g: g, b: b, seed: seed, layer: layer,
      nb: Math.max(3, Math.min(16, Math.round(Math.sqrt(w) * 1.5))),
      lit: (-dy / len) * LIGHT[0] + (dx / len) * LIGHT[1],
      len: total, t0: 0, t1: 0
    };
  }

  /* ---------- planning ---------- */

  function fillGround(ctx, W, H) {
    ctx.fillStyle = 'rgb(' + GROUND.join(',') + ')';
    ctx.fillRect(0, 0, W, H);
  }

  /**
   * Plans the whole painting for a reference image (ImageData).
   * Returns { width, height, strokes, layers, duration }.
   */
  async function planPainting(ref, duration, onProgress) {
    var W = ref.width, H = ref.height, N = W * H, L = Math.max(W, H);
    var src = ref.data, i, p;
    var rnd = mulberry32(0x9E3779B1);

    // Reference colour planes, with a mild saturation and contrast lift so the
    // result reads as paint rather than as a filtered photo.
    var R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), l;
    for (i = 0, p = 0; i < N; i++, p += 4) {
      l = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
      R[i] = clamp255((l + (src[p] - l) * 1.14 - 128) * 1.05 + 128);
      G[i] = clamp255((l + (src[p + 1] - l) * 1.14 - 128) * 1.05 + 128);
      B[i] = clamp255((l + (src[p + 2] - l) * 1.14 - 128) * 1.05 + 128);
    }

    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    fillGround(ctx, W, H);

    var strokes = [], layerInfo = [];

    for (var li = 0; li < LAYERS.length; li++) {
      var layer = LAYERS[li];
      if (onProgress) onProgress(li / LAYERS.length, layer.name);
      await nextFrame();

      var w = Math.max(3, L * layer.size);
      var step = Math.max(2, w * 0.5);
      var grid = Math.max(2, Math.round(w * 0.5));
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

      var cv = ctx.getImageData(0, 0, W, H).data;

      // Find the cells that still need paint, and the worst pixel in each.
      var cells = [], sub = Math.max(1, grid >> 3), cx, cy, x1, y1, sum, cnt, best, bx, by, e;
      for (cy = 0; cy < H; cy += grid) {
        for (cx = 0; cx < W; cx += grid) {
          x1 = Math.min(W, cx + grid); y1 = Math.min(H, cy + grid);
          sum = 0; cnt = 0; best = -1; bx = cx; by = cy;
          for (y = cy; y < y1; y += sub) {
            for (x = cx; x < x1; x += sub) {
              i = y * W + x; p = i * 4;
              e = (Math.abs(br[i] - cv[p]) + Math.abs(bg[i] - cv[p + 1]) + Math.abs(bb[i] - cv[p + 2])) / 3;
              sum += e; cnt++;
              if (e > best) { best = e; bx = x; by = y; }
            }
          }
          e = sum / cnt;
          if (li === 0) {
            cells.push({ x: cx + grid * (0.3 + rnd() * 0.4), y: cy + grid * (0.3 + rnd() * 0.4), e: e });
          } else if (e > layer.thresh) {
            cells.push({ x: bx, y: by, e: e });
          }
        }
      }
      if (cells.length > layer.cap) {
        cells.sort(function (a, b) { return b.e - a.e; });
        cells.length = layer.cap;
      }

      var layerStrokes = [];
      for (var ci = 0; ci < cells.length; ci++) {
        layerStrokes.push(trace(cells[ci].x, cells[ci].y));
      }
      // Loosely dark-to-light, the way a painter builds a layer.
      layerStrokes.forEach(function (s) { s.key = rnd() + 0.6 * (0.299 * s.r + 0.587 * s.g + 0.114 * s.b) / 255; });
      layerStrokes.sort(function (a, b) { return a.key - b.key; });

      for (i = 0; i < layerStrokes.length; i++) {
        drawStroke(ctx, layerStrokes[i], 0, layerStrokes[i].n - 1);
        strokes.push(layerStrokes[i]);
      }
      layerInfo.push({ name: layer.name, count: layerStrokes.length, start: 0, end: 0 });
    }

    assignTimes(strokes, layerInfo, duration);
    if (onProgress) onProgress(1, 'Ready');
    return { width: W, height: H, strokes: strokes, layers: layerInfo, duration: duration };

    function trace(x0, y0) {
      var xi = clampInt(x0, W), yi = clampInt(y0, H), k = yi * W + xi;
      var lj = (rnd() - 0.5) * 9;
      var cr = br[k] + lj + (rnd() - 0.5) * 5;
      var cg = bg[k] + lj + (rnd() - 0.5) * 5;
      var cb = bb[k] + lj + (rnd() - 0.5) * 5;
      var xs = [x0], ys = [y0], px = x0, py = y0, ldx = 0, ldy = 0;
      var a, b, mag, th, tx, ty, n, dc, ds, q, margin = w * 0.5;

      for (var s = 1; s <= layer.maxSteps; s++) {
        xi = clampInt(px, W); yi = clampInt(py, H); k = yi * W + xi; q = k * 4;
        if (s > layer.minSteps) {
          // Stop once the canvas already matches the photo better than this colour would.
          dc = Math.abs(br[k] - cv[q]) + Math.abs(bg[k] - cv[q + 1]) + Math.abs(bb[k] - cv[q + 2]);
          ds = Math.abs(br[k] - cr) + Math.abs(bg[k] - cg) + Math.abs(bb[k] - cb);
          if (dc < ds) break;
        }
        a = jxx[k] - jyy[k]; b = 2 * jxy[k];
        mag = Math.sqrt(a * a + b * b);
        if (mag > 1.5) {
          th = 0.5 * Math.atan2(b, a);       // dominant gradient direction
          tx = -Math.sin(th); ty = Math.cos(th); // paint along the edge
        } else {
          // Flat area: a loose, slowly turning hatch.
          th = -0.7 + 0.8 * Math.sin(px / L * 5.1 + 1.3) * Math.cos(py / L * 4.3 + 0.7);
          tx = Math.cos(th); ty = Math.sin(th);
        }
        if (s === 1) {
          if (rnd() < 0.5) { tx = -tx; ty = -ty; }
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
      return makeStroke(xs, ys, w, cr, cg, cb, (rnd() * 4294967296) >>> 0, li);
    }
  }

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function clampInt(v, n) { v = v | 0; return v < 0 ? 0 : v >= n ? n - 1 : v; }

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

  /* ---------- playback ---------- */

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

  /** Plays a plan onto a visible canvas in real time. */
  function Player(display, plan) {
    this.display = display;
    this.plan = plan;
    this.dctx = display.getContext('2d');
    this.paint = document.createElement('canvas');
    this.paint.width = plan.width; this.paint.height = plan.height;
    this.pctx = this.paint.getContext('2d');
    this.weave = makeWeave(plan.width, plan.height);
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
    fillGround(this.pctx, this.plan.width, this.plan.height);
    this.composite();
  };

  Player.prototype.composite = function () {
    var c = this.dctx;
    c.globalCompositeOperation = 'source-over';
    c.drawImage(this.paint, 0, 0);
    c.globalCompositeOperation = 'multiply';
    c.drawImage(this.weave, 0, 0);
    c.globalCompositeOperation = 'source-over';
  };

  Player.prototype.advanceTo = function (t) {
    var strokes = this.plan.strokes, s, u;
    this.time = Math.min(t, this.plan.duration);
    while (this.cur < strokes.length) {
      s = strokes[this.cur];
      if (this.time >= s.t1) {
        drawStroke(this.pctx, s, this.drawn, s.n - 1);
        this.cur++; this.drawn = 0;
      } else if (this.time > s.t0) {
        u = (this.time - s.t0) / (s.t1 - s.t0) * (s.n - 1);
        drawStroke(this.pctx, s, this.drawn, u);
        this.drawn = u;
        break;
      } else break;
    }
    this.composite();
    if (this.onFrame) this.onFrame(this);
    if (this.time >= this.plan.duration && !this.ended) {
      this.ended = true;
      this.playing = false;
      if (this.onEnd) this.onEnd(this);
    }
  };

  Player.prototype._tick = function (now) {
    if (!this.playing) return;
    var dt = Math.min(100, now - this._last);
    this._last = now;
    this.advanceTo(this.time + dt / 1000);
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
    analyzeComplexity: analyzeComplexity,
    durationFor: durationFor,
    planPainting: planPainting,
    Player: Player
  };
})(window);
