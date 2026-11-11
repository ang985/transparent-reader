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
// 先写临时文件再 rename（同盘 rename 是原子的），并保留一份上一版：
// 直接覆盖写的话，断电/崩溃/磁盘满会留下 0 字节或半截 JSON，
// 下次启动 JSON.parse 抛错 → 静默落回 DEFAULT_STATE，浓度、站点记忆、
// 热键、窗口位置全丢且无从恢复。
const STATE_TMP = STATE_FILE + '.tmp';
const STATE_BAK = STATE_FILE + '.bak';

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

// 页签 = 一个同尺寸的 BrowserWindow，同一时刻只显示 active 那一个。
// 之所以还用"多窗口伪装单窗口"而不是 WebContentsView：透明窗口 + 无边框这套
// 已经被验证过（WebContentsView 的透明合成不可控），preload 里的样式注入、
// 弹窗识别、查找、自动滚动全都不用改一行。
// 不变式：**任何时刻最多一个 overlays 里的窗口可见**。所有显示路径最终都要过
// activateTab / hideOtherOverlays，绕过它们就会复发"两个窗口叠在一起"。
const overlays = new Set();   // 所有页签窗口
let tabSeq = 0;               // 页签 id 自增
let activeTabId = null;       // 当前显示的页签
let overlayWin = null;        // 当前页签窗口（= activeTabId 对应的窗口，供既有代码复用）
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

