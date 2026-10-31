'use strict';

const { ipcRenderer } = require('electron');

function readAlphaFromArgv() {
  const hit = process.argv.find((a) => a.startsWith('--vr-alpha='));
  const v = hit ? parseFloat(hit.split('=')[1]) : 0.2;
  return isFinite(v) ? Math.min(0.92, Math.max(0, v)) : 0.2;
}

let veil = readAlphaFromArgv();

function readZoomFromArgv() {
  const hit = process.argv.find((a) => a.startsWith('--vr-zoom='));
  const v = hit ? parseFloat(hit.split('=')[1]) : 1;
  return isFinite(v) && v > 0 ? Math.min(2.4, Math.max(0.5, v)) : 1;
}

let zoomFactor = readZoomFromArgv();

// 页面缩放会连工具条一起放大。工具条是窗口边框，应当保持原尺寸，
// 所以给它一个 1/zoom 的反向缩放，物理高度恒为 30px。
// 这样主进程那边 34px 的悬停判定区就不会错位。
//
// 同时要给 body 补一条等高的顶部留白：工具条悬浮在页面之上，
// 不留白就会压住页面自己的标题和返回按钮。留白量也是物理 30px，
// 所以同样写成 30 / zoomFactor 个 CSS 像素（CSS px 会被 zoom 放大）。
const BAR_HEIGHT = 30;

function applyBarZoom() {
  const de = document.documentElement;
  if (de) {
    de.style.setProperty('--vr-bar-pad', (BAR_HEIGHT / zoomFactor).toFixed(2) + 'px');
  }
  const bar = document.getElementById(BAR_ID);
  if (!bar) return;
  bar.style.setProperty('zoom', String(1 / zoomFactor), 'important');
}

// 工具条是否"常亮"：开启后不再随鼠标淡出，始终完全不透明
function readBarAlwaysFromArgv() {
  const hit = process.argv.find((a) => a.startsWith('--vr-bar-always='));
  return !!(hit && hit.split('=')[1] === '1');
}

let barAlways = readBarAlwaysFromArgv();
let barHover = false;

// 页面比窗口宽出一点点时，会硬撑出一条没用的横向滚动条。
// 只裁剪小溢出（≤48px），真正宽的表格仍然可以横向滚动。
function tidyOverflowX() {
  const de = document.documentElement;
  if (!de) return;
  const over = de.scrollWidth - de.clientWidth;
  de.classList.toggle('vr-clip-x', over > 0 && over <= 48);
}

function paintBarOpacity() {
  const bar = document.getElementById(BAR_ID);
  if (!bar) return;
  bar.style.setProperty('opacity', (barAlways || barHover) ? '1' : BAR_IDLE_OPACITY, 'important');
}

function veilColor() {
  return `rgba(255,255,255,${veil.toFixed(3)})`;
}

// 文字光晕要跟着背景浓度走：
//   浓度低（背景近乎透明）→ 需要一圈紧实的白边，字才不会被底下的深色吃掉
//   浓度高（底已经是白纸）→ 光晕必须收掉，否则字边缘发糊、反而看不清
function shadowFor(v) {
  const a = Math.max(0, Math.min(1, 1 - v / 0.6));
  if (a <= 0.03) return 'none';
  const t = (x) => `rgba(255,255,255,${Math.min(1, x).toFixed(2)})`;
  return [
    `0 0 1px ${t(a)}`,
    `0 0 1px ${t(a)}`,
    `0 0 2.5px ${t(a * 0.92)}`,
    `0 0 6px ${t(a * 0.62)}`
  ].join(', ');
}

function paintRoot() {
  const de = document.documentElement;
  if (!de) return false;
  de.style.setProperty('background-color', veilColor(), 'important');
  de.style.setProperty('color-scheme', 'light', 'important');
  de.style.setProperty('--vr-shadow', shadowFor(veil));
  if (document.body) {
    document.body.style.setProperty('background-color', 'transparent', 'important');
  }
  return !!document.body;
}

// 顶部留白该加在哪一层，取决于页面的滚动结构（详见 styles.js 里的注释）。
//   文档流滚动        → 加在 body（CSS 的 html.vr-pad-body 负责）
//   内部滚动容器      → 加在那个容器上；加在 body 会撑出第二条滚动条
let padEl = null;

function innerScroller() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pts = [[vw / 2, vh / 2], [vw / 2, vh * 0.75], [vw * 0.2, vh * 0.6]];
  for (const pt of pts) {
    let node = document.elementFromPoint(Math.round(pt[0]), Math.round(pt[1]));
    while (node && node !== document.body && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      const scrollable = cs.overflowY === 'auto' || cs.overflowY === 'scroll'
        || cs.overflow === 'auto' || cs.overflow === 'scroll';
      if (scrollable && node.clientHeight >= vh * 0.7 && node.scrollHeight > node.clientHeight + 8) {
        return node;
      }
      node = node.parentElement;
    }
  }
  return null;
}

function decidePad() {
  const de = document.documentElement;
  if (!de) return;
  const sc = innerScroller();

  if (padEl && padEl !== sc) {
    padEl.style.removeProperty('padding-top');
    padEl.style.removeProperty('box-sizing');
    padEl = null;
  }

  if (sc) {
    if (padEl !== sc) {
      sc.style.setProperty('padding-top', 'var(--vr-bar-pad, 30px)', 'important');
      sc.style.setProperty('box-sizing', 'border-box', 'important');
      padEl = sc;
    }
    de.classList.add('vr-pad-inner');
    de.classList.remove('vr-pad-body');
  } else {
    de.classList.add('vr-pad-body');
    de.classList.remove('vr-pad-inner');
  }
}

