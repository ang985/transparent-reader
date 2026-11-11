'use strict';

const { ipcRenderer } = require('electron');

function readAlphaFromArgv() {
  const hit = process.argv.find((a) => a.startsWith('--vr-alpha='));
  const v = hit ? parseFloat(hit.split('=')[1]) : 0.2;
  return isFinite(v) ? Math.min(0.92, Math.max(0, v)) : 0.2;
}

let veil = readAlphaFromArgv();

// 蒙版主题：auto = 按页面底色自动判断；light / dark = 面板里手动锁死
function readVeilModeFromArgv() {
  const hit = process.argv.find((a) => a.startsWith('--vr-veil='));
  const v = hit ? hit.split('=')[1] : 'auto';
  return (v === 'light' || v === 'dark') ? v : 'auto';
}

let veilMode = readVeilModeFromArgv();
let veilDark = false;

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
  syncHudZoom();
  const bar = document.getElementById(BAR_ID);
  if (!bar) return;
  bar.style.setProperty('zoom', String(1 / zoomFactor), 'important');
  // 查找条挂在工具条正下方，得用同样的反向缩放，否则页面放大后
  // 它会和工具条之间裂开一条缝（30px 也会被 zoom 放大）
  const find = document.getElementById(FIND_ID);
  if (find) find.style.setProperty('zoom', String(1 / zoomFactor), 'important');
}

// ---------------- 改动数值时的提示条 ----------------
// 为什么需要它：蒙版是"垫在页面后面的一层白"，背后如果正好是白色窗口，
// 18% 和 24% 的差别肉眼几乎为零。用户滚了滚轮、状态确实变了，
// 屏幕却没有任何反馈，只能得出"这个快捷键没实现"的结论。
// 于是每次调浓度/缩放都在工具条下面弹一个一秒就散的小药丸，把数值直接写出来。
const HUD_ID = 'vr-hud';
let hudEl = null;
let hudTimer = 0;

function hudNode() {
  if (hudEl && hudEl.isConnected) return hudEl;
  if (!document.body) return null;
  const el = document.createElement('div');
  el.id = HUD_ID;
  el.setAttribute('data-vr', 'hud');
  const st = el.style;
  st.setProperty('position', 'fixed', 'important');
  st.setProperty('left', '50%', 'important');
  st.setProperty('top', '38px', 'important');
  st.setProperty('transform', 'translateX(-50%)', 'important');
  st.setProperty('z-index', '2147483647', 'important');
  st.setProperty('padding', '5px 13px', 'important');
  st.setProperty('border-radius', '999px', 'important');
  st.setProperty('background', 'rgba(22,24,29,.84)', 'important');
  st.setProperty('color', '#f4f6fa', 'important');
  st.setProperty('font-size', '12.5px', 'important');
  st.setProperty('line-height', '1.35', 'important');
  st.setProperty('font-family', '"Microsoft YaHei UI","Segoe UI",sans-serif', 'important');
  st.setProperty('white-space', 'nowrap', 'important');
  st.setProperty('text-shadow', 'none', 'important');
  st.setProperty('box-shadow', '0 6px 18px rgba(0,0,0,.28)', 'important');
  st.setProperty('pointer-events', 'none', 'important');
  st.setProperty('user-select', 'none', 'important');
  st.setProperty('opacity', '0', 'important');
  st.setProperty('transition', 'opacity .16s ease', 'important');
  document.body.appendChild(el);
  hudEl = el;
  syncHudZoom();
  return el;
}

// 页面缩放会把提示条一起放大；用和工具条同样的反向缩放抵消，
// 顶部偏移也得除掉缩放，否则大倍率下会被推出屏幕
function syncHudZoom() {
  if (!hudEl || !hudEl.isConnected) return;
  hudEl.style.setProperty('zoom', String(1 / zoomFactor), 'important');
  hudEl.style.setProperty('top', (38 / zoomFactor).toFixed(2) + 'px', 'important');
}

function showHud(text) {
  const el = hudNode();
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  syncHudZoom();
  el.style.setProperty('opacity', '1', 'important');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => {
    if (hudEl && hudEl.isConnected) hudEl.style.setProperty('opacity', '0', 'important');
  }, 1100);
}

