'use strict';
// File previews, shared by the project Documents and by the GitHub file browser.
// Supported: PDF, Word (.docx), HTML, Excel (.xlsx .xls .csv), PowerPoint (.pptx), images (SVG PNG JPG GIF WebP), text/code.
// Safety: file content is only ever inserted as text (textContent) or inside a sandboxed frame / <img>; never as page HTML.
// Uses the helper h() from app.js (called only after the page has loaded).

const FILE_TYPES = {
  pdf: 'pdf', docx: 'docx', html: 'html', htm: 'html',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', csv: 'sheet',
  pptx: 'slides',
  svg: 'image', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image',
  md: 'text', markdown: 'text', txt: 'text', log: 'text', json: 'text', yml: 'text', yaml: 'text', xml: 'text', ini: 'text', cfg: 'text', conf: 'text',
  toml: 'text', env: 'text', py: 'text', js: 'text', mjs: 'text', ts: 'text', sh: 'text', ps1: 'text', bat: 'text', css: 'text', sql: 'text',
  tf: 'text', j2: 'text', go: 'text', java: 'text', c: 'text', h: 'text', cpp: 'text', cs: 'text', rb: 'text', rs: 'text', tsv: 'text',
};
const IMAGE_MIME = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon' };
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
const SHEET_MAX_ROWS = 1000;
const SHEET_MAX_COLS = 60;
const TEXT_MAX_CHARS = 400000;

const fileExt = (name) => ((String(name).split('.').pop() || '').toLowerCase());
const fileKindOf = (name) => FILE_TYPES[fileExt(name)] || null;
const fmtFileSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

// ----- libraries are loaded the first time they are needed -----
const scriptLoads = {};
function loadScriptOnce(src, isReady, errorText) {
  if (isReady()) return Promise.resolve();
  return (scriptLoads[src] ||= new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok;
    s.onerror = () => { delete scriptLoads[src]; bad(new Error(errorText)); };
    document.head.append(s);
  }));
}
const loadMammoth = () => loadScriptOnce('vendor/mammoth.js', () => !!window.mammoth, 'Could not load the Word viewer (is docs/vendor/mammoth.js uploaded?)');
const loadSheetJs = () => loadScriptOnce('vendor/xlsx.js', () => !!window.XLSX, 'Could not load the Excel viewer (is docs/vendor/xlsx.js uploaded?)');
const loadJsZip = () => loadScriptOnce('vendor/jszip.js', () => !!window.JSZip, 'Could not load the PowerPoint viewer (is docs/vendor/jszip.js uploaded?)');

const SAFE_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: https:; style-src \'unsafe-inline\'; font-src data: https:">';
// HTML files may run their own scripts (tabs, menus), but only in an isolated frame: no access to this site,
// your login, other pages, the network, forms or navigation.
const HTML_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: https:; font-src data: https:; media-src data: https:; connect-src \'none\'; form-action \'none\'">';
const DOC_STYLE = '<style>body{font:15px/1.6 "Segoe UI",system-ui,sans-serif;color:#1b2a3b;background:#fff;max-width:860px;margin:0 auto;padding:24px}' +
  'img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ccd;padding:4px 8px}h1,h2,h3{color:#0d274d}a{color:#0067a0}</style>';

const colName = (i) => { let s = ''; for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s; return s; };