const BAR_ID = 'vr-toolbar';
const FRAME_ID = 'vr-frame';
const BAR_HOVER_ZONE = 34;   // 与主进程 BAR_HIT_ZONE 保持一致：工具条 30px + 4px 余量
const BAR_IDLE_OPACITY = '0.32';

function buildFrame() {
  if (!document.documentElement) return false;
  if (document.getElementById(FRAME_ID)) return true;

  const frame = document.createElement('div');
  frame.id = FRAME_ID;
  const fs = frame.style;
  fs.setProperty('position', 'fixed', 'important');
  fs.setProperty('inset', '0', 'important');
  fs.setProperty('box-sizing', 'border-box', 'important');
  fs.setProperty('pointer-events', 'none', 'important');
  fs.setProperty('z-index', '2147483646', 'important');
  fs.setProperty('border', '1px solid rgba(0,0,0,0.42)', 'important');
  fs.setProperty('box-shadow', 'inset 0 0 0 1px rgba(255,255,255,0.75), inset 0 0 6px rgba(0,0,0,0.10)', 'important');

  document.documentElement.appendChild(frame);
  return true;
}

function buildToolbar() {
  if (!document.body) return false;
  if (document.getElementById(BAR_ID)) return true;

  const bar = document.createElement('div');
  bar.id = BAR_ID;
  const st = bar.style;
  st.setProperty('position', 'fixed', 'important');
  st.setProperty('top', '0', 'important');
  st.setProperty('left', '0', 'important');
  st.setProperty('right', '0', 'important');
  st.setProperty('height', '30px', 'important');
  st.setProperty('display', 'flex', 'important');
  st.setProperty('align-items', 'center', 'important');
  st.setProperty('box-sizing', 'border-box', 'important');
  st.setProperty('background', 'rgba(255,255,255,0.66)', 'important');
  st.setProperty('border-bottom', '1px solid rgba(0,0,0,0.10)', 'important');
  st.setProperty('z-index', '2147483647', 'important');
  st.setProperty('font-family', '"Microsoft YaHei UI","Segoe UI",sans-serif', 'important');
  st.setProperty('font-size', '12px', 'important');
  st.setProperty('color', '#3a3f47', 'important');
  st.setProperty('opacity', BAR_IDLE_OPACITY, 'important');
  st.setProperty('transition', 'opacity .15s ease', 'important');
  st.setProperty('user-select', 'none', 'important');
  st.setProperty('padding', '0 4px 0 0', 'important');
  st.setProperty('-webkit-app-region', 'drag');
  st.setProperty('cursor', 'move', 'important');

  const handle = document.createElement('div');
  handle.setAttribute('data-vr', 'handle');
  handle.style.flex = 'none';
  handle.style.width = '52px';
  handle.style.height = '100%';
  handle.style.display = 'flex';
  handle.style.alignItems = 'center';
  handle.style.paddingLeft = '10px';
  handle.style.fontSize = '11.5px';
  handle.style.cursor = 'move';
  handle.style.setProperty('-webkit-app-region', 'drag');
  handle.textContent = '阅读层';
  bar.appendChild(handle);

  // 页签条已移除（单窗口模式）：这里原本放标签，现在留出的整段空白
  // 都当作拖动区，工具条比之前更好拖。
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  spacer.style.height = '100%';
  spacer.style.setProperty('-webkit-app-region', 'drag');
  bar.appendChild(spacer);

  const makeBtn = (label, tip, cb) => {
    const b = document.createElement('div');
    b.setAttribute('data-vr', 'btn');
    b.textContent = label;
    b.title = tip;
    const bs = b.style;
    bs.width = '30px';
    bs.height = '22px';
    bs.marginRight = '2px';
    bs.display = 'flex';
    bs.alignItems = 'center';
    bs.justifyContent = 'center';
    bs.borderRadius = '4px';
    bs.cursor = 'default';
    bs.fontSize = '14px';
    bs.lineHeight = '1';
    bs.setProperty('-webkit-app-region', 'no-drag');
    b.addEventListener('mouseenter', () => { bs.background = 'rgba(0,0,0,0.08)'; });
    b.addEventListener('mouseleave', () => { bs.background = 'transparent'; });
    b.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      cb();
    });
    bar.appendChild(b);
    return b;
  };

  const backBtn = makeBtn('‹', '后退（Alt+←）', () => ipcRenderer.send('vr-back'));
  const fwdBtn = makeBtn('›', '前进（Alt+→）', () => ipcRenderer.send('vr-forward'));
  makeBtn('↻', '刷新', () => ipcRenderer.send('vr-reload'));
  makeBtn('⋯', '打开设置面板', () => ipcRenderer.send('vr-panel'));
  makeBtn('—', '收起成小胶囊（Alt+Q）', () => ipcRenderer.send('vr-mini'));
  makeBtn('×', '关闭这个阅读层', () => ipcRenderer.send('vr-close'));

  const syncNav = () => {
    ipcRenderer.invoke('vr-nav-state').then((s) => {
      if (backBtn) backBtn.style.setProperty('opacity', s && s.back ? '1' : '0.3', 'important');
      if (fwdBtn) fwdBtn.style.setProperty('opacity', s && s.forward ? '1' : '0.3', 'important');
    }).catch(() => {});
  };
  syncNav();
  window.addEventListener('load', syncNav);
  let navTicks = 0;
  const navTimer = setInterval(() => {
    syncNav();
    navTicks += 1;
    if (navTicks > 80) clearInterval(navTimer);
  }, 1500);

  document.body.appendChild(bar);

  // 主进程会用系统光标坐标通知"鼠标是否压在工具条上"，
  // 因为 drag 区域收不到网页内的鼠标事件
  const setBarActive = (on) => {
    barHover = !!on;
    paintBarOpacity();
  };
  ipcRenderer.on('vr-bar-hover', (_e, on) => setBarActive(!!on));

  document.addEventListener('mousemove', (e) => {
    setBarActive(e.clientY <= BAR_HOVER_ZONE);
  }, true);

  window.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget && !e.toElement) setBarActive(false);
  }, true);

  // 和浏览器一样：Ctrl + 滚轮缩放页面（Ctrl+0 复位，Ctrl + / - 也行）
  let lastZoomAt = 0;
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - lastZoomAt < 45) return;
    lastZoomAt = now;
    ipcRenderer.send('vr-zoom-step', e.deltaY < 0 ? 1 : -1);
  }, { passive: false, capture: true });

  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      ipcRenderer.send('vr-zoom-step', 1);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      ipcRenderer.send('vr-zoom-step', -1);
    } else if (e.key === '0') {
      e.preventDefault();
      ipcRenderer.send('vr-zoom-reset');
    }
  }, true);

  applyBarZoom();
  paintBarOpacity();
  tidyOverflowX();
  try { ipcRenderer.send('vr-prefs-ask'); } catch (_) {}

  return true;
}