// ---------------- 滚轮 / 缩放快捷键 ----------------
// 只注册一次：页签切回来、页面重写 body 都不会重复挂。
let wheelBound = false;
function bindWheelShortcuts() {
  if (wheelBound) return;
  wheelBound = true;

  // Ctrl + 滚轮：缩放页面（Ctrl+0 复位，Ctrl + / - 也行）
  // Alt  + 滚轮：直接调背景浓度（上滚更浓、下滚更淡），不用去面板摸滑块
  let lastZoomAt = 0;
  let lastAlphaAt = 0;
  window.addEventListener('wheel', (e) => {
    // deltaY 为 0 的是横向滚动/触控板捏合，方向无意义，别拿它当"向下"
    if (!e.deltaY) return;
    if (e.altKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastAlphaAt < 40) return;
      lastAlphaAt = now;
      ipcRenderer.send('vr-alpha-step', e.deltaY < 0 ? 1 : -1);
      return;
    }
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

// 深色页面需要一个浓度下限。
// 原因：窗口是透明的，页面自己的背景被抹掉了，真正"垫在下面"的是用户身后那个程序。
// 浅色文字一旦遇到浅色底（比如背后是白色编辑器），20%~30% 的深色蒙版根本压不住，
// 字就变成"灰字浮灰底"。60% 是在白色背景下也能稳住对比度的下限。
// 想回到白底黑字，在面板里选「强制浅色」即可。
const DARK_MIN_VEIL = 0.55;

function effectiveVeil() {
  return veilDark ? Math.max(veil, DARK_MIN_VEIL) : veil;
}

function veilColor() {
  // 深色页用近黑蒙版：白色蒙版会让浅色文字彻底糊掉
  const rgb = veilDark ? '18,20,25' : '255,255,255';
  return `rgba(${rgb},${effectiveVeil().toFixed(3)})`;
}

// 文字光晕要跟着背景浓度走：
//   浓度低（背景近乎透明）→ 需要一圈紧实的白边，字才不会被底下的深色吃掉
//   浓度高（底已经是白纸）→ 光晕必须收掉，否则字边缘发糊、反而看不清
// 注意：这里直接用逗号拼 —— 它是写进 CSS 的值，用竖线之类好看的分隔符
// 会让整条 text-shadow 声明变成非法值被浏览器丢弃，
// 于是退回基础表里的白色 fallback，屏幕上就是"亮边糊字"。
function formatShadow(list) {
  return (list || []).map((x) => String(x).trim()).join(', ');
}

function shadowFor(v) {
  const a = Math.max(0, Math.min(1, 1 - v / 0.6));
  if (a <= 0.03) return ['none'];
  // 光晕要和文字反着来：浅色页用白边托黑字，深色页用暗边托亮字
  const rgb = veilDark ? '8,10,14' : '255,255,255';
  const t = (x) => `rgba(${rgb},${Math.min(1, x).toFixed(2)})`;
  if (veilDark) {
    // 深色页要的是"紧实的暗边"，不是柔光。半径一大（原来 6px），
    // 笔画边缘就化成一团，正是用户说的"字发糊"。
    const ring = Math.min(1, 0.34 + a * 1.4);
    return [
      `0 0 1px ${t(ring)}`,
      `0 0 1px ${t(ring)}`,
      `0 0 2px ${t(a * 0.8)}`
    ];
  }
  return [
    `0 0 1px ${t(a)}`,
    `0 0 1px ${t(a)}`,
    `0 0 2.5px ${t(a * 0.92)}`,
    `0 0 6px ${t(a * 0.62)}`
  ];
}

// 蒙版和描边以前写在 <html> 的 inline style 上（背景色 / color-scheme / --vr-shadow）。
// 这很脆：不少站点会整体重写 documentElement 的 class 或 style，一重写就全丢 ——
// 蒙版没了、--vr-shadow 掉了退回基础表里的**白色** fallback，
// 于是屏幕上出现"亮边糊字"，正是用户报的那个现象。
// 改成往 <head> 里放一个自己的 <style>：选择器用 :root（0,1,0）压过基础表的
// html（0,0,1），而且页面脚本删不掉、也不会被 className 改写波及。
function rootStyleEl() {
  const de = document.documentElement;
  if (!de) return null;
  let el = document.getElementById('vr-root');
  if (!el || !el.isConnected) {
    el = document.createElement('style');
    el.id = 'vr-root';
    (document.head || de).appendChild(el);
  }
  return el;
}

function paintRoot() {
  const de = document.documentElement;
  if (!de) return false;
  const el = rootStyleEl();
  if (!el) return false;
  // :not(.vr-probe) —— 探测页面自身底色时先让这条失效，否则读到的永远是我们自己的蒙版
  const css =
    ':root:not(.vr-probe){background-color:' + veilColor() + ' !important;'
    + 'color-scheme:' + (veilDark ? 'dark' : 'light') + ' !important;}'
    + ':root body,:root body *{text-shadow:' + formatShadow(shadowFor(effectiveVeil())) + ' !important;}';
  // 只有内容真的变了才写。哪怕写进去的是一模一样的字符串，Chromium 也会
  // 认定样式表发生变更，对 `:root body *` 这种匹配全页元素的规则做一次全页
  // 样式重算 + 重绘 —— 切页签时那几百毫秒的"渐进上色"就是这么来的。
  if (el.textContent !== css) el.textContent = css;
  if (document.body) {
    document.body.style.setProperty('background-color', 'transparent', 'important');
  }
  return !!document.body;
}

// ---------------- 深色页面识别 ----------------
// 难点：注入的 CSS 把所有背景都刷成了 transparent，页面自己的底色已经读不到了。
// 办法是临时给 <html> 加 .vr-probe —— styles.js 里那条"强制透明"规则写成
// html:not(.vr-probe) ...，一类名消失规则就不生效，于是 getComputedStyle 又能
// 读到页面**原本的**背景色。整个过程是同步的（读到就摘掉），中间不会绘制。

function parseRGB(str) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?/i.exec(str || '');
  if (!m) return null;
  let a = 1;
  if (m[4] != null) a = m[4].indexOf('%') >= 0 ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: +m[1], g: +m[2], b: +m[3], a: isFinite(a) ? a : 1 };
}

