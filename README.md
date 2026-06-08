# Scrollery

A clean, single-page reader for **PDF** and **EPUB** files with smooth
autoscroll — inspired by the calm aesthetic of Apple Books. Everything runs in
the browser; there is no backend.

## Features

- **Drag-and-drop or click** to open a `.pdf` or `.epub` file. The upload zone
  disappears and the reader takes over once a file is loaded.
- **PDF** pages are rendered with [pdf.js](https://mozilla.github.io/pdf.js/) as
  high-DPI canvases stacked vertically, so autoscroll flows through the whole
  document continuously.
- **EPUB** chapters are parsed with [epub.js](https://github.com/futurepress/epub.js/)
  and flowed into one scrollable HTML column.
- **Autoscroll** with a floating pill control bar:
  - Play / Pause (also toggled with the **Space** bar).
  - Smooth, continuous motion driven by `requestAnimationFrame` with a
    sub-pixel accumulator — not jumpy `scrollBy`.
  - Speed slider from **0.2 px/frame** (barely moving) to **3 px/frame**
    (normal reading pace). Speed changes apply live, without stopping.
  - Stops automatically when you scroll manually (wheel / touch / arrow keys)
    or when you reach the end.
- **Font controls** (apply instantly to EPUB text):
  - Family: Georgia, Merriweather, Lato, Palatino, Courier New.
  - Size: 12 px – 32 px.
- **Page color** picker — Paper, White, Sepia, Gray and Night themes, applied
  live to the whole reading surface.
- **Progress indicator** in the control bar — percentage for EPUB, plus
  `Page x / y` for PDF.
- **Remembered Library** — every book you open is saved locally (IndexedDB),
  along with how far you've read. Reopen the app and your shelf is waiting;
  click any book to jump straight back to where you left off. Font, size,
  speed and color preferences persist too (localStorage).

## Running it

The app is a single React component, [`App.jsx`](./App.jsx), hosted by
[`index.html`](./index.html), which pulls React, pdf.js, epub.js and Babel from
a CDN. Because the browser fetches `App.jsx`, it needs to be served over HTTP
(opening `index.html` via `file://` will not work).

From this folder, run any static server, for example:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed URL (e.g. <http://localhost:8000>) and drop in a book.

## Files

| File         | Purpose                                                        |
| ------------ | ------------------------------------------------------------- |
| `App.jsx`    | The entire app — one React component using hooks.             |
| `index.html` | Minimal host that loads the CDN libraries and mounts the app. |
