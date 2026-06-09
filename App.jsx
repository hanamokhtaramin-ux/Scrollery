/*
 * Scrollery — a single-file PDF & EPUB autoscroll reader.
 *
 * Hosted by index.html, which loads React, pdf.js, epub.js (+ JSZip) and Babel
 * from a CDN, so those libraries are available here as globals
 * (window.pdfjsLib, window.ePub) rather than via `import`.
 *
 * Everything runs in the browser:
 *   - PDF / EPUB rendering with autoscroll
 *   - a remembered Library (book files + reading progress) via IndexedDB
 *   - selectable page colors / themes, with preferences saved in localStorage
 */

const { useState, useEffect, useRef, useCallback } = React;

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const FONT_OPTIONS = [
  { label: "Georgia", value: 'Georgia, "Times New Roman", serif' },
  { label: "Merriweather", value: '"Merriweather", Georgia, serif' },
  { label: "Lato", value: '"Lato", "Helvetica Neue", Arial, sans-serif' },
  { label: "Palatino", value: '"Palatino Linotype", "Book Antiqua", Palatino, serif' },
  { label: "Courier New", value: '"Courier New", Courier, monospace' },
];

// Selectable page colors, Apple Books style.
const THEMES = [
  { id: "paper", label: "Paper", bg: "#f7f4ee", text: "#2b2722", muted: "#8a8276", swatch: "#f7f4ee", dark: false },
  { id: "white", label: "White", bg: "#ffffff", text: "#23211d", muted: "#8a8276", swatch: "#ffffff", dark: false },
  { id: "sepia", label: "Sepia", bg: "#f4ecd8", text: "#4a3f2c", muted: "#9c8c66", swatch: "#f1e2c0", dark: false },
  { id: "gray", label: "Gray", bg: "#e8e6e1", text: "#2b2722", muted: "#857f74", swatch: "#d9d6cf", dark: false },
  { id: "night", label: "Night", bg: "#1f1d1b", text: "#d8d2c7", muted: "#9b948a", swatch: "#1f1d1b", dark: true },
];

const ACCENT = "#b08a52";
const SPEED_MIN = 0.2; // px / frame — barely moving
const SPEED_MAX = 3.0; // px / frame — brisk reading pace
const PAGE_WIDTH = 820; // max content width, like a book column

// Vendored locally (see ./vendor) so nothing is fetched from a CDN at runtime.
const PDF_WORKER = "vendor/pdf.worker.min.js";

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
}

/* ------------------------------------------------------------------ *
 * Preferences (localStorage)
 * ------------------------------------------------------------------ */

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem("scrollery." + key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem("scrollery." + key, JSON.stringify(value));
  } catch (e) {
    /* ignore quota / private mode */
  }
}

/* ------------------------------------------------------------------ *
 * Library storage (IndexedDB) — keeps book files + reading progress
 * ------------------------------------------------------------------ */

const DB_NAME = "scrollery";
const STORE = "books";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(book) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(book);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Update just the progress on an existing record without rewriting the file.
async function idbSaveProgress(id, progress) {
  const rec = await idbGet(id);
  if (!rec) return;
  rec.progress = progress;
  rec.lastOpened = Date.now();
  await idbPut(rec);
}

// Merge a partial patch (e.g. bookmarks / highlights) into a stored book.
async function idbPatch(id, patch) {
  const rec = await idbGet(id);
  if (!rec) return;
  Object.assign(rec, patch);
  await idbPut(rec);
}

// Strip the heavy `data` buffer before putting records into React state.
const toMeta = (rec) => ({
  id: rec.id,
  name: rec.name,
  type: rec.type,
  size: rec.size,
  addedAt: rec.addedAt,
  lastOpened: rec.lastOpened,
  progress: rec.progress || 0,
});

/* ------------------------------------------------------------------ *
 * EPUB extraction — flow every chapter into one HTML string
 * ------------------------------------------------------------------ */

function sanitizeHtml(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<link[^>]*>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "");
}

function bodyHtmlFromXml(raw) {
  if (!raw) return "";
  let doc;
  try {
    doc = new DOMParser().parseFromString(raw, "application/xhtml+xml");
    if (doc.querySelector("parsererror")) throw new Error("xhtml");
  } catch (_) {
    doc = new DOMParser().parseFromString(raw, "text/html");
  }
  const body = doc.querySelector("body");
  return body ? body.innerHTML : "";
}

const fileBase = (href) => (href || "").split("#")[0].split("/").pop();

function firstHeadingText(html) {
  const m = html.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
  if (!m) return "";
  return m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function extractEpub(book, onProgress) {
  // Only wait for the package + spine. book.ready also waits on navigation and
  // cover parsing, which REJECT on plenty of otherwise-readable EPUBs — that
  // rejection was surfacing as "cannot read it".
  await book.opened;
  try { await book.loaded.spine; } catch (e) { /* keep going with the spine we have */ }

  // Best-effort: read the EPUB's own navigation for nice chapter titles.
  const navByFile = {};
  try {
    await book.loaded.navigation;
    const flat = [];
    const walk = (arr) => (arr || []).forEach((it) => { flat.push(it); if (it.subitems) walk(it.subitems); });
    walk(book.navigation && book.navigation.toc);
    flat.forEach((it) => {
      const b = fileBase(it.href);
      const label = (it.label || "").trim();
      if (b && label && !navByFile[b]) navByFile[b] = label;
    });
  } catch (e) { /* navless EPUB — we fall back to headings */ }

  let items = [];
  try { items = (book.spine && book.spine.spineItems) || []; } catch (e) { items = []; }
  if (!items.length) throw new Error("no readable chapters in spine");

  let html = "";
  const toc = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (onProgress) onProgress(i + 1, items.length);
    let content = "";

    // Archive-first: read the raw XHTML straight from the zip. This is the most
    // reliable path and avoids epub.js's rendering hooks entirely.
    if (book.archive && book.archive.getText) {
      const candidates = [item.url, item.canonical, item.href].filter(Boolean);
      for (let c = 0; c < candidates.length && !content; c++) {
        try {
          const raw = await book.archive.getText(candidates[c]);
          content = bodyHtmlFromXml(raw);
        } catch (e) { /* try the next candidate path */ }
      }
    }

    // Fallback: let epub.js load & parse the section itself.
    if (!content) {
      try {
        const node = await item.load(book.load.bind(book));
        let el = node;
        if (el && el.nodeType === 9) el = el.body || el;            // a Document
        else if (el && el.querySelector) el = el.querySelector("body") || el; // an <html> element
        content = el && el.innerHTML ? el.innerHTML : "";
        if (item.unload) item.unload();
      } catch (e) { content = ""; }
    }

    content = sanitizeHtml(content);
    if (content.trim()) {
      const id = `epub-sec-${toc.length}`;
      const label =
        navByFile[fileBase(item.href)] ||
        firstHeadingText(content) ||
        `Chapter ${toc.length + 1}`;
      toc.push({ id, label, level: 0, page: null });
      html += `<section class="epub-section" id="${id}">${content}</section>`;
    }
  }

  if (!html) throw new Error("chapters were empty after parsing");
  return { html, toc };
}