// 读一个 state 文件：不存在 / 读不了 / 内容不是合法 JSON 对象，统一返回 null。
// 空文件也要当失败——那正是"覆盖写到一半断电"的典型产物。
function readStateFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function loadState() {
  const primary = readStateFile(STATE_FILE);
  let recoveredFromBak = false;
  if (primary) {
    state = { ...DEFAULT_STATE, ...primary };
  } else {
    // 主文件坏了（断电写坏 / 被外部改坏）→ 用上一次的备份救回来。
    // 不这么做的话，用户攒了很久的站点记忆、热键配置会被一把清空。
    const bak = readStateFile(STATE_BAK);
    if (bak) {
      state = { ...DEFAULT_STATE, ...bak };
      recoveredFromBak = true;
      log('state.json 不可用，已从 state.json.bak 恢复');
    } else {
      state = { ...DEFAULT_STATE };
      if (fs.existsSync(STATE_FILE)) log('state.json 与备份都不可用，使用默认配置');
    }
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

  // 从备份恢复后立刻把主文件修回去，否则每次启动都要再走一遍"读坏文件"。
  // 但必须先删掉那个坏文件：saveState 会先把当前 state.json 复制成 .bak，
  // 留着坏文件就把唯一的好备份也覆盖成坏的了 —— 那等于白备份。
  if (recoveredFromBak) {
    try { fs.unlinkSync(STATE_FILE); } catch (_) {}
    saveState();
  }
}

function saveState() {
  try {
    // 页签列表只在"非退出过程"里更新。
    // 退出时窗口会一个个销毁，这时任何一次落盘（包括防抖的那种）都会把
    // state.tabs 削成"还活着的那些"，最后只剩最后一个被关掉的 —— 下次启动
    // 就只恢复一个页签。退出前由 before-quit 先拍一份完整的快照并冻结。
    if (!tabsFrozen) {
      const list = [...overlays].filter((w) => !w.isDestroyed());
      if (list.length) {
        state.tabs = list.map((w) => ({ url: w.__st.url, title: w.__st.title || '' }));
        const idx = list.findIndex((w) => w.__st.tabId === activeTabId);
        state.activeTab = idx >= 0 ? idx : 0;
      }
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

    const json = JSON.stringify(state, null, 2);

    // 1) 先整份写进 .tmp，并 fsync。
    //    fsync 不能省：部分文件系统上 rename 会先落盘、数据块后落盘，
    //    断电后可能出现"文件名换了、内容是空的"。写完立刻 fsync 才真正安全。
    const fd = fs.openSync(STATE_TMP, 'w');
    try {
      fs.writeFileSync(fd, json, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // 2) 把上一版留成 .bak。用 copy 而不是 rename —— rename 会把主文件挪走，
    //    中间那一瞬主文件不存在，此刻崩溃就两头空。
    try {
      if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_BAK);
    } catch (_) { /* 备份失败不该阻断正常保存 */ }

    // 3) 原子替换：同盘 rename 要么全成、要么全不成，
    //    绝不会留下"主文件被截断成半截 JSON"的中间态。
    fs.renameSync(STATE_TMP, STATE_FILE);
  } catch (e) {
    log('saveState failed: ' + e.message);
    try { fs.unlinkSync(STATE_TMP); } catch (_) {}
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
  // dom-ready 和 did-finish-load 都会走到这里，原来每次都把整张基础样式表
  // 摘掉再插回去 —— 这是全页重绘，同一次导航里做两遍纯属浪费，而且正好
  // 撞上新窗口显示那一刻。内容由 hideImages/focus 决定，导航序号区分文档。
  const key = [win.__navSeq || 0, !!win.__st.hideImages, !!win.__st.focus].join('|');
  if (win.__cssAppliedKey === key && win.__cssKey) return;
  win.__cssAppliedKey = key;   // 先占位，挡住两个事件并发时的第二次插入
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
    win.__cssAppliedKey = null;   // 插入失败要让下一次有机会重试
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

  // 注意：这里**不再**复用已有窗口。每个网址 = 一个新页签（独立窗口），
  // 由 activateTab 保证同一时刻只有它一个可见。
  // 之前"换网址就 loadURL 复用同一个窗口"的设计会让新页面把原来的顶掉，
  // 用户想对照着看两篇就没办法了。
  const b = overlayBounds();
  // 创建时是否已经存在别的页签（此时还没把 win 加进 overlays）。
  // 后续页签一律由 activateTab 负责显示，见下面 reveal 里的判断。
  const hasExisting = overlays.size > 0;

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
    tabId: ++tabSeq,
    id: ++winSeq,
    title: '',
    url,
    dark: false,        // 当前页面是否按深色蒙版渲染（由 preload 上报）
    eff: state.alpha,   // 实际生效浓度（深色页有下限，可能大于 alpha）
  };

  win.setAlwaysOnTop(state.onTop !== false, state.onTop !== false ? 'screen-saver' : 'normal');
  win.__topLevel = state.onTop !== false ? 'screen-saver' : 'normal';
  win.setMenuBarVisibility(false);
  win.setSkipTaskbar(true);

  // 页面里的 target=_blank / window.open：在新页签里打开，当前页保持不动。
  // 原来这里是 win.loadURL(target) —— 点一个"在新窗口打开"的链接，
  // 正在读的那一页就被顶掉了，看起来就是"窗口被换掉"。
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target || '')) createOverlay(target);
    return { action: 'deny' };
  });

  win.webContents.on('dom-ready', () => { applyCSS(win); syncPagePrefs(win); sendTabs(); });
  win.webContents.on('did-finish-load', () => { applyCSS(win); syncPagePrefs(win); sendTabs(); });

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
    sendTabs();
    saveStateDebounced();
  });
  win.webContents.on('did-navigate', (_e, u) => {
    win.__st.url = u;
    // document 换了：之前 insertCSS 的表、补发给 preload 的偏好都随旧文档
    // 一起失效。清掉去重标记，随后的 dom-ready 才会重新插一次、重发一次。
    // SPA 的 did-navigate-in-page 不换 document，所以那边不清。
    win.__navSeq = (win.__navSeq || 0) + 1;
    win.__prefsSnap = null;
    win.__cssAppliedKey = null;
    win.__cssKey = null;
    win.__darkKey = null;
    // 换了站点就把该站点记住的浓度/缩放套上来；
    // 具体应用发生在随后的 dom-ready（applyCSS / syncPagePrefs）
    applySitePrefs(win, u);
    sendTabs();     // 有些站点的 title 不变，靠这次把"标题空着"的标签补上主机名
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
    // 已经有别的页签时，这个窗口由 createOverlay 末尾的 swap/activateTab
    // 统一显示。原来 ready-to-show 会先 raiseOverlay 一次、dom-ready 后
    // activateTab 又来一次、400ms 兜底再 raiseOverlay 一次 —— 三次显隐搅动，
    // 就是"已有窗口时打开新链接会闪"的主因。
    if (hasExisting) return;
    // 不是当前页签就别冒头：否则后台加载完的页签会自己跳出来，
    // 屏幕上立刻变成两个窗口叠着。
    if (win.__st.tabId !== activeTabId) return;
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
    // 兜底只负责"还没露出来"的情况。窗口已经可见时再 applyTop / moveTop
    // 只是白白搅动一次 z 序，透明窗口会因此重画一帧。
    if (!win.isVisible()) {
      win.showInactive();
      applyTop(win);
      win.moveTop();
    }
  };
  win.once('ready-to-show', reveal);
  // 透明窗口不一定会触发 ready-to-show，必须加时间兜底
  setTimeout(reveal, 400);
  setTimeout(reveal, 1600);

  win.on('focus', () => { lastActive = win; });
  win.on('resized', () => {
    if (win.isDestroyed() || win.__st.tabId !== activeTabId) return;
    const [w, h] = win.getSize();
    state.width = clamp(w, MIN_W, 1600);
    state.height = clamp(h, MIN_H, 1400);
    mirrorBounds(win);   // 其它页签跟着改成同样大小，切过去不会突然"变形"
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

  // 关闭当前页签时，先把下一个顶上来，再让这个窗口消失。
  // 反过来（等 closed 里再激活）会先露出桌面再出现新页面，看起来是"闪一下"。
  // 退出程序时例外：这时正在挨个销毁所有窗口，再"激活下一个"会把窗口重新
  // show 出来（退出时屏幕闪一下），也会让每个窗口的 closed 里反复改写 state.tabs，
  // 最后把整组页签缩成只剩一个 —— 下次启动就只恢复一个页签了。
  win.on('close', () => {
    if (quitting) return;
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
    const wasActive = !!(win.__st && win.__st.tabId === activeTabId);
    log('tab closed #' + (win.__st ? win.__st.tabId : '?') + ' wasActive=' + wasActive);
    overlays.delete(win);
    if (overlayWin === win) overlayWin = null;
    if (lastActive === win) lastActive = null;
    // 穿透状态跟着窗口走，别留一个指向已销毁窗口的全局热键
    if (passthrough) {
      passthrough = false;
      try { globalShortcut.unregister(PASSTHROUGH_ACCEL); } catch (_) {}
    }
    // 退出过程中整组窗口都在销毁：这时候既不该切页签，也不该落盘，
    // 否则 state.tabs 会被逐步削成"只剩最后关掉的那个"。
    if (!quitting) {
      if (wasActive) {
        activeTabId = null;
        // 兜底：close 事件里那一步没能切成（例如整组窗口同时在关），这里再试一次
        const next = [...overlays].find((w) => !w.isDestroyed());
        if (next) activateTab(next);
      }
      sendTabs();
      saveState();
      notifyPanel();
    }

    // 从面板打开网址时面板会隐藏让位。这时关掉最后一个阅读层，屏幕上就
    // 什么都不剩了（面板窗口对象还在，所以 window-all-closed 也不会触发），
    // 用户会以为程序卡死。这里把面板叫回来。
    // 注意只在"一个不剩"的时候叫：还有别的页签就不该弹面板。
    if (!quitting) {
      setTimeout(() => {
        if (quitting) return;
        if (overlays.size > 0) return;
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
    // Ctrl+Tab / Ctrl+Shift+Tab：切页签（和浏览器一致）。
    // 之所以必须放在主进程：切页签要把另一个窗口 show 出来并抢焦点，
    // 渲染层做不到跨窗口的事。
    if (input.control && !input.alt && !input.meta && key === 'tab') {
      event.preventDefault();
      cycleTab(input.shift ? -1 : 1);
      return;
    }
    // Ctrl+1..8 跳到第 n 个页签，Ctrl+9 跳最后一个（浏览器同款）
    if (input.control && !input.alt && !input.meta && !input.shift && /^[1-9]$/.test(key)) {
      const list = [...overlays].filter((w) => !w.isDestroyed());
      if (list.length > 1) {
        event.preventDefault();
        const idx = key === '9' ? list.length - 1 : Math.min(Number(key) - 1, list.length - 1);
        if (list[idx]) activateTab(list[idx]);
        return;
      }
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
  overlays.add(win);
  log('tab create #' + win.__st.tabId + ' activate=' + (opts.activate !== false) +
    ' total=' + overlays.size + ' resizable=' + win.isResizable() + ' ' + url.slice(0, 40));

  state.url = url;
  state.history = [url, ...state.history.filter((u) => u !== url)].slice(0, 20);

  // 立刻把新页签推给所有窗口，让已显示的那一页顶部马上多出一个标签，
  // 而不是等新页面加载完才出现（否则会觉得"点了没反应"）。
  sendTabs();

  if (opts.activate === false) {
    saveState();
    return win;
  }

  // 第一个页签必须立刻显示；后续新页签等页面**加载完**再切换。
  // 原来用 dom-ready + 60ms：真实站点那时 CSS/图片还在陆续到位、DOM 也在
  // 重排，切过去看到的就是半成品一点点补画，即用户说的"闪"。
  if (overlays.size === 1) {
    activateTab(win);
  } else {
    let switched = false;
    const swap = () => {
      if (switched || win.isDestroyed()) return;
      switched = true;
      activateTab(win);
    };
    win.webContents.once('did-finish-load', () => setTimeout(swap, 120));
    // 长连接 / SPA 可能一直不触发 did-finish-load，留个兜底
    setTimeout(swap, 3000);
  }
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

// 把「当前有哪些页签、谁是 active」推给所有阅读层窗口。
// 必须给每个窗口都发：页签条是各窗口自己画的（窗口之间不共享 DOM）。
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

// 拖动/缩放当前页签后，把其它页签的窗口摆到同一位置同一尺寸。
// 不做这一步，切过去的页签会停在旧位置，看起来像"跳到别处去了"。
function mirrorBounds(win) {
  const b = overlayBounds();
  for (const w of overlays) {
    if (w === win || w.isDestroyed()) continue;
    try {
      w.setBounds({ x: b.x, y: b.y, width: b.w, height: b.h });
    } catch (_) {}
  }
}

// 保证任何时刻最多只有一个浮层窗口可见。keep 传 null 表示全部隐藏。
function hideOtherOverlays(keep) {
  for (const w of overlays) {
    if (!w || w === keep || w.isDestroyed()) continue;
    try { if (w.isVisible()) w.hide(); } catch (_) { /* ignore */ }
  }
}

// 切页签的顺序：先把新窗口显示出来，**同一步里**把其它页签藏掉。
// 顺序绝不能反 —— 先藏旧的再显示新的，中间会漏出一帧桌面（抓帧抓到过整屏壁纸）。
//
// 这段历史值得记一下，免得以后又走回头路。试过三种"等新窗口画好了再藏旧的"：
//   1. 两次 rAF 当信号：Chromium 对被遮挡窗口的 rAF 不是帧同步的，
//      没出帧也会回调，等于没等；
//   2. capturePage() 预热：不会强制整页光栅化，反而让切换多等 200ms；
//   3. 固定延时 240ms：两个窗口同屏 240ms，两张半透明页面叠在一起是"糊"，
//      比闪一下更难看（用户会读成两页文字搅在一起）。
// 实测（520×780 纯文本页，逐帧采样）：show 之后约 110ms 新页签已完成 92%，
// 300ms 完全稳定。这期间旧窗口已经藏掉，屏幕上只是新页面在补剩余像素，
// 既没有桌面、也没有重影。所以：立即藏，只留一个"还是不是当前页签"的判断，
// 防止等待期间用户又切走了，反过来把当前页签藏掉。
function hideOtherTabs(win) {
  if (!win || win.isDestroyed() || !win.__st) return;
  if (activeTabId !== win.__st.tabId) return;
  hideOtherOverlays(win);
}

// 切到某个页签：摆位置 → 显示并拿焦点 → 藏掉其它 → 广播页签列表。
// 顺序不能反：先显示新的再隐藏旧的，中间那一帧才不会露出桌面。
function activateTab(win) {
  if (!win || win.isDestroyed() || !win.__st) return;
  const mine = win.__st.tabId;

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

  // 置顶层级只有变化时才重新设置：同一个值再设一次会走一遍 SetWindowPos，
  // 透明窗口会因此重画一帧 —— 切页签时的"闪"有它一份。
  const wantTop = state.onTop !== false;
  const wantLevel = wantTop ? 'screen-saver' : 'normal';
  if (win.__topLevel !== wantLevel) {
    win.setAlwaysOnTop(wantTop, wantLevel);
    win.__topLevel = wantLevel;
  }

  activeTabId = mine;
  overlayWin = win;
  lastActive = win;

  // 切页签是用户主动操作，焦点必须跟过来；只 moveTop 会让键盘还留在旧窗口上。
  if (!win.isVisible()) win.show();
  win.moveTop();
  try { win.focus(); } catch (_) { /* ignore */ }
  try { win.webContents.focus(); } catch (_) { /* ignore */ }
  // show() 之后同一步里就把别的窗口收掉（顺序反了会漏一帧桌面，见 hideOtherTabs 注释）
  hideOtherTabs(win);

  // 这个页签在后台待着的时候，用户可能改过全局设置（浓度、字号、蒙版、
  // 自动滚动速度），切回来得把这些补发一次，否则它还是创建时那套旧参数。
  syncPagePrefs(win);

  log('tab activate #' + mine + ' visible=' + win.isVisible() +
    ' top=' + win.isAlwaysOnTop() + ' total=' + overlays.size);

  // 只在"真的被别的置顶窗口压下去"时才补抬一次；
  // 无条件 applyTop + moveTop 会平白搅动一次 z 序，同样会闪。
  setTimeout(() => {
    if (win.isDestroyed() || activeTabId !== mine) return;
    if (state.onTop !== false && !win.isAlwaysOnTop()) {
      applyTop(win);
      win.moveTop();
    }
  }, 300);

  // 页签列表要在三个时间点各补发一次：窗口刚创建时 preload 可能还没注册监听，
  // 只发一次会丢，表现就是"页签条永远是空的 / 少一个标签"。
  // 页签条那边会按内容去重，同样的列表不会重复重建 DOM。
  sendTabs();
  setTimeout(sendTabs, 700);
  setTimeout(sendTabs, 2000);
  saveState();
  notifyPanel();
}

function tabById(id) {
  const n = Number(id);
  for (const w of overlays) {
    if (!w.isDestroyed() && w.__st && w.__st.tabId === n) return w;
  }
  return null;
}

// Ctrl+Tab / Ctrl+Shift+Tab：按创建顺序循环切页签。
function cycleTab(dir) {
  const list = [...overlays].filter((w) => !w.isDestroyed());
  if (list.length < 2) return;
  const cur = list.findIndex((w) => w.__st.tabId === activeTabId);
  const from = cur >= 0 ? cur : 0;
  const next = list[(from + (dir > 0 ? 1 : -1) + list.length) % list.length];
  if (next) activateTab(next);
}

function applyTop(win) {
  if (!win || win.isDestroyed()) return;
  const on = state.onTop !== false;
  const level = on ? 'screen-saver' : 'normal';
  if (win.__topLevel === level) return;   // 同值重设会白重画一帧
  try {
    win.setAlwaysOnTop(on, level);
    win.__topLevel = level;
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
    // 已经是置顶就别再设一遍：setAlwaysOnTop 会走 SetWindowPos，透明窗口
    // 会因此重画一帧，热键连按时看着就是"闪"。
    if (!win.isAlwaysOnTop()) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.__topLevel = 'screen-saver';
    }
    win.moveTop();
    // 被抬起来的这一扇就是新的当前页签 —— 先把指针改过来，
    // 后面 hideOtherTabs 才会按"当前页签"去收其它窗口。
    if (win.__st) {
      activeTabId = win.__st.tabId;
      overlayWin = win;
      lastActive = win;
    }
    // 多页签时把其它 tab 的窗口收起来，避免叠窗。
    // 这一句是"最多一个浮层可见"不变式的最后一道保险 —— 任何显示路径
    // 最终都会走到 raiseOverlay，漏掉这里就会有第二个窗口留在屏幕上。
    hideOtherTabs(win);
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
          win.__topLevel = 'normal';
        } catch (_) {}
      }
    }, 1200);
  }
  log('raise overlay #' + (win.__st ? win.__st.id : '?') + ' onTop=' + (state.onTop !== false));
  return true;
}

function currentOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  // 兜底：激活指针可能因为异常路径丢了（例如 close 与 closed 交错），
  // 这时退回"任意一个还活着的页签"，别让热键/面板以为没有阅读层。
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
  // 切页签、关页签、打开新链接都会调到这里。原来无条件重设缩放并补发
  // 7 条 IPC，渲染层收到 vr-alpha 就重写整页样式规则 —— 等于每次都整页重绘。
  // 值没变就整批跳过；导航后 __navSeq 变了（或 __prefsSnap 被清空）才重发，
  // 保证新 document 的 preload 仍能拿到正确初值。
  const snap = [
    win.__navSeq || 0, z, !!state.barAlways, win.__st.alpha,
    win.__st.fontScale || 1, state.veilMode || 'auto', state.autoScrollSpeed,
  ].join('|');
  if (win.__prefsSnap === snap) return;
  win.__prefsSnap = snap;
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
  // 全局设置：所有页签窗口都要跟上，否则切到别的页签会看到旧模式
  for (const w of overlays) {
    if (w.isDestroyed()) continue;
    try { w.webContents.send('vr-veil-mode', state.veilMode); } catch (_) {}
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
        // 每个页签窗口各自有置顶状态，必须逐个改；只改当前那个的话，
        // 切到别的页签会发现"置顶设置没生效"。
        for (const w of overlays) { if (!w.isDestroyed()) applyTop(w); }
        const cur = currentOverlay();
        if (cur && state.onTop) cur.moveTop();
        saveState();
        notifyPanel();
      } },
      { type: 'separator' },
      { label: '关闭当前页签', enabled: has, click: () => { const w = currentOverlay(); if (w) w.close(); } },
      { label: '关闭全部页签', enabled: overlays.size > 0, click: () => { for (const w of [...overlays]) if (!w.isDestroyed()) w.close(); } },
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
    // 置顶是窗口级状态，每个页签窗口都得改一遍
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
  if (key === 'veilMode') {
    setVeilMode(val);
    return { ok: true };
  }
  if (key === 'lockSize') {
    state.lockSize = !!val;
    for (const w of overlays) {
      if (w.isDestroyed()) continue;
      try {
        w.setResizable(!state.lockSize);
      } catch (_) {}
    }
    log('lockSize=' + state.lockSize + ' applied to ' + overlays.size + ' window(s)');
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
    for (const w of overlays) {
      if (w.isDestroyed()) continue;
      w.__st[key] = !!val;
      refresh(w);
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

// ---------------- 页签 ----------------
// 页签条是渲染层画的，这三条只是"用户的点击 → 主进程动作"的转发。
ipcMain.on('vr-tab-activate', (_e, id) => {
  const w = tabById(id);
  if (w) activateTab(w);
});

ipcMain.on('vr-tab-close', (_e, id) => {
  const w = tabById(id);
  if (w) w.close();
});

// 「+」不直接开空白页（没有地址栏可填），把控制面板叫出来让用户输网址
ipcMain.on('vr-tab-new', () => { showPanel(); });

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
  // 收起时要隐藏**所有**页签窗口，不只是当前这个：多页签下每个 tab 都是
  // 独立窗口，漏掉一个就会留下「胶囊 + 旧窗口」同屏的错乱状态。
  miniWin = makeMiniWindow(() => { hideOtherOverlays(null); });
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
    // 先让这一扇显示出来，再收其它窗口 —— 顺序反了会先露一帧桌面
    hideOtherTabs(win);
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
    // 排查"切页签要几百毫秒才画完"这类问题时，先确认到底走的是 GPU 还是软件光栅。
    // 软件光栅下大页面重绘会慢一个数量级，症状和这里很像。
    if (process.env.VR_DIAG === '1') {
      // 刚 ready 时 GPU 进程可能还没起来，这里查到的会是 software —— 延后再查一次。
      setTimeout(() => {
        try { log('gpu: ' + JSON.stringify(app.getGPUFeatureStatus())); } catch (_) {}
      }, 3000);
    }
    createTray();
    startBarWatch();
    // 全局热键必须在 whenReady 之后注册（Electron 要求 app ready）。
    // 注册失败不阻断启动：面板照样能开，只是会在设置区用红字说明没抢到键。
    registerSummon();

    // 首次启动也认 --vr-open。这条参数原本只在 second-instance（已有实例）里处理，
    // 第一个进程带着它会被无声忽略 —— 拿它做自动化/脚本时非常困惑。
    const openAtBoot = process.argv.find((a) => /^--vr-open=/.test(a));
    if (openAtBoot) {
      const target = openAtBoot.slice('--vr-open='.length);
      log('open requested at startup: ' + target.slice(0, 60));
      createOverlay(target);
      return;
    }

    // 启动只打开控制面板，阅读层按需再开：
    // 双击桌面图标时不应该突然在屏幕上盖一层窗口 —— 用户可能只是想改个浓度、
    // 或者先看看最近看过什么。上次的网址已经由 state.url 带给面板，
    // 面板会自动填进输入框，回车一下就回到上次那页。
    // 想让它启动就自动开窗口，可设环境变量 VR_AUTOVIEW=1。
    showPanel();

    if (process.env.VR_AUTOVIEW === '1') {
      // 恢复上次的整组页签：只有 active 那个走 activate（立刻显示），
      // 其它以 activate:false 建好但保持隐藏 —— 一次开出好几个可见窗口，
      // 就是"两个窗口叠在一起"的来源。
      const saved = Array.isArray(state.tabs) ? state.tabs.filter((t) => t && t.url) : [];
      const list = saved.length ? saved : (state.url ? [{ url: state.url }] : []);
      if (list.length) {
        const active = clamp(Number(state.activeTab) || 0, 0, Math.max(0, list.length - 1));
        list.forEach((t, i) => createOverlay(t.url, { activate: i === active }));
      }
    }
  });
}

let quitting = false;
let tabsFrozen = false;   // 退出流程中冻结 state.tabs，见 saveState 里的说明
let lastClosedKind = '';
app.on('before-quit', () => {
  quitting = true;
  // 这一刻所有页签窗口都还活着，是唯一能拿到完整列表的时机。
  // 先按当前窗口拍快照落盘，再冻结，后面关窗过程中的落盘都不会再动它。
  try { saveState(); } catch (_) { /* ignore */ }
  tabsFrozen = true;
});

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
