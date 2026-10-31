'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { buildCSS } = require('./styles');

if (process.env.VR_NO_GPU === '1') app.disableHardwareAcceleration();

// 数据目录选取顺序：
//   1. 环境变量 VR_DATA_DIR —— 想固定到某个位置时用
//   2. 旧版本沿用的 E:\Tools\transparent-reader-data —— 本机升级时不丢页签状态
//   3. 系统用户数据目录（Windows 下是 %APPDATA%\transparent-reader）
// 这样别人 clone 下来零配置即可运行，也不会往他的盘上乱建目录。
function resolveDataDir() {
  if (process.env.VR_DATA_DIR) return process.env.VR_DATA_DIR;

  const legacy = 'E:\\Tools\\transparent-reader-data';
  try {
    if (fs.existsSync(path.join(legacy, 'state.json'))) return legacy;
  } catch (_) { /* 没有这个盘符，正常忽略 */ }

  return path.join(app.getPath('appData'), 'transparent-reader');
}

const DATA_DIR = resolveDataDir();
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  app.setPath('userData', DATA_DIR);
} catch (e) {
  console.warn('用户数据目录不可用，回落到默认位置:', e.message);
}

const STATE_FILE = path.join(app.getPath('userData'), 'state.json');

const DEFAULT_STATE = {
  url: '',
  alpha: 0.2,
  hideImages: true,
  focus: true,
  width: 520,
  height: 780,
  x: null,
  y: null,
  history: [],
  tabs: [],        // [{ url, title }]，重启后按顺序恢复
  activeTab: 0,
  onTop: true,     // 是否始终置顶
  lockSize: true,  // 锁定窗口大小：关闭拖边缘缩放的感应区，避免抢滚动条时误拖
  zoom: 1,         // 页面缩放（Ctrl+滚轮），1 = 100%
  barAlways: false, // 顶部工具条是否常亮（不随鼠标淡出）
};

let state = { ...DEFAULT_STATE };
// 单窗口模式（页签功能已移除）：任何时刻最多只有一个阅读层窗口。
// 之前每个页签一个 BrowserWindow，虽然做了"只显示一个"的约束，但焦点、收起、
// 展开三条路径都要各自维护，一漏就叠窗。现在没有第二个窗口，这类 bug 从根上没了。
let overlayWin = null;
let winSeq = 0;               // 窗口代号：异步回调里判断"还是不是当初那个窗口"
let lastActive = null;
let panelWin = null;
let dragTimer = null;
let barTimer = null;
let tray = null;
let saveTimer = null;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.4;
const ZOOM_STEP = 1.1;

const MIN_W = 340;
const MIN_H = 320;