const BLANK_ID = 'vr-blank';

// 页面渲染不出内容时，窗口会变成"全透明但仍挡住鼠标"的幽灵窗。
// 这时必须让用户看得见它在哪、怎么关掉。
function guardBlank() {
  if (!document.body) return;
  if (document.getElementById(BLANK_ID)) return;
  const text = (document.body.innerText || '').trim();
  if (text.length >= 20) return;

  const box = document.createElement('div');
  box.id = BLANK_ID;
  const s = box.style;
  s.setProperty('position', 'fixed', 'important');
  s.setProperty('inset', '0', 'important');
  s.setProperty('display', 'flex', 'important');
  s.setProperty('flex-direction', 'column', 'important');
  s.setProperty('align-items', 'center', 'important');
  s.setProperty('justify-content', 'center', 'important');
  s.setProperty('gap', '8px', 'important');
  s.setProperty('background', 'rgba(255,255,255,0.95)', 'important');
  s.setProperty('color', '#5a616b', 'important');
  s.setProperty('font-family', '"Microsoft YaHei UI","Segoe UI",sans-serif', 'important');
  s.setProperty('font-size', '13px', 'important');
  s.setProperty('line-height', '1.7', 'important');
  s.setProperty('text-align', 'center', 'important');
  s.setProperty('padding', '24px', 'important');
  s.setProperty('box-sizing', 'border-box', 'important');
  s.setProperty('pointer-events', 'none', 'important');
  s.setProperty('z-index', '2147483645', 'important');

  const title = document.createElement('div');
  title.textContent = '这个页面没有加载出内容';
  title.style.setProperty('font-size', '14px', 'important');
  title.style.setProperty('font-weight', '600', 'important');
  title.style.setProperty('color', '#16181d', 'important');

  const line1 = document.createElement('div');
  line1.textContent = '窗口是透明的，容易挡住鼠标却看不见';

  const line2 = document.createElement('div');
  line2.textContent = '点右上角 × 关掉，或点 ⋯ 换一个网址';

  box.appendChild(title);
  box.appendChild(line1);
  box.appendChild(line2);
  document.documentElement.appendChild(box);

  const bar = document.getElementById(BAR_ID);
  if (bar) bar.style.setProperty('opacity', '1', 'important');
}

// 弹窗、登录框、下拉面板原本靠背景色和阴影区分层次。
// 背景被我们统一透明之后，它们会和正文糊在一起（勾选框、输入框更是完全消失）。
// 这里在运行时把真正的浮层标出来，交给 CSS 给它们一张可见的卡片底。
const CARD_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[aria-modal="true"]',
  '[class*="modal"]',
  '[class*="dialog"]',
  '[class*="popup"]',
  '[class*="pop-layer"]',
  '[class*="mask-box"]',
  '[class*="login-box"]',
  '[class*="loginBox"]'
].join(',');

const OWN_IDS = { 'vr-frame': 1, 'vr-toolbar': 1, 'vr-blank': 1 };

function markDialogs() {
  if (!document.body) return;
  let nodes;
  try {
    nodes = document.querySelectorAll(CARD_SELECTOR);
  } catch (e) {
    return;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  for (const el of nodes) {
    if (OWN_IDS[el.id]) continue;
    if (el.hasAttribute('data-vr-card')) continue;

    const r = el.getBoundingClientRect();
    if (r.width < 180 || r.height < 90) continue;

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.opacity === '0') continue;
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;

    // 铺满整屏且几乎没文字的多半是遮罩，不要涂白
    const coversAll = r.width >= vw * 0.94 && r.height >= vh * 0.94;
    const text = (el.innerText || '').trim();
    if (coversAll && text.length < 40) continue;
    if (text.length < 4) continue;

    el.setAttribute('data-vr-card', '1');
  }
}

// 很多站点（含粉笔）的勾选框不是 <input type=checkbox>，而是用元素背景图画的。
// 背景被抹掉之后就成了空白方块，用户根本找不到该点哪儿。
const CHECK_CLASS_HINT = 'checkbox,check-box,checkBox,check_box,radio-box,radioBox';

function markOne(el) {
  if (!el || OWN_IDS[el.id]) return;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.width > 40 || r.height < 8 || r.height > 40) return;
  el.setAttribute('data-vr-check', '1');
}