// ----- Excel: tabs for the sheets, plain grid with column letters and row numbers -----
async function previewSheet(name, buffer) {
  await loadSheetJs();
  const wb = window.XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });
  if (!wb.SheetNames.length) throw new Error('This workbook has no sheets');
  const holder = h('div', { class: 'sheet-wrap' });
  const tabs = h('div', { class: 'sheet-tabs' });
  const show = (sheetName) => {
    [...tabs.children].forEach((b) => b.classList.toggle('active', b.dataset.name === sheetName));
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: true });
    const shownRows = rows.slice(0, SHEET_MAX_ROWS);
    const width = Math.min(SHEET_MAX_COLS, shownRows.reduce((m, r) => Math.max(m, r.length), 0));
    const table = h('table', { class: 'sheet-table' },
      h('thead', null, h('tr', null, h('th', { class: 'rn' }, ''), Array.from({ length: width }, (_, c) => h('th', null, colName(c))))),
      h('tbody', null, shownRows.map((r, i) => h('tr', null, h('th', { class: 'rn' }, i + 1), Array.from({ length: width }, (_, c) => h('td', null, r[c] === undefined ? '' : String(r[c])))))));
    holder.replaceChildren(...[table,
      rows.length > SHEET_MAX_ROWS ? h('p', { class: 'muted small' }, `Showing the first ${SHEET_MAX_ROWS} of ${rows.length} rows.`) : null,
      width >= SHEET_MAX_COLS ? h('p', { class: 'muted small' }, `Showing the first ${SHEET_MAX_COLS} columns.`) : null].filter(Boolean));
  };
  wb.SheetNames.forEach((n) => tabs.append(h('button', { class: 'sheet-tab', 'data-name': n, onclick: () => show(n) }, n)));
  show(wb.SheetNames[0]);
  return { el: h('div', { class: 'sheet-view' }, wb.SheetNames.length > 1 ? tabs : null, holder), dispose() {} };
}

// ----- PowerPoint (.pptx): the text, tables and pictures of every slide, in order (not the exact layout) -----
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const kids = (node) => [...node.childNodes].filter((n) => n.nodeType === 1);
const paraText = (p) => [...p.getElementsByTagNameNS(NS_A, 't')].map((t) => t.textContent).join('');