function relLum(c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function probePageBg() {
  const de = document.documentElement;
  if (!de || !document.body) return null;
  try {
    // 加 .vr-probe 让 #vr-root 里那条 :root:not(.vr-probe) 失效，
    // body 自己的 inline 透明也要摘掉，否则读到的永远是我们刷的透明
    de.classList.add('vr-probe');
    document.body.style.removeProperty('background-color');
    for (const el of [document.body, de]) {
      const c = parseRGB(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0.2) return c;
    }
    // 很常见的"页面自己没设底色"：退一步看光标附近的大块容器
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pts = [[vw * 0.5, vh * 0.3], [vw * 0.2, vh * 0.7], [vw * 0.8, vh * 0.6]];
    for (const pt of pts) {
      let node = document.elementFromPoint(Math.round(pt[0]), Math.round(pt[1]));
      let guard = 0;
      while (node && node !== de && guard < 6) {
        const c = parseRGB(getComputedStyle(node).backgroundColor);
        if (c && c.a > 0.5) return c;
        node = node.parentElement;
        guard += 1;
      }
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    de.classList.remove('vr-probe');
    document.body.style.setProperty('background-color', 'transparent', 'important');
  }
}

function detectDark() {
  if (veilMode === 'dark') return true;
  if (veilMode === 'light') return false;
  const c = probePageBg();
  if (c) return relLum(c) < 0.42;
  // 读不到底色时退一步看页面声明的配色倾向
  const meta = document.querySelector('meta[name="color-scheme"]');
  const cs = (meta && meta.getAttribute('content')) || '';
  if (/dark/i.test(cs) && !/light/i.test(cs)) return true;
  return false;
}

function reportTheme() {
  try {
    const info = { dark: veilDark, eff: effectiveVeil() };
    if (process.env.VR_DIAG === '1') {
      // 诊断用：把真正生效的阴影、底色、以及"文字被染透明"的元素数一并带出去
      const de = document.documentElement;
      const sample = Array.from(document.querySelectorAll('a,h1,h2,h3,h4,p,span,li,td,strong,b'))
        .slice(0, 1200);
      let hollow = 0;
      let sampleColor = '';
      let sampleShadow = '';
      for (const el of sample) {
        const cs = getComputedStyle(el);
        const fc = cs.webkitTextFillColor || '';
        const m = /rgba?\(([^)]+)\)/.exec(fc);
        const alpha = m ? (m[1].split(',')[3] != null ? parseFloat(m[1].split(',')[3]) : 1) : 1;
        if (alpha < 0.05) hollow += 1;
        if (!sampleColor && el.textContent && el.textContent.trim().length > 2) {
          sampleColor = el.tagName + ' color=' + cs.color + ' fill=' + fc;
          sampleShadow = cs.textShadow;
        }
      }
      info.diag = {
        stat: formatShadow(shadowFor(effectiveVeil())),
        htmlBg: de ? getComputedStyle(de).backgroundColor : '',
        cls: de ? de.className : '',
        mode: veilMode,
        hollow: hollow + '/' + sample.length,
        sample: sampleColor,
        // 下面几项是用来区分"文字淡"到底是哪一层的锅：
        //   bodyColor 还是浅色 → 基础配色表没插进来（或权重输了）
        //   sheets 数量异常     → insertCSS 没成功 / 被导航清掉了
        bodyColor: document.body ? getComputedStyle(document.body).color : '',
        bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : '',
        sheets: document.styleSheets.length,
        sampleShadow: sampleShadow,
      };
    }
    ipcRenderer.send('vr-theme', info);
  } catch (_) { /* ignore */ }
}

// 切换主题只需要重涂根节点：配色那边由主进程插/摘暗色样式表，这里只管蒙版与描边
function applyTheme() {
  if (!document.documentElement) return;
  const want = detectDark();
  if (want === veilDark) {
    // 强制模式下每轮都上报一次，让主进程的 dark/eff 与页面实际状态对齐。
    // 主进程那边有去重，重复上报不会反复插表；这条是兜底：
    // 任何一次漏报都会让"暗色表该摘没摘"，屏幕上就是白蒙版压着近白文字。
    if (veilMode !== 'auto') reportTheme();
    return;
  }
  veilDark = want;
  paintRoot();
  reportTheme();
}

// ---------------- 正文字号 ----------------
// 为什么不去改 body 的 font-size：大量站点用 px 把字号固定写在各自的 CSS 类上，
// 改 body 基准对它们完全无效 —— 只有用 em / rem / % 的后代才会跟着变。
// 所以这里改成"逐元素记基准、按比例写回 inline px"：
//   · 只处理**直接承载文字**的元素，数量与段落数同量级，不是整个 DOM
//   · 基准从 computed 读一次就缓存，拖滑块时只做乘法，不再触发样式计算
//   · 必须写绝对 px —— 写 1.2em 会在嵌套结构里逐层累乘，越深的文字越大
const FONT_MIN = 0.8;
const FONT_MAX = 1.6;

// 自动滚动：px/秒
const SCROLL_MIN = 15;
const SCROLL_MAX = 300;
const SCROLL_DEFAULT = 60;

function readScrollSpeedFromArgv() {
  const hit = process.argv.find((a) => a.startsWith('--vr-scroll-speed='));
  const v = hit ? parseFloat(hit.split('=')[1]) : SCROLL_DEFAULT;
  if (!isFinite(v)) return SCROLL_DEFAULT;
  return Math.min(SCROLL_MAX, Math.max(SCROLL_MIN, v));
}

let scrollSpeed = readScrollSpeedFromArgv();

function readFontFromArgv() {
  const hit = process.argv.find((a) => a.startsWith('--vr-font='));
  const v = hit ? parseFloat(hit.split('=')[1]) : 1;
  if (!isFinite(v)) return 1;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, v));
}

let fontScale = readFontFromArgv();

const fsBase = new WeakMap();     // el -> 未缩放时的 px
const fsInline = new WeakMap();   // el -> 元素原本的 inline font-size（值 + 优先级）
const fsTouched = new WeakSet();  // 被我们改过的元素
const FS_SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION|SVG)$/i;

function hasOwnText(el) {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
  }
  return false;
}

// 回到"我们没碰过"的状态：页面原本有 inline 就写回去，没有才删。
// 直接 removeProperty 会把页面自己的内联字号一起删掉，那属于破坏页面。
function restoreFont(el) {
  const origin = fsInline.get(el);
  if (origin && origin.value) {
    el.style.setProperty('font-size', origin.value, origin.priority);
  } else {
    el.style.removeProperty('font-size');
  }
  fsTouched.delete(el);
}

function applyFontTo(list) {
  const scale = fontScale;
  for (const el of list) {
    if (el.nodeType !== 1 || FS_SKIP.test(el.tagName)) continue;
    if (!hasOwnText(el)) continue;
    if (!fsInline.has(el)) {
      fsInline.set(el, {
        value: el.style.getPropertyValue('font-size'),
        priority: el.style.getPropertyPriority('font-size'),
      });
    }
    if (Math.abs(scale - 1) < 0.005) {
      if (fsTouched.has(el)) restoreFont(el);
      continue;
    }
    let base = fsBase.get(el);
    if (base == null) {
      base = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (!base) continue;
      fsBase.set(el, base);
    }
    el.style.setProperty('font-size', (base * scale).toFixed(2) + 'px', 'important');
    fsTouched.add(el);
  }
}

function applyFontScale() {
  if (!document.body) return 0;
  applyFontTo(document.body.getElementsByTagName('*'));
  return 1;
}

// 页面是 SPA，正文经常是滚动加载出来的。只靠一次性扫描，
// 往下滚两屏之后的文字就还是原字号，看起来像"只生效了一半"。
let fsObserver = null;
let fsSweep = 0;

function watchFontNodes() {
  if (fsObserver || !document.body) return;
  fsObserver = new MutationObserver((muts) => {
    if (Math.abs(fontScale - 1) < 0.005) return;
    const added = [];
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        added.push(n);
        const kids = n.getElementsByTagName ? n.getElementsByTagName('*') : [];
        for (const k of kids) added.push(k);
      }
    }
    if (!added.length) return;
    // 一次 DOM 变动可能带几百个节点，合并到下一帧统一处理
    if (fsSweep) return;
    fsSweep = requestAnimationFrame(() => {
      fsSweep = 0;
      applyFontTo(added);
    });
  });
  fsObserver.observe(document.body, { childList: true, subtree: true });
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
const FIND_ID = 'vr-find';
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