function markChecks() {
  if (!document.body) return;

  // 1) 类名里带 checkbox / check-box 之类，且尺寸像个小方块
  const byClass = document.querySelectorAll(
    CHECK_CLASS_HINT.split(',').map((c) => '[class*="' + c + '" i]').join(',')
  );
  for (const el of byClass) markOne(el);

  // 2) 兜底：在"我已阅读并同意《…协议》"这类协议行里，找第一个没有文字的小方块
  const lines = document.querySelectorAll('label, div, span, p');
  for (const line of lines) {
    if (line.hasAttribute('data-vr-check')) continue;
    const t = (line.innerText || '').trim();
    if (t.length < 8 || t.length > 90) continue;
    if (t.indexOf('同意') < 0 || t.indexOf('协议') < 0) continue;
    if (line.querySelector('input[type="checkbox"], input[type="radio"]')) continue;

    for (const k of line.querySelectorAll('*')) {
      if ((k.innerText || '').trim()) continue;
      const r = k.getBoundingClientRect();
      if (r.width >= 8 && r.width <= 26 && r.height >= 8 && r.height <= 26) {
        k.setAttribute('data-vr-check', '1');
        break;
      }
    }
  }
}

function scanOverlays() {
  markDialogs();
  markChecks();
}

// ============================================================
// 语义色还原：把被透明化顺手清掉的"状态色"找回来
//
// 透明化的做法是把所有背景刷成透明，连带答题卡上"答对绿 / 答错红 /
// 已答蓝"一起清掉，于是一排题号长得一模一样。
// 颜色本身读不出来（getComputedStyle 已经是被我们改过的值），
// 但样式表里的原始声明还在 —— 同源样式表可以直接读 cssRules。
// 这里把"带明显色相"的规则捡出来，只贴回到小面积元素上：
// 大面积色块不贴，否则整页变成彩色，就失去隐形的意义了。
// ============================================================
const TINT_TTL = 15000;
let tintProbe = null;
let tintTick = 0;

function rgbOf(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s || s === 'none' || s === 'transparent' || s === 'initial' || s === 'inherit') return null;

  if (!tintProbe || !tintProbe.isConnected) {
    tintProbe = document.createElement('div');
    tintProbe.setAttribute('data-vr-tint-probe', '1');
    tintProbe.style.setProperty('display', 'none', 'important');
    (document.body || document.documentElement).appendChild(tintProbe);
  }
  // 注意：必须用 inline !important 写。全局透明规则是 `body * { background-color:
  // transparent !important }`，普通 inline 会被它压掉，读出来的永远是 transparent，
  // 于是所有颜色都解析成 null —— 颜色判定会整体失效（这一步踩过坑）。
  tintProbe.style.removeProperty('background-color');
  tintProbe.style.setProperty('background-color', s, 'important');
  const v = getComputedStyle(tintProbe).backgroundColor;
  const m = v && v.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map((x) => parseFloat(x));
  if (p.length < 3 || !isFinite(p[0])) return null;
  const a = p.length > 3 && isFinite(p[3]) ? p[3] : 1;
  if (a < 0.06) return null;
  return { r: p[0], g: p[1], b: p[2], a };
}

function chroma(c) {
  const hi = Math.max(c.r, c.g, c.b);
  const lo = Math.min(c.r, c.g, c.b);
  return hi <= 0 ? 0 : (hi - lo) / hi;
}

// 背景/边框：有一点色相就算状态色（浅绿底 #e8f5e9 的 chroma 只有 0.053）
function tintedSoft(c) {
  if (!c) return false;
  const hi = Math.max(c.r, c.g, c.b);
  if (hi < 45) return false;          // 近黑：多半是深色遮罩，不要
  return chroma(c) >= 0.045;
}

// 文字：要明显饱和才还原，否则满屏变彩色，反而更花
function tintedText(c) {
  if (!c) return false;
  const hi = Math.max(c.r, c.g, c.b);
  if (hi < 45) return false;
  return chroma(c) >= 0.35;
}

function walkStyleRules(list, out) {
  for (const rule of list) {
    if (rule.cssRules && rule.cssRules.length) {
      try { walkStyleRules(rule.cssRules, out); } catch (_) { /* 跨域子表 */ }
      continue;
    }
    if (!rule.selectorText || !rule.style) continue;
    const sel = rule.selectorText;
    // 伪类/伪元素的结果不是静态状态，跳过
    if (sel.indexOf(':') >= 0) continue;

    const bg = rgbOf(rule.style.backgroundColor) || rgbOf(rule.style.background);
    if (tintedSoft(bg)) out.bg.push({ sel, c: bg });

    const bd = rgbOf(rule.style.borderTopColor) || rgbOf(rule.style.borderColor);
    if (tintedSoft(bd)) out.bd.push({ sel, c: bd });

    const fg = rgbOf(rule.style.color);
    if (tintedText(fg)) out.fg.push({ sel, c: fg });
  }
}

let tintCache = null;
let tintCacheAt = 0;
let tintSheetCount = -1;

function collectTintRules() {
  const now = Date.now();
  let count = 0;
  try { count = document.styleSheets.length; } catch (_) { count = -1; }
  if (tintCache && now - tintCacheAt < TINT_TTL && count === tintSheetCount) return tintCache;

  const out = { bg: [], bd: [], fg: [] };
  try {
    for (const sh of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sh.cssRules; } catch (_) { continue; }  // 跨域样式表读不了
      if (rules) walkStyleRules(rules, out);
    }
  } catch (_) { /* ignore */ }

  tintCache = out;
  tintCacheAt = now;
  tintSheetCount = count;
  return out;
}

