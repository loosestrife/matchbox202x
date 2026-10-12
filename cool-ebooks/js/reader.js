// EPUB Reader, Location Tracker, & Page Navigation

let book;
let rendition;
let isFlipping = false;

// Helper to construct a valid IDPF EPUB CFI Range string from start and end CFIs
function makeCfiRange(startCfi, endCfi) {
  if (!startCfi || !endCfi) return startCfi;
  try {
    const s = startCfi.replace(/^epubcfi\(/, '').replace(/\)$/, '');
    const e = endCfi.replace(/^epubcfi\(/, '').replace(/\)$/, '');
    const sParts = s.split('!');
    const eParts = e.split('!');
    if (sParts.length === 2 && eParts.length === 2 && sParts[0] === eParts[0]) {
      return `epubcfi(${sParts[0]}!,${sParts[1]},${eParts[1]})`;
    }
  } catch (_) {}
  return startCfi;
}

// Extract text starting from top of visible page
function getVisiblePageText() {
  if (!rendition) return "";

  try {
    const contents = rendition.getContents()[0];
    if (!contents || !contents.document) return "";

    const doc = contents.document;
    const iframeWin = doc.defaultView || window;

    const viewportHeight = iframeWin.innerHeight || doc.documentElement.clientHeight;
    const viewportWidth = iframeWin.innerWidth || doc.documentElement.clientWidth;

    // 1. Primary: Use EPUB CFI Range constructed from rendition.currentLocation()
    const location = rendition.currentLocation();
    if (location && location.start && location.start.cfi && location.end && location.end.cfi) {
      try {
        const cfiRangeStr = makeCfiRange(location.start.cfi, location.end.cfi);
        const range = contents.range(cfiRangeStr);
        if (range) {
          const rangeText = range.toString().replace(/\s+/g, ' ').trim();
          if (rangeText) return rangeText;
        }
      } catch (err) {
        console.warn('[cool-ebooks] cfiRange extraction error:', err);
      }
    }

    // 2. Secondary: Query Chromium layout engine at screen points (start: 30,30; end: bottom-right)
    if (typeof doc.caretRangeFromPoint === 'function') {
      try {
        const startRange = doc.caretRangeFromPoint(30, 30);
        let endRange = null;
        for (let y = viewportHeight - 20; y >= 50; y -= 30) {
          endRange = doc.caretRangeFromPoint(viewportWidth - 30, y);
          if (endRange && endRange.startContainer && endRange.startContainer !== doc.body) {
            break;
          }
        }
        if (startRange && startRange.startContainer && endRange && endRange.startContainer) {
          const pageRange = doc.createRange();
          pageRange.setStart(startRange.startContainer, startRange.startOffset);
          pageRange.setEnd(endRange.startContainer, endRange.startOffset);
          const text = pageRange.toString().replace(/\s+/g, ' ').trim();
          if (text && text.length > 5) return text;
        }
      } catch (err) {
        console.warn('[cool-ebooks] caretRangeFromPoint error:', err);
      }
    }

    // 3. Fallback: Extract text from DOM elements visible in current viewport bounds
    const elements = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
    const visibleTexts = [];

    elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      const isVisible = (
        rect.right > 10 &&
        rect.bottom > 10 &&
        rect.left < (viewportWidth - 10) &&
        rect.top < (viewportHeight - 10) &&
        rect.width > 0 && rect.height > 0
      );

      if (isVisible) {
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, ' ').trim();
        if (text && !visibleTexts.some(t => t === text || t.includes(text))) {
          visibleTexts.push(text);
        }
      }
    });

    if (visibleTexts.length > 0) {
      return visibleTexts.join(' ');
    }
  } catch (err) {
    console.warn('[cool-ebooks] getVisiblePageText error:', err);
  }
  return "";
}

// Handle Page Flip (drops buffers if playing, flips page, and restarts TTS if playing)
async function handlePageFlip(direction, isAutoAdvance = false) {
  console.log('[cool-ebooks] handlePageFlip direction:', direction, 'rendition:', Boolean(rendition), 'isAutoAdvance:', isAutoAdvance);
  if (!rendition) {
    updateTtsStatus("Please select or upload an EPUB book file to navigate pages.");
    logDebug("[Navigation] No EPUB book loaded into viewer.");
    return;
  }

  if (isFlipping) return;
  isFlipping = true;

  const wasPlaying = isTtsActive;
  if (wasPlaying) {
    // If auto-advancing naturally, do NOT send xaudio.ControlStream stop command
    await stopTts(!isAutoAdvance);
  }

  try {
    if (direction === 'next') {
      logDebug("[Navigation] Flipping to Next Page...");
      await rendition.next();
    } else if (direction === 'prev') {
      logDebug("[Navigation] Flipping to Previous Page...");
      await rendition.prev();
    }
  } catch (err) {
    console.warn('[cool-ebooks] Page flip warning:', err);
    logDebug(`[Navigation Warning] ${err.message || err}`);
  } finally {
    isFlipping = false;
  }

  // Wait for rendition iframe content to settle on the new page
  await new Promise((resolve) => setTimeout(resolve, 200));

  if (wasPlaying) {
    startDoubleBufferedTts(isAutoAdvance);
  }
}

