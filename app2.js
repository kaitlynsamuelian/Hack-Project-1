// ===== UI helpers =====
const fileInput = document.getElementById('file');
const preview   = document.getElementById('preview');
const ocrOut    = document.getElementById('ocrOut');
const jsonOut   = document.getElementById('jsonOut');
const dishesList= document.getElementById('dishesList');
const progress  = document.getElementById('progress');
const copyBtn   = document.getElementById('copyJson');
const toast     = document.getElementById('toast');

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1500);
}

// ===== Text-only menu parser =====
const SECTION_RE = /\b(APPETIZERS|STARTERS|SMALL PLATES|SALADS|SOUPS|SANDWICHES|MAINS|ENTR[EÉ]ES|PIZZA|PASTA|SIDES|DESSERTS?|DRINKS?)\b/i;

// Price tokenizer
const PRICE_TOKEN = /\$?\d{1,4}(?:[.,]\d{1,2}|\s\d{2})?|\d{1,4}\s?[-–]\s?\d{1,4}/g;

function normalizePrice(t) {
  let s = t.replace(/\s+/g, ' ').trim();
  if (/^\d{1,4}\s?[-–]\s?\d{1,4}$/.test(s)) return s.replace('–','-');
  s = s.replace(/^\$/, '').replace(',', '.');
  if (/^\d{1,3}\s\d{2}$/.test(s)) return s.replace(' ', '.');
  if (/^\d{3}$/.test(s)) return s.replace(/(\d{2})(\d)$/, '$1.$2');
  if (/^\d{4}$/.test(s)) return s.replace(/(\d{2})(\d{2})$/, '$1.$2');
  return s;
}

// $1–$300 filter
function looksLikePrice(norm) {
  if (/^\d{1,3}-\d{1,3}$/.test(norm)) {
    const [a, b] = norm.split('-').map(n => parseFloat(n));
    return a >= 1 && a <= 300 && b >= 1 && b <= 300;
  }
  if (/^\d{1,3}(?:\.\d{1,2})?$/.test(norm)) {
    const v = parseFloat(norm);
    return v >= 1 && v <= 300;
  }
  return false;
}

function findPricesInLine(line) {
  const out = [];
  let m;
  while ((m = PRICE_TOKEN.exec(line)) !== null) {
    const raw = m[0];
    const norm = normalizePrice(raw);
    if (looksLikePrice(norm)) out.push({ raw, norm, index: m.index });
  }
  return out;
}

