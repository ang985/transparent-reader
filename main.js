'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { buildCSS, buildDarkCSS } = require('./styles');

if (process.env.VR_NO_GPU === '1') app.disableHardwareAcceleration();

// 数据目录选取顺序：
//   1. 环境变量 VR_DATA_DIR —— 想固定到某个位置时用
//   2. 本机提示文件 %APPDATA%/transparent-reader/data-dir.txt —— 老版本把数据
//      放在别的盘时，写一行路径进去就接着用，省得在源码里写死某个目录
//   3. 系统用户数据目录（Windows 下是 %APPDATA%/transparent-reader）
// 这样别人拿到源码零配置即可运行，也不会往他的盘上乱建目录。
function readDirHint() {
  try {
    const hint = path.join(app.getPath('appData'), 'transparent-reader', 'data-dir.txt');
    const dir = fs.readFileSync(hint, 'utf8').trim();
    if (dir && fs.existsSync(path.join(dir, 'state.json'))) return dir;
  } catch (_) { /* 没有提示文件，走默认位置 */ }
  return '';
}

function resolveDataDir() {
  return process.env.VR_DATA_DIR
    || readDirHint()
    || path.join(app.getPath('appData'), 'transparent-reader');
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
  fontScale: 1,    // 正文字号倍率（只改文字，不改布局）
  barAlways: false, // 顶部工具条是否常亮（不随鼠标淡出）
  // 按站点记忆：{ "example.com": { alpha: 0.14, zoom: 1.2 } }
  // 只存浓度和缩放；没记录的站点用上面的全局默认值。
  sitePrefs: {},
  // 蒙版主题：auto 按页面底色自动判断；light / dark 手动锁死（判断错时用）
  veilMode: 'auto',
  // 全局唤出热键：窗口被别的程序盖住、或压根没焦点时，按一下把浮层捞到最前并聚焦。
  // 必须是系统级热键（globalShortcut）—— 那种状态下页面收不到任何键盘事件。
  summonEnabled: true,
  summonAccel: 'Alt+R',
  // 自动滚动速度（px/秒，0 = 关闭）。在渲染层跑 rAF，主进程只存配置。
  autoScrollSpeed: 60,
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

// 正文字号：只缩放文字，不动布局（和 zoom 不是一回事）。
// 范围收得比较窄 —— 再大就开始频繁折行，反而更难读。
const FONT_MIN = 0.8;
const FONT_MAX = 1.6;
const FONT_STEP = 0.1;

const ALPHA_MIN = 0;
const ALPHA_MAX = 0.92;
const ALPHA_STEP = 0.03;   // Alt+滚轮每档的浓度变化

// 自动滚动速度范围（px/秒）
const SCROLL_MIN = 15;
const SCROLL_MAX = 300;
const SCROLL_DEFAULT = 60;

const SITE_MAX = 200;      // 站点记忆最多保留多少条

const MIN_W = 340;
const MIN_H = 320;

function clamp(v, min, max) {
  v = Number(v);
  if (!isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

// 日志超过 1MB 就清空重来。原来只 append 不轮转，日志会一直长，而且每次写都是
// 同步 IO 卡在主线进程上——文件越大越慢。
const LOG_MAX_BYTES = 1024 * 1024;

function log(msg) {
  try {
    const file = path.join(app.getPath('userData'), 'run.log');
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.truncateSync(file, 0);
    } catch (_) { /* 文件还不存在，正常 */ }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
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
  state.fontScale = clamp(state.fontScale || 1, FONT_MIN, FONT_MAX);
  state.autoScrollSpeed = clamp(Number(state.autoScrollSpeed) || SCROLL_DEFAULT, SCROLL_MIN, SCROLL_MAX);
  state.width = clamp(state.width, MIN_W, 1600);
  state.height = clamp(state.height, MIN_H, 1400);
  if (!Array.isArray(state.history)) state.history = [];
  // 热键字段容错：老版本的 state.json 里没有这两项，缺了就落回默认值；
  // 存了乱七八糟的内容也不让它卡在"注册不上还改不掉"的状态。
  if (state.summonEnabled !== true && state.summonEnabled !== false) state.summonEnabled = true;
  state.summonAccel = normAccel(state.summonAccel) || SUMMON_DEFAULT;
  // 站点记忆：容错 + 只保留最近 200 个条目，避免这个字段无限长
  if (!state.sitePrefs || typeof state.sitePrefs !== 'object' || Array.isArray(state.sitePrefs)) {
    state.sitePrefs = {};
  }
  const keys = Object.keys(state.sitePrefs);
  if (keys.length > SITE_MAX) {
    for (const k of keys.slice(0, keys.length - SITE_MAX)) delete state.sitePrefs[k];
  }
  for (const k of Object.keys(state.sitePrefs)) {
    const v = state.sitePrefs[k];
    if (!v || typeof v !== 'object') { delete state.sitePrefs[k]; continue; }
    const out = {};
    if (typeof v.alpha === 'number') out.alpha = clamp(v.alpha, 0, 0.92);
    if (typeof v.zoom === 'number') out.zoom = clamp(v.zoom, ZOOM_MIN, ZOOM_MAX);
    // 注意：这里是白名单式重建，新加的每站点字段都必须在这里放行，
    // 否则存进 state.json 后会在下次启动被静默丢弃。
    if (typeof v.fontScale === 'number') out.fontScale = clamp(v.fontScale, FONT_MIN, FONT_MAX);
    if (!Object.keys(out).length) delete state.sitePrefs[k];
    else state.sitePrefs[k] = out;
  }
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

// 暗色配色是一张独立样式表：页面判定为深色就插进去，浅色就摘掉。
// 用 insertCSS 而不是往 <html> 挂类名 —— 洛谷这类 SPA 会整体重写
// documentElement.className，类名一被抹掉，深色配色就集体失效，
// 只剩深色蒙版压着浅色页的深色文字，屏幕上就是一坨糊。
let darkSeq = 0;
// quiet：由 applyCSS 内部调用时为 true —— 那时候"没有 key"是正常的（新文档还没插过），
// 不该往日志里刷告警。只有面板切换触发的摘除没有 key，才是真问题。
async function setDarkSheet(win, on, quiet) {
  if (!win || win.isDestroyed()) return;
  const tag = ++darkSeq;
  if (on) {
    if (win.__darkKey) return;
    try {
      const key = await win.webContents.insertCSS(buildDarkCSS());
      if (tag !== darkSeq || win.isDestroyed()) {
        try { win.webContents.removeInsertedCSS(key); } catch (_) {}
        return;
      }
      win.__darkKey = key;
    } catch (e) {
      log('insert dark CSS failed: ' + e.message);
    }
    return;
  }
  const key = win.__darkKey;
  win.__darkKey = null;
  if (key) {
    try {
      await win.webContents.removeInsertedCSS(key);
      if (!quiet) log('dark CSS removed');
    } catch (e) {
      log('remove dark CSS failed: ' + e.message);
    }
  } else if (!quiet) {
    // 没有 key 却要求摘除：暗色配色会一直压在浅色蒙版底下，字就是近白色，必须留痕。
    log('dark CSS key missing (nothing to remove)');
  }
}

let cssSeq = 0;

async function applyCSS(win) {
  if (!win || win.isDestroyed()) return;
  const tag = ++cssSeq;
  const css = buildCSS(win.__st);
  try {
    if (win.__cssKey) {
      const oldKey = win.__cssKey;
      win.__cssKey = null;
      try { await win.webContents.removeInsertedCSS(oldKey); } catch (_) { /* stale key after navigation */ }
    }
    // 关键：重插基础表之前，必须先把旧暗表**真正移除**。
    // 以前这里只写了 win.__darkKey = null，样式表本身还挂在文档上，
    // 于是每次 dom-ready / did-finish-load 都会漏下一张摘不掉的孤儿暗表：
    //   auto 模式启动 → 插暗表(K1) → did-finish-load 再 applyCSS
    //   → key 被清空但 K1 还在 → 重插暗表(K2)
    //   → 用户切「强制浅色」时只摘掉了 K2，K1 让文字一直停在 #e3e6eb
    // 屏幕上就是"白蒙版 + 近白字"，也就是用户报的"强制浅色后字很淡"。
    await setDarkSheet(win, false, true);
    const newKey = await win.webContents.insertCSS(css);
    if (tag !== cssSeq || win.isDestroyed()) {
      try { await win.webContents.removeInsertedCSS(newKey); } catch (_) {}
      return;
    }
    win.__cssKey = newKey;
    if (win.__st.dark) await setDarkSheet(win, true);
  } catch (e) {
    log('insertCSS failed: ' + e.message);
  }
}

function overlayBounds() {
  const w = state.width;
  const h = state.height;
  let x = state.x;
  let y = state.y;

  // 边界要按窗口自己所在的那块屏算。原来固定用 getPrimaryDisplay()，
  // 把窗口放到第二块屏后，重启或再展开时会被拽回主屏。
  const known = (x != null && y != null);
  const area = known
    ? screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width: w, height: h }).workArea
    : screen.getPrimaryDisplay().workArea;

  if (!known) {
    x = area.x + area.width - w - 40;
    y = area.y + 80;
  }
  x = clamp(x, area.x - w + 80, area.x + area.width - 80);
  y = clamp(y, area.y - h + 80, area.y + area.height - 80);
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
      additionalArguments: [
        '--vr-alpha=' + state.alpha,
        '--vr-zoom=' + (state.zoom || 1),
        '--vr-font=' + (state.fontScale || 1),
        '--vr-bar-always=' + (state.barAlways ? '1' : '0'),
        '--vr-veil=' + (state.veilMode || 'auto'),
        '--vr-scroll-speed=' + state.autoScrollSpeed,
      ],
    },
  });

  win.__st = {
    alpha: state.alpha,
    zoom: clamp(state.zoom || 1, ZOOM_MIN, ZOOM_MAX),
    fontScale: clamp(state.fontScale || 1, FONT_MIN, FONT_MAX),
    hideImages: state.hideImages,
    focus: state.focus,
    id: ++winSeq,
    title: '',
    url,
    dark: false,        // 当前页面是否按深色蒙版渲染（由 preload 上报）
    eff: state.alpha,   // 实际生效浓度（深色页有下限，可能大于 alpha）
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

  // 原生查找的结果回传给阅读层的查找条。
  // 每次 findInPage 都会连着来几条（finalUpdate 为 false 的是中间态），
  // 一律转发，由界面自己决定怎么显示 —— 这样"输入过程中计数不断跳"是自然的。
  win.webContents.on('found-in-page', (_e, result) => {
    if (win.isDestroyed() || !result) return;
    try {
      win.webContents.send('vr-find-result', {
        active: result.activeMatchOrdinal || 0,
        total: result.matches || 0,
        final: !!result.finalUpdate,
      });
    } catch (_) {}
  });
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

  // 渲染进程的 console 落到 run.log：
  // 页面里出问题时只能靠这个看，否则要么开 devtools，要么什么都看不到。
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log('page[' + level + '] ' + String(message).slice(0, 400) +
      (sourceId ? ' @' + String(sourceId).slice(-40) + ':' + line : ''));
  });

  win.webContents.on('page-title-updated', (_e, title) => {
    win.__st.title = String(title || '').trim().slice(0, 40);
    saveStateDebounced();
  });
  win.webContents.on('did-navigate', (_e, u) => {
    win.__st.url = u;
    // 换了站点就把该站点记住的浓度/缩放套上来；
    // 具体应用发生在随后的 dom-ready（applyCSS / syncPagePrefs）
    applySitePrefs(win, u);
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
    // 穿透状态跟着窗口走，别留一个指向已销毁窗口的全局热键
    if (passthrough) {
      passthrough = false;
      try { globalShortcut.unregister(PASSTHROUGH_ACCEL); } catch (_) {}
    }
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

  // Alt+Q 收起成胶囊、Alt+P 唤出控制面板、Alt+T 临时穿透。
  // 放在 webContents 的 before-input-event 而不是页面里的 keydown：
  //   1. 页面每次导航 preload 都会重跑一遍，注册时机容易出岔子；
  //   2. 页面自己吞键（stopPropagation / 富文本编辑器）也拦不到这一层；
  //   3. 这一层覆盖所有 frame，iframe 抢走焦点时同样有效。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    // Ctrl+F：页面内查找。必须在这一层拦，页面自己吞键（富文本、编辑器）
    // 或者焦点在 iframe 里时，页面级的 keydown 收不到。
    if (input.control && !input.alt && !input.meta && !input.shift && key === 'f') {
      event.preventDefault();
      try { win.webContents.send('vr-find-open'); } catch (_) {}
      return;
    }
    if (!input.alt || input.control || input.meta || input.shift) return;
    if (key === 'q') {
      event.preventDefault();
      toggleMini();
      return;
    }
    if (key === 'p') {
      event.preventDefault();
      showPanel();
      return;
    }
    if (key === 't') {
      event.preventDefault();
      togglePassthrough();
    }
    if (key === 's') {
      // Alt+S：开/关自动滚动。滚动循环跑在渲染层（那里能找对滚动容器），
      // 主进程只负责把按键转发过去。
      event.preventDefault();
      try { win.webContents.send('vr-scroll-toggle'); } catch (_) {}
    }
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
  // 浓度也要补发：站点记忆里的浓度和全局默认值不一样，不补发的话
  // preload 会一直用启动参数 --vr-alpha 里那个全局值。
  try {
    win.webContents.send('vr-zoom', z);
    win.webContents.send('vr-bar-always', !!state.barAlways);
    win.webContents.send('vr-alpha', win.__st.alpha);
    win.webContents.send('vr-font', win.__st.fontScale || 1);
    win.webContents.send('vr-veil-mode', state.veilMode || 'auto');
    win.webContents.send('vr-scroll-speed', state.autoScrollSpeed);
  } catch (_) {}
}

// ---- 按站点记忆 ----
// 用 hostname（去掉 www.）当键。path 不参与，否则每个题目页都要记一份。
function siteKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (!/^https?:$/i.test(u.protocol)) return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function sitePrefOf(rawUrl) {
  const key = siteKey(rawUrl);
  if (!key) return null;
  const p = state.sitePrefs && state.sitePrefs[key];
  return p && typeof p === 'object' ? { key, ...p } : { key };
}

// 记住某个站点的浓度 / 缩放。只有真的改了才写，避免每次都覆盖。
function rememberSite(win, patch) {
  if (!win || win.isDestroyed()) return;
  const key = siteKey(win.__st.url);
  if (!key) return;
  const cur = state.sitePrefs[key] || {};
  const next = { ...cur };
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (next[k] !== patch[k]) { next[k] = patch[k]; changed = true; }
  }
  if (!changed) return;
  state.sitePrefs[key] = next;
  log('site pref ' + key + ' = ' + JSON.stringify(next));
}

