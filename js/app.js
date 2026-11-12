(function () {
  'use strict';

  var MAX_SIDE = 1024, MIN_SIDE = 640;
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    start: $('start'), studio: $('studio'), drop: $('drop'), file: $('file'),
    sample: $('sample'), error: $('error'), newPhoto: $('newPhoto'),
    canvas: $('canvas'), busy: $('busy'), busyText: $('busyText'), busyBar: $('busyBar'),
    play: $('play'), iconPlay: $('iconPlay'), iconPause: $('iconPause'), replay: $('replay'),
    stage: $('stage'), clock: $('clock'), scrub: $('scrub'), speedChips: $('speedChips'),
    thumb: $('thumb'), statComplexity: $('statComplexity'), statStrokes: $('statStrokes'),
    statLength: $('statLength'), options: $('options'), styleChips: $('styleChips'), lenChips: $('lenChips'), startNote: $('startNote'), meta: $('meta'), saveVideo: $('saveVideo'), saveImage: $('saveImage'), note: $('note'), queue: $('queue'), queueList: $('queueList')
  };

  var player = null, job = 0, baseName = 'photodraw';
  var work = null, complexity = null, opts = loadOpts();
  var SPEEDS = [0.5, 1, 2, 4], speed = 1, scrubbing = false, wasPlaying = false, scrubTarget = null;

  /* ---------- options: medium and length ---------- */

  function loadOpts() {
    var o = { style: 'oil', length: 'standard' };
    try {
      var saved = JSON.parse(localStorage.getItem('photodraw-options') || '{}');
      if (PhotoDraw.STYLES[saved.style]) o.style = saved.style;
      if (PhotoDraw.LENGTHS.some(function (l) { return l.id === saved.length; })) o.length = saved.length;
    } catch (e) { /* storage unavailable: defaults are fine */ }
    return o;
  }

  function saveOpts() {
    try { localStorage.setItem('photodraw-options', JSON.stringify(opts)); } catch (e) { /* ignore */ }
  }

  function currentLength() {
    return PhotoDraw.LENGTHS.filter(function (l) { return l.id === opts.length; })[0];
  }

  function chip(group, value, label, sub, checked) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', checked ? 'true' : 'false');
    b.dataset.group = group;
    b.dataset.value = value;
    b.textContent = label;
    if (sub) {
      var i = document.createElement('small');
      i.className = 'num';
      i.textContent = sub;
      b.appendChild(i);
    }
    return b;
  }

  function renderOptions() {
    el.styleChips.textContent = '';
    PhotoDraw.STYLE_ORDER.forEach(function (id) {
      el.styleChips.appendChild(chip('style', id, PhotoDraw.STYLES[id].name, '', id === opts.style));
    });
    el.lenChips.textContent = '';
    PhotoDraw.LENGTHS.forEach(function (l) {
      var sub = complexity ? clock(PhotoDraw.durationFor(complexity.score, l.mult)) : '';
      el.lenChips.appendChild(chip('length', l.id, l.name, sub, l.id === opts.length));
    });
  }

  function onChoose(e) {
    var b = e.target.closest('.chip');
    if (!b || b.getAttribute('aria-checked') === 'true') return;
    opts[b.dataset.group] = b.dataset.value;
    saveOpts();
    renderOptions();
    if (work) paint();
  }

  // The option pickers live on the start screen, or under the player once a photo is loaded.
  function dock() {
    if (el.studio.hidden) el.start.insertBefore(el.options, el.startNote);
    else el.studio.insertBefore(el.options, el.meta);
  }

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

  // Prepares a photo (resized working copy, thumbnail, complexity score) and paints it.
  async function begin(source, objectUrl) {
    var mine = ++job;
    stopPlayer();
    el.error.hidden = true;

    var sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
    if (!sw || !sh) { showError('That image appears to be empty.'); return; }
    var side = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.max(sw, sh)));
    var k = side / Math.max(sw, sh);
    var W = Math.max(16, Math.round(sw * k)), H = Math.max(16, Math.round(sh * k));

    work = document.createElement('canvas');
    work.width = W; work.height = H;
    var wctx = work.getContext('2d', { willReadFrequently: true });
    wctx.imageSmoothingQuality = 'high';
    wctx.drawImage(source, 0, 0, W, H);

    el.thumb.src = thumbUrl(work);
    if (objectUrl) URL.revokeObjectURL(objectUrl);

    el.start.hidden = true;
    el.studio.hidden = false;
    el.newPhoto.hidden = false;
    dock();
    el.canvas.width = W; el.canvas.height = H;
    el.canvas.getContext('2d').drawImage(work, 0, 0);
    setBusy(true, 'Studying the photo…', 0);
    setControls(false);
    el.note.textContent = '';
    el.statComplexity.textContent = el.statStrokes.textContent = el.statLength.textContent = '–';

    await new Promise(function (r) { setTimeout(r, 30); });
    if (mine !== job) return;
    complexity = PhotoDraw.analyzeComplexity(work);
    el.statComplexity.textContent = Math.round(complexity.score * 100) + ' / 100';
    renderOptions();
    paint();
  }

  // (Re)paints the current photo with the chosen medium and length.
  async function paint() {
    if (!work) return;
    var mine = ++job;
    stopPlayer();
    var len = currentLength(), duration = PhotoDraw.durationFor(complexity.score, len.mult);
    var W = work.width, H = work.height;
    el.canvas.getContext('2d').drawImage(work, 0, 0);
    setBusy(true, 'Planning…', 0);
    setControls(false);
    el.note.textContent = '';
    el.statStrokes.textContent = el.statLength.textContent = '–';

    var plan = await PhotoDraw.planPainting(work.getContext('2d').getImageData(0, 0, W, H), duration, function (f, label) {
      if (mine === job) setBusy(true, f < 1 ? 'Planning: ' + label.toLowerCase() + '…' : 'Ready', f);
    }, { style: opts.style, detail: len.mult, cancelled: function () { return mine !== job; } });
    if (!plan || mine !== job) return;

    el.statStrokes.textContent = plan.strokes.length.toLocaleString();
    el.statLength.textContent = clock(duration);

    player = new PhotoDraw.Player(el.canvas, plan);
    player.speed = speed;
    player.onFrame = updateProgress;
    player.onEnd = function () { syncPlayButton(); };
    setBusy(false);
    setControls(true);
    renderSpeed();
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
    [el.play, el.replay, el.scrub, el.saveVideo, el.saveImage].forEach(function (b) { b.disabled = !on; });
  }

  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  function updateProgress(p) {
    var f = p.time / p.plan.duration;
    if (!scrubbing) setScrub(f);
    el.clock.textContent = clock(p.time) + ' / ' + clock(p.plan.duration);
    var stage = p.stageName();
    if (el.stage.textContent !== stage) el.stage.textContent = stage;
  }

  function setScrub(f) {
    el.scrub.value = Math.round(f * 1000);
    el.scrub.style.setProperty('--fill', (f * 100).toFixed(2) + '%');
  }

  function renderSpeed() {
    el.speedChips.textContent = '';
    SPEEDS.forEach(function (v) {
      var b = chip('speed', String(v), v + '\u00d7', '', v === speed);
      b.disabled = !player;
      el.speedChips.appendChild(b);
    });
  }

  function setSpeed(v) {
    speed = v;
    if (player) player.speed = v;
    renderSpeed();
  }

  // Seeks are applied at most once per frame, so dragging stays smooth.
  function applyScrub() {
    var t = scrubTarget;
    scrubTarget = null;
    if (t == null || !player) return;
    player.seek(t * player.plan.duration);
  }

  function onScrubInput() {
    if (!player) return;
    var f = el.scrub.value / 1000;
    el.scrub.style.setProperty('--fill', (f * 100).toFixed(2) + '%');
    var pending = scrubTarget != null;
    scrubTarget = f;
    if (!pending) requestAnimationFrame(applyScrub);
  }

  function scrubStart() {
    if (!player || scrubbing) return;
    scrubbing = true;
    wasPlaying = player.playing;
    player.pause();
    syncPlayButton();
  }

  function scrubEnd() {
    if (!scrubbing) return;
    scrubbing = false;
    applyScrub();
    if (player && wasPlaying && !player.ended) player.play();
    wasPlaying = false;
    syncPlayButton();
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

  /* ---------- video render queue ---------- */

  // Each video is rendered by its own off-screen player from a snapshot of the
  // plan, so it never touches the visible player: keep watching, scrub, change
  // speed or even load another photo meanwhile. Rendering is real time (the
  // video is recorded as it plays), at the playback speed chosen when it was
  // queued, and jobs run one after another.
  var HOLD_MS = 1500;
  var queue = [], running = null, jobId = 0;

  function jobLabel(j) {
    return j.name + ' · ' + j.medium + (j.speed !== 1 ? ' · ' + j.speed + '×' : '') + ' · ' + clock(j.videoSec);
  }

  function renderQueue() {
    el.queue.hidden = !queue.length;
    el.queueList.textContent = '';
    queue.forEach(function (j) {
      var li = document.createElement('li'), top = document.createElement('div'), name = document.createElement('span');
      var state = document.createElement('span'), x = document.createElement('button'), bar = document.createElement('div'), fill = document.createElement('div');
      li.className = 'job';
      top.className = 'job-top';
      name.className = 'job-name'; name.textContent = jobLabel(j);
      state.className = 'job-state num';
      x.type = 'button'; x.className = 'btn ghost job-x';
      x.textContent = j.state === 'queued' || j.state === 'rendering' ? 'Cancel' : 'Dismiss';
      x.addEventListener('click', function () { removeJob(j); });
      bar.className = 'bar'; fill.className = 'bar-fill';
      bar.appendChild(fill);
      top.appendChild(name); top.appendChild(state); top.appendChild(x);
      li.appendChild(top);
      if (j.state === 'rendering' || j.state === 'queued') li.appendChild(bar);
      j.els = { state: state, fill: fill };
      el.queueList.appendChild(li);
      updateJob(j);
    });
  }

  function updateJob(j) {
    if (!j.els) return;
    var text = { queued: 'Waiting', rendering: Math.round(j.frac * 100) + '%', done: 'Saved', failed: j.error || 'Failed' }[j.state];
    j.els.state.textContent = text;
    j.els.state.classList.toggle('bad', j.state === 'failed');
    j.els.fill.style.width = Math.round(j.frac * 100) + '%';
  }

  function removeJob(j) {
    if (j.cancel) j.cancel();
    queue.splice(queue.indexOf(j), 1);
    j.state = 'cancelled';
    renderQueue();
    if (running === j) { running = null; runNext(); }
  }

  function runNext() {
    if (running) return;
    var j = queue.filter(function (q) { return q.state === 'queued'; })[0];
    if (!j) return;
    running = j;
    j.state = 'rendering';
    renderQueue();
    renderJob(j, function (error) {
      if (running !== j) return; // cancelled meanwhile
      running = null;
      j.state = error ? 'failed' : 'done';
      j.error = error;
      j.frac = error ? 0 : 1;
      j.cancel = null;
      renderQueue();
      runNext();
    });
  }

  function renderJob(j, finish) {
    var plan = j.plan, fmt = j.fmt, chunks = [], c, p, stream, rec, timer = 0, stopped = false;
    try {
      c = document.createElement('canvas');
      c.width = plan.width; c.height = plan.height;
      p = new PhotoDraw.Player(c, plan);
      stream = c.captureStream(30);
      rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: 8000000 });
    } catch (e) {
      finish('Could not start');
      return;
    }
    function end() {
      clearInterval(timer);
      stream.getTracks().forEach(function (t) { t.stop(); });
    }
    j.cancel = function () {
      stopped = true;
      end();
      if (rec.state !== 'inactive') rec.stop();
    };
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = function () { if (!stopped) { stopped = true; end(); finish('Recording failed'); } };
    rec.onstop = function () {
      if (stopped) return;
      stopped = true;
      if (!chunks.length) { finish('Came back empty'); return; }
      download(new Blob(chunks, { type: fmt.mime.split(';')[0] }), j.file + '.' + fmt.ext);
      finish(null);
    };

    var t0 = performance.now(), doneAt = 0;
    p.reset();
    rec.start(250);
    timer = setInterval(function () {
      var now = performance.now();
      p.advanceTo((now - t0) / 1000 * j.speed);
      j.frac = Math.min(1, (now - t0) / 1000 / j.videoSec);
      updateJob(j);
      if (p.ended) {
        // Hold the finished painting for a moment before the video ends.
        if (!doneAt) doneAt = now;
        if (now - doneAt >= HOLD_MS) { clearInterval(timer); if (rec.state !== 'inactive') rec.stop(); }
      }
    }, 1000 / 30);
  }

  function saveVideo() {
    if (!player) return;
    var fmt = videoFormat();
    if (!fmt) { el.note.textContent = 'This browser cannot record video from a canvas. Try a current Chrome, Edge, Firefox or Safari.'; return; }
    var plan = player.plan, medium = PhotoDraw.STYLES[opts.style].name, name = baseName.replace(/-painting$/, '');
    queue.push({
      id: ++jobId, plan: plan, fmt: fmt, speed: speed, medium: medium, name: name,
      file: baseName + '-' + opts.style + (speed !== 1 ? '-' + speed + 'x' : ''),
      videoSec: plan.duration / speed + HOLD_MS / 1000,
      state: 'queued', frac: 0, error: null, cancel: null, els: null
    });
    el.note.textContent = queue.length > 1 ? 'Added to the render queue.' : '';
    renderQueue();
    runNext();
  }

  window.addEventListener('beforeunload', function (e) {
    if (queue.some(function (j) { return j.state === 'queued' || j.state === 'rendering'; })) { e.preventDefault(); e.returnValue = ''; }
  });

  function saveImage() {
    if (!player) return;
    player.finish();
    syncPlayButton();
    el.canvas.toBlob(function (blob) {
      if (blob) download(blob, baseName + '-' + opts.style + '.png');
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
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  document.addEventListener('paste', function (e) {
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
    job++;
    stopPlayer();
    el.studio.hidden = true;
    el.newPhoto.hidden = true;
    el.start.hidden = false;
    work = null; complexity = null;
    dock();
    renderOptions();
  });

  el.play.addEventListener('click', function () {
    if (!player) return;
    if (player.playing) player.pause(); else player.play();
    syncPlayButton();
  });

  el.replay.addEventListener('click', function () {
    if (!player) return;
    player.pause();
    player.reset();
    player.play();
    syncPlayButton();
  });

  el.options.addEventListener('click', onChoose);
  el.speedChips.addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (b && !b.disabled) setSpeed(parseFloat(b.dataset.value));
  });
  el.scrub.addEventListener('pointerdown', scrubStart);
  el.scrub.addEventListener('input', onScrubInput);
  el.scrub.addEventListener('change', scrubEnd);
  window.addEventListener('pointerup', scrubEnd);
  window.addEventListener('pointercancel', scrubEnd);
  el.saveVideo.addEventListener('click', saveVideo);
  el.saveImage.addEventListener('click', saveImage);

  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && player && !/^(BUTTON|INPUT|A)$/.test(e.target.tagName)) {
      e.preventDefault();
      el.play.click();
    }
  });
  dock();
  renderOptions();
  renderSpeed();
})();