async function previewSlides(name, buffer) {
  await loadJsZip();
  const zip = await window.JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files).map((f) => ({ f, m: f.match(/^ppt\/slides\/slide(\d+)\.xml$/) })).filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  if (!slideFiles.length) throw new Error('No slides found in this file');
  const urls = [];
  const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
  const cards = [];
  for (const { f, m } of slideFiles) {
    const doc = parse(await zip.file(f).async('string'));
    const relsFile = zip.file(`ppt/slides/_rels/slide${m[1]}.xml.rels`);
    const rels = {};
    if (relsFile) parse(await relsFile.async('string')).querySelectorAll('Relationship').forEach((r) => { rels[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const parts = [];
    let title = '';
    const walk = async (node) => {
      for (const n of kids(node)) {
        const ln = n.localName;
        if (ln === 'grpSp') { await walk(n); continue; }
        if (ln === 'sp') {
          const ph = n.getElementsByTagName('p:ph')[0];
          const isTitle = !!ph && /^(title|ctrTitle)$/.test(ph.getAttribute('type') || '');
          const lines = [...n.getElementsByTagNameNS(NS_A, 'p')].map(paraText).filter((t) => t.trim());
          if (isTitle && !title) title = lines.join(' ');
          else if (lines.length) parts.push({ type: 'text', lines });
        } else if (ln === 'pic') {
          const blip = n.getElementsByTagNameNS(NS_A, 'blip')[0];
          const rid = blip && blip.getAttributeNS(NS_R, 'embed');
          const target = rid && rels[rid];
          if (target) {
            const path = 'ppt/' + target.replace(/^\.\.\//, '');
            const file = zip.file(path);
            const ext = fileExt(path);
            if (file && IMAGE_MIME[ext]) {
              const url = URL.createObjectURL(new Blob([await file.async('uint8array')], { type: IMAGE_MIME[ext] }));
              urls.push(url); parts.push({ type: 'img', url });
            } else parts.push({ type: 'note', text: '[picture in a format the browser cannot show]' });
          }
        } else if (ln === 'graphicFrame') {
          const rows = [...n.getElementsByTagNameNS(NS_A, 'tr')].map((tr) => [...tr.getElementsByTagNameNS(NS_A, 'tc')].map((tc) => [...tc.getElementsByTagNameNS(NS_A, 'p')].map(paraText).join(' ')));
          if (rows.length) parts.push({ type: 'table', rows });
        }
      }
    };
    const tree = doc.getElementsByTagName('p:spTree')[0];
    if (tree) await walk(tree);
    cards.push(h('section', { class: 'slide-card' },
      h('div', { class: 'slide-head' }, h('span', { class: 'slide-no' }, 'Slide ' + Number(m[1])), title ? h('b', null, title) : null),
      parts.length ? parts.map((pt) => pt.type === 'text' ? h('div', { class: 'slide-text' }, pt.lines.map((l) => h('p', null, l)))
        : pt.type === 'img' ? h('img', { class: 'slide-img', src: pt.url, alt: 'Picture on slide ' + Number(m[1]) })
        : pt.type === 'table' ? h('table', { class: 'sheet-table' }, h('tbody', null, pt.rows.map((r) => h('tr', null, r.map((c) => h('td', null, c))))))
        : h('p', { class: 'muted small' }, pt.text))
        : (title ? null : h('p', { class: 'muted small' }, '(nothing to show on this slide)'))));
  }
  return { el: h('div', { class: 'slides' },
    h('p', { class: 'muted small' }, 'Text, tables and pictures of each slide. Open the file in PowerPoint for the exact design.'), cards),
    dispose() { urls.forEach((u) => URL.revokeObjectURL(u)); } };
}

// ----- the main entry: bytes in, a node (and a clean-up function) out -----
async function renderPreview(name, buffer) {
  const kind = fileKindOf(name);
  const ext = fileExt(name);
  if (buffer.byteLength > PREVIEW_MAX_BYTES) throw new Error('This file is too large to preview (' + fmtFileSize(buffer.byteLength) + ', limit ' + fmtFileSize(PREVIEW_MAX_BYTES) + ')');
  if (kind === 'pdf') {
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
    return { el: h('iframe', { class: 'docframe', src: url + '#toolbar=0&navpanes=0', title: name }), dispose() { URL.revokeObjectURL(url); } };
  }
  if (kind === 'html') {
    return { el: h('iframe', { class: 'docframe', sandbox: 'allow-scripts', srcdoc: HTML_CSP + new TextDecoder('utf-8').decode(buffer), title: name }), dispose() {} };
  }
  if (kind === 'docx') {
    await loadMammoth();
    const out = await window.mammoth.convertToHtml({ arrayBuffer: buffer });
    return { el: h('iframe', { class: 'docframe', sandbox: '', srcdoc: SAFE_CSP + DOC_STYLE + out.value, title: name }), dispose() {} };
  }
  if (kind === 'sheet') return previewSheet(name, buffer);
  if (kind === 'slides') return previewSlides(name, buffer);
  if (kind === 'image') {
    const url = URL.createObjectURL(new Blob([buffer], { type: IMAGE_MIME[ext] || 'application/octet-stream' }));   // <img> never runs scripts, even for SVG
    return { el: h('div', { class: 'img-view' }, h('img', { src: url, alt: name })), dispose() { URL.revokeObjectURL(url); } };
  }
  if (kind === 'text') {
    let text = new TextDecoder('utf-8').decode(buffer);
    const cut = text.length > TEXT_MAX_CHARS;
    if (cut) text = text.slice(0, TEXT_MAX_CHARS);
    return { el: h('div', { class: 'text-view' }, h('pre', null, text), cut ? h('p', { class: 'muted small' }, 'File shortened: showing the first ' + TEXT_MAX_CHARS.toLocaleString() + ' characters.') : null), dispose() {} };
  }
  throw new Error('No preview for .' + (ext || 'this') + ' files. Supported: PDF, Word (.docx), HTML, Excel, PowerPoint (.pptx), images (including SVG) and text files.');
}