// ---------- 状态判定：颜色优先，类名兜底 ----------
// 站点表达"这题对/错/没做"有两种常见手法，颜色比类名可靠得多
// （粉笔这类题库用的是颜色，类名里根本没有 right/wrong 字样）。
// 颜色不能直接读 getComputedStyle —— 那已经是被我们刷透明的值；
// 但样式表里的原始声明还在，用 matches 反查即可。
function hueOf(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const d = hi - lo;
  if (d < 0.02) return -1;
  let h;
  if (hi === r) h = ((g - b) / d) % 6;
  else if (hi === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function verdictOfColor(c) {
  if (!c) return null;
  const h = hueOf(c);
  if (h < 0) return null;
  // 题库用的多是浅底（#e6f4ea 这种），饱和度只有 0.05 上下，
  // 门槛设高了会全部判不出来；灰阶 chroma 接近 0，仍然能排除。
  if (chroma(c) < 0.045) return null;
  if (h >= 325 || h <= 20) return 'wrong';    // 红
  if (h >= 70 && h <= 175) return 'right';    // 绿
  if (h >= 185 && h <= 265) return 'done';    // 蓝
  if (h >= 25 && h <= 62) return 'current';   // 橙黄 = 当前题
  return null;
}

function ruleColorOf(el, list) {
  let hit = null;
  for (const rule of list) {
    let ok = false;
    try { ok = el.matches(rule.sel); } catch (_) { ok = false; }
    if (ok) hit = rule.c;                       // 后面的规则优先，近似 CSS 级联
  }
  return hit;
}

// 我们自己写进格子的颜色不能被当成"站点给的状态色"再判一次，
// 否则会自我强化：未答用的灰字带一点蓝调，下一轮就被读成"蓝色＝已答"。
const OWN_RGB = {};

function ownRGB(key) {
  if (OWN_RGB[key]) return OWN_RGB[key];
  const list = [CELL_BG[key], CELL_FG[key]].map((s) => rgbOf(s) || { r: -1, g: -1, b: -1 });
  OWN_RGB[key] = list;
  return list;
}

function inlineColorOf(el, prop) {
  let raw;
  try { raw = el.style && el.style[prop]; } catch (_) { return null; }
  if (!raw) return null;
  const c = rgbOf(raw);
  if (!c) return null;
  const key = el.getAttribute('data-vr-cell');
  if (key) {
    for (const o of ownRGB(key)) {
      if (o && o.r === c.r && o.g === c.g && o.b === c.b) return null;
    }
  }
  return c;
}

function colorState(el, rules) {
  const nodes = [el].concat(Array.from(el.children).slice(0, 3));
  let current = false;
  for (const node of nodes) {
    const cands = [
      inlineColorOf(node, 'backgroundColor'), ruleColorOf(node, rules.bg),
      inlineColorOf(node, 'borderTopColor'), ruleColorOf(node, rules.bd),
      inlineColorOf(node, 'color'), ruleColorOf(node, rules.fg)
    ];
    for (const c of cands) {
      const v = verdictOfColor(c);
      if (!v) continue;
      if (v === 'current') { current = true; continue; }
      return { verdict: v, current };
    }
  }
  return { verdict: null, current };
}

// ============================================================
// 答题卡状态标识
//
// 题库的答题卡是一组小方块，靠类名表达状态（right/wrong/current…）。
// 透明化之后颜色没了，全变成一样的白框，看不出哪题做过、哪题错了。
// 这里做两件事：
//   1. 用"带对错类名的小方块 ≥4 个、同属一个父容器"找出答题卡；
//   2. 按状态给每格画色：绿=对、红=错、蓝=已答、白灰=未答，黄圈=当前题。
// 不用 border 而用 inset box-shadow 描边，避免把原布局挤变形。
// ============================================================
const VERDICT_WRONG = ['wrong', 'error', 'errors', 'incorrect', 'false', 'fail', 'failed', 'mistake'];
const VERDICT_RIGHT = ['right', 'correct', 'success', 'true', 'answerright', 'rightanswer'];
const DONE_WORDS = ['done', 'finished', 'answered', 'complete', 'completed', 'filled', 'selected', 'reply'];
const CURRENT_WORDS = ['current', 'active', 'now', 'focus', 'highlight'];

function classTokens(el) {
  let raw = '';
  try { raw = el.getAttribute('class') || ''; } catch (_) { return []; }
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean);
}

function readCellState(el, rules) {
  const tk = classTokens(el);
  let raw = '';
  try { raw = el.getAttribute('class') || ''; } catch (_) { /* ignore */ }

  // 类名优先：correct / error 这种是站点的明确语义，比颜色推断可靠
  const hit = (words) => tk.some((t) => words.indexOf(t) >= 0);
  let verdict = null;
  if (hit(VERDICT_WRONG) || /错误|答错|做错/.test(raw)) verdict = 'wrong';
  else if (hit(VERDICT_RIGHT) || /正确|答对|做对/.test(raw)) verdict = 'right';

  const byColor = colorState(el, rules);
  if (!verdict) verdict = byColor.verdict;

  const current = byColor.current || hit(CURRENT_WORDS) || /当前/.test(raw);
  const done = verdict !== null || hit(DONE_WORDS) || /已答|已完成|已做/.test(raw);
  return { verdict, current, done };
}

const CELL_BG = {
  wrong: 'rgba(214,58,73,.20)',
  right: 'rgba(46,160,67,.22)',
  done: 'rgba(11,78,162,.16)',
  todo: 'rgba(255,255,255,.50)'
};
const CELL_RING = {
  wrong: '#d63a49',
  right: '#2ea043',
  done: '#0b4ea2',
  todo: 'rgba(0,0,0,.28)'
};
const CELL_FG = {
  wrong: '#b31527',
  right: '#146c33',
  done: '#0b4ea2',
  todo: '#5a616b'
};

function paintCell(el, st) {
  const key = st.verdict || (st.done ? 'done' : 'todo');
  const s = el.style;
  try {
    s.setProperty('background-color', CELL_BG[key], 'important');
    s.setProperty('box-shadow', `inset 0 0 0 1.5px ${CELL_RING[key]}`, 'important');
    s.setProperty('border-radius', '4px', 'important');
    s.setProperty('color', CELL_FG[key], 'important');
    s.setProperty('text-align', 'center', 'important');
    if (st.current) {
      s.setProperty('outline', '2px solid #ffb000', 'important');
      s.setProperty('outline-offset', '1px', 'important');
    } else {
      s.setProperty('outline', '0', 'important');
      s.setProperty('outline-offset', '0', 'important');
    }
  } catch (_) { return; }
  el.setAttribute('data-vr-cell', key);
  if (st.current) el.setAttribute('data-vr-cur', '1');
  else el.removeAttribute('data-vr-cur');
}

function cellBox(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  if (r.width < 8 || r.height < 8 || r.width > 110 || r.height > 110) return null;
  if (r.width * r.height > window.innerWidth * window.innerHeight * 0.03) return null;
  return r;
}

// 状态触发词：只认"对错"，否则 tab 条、分页器也会被当成答题卡
const CELL_PROBE = [
  '[class*="right" i]', '[class*="wrong" i]', '[class*="correct" i]',
  '[class*="error" i]', '[class*="success" i]', '[class*="正确"]', '[class*="错误"]'
].join(',');

// 答题卡容器缓存：找到一次就记住，别每 1.2 秒全量重找
let cardGrid = null;

// 靠"答题卡"三个字定位：题库的格子类名往往是 answer-item 之类，
// 里面根本没有 right/wrong，只靠类名会一个都找不到。
function gridFromTitle() {
  if (cardGrid && cardGrid.box.isConnected && cardGrid.cells.length >= 6) return cardGrid;

  // 页面里可能有多处"答题卡"（比如底部那个悬浮卡也有这三个字），
  // 所以要挨个试，不能只看第一个。
  const hosts = [];
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue || '';
      if (v.indexOf('答题卡') < 0) continue;
      if (v.trim().length > 6) continue;
      if (n.parentElement) hosts.push(n.parentElement);
      if (hosts.length >= 6) break;
    }
  } catch (_) {
    return null;
  }
  if (!hosts.length) return null;

  for (const host of hosts) {
    let node = host;
    for (let up = 0; up < 5 && node; up++) {
      const root = node.parentElement;
      if (!root) break;
      let best = null;
      let boxes;
      try { boxes = root.querySelectorAll('div, ul, ol'); } catch (_) { break; }
      for (const box of boxes) {
        const kids = box.children;
        if (kids.length < 6 || kids.length > 120) continue;
        const cells = Array.from(kids).filter(cellBox);
        if (cells.length >= 6 && cells.length >= kids.length * 0.8) best = { box, cells };
      }
      if (best) {
        cardGrid = best;
        return best;
      }
      node = root;
    }
  }
  return null;
}