function clamp(v, min, max) {
  v = Number(v);
  if (!isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function log(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'run.log'),
      `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch (_) { /* ignore */ }
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    state = { ...DEFAULT_STATE, ...parsed };
  } catch (e) {
    state = { ...DEFAULT_STATE };
  }
  state.alpha = clamp(state.alpha, 0, 0.92);
  state.zoom = clamp(state.zoom || 1, ZOOM_MIN, ZOOM_MAX);
  state.width = clamp(state.width, MIN_W, 1600);
  state.height = clamp(state.height, MIN_H, 1400);
  if (!Array.isArray(state.history)) state.history = [];
}

function saveState() {
  try {
    // tabs 字段只为兼容旧的 state.json（老版本存过多页签），现在最多一条。
    if (overlayWin && !overlayWin.isDestroyed()) {
      state.tabs = [{ url: overlayWin.__st.url, title: overlayWin.__st.title || '' }];
      state.activeTab = 0;
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log('saveState failed: ' + e.message);
  }
}

function saveStateDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState(), 400);
}

async function applyCSS(win) {
  if (!win || win.isDestroyed()) return;
  const css = buildCSS(win.__st);
  try {
    if (win.__cssKey) {
      try { win.webContents.removeInsertedCSS(win.__cssKey); } catch (_) { /* stale key after navigation */ }
    }
    win.__cssKey = await win.webContents.insertCSS(css);
  } catch (e) {
    log('insertCSS failed: ' + e.message);
  }
}

function overlayBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = state.width;
  const h = state.height;
  let x = state.x;
  let y = state.y;
  if (x == null || y == null) {
    x = wa.x + wa.width - w - 40;
    y = wa.y + 80;
  }
  x = clamp(x, wa.x - w + 80, wa.x + wa.width - 80);
  y = clamp(y, wa.y - h + 80, wa.y + wa.height - 80);
  return { x: Math.round(x), y: Math.round(y), w, h };
}

function createOverlay(rawUrl, opts = {}) {
  let url = String(rawUrl || '').trim();
  if (!url) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  // 已经有阅读层了：直接在它里面跳转，绝不再开第二个窗口。
  // 这是页签功能移除后最关键的一条 —— 从面板、历史记录、页面内链接
  // 打开的网址，永远落在同一个窗口里。
  const existing = currentOverlay();
  if (existing) {
    log('reuse overlay for ' + url.slice(0, 60));
    existing.__st.url = url;
    try {
      existing.loadURL(url).catch((e) => log('loadURL(reuse): ' + e.message));
    } catch (e) {
      log('reuse loadURL failed: ' + e.message);
    }
    state.url = url;
    state.history = [url, ...state.history.filter((u) => u !== url)].slice(0, 20);
    raiseOverlay(existing);
    saveState();
    notifyPanel();
    return existing;
  }

  const b = overlayBounds();

  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.w,
    height: b.h,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: state.lockSize === false,
    movable: true,
    minWidth: MIN_W,
    minHeight: MIN_H,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: state.onTop !== false,
    show: false,
    title: 'Document',
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      additionalArguments: ['--vr-alpha=' + state.alpha, '--vr-zoom=' + (state.zoom || 1), '--vr-bar-always=' + (state.barAlways ? '1' : '0')],
    },
  });

  win.__st = {
    alpha: state.alpha,
    zoom: clamp(state.zoom || 1, ZOOM_MIN, ZOOM_MAX),
    hideImages: state.hideImages,
    focus: state.focus,
    id: ++winSeq,
    title: '',
    url,
  };
  overlayWin = win;

  win.setAlwaysOnTop(state.onTop !== false, state.onTop !== false ? 'screen-saver' : 'normal');
  win.setMenuBarVisibility(false);
  win.setSkipTaskbar(true);

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target || '')) win.loadURL(target).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('dom-ready', () => { applyCSS(win); syncPagePrefs(win); });
  win.webContents.on('did-finish-load', () => { applyCSS(win); syncPagePrefs(win); });
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`load failed ${code} ${desc}`));
  win.webContents.on('context-menu', (e) => e.preventDefault());

  // 渲染进程崩溃时窗口会变成"透明但挡住鼠标"的幽灵窗，必须自动处理
  let crashCount = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    crashCount += 1;
    log('render-process-gone#' + crashCount + ': ' + JSON.stringify(details));
    if (win.isDestroyed()) return;
    if (crashCount >= 2) {
      log('renderer crashed twice, destroying ghost window');
      win.destroy();
      return;
    }
    try { win.reload(); } catch (e) { log('reload after crash failed: ' + e.message); }
  });
  win.webContents.on('unresponsive', () => log('webContents unresponsive'));
  win.webContents.on('responsive', () => log('webContents responsive again'));

  win.webContents.on('page-title-updated', (_e, title) => {
    win.__st.title = String(title || '').trim().slice(0, 40);
    saveStateDebounced();
  });
  win.webContents.on('did-navigate', (_e, u) => {
    win.__st.url = u;
    saveStateDebounced();
  });
  win.webContents.on('did-navigate-in-page', (_e, u) => {
    win.__st.url = u;
    saveStateDebounced();
  });

  win.loadURL(url).catch((e) => log('loadURL: ' + e.message));

  let revealed = false;
  const reveal = () => {
    if (win.isDestroyed()) return;
    if (overlayWin !== win) return;
    // 已经收成胶囊了就不要再把它冒出来 —— 否则收起后 400ms 的主窗兜底
    // 会和胶囊同时出现在屏幕上，这正是之前"两个窗口重叠"的成因之一。
    if (miniWin && !miniWin.isDestroyed()) return;
    if (!revealed) {
      revealed = true;
      // 第一次显示时把窗口和焦点一起拿过来：用户刚点了「打开」，
      // 焦点若留在别的程序上，Alt+Q 会像失灵一样毫无反应。
      raiseOverlay(win);
      return;
    }
    if (!win.isVisible()) win.showInactive();
    applyTop(win);
    win.moveTop();
  };
  win.once('ready-to-show', reveal);
  // 透明窗口不一定会触发 ready-to-show，必须加时间兜底
  setTimeout(reveal, 400);
  setTimeout(reveal, 1600);

  win.on('focus', () => { lastActive = win; });
  win.on('resized', () => {
    if (win.isDestroyed() || overlayWin !== win) return;
    const [w, h] = win.getSize();
    state.width = clamp(w, MIN_W, 1600);
    state.height = clamp(h, MIN_H, 1400);
    saveStateDebounced();
  });
  win.on('moved', () => {
    if (win.isDestroyed() || overlayWin !== win) return;
    const [x, y] = win.getPosition();
    state.x = x;
    state.y = y;
    saveStateDebounced();
  });

  win.on('closed', () => {
    lastClosedKind = 'overlay';
    // 被收起成胶囊的那个窗口关掉了，胶囊也要一起收掉，否则会留个孤儿
    if (miniFor === win) {
      miniFor = null;
      const m = miniWin;
      miniWin = null;
      if (m && !m.isDestroyed()) {
        miniSwapping = true;
        try { m.destroy(); } catch (_) { /* ignore */ }
        miniSwapping = false;
      }
    }
    log('overlay closed #' + (win.__st ? win.__st.id : '?'));
    if (overlayWin === win) overlayWin = null;
    if (lastActive === win) lastActive = null;
    saveState();
    notifyPanel();

    // 从面板打开网址时面板会隐藏让位。这时关掉这个唯一的阅读层，屏幕上就
    // 什么都不剩了（面板窗口对象还在，所以 window-all-closed 也不会触发），
    // 用户会以为程序卡死。这里把面板叫回来。
    if (!quitting) {
      setTimeout(() => {
        if (quitting) return;
        if (!panelWin || panelWin.isDestroyed() || !panelWin.isVisible()) showPanel();
      }, 0);
    }
  });

  // Alt+Q 收起成胶囊。
  // 放在 webContents 的 before-input-event 而不是页面里的 keydown：
  //   1. 页面每次导航 preload 都会重跑一遍，注册时机容易出岔子；
  //   2. 页面自己吞键（stopPropagation / 富文本编辑器）也拦不到这一层；
  //   3. 这一层覆盖所有 frame，iframe 抢走焦点时同样有效。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!input.alt || input.control || input.meta || input.shift) return;
    if (String(input.key || '').toLowerCase() !== 'q') return;
    event.preventDefault();
    toggleMini();
  });

  lastActive = win;
  log('overlay create #' + win.__st.id + ' resizable=' + win.isResizable() + ' ' + url.slice(0, 40));

  state.url = url;
  state.history = [url, ...state.history.filter((u) => u !== url)].slice(0, 20);

  saveState();
  notifyPanel();
  return win;
}

function applyTop(win) {
  if (!win || win.isDestroyed()) return;
  const on = state.onTop !== false;
  try {
    win.setAlwaysOnTop(on, on ? 'screen-saver' : 'normal');
  } catch (_) {}
}


// 把浮层从别的窗口下面"捞"回来。
// 非置顶状态下，单纯 moveTop 有时会被系统压住，所以先临时置顶 1.2 秒再恢复，
// 既能可靠地盖到最前，又不会违背"不始终置顶"的选择。
let raiseTimer = null;

function raiseOverlay(target) {
  const win = (target && !target.isDestroyed()) ? target : currentOverlay();
  if (!win || win.isDestroyed()) return false;

  // 胶囊还开着 = 当前处于「已收起」状态。此时若只把主窗 show 出来，屏幕上会
  // 同时出现主窗和胶囊；而且再按 Alt+Q 会撞上 collapseOverlay 的防重入判断
  // 静默返回（快捷键看起来完全失效）。所以先把状态还原成完整窗口。
  if (miniWin && !miniWin.isDestroyed()) {
    expandOverlay();     // 内部会销毁胶囊并再调一次本函数，那时 miniWin 已置空
    return true;
  }

  try {
    if (!win.isVisible()) win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    // 只 moveTop 是"视觉上在最前"，键盘焦点仍在别的程序上，
    // 于是看着窗口在顶层，按 Alt+Q 却毫无反应。
    // 这里把焦点真正拿过来：app.focus({steal:true}) 用于突破 Windows 的前台锁定。
    try { app.focus({ steal: true }); } catch (_) { /* ignore */ }
    win.focus();
    try { win.webContents.focus(); } catch (_) { /* ignore */ }
  } catch (_) {
    return false;
  }

  clearTimeout(raiseTimer);
  if (state.onTop === false) {
    raiseTimer = setTimeout(() => {
      if (!win.isDestroyed() && state.onTop === false) {
        try {
          win.setAlwaysOnTop(false);
        } catch (_) {}
      }
    }, 1200);
  }
  log('raise overlay #' + (win.__st ? win.__st.id : '?') + ' onTop=' + (state.onTop !== false));
  return true;
}

function currentOverlay() {
  return (overlayWin && !overlayWin.isDestroyed()) ? overlayWin : null;
}

function refresh(win) {
  if (!win || win.isDestroyed()) return;
  applyCSS(win);
  win.webContents.send('vr-alpha', win.__st.alpha);
}

function syncPagePrefs(win) {
  if (!win || win.isDestroyed()) return;
  const z = clamp(win.__st.zoom || 1, ZOOM_MIN, ZOOM_MAX);
  try {
    win.webContents.setZoomFactor(z);
  } catch (_) {}
  // 跳转/刷新后页面是全新的，preload 不知道当前缩放和工具条偏好，
  // 必须补发通知：否则工具条不会按 1/zoom 反向缩放（看着像被放大），
  // 常亮开关也会回退成窗口创建时的旧值。
  try {
    win.webContents.send('vr-zoom', z);
    win.webContents.send('vr-bar-always', !!state.barAlways);
  } catch (_) {}
}

function setZoom(win, z) {
  if (!win || win.isDestroyed()) return;
  const next = clamp(z, ZOOM_MIN, ZOOM_MAX);
  win.__st.zoom = next;
  state.zoom = next;
  try {
    win.webContents.setZoomFactor(next);
  } catch (_) {}
  // 通知页面：工具条按 1/zoom 反向缩放，保持原尺寸不跟着变大
  try {
    win.webContents.send('vr-zoom', next);
  } catch (_) {}
  saveStateDebounced();
}

function setAlpha(win, v) {
  win.__st.alpha = clamp(v, 0, 0.92);
  state.alpha = win.__st.alpha;
  refresh(win);
  saveState();
  notifyPanel();
}

function moveBy(win, dx, dy) {
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
  const [nx, ny] = win.getPosition();
  state.x = nx;
  state.y = ny;
  saveState();
}

function scrollOverlay(win, dy) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.scrollBy({ top: ${dy}, behavior: 'auto' });`).catch(() => {});
}

