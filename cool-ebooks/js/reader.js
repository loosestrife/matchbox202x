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

function extractTextFromCfiLocation(contents) {
  const location = rendition.currentLocation();
  if (!location?.start?.cfi || !location?.end?.cfi) return '';
  try {
    const cfiRangeStr = makeCfiRange(location.start.cfi, location.end.cfi);
    const range = contents.range(cfiRangeStr);
    return range ? range.toString().replace(/\s+/g, ' ').trim() : '';
  } catch (err) {
    console.warn('[cool-ebooks] cfiRange extraction error:', err);
    return '';
  }
}

function findBottomRightCaretRange(doc, viewportWidth, viewportHeight) {
  for (let y = viewportHeight - 20; y >= 50; y -= 30) {
    const endRange = doc.caretRangeFromPoint(viewportWidth - 30, y);
    if (endRange && endRange.startContainer && endRange.startContainer !== doc.body) {
      return endRange;
    }
  }
  return null;
}

function extractTextFromCaretPoints(doc, viewportWidth, viewportHeight) {
  if (typeof doc.caretRangeFromPoint !== 'function') return '';
  try {
    const startRange = doc.caretRangeFromPoint(30, 30);
    const endRange = findBottomRightCaretRange(doc, viewportWidth, viewportHeight);
    if (!startRange?.startContainer || !endRange?.startContainer) return '';

    const pageRange = doc.createRange();
    pageRange.setStart(startRange.startContainer, startRange.startOffset);
    pageRange.setEnd(endRange.startContainer, endRange.startOffset);
    const text = pageRange.toString().replace(/\s+/g, ' ').trim();
    return text.length > 5 ? text : '';
  } catch (err) {
    console.warn('[cool-ebooks] caretRangeFromPoint error:', err);
    return '';
  }
}

function isRectInViewport(rect, viewportWidth, viewportHeight) {
  return (
    rect.right > 10 &&
    rect.bottom > 10 &&
    rect.left < (viewportWidth - 10) &&
    rect.top < (viewportHeight - 10) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function extractTextFromVisibleElements(doc, viewportWidth, viewportHeight) {
  const elements = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
  const visibleTexts = [];

  elements.forEach((el) => {
    if (!isRectInViewport(el.getBoundingClientRect(), viewportWidth, viewportHeight)) return;
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && !visibleTexts.some((t) => t === text || t.includes(text))) {
      visibleTexts.push(text);
    }
  });

  return visibleTexts.join(' ');
}

// Extract text starting from top of visible page
function getVisiblePageText() {
  if (!rendition) return '';

  try {
    const contents = rendition.getContents()[0];
    if (!contents || !contents.document) return '';

    const doc = contents.document;
    const iframeWin = doc.defaultView || window;
    const viewportHeight = iframeWin.innerHeight || doc.documentElement.clientHeight;
    const viewportWidth = iframeWin.innerWidth || doc.documentElement.clientWidth;

    const cfiText = extractTextFromCfiLocation(contents);
    if (cfiText) return cfiText;

    const caretText = extractTextFromCaretPoints(doc, viewportWidth, viewportHeight);
    if (caretText) return caretText;

    return extractTextFromVisibleElements(doc, viewportWidth, viewportHeight);
  } catch (err) {
    console.warn('[cool-ebooks] getVisiblePageText error:', err);
    return '';
  }
}

function handleArrowKeyPageFlip(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowRight') {
    handlePageFlip('next');
  } else if (e.key === 'ArrowLeft') {
    handlePageFlip('prev');
  }
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

  await new Promise((resolve) => setTimeout(resolve, 200));

  if (wasPlaying) {
    startDoubleBufferedTts(isAutoAdvance);
  }
}

