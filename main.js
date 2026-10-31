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
const overlays = new Set();   // 所有页签窗口
let tabSeq = 0;               // 页签 id 自增
let activeTabId = null;       // 当前显示的页签
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
    const list = [...overlays].filter((w) => !w.isDestroyed());
    if (list.length) {
      state.tabs = list.map((w) => ({ url: w.__st.url, title: w.__st.title || '' }));
      const idx = list.findIndex((w) => w.__st.tabId === activeTabId);
      state.activeTab = idx >= 0 ? idx : 0;
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
    tabId: ++tabSeq,
    title: '',
    url,
  };

  win.setAlwaysOnTop(state.onTop !== false, state.onTop !== false ? 'screen-saver' : 'normal');
  win.setMenuBarVisibility(false);
  win.setSkipTaskbar(true);

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target || '')) win.loadURL(target).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('dom-ready', () => { applyCSS(win); syncPagePrefs(win); sendTabs(); });
  win.webContents.on('did-finish-load', () => { applyCSS(win); syncPagePrefs(win); sendTabs(); });
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
    sendTabs();
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

  const reveal = () => {
    if (win.isDestroyed()) return;
    if (win.__st.tabId !== activeTabId) return;
    if (!win.isVisible()) win.showInactive();
    applyTop(win);
    win.moveTop();
  };
  win.once('ready-to-show', reveal);

  win.on('focus', () => { lastActive = win; });
  win.on('resized', () => {
    if (win.isDestroyed() || win.__st.tabId !== activeTabId) return;
    const [w, h] = win.getSize();
    state.width = clamp(w, MIN_W, 1600);
    state.height = clamp(h, MIN_H, 1400);
    mirrorBounds(win);
    saveStateDebounced();
  });
  win.on('moved', () => {
    if (win.isDestroyed() || win.__st.tabId !== activeTabId) return;
    const [x, y] = win.getPosition();
    state.x = x;
    state.y = y;
    mirrorBounds(win);
    saveStateDebounced();
  });
  // 关闭当前页签时，先把下一个顶上来，再让这个窗口消失，
  // 否则会先露出桌面再出现新页面（又是"闪一下"）。
  win.on('close', () => {
    if (!win.__st || win.__st.tabId !== activeTabId) return;
    const next = [...overlays].find((w) => w !== win && !w.isDestroyed());
    if (next) activateTab(next);
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
    const wasActive = win.__st && win.__st.tabId === activeTabId;
    log('tab closed #' + (win.__st ? win.__st.tabId : '?') + ' wasActive=' + wasActive);
    overlays.delete(win);
    if (lastActive === win) lastActive = null;
    if (wasActive) {
      activeTabId = null;
      const next = [...overlays].find((w) => !w.isDestroyed());
      if (next) activateTab(next);
    }
    sendTabs();
    saveState();
    notifyPanel();
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

  overlays.add(win);
  lastActive = win;
  log('tab create #' + win.__st.tabId + ' activate=' + (opts.activate !== false) + ' total=' + overlays.size + ' resizable=' + win.isResizable() + ' ' + url.slice(0, 40));

  state.url = url;
  state.history = [url, ...state.history.filter((u) => u !== url)].slice(0, 20);

  // 立刻把新页签推给所有窗口，让当前页面顶部马上多出一个标签，
  // 而不是等新页面加载完才出现（否则会觉得"点了没反应"）
  sendTabs();

  if (opts.activate === false) {
    sendTabs();
    saveState();
    return win;
  }

  // 第一个页签必须立刻显示；后续新页签等页面画出第一帧再切换，
  // 否则会看到"旧页签消失 → 空白 → 新页面"的闪白。
  if (overlays.size === 1) {
    activateTab(win);
    setTimeout(reveal, 400);
    setTimeout(reveal, 1600);
  } else {
    let switched = false;
    const swap = () => {
      if (switched || win.isDestroyed()) return;
      switched = true;
      activateTab(win);
    };
    win.webContents.once('dom-ready', () => setTimeout(swap, 60));
    setTimeout(swap, 2500);
  }

  notifyPanel();
  return win;
}

function tabTitle(win) {
  const t = (win.__st && win.__st.title ? win.__st.title : '').trim();
  if (t) return t;
  try {
    return new URL(win.__st.url).host.replace(/^www\./, '');
  } catch (_) {
    return String((win.__st && win.__st.url) || '').slice(0, 24);
  }
}

function sendTabs() {
  const list = [...overlays]
    .filter((w) => !w.isDestroyed())
    .map((w) => ({
      id: w.__st.tabId,
      title: tabTitle(w),
      active: w.__st.tabId === activeTabId,
    }));

  for (const w of overlays) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send('vr-tabs', { selfId: w.__st.tabId, list });
    } catch (_) {}
  }
}