function toggleVisible() {
  const win = currentOverlay();
  if (!win) return;
  if (win.isVisible()) win.hide();
  else raiseOverlay();   // 走 raise 才顺便把键盘焦点拿回来
}

function panelState() {
  const win = currentOverlay();
  return {
    url: state.url || '',
    history: state.history || [],
    alpha: win ? win.__st.alpha : state.alpha,
    hideImages: win ? win.__st.hideImages : state.hideImages,
    focus: win ? win.__st.focus : state.focus,
    onTop: state.onTop !== false,
    lockSize: state.lockSize !== false,
    barAlways: !!state.barAlways,
    hasOverlay: !!win,
  };
}

function notifyPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('vr-state', panelState());
  }
}

function createTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, 'icon.ico');
    let img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) {
      img = nativeImage.createEmpty();
    } else {
      img = img.resize({ width: 16, height: 16 });
    }
    tray = new Tray(img);
  } catch (e) {
    log('tray create failed: ' + e.message);
    return;
  }

  tray.setToolTip('悬浮阅读层 · 单击唤到最前，右键菜单');

  const rebuild = () => {
    if (!tray || tray.isDestroyed()) return;
    const has = !!currentOverlay();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开面板', click: () => showPanel() },
      { label: '隐藏 / 显示浮层', enabled: has, click: () => toggleVisible() },
      { label: miniWin ? '展开阅读层' : '收起为小胶囊（Alt+Q）', enabled: has || !!miniWin, click: () => { if (miniWin) expandOverlay(); else collapseOverlay(); } },
      { label: '把浮层提到最前', enabled: has, click: () => raiseOverlay() },
      { label: state.onTop !== false ? '取消置顶（可被其它窗口盖住）' : '恢复置顶', enabled: has, click: () => {
        state.onTop = state.onTop === false;
        const w = currentOverlay();
        if (w) applyTop(w);
        saveState();
        notifyPanel();
      } },
      { type: 'separator' },
      { label: '关闭浮层', enabled: has, click: () => { const w = currentOverlay(); if (w) w.close(); } },
      { type: 'separator' },
      { label: '退出', click: () => { app.quit(); } },
    ]));
  };

  tray.on('right-click', rebuild);
  tray.on('click', () => {
    if (!raiseOverlay()) showPanel();
  });
  tray.on('double-click', () => showPanel());
  rebuild();
}

function showPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    notifyPanel();
    return;
  }

  panelWin = new BrowserWindow({
    width: 500,
    height: 765,
    frame: false,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: '悬浮阅读层',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload-panel.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  panelWin.setMenuBarVisibility(false);
  panelWin.loadFile(path.join(__dirname, 'panel.html'));
  panelWin.once('ready-to-show', () => { if (panelWin && !panelWin.isDestroyed()) { panelWin.focus(); panelWin.moveTop(); } });
  panelWin.on('closed', () => { panelWin = null; lastClosedKind = 'panel'; });
}

ipcMain.handle('vr-open', (_e, url) => {
  if (!String(url || '').trim()) return { ok: false, error: '网址不能为空' };
  const win = createOverlay(url);
  if (!win) return { ok: false, error: '打开失败' };
  if (panelWin && !panelWin.isDestroyed()) panelWin.hide();
  return { ok: true };
});

ipcMain.handle('vr-state', () => panelState());

ipcMain.handle('vr-history-drop', (_e, target) => {
  const u = String(target || '');
  state.history = (state.history || []).filter((x) => x !== u);
  saveState();
  notifyPanel();
  return panelState();
});

ipcMain.handle('vr-history-clear', () => {
  state.history = [];
  saveState();
  notifyPanel();
  return panelState();
});

ipcMain.handle('vr-alpha-all', (_e, v) => {
  const win = currentOverlay();
  if (win) setAlpha(win, v);
  return { ok: true };
});

ipcMain.handle('vr-opt', (_e, key, val) => {
  const win = currentOverlay();
  if (key === 'onTop') {
    state.onTop = !!val;
    if (win) {
      applyTop(win);
      if (state.onTop) win.moveTop();
    }
    saveState();
    notifyPanel();
    return { ok: true };
  }
  if (key === 'barAlways') {
    state.barAlways = !!val;
    if (win) {
      win.__barHover = null;   // 关掉常亮后重新按光标判断
      try { win.webContents.send('vr-bar-always', state.barAlways); } catch (_) {}
    }
    saveState();
    notifyPanel();
    return { ok: true };
  }
  if (key === 'lockSize') {
    state.lockSize = !!val;
    if (win) {
      try {
        win.setResizable(!state.lockSize);
      } catch (_) {}
    }
    log('lockSize=' + state.lockSize + ' applied to ' + (win ? 1 : 0) + ' window(s)');
    saveState();
    notifyPanel();
    return { ok: true };
  }
  if (key === 'hideImages' || key === 'focus') {
    state[key] = !!val;
    if (win) {
      win.__st[key] = !!val;
      refresh(win);
    }
    saveState();
    notifyPanel();
  }
  return { ok: true };
});

ipcMain.handle('vr-close-all', () => {
  const win = currentOverlay();
  if (win) win.close();
  return { ok: true };
});

ipcMain.handle('vr-raise', () => ({ ok: raiseOverlay() }));

// ---------------- 收起成小胶囊 ----------------
// 悬浮层不适合"最小化到任务栏"（那会把自己暴露在任务栏里）。
// 收起时用一个 244×34 的小胶囊窗口顶替它，点"展开"就回来。
let miniWin = null;
let miniFor = null;
let miniBounds = null;
let miniSwapping = false;

const MINI_W = 244;
const MINI_H = 34;

function makeMiniWindow(onReveal) {
  const at = miniBounds || { x: 120, y: 120 };
  // 原窗口贴着屏幕边时，胶囊可能被挤到屏幕外，收进工作区里
  let px = at.x;
  let py = at.y;
  try {
    const area = screen.getDisplayMatching(at).workArea;
    px = Math.min(Math.max(area.x, at.x), area.x + area.width - MINI_W);
    py = Math.min(Math.max(area.y, at.y), area.y + area.height - MINI_H);
  } catch (_) { /* ignore */ }
  const m = new BrowserWindow({
    width: MINI_W,
    height: MINI_H,
    x: px,
    y: py,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: state.onTop !== false,
    show: false,
    title: '阅读层',
    webPreferences: {
      preload: path.join(__dirname, 'preload-mini.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  m.setMenuBarVisibility(false);
  if (state.onTop !== false) m.setAlwaysOnTop(true, 'screen-saver');
  m.loadFile(path.join(__dirname, 'mini.html'));
  // 收起后要把焦点交给胶囊，否则键盘事件还落在已经隐藏的主窗上，
  // 用户在胶囊上再按 Alt+Q 是收不到的。
  // 注意用 show() 而不是 showInactive()：这里是从自己窗口收起来的，
  // 前台程序没变，不存在"从别的软件那里抢焦点"的问题。
  const reveal = () => {
    if (m.isDestroyed()) return;
    m.show();
    m.focus();
    try { m.webContents.focus(); } catch (_) { /* ignore */ }
    if (typeof onReveal === 'function') {
      try { onReveal(); } catch (_) { /* ignore */ }
    }
  };
  m.once('ready-to-show', reveal);
  // 无条件兜底：透明窗口不一定触发 ready-to-show。原来这里带 !m.isVisible() 判断，
  // 一旦胶囊已经可见而 reveal 因故没跑，主窗就永远不会被隐藏，于是胶囊和主窗叠在一起。
  setTimeout(() => { if (!m.isDestroyed()) reveal(); }, 400);

  m.on('closed', () => {
    if (miniWin === m) miniWin = null;
    // 胶囊被意外关掉（例如 Alt+F4）时把阅读层还回来，别让用户找不到
    if (!miniSwapping && miniFor) expandOverlay();
  });
  return m;
}

function toggleMini() {
  if (miniWin && !miniWin.isDestroyed()) {
    log('toggle mini -> expand');
    expandOverlay();
  } else {
    log('toggle mini -> collapse');
    collapseOverlay();
  }
  return { ok: true };
}

function collapseOverlay() {
  const win = currentOverlay();
  if (!win || win.isDestroyed()) return { ok: false };
  if (miniWin && !miniWin.isDestroyed()) return { ok: true };

  miniFor = win;
  miniBounds = win.getBounds();
  // 先把胶囊造出来再隐藏主窗：否则这一瞬间没有任何窗口，
  // 会触发 window-all-closed 把程序退掉。
  // 胶囊显示并拿到焦点之后，再把主窗藏起来 —— 焦点是无缝转移的，
  // 中间不会出现"焦点跑到别的程序上又被抢回来"的闪动。
  // 单窗口模式下只需要藏这一个窗口，不会有"漏掉某个页签窗口"的问题。
  miniWin = makeMiniWindow(() => {
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  });
  log('collapse overlay #' + (win.__st && win.__st.id) + ' -> mini at ' + miniBounds.x + ',' + miniBounds.y);
  notifyPanel();
  return { ok: true };
}

function expandOverlay() {
  // 兜底：万一 miniFor 已被清空（异常路径），也要能把主窗还回来，
  // 否则 raiseOverlay 里调本函数会变成「什么都没发生」。
  const win = miniFor || currentOverlay();
  miniFor = null;
  // 顺序很重要：先显示主窗，再销毁胶囊
  if (win && !win.isDestroyed()) {
    if (miniBounds) {
      try { win.setBounds(miniBounds); } catch (_) { /* ignore */ }
    }
    win.showInactive();
  }
  const m = miniWin;
  miniWin = null;
  if (m && !m.isDestroyed()) {
    miniSwapping = true;
    try { m.destroy(); } catch (_) { /* ignore */ }
    miniSwapping = false;
  }
  raiseOverlay(win);
  log('expand overlay from mini');
  notifyPanel();
  return { ok: true };
}

ipcMain.on('vr-mini', () => { collapseOverlay(); });
ipcMain.on('vr-mini-expand', () => { expandOverlay(); });

ipcMain.handle('vr-mini-info', () => {
  let title = '阅读层已收起';
  try {
    if (miniFor && !miniFor.isDestroyed()) title = miniFor.webContents.getTitle() || title;
  } catch (_) { /* ignore */ }
  return { title };
});

ipcMain.handle('vr-panel-min', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.minimize();
  return { ok: true };
});

ipcMain.handle('vr-panel-hide', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.hide();
  return { ok: true };
});

ipcMain.handle('vr-quit', () => { app.quit(); return { ok: true }; });

ipcMain.handle('vr-fit', (e, h) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return { ok: false };
  const [cw] = w.getSize();
  const target = clamp(Number(h) || 0, 420, 960);
  w.setSize(Math.round(cw), Math.round(target));
  return { ok: true };
});

ipcMain.on('vr-close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.on('vr-zoom-step', (e, dir) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const cur = win.__st.zoom || 1;
  const next = dir > 0 ? cur * ZOOM_STEP : cur / ZOOM_STEP;
  setZoom(win, next);
  log('zoom #' + win.__st.id + ' -> ' + Math.round((win.__st.zoom || 1) * 100) + '%');
});

ipcMain.on('vr-prefs-ask', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('vr-zoom', clamp(win.__st.zoom || 1, ZOOM_MIN, ZOOM_MAX));
    win.webContents.send('vr-bar-always', !!state.barAlways);
  } catch (_) {}
});