const cellCache = new WeakMap();

// 纯结构识别：一排"只装数字的小方块"。标题可能是伪元素画的（拿不到文本），
// 所以不能只认"答题卡"三个字。
function numberGridCells(box) {
  const kids = box.children;
  if (kids.length < 6 || kids.length > 120) return null;
  const cells = [];
  let h0 = 0;
  for (const k of kids) {
    const r = k.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.width < 12 || r.width > 90 || r.height < 12 || r.height > 90) continue;
    const t = (k.textContent || '').trim();
    if (!/^\d{1,4}$/.test(t)) continue;
    if (h0 && Math.abs(r.height - h0) > 4) continue;   // 高度要一致，才是同一排格子
    h0 = r.height;
    cells.push(k);
  }
  if (cells.length < 6 || cells.length < kids.length * 0.6) return null;
  return cells;
}

// 粉笔这类站点把每个题号做成自定义元素（app-answer-button，36×36），
// 按 5 个一组分块排列 —— 所以"一排 ≥6 个"的判据永远命中不了。
// 真正的状态类名在内层的 <button class="answer-btn correct"> 上，
// 所以要取到按钮这一层，而不是外面的自定义元素。
function gridFromCustomCells() {
  if (cardGrid && cardGrid.box.isConnected && cardGrid.cells.length >= 4) return cardGrid;

  const pick = (sel) => {
    try { return Array.from(document.querySelectorAll(sel)); } catch (_) { return []; }
  };

  let cells = pick('[class*="answer-card" i] .answer-btn');
  if (cells.length < 4) cells = pick('.answer-btn');
  if (cells.length < 4) cells = pick('app-answer-button');
  if (cells.length < 4) cells = pick('.answer-btn-container, [class*="answer-btn" i]');
  if (cells.length < 4) return null;

  let box = null;
  try { box = cells[0].closest('[class*="answer-card" i]'); } catch (_) { box = null; }
  if (!box) box = cells[0].parentElement;
  cardGrid = { box, cells };
  return cardGrid;
}

function gridFromStructure() {
  if (cardGrid && cardGrid.box.isConnected && cardGrid.cells.length >= 6) return cardGrid;
  let best = null;
  let boxes;
  try { boxes = document.querySelectorAll('body div, body ul, body ol'); } catch (_) { return null; }
  for (const box of boxes) {
    const cells = numberGridCells(box);
    if (cells && (!best || cells.length > best.cells.length)) best = { box, cells };
  }
  if (best) cardGrid = best;
  return best;
}

// 找不到答题卡时把页面现状写出来，省得反复猜
// 输出元素的层级结构树（只看标签/类名/尺寸/文本），比 outerHTML 好用得多：
// 答题卡里全是 SVG，outerHTML 截 4000 字符全是 path，看不到格子。
function outlineOf(el, depth, lines) {
  if (depth > 6 || lines.length > 150) return;
  const r = el.getBoundingClientRect();
  const cls = String(el.getAttribute('class') || '').split(/\s+/).filter((c) => c && c.indexOf('ng-') !== 0).slice(0, 3).join('.');
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  lines.push('  '.repeat(depth) + el.tagName.toLowerCase() + (cls ? '.' + cls : '')
    + ' [' + Math.round(r.width) + 'x' + Math.round(r.height) + ']'
    + (t ? ' "' + t + '"' : ''));
  for (const k of el.children) outlineOf(k, depth + 1, lines);
}