// 页面切到新地址后，把该站点记住的值套上去（没记过就沿用当前值）。
function applySitePrefs(win, url) {
  if (!win || win.isDestroyed()) return;
  const key = siteKey(url);
  if (!key) return;
  const p = state.sitePrefs[key];
  if (!p) return;

  if (typeof p.alpha === 'number') win.__st.alpha = clamp(p.alpha, ALPHA_MIN, ALPHA_MAX);
  if (typeof p.zoom === 'number') win.__st.zoom = clamp(p.zoom, ZOOM_MIN, ZOOM_MAX);
  if (typeof p.fontScale === 'number') win.__st.fontScale = clamp(p.fontScale, FONT_MIN, FONT_MAX);

  // 这里只改窗口自己的状态；真正的应用交给 dom-ready 之后的
  // applyCSS / syncPagePrefs，避免往还没加载完的页面上插样式。
  log('apply site pref ' + key + ' ' + JSON.stringify(p) +
      ' -> alpha=' + win.__st.alpha + ' zoom=' + win.__st.zoom);
}

function setZoom(win, z) {
  if (!win || win.isDestroyed()) return;
  const next = clamp(z, ZOOM_MIN, ZOOM_MAX);
  win.__st.zoom = next;
  state.zoom = next;
  rememberSite(win, { zoom: Number(next.toFixed(3)) });
  try {
    win.webContents.setZoomFactor(next);
  } catch (_) {}
  // 通知页面：工具条按 1/zoom 反向缩放，保持原尺寸不跟着变大
  try {
    win.webContents.send('vr-zoom', next);
  } catch (_) {}
  saveStateDebounced();
}

