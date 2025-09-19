// ===== UI refs
const fileInput = document.getElementById('file');
const preview   = document.getElementById('preview');
const wrap      = document.getElementById('previewWrap');
const log       = document.getElementById('log');
const jsonOutEl = document.getElementById('jsonOut');
const debugEl   = document.getElementById('debug');
const progress  = document.getElementById('progress');
const toast     = document.getElementById('toast');
const copyBtn   = document.getElementById('copyJson');
const dlBtn     = document.getElementById('downloadJson');

function showToast(msg){ toast.textContent = msg; toast.classList.add('show'); setTimeout(()=>toast.classList.remove('show'), 1200); }
function clearBoxes(){ [...wrap.querySelectorAll('.hitbox')].forEach(el=>el.remove()); }

// ===== Preprocess (scale + grayscale + mild contrast)
async function preprocess(file, scale=2) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  await new Promise(r => { img.onload = r; img.src = url; });

  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth*scale);
  c.height= Math.round(img.naturalHeight*scale);
  const ctx = c.getContext('2d');
  ctx.drawImage(img,0,0,c.width,c.height);

  const id = ctx.getImageData(0,0,c.width,c.height);
  const d = id.data, contrast=1.15;
  for (let i=0;i<d.length;i+=4){
    const y = 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
    let Y = (y-128)*contrast+128; Y = Math.max(0,Math.min(255,Y));
    d[i]=d[i+1]=d[i+2]=Y;
  }
  ctx.putImageData(id,0,0);
  return { url, img, canvas: c };
}

// ===== Group OCR words into lines (for hitboxes)
function groupWordsIntoLines(words) {
  const items = words
    .filter(w => (w.text||'').trim().length)
    .map(w => ({
      text: w.text.trim(),
      x0:w.bbox.x0,y0:w.bbox.y0,x1:w.bbox.x1,y1:w.bbox.y1,
      cx:(w.bbox.x0+w.bbox.x1)/2, cy:(w.bbox.y0+w.bbox.y1)/2,
      h:(w.bbox.y1-w.bbox.y0)
    }))
    .sort((a,b)=> a.cy-b.cy || a.x0-b.x0);

  const lines=[]; const tol=0.6;
  for (const w of items){
    let placed=false;
    for (const L of lines){
      const sameRow = Math.abs(w.cy-L.cy) <= Math.max(w.h,L.avgH)*tol;
      if (sameRow){
        L.words.push(w);
        L.x0=Math.min(L.x0,w.x0); L.y0=Math.min(L.y0,w.y0);
        L.x1=Math.max(L.x1,w.x1); L.y1=Math.max(L.y1,w.y1);
        L.cy=(L.cy*L.count+w.cy)/(L.count+1);
        L.avgH=(L.avgH*L.count+w.h)/(L.count+1);
        L.count++; placed=true; break;
      }
    }
    if(!placed){ lines.push({words:[w],x0:w.x0,y0:w.y0,x1:w.x1,y1:w.y1,cy:w.cy,avgH:w.h,count:1}); }
  }
  lines.forEach(L=>{ L.words.sort((a,b)=>a.x0-b.x0); L.text=L.words.map(x=>x.text).join(' ').replace(/\s+/g,' ').trim(); });
  return lines.filter(L=>L.text.length>=2).sort((a,b)=> a.y0-b.y0 || a.x0-b.x0);
}

// ===== Text parser (robust across formats)
const SECTION_RE=/\b(APPETIZERS|STARTERS|SMALL PLATES|SALADS|SOUPS|SANDWICHES|MAINS|ENTR[EÉ]ES|PIZZA|PASTA|SIDES|DESSERTS?|DRINKS?|BREAKFAST|LUNCH|DINNER|BURGERS|TACOS|BOWLS|ROLLS|COCKTAILS|BEVERAGES)\b/i;
const PRICE_TOKEN=/\$?\d{1,4}(?:[.,]\d{1,2}|\s\d{2})?|\d{1,4}\s?[-–]\s?\d{1,4}/g;