// 诊断导出：只在调试时开启（设置环境变量 VR_DUMP=1），
// 用于把页面上真实存在的答题卡结构 dump 成文本，定位识别失败的原因。
function dumpFile() {
  try {
    return require('path').join(require('os').tmpdir(), 'transparent-reader-card-dump.txt');
  } catch (_) {
    return null;
  }
}

let missAt = 0;
function dumpMiss(note) {
  if (!process.env.VR_DUMP) return;
  if (missAt) return;      // 只写一次，别反复写盘
  missAt = 1;
  try {
    const fs = require('fs');
    const text = (document.body && document.body.innerText) || '';
    const cands = [];
    try {
      for (const box of document.querySelectorAll('body div, body ul')) {
        if (box.children.length >= 6 && box.children.length <= 120) {
          const cells = numberGridCells(box);
          if (cells) cands.push(box.tagName + '.' + (box.getAttribute('class') || '') + ' cells=' + cells.length);
        }
      }
    } catch (_) { /* ignore */ }
    const out = [
      'NOTE: ' + note,
      'URL: ' + location.href,
      'HAS_WORD: ' + (text.indexOf('答题卡') >= 0),
      'GRID_CANDIDATES: ' + (cands.length ? cands.slice(0, 8).join(' || ') : '(none)')
    ];

    // 找到"答题卡"这个文本节点，把它所在区域的真实结构抓出来
    let host = null;
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {
        if ((n.nodeValue || '').indexOf('答题卡') >= 0) { host = n.parentElement; break; }
      }
    } catch (_) { /* ignore */ }

    if (host) {
      out.push('HOST: <' + host.tagName.toLowerCase() + ' class="' + (host.getAttribute('class') || '') + '">');
      let up = host;
      for (let i = 0; i < 3 && up.parentElement; i++) up = up.parentElement;
      out.push('REGION_HTML: ' + up.outerHTML.slice(0, 4000));
    } else {
      out.push('HOST: (答题卡文本节点没找到)');
      const boxes = [];
      for (const box of document.querySelectorAll('body div')) {
        const c = box.children.length;
        if (c >= 5 && c <= 60) boxes.push(box.tagName.toLowerCase() + '.' + (box.getAttribute('class') || '') + '#' + c);
      }
      out.push('BOXES_5_60: ' + boxes.slice(0, 25).join(' || '));
    }

    out.push('BODY_TEXT: ' + text.replace(/\s+/g, ' ').slice(0, 400));

    // 把所有 class 带 answer-card / sheet 的元素的层级结构抓出来
    try {
      const els = document.querySelectorAll('[class*="answer-card" i], [class*="answersheet" i], [class*="answer-sheet" i]');
      out.push('CARD_ELS: ' + els.length);
      let shown = 0;
      for (const el of els) {
        if (shown >= 3) break;
        out.push('=== TREE of .' + String(el.getAttribute('class') || '') + ' ===');
        const lines = [];
        outlineOf(el, 0, lines);
        out.push(lines.join('\n'));
        shown += 1;
      }
      const anyCard = document.querySelectorAll('[class*="card" i]').length;
      out.push('ANY_CARD_ELS: ' + anyCard);
    } catch (_) { /* ignore */ }

    const p = dumpFile();
    if (p) fs.writeFileSync(p, out.join('\n'), 'utf8');
  } catch (_) { /* ignore */ }
}

function cellSig(el) {
  let s = (el.getAttribute('class') || '') + '|' + (el.getAttribute('style') || '');
  for (let i = 0; i < el.children.length && i < 3; i++) {
    s += '|' + (el.children[i].getAttribute('class') || '') + ',' + (el.children[i].getAttribute('style') || '');
  }
  return s;
}

// 把答题卡的真实结构导出来。状态到底画在哪儿（背景色？背景图？伪元素？
// 文字颜色？）从截图上永远看不出来，只能看 DOM。
// 写到 userData 目录，结构没变就不重复写。
let dumpSig = '';
let dumpAt = 0;

function dumpCard(grid) {
  if (!process.env.VR_DUMP) return;
  if (!grid || !grid.cells.length) return;
  if (dumpAt) return;         // 只写一次，够看清结构就行
  dumpAt = 1;
  try {
    const fs = require('fs');
    const lines = [];
    lines.push('URL: ' + location.href);
    lines.push('BOX: <' + grid.box.tagName.toLowerCase() + ' class="' + (grid.box.getAttribute('class') || '') + '">');
    lines.push('CELLS: ' + grid.cells.length);
    grid.cells.forEach((c, i) => {
      const cs = getComputedStyle(c);
      const bef = getComputedStyle(c, '::before');
      const aft = getComputedStyle(c, '::after');
      lines.push('---- cell ' + (i + 1) + ' ----');
      lines.push('class="' + (c.getAttribute('class') || '') + '"');
      lines.push('inline="' + (c.getAttribute('style') || '') + '"');
      lines.push('bg=' + cs.backgroundColor + ' | bgimg=' + cs.backgroundImage + ' | color=' + cs.color
        + ' | border=' + cs.borderTopColor + ' | outline=' + cs.outlineColor);
      lines.push('::before content=' + bef.content + ' bg=' + bef.backgroundColor + ' img=' + bef.backgroundImage + ' border=' + bef.borderTopColor);
      lines.push('::after  content=' + aft.content + ' bg=' + aft.backgroundColor + ' img=' + aft.backgroundImage + ' border=' + aft.borderTopColor);
      lines.push('html=' + c.outerHTML.slice(0, 400));
    });
    const p = dumpFile();
    if (p) fs.writeFileSync(p, lines.join('\n'), 'utf8');
  } catch (_) { /* 诊断用，失败不影响阅读 */ }
}