// ---------------- 页面内查找 ----------------
// 真正的匹配交给主进程的 webContents.findInPage（Chromium 原生实现），
// 这里只负责那个小横条：输入、计数、上一个/下一个。
// 之所以不自己遍历 DOM 找文字：原生查找能正确处理跨节点、富文本、Shadow DOM，
// 而且自带"滚动到匹配处 + 高亮"，自己实现这两件事会差很多。
let findBar = null;
let findInput = null;
let findCount = null;
let findOpen = false;
let findTimer = 0;

function buildFindBar() {
  if (!document.documentElement) return;
  if (document.getElementById(FIND_ID)) return;

  const bar = document.createElement('div');
  bar.id = FIND_ID;
  const s = bar.style;
  s.setProperty('position', 'fixed', 'important');
  s.setProperty('top', '30px', 'important');
  s.setProperty('left', '50%', 'important');
  s.setProperty('transform', 'translateX(-50%)', 'important');
  s.setProperty('display', 'none', 'important');
  s.setProperty('align-items', 'center', 'important');
  s.setProperty('gap', '2px', 'important');
  s.setProperty('width', '330px', 'important');
  s.setProperty('height', '32px', 'important');
  s.setProperty('padding', '0 6px', 'important');
  s.setProperty('box-sizing', 'border-box', 'important');
  s.setProperty('background', 'rgba(255,255,255,0.97)', 'important');
  s.setProperty('border', '1px solid rgba(0,0,0,0.18)', 'important');
  s.setProperty('border-top', 'none', 'important');
  s.setProperty('border-radius', '0 0 8px 8px', 'important');
  s.setProperty('box-shadow', '0 6px 18px rgba(0,0,0,0.20)', 'important');
  s.setProperty('z-index', '2147483647', 'important');
  s.setProperty('font-family', '"Microsoft YaHei UI","Segoe UI",sans-serif', 'important');
  s.setProperty('font-size', '12px', 'important');
  s.setProperty('color', '#3a3f47', 'important');
  s.setProperty('user-select', 'none', 'important');

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '在当前页查找…';
  input.spellcheck = false;
  const is = input.style;
  // 显式给宽度而不是只靠 flex:1：这个条挂在页面 body 下，
  // 页面的某些全局规则（max-width、flex 容器重置）会让 flex 子项算出 0 宽，
  // 尺寸为 0 的 input 在 Chromium 里 focus() 会静默失败。
  is.setProperty('flex', '0 0 226px', 'important');
  is.setProperty('width', '226px', 'important');
  is.setProperty('min-width', '0', 'important');
  is.setProperty('height', '22px', 'important');
  is.setProperty('margin', '0 4px', 'important');
  is.setProperty('border', 'none', 'important');
  is.setProperty('outline', 'none', 'important');
  is.setProperty('background', 'transparent', 'important');
  is.setProperty('font-size', '12.5px', 'important');
  is.setProperty('font-family', 'inherit', 'important');
  is.setProperty('color', '#16181d', 'important');
  bar.appendChild(input);

  const count = document.createElement('span');
  count.textContent = '';
  count.style.setProperty('flex', '0 0 auto', 'important');
  count.style.setProperty('min-width', '46px', 'important');
  count.style.setProperty('text-align', 'right', 'important');
  count.style.setProperty('color', '#8b929c', 'important');
  count.style.setProperty('font-size', '11.5px', 'important');
  bar.appendChild(count);

  const mkBtn = (label, tip, cb) => {
    const b = document.createElement('div');
    b.textContent = label;
    b.title = tip;
    const bs = b.style;
    bs.setProperty('width', '22px', 'important');
    bs.setProperty('height', '22px', 'important');
    bs.setProperty('display', 'flex', 'important');
    bs.setProperty('align-items', 'center', 'important');
    bs.setProperty('justify-content', 'center', 'important');
    bs.setProperty('border-radius', '4px', 'important');
    bs.setProperty('cursor', 'default', 'important');
    bs.setProperty('font-size', '14px', 'important');
    bs.setProperty('line-height', '1', 'important');
    b.addEventListener('mouseenter', () => bs.setProperty('background', 'rgba(0,0,0,0.08)', 'important'));
    b.addEventListener('mouseleave', () => bs.setProperty('background', 'transparent', 'important'));
    // 按钮不能把焦点从输入框抢走，否则输一个词就要重新点回输入框
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      cb();
    });
    bar.appendChild(b);
    return b;
  };

  mkBtn('‹', '上一个（Shift+Enter）', () => findStep(false));
  mkBtn('›', '下一个（Enter）', () => findStep(true));
  mkBtn('×', '关闭查找（Esc）', () => closeFind());

  // 挂 body 而不是 documentElement：input 直接作为 <html> 的子节点时，
  // Chromium 不给它正常的光标/焦点语义，focus() 会静默失败（activeElement 仍是 body）。
  document.body.appendChild(bar);

  findBar = bar;
  findInput = input;
  findCount = count;

  input.addEventListener('input', () => {
    const text = input.value;
    clearTimeout(findTimer);
    // 每敲一个字就查一次，长页面会明显卡；180ms 是个不觉得迟、也不浪费的值
    findTimer = setTimeout(() => {
      if (!text) {
        ipcRenderer.send('vr-find-stop');
        count.textContent = '';
        return;
      }
      // findNext 的语义是"开始一次新的查找会话"，所以**关键词变化时**必须是 true；
      // 后面按 Enter 翻到下一个才是 false。用反了会表现为"有计数但按 Enter 不动"。
      ipcRenderer.send('vr-find', { text, findNext: true, forward: true });
    }, 180);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      findStep(!e.shiftKey);
    }
    // Esc 由 window 的捕获监听统一处理，这里不再重复
  });
}

function openFind() {
  if (!findBar) buildFindBar();
  if (!findBar) return;
  findOpen = true;
  findBar.style.setProperty('display', 'flex', 'important');
  // display 刚从 none 变过来时，同一个任务里 focus() 有时不生效（元素还没参与布局）。
  // 用 setTimeout 而不是 requestAnimationFrame：rAF 在窗口不活跃时会被节流，
  // 那时 Ctrl+F 刚打开查找条就会"看得见、打不进字"。
  setTimeout(() => {
    try {
      findInput.focus({ preventScroll: true });
      findInput.select();
    } catch (_) { /* 焦点抢不到不影响后续，Enter 在 window 层兜底 */ }
  }, 30);
}