// Handle Jump to Specific Page Number
async function handlePageJump() {
  const pageInput = document.getElementById('page-input');
  if (!pageInput) return;
  const pageNum = parseInt(pageInput.value, 10);

  console.log('[cool-ebooks] handlePageJump pageNum:', pageNum, 'book:', Boolean(book), 'rendition:', Boolean(rendition));
  if (!book || !rendition) {
    updateTtsStatus("Please select or upload an EPUB book file to navigate pages.");
    logDebug("[Navigation] No EPUB book loaded into viewer.");
    return;
  }
  if (!pageNum) return;

  const wasPlaying = isTtsActive;
  if (wasPlaying) {
    await stopTts(true);
  }

  try {
    logDebug(`[Navigation] Jumping to Page #${pageNum}...`);
    if (book.locations && book.locations.total > 0) {
      const targetPage = Math.max(1, Math.min(pageNum, book.locations.total));
      const cfi = book.locations.cfiFromLocation(targetPage - 1);
      if (cfi) {
        await rendition.display(cfi);
      } else {
        await rendition.display(targetPage - 1);
      }
    } else {
      await rendition.display(pageNum - 1);
    }
  } catch (err) {
    console.warn('[cool-ebooks] Page jump error:', err);
    logDebug(`[Navigation Error] ${err.message || err}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 200));

  if (wasPlaying) {
    startDoubleBufferedTts(false);
  }
}

// Load EPUB Data into epub.js rendition and bind location tracking
function loadBookFromData(data, fileName, initialLocation = null) {
  if (rendition) {
    try { rendition.destroy(); } catch (e) {}
  }

  const bookBuffer = (typeof data === 'string') ? base64ToBuffer(data) : data;
  book = ePub(bookBuffer);

  // Bug Fix (2): explicitly specify paginated flow so next() and prev() flip pages smoothly
  rendition = book.renderTo("viewer", {
    width: "100%",
    height: "100%",
    flow: "paginated",
    manager: "default"
  });

  // Bug Fix (2): Register keyboard listeners on iframe content so arrow keys work when iframe is focused
  rendition.hooks.content.register((contents) => {
    contents.window.addEventListener('keyup', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowRight') {
        handlePageFlip('next');
      }
      if (e.key === 'ArrowLeft') {
        handlePageFlip('prev');
      }
    });
  });

  if (initialLocation) {
    rendition.display(initialLocation);
  } else {
    rendition.display();
  }

  // Track location changes: update UI and persist to localStorage
  rendition.on('relocated', (location) => {
    console.log('[cool-ebooks] Relocated to:', location);
    logDebug(`[Navigation] Displaying location CFI: ${location?.start?.cfi || 'unknown'}`);
    if (location && location.start) {
      try {
        localStorage.setItem('cool_ebooks_location', location.start.cfi);
      } catch (e) {}
    }
    if (book && book.locations && book.locations.total > 0) {
      const currentLocation = book.locations.locationFromCfi(location.start.cfi);
      if (currentLocation !== -1 && currentLocation !== undefined) {
        const pageNum = currentLocation + 1;
        const pageInputEl = document.getElementById('page-input');
        if (pageInputEl) pageInputEl.value = pageNum;
        try {
          localStorage.setItem('cool_ebooks_page', pageNum);
        } catch (e) {}
      }
    }
  });

  stopTts(true);
  updateTtsStatus(`Loaded EPUB: ${fileName}. Generating page index...`);

  book.ready.then(() => {
    return book.locations.generate(1024);
  }).then(() => {
    const totalPages = book.locations.total;
    const pageTotalEl = document.getElementById('page-total');
    const pageInputEl = document.getElementById('page-input');

    if (pageTotalEl) pageTotalEl.textContent = `/ ${totalPages}`;
    if (pageInputEl) pageInputEl.max = totalPages;

    // Sync page input field after locations finish generating
    const currentLoc = rendition.currentLocation();
    if (currentLoc && currentLoc.start) {
      const pNum = book.locations.locationFromCfi(currentLoc.start.cfi);
      if (pNum !== -1 && pNum !== undefined && pageInputEl) {
        pageInputEl.value = pNum + 1;
      }
    }

    updateTtsStatus(`Loaded EPUB: ${fileName} (${totalPages} pages). Ready for TTS.`);
  }).catch((err) => {
    console.warn('Page index generation failed:', err);
    updateTtsStatus(`Loaded EPUB: ${fileName}. Ready for TTS.`);
  });
}

// Restore saved EPUB and location from localStorage
function restoreSavedState() {
  try {
    const savedData = localStorage.getItem('cool_ebooks_book_data');
    const savedName = localStorage.getItem('cool_ebooks_book_name') || 'Saved Book.epub';
    const savedLocation = localStorage.getItem('cool_ebooks_location');

    if (savedData) {
      loadBookFromData(savedData, savedName, savedLocation);
    }
  } catch (err) {
    console.warn('Failed to restore saved book state from localStorage:', err);
  }
}

// Setup Reader Event Listeners (file picking, navigation buttons, keyboard)
function setupReaderEventListeners() {
  // EPUB File Loading via XIntent fs.PickFile
  const xintentPickBtn = document.getElementById('xintent-pick');
  if (xintentPickBtn) {
    xintentPickBtn.addEventListener('click', async () => {
      if (!window.xintent) {
        alert("window.xintent not loaded yet");
        return;
      }
      try {
        const res = await window.xintent.intent('fs.PickFile', {
          intent: 'fs.PickFile',
          Accept: 'application/epub+zip'
        });
        if (res && res.ok) {
          let parts = [];
          if (typeof res.parseMultipart === 'function') {
            parts = await res.parseMultipart();
          } else {
            parts = window.xintent.parseMultipartResponse(await res.text());
          }

          let fileBuffer = null;
          let fileName = 'xintent-book.epub';
          let base64Str = null;

          // 1. Check if binary/base64 file attachment was returned in Part 2 (p.body)
          const binaryPart = parts.find(p => p.body && (p.body.byteLength > 0 || p.body.length > 0) && !p.json);
          if (binaryPart && binaryPart.body) {
            if (typeof binaryPart.body === 'string') {
              base64Str = binaryPart.body;
              try {
                const binaryStr = atob(binaryPart.body.trim());
                const len = binaryStr.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
                fileBuffer = bytes.buffer;
              } catch (_) {
                const encoder = new TextEncoder();
                fileBuffer = encoder.encode(binaryPart.body).buffer;
              }
            } else if (binaryPart.body instanceof ArrayBuffer) {
              fileBuffer = binaryPart.body;
            }
            if (binaryPart.headers && binaryPart.headers['content-disposition']) {
              const m = binaryPart.headers['content-disposition'].match(/filename\s*=\s*"?([^";]+)"?/i);
              if (m) fileName = m[1];
            }
          }

          // 2. Fallback to inline json.blob.data structure
          if (!fileBuffer) {
            const blobPart = parts.find(p => p.json && (p.json.blob || p.json.data_blob));
            if (blobPart && blobPart.json && blobPart.json.blob && blobPart.json.blob.data) {
              base64Str = blobPart.json.blob.data;
              fileName = blobPart.json.blob.name || fileName;
              const binaryStr = atob(base64Str);
              const len = binaryStr.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
              fileBuffer = bytes.buffer;
            }
          }

          if (fileBuffer) {
            if (base64Str) {
              try {
                localStorage.setItem('cool_ebooks_book_data', base64Str);
                localStorage.setItem('cool_ebooks_book_name', fileName);
                localStorage.removeItem('cool_ebooks_location');
                localStorage.removeItem('cool_ebooks_page');
              } catch (err) {
                console.warn('Could not store EPUB in localStorage:', err);
              }
            }
            loadBookFromData(fileBuffer, fileName);
          } else {
            console.log("No file data received (or user cancelled).");
          }
        }
      } catch (err) {
        console.error("XIntent Pick error", err);
      }
    });
  }

  // File input change
  const fileInputEl = document.getElementById('file-input');
  if (fileInputEl) {
    fileInputEl.addEventListener('change', function (e) {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = function (event) {
        const arrayBuffer = event.target.result;
        try {
          const base64Str = bufferToBase64(arrayBuffer);
          localStorage.setItem('cool_ebooks_book_data', base64Str);
          localStorage.setItem('cool_ebooks_book_name', file.name);
          localStorage.removeItem('cool_ebooks_location');
          localStorage.removeItem('cool_ebooks_page');
        } catch (err) {
          console.warn('Could not store EPUB in localStorage (quota limit):', err);
        }
        loadBookFromData(arrayBuffer, file.name);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Navigation buttons
  const nextBtn = document.getElementById('next');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => handlePageFlip('next'));
  }

  const prevBtn = document.getElementById('prev');
  if (prevBtn) {
    prevBtn.addEventListener('click', () => handlePageFlip('prev'));
  }

  const pageGoBtn = document.getElementById('page-go');
  if (pageGoBtn) {
    pageGoBtn.addEventListener('click', handlePageJump);
  }

  const pageInputEl = document.getElementById('page-input');
  if (pageInputEl) {
    pageInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlePageJump();
    });
  }

  // TTS buttons
  const ttsPlayBtn = document.getElementById('tts-play');
  if (ttsPlayBtn) {
    ttsPlayBtn.addEventListener('click', () => startDoubleBufferedTts(false));
  }

  const ttsStopBtn = document.getElementById('tts-stop');
  if (ttsStopBtn) {
    ttsStopBtn.addEventListener('click', () => stopTts(true));
  }

  // Outer document keyboard navigation
  document.addEventListener('keyup', (e) => {
    if (!rendition) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowRight') {
      handlePageFlip('next');
    }
    if (e.key === 'ArrowLeft') {
      handlePageFlip('prev');
    }
  });
}