// 正文字号：只改文字大小，布局和图片不动。
// 和 setZoom 的区别要说清楚：zoom 是整页缩放（连版心宽度一起变），
// fontScale 只作用于承载文字的元素，适合"字太小但版式正好"的场景。
function setFontScale(win, v) {
  if (!win || win.isDestroyed()) return { ok: false };
  const next = clamp(Math.round(Number(v) * 100) / 100, FONT_MIN, FONT_MAX);
  if (Math.abs(next - (win.__st.fontScale || 1)) < 1e-6) return { ok: true, fontScale: next };
  win.__st.fontScale = next;
  state.fontScale = next;
  rememberSite(win, { fontScale: next });
  try { win.webContents.send('vr-font', next); } catch (_) {}
  saveStateDebounced();
  notifyPanel();
  log('fontScale=' + next);
  return { ok: true, fontScale: next };
}

function setAlpha(win, v) {
  win.__st.alpha = clamp(v, ALPHA_MIN, ALPHA_MAX);
  state.alpha = win.__st.alpha;
  rememberSite(win, { alpha: Number(win.__st.alpha.toFixed(3)) });
  refresh(win);
  // 拖滑块 / Alt+滚轮会连续触发，这里用防抖，避免每一下都同步写盘
  saveStateDebounced();
  notifyPanel();
}