function closeFind() {
  findOpen = false;
  if (findBar) findBar.style.setProperty('display', 'none', 'important');
  if (findCount) findCount.textContent = '';
  // clearSelection：不留下选中高亮，否则关掉查找后页面还挂着几个选区块
  ipcRenderer.send('vr-find-stop');
  // 焦点还给页面，不然方向键和滚动都失灵
  try { window.focus(); } catch (_) {}
}

function findStep(forward) {
  if (!findInput) return;
  const text = findInput.value;
  if (!text) return;
  // findNext:false = 在同一次查找会话里前进/后退到下一个匹配
  ipcRenderer.send('vr-find', { text, findNext: false, forward: !!forward });
}

ipcRenderer.on('vr-find-open', () => openFind());
ipcRenderer.on('vr-find-result', (_e, r) => {
  if (!findCount || !findOpen) return;
  if (!r || !r.total) {
    findCount.textContent = '无匹配';
    return;
  }
  findCount.textContent = (r.active || 1) + '/' + r.total;
});

// WebContentsView 里 -webkit-app-region:drag 不再传给宿主窗口，
// 所以在专门的拖动区上用已有的 IPC 拖动补回来。绑在元素本身而不是靠
// window 捕获阶段的 e.target 猜测，避免边框/文本节点导致判断落空。
function bindPlainDrag(el) {
  el.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || ev.altKey || ev.ctrlKey || ev.shiftKey) return;
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    document.documentElement.style.setProperty('user-select', 'none', 'important');
    ipcRenderer.send('vr-drag-start');
  });
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
  bindPlainDrag(handle);
  handle.textContent = '阅读层';
  bar.appendChild(handle);

  const tabsWrap = document.createElement('div');
  tabsWrap.id = 'vr-tabs';
  tabsWrap.style.flex = '0 1 auto';
  tabsWrap.style.maxWidth = '56%';
  tabsWrap.style.display = 'flex';
  tabsWrap.style.alignItems = 'center';
  tabsWrap.style.gap = '4px';
  tabsWrap.style.height = '100%';
  tabsWrap.style.overflow = 'hidden';
  tabsWrap.style.setProperty('-webkit-app-region', 'no-drag');
  tabsWrap.style.cursor = 'default';
  bar.appendChild(tabsWrap);

  // 页签右边的空白留作拖动区。
  // 整条 bar 是 drag，页签容器是 no-drag，所以必须留一块 flex:1 的拖动区，
  // 否则把 handle 固定成 52px 之后，整条工具条只剩最左边能拖 —— 老 bug。
  const spacer = document.createElement('div');
  spacer.setAttribute('data-vr', 'spacer');   // 普通拖动的命中区（见下方 mousedown）
  spacer.style.flex = '1';
  spacer.style.height = '100%';
  spacer.style.setProperty('-webkit-app-region', 'drag');
  bindPlainDrag(spacer);
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
  const scrollBtn = makeBtn('⇓', '自动滚动', () => toggleAutoScroll());
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

  // 滚轮/缩放快捷键放到 bindWheelShortcuts() 里统一注册（见文件后半段）：
  // 它们原来长在这个函数里，而工具条一旦被页面的"整体重写 body"清掉，
  // 这个函数会再跑一遍、把监听器**再挂一份**，于是滚一格跳两档。
  bindWheelShortcuts();

  applyBarZoom();
  paintBarOpacity();
  tidyOverflowX();
  try { ipcRenderer.send('vr-prefs-ask'); } catch (_) {}
  // 工具条如果是"第二次 boot 才建起来"的，把缓存的页签列表立刻画出来，
  // 不然要等到下一次主进程广播（切页签/改标题）才会出现。
  if (lastTabsPayload) renderTabs(lastTabsPayload);

  return true;
}

// ============================================================
// 页签条
//
// 每个页签是一个独立的 BrowserWindow，各自跑一份 preload，窗口之间不共享 DOM。
// 所以列表由主进程算好（sendTabs）推给**每个**窗口，这里只负责画。
// 注意 #vr-tabs 在 buildToolbar 里、页面刚加载时可能还不存在（boot 之前就收到
// 消息），renderTabs 里判空直接返回，等 dom-ready 后主进程补发的那几次。
// ============================================================
function renderTabs(payload) {
  const wrap = document.getElementById('vr-tabs');
  if (!wrap) return;
  wrap.textContent = '';

  const list = payload && Array.isArray(payload.list) ? payload.list : [];

  list.slice(0, 8).forEach((t) => {
    const chip = document.createElement('div');
    const s = chip.style;
    s.maxWidth = '110px';
    s.minWidth = '30px';
    s.height = '20px';
    s.display = 'flex';
    s.alignItems = 'center';
    s.padding = '0 3px 0 7px';
    s.borderRadius = '4px';
    s.fontSize = '11.5px';
    s.whiteSpace = 'nowrap';
    s.overflow = 'hidden';
    s.cursor = 'default';
    s.setProperty('-webkit-app-region', 'no-drag');
    if (t.active) {
      s.background = 'rgba(11,78,162,.16)';
      s.color = '#0b4ea2';
      s.fontWeight = '600';
    } else {
      s.background = 'rgba(0,0,0,.07)';
      s.color = '#3a3f47';
    }

    const label = document.createElement('span');
    label.textContent = String(t.title || '').slice(0, 14) || '新页签';
    label.title = t.title || '';
    label.style.flex = '1';
    label.style.overflow = 'hidden';
    label.style.textOverflow = 'ellipsis';
    label.style.whiteSpace = 'nowrap';
    chip.appendChild(label);

    const close = document.createElement('span');
    close.textContent = '×';
    close.title = '关闭这个页签';
    close.style.flex = 'none';
    close.style.fontSize = '12px';
    close.style.lineHeight = '1';
    close.style.padding = '0 2px';
    close.style.opacity = '0.5';
    close.addEventListener('mousedown', (ev) => ev.stopPropagation());
    close.addEventListener('mouseenter', () => { close.style.opacity = '1'; });
    close.addEventListener('mouseleave', () => { close.style.opacity = '0.5'; });
    close.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ipcRenderer.send('vr-tab-close', t.id);
    });
    chip.appendChild(close);

    if (!t.active) {
      chip.addEventListener('mouseenter', () => { s.background = 'rgba(0,0,0,.13)'; });
      chip.addEventListener('mouseleave', () => { s.background = 'rgba(0,0,0,.07)'; });
    }
    chip.addEventListener('mousedown', (ev) => ev.stopPropagation());
    chip.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!t.active) ipcRenderer.send('vr-tab-activate', t.id);
    });

    wrap.appendChild(chip);
  });

  const plus = document.createElement('div');
  plus.textContent = '+';
  plus.title = '打开新页签';
  const ps = plus.style;
  ps.flex = 'none';
  ps.width = '18px';
  ps.height = '18px';
  ps.display = 'flex';
  ps.alignItems = 'center';
  ps.justifyContent = 'center';
  ps.borderRadius = '3px';
  ps.fontSize = '14px';
  ps.lineHeight = '1';
  ps.color = '#3a3f47';
  ps.cursor = 'default';
  ps.setProperty('-webkit-app-region', 'no-drag');
  plus.addEventListener('mousedown', (ev) => ev.stopPropagation());
  plus.addEventListener('mouseenter', () => { ps.background = 'rgba(0,0,0,.10)'; });
  plus.addEventListener('mouseleave', () => { ps.background = 'transparent'; });
  plus.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ipcRenderer.send('vr-tab-new');
  });
  wrap.appendChild(plus);
}