// Caps & scoring
function isAllCaps(s){ return s.length>1 && s === s.toUpperCase(); }
function capWordRatio(s){
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let caps = 0;
  for (const w of words){
    if (/^[A-Z][a-z’'&\-]*$/.test(w) || /^[A-Z]{2,}$/.test(w)) caps++;
  }
  return caps / words.length;
}
function titleScore(line) {
  const s = line.trim();
  if (!s) return 0;
  const len = s.split(/\s+/).length;
  const hasComma = /,/.test(s);
  const hasPrice = !!findPricesInLine(s).length;
  let score = 0;
  if (len >= 1 && len <= 8) score += 1;
  score += capWordRatio(s) * 2;
  if (!hasComma) score += 1;
  if (hasPrice) score -= 0.6;
  if (/&|and/i.test(s)) score -= 0.2;
  if (/[.:;]$/.test(s)) score -= 0.4;
  return score;
}
function descScore(line) {
  const s = line.trim();
  if (!s) return 0;
  const len = s.split(/\s+/).length;
  const hasComma = /,/.test(s);
  const hasPrice = !!findPricesInLine(s).length;
  let score = 0;
  if (len >= 3) score += 1;
  if (hasComma) score += 1;
  if (hasPrice) score += 0.8;
  if (/[a-z]/.test(s) && !/[A-Z]{4,}/.test(s)) score += 0.4;
  return score;
}
function isSectionHeader(line){
  const s = line.trim();
  if (!s) return false;
  if (SECTION_RE.test(s)) return true;
  if (isAllCaps(s) && s.split(/\s+/).length <= 3) return true;
  return false;
}

// Detect where prices usually live
function detectPriceStyle(lines) {
  let onTitle = 0, onDesc = 0, standalone = 0;
  for (let L of lines) {
    const prices = findPricesInLine(L);
    if (!prices.length) continue;
    const t = titleScore(L) >= 2;
    const d = descScore(L)  >= 1.2;
    if (t && !d) onTitle++;
    else if (d && !t) onDesc++;
    else if (L.trim().split(/\s+/).length <= 3) standalone++;
    else onDesc++;
  }
  const max = Math.max(onTitle, onDesc, standalone);
  if (max === 0) return 'unknown';
  if (max === onTitle) return 'price_on_title';
  if (max === onDesc)  return 'price_on_desc';
  return 'price_standalone';
}

// Core parser
function parseMenuFromText(ocrText) {
  const lines = ocrText.split(/\r?\n/).map(x => x.trim()).filter(x => x);
  const style = detectPriceStyle(lines);
  const dishes = [];
  let section = '';
  let pendingTitle = null;
  const finalize = () => {
    if (pendingTitle && pendingTitle.name) {
      dishes.push({
        name: pendingTitle.name.replace(/^[•·\-–—\s]+/, '').trim(),
        price: pendingTitle.price || '',
        description: (pendingTitle.description || '').trim(),
        section: pendingTitle.section
      });
      pendingTitle = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (isSectionHeader(L)) { section = L; finalize(); continue; }
    const tScore = titleScore(L);
    const dScore = descScore(L);
    const pricesHere = findPricesInLine(L);

    if (style === 'price_on_title' && tScore >= 2 && tScore >= dScore) {
      finalize();
      pendingTitle = { name: L, section, price: '', description: '' };
      if (pricesHere.length) pendingTitle.price = pricesHere.at(-1).norm;
      continue;
    }
    if (tScore >= 2 && tScore >= dScore) {
      finalize();
      pendingTitle = { name: L, section, price: '', description: '' };
      if (pricesHere.length) pendingTitle.price = pricesHere.at(-1).norm;
      continue;
    }
    if (dScore >= 1) {
      if (!pendingTitle && i > 0) {
        const prev = lines[i-1];
        if (!isSectionHeader(prev) && titleScore(prev) >= 1.6) {
          pendingTitle = { name: prev, section, price: '', description: '' };
        }
      }
      if (!pendingTitle) continue;
      if (pricesHere.length && !pendingTitle.price) {
        pendingTitle.price = pricesHere.at(-1).norm;
      }
      let desc = L;
      for (const p of pricesHere) desc = desc.replace(p.raw, '');
      pendingTitle.description = (pendingTitle.description + ' ' + desc).replace(/\s{2,}/g,' ').trim();
      const next = lines[i+1] || '';
      const endHere = !next || isSectionHeader(next) || titleScore(next) >= 2 || (style !== 'price_on_title' && findPricesInLine(next).length);
      if (endHere) finalize();
      continue;
    }
    if (style === 'price_standalone' && pendingTitle) {
      if (L.split(/\s+/).length <= 3) {
        const p = findPricesInLine(L).at(-1);
        if (p && !pendingTitle.price) pendingTitle.price = p.norm;
      }
    }
    if (pendingTitle) finalize();
  }
  finalize();
  return { dishes: dishes.filter(d => d.name && d.name.length >= 2) };
}

// ===== OCR + wiring =====
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  preview.src = url;
  progress.textContent = 'Running OCR…';
  copyBtn.disabled = true;
  ocrOut.textContent = '…';

  try {
    const { data } = await Tesseract.recognize(url, 'eng', {
      logger: m => {
        if (m.status && typeof m.progress === 'number') {
          progress.textContent = `${m.status} ${(m.progress*100|0)}%`;
        }
      }
    });
    const raw = (data?.text ?? '').trim();
    ocrOut.textContent = raw || '(no text detected)';
    const parsed = parseMenuFromText(raw);
    jsonOut.value = JSON.stringify(parsed, null, 2);
    copyBtn.disabled = false;

    if (!parsed.dishes.length) {
      dishesList.innerHTML = '<span class="hint">No dishes detected.</span>';
    } else {
      const ul = document.createElement('ul');
      parsed.dishes.forEach(d => {
        const li = document.createElement('li');
        const sec = d.section ? `<span class="hint">[${d.section}]</span> ` : '';
        const price = d.price ? ` — <b>${d.price}</b>` : '';
        li.innerHTML = `${sec}<b>${d.name}</b>${price}<br><span class="hint">${d.description}</span>`;
        ul.appendChild(li);
      });
      dishesList.innerHTML = '';
      dishesList.appendChild(ul);
      showToast(`Found ${parsed.dishes.length} dishes`);
    }
  } catch (err) {
    console.error(err);
    ocrOut.textContent = `OCR error: ${err.message || String(err)}`;
    showToast('OCR failed');
  } finally {
    progress.textContent = '';
  }
});

// Copy JSON
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(jsonOut.value);
    showToast('Copied JSON');
  } catch {
    jsonOut.select(); document.execCommand('copy');
    showToast('Copied (fallback)');
  }
});