ipcMain.on('vr-zoom-reset', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) setZoom(win, 1);
});

ipcMain.on('vr-reload', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.reload();
});

function navOf(win) {
  if (!win || win.isDestroyed()) return null;
  const wc = win.webContents;
  if (wc.navigationHistory) return wc.navigationHistory;
  return null;
}

ipcMain.handle('vr-nav-state', (e) => {
  const h = navOf(BrowserWindow.fromWebContents(e.sender));
  if (!h) return { back: false, forward: false };
  try {
    return { back: h.canGoBack(), forward: h.canGoForward() };
  } catch (_) {
    return { back: false, forward: false };
  }
});

ipcMain.on('vr-back', (e) => {
  const h = navOf(BrowserWindow.fromWebContents(e.sender));
  try { if (h && h.canGoBack()) h.goBack(); } catch (_) {}
});

ipcMain.on('vr-forward', (e) => {
  const h = navOf(BrowserWindow.fromWebContents(e.sender));
  try { if (h && h.canGoForward()) h.goForward(); } catch (_) {}
});

ipcMain.on('vr-panel', () => {
  showPanel();
});

ipcMain.on('vr-drag-start', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  const start = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(dragTimer); return; }
    const p = screen.getCursorScreenPoint();
    win.setPosition(Math.round(wx + p.x - start.x), Math.round(wy + p.y - start.y));
  }, 12);
});