async function displayTargetPageLocation(pageNum) {
  if (book.locations && book.locations.total > 0) {
    const targetPage = Math.max(1, Math.min(pageNum, book.locations.total));
    const cfi = book.locations.cfiFromLocation(targetPage - 1);
    await rendition.display(cfi || (targetPage - 1));
  } else {
    await rendition.display(pageNum - 1);
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
    await displayTargetPageLocation(pageNum);
  } catch (err) {
    console.warn('[cool-ebooks] Page jump error:', err);
    logDebug(`[Navigation Error] ${err.message || err}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 200));

  if (wasPlaying) {
    startDoubleBufferedTts(false);
  }
}

function handleRenditionRelocated(location) {
  console.log('[cool-ebooks] Relocated to:', location);
  logDebug(`[Navigation] Displaying location CFI: ${location?.start?.cfi || 'unknown'}`);
  if (location && location.start) {
    try {
      localStorage.setItem('cool_ebooks_location', location.start.cfi);
    } catch (_) {}
  }
  if (!book?.locations || book.locations.total <= 0) return;

  const currentLocation = book.locations.locationFromCfi(location.start.cfi);
  if (currentLocation === -1 || currentLocation === undefined) return;

  const pageNum = currentLocation + 1;
  const pageInputEl = document.getElementById('page-input');
  if (pageInputEl) pageInputEl.value = pageNum;
  try {
    localStorage.setItem('cool_ebooks_page', pageNum);
  } catch (_) {}
}

function syncLocationsUiAfterGenerate(fileName) {
  const totalPages = book.locations.total;
  const pageTotalEl = document.getElementById('page-total');
  const pageInputEl = document.getElementById('page-input');

  if (pageTotalEl) pageTotalEl.textContent = `/ ${totalPages}`;
  if (pageInputEl) pageInputEl.max = totalPages;

  const currentLoc = rendition.currentLocation();
  if (currentLoc && currentLoc.start) {
    const pNum = book.locations.locationFromCfi(currentLoc.start.cfi);
    if (pNum !== -1 && pNum !== undefined && pageInputEl) {
      pageInputEl.value = pNum + 1;
    }
  }

  updateTtsStatus(`Loaded EPUB: ${fileName} (${totalPages} pages). Ready for TTS.`);
}

// Load EPUB Data into epub.js rendition and bind location tracking
function loadBookFromData(data, fileName, initialLocation = null) {
  if (rendition) {
    try { rendition.destroy(); } catch (_) {}
  }

  const bookBuffer = (typeof data === 'string') ? base64ToBuffer(data) : data;
  book = ePub(bookBuffer);

  rendition = book.renderTo("viewer", {
    width: "100%",
    height: "100%",
    flow: "paginated",
    manager: "default"
  });

  rendition.hooks.content.register((contents) => {
    contents.window.addEventListener('keyup', handleArrowKeyPageFlip);
  });

  if (initialLocation) {
    rendition.display(initialLocation);
  } else {
    rendition.display();
  }

  rendition.on('relocated', handleRenditionRelocated);

  stopTts(true);
  updateTtsStatus(`Loaded EPUB: ${fileName}. Generating page index...`);

  book.ready
    .then(() => book.locations.generate(1024))
    .then(() => syncLocationsUiAfterGenerate(fileName))
    .catch((err) => {
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

function decodeStringBodyToBuffer(bodyStr) {
  try {
    const binaryStr = atob(bodyStr.trim());
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes.buffer;
  } catch (_) {
    return new TextEncoder().encode(bodyStr).buffer;
  }
}

function extractBinaryPartAttachment(parts, defaultName) {
  const binaryPart = parts.find((p) => p.body && (p.body.byteLength > 0 || p.body.length > 0) && !p.json);
  if (!binaryPart || !binaryPart.body) return null;

  let fileBuffer = null;
  let base64Str = null;
  let fileName = defaultName;

  if (typeof binaryPart.body === 'string') {
    base64Str = binaryPart.body;
    fileBuffer = decodeStringBodyToBuffer(binaryPart.body);
  } else if (binaryPart.body instanceof ArrayBuffer) {
    fileBuffer = binaryPart.body;
  }

  const disposition = binaryPart.headers && binaryPart.headers['content-disposition'];
  if (disposition) {
    const m = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (m) fileName = m[1];
  }
  return fileBuffer ? { fileBuffer, fileName, base64Str } : null;
}

function extractJsonBlobPartAttachment(parts, defaultName) {
  const blobPart = parts.find((p) => p.json && (p.json.blob || p.json.data_blob));
  const blobObj = blobPart?.json?.blob;
  if (!blobObj || !blobObj.data) return null;

  const base64Str = blobObj.data;
  const fileName = blobObj.name || defaultName;
  const fileBuffer = decodeStringBodyToBuffer(base64Str);
  return { fileBuffer, fileName, base64Str };
}

function persistBookToLocalStorage(base64Str, fileName) {
  if (!base64Str) return;
  try {
    localStorage.setItem('cool_ebooks_book_data', base64Str);
    localStorage.setItem('cool_ebooks_book_name', fileName);
    localStorage.removeItem('cool_ebooks_location');
    localStorage.removeItem('cool_ebooks_page');
  } catch (err) {
    console.warn('Could not store EPUB in localStorage:', err);
  }
}

async function handleXIntentPickBook() {
  if (!window.xintent) {
    alert("window.xintent not loaded yet");
    return;
  }
  try {
    const res = await window.xintent.intent('fs.PickFile', {
      intent: 'fs.PickFile',
      Accept: 'application/epub+zip'
    });
    if (!res || !res.ok) return;

    const parts = typeof res.parseMultipart === 'function'
      ? await res.parseMultipart()
      : window.xintent.parseMultipartResponse(await res.text());

    const extracted =
      extractBinaryPartAttachment(parts, 'xintent-book.epub') ||
      extractJsonBlobPartAttachment(parts, 'xintent-book.epub');

    if (extracted && extracted.fileBuffer) {
      persistBookToLocalStorage(extracted.base64Str, extracted.fileName);
      loadBookFromData(extracted.fileBuffer, extracted.fileName);
    } else {
      console.log("No file data received (or user cancelled).");
    }
  } catch (err) {
    console.error("XIntent Pick error", err);
  }
}

function handleLocalFileInputChange(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (event) {
    const arrayBuffer = event.target.result;
    try {
      persistBookToLocalStorage(bufferToBase64(arrayBuffer), file.name);
    } catch (err) {
      console.warn('Could not store EPUB in localStorage (quota limit):', err);
    }
    loadBookFromData(arrayBuffer, file.name);
  };
  reader.readAsArrayBuffer(file);
}

function bindClickById(id, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', handler);
}

// Setup Reader Event Listeners (file picking, navigation buttons, keyboard)
function setupReaderEventListeners() {
  bindClickById('xintent-pick', handleXIntentPickBook);

  const fileInputEl = document.getElementById('file-input');
  if (fileInputEl) {
    fileInputEl.addEventListener('change', handleLocalFileInputChange);
  }

  bindClickById('next', () => handlePageFlip('next'));
  bindClickById('prev', () => handlePageFlip('prev'));
  bindClickById('page-go', handlePageJump);
  bindClickById('tts-play', () => startDoubleBufferedTts(false));
  bindClickById('tts-stop', () => stopTts(true));

  const pageInputEl = document.getElementById('page-input');
  if (pageInputEl) {
    pageInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlePageJump();
    });
  }

  document.addEventListener('keyup', (e) => {
    if (rendition) handleArrowKeyPageFlip(e);
  });
}
