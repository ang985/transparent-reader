# Transparent Reader · 悬浮阅读层

A transparent, always-on-top reading overlay built with Electron: it strips the page background, keeps the text crisp, and floats above other windows — handy for reading news or doing quizzes without drawing attention.

一个基于 Electron 的透明悬浮阅读窗口：把任意网页"抠掉背景、留下文字"，悬浮在其它窗口之上，适合低调地阅读新闻、刷题。

**English** · [简体中文](#简体中文)

![platform](https://img.shields.io/badge/platform-Windows-blue) ![electron](https://img.shields.io/badge/electron-33.x-green) ![license](https://img.shields.io/badge/license-MIT-blue)

---

## English

### Features

- **Transparent reading layer** — page backgrounds are wiped out while text stays sharp and readable (with a subtle text-shadow halo), floating above other applications
- **One reading layer, one window** — opening another URL navigates the same overlay instead of stacking a second window; back / forward / reload built into the toolbar, last page restored on launch
- **Opacity & focus controls** — a settings panel to adjust background opacity, hide images, and enable focus mode
- **Answer-sheet state detection** — on quiz sites (e.g. Fenbi) answer grids are colour-coded as correct / wrong / answered
- **Collapse to a pill** — shrink the whole window into a 244×34 pill parked in a screen corner; double-click or hotkey to expand
- **`Alt+Q` shortcut** — implemented on `before-input-event`, so it survives page navigation; no system-wide hotkey is registered
- **`Ctrl` + wheel zoom** — zoom the page while the top toolbar keeps its physical size
- **Window controls** — always-on-top toggle, size lock, always-visible toolbar, temporary top-most raise

### Quick start

```bash
# install dependencies
npm install

# run
npm start
```

> Requires Electron 33.x; the first install downloads roughly 100 MB of runtime.
> Set the `ELECTRON_CACHE` environment variable to keep the cache on another drive.

> **Windows only.** The launcher scripts (`.bat`, `.ps1`) and the window-transparency helper are Windows-specific.
> Data is stored under `%APPDATA%\transparent-reader` unless you point `VR_DATA_DIR` somewhere else.

### Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Q` | Collapse to the pill / expand again (while the overlay or the pill has focus) |
| `Ctrl` + wheel | Zoom the page (the toolbar does not zoom) |
| `Alt+←` / `Alt+→` | Go back / forward |

### Project structure

```
transparent-reader/
├── main.js               # main process: window / tray / pill / persistence
├── preload-overlay.js    # overlay injection: toolbar, frame, transparency, answer-grid
├── preload-panel.js      # settings panel bridge
├── preload-mini.js       # collapsed pill bridge
├── styles.js             # injected CSS (transparency, inputs, scrollbars)
├── panel.html            # settings panel
├── mini.html             # collapsed pill
└── tools/                # helper scripts
```

### Notes from the trenches

Things that actually bit me while building this:

- A `transparent: true` window does not reliably fire `ready-to-show` — a timed fallback `showInactive()` is required
- `insertCSS` must use the default author origin; user origin overrides inline `!important` in the page and silently breaks the opacity slider
- When collapsing to the pill, create the pill **before** hiding the main window; when expanding, show the main window **before** destroying the pill — the intermediate "zero windows" moment triggers `window-all-closed` and kills the app
- Shortcuts that must always work belong in the main process `before-input-event`, not a page-level `keydown` listener (navigation, iframes and rich-text editors all swallow key events)
- An off-screen probe element used to parse colours must set values with `style.setProperty(..., 'important')`, otherwise the global transparent rules override it and every colour reads back as `transparent`

### License

MIT

---

## 简体中文

### 功能特性

- **透明阅读层**：网页背景被抹掉，文字保留清晰可读（带光晕描边），浮在其它应用之上
- **单窗口单页面**：换网址只在同一个阅读层里跳转，不会叠出第二个窗口；工具条带前进 / 后退 / 刷新，启动恢复上次页面
- **浓度与专注**：控制面板可调背景浓度、隐藏图片、开启专注模式
- **答题卡状态识别**：刷题网站（如粉笔）答题卡按对 / 错 / 已答自动着色标识
- **收起为小胶囊**：一键收成 244×34 的小胶囊挂在屏幕角落，双击或快捷键展开
- **`Alt+Q` 快捷收起**：基于 `before-input-event` 实现，页面跳转不影响，不注册系统级热键
- **Ctrl+滚轮缩放**：页面缩放时顶部工具条保持物理尺寸不变
- **窗口控制**：始终置顶开关、锁定窗口大小、工具条常亮、临时置顶唤回

### 快速开始

```bash
# 安装依赖
npm install

# 启动
npm start
```

> 依赖 Electron 33.x，首次安装会下载约 100MB 的运行时。
> 可通过环境变量 `ELECTRON_CACHE` 把缓存指到其它盘。

> **仅支持 Windows**：启动脚本（`.bat`、`.ps1`）与窗口透明化辅助脚本都是 Windows 专用。
> 运行数据默认存放在 `%APPDATA%\transparent-reader`，可用 `VR_DATA_DIR` 指定到别处。

### 快捷键

| 快捷键 | 作用 |
|---|---|
| `Alt+Q` | 收起为小胶囊 / 再按恢复（焦点在阅读层或胶囊上时） |
| `Ctrl+滚轮` | 页面缩放（工具条不跟着缩放） |
| `Alt+←` / `Alt+→` | 页面后退 / 前进 |

### 项目结构

```
transparent-reader/
├── main.js               # 主进程：窗口/托盘/胶囊/状态持久化
├── preload-overlay.js    # 阅读层注入：工具条/描边/透明化/答题卡识别
├── preload-panel.js      # 控制面板桥接
├── preload-mini.js       # 小胶囊桥接
├── styles.js             # 注入页面的 CSS（透明化/输入框/滚动条等）
├── panel.html            # 控制面板
├── mini.html             # 收起后的小胶囊
└── tools/                # 辅助脚本
```

### 技术要点（踩坑记录）

- 透明窗口（`transparent: true`）不一定触发 `ready-to-show`，需要定时兜底显示
- `insertCSS` 必须用默认 author origin —— user origin 会压过页面内联的 `!important`，导致浓度调节失效
- 收起胶囊时必须**先建胶囊再隐藏主窗**、展开时**先显示主窗再销毁胶囊**，否则中间的"零窗口"瞬间会触发 `window-all-closed` 把程序退掉
- "稳定生效"的快捷键应放在主进程 `before-input-event`，而不是页面的 `keydown`（导航、iframe、富文本都会吞事件）
- 解析页面颜色的探针元素要用 `style.setProperty(..., 'important')` 写入，否则会被全局透明规则覆盖导致读到的永远是 transparent

### 许可证

MIT