// 缓存最近一次收到的列表：工具条可能是"后建"的（boot 重试），
// 建好后要立刻按缓存画一次，否则会空着等下一次广播。
let lastTabsPayload = null;
let lastTabsKey = '';
ipcRenderer.on('vr-tabs', (_e, payload) => {
  // 主进程会在 0 / 700 / 2000ms 各推一次（防止 preload 还没注册监听时那条丢在
  // 半路），列表其实一模一样。不比对的话每次切页签都要把 DOM 清空重画三遍，
  // 页签条就会"一闪一闪"。这里只在内容真的变了才重建。
  const key = JSON.stringify((payload && payload.list) || []);
  lastTabsPayload = payload;
  if (key === lastTabsKey) return;
  lastTabsKey = key;
  renderTabs(payload);
});

// 自动滚动：长文/刷题时让页面自己往下滚，手动滚一下即暂停。
//
// 滚动目标不是 window 而是"当前真正在滚的容器"：很多站点把正文
// 塞进 overflow:auto 的 div 里，滚 window 是空转。每次起滚前现找，
// 不缓存 —— SPA 换路由后滚动容器会变。
// ============================================================
let scrollAnimId = null;   // 非 null = 正在自动滚动
let scrollScroller = null; // 当前滚动容器（window 或元素）
let scrollLastTs = 0;

function findScroller() {
  // 优先 window：绝大多数页面的滚动发生在 documentElement / body
  const doc = document.scrollingElement || document.documentElement;
  if (doc && doc.scrollHeight > doc.clientHeight + 1) return null; // null 表示滚 window

  // window 滚不动，找内部可滚动的元素：优先找高度占比最大、正在显示的那个
  let best = null;
  let bestArea = 0;
  const all = document.querySelectorAll('div, section, main, article, ul, ol, pre');
  for (const el of all) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowY === 'visible' && cs.overflow === 'visible') continue;
    if (cs.overflowY === 'hidden' || cs.overflow === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.height < 40) continue;
    const area = r.width * r.height;
    if (area > bestArea) { bestArea = area; best = el; }
  }
  return best;
}

function scrollStep(now) {
  if (scrollAnimId === null) return;
  const dt = scrollLastTs ? (now - scrollLastTs) / 1000 : 0;
  scrollLastTs = now;
  if (dt > 0) {
    const scroller = scrollScroller;
    if (scroller) {
      scroller.scrollTop += scrollSpeed * dt;
    } else {
      window.scrollBy(0, scrollSpeed * dt);
    }
  }

  // 到底了：window 或内部容器滚不动就停
  const atBottom = scrollScroller
    ? (scrollScroller.scrollTop + scrollScroller.clientHeight >= scrollScroller.scrollHeight - 1)
    : (window.innerHeight + window.scrollY >= (document.scrollingElement?.scrollHeight ?? 0) - 1);
  if (atBottom) {
    stopAutoScroll();
    return;
  }
  scrollAnimId = requestAnimationFrame(scrollStep);
}

function startAutoScroll() {
  if (scrollAnimId !== null) return;
  scrollScroller = findScroller();
  scrollLastTs = 0;
  scrollAnimId = requestAnimationFrame(scrollStep);
  setScrollBtnActive(true);
}

function stopAutoScroll() {
  if (scrollAnimId === null) return;
  cancelAnimationFrame(scrollAnimId);
  scrollAnimId = null;
  scrollScroller = null;
  setScrollBtnActive(false);
}

function toggleAutoScroll() {
  if (scrollAnimId !== null) stopAutoScroll();
  else startAutoScroll();
}

// 工具条按钮的高亮态（自动滚动中显示为激活色）
let scrollBtnEl = null;
function setScrollBtnActive(on) {
  if (!scrollBtnEl) {
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    // 自动滚动按钮是"刷新"之后、"设置"之前的那个 ⇓
    const btns = bar.querySelectorAll('[data-vr="btn"]');
    scrollBtnEl = btns[3] || null;
  }
  if (scrollBtnEl) {
    // 用 !important 压过 makeBtn 的 hover 态（否则鼠标悬停时会闪回灰色）
    scrollBtnEl.style.setProperty('background', on ? 'rgba(37,99,235,0.16)' : 'transparent', 'important');
    scrollBtnEl.style.setProperty('color', on ? '#2563eb' : '', 'important');
  }
}

// 手动滚动 / 按键 / 触控板一有动作就暂停，别和用户抢控制权
function autoScrollInterrupted() {
  if (scrollAnimId !== null) stopAutoScroll();
}
// 用 capture 才能兜住被滚动容器/iframe 吃掉、不冒泡上来的 wheel
window.addEventListener('wheel', autoScrollInterrupted, { passive: true, capture: true });
window.addEventListener('touchmove', autoScrollInterrupted, { passive: true, capture: true });
window.addEventListener('keydown', (e) => {
  // 方向键 / 空格 / PageUp / PageDown / Home / End 都算用户主动滚动
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
    autoScrollInterrupted();
  }
}, true);

const PASS_BADGE_ID = 'vr-passthrough-badge';