// 蒙版模式：auto（跟页面底色）/ light（强制浅色）/ dark（强制深色）
// 抽成函数是因为面板 IPC 和命令行都要走同一条路径，
// 少一处分支就少一处"改了模式但页面没跟上"的坑。
function setVeilMode(val) {
  state.veilMode = (val === 'light' || val === 'dark') ? val : 'auto';
  const win = currentOverlay();
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('vr-veil-mode', state.veilMode); } catch (_) {}
  }
  saveState();
  notifyPanel();
  log('veilMode=' + state.veilMode);
  return state.veilMode;
}

// Alt+滚轮：直接调浓度，不用先摸到面板里的滑块
function stepAlpha(win, dir) {
  if (!win || win.isDestroyed()) return;
  const next = clamp(win.__st.alpha + dir * ALPHA_STEP, ALPHA_MIN, ALPHA_MAX);
  if (Math.abs(next - win.__st.alpha) < 1e-6) return;
  setAlpha(win, next);
  log('alpha step -> ' + Math.round(next * 100) + '%');
}

// ---------------- 临时穿透 ----------------
// 打开后鼠标直接落到下层窗口：临时点一下被挡住的按钮、或者核对下层内容时用。
// 关键点是"怎么退出来"：窗口一旦忽略鼠标，键盘焦点也可能跑到别的程序上，
// Alt+T 就收不到了。所以进入穿透时注册一个**全局**热键专门负责退出，
// 退出后再立刻注销，不去长期占用这个组合键。
let passthrough = false;
const PASSTHROUGH_ACCEL = 'Alt+T';

function setPassthrough(on) {
  const win = currentOverlay();
  if (!win) return false;
  on = !!on;
  if (on === passthrough) return true;

  if (on) {
    // 先拿到退出手段再开穿透，注册失败就干脆不进这状态，免得用户被"卡死"
    let ok = false;
    try {
      ok = globalShortcut.register(PASSTHROUGH_ACCEL, () => setPassthrough(false));
    } catch (e) {
      log('register passthrough shortcut failed: ' + e.message);
    }
    if (!ok) {
      log('passthrough aborted: ' + PASSTHROUGH_ACCEL + ' unavailable');
      return false;
    }
  }

  passthrough = on;
  try {
    win.setIgnoreMouseEvents(on, { forward: true });   // forward 保留 hover，看起来不"死"
  } catch (e) {
    log('setIgnoreMouseEvents failed: ' + e.message);
  }
  try { win.webContents.send('vr-passthrough', passthrough); } catch (_) {}

  if (!on) {
    try { globalShortcut.unregister(PASSTHROUGH_ACCEL); } catch (_) {}
  }
  log(passthrough ? 'passthrough ON (global ' + PASSTHROUGH_ACCEL + ' to exit)' : 'passthrough OFF');
  notifyPanel();
  return true;
}