ipcMain.on('vr-drag-stop', (e) => {
  clearInterval(dragTimer);
  dragTimer = null;
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    state.x = x;
    state.y = y;
    saveState();
  }
});

// 工具条整条用了 -webkit-app-region: drag（系统接管拖动），这块区域内的鼠标事件
// 不会送进渲染进程，网页里收不到 mousemove / :hover。所以改由主进程直接读系统光标
// 坐标来判断"鼠标是否压在工具条上"，再通知页面高亮。
const BAR_HIT_ZONE = 34;   // 工具条高 30px，向上取整并留 4px 余量

function startBarWatch() {
  clearInterval(barTimer);
  barTimer = setInterval(() => {
    if (state.barAlways) return;   // 常亮时无需判断光标
    const win = currentOverlay();
    if (!win || win.isDestroyed() || !win.isVisible()) return;

    let on = false;
    try {
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      on = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + BAR_HIT_ZONE;
    } catch (_) {
      return;
    }

    if (win.__barHover === on) return;
    win.__barHover = on;
    try {
      win.webContents.send('vr-bar-hover', on);
    } catch (_) { /* 页面还没加载好，下一次状态变化会重新发 */ }
  }, 100);
}

app.setAppUserModelId('com.local.transparentreader');

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  log('another instance is already running, this one exits');
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // 重启用：electron.exe . --vr-quit 让正在运行的实例自己保存状态并退出，
    // 比外部强杀干净（强杀时外层 shell 会记成退出码 127，看着像启动失败）。
    if (Array.isArray(argv) && argv.indexOf('--vr-quit') >= 0) {
      log('quit requested by second instance');
      try { saveState(); } catch (_) { /* ignore */ }
      app.quit();
      return;
    }
    // 命令行换页面：electron . --vr-open=https://example.com
    // 走的就是面板「打开」那条路径 —— 已有阅读层就原地跳转，不会再开一个窗口。
    const openArg = Array.isArray(argv) ? argv.find((a) => /^--vr-open=/.test(a)) : null;
    if (openArg) {
      const target = openArg.slice('--vr-open='.length);
      log('open requested by command line: ' + target.slice(0, 60));
      createOverlay(target);
      return;
    }
    log('second launch detected, reusing the running instance');
    showPanel();
    const w = currentOverlay();
    if (w && !w.isDestroyed()) w.showInactive();
  });

  app.whenReady().then(() => {
    loadState();
    createTray();
    startBarWatch();
    showPanel();

    // 页签功能已移除：只恢复一个页面。
    // 旧版 state.json 里 tabs 可能有多条，这里只取当初处于激活态的那一条，
    // 避免升级后一口气开出好几个窗口。
    const saved = Array.isArray(state.tabs) ? state.tabs.filter((t) => t && t.url) : [];
    let restoreUrl = '';
    if (saved.length) {
      const idx = clamp(Number(state.activeTab) || 0, 0, saved.length - 1);
      restoreUrl = saved[idx].url || saved[0].url;
    } else if (state.url) {
      restoreUrl = state.url;
    }

    if (restoreUrl) createOverlay(restoreUrl);
  });
}

let quitting = false;
let lastClosedKind = '';
app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // 关掉阅读层时不要顺手退出整个程序 —— 浏览器关掉最后一个标签页
  // 也不会把浏览器关掉。这里把控制面板叫出来：想继续就点个网址，想退再点退出。
  // 但如果用户关的就是控制面板本身，那就照常退出，否则面板会变成"关不掉"。
  if (quitting) {
    app.quit();
    return;
  }
  const hasSavedPage = !!(state.url || (Array.isArray(state.tabs) && state.tabs.length > 0));
  if (lastClosedKind !== 'overlay' || !hasSavedPage) {
    app.quit();
    return;
  }
  log('overlay closed, keeping app alive with panel');
  showPanel();
});

app.on('will-quit', () => {
  clearInterval(barTimer);
  barTimer = null;
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
});
