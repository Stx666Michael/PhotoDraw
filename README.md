# PhotoDraw

A web app that turns any photo into a short animation of it being painted in oils, stroke by stroke.

## Use it

Open `index.html` in a browser. There is no build step, server or dependency.

1. Drop, choose or paste a photo (or try the built-in sample).
2. Watch it get painted: block-in with a wide brush first, then smaller and smaller brushes.
3. **Save video** records the animation (MP4 or WebM, depending on the browser); **Save painting** downloads the finished picture as a PNG.

Photos never leave the device; everything runs in the browser.

## How it works

- **Complexity** – the photo is scored from 0 to 100 using edge density, gradient energy and colour variety, measured at a fixed small size so resolution does not matter. The animation runs from 8 seconds (flat, simple photos) to 42 seconds (very busy ones).
- **Planning** – five layers of brushes, coarse to fine. Each layer compares the canvas so far with the photo and only paints where they still differ, so simple areas keep their broad strokes and detailed areas get many small ones. Strokes follow the edges in the photo rather than crossing them.
- **Brush** – every stroke is a bundle of bristle lines with slightly varied colour, ragged ends and a light side, over a canvas weave.

## Files

- `index.html`, `style.css` – the page
- `js/painter.js` – complexity analysis, stroke planning, brush rendering, playback
- `js/app.js` – photo loading, controls, video and image export
