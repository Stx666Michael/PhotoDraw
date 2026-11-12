(function () {
  'use strict';

  var MAX_SIDE = 1024, MIN_SIDE = 640;
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    start: $('start'), studio: $('studio'), drop: $('drop'), file: $('file'),
    sample: $('sample'), error: $('error'), newPhoto: $('newPhoto'),
    canvas: $('canvas'), busy: $('busy'), busyText: $('busyText'), busyBar: $('busyBar'),
    play: $('play'), iconPlay: $('iconPlay'), iconPause: $('iconPause'), replay: $('replay'),
    stage: $('stage'), clock: $('clock'), progressBar: $('progressBar'), progressFill: $('progressFill'),
    thumb: $('thumb'), statComplexity: $('statComplexity'), statStrokes: $('statStrokes'),
    statLength: $('statLength'), saveVideo: $('saveVideo'), saveImage: $('saveImage'), note: $('note')
  };

  var player = null, recording = false, job = 0, baseName = 'photodraw';

  /* ---------- loading ---------- */

  function showError(msg) {
    el.error.textContent = msg;
    el.error.hidden = false;
  }

  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { showError('That file is not an image. Try a JPEG, PNG or WebP photo.'); return; }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      baseName = (file.name || 'photo').replace(/\.[^.]+$/, '') + '-painting';
      begin(img, url);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      showError('This browser could not open that image. Try a JPEG or PNG version of it.');
    };
    img.src = url;
  }

  // A small procedural landscape, so the app can be tried without a photo.
  function makeSample() {
    var c = document.createElement('canvas');
    c.width = 1200; c.height = 800;
    var x = c.getContext('2d'), g, i, r = seeded(11);
    g = x.createLinearGradient(0, 0, 0, 520);
    g.addColorStop(0, '#1f3a6b'); g.addColorStop(0.55, '#d9785a'); g.addColorStop(1, '#f6c56f');
    x.fillStyle = g; x.fillRect(0, 0, 1200, 520);
    g = x.createRadialGradient(820, 430, 10, 820, 430, 260);
    g.addColorStop(0, 'rgba(255,244,200,1)'); g.addColorStop(0.12, 'rgba(255,225,140,.9)'); g.addColorStop(1, 'rgba(255,200,120,0)');
    x.fillStyle = g; x.fillRect(0, 0, 1200, 520);
    for (i = 0; i < 9; i++) {
      x.fillStyle = 'rgba(' + (235 - i * 6) + ',' + (150 + r() * 50 | 0) + ',' + (140 + r() * 40 | 0) + ',.55)';
      x.beginPath(); x.ellipse(r() * 1200, 80 + r() * 250, 90 + r() * 160, 12 + r() * 22, 0, 0, 7); x.fill();
    }
    [['#4a4a78', 400, 120], ['#35365c', 450, 90], ['#232540', 490, 60]].forEach(function (m, k) {
      x.fillStyle = m[0]; x.beginPath(); x.moveTo(0, 520);
      for (i = 0; i <= 1200; i += 40) x.lineTo(i, m[1] - m[2] * Math.abs(Math.sin(i * 0.004 * (k + 1.3) + k * 2)) - r() * 14);
      x.lineTo(1200, 520); x.fill();
    });
    g = x.createLinearGradient(0, 520, 0, 800);
    g.addColorStop(0, '#e9a868'); g.addColorStop(0.3, '#7d6a86'); g.addColorStop(1, '#17223f');
    x.fillStyle = g; x.fillRect(0, 520, 1200, 280);
    for (i = 0; i < 70; i++) {
      var yy = 525 + r() * 270, ww = 30 + r() * 160;
      x.fillStyle = 'rgba(255,' + (200 + r() * 40 | 0) + ',150,' + (0.1 + r() * 0.3) + ')';
      x.fillRect(820 - ww / 2 + (r() - 0.5) * (yy - 500) * 0.8, yy, ww, 2 + r() * 3);
    }
    for (i = 0; i < 16; i++) {
      var tx = i < 9 ? r() * 330 : 980 + r() * 220, th = 120 + r() * 170, base = 560 + r() * 40, k2;
      x.fillStyle = '#0f1a1c';
      for (k2 = 0; k2 < 7; k2++) {
        x.beginPath();
        x.moveTo(tx, base - th + k2 * th / 8);
        x.lineTo(tx - (10 + k2 * 7), base - th + (k2 + 1.6) * th / 8);
        x.lineTo(tx + (10 + k2 * 7), base - th + (k2 + 1.6) * th / 8);
        x.fill();
      }
      x.fillRect(tx - 3, base - 20, 6, 30);
    }
    x.fillStyle = '#0f1a1c';
    x.beginPath(); x.moveTo(0, 590); x.quadraticCurveTo(200, 560, 380, 600); x.lineTo(0, 640); x.fill();
    x.beginPath(); x.moveTo(1200, 585); x.quadraticCurveTo(1060, 565, 940, 600); x.lineTo(1200, 630); x.fill();
    return c;
  }

  function seeded(a) {
    return function () { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  }

  /* ---------- painting ---------- */

  async function begin(source, objectUrl) {
    var mine = ++job;
    stopPlayer();
    el.error.hidden = true;

    var sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
    if (!sw || !sh) { showError('That image appears to be empty.'); return; }
    var side = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.max(sw, sh)));
    var k = side / Math.max(sw, sh);
    var W = Math.max(16, Math.round(sw * k)), H = Math.max(16, Math.round(sh * k));

    var work = document.createElement('canvas');
    work.width = W; work.height = H;
    var wctx = work.getContext('2d', { willReadFrequently: true });
    wctx.imageSmoothingQuality = 'high';
    wctx.drawImage(source, 0, 0, W, H);

    el.thumb.src = thumbUrl(work);
    if (objectUrl) URL.revokeObjectURL(objectUrl);

    el.start.hidden = true;
    el.studio.hidden = false;
    el.newPhoto.hidden = false;
    el.canvas.width = W; el.canvas.height = H;
    var cx = el.canvas.getContext('2d');
    cx.drawImage(work, 0, 0);
    setBusy(true, 'Studying the photo…', 0);
    setControls(false);
    el.note.textContent = '';
    el.statComplexity.textContent = el.statStrokes.textContent = el.statLength.textContent = '–';

    await new Promise(function (r) { setTimeout(r, 30); });

    var complexity = PhotoDraw.analyzeComplexity(work);
    var duration = PhotoDraw.durationFor(complexity.score);
    var plan = await PhotoDraw.planPainting(wctx.getImageData(0, 0, W, H), duration, function (f, label) {
      if (mine === job) setBusy(true, f < 1 ? 'Planning: ' + label.toLowerCase() + '…' : 'Ready', f);
    });
    if (mine !== job) return;

    el.statComplexity.textContent = Math.round(complexity.score * 100) + ' / 100';
    el.statStrokes.textContent = plan.strokes.length.toLocaleString();
    el.statLength.textContent = clock(duration);

    player = new PhotoDraw.Player(el.canvas, plan);
    player.onFrame = updateProgress;
    player.onEnd = function () { syncPlayButton(); };
    setBusy(false);
    setControls(true);
    updateProgress(player);
    player.play();
    syncPlayButton();
  }

  function thumbUrl(canvas) {
    var t = document.createElement('canvas'), s = 112 / Math.min(canvas.width, canvas.height);
    t.width = Math.round(canvas.width * s); t.height = Math.round(canvas.height * s);
    t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.8);
  }

  function stopPlayer() {
    if (player) { player.destroy(); player = null; }
  }

  function setBusy(on, text, frac) {
    el.busy.hidden = !on;
    if (text) el.busyText.textContent = text;
    if (frac != null) el.busyBar.style.width = Math.round(frac * 100) + '%';
  }

  function setControls(on) {
    [el.play, el.replay, el.saveVideo, el.saveImage].forEach(function (b) { b.disabled = !on; });
  }

  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function updateProgress(p) {
    var f = p.time / p.plan.duration;
    el.progressFill.style.width = (f * 100).toFixed(2) + '%';
    el.progressBar.setAttribute('aria-valuenow', Math.round(f * 100));
    el.clock.textContent = clock(p.time) + ' / ' + clock(p.plan.duration);
    var stage = p.stageName();
    if (el.stage.textContent !== stage) el.stage.textContent = stage;
  }

  function syncPlayButton() {
    var playing = player && player.playing;
    el.iconPause.toggleAttribute('hidden', !playing);
    el.iconPlay.toggleAttribute('hidden', !!playing);
    el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  /* ---------- export ---------- */

  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }

  function videoFormat() {
    if (!window.MediaRecorder || !el.canvas.captureStream) return null;
    var options = [
      ['video/mp4;codecs=avc1.42E01E', 'mp4'], ['video/mp4', 'mp4'],
      ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm']
    ];
    for (var i = 0; i < options.length; i++) {
      if (MediaRecorder.isTypeSupported(options[i][0])) return { mime: options[i][0], ext: options[i][1] };
    }
    return null;
  }

  // Replays the painting from the start while recording the canvas. The
  // recording is real time, so it takes as long as the animation.
  function saveVideo() {
    if (!player || recording) return;
    var fmt = videoFormat();
    if (!fmt) { el.note.textContent = 'This browser cannot record video from a canvas. Try a current Chrome, Edge, Firefox or Safari.'; return; }

    var p = player, stream = el.canvas.captureStream(30), chunks = [], rec;
    try {
      rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 8000000 });
    } catch (e) {
      el.note.textContent = 'Video recording could not start in this browser.';
      return;
    }
    recording = true;
    setControls(false);
    el.note.textContent = 'Recording the painting in real time — keep this tab visible. The video downloads when it finishes.';

    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      stream.getTracks().forEach(function (t) { t.stop(); });
      recording = false;
      if (player !== p) return; // a new photo was loaded meanwhile
      p.onEnd = function () { syncPlayButton(); };
      setControls(true);
      syncPlayButton();
      if (chunks.length) {
        download(new Blob(chunks, { type: fmt.mime.split(';')[0] }), baseName + '.' + fmt.ext);
        el.note.textContent = 'Video saved.';
      } else {
        el.note.textContent = 'The recording came back empty. Please try again.';
      }
    };

    p.pause();
    p.reset();
    p.onEnd = function () {
      syncPlayButton();
      // Hold the finished painting for a moment before the video ends.
      var until = performance.now() + 1500;
      (function hold(now) {
        if (player !== p || now >= until) { if (rec.state !== 'inactive') rec.stop(); return; }
        p.composite();
        requestAnimationFrame(hold);
      })(performance.now());
    };
    rec.start(250);
    p.play();
    syncPlayButton();
  }

  function saveImage() {
    if (!player || recording) return;
    player.finish();
    syncPlayButton();
    el.canvas.toBlob(function (blob) {
      if (blob) download(blob, baseName + '.png');
    }, 'image/png');
  }

  /* ---------- events ---------- */

  el.file.addEventListener('change', function () {
    loadFile(el.file.files[0]);
    el.file.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); el.drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    document.addEventListener(t, function (e) { e.preventDefault(); el.drop.classList.remove('over'); });
  });
  document.addEventListener('drop', function (e) {
    if (recording) return;
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  document.addEventListener('paste', function (e) {
    if (recording) return;
    var items = (e.clipboardData && e.clipboardData.files) || [];
    for (var i = 0; i < items.length; i++) {
      if (/^image\//.test(items[i].type)) { loadFile(items[i]); return; }
    }
  });

  el.sample.addEventListener('click', function () {
    baseName = 'photodraw-sample';
    begin(makeSample());
  });

  el.newPhoto.addEventListener('click', function () {
    if (recording) return;
    job++;
    stopPlayer();
    el.studio.hidden = true;
    el.newPhoto.hidden = true;
    el.start.hidden = false;
  });

  el.play.addEventListener('click', function () {
    if (!player || recording) return;
    if (player.playing) player.pause(); else player.play();
    syncPlayButton();
  });

  el.replay.addEventListener('click', function () {
    if (!player || recording) return;
    player.pause();
    player.reset();
    player.play();
    syncPlayButton();
  });

  el.saveVideo.addEventListener('click', saveVideo);
  el.saveImage.addEventListener('click', saveImage);

  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && player && !recording && !/^(BUTTON|INPUT|A)$/.test(e.target.tagName)) {
      e.preventDefault();
      el.play.click();
    }
  });
})();