// 穿透状态下鼠标已经穿透给下层了，页面上必须有个显眼的提示，
// 否则用户会以为"窗口卡死了、点不动"。
function showPassBadge() {
  if (!document.body) return;
  let el = document.getElementById(PASS_BADGE_ID);
  if (el) return;
  el = document.createElement('div');
  el.id = PASS_BADGE_ID;
  const s = el.style;
  s.setProperty('position', 'fixed', 'important');
  s.setProperty('top', '36px', 'important');
  s.setProperty('right', '8px', 'important');
  s.setProperty('padding', '3px 8px', 'important');
  s.setProperty('border-radius', '4px', 'important');
  s.setProperty('background', 'rgba(176,42,42,0.92)', 'important');
  s.setProperty('color', '#fff', 'important');
  s.setProperty('font-family', '"Microsoft YaHei UI","Segoe UI",sans-serif', 'important');
  s.setProperty('font-size', '11.5px', 'important');
  s.setProperty('line-height', '1.5', 'important');
  s.setProperty('pointer-events', 'none', 'important');
  s.setProperty('z-index', '2147483647', 'important');
  s.setProperty('box-shadow', '0 2px 8px rgba(0,0,0,.25)', 'important');
  el.textContent = '穿透中 · 按 Alt+T 退出';
  document.documentElement.appendChild(el);
}

function hidePassBadge() {
  const el = document.getElementById(PASS_BADGE_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

ipcRenderer.on('vr-passthrough', (_e, on) => {
  if (on) showPassBadge();
  else hidePassBadge();
});

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
  // 查找条平时是隐藏的，但要在启动时就建好：
  // Ctrl+F 那一刻页面可能正忙，临时创建会慢半拍，输入框还抢不到焦点。
  if (ok) buildFindBar();
  if (ok) {
    applyTheme();
    reportTheme();
  }
  if (ok) {
    scanOverlays();
    decidePad();
    // 字号要在 DOM 就绪后处理；观察器负责后续滚动加载出来的段落
    applyFontScale();
    watchFontNodes();
    // 弹窗/懒加载内容靠 DOM 变动触发重扫，替掉原来的 1.2 秒轮询
    watchDom();
    watchTheme();
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

// 弹窗是点击后才出现的，得盯着 DOM；但不能每 1.2 秒全量扫一遍。
//
// 原来这套挂在 1.2 秒的 setInterval 上，每个 tick 都干四件重活：
//   scanOverlays()   遍历全文档 + getBoundingClientRect（强制布局）
//   decidePad()      elementFromPoint ×3 + 祖先链 getComputedStyle（强制布局）
//   tidyOverflowX()  读 scrollWidth（同步布局）
//   applyTheme()     改 <html> class 再读计算样式（强制布局）
// 在几千个节点的长页面上，这就是每 1.2 秒一次主线程停顿，越滚越涩。
//
// 现在改成事件驱动：
//   - DOM 一有变动就防抖 300ms 重扫一次（懒加载、无限滚动都靠它）
//   - 滚动过程中完全不扫，停下 500ms 后补一次
//   - 20 秒兜底定时器只查 vr-root 还在不在，不触碰任何布局
let rescanTimer = 0;
let scrollStopTimer = 0;
let lastScrollAt = 0;

function isScrolling() {
  return Date.now() - lastScrollAt < 500;
}

// 重活集合：扫描 + 只在结构/尺寸变了时才重算留白与横向溢出
function rescan(withLayout) {
  if (!document.body) return;
  scanOverlays();
  if (withLayout) {
    decidePad();
    tidyOverflowX();
  }
}

// 防抖：一次无限滚动能连着插几十个节点，只在安静下来后扫一次
function scheduleRescan(delay) {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    rescanTimer = 0;
    if (document.hidden) return;
    // 还在滚就先不动，等滚动停下会再排一次
    if (isScrolling()) { scheduleRescan(600); return; }
    rescan(true);
    applyTheme();
    if (!document.getElementById('vr-root')) paintRoot();   // 被页面重渲染清掉就补回来
  }, delay == null ? 300 : delay);
}

// 我们自己注入的节点不能算"页面结构变化"，否则挂一个工具条就自激重扫
const OWN_NODE_IDS = {
  'vr-toolbar': 1, 'vr-find': 1, 'vr-frame': 1,
  'vr-root': 1, 'vr-passthrough-badge': 1, 'vr-blank': 1,
};

function isOwnNode(n) {
  if (!n || n.nodeType !== 1) return false;
  if (OWN_NODE_IDS[n.id]) return true;
  if (n.hasAttribute && n.hasAttribute('data-vr-tint-probe')) return true;
  return false;
}

const domObserver = new MutationObserver((records) => {
  for (const r of records) {
    if (r.type !== 'childList') continue;
    for (const n of r.addedNodes) {
      if (n.nodeType === 1 && !isOwnNode(n)) { scheduleRescan(300); return; }
    }
    for (const n of r.removedNodes) {
      if (n.nodeType === 1 && !isOwnNode(n)) { scheduleRescan(300); return; }
    }
  }
});

function watchDom() {
  // 只盯 body：要标记的弹窗、勾选框、答题卡全在 body 里。
  // 盯 documentElement 会顺带收到 <head> 的变动 —— 定时改 document.title、
  // 第三方脚本插 <style>，都会白白触发一次全量重扫。
  if (!document.body) return;
  domObserver.observe(document.body, { childList: true, subtree: true });
}

// 主题切换通常只改 <html class="dark"> 或 --xxx 变量，不产生 childList 变化。
// 单独盯 documentElement 的 class/style（不设 subtree，范围只有 <html> 自己），
// 防抖 400ms 后再判定一次深浅 —— 替掉原来"每 6 秒复查一次"的做法。
//
// 关键是不能被自己误触发：probePageBg() 会临时加 .vr-probe，
// decidePad() 会加 .vr-pad-body / .vr-pad-inner，都是 <html> 上的 class 变化。
// 若照单全收，就变成"重扫 → 改类 → 又判定主题 → 再探测"的自激循环，
// 每 400ms 一次强制布局，比原来的轮询还糟。
// 所以只比较**去掉 vr- 前缀之后**的类名：我们自己改的类被滤掉，
// 页面真正的 html.dark / html.light 才放行。
function stripVrClass(s) {
  return String(s || '').split(/\s+/)
    .filter((c) => c && !/^vr-/.test(c))
    .join(' ');
}

let themeTimer = 0;

const themeObserver = new MutationObserver((records) => {
  let meaningful = false;
  for (const r of records) {
    if (r.attributeName === 'class') {
      const now = stripVrClass(document.documentElement.className);
      const old = stripVrClass(r.oldValue || '');
      if (now !== old) { meaningful = true; break; }
    } else if (r.attributeName === 'style') {
      // 我们不往 <html> 写 inline style（蒙版写在 <style id="vr-root"> 里），
      // 所以 html 的 style 变化一定来自页面，比如切主题时改 CSS 变量。
      meaningful = true;
      break;
    }
  }
  if (!meaningful) return;
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => {
    if (document.hidden) return;
    applyTheme();
  }, 400);
});

