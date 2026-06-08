/*
 * Scrollery — a single-file PDF & EPUB autoscroll reader.
 *
 * This is the one .jsx component the app is built around. It is hosted by
 * index.html, which loads React, pdf.js, epub.js (+ JSZip) and Babel from a
 * CDN, so the libraries are available here as globals (window.pdfjsLib,
 * window.ePub) rather than via `import`.
 *
 * Everything runs in the browser — no backend.
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

const SPEED_MIN = 0.2; // px / frame — barely moving
const SPEED_MAX = 3.0; // px / frame — brisk reading pace
const PAGE_WIDTH = 820; // max content width, like a book column

const PDF_WORKER =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

function App() {
  // View state
  const [mode, setMode] = useState(null); // null | 'pdf' | 'epub'
  const [ready, setReady] = useState(false); // reader mounted?
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  // Reader content
  const [epubHtml, setEpubHtml] = useState("");
  const [fileName, setFileName] = useState("");

  // Controls
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1.0);
  const [fontFamily, setFontFamily] = useState(FONT_OPTIONS[0].value);
  const [fontSize, setFontSize] = useState(19);

  // Progress
  const [progress, setProgress] = useState(0); // 0-100
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  // Refs (read inside the rAF loop so it never needs restarting)
  const scrollRef = useRef(null);
  const pdfContainerRef = useRef(null);
  const speedRef = useRef(speed);
  const playingRef = useRef(false);
  const rafRef = useRef(null);
  const accRef = useRef(0); // sub-pixel accumulator
  const progressRef = useRef(-1);
  const modeRef = useRef(null);
  const totalPagesRef = useRef(0);
  const pendingRef = useRef(null); // file buffer waiting for reader to mount

  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { totalPagesRef.current = totalPages; }, [totalPages]);

  /* ---------------------------------------------------------------- *
   * Progress + autoscroll loop
   * ---------------------------------------------------------------- */

  const updateProgress = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? el.scrollTop / max : 0;
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    if (pct !== progressRef.current) {
      progressRef.current = pct;
      setProgress(pct);
      if (modeRef.current === "pdf" && totalPagesRef.current) {
        const p = Math.min(
          totalPagesRef.current,
          Math.floor(ratio * totalPagesRef.current) + 1
        );
        setCurrentPage(p);
      }
    }
  }, []);

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
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

    // Reached the end → stop automatically.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
      pause();
      return;
    }
    rafRef.current = requestAnimationFrame(step);
  }, [pause, updateProgress]);

  const play = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // If we're already at the very bottom, snap back to the top first.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
      el.scrollTop = 0;
    }
    accRef.current = 0;
    playingRef.current = true;
    setPlaying(true);
    rafRef.current = requestAnimationFrame(step);
  }, [step]);

  const togglePlay = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  /* ---------------------------------------------------------------- *
   * Manual-scroll detection → pause autoscroll
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!ready) return;
    const el = scrollRef.current;
    if (!el) return;

    const onManual = () => { if (playingRef.current) pause(); };
    const onScrollSync = () => { if (!playingRef.current) updateProgress(); };
    const onKey = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (
        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(
          e.code
        )
      ) {
        onManual();
      }
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

  // Tidy up the animation frame if the component ever unmounts.
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  /* ---------------------------------------------------------------- *
   * Rendering: PDF
   * ---------------------------------------------------------------- */

  const renderPdf = useCallback(async (buffer) => {
    setLoading(true);
    setLoadingMsg("Rendering PDF…");
    setError("");
    try {
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
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = viewport.width + "px";
        canvas.style.height = viewport.height + "px";
        container.appendChild(canvas);

        const ctx = canvas.getContext("2d");
        await page.render({
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
      }
    } catch (err) {
      console.error(err);
      setError("Could not render this PDF. It may be corrupted or protected.");
    } finally {
      setLoading(false);
      updateProgress();
    }
  }, [updateProgress]);

  /* ---------------------------------------------------------------- *
   * Rendering: EPUB
   * ---------------------------------------------------------------- */

  const renderEpub = useCallback(async (buffer) => {
    setLoading(true);
    setLoadingMsg("Parsing EPUB…");
    setError("");
    try {
      const book = window.ePub(buffer);
      await book.ready;

      const items = book.spine && book.spine.spineItems ? book.spine.spineItems : [];
      let html = "";
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        setLoadingMsg(`Loading chapter ${i + 1} of ${items.length}…`);
        try {
          const node = await item.load(book.load.bind(book));
          let el = node;
          if (el && el.body) el = el.body; // a Document was returned
          let content = el && el.innerHTML ? el.innerHTML : "";
          // Strip things that won't resolve / aren't safe in a flowing view.
          content = content
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<img[^>]*>/gi, "")
            .replace(/<svg[\s\S]*?<\/svg>/gi, "");
          html += `<section class="epub-section">${content}</section>`;
          item.unload();
        } catch (e) {
          console.warn("Skipped a chapter:", e);
        }
      }
      if (!html) throw new Error("No readable content found.");
      setEpubHtml(html);
    } catch (err) {
      console.error(err);
      setError("Could not read this EPUB. It may be corrupted or DRM-protected.");
    } finally {
      setLoading(false);
      // Let the DOM paint the injected HTML before measuring.
      requestAnimationFrame(() => updateProgress());
    }
  }, [updateProgress]);

  // Once the reader is mounted, render whatever file is pending.
  useEffect(() => {
    if (ready && pendingRef.current) {
      const p = pendingRef.current;
      pendingRef.current = null;
      if (p.type === "pdf") renderPdf(p.buffer);
      else renderEpub(p.buffer);
    }
  }, [ready, renderPdf, renderEpub]);

  /* ---------------------------------------------------------------- *
   * File intake
   * ---------------------------------------------------------------- */

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
    reader.onload = (e) => {
      const buffer = e.target.result;
      const type = isPdf ? "pdf" : "epub";
      setFileName(file.name);
      setMode(type);
      modeRef.current = type;
      pendingRef.current = { type, buffer };
      setReady(true);
    };
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsArrayBuffer(file);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    loadFile(file);
  }, [loadFile]);

  const reset = useCallback(() => {
    pause();
    setReady(false);
    setMode(null);
    setEpubHtml("");
    setFileName("");
    setProgress(0);
    setCurrentPage(0);
    setTotalPages(0);
    progressRef.current = -1;
    if (pdfContainerRef.current) pdfContainerRef.current.innerHTML = "";
  }, [pause]);

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  const progressLabel =
    mode === "pdf" && totalPages
      ? `Page ${currentPage || 1} / ${totalPages} · ${progress}%`
      : `${progress}%`;

  return (
    <div style={S.app}>
      <GlobalStyle fontFamily={fontFamily} fontSize={fontSize} />

      {!ready ? (
        <UploadZone
          dragging={dragging}
          error={error}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onPick={loadFile}
        />
      ) : (
        <>
          {/* Scrolling reader surface */}
          <div ref={scrollRef} style={S.scroll} className="reader-scroll">
            <div style={S.page}>
              {mode === "pdf" && <div ref={pdfContainerRef} style={S.pdfWrap} />}
              {mode === "epub" && (
                <div
                  className="epub-content"
                  dangerouslySetInnerHTML={{ __html: epubHtml }}
                />
              )}
              <div style={{ height: "40vh" }} />
            </div>
          </div>

          {/* Loading overlay */}
          {loading && (
            <div style={S.loadingWrap}>
              <div style={S.spinner} className="spinner" />
              <div style={S.loadingText}>{loadingMsg}</div>
            </div>
          )}

          {error && !loading && <div style={S.errorToast}>{error}</div>}

          {/* Floating pill control bar */}
          <ControlBar
            playing={playing}
            onToggle={togglePlay}
            speed={speed}
            onSpeed={setSpeed}
            fontFamily={fontFamily}
            onFontFamily={setFontFamily}
            fontSize={fontSize}
            onFontSize={setFontSize}
            progressLabel={progressLabel}
            onReset={reset}
          />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Upload zone
 * ------------------------------------------------------------------ */

function UploadZone({ dragging, error, onDragOver, onDragLeave, onDrop, onPick }) {
  const inputRef = useRef(null);
  return (
    <div style={S.uploadOuter}>
      <div style={S.brand}>
        <div style={S.brandMark}>❧</div>
        <div>
          <div style={S.brandTitle}>Scrollery</div>
          <div style={S.brandSub}>A calm reader with autoscroll, for PDF &amp; EPUB</div>
        </div>
      </div>

      <div
        className="dropzone"
        style={{
          ...S.dropzone,
          ...(dragging ? S.dropzoneActive : null),
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => inputRef.current && inputRef.current.click()}
      >
        <div style={S.dropIcon}>⤓</div>
        <div style={S.dropTitle}>
          {dragging ? "Drop to open" : "Drag a book here"}
        </div>
        <div style={S.dropSub}>
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
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Control bar
 * ------------------------------------------------------------------ */

function ControlBar({
  playing,
  onToggle,
  speed,
  onSpeed,
  fontFamily,
  onFontFamily,
  fontSize,
  onFontSize,
  progressLabel,
  onReset,
}) {
  return (
    <div style={S.barWrap}>
      <div style={S.bar} className="control-bar">
        <button
          style={{ ...S.playBtn, ...(playing ? S.playBtnOn : null) }}
          onClick={onToggle}
          className="play-btn"
          title={playing ? "Pause (Space)" : "Play (Space)"}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "►"}
        </button>

        <Control label="Speed">
          <input
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.1}
            value={speed}
            onChange={(e) => onSpeed(parseFloat(e.target.value))}
            style={{ ...S.range, width: 110 }}
            className="slider"
          />
          <span style={S.valueTag}>{speed.toFixed(1)}×</span>
        </Control>

        <div style={S.divider} />

        <Control label="Font">
          <select
            value={fontFamily}
            onChange={(e) => onFontFamily(e.target.value)}
            style={S.select}
            className="select"
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </Control>

        <div style={S.divider} />

        <Control label="Size">
          <input
            type="range"
            min={12}
            max={32}
            step={1}
            value={fontSize}
            onChange={(e) => onFontSize(parseInt(e.target.value, 10))}
            style={{ ...S.range, width: 90 }}
            className="slider"
          />
          <span style={S.valueTag}>{fontSize}px</span>
        </Control>

        <div style={S.divider} />

        <div style={S.progress} title="Reading progress">
          {progressLabel}
        </div>

        <button
          style={S.resetBtn}
          onClick={onReset}
          className="reset-btn"
          title="Open another file"
          aria-label="Open another file"
        >
          ＋
        </button>
      </div>
    </div>
  );
}

function Control({ label, children }) {
  return (
    <div style={S.control}>
      <span style={S.controlLabel}>{label}</span>
      <div style={S.controlBody}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Injected global / dynamic CSS
 * ------------------------------------------------------------------ */

function GlobalStyle({ fontFamily, fontSize }) {
  const css = `
    * { box-sizing: border-box; }
    html, body, #root { height: 100%; margin: 0; }
    body {
      background: #f7f4ee;
      color: #2b2722;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    .reader-scroll::-webkit-scrollbar { width: 10px; }
    .reader-scroll::-webkit-scrollbar-thumb {
      background: rgba(0,0,0,0.14); border-radius: 8px;
      border: 3px solid transparent; background-clip: padding-box;
    }
    .reader-scroll::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.24); background-clip: padding-box; }

    .pdf-page {
      display: block;
      margin: 0 auto 22px;
      border-radius: 4px;
      background: #fff;
      box-shadow: 0 6px 24px rgba(40,33,22,0.10);
    }

    /* EPUB flowing text — font controls apply live via these rules */
    .epub-content {
      font-family: ${fontFamily};
      font-size: ${fontSize}px;
      line-height: 1.75;
      color: #2b2722;
    }
    .epub-content, .epub-content * { font-family: ${fontFamily} !important; }
    .epub-content p,
    .epub-content li,
    .epub-content span,
    .epub-content div,
    .epub-content blockquote {
      font-size: ${fontSize}px !important;
      line-height: 1.75 !important;
    }
    .epub-content h1 { font-size: ${Math.round(fontSize * 1.7)}px !important; }
    .epub-content h2 { font-size: ${Math.round(fontSize * 1.45)}px !important; }
    .epub-content h3 { font-size: ${Math.round(fontSize * 1.25)}px !important; }
    .epub-content h1, .epub-content h2, .epub-content h3 { line-height: 1.3 !important; margin: 1.2em 0 0.5em; }
    .epub-content p { margin: 0 0 1em; }
    .epub-content img { max-width: 100%; height: auto; }
    .epub-content a { color: #8a6a3b; }
    .epub-section { margin-bottom: 1.5em; }

    /* Range sliders */
    .slider { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 999px;
      background: rgba(0,0,0,0.18); outline: none; cursor: pointer; }
    .slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
      width: 16px; height: 16px; border-radius: 50%; background: #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,0.3); border: 1px solid rgba(0,0,0,0.08);
      transition: transform 0.12s ease; }
    .slider::-webkit-slider-thumb:hover { transform: scale(1.12); }
    .slider::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.3); border: none; cursor: pointer; }

    .select { transition: background 0.15s ease, box-shadow 0.15s ease; }
    .select:hover { background: rgba(0,0,0,0.06); }

    .play-btn, .reset-btn { transition: transform 0.12s ease, background 0.18s ease, box-shadow 0.18s ease; }
    .play-btn:hover { transform: scale(1.05); }
    .play-btn:active { transform: scale(0.96); }
    .reset-btn:hover { background: rgba(0,0,0,0.08); transform: rotate(90deg); }

    .dropzone { transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease; }
    .dropzone:hover { transform: translateY(-2px); box-shadow: 0 18px 50px rgba(40,33,22,0.12); }

    .spinner { animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .control-bar { transition: box-shadow 0.25s ease; }
  `;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */

const S = {
  app: {
    position: "fixed",
    inset: 0,
    overflow: "hidden",
    background: "#f7f4ee",
  },

  // Upload
  uploadOuter: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 36,
    padding: 24,
  },
  brand: { display: "flex", alignItems: "center", gap: 16 },
  brandMark: {
    width: 56, height: 56, borderRadius: 16,
    background: "linear-gradient(160deg,#fff,#efe9df)",
    boxShadow: "0 8px 24px rgba(40,33,22,0.12)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 28, color: "#a9824f",
  },
  brandTitle: { fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", color: "#2b2722" },
  brandSub: { fontSize: 15, color: "#8a8276", marginTop: 2 },

  dropzone: {
    width: "min(560px, 92vw)",
    padding: "56px 32px",
    borderRadius: 24,
    border: "2px dashed rgba(0,0,0,0.16)",
    background: "rgba(255,255,255,0.6)",
    boxShadow: "0 10px 40px rgba(40,33,22,0.08)",
    textAlign: "center",
    cursor: "pointer",
    backdropFilter: "blur(8px)",
  },
  dropzoneActive: {
    borderColor: "#a9824f",
    background: "rgba(255,251,244,0.95)",
    transform: "translateY(-2px)",
  },
  dropIcon: { fontSize: 40, color: "#a9824f", marginBottom: 10 },
  dropTitle: { fontSize: 21, fontWeight: 600, color: "#2b2722" },
  dropSub: { fontSize: 15, color: "#8a8276", marginTop: 8 },
  dropLink: { color: "#a9824f", fontWeight: 600 },
  uploadError: { color: "#b4452f", fontSize: 14 },

  // Reader
  scroll: {
    position: "absolute",
    inset: 0,
    overflowY: "auto",
    overflowX: "hidden",
    WebkitOverflowScrolling: "touch",
    scrollBehavior: "auto",
  },
  page: {
    maxWidth: PAGE_WIDTH,
    margin: "0 auto",
    padding: "56px 40px 0",
  },
  pdfWrap: { width: "100%" },

  // Loading
  loadingWrap: {
    position: "fixed",
    top: "50%", left: "50%",
    transform: "translate(-50%,-50%)",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
    padding: "26px 34px",
    background: "rgba(255,255,255,0.82)",
    backdropFilter: "blur(14px)",
    borderRadius: 18,
    boxShadow: "0 12px 40px rgba(40,33,22,0.16)",
  },
  spinner: {
    width: 34, height: 34, borderRadius: "50%",
    border: "3px solid rgba(0,0,0,0.12)",
    borderTopColor: "#a9824f",
  },
  loadingText: { fontSize: 14, color: "#6b6459" },

  errorToast: {
    position: "fixed",
    top: 24, left: "50%", transform: "translateX(-50%)",
    background: "#fff", color: "#b4452f",
    padding: "12px 20px", borderRadius: 12,
    boxShadow: "0 8px 28px rgba(40,33,22,0.16)",
    fontSize: 14, maxWidth: "90vw",
  },

  // Control bar
  barWrap: {
    position: "fixed",
    bottom: 24, left: 0, right: 0,
    display: "flex", justifyContent: "center",
    pointerEvents: "none",
    padding: "0 16px",
  },
  bar: {
    pointerEvents: "auto",
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "10px 16px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.72)",
    backdropFilter: "blur(20px) saturate(1.6)",
    WebkitBackdropFilter: "blur(20px) saturate(1.6)",
    boxShadow: "0 10px 40px rgba(40,33,22,0.18), inset 0 0 0 1px rgba(255,255,255,0.5)",
    maxWidth: "calc(100vw - 32px)",
    overflowX: "auto",
  },
  playBtn: {
    flex: "0 0 auto",
    width: 42, height: 42, borderRadius: "50%",
    border: "none", cursor: "pointer",
    background: "linear-gradient(160deg,#3a352e,#23201b)",
    color: "#fff", fontSize: 15,
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
    paddingLeft: 2,
  },
  playBtnOn: {
    background: "linear-gradient(160deg,#b08a52,#8a6a3b)",
    paddingLeft: 0,
  },
  control: { display: "flex", flexDirection: "column", gap: 3, flex: "0 0 auto" },
  controlLabel: {
    fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
    textTransform: "uppercase", color: "#9a9286",
  },
  controlBody: { display: "flex", alignItems: "center", gap: 8 },
  range: { margin: 0 },
  valueTag: {
    fontSize: 12, color: "#6b6459", minWidth: 34,
    fontVariantNumeric: "tabular-nums",
  },
  select: {
    appearance: "none",
    border: "none",
    background: "rgba(0,0,0,0.04)",
    borderRadius: 8,
    padding: "6px 26px 6px 10px",
    fontSize: 13, color: "#2b2722", cursor: "pointer",
    backgroundImage:
      "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path d='M2 3.5L5 6.5L8 3.5' stroke='%236b6459' stroke-width='1.4' fill='none' stroke-linecap='round'/></svg>\")",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 8px center",
  },
  divider: { width: 1, height: 30, background: "rgba(0,0,0,0.10)", flex: "0 0 auto" },
  progress: {
    fontSize: 12, color: "#6b6459", whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums", flex: "0 0 auto",
    padding: "0 2px",
  },
  resetBtn: {
    flex: "0 0 auto",
    width: 34, height: 34, borderRadius: "50%",
    border: "none", cursor: "pointer",
    background: "rgba(0,0,0,0.04)", color: "#6b6459",
    fontSize: 18, lineHeight: 1,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
};

/* ------------------------------------------------------------------ *
 * Mount
 * ------------------------------------------------------------------ */

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