function togglePassthrough() {
  if (!currentOverlay()) return { ok: false };
  return { ok: setPassthrough(!passthrough) };
}

// ---------------- 全局唤出热键 ----------------
// 为什么必须走 globalShortcut，而不是像 Alt+Q / Alt+P 那样用 before-input-event：
// 后者只在本窗口吃到键盘事件时才触发，而这里要解决的恰恰是
// "窗口被别的程序盖住 / 根本没有键盘焦点" —— 那种状态下页面一个键都收不到。
//
// 代价也要说清楚：全局热键是**独占**的，注册期间其它程序收不到这个组合。
// 所以默认挑了一个不常用的 Alt+R，并且只在用户开着开关时才注册。
const SUMMON_DEFAULT = 'Alt+R';
const SUMMON_MODS = ['Ctrl', 'Alt', 'Shift', 'Super'];

// 键名白名单：只放行这些，避免用户录进 "MediaPlayPause" 之类
// Electron 能吃但 Windows 上行为诡异的键，也避免拼出非法 accelerator。
const SUMMON_KEY_RE = /^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Tab|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/;

// 系统保留组合：Windows 会先一步吃掉，注册要么直接失败，要么"成功"但永远不触发。
// 与其让用户录进来再一脸问号，不如当场说不可用。
const SUMMON_RESERVED = new Set([
  'ALT+F4', 'ALT+TAB', 'ALT+ESC', 'ALT+SPACE', 'ALT+PRINTSCREEN',
  'CTRL+ESC', 'CTRL+ALT+DEL', 'CTRL+ALT+TAB', 'CTRL+SHIFT+ESC', 'CTRL+SHIFT+ENTER',
  'SUPER+L', 'SUPER+D', 'SUPER+E', 'SUPER+R', 'SUPER+TAB', 'SUPER+S', 'SUPER+X', 'SUPER+I',
]);

// 应用内部的本地快捷键。它们靠 before-input-event 工作，一旦被登记成全局热键，
// 窗口有焦点时两个通道会同时响应（比如收起两次），必须挡掉。
const SUMMON_TAKEN = {
  'ALT+Q': '收起 / 展开浮层',
  'ALT+P': '唤出控制面板',
  'ALT+T': '临时穿透',
};

let summonAccel = '';   // 真正注册成功的组合（空 = 当前没生效）
let summonError = '';   // 最近一次失败原因，面板要原样显示给用户

// 规范化：'ctrl+alt+r' / 'Alt + R' / 'CMDORCTRL+K' → 'Ctrl+Alt+R' / 'Ctrl+K'
// 不合法时返回 ''，让调用方给出人话提示，而不是把非法串丢进 register() 撞异常。
function normAccel(raw) {
  const parts = String(raw || '').split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  const mods = new Set();
  let key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control' || l === 'cmdorctrl' || l === 'commandorcontrol') mods.add('Ctrl');
    else if (l === 'alt' || l === 'option') mods.add('Alt');
    else if (l === 'shift') mods.add('Shift');
    else if (l === 'super' || l === 'meta' || l === 'win' || l === 'cmd' || l === 'command') mods.add('Super');
    else if (!key) key = p.length === 1 ? p.toUpperCase() : p.replace(/^f/i, 'F');
  }
  if (!key || !SUMMON_KEY_RE.test(key)) return '';
  // 必须至少一个修饰键：单键做全局热键会把那个键从整个系统手里抢走，
  // 用户从此打不出那个字母，属于事故级配置。
  if (!mods.size) return '';
  return SUMMON_MODS.filter((m) => mods.has(m)).join('+') + '+' + key;
}

function unregisterSummon() {
  if (!summonAccel) return;
  try { globalShortcut.unregister(summonAccel); } catch (_) {}
  summonAccel = '';
}

// 统一的注册入口：先干净注销，再按当前 state 重新注册。
// 返回 { ok, error }，面板据此显示"已生效 / 被占用"。
function registerSummon() {
  unregisterSummon();
  summonError = '';
  if (state.summonEnabled === false) {
    log('summon hotkey disabled');
    return { ok: true, active: '' };
  }
  const acc = normAccel(state.summonAccel);
  if (!acc) {
    summonError = '至少要带一个 Ctrl / Alt / Shift，再加一个字母或功能键';
    log('summon hotkey invalid: ' + state.summonAccel);
    return { ok: false, error: summonError };
  }
  if (SUMMON_RESERVED.has(acc.toUpperCase())) {
    summonError = acc + ' 是系统保留组合，抢不到，换一个';
    log('summon hotkey reserved: ' + acc);
    return { ok: false, error: summonError };
  }
  const taken = SUMMON_TAKEN[acc.toUpperCase()];
  if (taken) {
    summonError = acc + ' 已经被「' + taken + '」占用，换一个';
    log('summon hotkey conflicts with builtin: ' + acc);
    return { ok: false, error: summonError };
  }
  let ok = false;
  try {
    ok = globalShortcut.register(acc, () => { summonOverlay(); });
  } catch (e) {
    summonError = '注册失败：' + e.message;
  }
  if (!ok) {
    // register() 返回 false 基本就是"被别的程序占了"，它不会抛异常也不说原因。
    if (!summonError) summonError = acc + ' 被其它程序占用了，换一个组合';
    log('summon hotkey register failed: ' + acc + ' / ' + summonError);
    return { ok: false, error: summonError };
  }
  summonAccel = acc;
  log('summon hotkey registered: ' + acc);
  return { ok: true, active: acc };
}