function markAnswerGrid() {
  if (!document.body) return;
  const rules = collectTintRules();

  const grids = new Map();

  // 1) 先认自定义格子（app-answer-button 这种），再退到文字/结构定位
  let byTitle = gridFromCustomCells();
  if (!byTitle) byTitle = gridFromTitle();
  if (!byTitle) byTitle = gridFromStructure();

  if (byTitle) {
    // 保住格子的原始外观：状态很可能画在背景色、背景图或内部 SVG 上，
    // 一味刷透明等于把答案涂掉。CSS 里 [data-vr-raw] 有豁免，
    // 所以要连后代一起标（背景常常挂在内层容器上）。
    for (const c of byTitle.cells) {
      if (!c.hasAttribute('data-vr-raw')) c.setAttribute('data-vr-raw', '1');
      let kids;
      try { kids = c.querySelectorAll('*'); } catch (_) { kids = []; }
      for (const d of kids) {
        if (!d.hasAttribute('data-vr-raw')) d.setAttribute('data-vr-raw', '1');
      }
    }
    dumpCard(byTitle);
    grids.set(byTitle.box, byTitle.cells);
  } else {
    dumpMiss('no answer-card grid found');
  }

  // 2) 按对错类名定位（补充：有的站点在别处也用同一套状态色）
  let probe = [];
  try { probe = document.querySelectorAll(CELL_PROBE); } catch (_) { probe = []; }
  for (const el of probe) {
    if (OWN_IDS[el.id]) continue;
    if (!cellBox(el)) continue;
    let node = el;
    for (let up = 0; up < 4 && node; up++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const kids = Array.from(parent.children);
      if (kids.length >= 4 && kids.length <= 120) {
        const cells = kids.filter(cellBox);
        if (cells.length >= 4 && cells.length >= kids.length * 0.6) {
          if (!grids.has(parent)) grids.set(parent, cells);
          break;
        }
      }
      node = parent;
    }
  }

  let painted = 0;
  for (const cells of grids.values()) {
    if (painted > 400) return;

    const states = cells.map((el) => {
      const sig = cellSig(el);
      const cached = cellCache.get(el);
      if (cached && cached.sig === sig) return cached.st;
      const st = readCellState(el, rules);
      cellCache.set(el, { sig, st });
      return st;
    });

    const hasVerdict = states.some((s) => s.verdict === 'right' || s.verdict === 'wrong');
    const looksLikeCard = hasVerdict || (cells.length >= 6 && states.some((s) => s.done));
    if (!looksLikeCard) continue;

    cells.forEach((el, i) => {
      paintCell(el, states[i]);
      painted += 1;
    });
  }
}

function scanOverlays() {
  markDialogs();
  markChecks();
  markAnswerGrid();
}

function boot() {
  const ok = paintRoot() && buildFrame() && buildToolbar();
  if (ok) {
    scanOverlays();
    decidePad();
  }
  return ok;
}

const timer = setInterval(() => {
  if (boot()) clearInterval(timer);
}, 40);
setTimeout(() => clearInterval(timer), 20000);

document.addEventListener('DOMContentLoaded', boot);
window.addEventListener('load', boot);

setTimeout(guardBlank, 5000);
setTimeout(guardBlank, 12000);

// 弹窗是点击后才出现的，需要持续盯着
// 顺便复查一次横向溢出（SPA 切页面后布局会变）
let tidyTick = 0;
setInterval(() => {
  if (document.hidden) return;
  scanOverlays();
  tidyTick += 1;
  if (tidyTick % 2 === 0) decidePad();      // SPA 换路由后滚动结构会变
  if (tidyTick % 3 === 0) tidyOverflowX();
}, 1200);

window.addEventListener('resize', () => {
  setTimeout(decidePad, 200);
  setTimeout(tidyOverflowX, 150);
});

ipcRenderer.on('vr-alpha', (_e, v) => {
  if (typeof v === 'number' && isFinite(v)) {
    veil = Math.min(0.92, Math.max(0, v));
    paintRoot();
  }
});

ipcRenderer.on('vr-bar-always', (_e, on) => {
  barAlways = !!on;
  paintBarOpacity();
});

ipcRenderer.on('vr-zoom', (_e, z) => {
  if (typeof z === 'number' && isFinite(z) && z > 0) {
    zoomFactor = Math.min(2.4, Math.max(0.5, z));
    applyBarZoom();
    setTimeout(tidyOverflowX, 200);
  }
});

let dragging = false;

window.addEventListener('dragstart', (e) => {
  e.preventDefault();
  e.stopPropagation();
  return false;
}, true);

window.addEventListener('mousedown', (e) => {
  if (e.altKey && e.button === 0 && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    document.documentElement.style.setProperty('user-select', 'none', 'important');
    ipcRenderer.send('vr-drag-start');
  }
}, true);

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  document.documentElement.style.removeProperty('user-select');
  ipcRenderer.send('vr-drag-stop');
}, true);

window.addEventListener('blur', () => {
  if (!dragging) return;
  dragging = false;
  document.documentElement.style.removeProperty('user-select');
  ipcRenderer.send('vr-drag-stop');
});

window.addEventListener('keydown', (e) => {
  // Alt+Q（收起成胶囊）统一由主进程的 before-input-event 处理：
  // 那一层不受页面导航、页面吞键、iframe 抢焦点影响。
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    ipcRenderer.send('vr-back');
    return;
  }
  if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    ipcRenderer.send('vr-forward');
    return;
  }
  if (e.key === 'Escape') {
    if (dragging) {
      dragging = false;
      ipcRenderer.send('vr-drag-stop');
      return;
    }
    e.preventDefault();
    ipcRenderer.send('vr-close');
  }
}, true);