function watchTheme() {
  if (!document.documentElement) return;
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['class', 'style'],
  });
}

// 只记录时间，不做重活。scroll 不冒泡，capture 才收得到元素级滚动。
window.addEventListener('scroll', () => {
  lastScrollAt = Date.now();
  clearTimeout(scrollStopTimer);
  scrollStopTimer = setTimeout(() => {
    // 滚动期间插入的新内容（懒加载）在这里补扫
    scheduleRescan(0);
  }, 500);
}, { passive: true, capture: true });

// 切回前台补一次：hidden 期间的所有重扫都被跳过了
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRescan(200);
});

// 兜底：canvas 重绘、CSS 动画、媒体查询换主题，MutationObserver 都看不见。
// 但它只做一次 getElementById，不触发任何布局计算。
setInterval(() => {
  if (document.hidden) return;
  if (!document.getElementById('vr-root')) paintRoot();
}, 20000);

window.addEventListener('resize', () => {
  setTimeout(decidePad, 200);
  setTimeout(tidyOverflowX, 150);
});

ipcRenderer.on('vr-alpha', (_e, v, fromUser) => {
  if (typeof v !== 'number' || !isFinite(v)) return;
  const next = Math.min(0.92, Math.max(0, v));
  // 切页签时主进程会补发一遍偏好，值通常没变。原来这里无条件 paintRoot
  // + reportTheme，等于每次切换都强制整页重算；值没变就什么都不做。
  if (Math.abs(next - veil) < 1e-6) {
    // 值没变也要给个反馈：比如已经滚到上限，用户不会以为滚轮失灵了
    if (fromUser) showHud('背景浓度 ' + Math.round(effectiveVeil() * 100) + '%（已到头）');
    return;
  }
  veil = next;
  paintRoot();
  // 提示条显示的是**实际生效**的浓度：深色页有 55% 下限，
  // 这时滚轮滚到 10% 屏幕不会变，只有把真实值写出来才不会像"坏了"
  if (fromUser) {
    const eff = effectiveVeil();
    showHud('背景浓度 ' + Math.round(eff * 100) + '%'
      + (eff > veil + 1e-3 ? '（深色页下限）' : ''));
  }
  reportTheme();   // 深色页有下限，实际值可能和滑块不同，要让面板知道
});

ipcRenderer.on('vr-veil-mode', (_e, mode) => {
  const next = (mode === 'light' || mode === 'dark') ? mode : 'auto';
  // 初始值来自 --vr-veil，主题判定由 applyTheme() 在页面就绪/结构变化时做。
  // 收到相同值时不要去动 DOM：detectDark() 会临时加 .vr-probe、读计算样式，
  // 是一次强制同步布局，切页签时的卡顿有它一份。
  if (next === veilMode) return;
  veilMode = next;
  veilDark = detectDark();
  paintRoot();
  // 这里必须上报。主进程靠 vr-theme 决定"插/摘暗色样式表"，
  // 以前只在 veilDark 变化时 paintRoot、且完全不 reportTheme，
  // 于是从"自动/强制深色"切到"强制浅色"时：白蒙版披上了，
  // 暗色配色表还挂着（文字仍是 #e3e6eb 的近白色），
  // 屏幕上就是白底上的浅灰字 —— 用户说的"强制浅色后字变得很淡"。
  reportTheme();
});

ipcRenderer.on('vr-font', (_e, v) => {
  if (typeof v !== 'number' || !isFinite(v)) return;
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, v));
  if (Math.abs(next - fontScale) < 1e-6) return;
  fontScale = next;
  applyFontScale();
  // 字号变了会改变换行和溢出，横向裁剪的判定要重跑一次
  setTimeout(tidyOverflowX, 200);
});

ipcRenderer.on('vr-bar-always', (_e, on) => {
  barAlways = !!on;
  paintBarOpacity();
});

ipcRenderer.on('vr-scroll-speed', (_e, v) => {
  if (typeof v === 'number' && isFinite(v)) {
    scrollSpeed = Math.min(SCROLL_MAX, Math.max(SCROLL_MIN, v));
  }
});

ipcRenderer.on('vr-scroll-toggle', () => toggleAutoScroll());

ipcRenderer.on('vr-zoom', (_e, z, fromUser) => {
  if (typeof z === 'number' && isFinite(z) && z > 0) {
    zoomFactor = Math.min(2.4, Math.max(0.5, z));
    applyBarZoom();
    if (fromUser) showHud('页面缩放 ' + Math.round(zoomFactor * 100) + '%');
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
  // Alt+左键：在页面任意位置都能拖（原有能力，保留）。
  // 工具条拖动区的普通左键拖动由 bindPlainDrag 在元素上直接绑定。
  const altDrag = e.altKey && e.button === 0 && !e.ctrlKey && !e.shiftKey;
  if (altDrag) {
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
  if (e.key === 'Enter') {
    // findInPage 被调用后，Chromium 的查找高亮机制会把焦点从输入框上抢走
    // （实测输入完成约 200ms 后 activeElement 就从 input 掉回 body）。
    // 所以 Enter 不能只挂在 input 的 keydown 上，得在这一层兜底：
    // 只要查找条还开着，Enter / Shift+Enter 就翻到下一个 / 上一个。
    if (findOpen) {
      e.preventDefault();
      e.stopPropagation();
      findStep(!e.shiftKey);
      return;
    }
  }
  if (e.key === 'Escape') {
    // 查找条开着时，Esc 的语义是"关掉查找"，不是"关掉整个阅读层"。
    // 这一层是捕获阶段，比输入框自己的 keydown 更早，所以在这里截住。
    if (findOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
      return;
    }
    if (dragging) {
      dragging = false;
      ipcRenderer.send('vr-drag-stop');
      return;
    }
    e.preventDefault();
    ipcRenderer.send('vr-close');
  }
}, true);