// 把浮层捞回最前并真正拿到键盘焦点。
// 窗口可能处于四种"看不见"的状态，得分别处理，少一种用户就会觉得热键"没反应"：
//   1. 被别的窗口盖住（有焦点/无焦点都可能）→ raiseOverlay 的 moveTop + focus
//   2. 已收成胶囊 → raiseOverlay 内部先 expandOverlay
//   3. 临时穿透中 → 窗口在画面上但鼠标点不进去，先退出穿透
//   4. 压根没有阅读层 → 唤出控制面板，让用户自己决定看什么
function summonOverlay() {
  const win = currentOverlay();
  if (!win) {
    showPanel();
    log('summon: no overlay window, panel shown instead');
    return { ok: false, reason: 'no-window' };
  }
  if (passthrough) setPassthrough(false);
  try { if (win.isMinimized()) win.restore(); } catch (_) {}
  if (!win.isVisible()) win.show();
  // 已经置顶时 raiseOverlay 照样有意义：置顶只保证"在所有窗口之上"，
  // 不保证"键盘焦点在它身上"，而被盖住时往往两样都缺，所以这里不跳过。
  const ok = raiseOverlay(win);
  log('summon: raise ' + (ok ? 'ok' : 'failed'));
  return { ok };
}

// 改键：先按新键注册，成功了才落盘；失败就退回去把旧键重新注册上，
// 不能让用户处于"改了键但两个都不生效"的状态。
function setSummonAccel(raw) {
  const acc = normAccel(raw);
  if (!acc) {
    return { ok: false, error: '至少要带一个 Ctrl / Alt / Shift，再加一个字母或功能键' };
  }
  const prev = state.summonAccel;
  state.summonAccel = acc;
  const r = registerSummon();
  if (!r.ok) {
    state.summonAccel = prev;
    registerSummon();          // 旧键恢复，界面不会因为一次误改就没热键可用
    notifyPanel();
    return { ok: false, error: r.error };
  }
  saveState();
  notifyPanel();
  return { ok: true, accel: acc, active: summonAccel };
}

