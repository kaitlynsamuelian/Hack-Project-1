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
// Known sections + tolerant price patterns
const SECTION_RE = /\b(APPETIZERS|STARTERS|SMALL PLATES|SALADS|SOUPS|SANDWICHES|MAINS|ENTR[EÉ]ES|PIZZA|PASTA|SIDES|DESSERTS?|DRINKS?)\b/i;
// $12, 12, 12.0, 12.50, 11-13, 11–13, OCR split "13 5"
const PRICE_RE   = /\$?\b\d{1,3}(?:[.,]\d{1,2}|\s?\d)?\b|\b\d{1,3}\s?[-–]\s?\d{1,3}\b/;

function normalizePriceToken(t) {
  const s = t.replace(/\s+/g,'').replace(',', '.');
  if (/^\$?\d{3}$/.test(s)) return s.replace(/(\d{2})(\d)$/,'$1.$2'); // 135 -> 13.5
  return s;
}
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
  const hasPrice = PRICE_RE.test(s);
  let score = 0;
  if (len >= 1 && len <= 8) score += 1;
  score += capWordRatio(s) * 2;
  if (!hasComma) score += 1;
  if (hasPrice) score -= 0.6;      // often not on title for many menus
  if (/&|and/i.test(s)) score -= 0.2;
  if (/[.:;]$/.test(s)) score -= 0.4;
  return score; // ~0..4
}
function descScore(line) {
  const s = line.trim();
  if (!s) return 0;
  const len = s.split(/\s+/).length;
  const hasComma = /,/.test(s);
  const hasPrice = PRICE_RE.test(s);
  let score = 0;
  if (len >= 3) score += 1;
  if (hasComma) score += 1;
  if (hasPrice) score += 0.8;
  if (/[a-z]/.test(s) && !/[A-Z]{4,}/.test(s)) score += 0.4; // mostly lower-case
  return score; // ~0..3
}
function isSectionHeader(line){
  const s = line.trim();
  if (!s) return false;
  if (SECTION_RE.test(s)) return true;
  if (isAllCaps(s) && s.split(/\s+/).length <= 3) return true; // e.g., "SALADS"
  return false;
}

// Core: raw OCR text -> {dishes:[{name, price, description, section}]}
function parseMenuFromText(ocrText) {
  const lines = ocrText
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => x && !/^\s+$/.test(x));

  const dishes = [];
  let section = '';
  let pendingTitle = null;

  for (let i=0; i<lines.length; i++){
    const L = lines[i];

    // Section?
    if (isSectionHeader(L)) {
      section = L.replace(/\s{2,}/g,' ').trim();
      pendingTitle = null;
      continue;
    }

    const tScore = titleScore(L);
    const dScore = descScore(L);

    // Prefer title if it clearly looks like one
    if (tScore >= 2 && tScore >= dScore) {
      pendingTitle = { name: L, section, price: null, description: '' };
      continue;
    }

    // Description-ish line
    if (dScore >= 1) {
      // If no title yet, try previous line
      if (!pendingTitle && i > 0) {
        const prev = lines[i-1];
        if (!isSectionHeader(prev) && titleScore(prev) >= 1.6) {
          pendingTitle = { name: prev, section, price: null, description: '' };
        }
      }
      if (!pendingTitle) continue;

      // Extract price (if present)
      const m = L.match(PRICE_RE);
      let desc = L;
      let price = pendingTitle.price;
      if (m) {
        price = normalizePriceToken(m[0]);
        desc = L.replace(m[0], '').replace(/\s{2,}/g,' ').trim();
      }
      pendingTitle.description = (pendingTitle.description + ' ' + desc).trim();
      if (price) pendingTitle.price = price;

      // End of dish?
      const next = lines[i+1] || '';
      const endHere =
        !next ||
        isSectionHeader(next) ||
        titleScore(next) >= 2 ||
        PRICE_RE.test(next); // another priced line usually starts a new dish

      if (endHere && pendingTitle.name) {
        dishes.push({
          name: pendingTitle.name.replace(/^[•·\-–—\s]+/,'').trim(),
          price: pendingTitle.price || '',
          description: pendingTitle.description.trim(),
          section: pendingTitle.section
        });
        pendingTitle = null;
      }
      continue;
    }

    // Neither title nor description -> flush if needed
    if (pendingTitle && pendingTitle.name) {
      dishes.push({
        name: pendingTitle.name.replace(/^[•·\-–—\s]+/,'').trim(),
        price: pendingTitle.price || '',
        description: pendingTitle.description.trim(),
        section: pendingTitle.section
      });
      pendingTitle = null;
    }
  }

  // flush at end
  if (pendingTitle && pendingTitle.name) {
    dishes.push({
      name: pendingTitle.name.replace(/^[•·\-–—\s]+/,'').trim(),
      price: pendingTitle.price || '',
      description: pendingTitle.description.trim(),
      section: pendingTitle.section
    });
  }

  return { dishes: dishes.filter(d => d.name && d.name.length >= 2) };
}

// ===== OCR + wiring =====
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  // Preview
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

    // Render bullet list
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
