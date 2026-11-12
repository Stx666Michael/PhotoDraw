# PhotoDraw

A web app that turns any photo into a short animation of it being painted or drawn, stroke by stroke.

## Use it

Open `index.html` in a browser. There is no build step, server or dependency.

1. Drop, choose or paste a photo (or try the built-in sample).
2. Pick a **medium**: oil paint, watercolor, colored pencil, graphite, charcoal or pen & ink.
3. Pick a **length**: Short, Standard, Long or Epic. Longer animations use more, smaller strokes, so they show finer detail. Changing either re-paints the same photo.
4. Watch it get painted: broad strokes first, then smaller and smaller ones. Drag the progress bar to preview any moment, and use the speed buttons (0.5×, 1×, 2×, 4×) to slow down or skip ahead.
5. **Save video** records the animation (MP4 or WebM, depending on the browser); **Save painting** downloads the finished picture as a PNG.

Video is always recorded at 1× speed. Photos never leave the device; everything runs in the browser.

## How it works

- **Complexity** – the photo is scored from 0 to 100 using edge density, gradient energy and colour variety, measured at a fixed small size so resolution does not matter. At Standard length the animation runs from 8 seconds (flat, simple photos) to 42 seconds (very busy ones); Short is half of that, Long double and Epic 3.5 times.
- **Planning** – five layers of brushes (up to seven for Long and Epic), coarse to fine. Each layer compares the canvas so far with the photo and only paints where they still differ, so simple areas keep their broad strokes and detailed areas get many small ones. Strokes follow the edges in the photo rather than crossing them.
- **Media** – each medium is a stroke renderer plus a paper texture: oil is opaque bristle lines on a canvas weave; watercolor is overlapping translucent washes with darker pooled edges; the pencils, charcoal and ink are bundles of thin hatching lines whose density builds up tone (graphite, charcoal and ink are monochrome).

## Files

- `index.html`, `style.css` – the page
- `js/painter.js` – complexity analysis, stroke planning, brush rendering, playback
- `js/app.js` – photo loading, controls, video and image export