function normalizePrice(t){
  let s=t.replace(/\s+/g,' ').trim();
  if(/^\d{1,4}\s?[-–]\s?\d{1,4}$/.test(s)) return s.replace('–','-');
  s=s.replace(/^\$/,'').replace(',', '.');
  if(/^\d{1,3}\s\d{2}$/.test(s)) return s.replace(' ', '.');
  if(/^\d{3}$/.test(s)) return s.replace(/(\d{2})(\d)$/, '$1.$2');
  if(/^\d{4}$/.test(s)) return s.replace(/(\d{2})(\d{2})$/, '$1.$2');
  return s;
}
function looksLikePrice(norm){
  if(/^\d{1,3}-\d{1,3}$/.test(norm)){ const [a,b]=norm.split('-').map(Number); return a>=1&&a<=300&&b>=1&&b<=300; }
  if(/^\d{1,3}(?:\.\d{1,2})?$/.test(norm)){ const v=parseFloat(norm); return v>=1&&v<=300; }
  return false;
}
function findPricesInLine(line){
  const out=[]; let m;
  while((m=PRICE_TOKEN.exec(line))!==null){
    const norm=normalizePrice(m[0]);
    if(looksLikePrice(norm)) out.push({raw:m[0], norm, index:m.index});
  }
  return out;
}
function isAllCaps(s){ return s.length>1 && s===s.toUpperCase(); }
function capWordRatio(s){
  const w=s.trim().split(/\s+/).filter(Boolean); if(!w.length) return 0;
  let caps=0; for(const t of w){ if(/^[A-Z][a-z’'&\-]*$/.test(t)||/^[A-Z]{2,}$/.test(t)) caps++; }
  return caps/w.length;
}
function titleScore(line){
  const s=line.trim(); if(!s) return 0;
  const len=s.split(/\s+/).length, hasComma= /,/.test(s), prices=findPricesInLine(s);
  let score=0;
  if(len>=1&&len<=8) score+=1;
  score+=capWordRatio(s)*2;
  if(!hasComma) score+=1;
  if(prices.length) score-=0.6;
  if(/^[a-z]/.test(s)) score-=1.2;       // penalize lowercase-first
  if(capWordRatio(s)<0.3) score-=0.6;    // require some caps
  if(/&|and/i.test(s)) score-=0.2;
  if(/[.:;]$/.test(s)) score-=0.4;
  return score;
}
function descScore(line){
  const s=line.trim(); if(!s) return 0;
  const len=s.split(/\s+/).length, hasComma=/,/.test(s), hasPrice=!!findPricesInLine(s).length;
  let score=0;
  if(len>=3) score+=1;
  if(hasComma) score+=1;
  if(hasPrice) score+=0.8;
  if(/[a-z]/.test(s) && !/[A-Z]{4,}/.test(s)) score+=0.4;
  return score;
}
function isSectionHeader(line){
  const s=line.trim(); if(!s) return false;
  if(SECTION_RE.test(s)) return true;
  if(isAllCaps(s) && s.split(/\s+/).length<=3) return true;
  return false;
}
function detectPriceStyle(lines){
  let onTitle=0,onDesc=0,standalone=0;
  for(const L of lines){
    const prices=findPricesInLine(L); if(!prices.length) continue;
    const t=titleScore(L)>=2.2, d=descScore(L)>=1.2;
    if(t&&!d) onTitle++; else if(d&&!t) onDesc++;
    else if(L.trim().split(/\s+/).length<=3) standalone++; else onDesc++;
  }
  const max=Math.max(onTitle,onDesc,standalone);
  if(max===0) return 'unknown';
  if(max===onTitle) return 'price_on_title';
  if(max===onDesc)  return 'price_on_desc';
  return 'price_standalone';
}
function stripPricesFromTitle(s){
  let out=s; for(const p of findPricesInLine(s)) out=out.replace(p.raw,'');
  return out.replace(/\s*[–—-]\s*$/,'').replace(/\s{2,}/g,' ').trim();
}
function parseMenuFromText(ocrText){
  const lines=ocrText.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const style=detectPriceStyle(lines);
  const dishes=[]; let section=''; let pending=null;
  const push=()=>{ if(pending&&pending.name){ dishes.push({name:pending.name, price:pending.price||'', description:(pending.description||'').trim(), section:pending.section}); pending=null; } };

  for(let i=0;i<lines.length;i++){
    const L=lines[i];
    if(isSectionHeader(L)){ section=L; push(); continue; }
    const t=titleScore(L), d=descScore(L), prices=findPricesInLine(L);

    if(t>=2.2 && t>=d){
      push();
      pending = { name: stripPricesFromTitle(L), section, price:'', description:'' };
      if(prices.length) pending.price = prices[prices.length-1].norm; // rightmost
      continue;
    }

    if(d>=1){
      if(!pending && i>0){
        const prev=lines[i-1];
        if(!isSectionHeader(prev) && titleScore(prev)>=1.8){
          const prevPrices=findPricesInLine(prev);
          pending={ name: stripPricesFromTitle(prev), section, price: prevPrices.length?prevPrices[prevPrices.length-1].norm:'', description:'' };
        }
      }
      if(!pending) continue;

      if(prices.length && !pending.price) pending.price = prices[prices.length-1].norm;
      let desc=L; for(const p of prices) desc=desc.replace(p.raw,'');
      pending.description = (pending.description+' '+desc).replace(/\s{2,}/g,' ').trim();

      const next=lines[i+1]||'';
      const end = !next || isSectionHeader(next) || titleScore(next)>=2.2 || findPricesInLine(next).length;
      if(end) push();
      continue;
    }

    if(pending) push();
  }
  push();
  return { dishes: dishes.filter(d=>d.name && d.name.length>=2), style };
}

// ===== Main flow
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0]; if (!file) return;

  const { url, canvas } = await preprocess(file, 2);
  preview.src = url;
  await new Promise(r => preview.onload ? preview.onload = r : r());

  log.textContent = 'Running OCR…';
  progress.textContent = ''; copyBtn.disabled = true; dlBtn.disabled = true;

  try {
    const { data } = await Tesseract.recognize(canvas, 'eng', {
      logger: m => { if(m.status && typeof m.progress === 'number') progress.textContent = `${m.status} ${(m.progress*100).toFixed(0)}%`; }
    });

    const rawLines = (data?.lines ?? []).map(l => l.text.trim()).filter(Boolean);
    const rawText = rawLines.length ? rawLines.join('\n') : (data?.text ?? '').trim();
    log.textContent = rawText || 'No text detected.';

    // Draw line hitboxes
    clearBoxes();
    const words = data?.words ?? [];
    if (words.length) {
      const dispW = preview.getBoundingClientRect().width;
      const dispH = preview.getBoundingClientRect().height;
      const scaleX = dispW / canvas.width;
      const scaleY = dispH / canvas.height;
      const lineGroups = groupWordsIntoLines(words);

      lineGroups.forEach(L => {
        const x=L.x0*scaleX, y=L.y0*scaleY, w=(L.x1-L.x0)*scaleX, h=(L.y1-L.y0)*scaleY;
        const box = document.createElement('div');
        box.className = 'hitbox';
        box.style.left = `${x}px`; box.style.top = `${y}px`;
        box.style.width = `${w}px`; box.style.height = `${h}px`;
        box.title = L.text;
        box.addEventListener('click', () => showToast(L.text));
        wrap.appendChild(box);
      });
    }

    // Parse into JSON
    const parsed = parseMenuFromText(rawText || '');
    jsonOutEl.textContent = JSON.stringify(parsed, null, 2);
    copyBtn.disabled = false; dlBtn.disabled = false;

    // Debug panel
    const dbg = (rawText||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(s=>{
      const t=titleScore(s).toFixed(2), d=descScore(s).toFixed(2);
      const p=findPricesInLine(s).map(x=>x.norm).join(', ');
      const sec=isSectionHeader(s)?'SECTION':'';
      return `${s}\n  title:${t} desc:${d} prices:[${p}] ${sec}`;
    }).join('\n\n');
    debugEl.textContent = dbg || 'No debug.';

    showToast(`Parsed ${parsed.dishes.length} dishes (style: ${parsed.style})`);
  } catch (err) {
    console.error(err);
    log.textContent = 'OCR error: ' + (err.message || String(err));
  } finally {
    progress.textContent = '';
  }
});

// ===== Copy / Download JSON
copyBtn.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(jsonOutEl.textContent); showToast('JSON copied'); }
  catch { showToast('Copy blocked'); }
});
dlBtn.addEventListener('click', () => {
  const blob = new Blob([jsonOutEl.textContent], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'menu.json';
  a.click();
});