function setSummonEnabled(on) {
  state.summonEnabled = !!on;
  const r = registerSummon();
  saveState();
  notifyPanel();
  // 开关保持用户选的样子，但注册失败要如实回传，面板会用红字提示，
  // 而不是"开关是开的、其实没生效"这种静默失败。
  return r.ok ? { ok: true, active: summonAccel } : { ok: false, error: r.error };
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
  const curUrl = win ? win.__st.url : state.url;
  const site = sitePrefOf(curUrl);
  return {
    url: state.url || '',
    history: state.history || [],
    alpha: win ? win.__st.alpha : state.alpha,
    fontScale: win ? (win.__st.fontScale || 1) : (state.fontScale || 1),
    hideImages: win ? win.__st.hideImages : state.hideImages,
    focus: win ? win.__st.focus : state.focus,
    onTop: state.onTop !== false,
    lockSize: state.lockSize !== false,
    barAlways: !!state.barAlways,
    veilMode: state.veilMode || 'auto',
    autoScrollSpeed: state.autoScrollSpeed,
    dark: win ? !!win.__st.dark : false,
    effAlpha: win ? (typeof win.__st.eff === 'number' ? win.__st.eff : win.__st.alpha) : state.alpha,
    hasOverlay: !!win,
    passthrough,
    // 全局唤出热键：enabled 是用户的开关，accel 是配置值，active 是**真正注册成功**的键。
    // 三者分开是必要的：开关打开 + accel 有值 + active 为空 = 被占用，面板必须红字提示，
    // 否则用户会以为"设了热键却没反应"是程序坏了。
    summon: {
      enabled: state.summonEnabled !== false,
      accel: state.summonAccel || SUMMON_DEFAULT,
      active: summonAccel,
      error: summonError,
    },
    // 当前站点的记忆值（null 表示这个站点还没单独记过）
    site: site ? {
      key: site.key,
      alpha: typeof site.alpha === 'number' ? site.alpha : null,
      zoom: typeof site.zoom === 'number' ? site.zoom : null,
      fontScale: typeof site.fontScale === 'number' ? site.fontScale : null,
    } : null,
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
      { label: '把浮层提到最前' + (summonAccel ? '（' + summonAccel + '）' : ''), enabled: has, click: () => summonOverlay() },
      { label: passthrough ? '退出临时穿透（Alt+T）' : '临时穿透：鼠标穿透下层（Alt+T）', enabled: has, click: () => setPassthrough(!passthrough) },
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
  // 面板加载完才抢焦点。但如果这时候已经有阅读层（VR_AUTOVIEW 启动即开窗的场景），
  // 焦点必须留在阅读层上，否则 Alt+Q 落在面板上，按了没反应。
  panelWin.once('ready-to-show', () => {
    if (!panelWin || panelWin.isDestroyed()) return;
    panelWin.moveTop();
    if (!currentOverlay()) panelWin.focus();
  });
  panelWin.on('closed', () => { panelWin = null; lastClosedKind = 'panel'; });
}

ipcMain.handle('vr-open', (_e, url) => {
  if (!String(url || '').trim()) return { ok: false, error: '网址不能为空' };
  const win = createOverlay(url);
  if (!win) return { ok: false, error: '打开失败' };
  if (panelWin && !panelWin.isDestroyed()) panelWin.hide();
  return { ok: true };
});

// preload 识别出页面深浅后上报：面板据此说明"实际按 xx% 渲染"
ipcMain.on('vr-theme', (e, info) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || !win.__st || !info) return;
  const dark = !!info.dark;
  const eff = typeof info.eff === 'number' ? clamp(info.eff, ALPHA_MIN, ALPHA_MAX) : win.__st.alpha;
  if (info.diag) log('theme diag: ' + JSON.stringify(info.diag));
  if (win.__st.dark === dark && win.__st.eff === eff) return;
  const flipped = win.__st.dark !== dark;
  win.__st.dark = dark;
  win.__st.eff = eff;
  if (flipped) {
    setDarkSheet(win, dark);
    log('dark sheet ' + (dark ? 'on' : 'off'));
  }
  notifyPanel();
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
  if (key === 'veilMode') {
    setVeilMode(val);
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
  if (key === 'summonEnabled') {
    return setSummonEnabled(val);
  }
  if (key === 'fontScale') {
    if (!win) {
      // 还没开窗口：先记为全局默认，下次开窗时随 argv 带过去
      state.fontScale = clamp(Number(val) || 1, FONT_MIN, FONT_MAX);
      saveState();
      notifyPanel();
      return { ok: true, fontScale: state.fontScale };
    }
    return setFontScale(win, val);
  }
  if (key === 'summonAccel') {
    return setSummonAccel(val);
  }
  if (key === 'autoScrollSpeed') {
    state.autoScrollSpeed = clamp(Number(val) || SCROLL_DEFAULT, SCROLL_MIN, SCROLL_MAX);
    if (win) {
      try { win.webContents.send('vr-scroll-speed', state.autoScrollSpeed); } catch (_) {}
    }
    saveState();
    notifyPanel();
    return { ok: true, autoScrollSpeed: state.autoScrollSpeed };
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

// ---------------- 页面内查找 ----------------
// 用 Chromium 原生的 findInPage：跨节点、富文本、Shadow DOM 都能正确匹配，
// 而且自带"滚到匹配处 + 高亮当前项"，自己遍历 DOM 做不到这个效果。
ipcMain.on('vr-find', (e, payload) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const text = String((payload && payload.text) || '');
  if (!text) {
    try { win.webContents.stopFindInPage('clearSelection'); } catch (_) {}
    return;
  }
  try {
    win.webContents.findInPage(text, {
      forward: !payload || payload.forward !== false,
      findNext: !!(payload && payload.findNext),
    });
  } catch (err) {
    log('findInPage failed: ' + err.message);
  }
});

ipcMain.on('vr-find-stop', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  // clearSelection：不留选中高亮，否则关掉查找后页面上还挂着几块选区
  try { win.webContents.stopFindInPage('clearSelection'); } catch (_) {}
});

ipcMain.handle('vr-raise', () => summonOverlay());

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
    // 注意：Windows + 透明窗口存在约 64px 的最小内容高度，请求 34 实际会得到 64
    // （实测 thickFrame:false / useContentSize / setBounds 都压不下去）。
    // 所以 mini.html 让胶囊填满 100% 高度，视觉尺寸就是窗口尺寸，不留"看得见却点不动"的死区。
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

  // 穿透状态下收起来会很别扭（胶囊也要能点），先退出穿透
  if (passthrough) setPassthrough(false);

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

// Alt+滚轮调浓度（上滚更浓、下滚更淡）
ipcMain.on('vr-alpha-step', (e, dir) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || !win.__st) return;
  stepAlpha(win, dir > 0 ? 1 : -1);
});

// 面板上的「不用记住这个站点」
ipcMain.handle('vr-site-clear', () => {
  const win = currentOverlay();
  const key = siteKey(win ? win.__st.url : state.url);
  if (key && state.sitePrefs[key]) {
    delete state.sitePrefs[key];
    log('site pref cleared: ' + key);
    saveState();
  }
  notifyPanel();
  return panelState();
});