// Read a PDF's outline/bookmarks into a flat, indented table of contents.
async function buildPdfToc(pdf) {
  let outline = null;
  try { outline = await pdf.getOutline(); } catch (e) { outline = null; }
  if (!outline || !outline.length) return [];

  const toc = [];
  const visit = async (items, level) => {
    for (const it of items) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === "string") dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          page = (await pdf.getPageIndex(dest[0])) + 1;
        }
      } catch (e) { /* unresolved destination — skip the link */ }
      if (page) toc.push({ id: `pdf-page-${page}`, label: (it.title || "").trim() || `Page ${page}`, level, page });
      if (it.items && it.items.length) await visit(it.items, level + 1);
    }
  };
  await visit(outline, 0);
  return toc;
}

/* ------------------------------------------------------------------ *
 * Highlight anchoring — store selections as character offsets within a
 * chapter section, then re-wrap them in <mark> on load. Offsets are stable
 * because wrapping never changes a section's textContent.
 * ------------------------------------------------------------------ */

const HL_COLORS = [
  { id: "yellow", value: "#ffe27a" },
  { id: "green", value: "#bce6a6" },
  { id: "pink", value: "#f7b8d2" },
  { id: "blue", value: "#aed6f5" },
];

// Character offset of a (container, offset) point within `root`'s text.
function pointOffset(root, container, offset) {
  const r = document.createRange();
  r.selectNodeContents(root);
  try { r.setEnd(container, offset); } catch (e) { return 0; }
  return r.toString().length;
}

function textNodesOf(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  return nodes;
}

// Wrap the [start, end) character range of a section in <mark> elements.
function wrapRange(section, start, end, id, color) {
  if (!section || end <= start) return;
  let pos = 0;
  for (const node of textNodesOf(section)) {
    const len = node.nodeValue.length;
    const ns = pos, ne = pos + len;
    pos = ne;
    const s = Math.max(start, ns), e = Math.min(end, ne);
    if (s < e) {
      const localStart = s - ns, localEnd = e - ns;
      let target = node;
      if (localEnd < len) target.splitText(localEnd);
      if (localStart > 0) target = target.splitText(localStart);
      const mark = document.createElement("mark");
      mark.className = "hl";
      mark.dataset.hlId = id;
      mark.style.background = color;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
    }
  }
}