function mirrorBounds(win) {
  const b = overlayBounds();
  for (const w of overlays) {
    if (w === win || w.isDestroyed()) continue;
    try {
      w.setBounds({ x: b.x, y: b.y, width: b.w, height: b.h });
    } catch (_) {}
  }
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

function raiseOverlay() {
  const win = currentOverlay();
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
  log('raise overlay #' + (win.__st ? win.__st.tabId : '?') + ' onTop=' + (state.onTop !== false));
  return true;
}

function activateTab(win) {
  if (!win || win.isDestroyed()) return;

  // 顺序很重要：先把新页签摆好并显示，再隐藏旧的。
  // 反过来做，中间那一帧桌面会露出来，看起来就是"闪一下"。
  const b = overlayBounds();
  let cur = null;
  try {
    cur = win.getBounds();
  } catch (_) {
    cur = null;
  }
  if (!cur || cur.x !== b.x || cur.y !== b.y || cur.width !== b.w || cur.height !== b.h) {
    try {
      win.setBounds({ x: b.x, y: b.y, width: b.w, height: b.h });
    } catch (_) {}
  }

  win.setAlwaysOnTop(state.onTop !== false, state.onTop !== false ? 'screen-saver' : 'normal');
  // 切页签是用户主动操作，焦点必须跟过来；只 moveTop 会让键盘还留在旧窗口上
  if (!win.isVisible()) win.show();
  win.moveTop();
  try { win.focus(); } catch (_) { /* ignore */ }
  try { win.webContents.focus(); } catch (_) { /* ignore */ }

  for (const w of overlays) {
    if (w === win || w.isDestroyed()) continue;
    if (w.isVisible()) w.hide();
  }

  log('tab activate #' + win.__st.tabId + ' visible=' + win.isVisible() + ' top=' + win.isAlwaysOnTop() + ' total=' + overlays.size);
  activeTabId = win.__st.tabId;
  lastActive = win;

  // 透明窗口刚显示时有时会被别的置顶窗口压住，300ms 后再抬一次
  setTimeout(() => {
    if (win.isDestroyed() || activeTabId !== win.__st.tabId) return;
    applyTop(win);
    win.moveTop();
  }, 300);

  sendTabs();
  setTimeout(sendTabs, 700);
  setTimeout(sendTabs, 2000);
  saveState();
  notifyPanel();
}

function currentOverlay() {
  if (lastActive && !lastActive.isDestroyed()) return lastActive;
  const list = [...overlays].filter((w) => !w.isDestroyed());
  return list[list.length - 1] || null;
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
        for (const w of overlays) { if (!w.isDestroyed()) applyTop(w); }
        saveState();
        notifyPanel();
      } },
      { type: 'separator' },
      { label: '关闭当前浮层', enabled: has, click: () => { const w = currentOverlay(); if (w) w.close(); } },
      { label: '关闭全部浮层', enabled: overlays.size > 0, click: () => { for (const w of [...overlays]) if (!w.isDestroyed()) w.close(); } },
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
  if (key === 'onTop') {
    state.onTop = !!val;
    for (const w of overlays) {
      if (w.isDestroyed()) continue;
      applyTop(w);
      if (state.onTop && w.__st.tabId === activeTabId) w.moveTop();
    }
    saveState();
    notifyPanel();
    return { ok: true };
  }
  if (key === 'barAlways') {
    state.barAlways = !!val;
    for (const w of overlays) {
      if (w.isDestroyed()) continue;
      w.__barHover = null;   // 关掉常亮后重新按光标判断
      try { w.webContents.send('vr-bar-always', state.barAlways); } catch (_) {}
    }
    saveState();
    notifyPanel();
    return { ok: true };
  }
  if (key === 'lockSize') {
    state.lockSize = !!val;
    for (const w of overlays) {
      if (!w.isDestroyed()) {
        try {
          w.setResizable(!state.lockSize);
        } catch (_) {}
      }
    }
    log('lockSize=' + state.lockSize + ' applied to ' + overlays.size + ' window(s)');
    saveState();
    notifyPanel();
    return { ok: true };
  }
  if (key === 'hideImages' || key === 'focus') {
    state[key] = !!val;
    for (const w of overlays) {
      if (!w.isDestroyed()) {
        w.__st[key] = !!val;
        refresh(w);
      }
    }
    saveState();
    notifyPanel();
  }
  return { ok: true };
});

ipcMain.handle('vr-close-all', () => {
  for (const w of [...overlays]) if (!w.isDestroyed()) w.close();
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
  setTimeout(() => { if (!m.isDestroyed() && !m.isVisible()) reveal(); }, 400);

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
  miniWin = makeMiniWindow(() => { try { win.hide(); } catch (_) { /* ignore */ } });
  log('collapse overlay #' + (win.__st && win.__st.tabId) + ' -> mini at ' + miniBounds.x + ',' + miniBounds.y);
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
  if (win && !win.isDestroyed()) raiseOverlay();
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
  log('zoom #' + win.__st.tabId + ' -> ' + Math.round((win.__st.zoom || 1) * 100) + '%');
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

function tabById(id) {
  const n = Number(id);
  for (const w of overlays) {
    if (!w.isDestroyed() && w.__st.tabId === n) return w;
  }
  return null;
}

ipcMain.on('vr-tab-activate', (_e, id) => {
  const w = tabById(id);
  if (w) activateTab(w);
});

ipcMain.on('vr-tab-close', (_e, id) => {
  const w = tabById(id);
  if (w) w.close();
});

ipcMain.on('vr-tab-new', () => {
  showPanel();
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

    const saved = Array.isArray(state.tabs) ? state.tabs.filter((t) => t && t.url) : [];
    const list = saved.length ? saved : (state.url ? [{ url: state.url }] : []);
    const active = clamp(Number(state.activeTab) || 0, 0, Math.max(0, list.length - 1));

    list.forEach((t, i) => {
      createOverlay(t.url, { activate: i === active });
    });


  });
}

let quitting = false;
let lastClosedKind = '';
app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // 关掉最后一个页签时不要顺手退出整个程序 —— 浏览器关掉最后一个标签页
  // 也不会把浏览器关掉。这里把控制面板叫出来：想继续就点个网址，想退再点退出。
  // 但如果用户关的就是控制面板本身，那就照常退出，否则面板会变成"关不掉"。
  if (quitting) {
    app.quit();
    return;
  }
  const hasTabs = Array.isArray(state.tabs) && state.tabs.length > 0;
  if (lastClosedKind !== 'overlay' || (!hasTabs && !state.url)) {
    app.quit();
    return;
  }
  log('last tab closed, keeping app alive with panel');
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