ipcMain.on('vr-prefs-ask', (e) => {  const win = BrowserWindow.fromWebContents(e.sender);
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
    // 顺带支持 --vr-veil=auto|light|dark：运行时切蒙版模式，
    // 自动化验证和"脚本一键换渲染方式"都靠它，不用去点面板。
    const openArg = Array.isArray(argv) ? argv.find((a) => /^--vr-open=/.test(a)) : null;
    const veilArg = Array.isArray(argv) ? argv.find((a) => /^--vr-veil=/.test(a)) : null;
    // --vr-summon-hotkey=Ctrl+Alt+K / --vr-summon=0|1：运行时改全局热键，
    // 走的是和面板完全相同的 setSummonAccel / setSummonEnabled，
    // 便于脚本切换和自动化验证"改键即时生效、失败能回退"。
    const hkArg = Array.isArray(argv) ? argv.find((a) => /^--vr-summon-hotkey=/.test(a)) : null;
    const sumArg = Array.isArray(argv) ? argv.find((a) => /^--vr-summon=/.test(a)) : null;
    // --vr-font-scale=1.4：运行时改正文字号，同样走面板那条 setFontScale
    const fontArg = Array.isArray(argv) ? argv.find((a) => /^--vr-font-scale=/.test(a)) : null;
    if (openArg) {
      const target = openArg.slice('--vr-open='.length);
      log('open requested by command line: ' + target.slice(0, 60));
      createOverlay(target);
      if (veilArg) setVeilMode(veilArg.slice('--vr-veil='.length));
      if (fontArg) {
        const w = currentOverlay();
        if (w) setFontScale(w, parseFloat(fontArg.slice('--vr-font-scale='.length)));
      }
      return;
    }
    if (veilArg) {
      setVeilMode(veilArg.slice('--vr-veil='.length));
      return;
    }
    if (fontArg) {
      const w = currentOverlay();
      const r = w
        ? setFontScale(w, parseFloat(fontArg.slice('--vr-font-scale='.length)))
        : { ok: false, error: 'no overlay window' };
      log('font scale by command line: ' + JSON.stringify(r));
      return;
    }
    if (hkArg) {
      const r = setSummonAccel(hkArg.slice('--vr-summon-hotkey='.length));
      log('summon hotkey by command line: ' + JSON.stringify(r));
      return;
    }
    const scrollArg = Array.isArray(argv) ? argv.find((a) => /^--vr-scroll-speed=/.test(a)) : null;
    if (scrollArg) {
      const v = parseFloat(scrollArg.slice('--vr-scroll-speed='.length));
      state.autoScrollSpeed = clamp(Number(v) || SCROLL_DEFAULT, SCROLL_MIN, SCROLL_MAX);
      const w = currentOverlay();
      if (w && !w.isDestroyed()) {
        try { w.webContents.send('vr-scroll-speed', state.autoScrollSpeed); } catch (_) {}
      }
      saveState();
      log('scroll speed by command line: ' + state.autoScrollSpeed);
      return;
    }
    if (sumArg) {
      const r = setSummonEnabled(sumArg.slice('--vr-summon='.length) !== '0');
      log('summon switch by command line: ' + JSON.stringify(r));
      return;
    }
    log('second launch detected, reusing the running instance');
    showPanel();
    const w = currentOverlay();
    if (w && !w.isDestroyed()) w.showInactive();
  });

  app.whenReady().then(() => {
    loadState();
    // --vr-quit 的双保险。
    // 正常路径是"第二个实例把 argv 交给已在运行的实例，由它自己退出"，
    // 但这里有个时序竞争：如果原实例退得太快、锁已经释放，
    // 这个带 --vr-quit 的进程反而会抢到锁、变成新的常驻实例 ——
    // 看起来就像"关不掉，还多了一个进程"。启动阶段自己再判一次，杜绝这种残留。
    if (process.argv.indexOf('--vr-quit') >= 0) {
      log('quit requested at startup, exiting before creating any window');
      try { saveState(); } catch (_) { /* ignore */ }
      app.quit();
      return;
    }
    createTray();
    startBarWatch();
    // 全局热键必须在 whenReady 之后注册（Electron 要求 app ready）。
    // 注册失败不阻断启动：面板照样能开，只是会在设置区用红字说明没抢到键。
    registerSummon();

    // 启动只打开控制面板，阅读层按需再开：
    // 双击桌面图标时不应该突然在屏幕上盖一层窗口 —— 用户可能只是想改个浓度、
    // 或者先看看最近看过什么。上次的网址已经由 state.url 带给面板，
    // 面板会自动填进输入框，回车一下就回到上次那页。
    // 想让它启动就自动开窗口，可设环境变量 VR_AUTOVIEW=1。
    showPanel();

    if (process.env.VR_AUTOVIEW === '1') {
      const saved = Array.isArray(state.tabs) ? state.tabs.filter((t) => t && t.url) : [];
      let restoreUrl = '';
      if (saved.length) {
        const idx = clamp(Number(state.activeTab) || 0, 0, saved.length - 1);
        restoreUrl = saved[idx].url || saved[0].url;
      } else if (state.url) {
        restoreUrl = state.url;
      }
      if (restoreUrl) createOverlay(restoreUrl);
    }
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
  try { globalShortcut.unregisterAll(); } catch (_) {}
  clearInterval(barTimer);
  barTimer = null;
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
});