function unwrapHighlight(mark) {
  const p = mark.parentNode;
  if (!p) return;
  while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
  p.removeChild(mark);
  p.normalize();
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

function App() {
  // View
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState(null); // 'pdf' | 'epub'
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  // Content
  const [epubHtml, setEpubHtml] = useState("");
  const [toc, setToc] = useState([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [fileName, setFileName] = useState("");

  // Bookmarks, highlights, selection popover, transient toast
  const [bookmarks, setBookmarks] = useState([]);
  const [highlights, setHighlights] = useState([]);
  const [popover, setPopover] = useState({ visible: false });
  const [flash, setFlash] = useState("");

  // Library
  const [library, setLibrary] = useState([]);

  // Controls (persisted preferences)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(() => loadPref("speed", 1.0));
  const [fontFamily, setFontFamily] = useState(() => loadPref("font", FONT_OPTIONS[0].value));
  const [fontSize, setFontSize] = useState(() => loadPref("size", 19));
  const [themeId, setThemeId] = useState(() => loadPref("theme", "paper"));
  const theme = THEMES.find((t) => t.id === themeId) || THEMES[0];

  // Progress
  const [progress, setProgress] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  // Refs read inside the rAF loop / async work
  const scrollRef = useRef(null);
  const pdfContainerRef = useRef(null);
  const speedRef = useRef(speed);
  const playingRef = useRef(false);
  const rafRef = useRef(null);
  const accRef = useRef(0);
  const progressRef = useRef(-1);
  const ratioRef = useRef(0);
  const modeRef = useRef(null);
  const totalPagesRef = useRef(0);
  const pendingRef = useRef(null);
  const currentBookIdRef = useRef(null);
  const restoreRatioRef = useRef(0);
  const saveTimerRef = useRef(null);
  const epubRef = useRef(null);
  const highlightsRef = useRef([]);
  const pendingSelRef = useRef(null);

  useEffect(() => { highlightsRef.current = highlights; }, [highlights]);

  // Persist preferences
  useEffect(() => { speedRef.current = speed; savePref("speed", speed); }, [speed]);
  useEffect(() => { savePref("font", fontFamily); }, [fontFamily]);
  useEffect(() => { savePref("size", fontSize); }, [fontSize]);
  useEffect(() => { savePref("theme", themeId); }, [themeId]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { totalPagesRef.current = totalPages; }, [totalPages]);

  // Load the library on first mount.
  const refreshLibrary = useCallback(async () => {
    try {
      const all = await idbAll();
      all.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
      setLibrary(all.map(toMeta));
    } catch (e) {
      /* IndexedDB unavailable — library just stays empty */
    }
  }, []);
  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  /* ---------------------------------------------------------------- *
   * Progress + saving
   * ---------------------------------------------------------------- */

  const persistProgress = useCallback((ratio) => {
    const id = currentBookIdRef.current;
    if (!id) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      idbSaveProgress(id, ratio).catch(() => {});
    }, 500);
  }, []);

  const updateProgress = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? el.scrollTop / max : 0;
    ratioRef.current = ratio;
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    if (pct !== progressRef.current) {
      progressRef.current = pct;
      setProgress(pct);
      persistProgress(ratio);
      if (modeRef.current === "pdf" && totalPagesRef.current) {
        setCurrentPage(
          Math.min(totalPagesRef.current, Math.floor(ratio * totalPagesRef.current) + 1)
        );
      }
    }
  }, [persistProgress]);

  /* ---------------------------------------------------------------- *
   * Autoscroll loop
   * ---------------------------------------------------------------- */

  const pause = useCallback(() => {
    const wasPlaying = playingRef.current;
    playingRef.current = false;
    setPlaying(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (wasPlaying && currentBookIdRef.current) {
      idbSaveProgress(currentBookIdRef.current, ratioRef.current).catch(() => {});
    }
  }, []);

  const step = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !playingRef.current) return;

    accRef.current += speedRef.current;
    if (accRef.current >= 1) {
      const inc = Math.floor(accRef.current);
      accRef.current -= inc;
      el.scrollTop += inc;
    }
    updateProgress();

    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
      pause(); // reached the end
      return;
    }
    rafRef.current = requestAnimationFrame(step);
  }, [pause, updateProgress]);

  const play = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) el.scrollTop = 0;
    accRef.current = 0;
    playingRef.current = true;
    setPlaying(true);
    rafRef.current = requestAnimationFrame(step);
  }, [step]);

  const togglePlay = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  // Manual-scroll detection → pause; keep progress synced when idle.
  useEffect(() => {
    if (!ready) return;
    const el = scrollRef.current;
    if (!el) return;

    const onManual = () => { if (playingRef.current) pause(); };
    const onScrollSync = () => { if (!playingRef.current) updateProgress(); };
    const onKey = (e) => {
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.code)) onManual();
    };

    el.addEventListener("wheel", onManual, { passive: true });
    el.addEventListener("touchmove", onManual, { passive: true });
    el.addEventListener("scroll", onScrollSync, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", onManual);
      el.removeEventListener("touchmove", onManual);
      el.removeEventListener("scroll", onScrollSync);
      window.removeEventListener("keydown", onKey);
    };
  }, [ready, pause, togglePlay, updateProgress]);

  // Flush progress + cancel rAF on unmount / tab close.
  useEffect(() => {
    const flush = () => {
      if (currentBookIdRef.current) {
        idbSaveProgress(currentBookIdRef.current, ratioRef.current).catch(() => {});
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /* ---------------------------------------------------------------- *
   * Restore saved scroll position once content is laid out
   * ---------------------------------------------------------------- */

  const applyRestore = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const r = restoreRatioRef.current;
    if (r && r > 0) {
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.round(r * max);
    }
    restoreRatioRef.current = 0;
    updateProgress();
  }, [updateProgress]);

  // EPUB html is injected by React, so re-apply highlights and restore the
  // saved position after it paints.
  useEffect(() => {
    if (mode === "epub" && epubHtml) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        highlightsRef.current.forEach((h) => {
          wrapRange(document.getElementById(h.sectionId), h.start, h.end, h.id, h.color);
        });
        applyRestore();
      }));
    }
  }, [epubHtml, mode, applyRestore]);

  // Scroll an element (by id) to the top of the reader.
  const scrollToTarget = useCallback((target, offset) => {
    const el = scrollRef.current;
    if (!el || !target) return;
    const c = el.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    el.scrollTop = Math.max(0, el.scrollTop + (t.top - c.top) - (offset || 24));
    updateProgress();
  }, [updateProgress]);

  // Jump to a table-of-contents entry.
  const goTo = useCallback((id) => {
    setTocOpen(false);
    pause();
    scrollToTarget(id && document.getElementById(id), 24);
  }, [pause, scrollToTarget]);

  // Jump to a saved scroll ratio (bookmarks).
  const goToRatio = useCallback((ratio) => {
    setTocOpen(false);
    pause();
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = Math.round(ratio * max);
    updateProgress();
  }, [pause, updateProgress]);

  const goToHighlight = useCallback((hl) => {
    setTocOpen(false);
    pause();
    scrollToTarget(document.querySelector(`mark[data-hl-id="${hl.id}"]`), 60);
  }, [pause, scrollToTarget]);

  /* ---------------------------------------------------------------- *
   * Bookmarks
   * ---------------------------------------------------------------- */

  const addBookmark = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? el.scrollTop / max : 0;
    let label;
    let page = null;
    if (modeRef.current === "pdf" && totalPagesRef.current) {
      page = Math.min(totalPagesRef.current, Math.floor(ratio * totalPagesRef.current) + 1);
      label = `Page ${page}`;
    } else {
      const box = el.getBoundingClientRect();
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + 90);
      const txt = ((at && at.textContent) || "").replace(/\s+/g, " ").trim();
      label = txt ? txt.slice(0, 48) + (txt.length > 48 ? "…" : "") : `${Math.round(ratio * 100)}% read`;
    }
    const bm = { id: "bm-" + Date.now(), ratio, label, page, createdAt: Date.now() };
    setBookmarks((prev) => {
      const next = [...prev, bm].sort((a, b) => a.ratio - b.ratio);
      if (currentBookIdRef.current) idbPatch(currentBookIdRef.current, { bookmarks: next }).catch(() => {});
      return next;
    });
    setFlash("Bookmark added");
    clearTimeout(addBookmark._t);
    addBookmark._t = setTimeout(() => setFlash(""), 1500);
  }, []);

  const removeBookmark = useCallback((id) => {
    setBookmarks((prev) => {
      const next = prev.filter((b) => b.id !== id);
      if (currentBookIdRef.current) idbPatch(currentBookIdRef.current, { bookmarks: next }).catch(() => {});
      return next;
    });
  }, []);

  /* ---------------------------------------------------------------- *
   * Highlights (EPUB text layer)
   * ---------------------------------------------------------------- */

  const addHighlight = useCallback((color) => {
    const sel = pendingSelRef.current;
    setPopover({ visible: false });
    if (!sel) return;
    const id = "hl-" + Date.now();
    const hl = { ...sel, id, color };
    wrapRange(document.getElementById(sel.sectionId), sel.start, sel.end, id, color);
    const s = window.getSelection();
    if (s) s.removeAllRanges();
    pendingSelRef.current = null;
    setHighlights((prev) => {
      const next = [...prev, hl];
      if (currentBookIdRef.current) idbPatch(currentBookIdRef.current, { highlights: next }).catch(() => {});
      return next;
    });
  }, []);

  const removeHighlight = useCallback((id) => {
    setPopover({ visible: false });
    document.querySelectorAll(`mark[data-hl-id="${id}"]`).forEach(unwrapHighlight);
    setHighlights((prev) => {
      const next = prev.filter((h) => h.id !== id);
      if (currentBookIdRef.current) idbPatch(currentBookIdRef.current, { highlights: next }).catch(() => {});
      return next;
    });
  }, []);

  // Selection → highlight popover (EPUB only; PDF canvas has no text layer).
  useEffect(() => {
    if (!ready || mode !== "epub") return;
    const root = epubRef.current;
    if (!root) return;

    const onUp = (e) => {
      const mark = e.target.closest && e.target.closest("mark.hl");
      if (mark) {
        const r = mark.getBoundingClientRect();
        setPopover({ visible: true, mode: "remove", hlId: mark.dataset.hlId, x: r.left + r.width / 2, y: r.top });
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
      const range = sel.getRangeAt(0);
      if (!root.contains(range.startContainer)) return;
      let section = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
      section = section && section.closest(".epub-section");
      if (!section) return;
      const start = pointOffset(section, range.startContainer, range.startOffset);
      const end = section.contains(range.endContainer)
        ? pointOffset(section, range.endContainer, range.endOffset)
        : section.textContent.length;
      if (end <= start) return;
      const rect = range.getBoundingClientRect();
      pendingSelRef.current = { sectionId: section.id, start, end, text: sel.toString() };
      pause();
      setPopover({ visible: true, mode: "create", x: rect.left + rect.width / 2, y: rect.top });
    };
    const onDown = (e) => {
      if (!(e.target.closest && e.target.closest(".hl-popover"))) {
        setPopover((p) => (p.visible ? { visible: false } : p));
      }
    };

    root.addEventListener("mouseup", onUp);
    root.addEventListener("touchend", onUp);
    document.addEventListener("mousedown", onDown);
    return () => {
      root.removeEventListener("mouseup", onUp);
      root.removeEventListener("touchend", onUp);
      document.removeEventListener("mousedown", onDown);
    };
  }, [ready, mode, pause]);

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  const renderPdf = useCallback(async (buffer) => {
    setLoading(true);
    setLoadingMsg("Rendering PDF…");
    setError("");
    try {
      if (!window.pdfjsLib) throw new Error("PDF engine didn't load — check your connection");
      const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
      setTotalPages(pdf.numPages);
      totalPagesRef.current = pdf.numPages;

      const container = pdfContainerRef.current;
      container.innerHTML = "";
      const dpr = window.devicePixelRatio || 1;
      const maxWidth = Math.min(container.clientWidth || PAGE_WIDTH, PAGE_WIDTH);

      for (let n = 1; n <= pdf.numPages; n++) {
        setLoadingMsg(`Rendering page ${n} of ${pdf.numPages}…`);
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = maxWidth / base.width;
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        canvas.className = "pdf-page";
        canvas.id = `pdf-page-${n}`;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = viewport.width + "px";
        canvas.style.height = viewport.height + "px";
        container.appendChild(canvas);

        await page.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
      }
      try { setToc(await buildPdfToc(pdf)); } catch (e) { setToc([]); }
      applyRestore();
    } catch (err) {
      console.error(err);
      setError("Could not render this PDF. It may be corrupted or protected.");
    } finally {
      setLoading(false);
    }
  }, [applyRestore]);

  const renderEpub = useCallback(async (buffer) => {
    setLoading(true);
    setLoadingMsg("Parsing EPUB…");
    setError("");
    try {
      if (!window.ePub) throw new Error("EPUB engine didn't load — check your connection");
      const book = window.ePub(buffer);
      const { html, toc: epubToc } = await extractEpub(book, (i, total) =>
        setLoadingMsg(`Loading chapter ${i} of ${total}…`)
      );
      setToc(epubToc);
      setEpubHtml(html); // restore happens in the epubHtml effect
    } catch (err) {
      console.error("EPUB load failed:", err);
      const detail = err && err.message ? err.message : "unknown error";
      setError(`Could not read this EPUB — ${detail}.`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Render whatever file is pending once the reader has mounted.
  useEffect(() => {
    if (ready && pendingRef.current) {
      const p = pendingRef.current;
      pendingRef.current = null;
      // pdf.js transfers the buffer to its worker, so hand it a private copy.
      if (p.type === "pdf") renderPdf(p.buffer.slice(0));
      else renderEpub(p.buffer);
    }
  }, [ready, renderPdf, renderEpub]);

  /* ---------------------------------------------------------------- *
   * Opening books
   * ---------------------------------------------------------------- */

  const openRecord = useCallback((rec) => {
    setError("");
    setEpubHtml("");
    setToc([]);
    setTocOpen(false);
    setPopover({ visible: false });
    const bm = rec.bookmarks || [];
    const hl = rec.highlights || [];
    setBookmarks(bm);
    setHighlights(hl);
    highlightsRef.current = hl;
    setProgress(0);
    setCurrentPage(0);
    setTotalPages(0);
    progressRef.current = -1;
    currentBookIdRef.current = rec.id;
    restoreRatioRef.current = rec.progress || 0;
    setFileName(rec.name);
    setMode(rec.type);
    modeRef.current = rec.type;
    pendingRef.current = { type: rec.type, buffer: rec.data };
    setReady(true);
  }, []);

  const loadFile = useCallback((file) => {
    if (!file) return;
    const name = file.name.toLowerCase();
    const isPdf = name.endsWith(".pdf");
    const isEpub = name.endsWith(".epub");
    if (!isPdf && !isEpub) {
      setError("Please choose a .pdf or .epub file.");
      return;
    }
    setError("");
    const reader = new FileReader();
    reader.onload = async (e) => {
      const buffer = e.target.result;
      const type = isPdf ? "pdf" : "epub";
      const id = `${file.name}::${file.size}::${file.lastModified}`;

      let rec;
      try {
        const existing = await idbGet(id); // resume if we've seen it before
        rec = existing
          ? { ...existing, data: buffer, lastOpened: Date.now() }
          : {
              id, name: file.name, type, size: file.size,
              lastModified: file.lastModified, addedAt: Date.now(),
              lastOpened: Date.now(), progress: 0, data: buffer,
            };
        await idbPut(rec);
      } catch (err) {
        // IndexedDB unavailable — still let the user read, just don't remember.
        rec = { id: null, name: file.name, type, progress: 0, data: buffer };
      }
      refreshLibrary();
      openRecord(rec);
    };
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsArrayBuffer(file);
  }, [openRecord, refreshLibrary]);

  const openFromLibrary = useCallback(async (id) => {
    try {
      const rec = await idbGet(id);
      if (!rec) { setError("That book is no longer stored."); refreshLibrary(); return; }
      rec.lastOpened = Date.now();
      idbPut(rec).catch(() => {});
      openRecord(rec);
    } catch (e) {
      setError("Could not open that book.");
    }
  }, [openRecord, refreshLibrary]);

  const removeFromLibrary = useCallback(async (id) => {
    await idbDelete(id).catch(() => {});
    refreshLibrary();
  }, [refreshLibrary]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    loadFile(e.dataTransfer.files && e.dataTransfer.files[0]);
  }, [loadFile]);

  const reset = useCallback(() => {
    pause();
    setReady(false);
    setMode(null);
    setEpubHtml("");
    setToc([]);
    setTocOpen(false);
    setPopover({ visible: false });
    setBookmarks([]);
    setHighlights([]);
    highlightsRef.current = [];
    setFileName("");
    setProgress(0);
    setCurrentPage(0);
    setTotalPages(0);
    progressRef.current = -1;
    currentBookIdRef.current = null;
    if (pdfContainerRef.current) pdfContainerRef.current.innerHTML = "";
    refreshLibrary();
  }, [pause, refreshLibrary]);

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  const progressLabel =
    mode === "pdf" && totalPages
      ? `Page ${currentPage || 1} / ${totalPages} · ${progress}%`
      : `${progress}%`;

  return (
    <div style={{ ...S.app, background: theme.bg, color: theme.text }}>
      <GlobalStyle fontFamily={fontFamily} fontSize={fontSize} theme={theme} />

      {!ready ? (
        <UploadZone
          theme={theme}
          dragging={dragging}
          error={error}
          library={library}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onPick={loadFile}
          onOpen={openFromLibrary}
          onRemove={removeFromLibrary}
        />
      ) : (
        <>
          <div ref={scrollRef} style={S.scroll} className="reader-scroll">
            <div style={S.page}>
              {mode === "pdf" && <div ref={pdfContainerRef} style={S.pdfWrap} />}
              {mode === "epub" && (
                <div
                  ref={epubRef}
                  className="epub-content"
                  dangerouslySetInnerHTML={{ __html: epubHtml }}
                />
              )}
              <div style={{ height: "40vh" }} />
            </div>
          </div>

          {loading && (
            <div style={S.loadingWrap}>
              <div style={S.spinner} className="spinner" />
              <div style={S.loadingText}>{loadingMsg}</div>
            </div>
          )}

          {error && !loading && <div style={S.errorToast}>{error}</div>}
          {flash && <div style={{ ...S.flashToast, background: theme.dark ? "rgba(40,38,35,0.92)" : "rgba(40,38,35,0.92)" }}>{flash}</div>}

          {popover.visible && (
            <HighlightPopover popover={popover} onPick={addHighlight} onRemove={removeHighlight} />
          )}

          {tocOpen && (toc.length > 0 || bookmarks.length > 0 || highlights.length > 0) && (
            <TocDrawer
              theme={theme}
              toc={toc}
              bookmarks={bookmarks}
              highlights={highlights}
              onGo={goTo}
              onGoRatio={goToRatio}
              onGoHighlight={goToHighlight}
              onRemoveBookmark={removeBookmark}
              onRemoveHighlight={removeHighlight}
              onClose={() => setTocOpen(false)}
            />
          )}

          <ControlBar
            theme={theme}
            playing={playing}
            onToggle={togglePlay}
            hasDrawer={toc.length > 0 || bookmarks.length > 0 || highlights.length > 0}
            onToc={() => setTocOpen((v) => !v)}
            onAddBookmark={addBookmark}
            speed={speed}
            onSpeed={setSpeed}
            fontFamily={fontFamily}
            onFontFamily={setFontFamily}
            fontSize={fontSize}
            onFontSize={setFontSize}
            themeId={themeId}
            onTheme={setThemeId}
            progressLabel={progressLabel}
            onReset={reset}
          />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Upload zone + Library
 * ------------------------------------------------------------------ */

function UploadZone({
  theme, dragging, error, library,
  onDragOver, onDragLeave, onDrop, onPick, onOpen, onRemove,
}) {
  const inputRef = useRef(null);
  return (
    <div style={S.uploadOuter}>
      <div style={S.brand}>
        <div style={S.brandMark}>❧</div>
        <div>
          <div style={{ ...S.brandTitle, color: theme.text }}>Scrollery</div>
          <div style={{ ...S.brandSub, color: theme.muted }}>
            A calm reader with autoscroll, for PDF &amp; EPUB
          </div>
        </div>
      </div>

      <div
        className="dropzone"
        style={{
          ...S.dropzone,
          background: theme.dark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.6)",
          borderColor: dragging ? ACCENT : theme.dark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.16)",
          ...(dragging ? S.dropzoneActive : null),
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => inputRef.current && inputRef.current.click()}
      >
        <div style={S.dropIcon}>⤓</div>
        <div style={{ ...S.dropTitle, color: theme.text }}>
          {dragging ? "Drop to open" : "Drag a book here"}
        </div>
        <div style={{ ...S.dropSub, color: theme.muted }}>
          or <span style={S.dropLink}>click to browse</span> · .pdf and .epub
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.epub,application/pdf,application/epub+zip"
          style={{ display: "none" }}
          onChange={(e) => onPick(e.target.files && e.target.files[0])}
        />
      </div>

      {error && <div style={S.uploadError}>{error}</div>}

      {library && library.length > 0 && (
        <div style={S.libraryWrap}>
          <div style={{ ...S.libraryHead, color: theme.muted }}>Your Library</div>
          <div style={S.libraryGrid}>
            {library.map((b) => (
              <LibraryCard key={b.id} book={b} theme={theme} onOpen={onOpen} onRemove={onRemove} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LibraryCard({ book, theme, onOpen, onRemove }) {
  const pct = Math.round((book.progress || 0) * 100);
  return (
    <div
      className="lib-card"
      style={{
        ...S.libCard,
        background: theme.dark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.7)",
      }}
      onClick={() => onOpen(book.id)}
      title={`Open "${book.name}"`}
    >
      <button
        className="lib-del"
        style={S.libDel}
        title="Remove from library"
        onClick={(e) => { e.stopPropagation(); onRemove(book.id); }}
      >
        ✕
      </button>
      <div style={{ ...S.libBadge, color: ACCENT }}>{book.type.toUpperCase()}</div>
      <div style={{ ...S.libName, color: theme.text }}>{book.name}</div>
      <div style={S.libBarTrack}>
        <div style={{ ...S.libBarFill, width: pct + "%" }} />
      </div>
      <div style={{ ...S.libMeta, color: theme.muted }}>
        {pct > 0 ? `${pct}% read` : "Not started"}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Table of contents drawer
 * ------------------------------------------------------------------ */

function TocDrawer({
  theme, toc, bookmarks, highlights,
  onGo, onGoRatio, onGoHighlight, onRemoveBookmark, onRemoveHighlight, onClose,
}) {
  const groupHead = { ...S.tocGroup, color: theme.muted };
  return (
    <div style={S.tocOverlay} onClick={onClose}>
      <div
        className="toc-panel"
        style={{
          ...S.tocPanel,
          background: theme.dark ? "rgba(28,26,24,0.97)" : "rgba(255,255,255,0.97)",
          color: theme.text,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ ...S.tocHead, borderColor: theme.dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)" }}>
          <span style={{ ...S.tocTitle, color: theme.muted }}>Contents</span>
          <button style={{ ...S.tocClose, color: theme.muted }} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={S.tocList} className="toc-list">
          {toc.length > 0 && <div style={groupHead}>Chapters</div>}
          {toc.map((t, i) => (
            <button
              key={"t" + i}
              className="toc-item"
              style={{ ...S.tocItem, color: theme.text, paddingLeft: 18 + t.level * 16 }}
              onClick={() => onGo(t.id)}
              title={t.label}
            >
              <span style={S.tocLabel}>{t.label}</span>
              {t.page ? <span style={{ ...S.tocPage, color: theme.muted }}>{t.page}</span> : null}
            </button>
          ))}

          {bookmarks.length > 0 && <div style={groupHead}>Bookmarks</div>}
          {bookmarks.map((b) => (
            <div key={b.id} className="toc-row" style={S.tocRow}>
              <button
                className="toc-item"
                style={{ ...S.tocItem, color: theme.text, flex: 1 }}
                onClick={() => onGoRatio(b.ratio)}
                title={b.label}
              >
                <span style={{ ...S.bmDot, background: ACCENT }} />
                <span style={S.tocLabel}>{b.label}</span>
                <span style={{ ...S.tocPage, color: theme.muted }}>{b.page ? b.page : Math.round(b.ratio * 100) + "%"}</span>
              </button>
              <button className="row-del" style={{ ...S.rowDel, color: theme.muted }} title="Remove bookmark" onClick={() => onRemoveBookmark(b.id)}>✕</button>
            </div>
          ))}

          {highlights.length > 0 && <div style={groupHead}>Highlights</div>}
          {highlights.map((h) => (
            <div key={h.id} className="toc-row" style={S.tocRow}>
              <button
                className="toc-item"
                style={{ ...S.tocItem, color: theme.text, flex: 1 }}
                onClick={() => onGoHighlight(h)}
                title={h.text}
              >
                <span style={{ ...S.bmDot, background: h.color }} />
                <span style={S.tocLabel}>{(h.text || "").trim()}</span>
              </button>
              <button className="row-del" style={{ ...S.rowDel, color: theme.muted }} title="Remove highlight" onClick={() => onRemoveHighlight(h.id)}>✕</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Highlight selection popover
 * ------------------------------------------------------------------ */

function HighlightPopover({ popover, onPick, onRemove }) {
  const left = Math.min(Math.max(popover.x || 0, 80), window.innerWidth - 80);
  const top = Math.max((popover.y || 0) - 12, 44);
  return (
    <div className="hl-popover" style={{ ...S.hlPop, left, top }} onMouseDown={(e) => e.stopPropagation()}>
      {popover.mode === "remove" ? (
        <button style={S.hlRemove} className="hl-remove" onClick={() => onRemove(popover.hlId)}>
          Remove
        </button>
      ) : (
        HL_COLORS.map((c) => (
          <button
            key={c.id}
            className="hl-swatch"
            style={{ ...S.hlSwatch, background: c.value }}
            title={`Highlight (${c.id})`}
            onClick={() => onPick(c.value)}
          />
        ))
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Control bar
 * ------------------------------------------------------------------ */

function ControlBar({
  theme, playing, onToggle, hasDrawer, onToc, onAddBookmark, speed, onSpeed, fontFamily, onFontFamily,
  fontSize, onFontSize, themeId, onTheme, progressLabel, onReset,
}) {
  const dark = theme.dark;
  const txt = dark ? "#e8e3d9" : "#2b2722";
  const muted = dark ? "#a59d92" : "#9a9286";
  const barBg = dark ? "rgba(40,38,35,0.72)" : "rgba(255,255,255,0.72)";
  const fieldBg = dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.04)";
  const line = dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)";

  return (
    <div style={S.barWrap}>
      <div style={{ ...S.bar, background: barBg }} className="control-bar">
        {hasDrawer && (
          <button
            style={{ ...S.resetBtn, background: fieldBg, color: muted, fontSize: 16 }}
            onClick={onToc}
            className="icon-btn"
            title="Contents, bookmarks & highlights"
            aria-label="Table of contents"
          >
            ☰
          </button>
        )}
        <button
          style={{ ...S.playBtn, ...(playing ? S.playBtnOn : null) }}
          onClick={onToggle}
          className="play-btn"
          title={playing ? "Pause (Space)" : "Play (Space)"}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "►"}
        </button>

        <Control label="Speed" color={muted}>
          <input
            type="range" min={SPEED_MIN} max={SPEED_MAX} step={0.1} value={speed}
            onChange={(e) => onSpeed(parseFloat(e.target.value))}
            style={{ ...S.range, width: 100 }} className="slider"
          />
          <span style={{ ...S.valueTag, color: muted }}>{speed.toFixed(1)}×</span>
        </Control>

        <div style={{ ...S.divider, background: line }} />

        <Control label="Font" color={muted}>
          <select
            value={fontFamily} onChange={(e) => onFontFamily(e.target.value)}
            style={{ ...S.select, background: fieldBg, color: txt }} className="select"
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.label} value={f.value}>{f.label}</option>
            ))}
          </select>
        </Control>

        <div style={{ ...S.divider, background: line }} />

        <Control label="Size" color={muted}>
          <input
            type="range" min={12} max={32} step={1} value={fontSize}
            onChange={(e) => onFontSize(parseInt(e.target.value, 10))}
            style={{ ...S.range, width: 84 }} className="slider"
          />
          <span style={{ ...S.valueTag, color: muted }}>{fontSize}px</span>
        </Control>

        <div style={{ ...S.divider, background: line }} />

        <Control label="Color" color={muted}>
          <div style={S.swatchRow}>
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => onTheme(t.id)}
                title={t.label}
                aria-label={`Page color: ${t.label}`}
                className="swatch"
                style={{
                  ...S.swatch,
                  background: t.swatch,
                  border: themeId === t.id ? `2px solid ${ACCENT}` : "1px solid rgba(0,0,0,0.18)",
                }}
              />
            ))}
          </div>
        </Control>

        <div style={{ ...S.divider, background: line }} />

        <div style={{ ...S.progress, color: muted }} title="Reading progress">
          {progressLabel}
        </div>

        <button
          style={{ ...S.resetBtn, background: fieldBg, color: muted, fontSize: 16 }}
          onClick={onAddBookmark} className="icon-btn"
          title="Bookmark this spot" aria-label="Add bookmark"
        >
          🔖
        </button>

        <button
          style={{ ...S.resetBtn, background: fieldBg, color: muted }}
          onClick={onReset} className="reset-btn"
          title="Library / open another file" aria-label="Library"
        >
          ＋
        </button>
      </div>
    </div>
  );
}

function Control({ label, color, children }) {
  return (
    <div style={S.control}>
      <span style={{ ...S.controlLabel, color }}>{label}</span>
      <div style={S.controlBody}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Injected global / dynamic CSS
 * ------------------------------------------------------------------ */

function GlobalStyle({ fontFamily, fontSize, theme }) {
  const css = `
    * { box-sizing: border-box; }
    html, body, #root { height: 100%; margin: 0; }
    body {
      background: ${theme.bg};
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transition: background 0.3s ease;
    }

    .reader-scroll::-webkit-scrollbar { width: 10px; }
    .reader-scroll::-webkit-scrollbar-thumb {
      background: ${theme.dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.14)"};
      border-radius: 8px; border: 3px solid transparent; background-clip: padding-box;
    }

    .pdf-page {
      display: block; margin: 0 auto 22px; border-radius: 4px; background: #fff;
      box-shadow: 0 6px 24px rgba(0,0,0,${theme.dark ? 0.5 : 0.12});
    }

    .epub-content {
      font-family: ${fontFamily}; font-size: ${fontSize}px;
      line-height: 1.75; color: ${theme.text};
      transition: color 0.3s ease;
    }
    .epub-content, .epub-content * { font-family: ${fontFamily} !important; color: ${theme.text} !important; }
    .epub-content p, .epub-content li, .epub-content span,
    .epub-content div, .epub-content blockquote {
      font-size: ${fontSize}px !important; line-height: 1.75 !important;
    }
    .epub-content h1 { font-size: ${Math.round(fontSize * 1.7)}px !important; }
    .epub-content h2 { font-size: ${Math.round(fontSize * 1.45)}px !important; }
    .epub-content h3 { font-size: ${Math.round(fontSize * 1.25)}px !important; }
    .epub-content h1, .epub-content h2, .epub-content h3 { line-height: 1.3 !important; margin: 1.2em 0 0.5em; }
    .epub-content p { margin: 0 0 1em; }
    .epub-content a { color: ${ACCENT} !important; }
    .epub-section { margin-bottom: 1.5em; }

    .slider { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 999px;
      background: ${theme.dark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.18)"}; outline: none; cursor: pointer; }
    .slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px;
      border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
      border: 1px solid rgba(0,0,0,0.08); transition: transform 0.12s ease; }
    .slider::-webkit-slider-thumb:hover { transform: scale(1.12); }
    .slider::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,0.3); border: none; cursor: pointer; }

    .select { transition: background 0.15s ease; }
    .swatch { width: 20px; height: 20px; border-radius: 50%; cursor: pointer; padding: 0;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25); transition: transform 0.12s ease; }
    .swatch:hover { transform: scale(1.15); }

    .play-btn, .reset-btn { transition: transform 0.12s ease, background 0.18s ease, box-shadow 0.18s ease; }
    .play-btn:hover { transform: scale(1.05); }
    .play-btn:active { transform: scale(0.96); }
    .reset-btn:hover { transform: rotate(90deg); }
    .icon-btn { transition: transform 0.12s ease, background 0.18s ease; }
    .icon-btn:hover { transform: scale(1.08); }

    .dropzone { transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease; }
    .dropzone:hover { transform: translateY(-2px); box-shadow: 0 18px 50px rgba(0,0,0,0.12); }

    .lib-card { transition: transform 0.15s ease, box-shadow 0.2s ease; position: relative; }
    .lib-card:hover { transform: translateY(-3px); box-shadow: 0 14px 36px rgba(0,0,0,0.14); }
    .lib-card .lib-del { opacity: 0; transition: opacity 0.15s ease; }
    .lib-card:hover .lib-del { opacity: 1; }

    .toc-panel { animation: tocIn 0.22s cubic-bezier(0.22,1,0.36,1); }
    @keyframes tocIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }
    .toc-item { transition: background 0.12s ease; }
    .toc-item:hover { background: ${theme.dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)"}; }
    .toc-row { transition: background 0.12s ease; }
    .toc-row:hover { background: ${theme.dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.035)"}; }
    .toc-row .row-del { opacity: 0; transition: opacity 0.12s ease; }
    .toc-row:hover .row-del { opacity: 0.6; }
    .toc-row .row-del:hover { opacity: 1; }
    .toc-list::-webkit-scrollbar { width: 8px; }
    .toc-list::-webkit-scrollbar-thumb { background: ${theme.dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.16)"}; border-radius: 8px; }

    .epub-content mark.hl {
      border-radius: 3px; padding: 0.05em 0.05em; cursor: pointer;
      -webkit-box-decoration-break: clone; box-decoration-break: clone;
      color: inherit !important; transition: filter 0.12s ease;
    }
    .epub-content mark.hl:hover { filter: brightness(0.94); }

    .hl-popover { animation: popIn 0.14s ease; }
    @keyframes popIn { from { opacity: 0; transform: translate(-50%, -100%) scale(0.92); } to { opacity: 1; transform: translate(-50%, -100%) scale(1); } }
    .hl-swatch { transition: transform 0.1s ease; }
    .hl-swatch:hover { transform: scale(1.15); }

    .spinner { animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */

const S = {
  app: { position: "fixed", inset: 0, overflow: "hidden", transition: "background 0.3s ease, color 0.3s ease" },

  // Upload
  uploadOuter: {
    height: "100%", display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 30, padding: 24, overflowY: "auto",
  },
  brand: { display: "flex", alignItems: "center", gap: 16 },
  brandMark: {
    width: 56, height: 56, borderRadius: 16, background: "linear-gradient(160deg,#fff,#efe9df)",
    boxShadow: "0 8px 24px rgba(0,0,0,0.12)", display: "flex", alignItems: "center",
    justifyContent: "center", fontSize: 28, color: ACCENT,
  },
  brandTitle: { fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em" },
  brandSub: { fontSize: 15, marginTop: 2 },

  dropzone: {
    width: "min(560px, 92vw)", padding: "48px 32px", borderRadius: 24,
    border: "2px dashed rgba(0,0,0,0.16)", boxShadow: "0 10px 40px rgba(0,0,0,0.08)",
    textAlign: "center", cursor: "pointer", backdropFilter: "blur(8px)",
  },
  dropzoneActive: { transform: "translateY(-2px)" },
  dropIcon: { fontSize: 40, color: ACCENT, marginBottom: 10 },
  dropTitle: { fontSize: 21, fontWeight: 600 },
  dropSub: { fontSize: 15, marginTop: 8 },
  dropLink: { color: ACCENT, fontWeight: 600 },
  uploadError: { color: "#b4452f", fontSize: 14 },

  // Library
  libraryWrap: { width: "min(720px, 92vw)" },
  libraryHead: { fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12, textAlign: "center" },
  libraryGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14 },
  libCard: {
    borderRadius: 16, padding: "16px 14px 14px", cursor: "pointer",
    boxShadow: "0 6px 22px rgba(0,0,0,0.08)", minHeight: 120,
    display: "flex", flexDirection: "column", gap: 8,
  },
  libDel: {
    position: "absolute", top: 8, right: 8, width: 22, height: 22, borderRadius: "50%",
    border: "none", cursor: "pointer", background: "rgba(0,0,0,0.35)", color: "#fff",
    fontSize: 11, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
  },
  libBadge: { fontSize: 10, fontWeight: 700, letterSpacing: "0.08em" },
  libName: {
    fontSize: 14, fontWeight: 600, lineHeight: 1.35, flex: 1,
    display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
  },
  libBarTrack: { height: 4, borderRadius: 999, background: "rgba(0,0,0,0.10)", overflow: "hidden" },
  libBarFill: { height: "100%", background: ACCENT, borderRadius: 999, transition: "width 0.3s ease" },
  libMeta: { fontSize: 11 },

  // Reader
  scroll: {
    position: "absolute", inset: 0, overflowY: "auto", overflowX: "hidden",
    WebkitOverflowScrolling: "touch", scrollBehavior: "auto",
  },
  page: { maxWidth: PAGE_WIDTH, margin: "0 auto", padding: "56px 40px 0" },
  pdfWrap: { width: "100%" },

  // Loading
  loadingWrap: {
    position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
    padding: "26px 34px", background: "rgba(255,255,255,0.82)", backdropFilter: "blur(14px)",
    borderRadius: 18, boxShadow: "0 12px 40px rgba(0,0,0,0.16)",
  },
  spinner: { width: 34, height: 34, borderRadius: "50%", border: "3px solid rgba(0,0,0,0.12)", borderTopColor: ACCENT },
  loadingText: { fontSize: 14, color: "#6b6459" },

  errorToast: {
    position: "fixed", top: 24, left: "50%", transform: "translateX(-50%)",
    background: "#fff", color: "#b4452f", padding: "12px 20px", borderRadius: 12,
    boxShadow: "0 8px 28px rgba(0,0,0,0.16)", fontSize: 14, maxWidth: "90vw",
  },

  // Table of contents
  tocOverlay: {
    position: "fixed", inset: 0, zIndex: 20, background: "rgba(0,0,0,0.28)",
    backdropFilter: "blur(2px)", display: "flex",
  },
  tocPanel: {
    width: "min(340px, 84vw)", height: "100%", display: "flex", flexDirection: "column",
    boxShadow: "8px 0 40px rgba(0,0,0,0.22)", backdropFilter: "blur(16px)",
  },
  tocHead: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "20px 20px 14px", borderBottom: "1px solid rgba(0,0,0,0.08)", flex: "0 0 auto",
  },
  tocTitle: { fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" },
  tocClose: { border: "none", background: "transparent", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 4 },
  tocList: { overflowY: "auto", padding: "8px 0 24px", flex: 1 },
  tocItem: {
    display: "flex", alignItems: "baseline", gap: 10, width: "100%",
    border: "none", background: "transparent", cursor: "pointer", textAlign: "left",
    padding: "9px 18px", fontSize: 14, lineHeight: 1.4,
  },
  tocLabel: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tocPage: { fontSize: 12, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" },
  tocGroup: {
    fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase",
    padding: "16px 18px 6px", opacity: 0.85,
  },
  tocRow: { display: "flex", alignItems: "center" },
  rowDel: {
    border: "none", background: "transparent", cursor: "pointer", fontSize: 12,
    padding: "0 14px", flex: "0 0 auto", opacity: 0.55,
  },
  bmDot: { width: 9, height: 9, borderRadius: "50%", flex: "0 0 auto", alignSelf: "center" },

  // Highlight popover
  hlPop: {
    position: "fixed", zIndex: 30, transform: "translate(-50%, -100%)",
    display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
    borderRadius: 999, background: "rgba(40,38,35,0.95)", backdropFilter: "blur(10px)",
    boxShadow: "0 8px 28px rgba(0,0,0,0.32)",
  },
  hlSwatch: { width: 22, height: 22, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.35)", cursor: "pointer", padding: 0 },
  hlRemove: {
    border: "none", background: "transparent", color: "#fff", cursor: "pointer",
    fontSize: 13, fontWeight: 600, padding: "2px 8px",
  },
  flashToast: {
    position: "fixed", bottom: 92, left: "50%", transform: "translateX(-50%)",
    color: "#fff", padding: "9px 18px", borderRadius: 999, fontSize: 13, zIndex: 25,
    boxShadow: "0 8px 24px rgba(0,0,0,0.22)", pointerEvents: "none",
  },

  // Control bar
  barWrap: {
    position: "fixed", bottom: 24, left: 0, right: 0, display: "flex",
    justifyContent: "center", pointerEvents: "none", padding: "0 16px",
  },
  bar: {
    pointerEvents: "auto", display: "flex", alignItems: "center", gap: 13,
    padding: "10px 16px", borderRadius: 999,
    backdropFilter: "blur(20px) saturate(1.6)", WebkitBackdropFilter: "blur(20px) saturate(1.6)",
    boxShadow: "0 10px 40px rgba(0,0,0,0.18), inset 0 0 0 1px rgba(255,255,255,0.4)",
    maxWidth: "calc(100vw - 32px)", overflowX: "auto",
  },
  playBtn: {
    flex: "0 0 auto", width: 42, height: 42, borderRadius: "50%", border: "none", cursor: "pointer",
    background: "linear-gradient(160deg,#3a352e,#23201b)", color: "#fff", fontSize: 15,
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 4px 14px rgba(0,0,0,0.25)", paddingLeft: 2,
  },
  playBtnOn: { background: "linear-gradient(160deg,#b08a52,#8a6a3b)", paddingLeft: 0 },
  control: { display: "flex", flexDirection: "column", gap: 3, flex: "0 0 auto" },
  controlLabel: { fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" },
  controlBody: { display: "flex", alignItems: "center", gap: 8 },
  range: { margin: 0 },
  valueTag: { fontSize: 12, minWidth: 34, fontVariantNumeric: "tabular-nums" },
  select: {
    appearance: "none", border: "none", borderRadius: 8, padding: "6px 26px 6px 10px",
    fontSize: 13, cursor: "pointer",
    backgroundImage:
      "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path d='M2 3.5L5 6.5L8 3.5' stroke='%236b6459' stroke-width='1.4' fill='none' stroke-linecap='round'/></svg>\")",
    backgroundRepeat: "no-repeat", backgroundPosition: "right 8px center",
  },
  swatchRow: { display: "flex", alignItems: "center", gap: 6 },
  swatch: {},
  divider: { width: 1, height: 30, flex: "0 0 auto" },
  progress: { fontSize: 12, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", flex: "0 0 auto", padding: "0 2px" },
  resetBtn: {
    flex: "0 0 auto", width: 34, height: 34, borderRadius: "50%", border: "none", cursor: "pointer",
    fontSize: 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
  },
};

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
