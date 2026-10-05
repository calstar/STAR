// In-page geometric checks for the Layer X QA scripts (passed to page.evaluate).
export /** In-page: the three geometric checks over `.lx` (or the whole body). */
function geometry(rootSel) {
  const root = document.querySelector(rootSel) ?? document.body;
  const vw = window.innerWidth, vh = window.innerHeight;
  const hidden = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return true;
      if (cs.position === 'absolute' && cs.clip === 'rect(0px, 0px, 0px, 0px)') return true;
      if (e.classList?.contains('sr-only')) return true;
    }
    return false;
  };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== root && parts.length < 4; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      const al = e.getAttribute?.('aria-label');
      if (al) s += `[${al.slice(0, 30)}]`;
      else if (e.classList?.length) s += '.' + [...e.classList].filter((c) => !c.includes('[') && !c.includes(':')).slice(0, 2).join('.');
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  // The visible rect an element is clipped to by its overflow ancestors.
  const visibleBox = (el) => {
    let box = { l: 0, t: 0, r: vw, b: vh };
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/(hidden|auto|scroll|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
        const r = e.getBoundingClientRect();
        box = { l: Math.max(box.l, r.left), t: Math.max(box.t, r.top), r: Math.min(box.r, r.right), b: Math.min(box.b, r.bottom) };
      }
    }
    return box;
  };
  const boxes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? 1 : 2) });
  let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement;
    if (!el || hidden(el) || el.closest('[data-qa-ignore]')) continue;
    const vb = visibleBox(el);
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      const l = Math.max(r.left, vb.l), t = Math.max(r.top, vb.t), rr = Math.min(r.right, vb.r), b = Math.min(r.bottom, vb.b);
      if (rr - l < 2 || b - t < 2) continue;
      boxes.push({ l, t, r: rr, b, el, node: n, text: n.textContent.trim().slice(0, 40) });
    }
  }
  // No occlusion test: the shots are taken at the top of the scroll with no popover open, so
  // nothing opaque sits over the content (sticky tabs and the docked timeline do not overlap it).
  const overlap = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.node === b.node) continue;
      const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (w < 2 || h < 3) continue;
      // Same-line neighbours whose line boxes overlap a hair are fine; require real ink overlap.
      if (w * h < 12) continue;
      const cx = (Math.max(a.l, b.l) + Math.min(a.r, b.r)) / 2, cy = (Math.max(a.t, b.t) + Math.min(a.b, b.b)) / 2;
      overlap.push({ a: a.text, b: b.text, at: [Math.round(cx), Math.round(cy)], w: Math.round(w), h: Math.round(h), pa: path(a.el), pb: path(b.el) });
    }
  }
  // Clipped text: an element whose own text overflows its box with overflow hidden/clip.
  const clipped = [], ellipsis = [];
  for (const el of root.querySelectorAll('*')) {
    if (hidden(el) || el.closest('[data-qa-ignore]')) continue;
    const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) || el.children.length === 0;
    if (!own || !el.textContent.trim()) continue;
    const cs = getComputedStyle(el);
    const ox = cs.overflowX, oy = cs.overflowY;
    const xOver = el.scrollWidth > el.clientWidth + 1 && /(hidden|clip)/.test(ox);
    const yOver = el.scrollHeight > el.clientHeight + 2 && /(hidden|clip)/.test(oy) && cs.display !== 'inline';
    if (!xOver && !yOver) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.width < 1) continue;
    const rec = { text: el.textContent.trim().slice(0, 60), title: el.getAttribute('title') ?? '', at: [Math.round(r.left), Math.round(r.top)], sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight, p: path(el) };
    if (xOver && cs.textOverflow === 'ellipsis') ellipsis.push(rec);
    else clipped.push(rec);
  }
  // Orphaned units: a unit (class lx-unit, or a short unit word in its own element) whose first
  // line is not the line the preceding number ended on.
  const orphan = [];
  const UNIT = /^(psia|psig|psi|bar|bar\(a\)|bar\(g\)|barg|bara|N|kN|lbf|kg|lb|g|s|ms|%|mm|in|K|°C|m|km|ft|kg\/s|g\/s|lb\/s|Hz|m\/s|ft\/s|N·s|kN·s|lbf·s|L|W|kW|MW|MPa|W\/m²|MW\/m²|mm\/s)$/;
  for (const el of root.querySelectorAll('span, small, sub, sup')) {
    const txt = el.textContent.trim();
    if (!(el.classList.contains('lx-unit') || UNIT.test(txt)) || el.children.length) continue;
    if (hidden(el)) continue;
    const prev = el.previousSibling && (el.previousSibling.nodeType === 3 ? el.previousSibling : el.previousElementSibling);
    if (!prev || !prev.textContent.trim() || !/\d/.test(prev.textContent)) continue;
    const pr = document.createRange();
    pr.selectNodeContents(prev);
    const prs = [...pr.getClientRects()].filter((x) => x.width > 0);
    const urs = [...el.getClientRects()].filter((x) => x.width > 0);
    if (!prs.length || !urs.length) continue;
    const last = prs[prs.length - 1], first = urs[0];
    if (Math.abs((first.top + first.bottom) / 2 - (last.top + last.bottom) / 2) > Math.max(6, last.height * 0.6) && first.top >= last.bottom - 2) {
      orphan.push({ num: prev.textContent.trim().slice(-20), unit: txt, at: [Math.round(first.left), Math.round(first.top)], p: path(el) });
    }
  }
  // Also: a text node that wraps right between a number and its unit ("578\npsia").
  const w2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while ((n = w2.nextNode())) {
    const s = n.textContent;
    const m = s.match(/\d[ ](psia|psig|psi|bar|N|kN|lbf|kg|lb|s|ms|mm|in|K|Hz|m|ft|kg\/s|g\/s|%)\b/);
    if (!m || !n.parentElement || hidden(n.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rs = [...range.getClientRects()].filter((x) => x.width > 0);
    if (rs.length < 2) continue;
    // Find the unit's position: measure the char right after the space.
    let idx = s.search(/\d[ ](psia|psig|psi|bar|N|kN|lbf|kg|lb|s|ms|mm|in|K|Hz|m|ft|kg\/s|g\/s|%)\b/);
    while (idx >= 0) {
      const r1 = document.createRange(); r1.setStart(n, idx); r1.setEnd(n, idx + 1);
      const r2 = document.createRange(); r2.setStart(n, idx + 2); r2.setEnd(n, idx + 3);
      const a = r1.getBoundingClientRect(), b = r2.getBoundingClientRect();
      if (a.width && b.width && Math.abs(a.top - b.top) > 4) {
        orphan.push({ num: s.slice(Math.max(0, idx - 8), idx + 1), unit: s.slice(idx + 2, idx + 7), at: [Math.round(b.left), Math.round(b.top)], p: path(n.parentElement), wrap: true });
      }
      const next = s.slice(idx + 1).search(/\d[ ](psia|psig|psi|bar|N|kN|lbf|kg|lb|s|ms|mm|in|K|Hz|m|ft|kg\/s|g\/s|%)\b/);
      idx = next < 0 ? -1 : idx + 1 + next;
    }
  }
  return { overlap, clipped, ellipsis, orphan };
}

