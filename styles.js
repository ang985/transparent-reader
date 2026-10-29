'use strict';

function parts() {
  const base = `
html, body { background-color: transparent !important; background-image: none !important; }
/* [data-vr-raw] 是 preload 认定的答题卡格子：它们的原始背景（纯色或背景图）
   就是"答对/答错/已答"的载体，一旦被刷透明状态就全丢了，所以这里必须放行。 */
body, body *:not(html):not(body):not([data-vr-raw]) { background-color: transparent !important; background-image: none !important; }
body, body * { text-shadow: var(--vr-shadow, 0 0 1px rgba(255,255,255,.95), 0 0 3px rgba(255,255,255,.8)) !important; }
body, p, div, span, li, td, th, dd, dt, a, em, strong, b, i, u, h1, h2, h3, h4, h5, h6, pre, code, blockquote, label, button, input, textarea, select, small, time, cite {
  color: #16181d !important;
  font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif !important;
  line-height: 1.75 !important;
}
h1, h2, h3, h4 { color: #000 !important; letter-spacing: 0 !important; }
a, a * { color: #0b4ea2 !important; text-decoration: none !important; }
::selection { background: rgba(11,78,162,.22) !important; }
a, area, img, [draggable="true"] { -webkit-user-drag: none !important; }
/* 左侧不加内边距：真实浏览器也不会替页面加边距。
   顶部要让出工具条那 30px（工具条悬浮在页面之上，不让位就压住页面标题），
   但让位方式必须看页面的滚动结构，加错地方会多出一条外层滚动条：
     - 文档流滚动 → 给 body 加 padding-top（下面的 .vr-pad-body）
     - 内部滚动容器（height:100vh; overflow:auto 的那种）
       → body 一加 padding 就把页面撑高 30px，外面又多一条滚动条，
         横向滚动条也会被推到内容最底部，得滚到底才看得见。
         这种情况由 preload 的 decidePad() 直接把 padding 加到那个容器上。
   --vr-bar-pad 由 preload 按当前缩放算出（物理高度恒 30px）。 */
body {
  padding: 0 !important;
  font-size: 15.5px !important;
  margin: 0 !important;
}
html.vr-pad-body body {
  padding-top: var(--vr-bar-pad, 30px) !important;
  box-sizing: border-box !important;
}
* { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
/* 滚动条：可见部分很细，但命中区宽 12px，贴着窗口边也容易抓稳 */
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-thumb {
  background-color: rgba(0,0,0,.22);
  background-clip: content-box;
  border: 2px solid transparent;
  border-radius: 8px;
  min-height: 28px;
}
::-webkit-scrollbar-thumb:hover { background-color: rgba(0,0,0,.38); }
::-webkit-scrollbar-thumb:active { background-color: rgba(0,0,0,.5); }
::-webkit-scrollbar-track { background: rgba(0,0,0,.035); }
::-webkit-scrollbar-track:hover { background: rgba(0,0,0,.06); }
::-webkit-scrollbar-corner { background: transparent; }
/* 页面只比窗口宽一点点时（页脚、导航条硬撑），不要横条，直接裁掉 */
html.vr-clip-x, html.vr-clip-x body { overflow-x: hidden !important; }
`;

  // 表单控件、按钮、弹窗卡片必须留下可见的底和边，
  // 否则勾选框、输入框、弹窗都会变成"看不见但能点"的空白区域。
  const controls = `
input:not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="range"]),
textarea, select {
  background-color: rgba(255,255,255,.94) !important;
  border: 1px solid rgba(0,0,0,.28) !important;
  border-radius: 4px !important;
  padding: 3px 8px !important;
}
input[type="checkbox"], input[type="radio"] {
  -webkit-appearance: checkbox !important;
  appearance: auto !important;
  width: 14px !important;
  height: 14px !important;
  min-width: 14px !important;
  min-height: 14px !important;
  margin: 0 6px 0 0 !important;
  vertical-align: -2px !important;
  background-color: #fff !important;
  border: 1px solid rgba(0,0,0,.55) !important;
  border-radius: 2px !important;
  accent-color: #0b4ea2 !important;
  opacity: 1 !important;
  visibility: visible !important;
}
input[type="radio"] { border-radius: 50% !important; }
body [data-vr-check] {
  background-color: #fff !important;
  background-image: none !important;
  border: 1px solid rgba(0,0,0,.62) !important;
  border-radius: 2px !important;
  box-sizing: border-box !important;
  display: inline-block !important;
  position: relative !important;
  vertical-align: -2px !important;
}
body [data-vr-check][class*="checked" i],
body [data-vr-check][class*="active" i],
body [data-vr-check][class*="selected" i] {
  background-color: #2b6cff !important;
  border-color: #2b6cff !important;
}
body [data-vr-check][class*="checked" i]::after,
body [data-vr-check][class*="active" i]::after,
body [data-vr-check][class*="selected" i]::after {
  content: '' !important;
  position: absolute !important;
  left: 32% !important;
  top: 20% !important;
  width: 38% !important;
  height: 20% !important;
  border-left: 2px solid #fff !important;
  border-bottom: 2px solid #fff !important;
  transform: rotate(-45deg) !important;
}
button, [role="button"], input[type="submit"], input[type="button"] {
  background-color: rgba(255,255,255,.92) !important;
  border: 1px solid rgba(0,0,0,.26) !important;
  border-radius: 4px !important;
  padding: 2px 12px !important;
  color: #16181d !important;
}
body [data-vr-card] {
  background-color: rgba(253,253,255,.975) !important;
  border: 1px solid rgba(0,0,0,.20) !important;
  border-radius: 8px !important;
  box-shadow: 0 12px 40px rgba(0,0,0,.32), 0 0 0 1px rgba(255,255,255,.5) inset !important;
}
body [data-vr-card] * { text-shadow: none !important; }

/* 答题卡格子（preload 按状态盖章）：内部的数字要跟着格子的字色走，
   否则会被上面统一的深色字压成黑色，在深色底上反而看不清。
   这类格子底下已经有明确色块，白边光晕只会让数字发糊，直接关掉。 */
body [data-vr-cell] { line-height: 1.2 !important; }
body [data-vr-cell], body [data-vr-cell] * {
  color: inherit !important;
  text-shadow: none !important;
}
`;

  const images = `
img, picture, video, canvas, iframe, object, embed, figure,
[style*="background-image"]:not(html):not(body):not([data-vr-card]):not([data-vr-raw]),
[style*="background: url"]:not(html):not(body):not([data-vr-card]):not([data-vr-raw]) { display: none !important; }
`;

  const focus = `
header, footer, nav, aside, [role="banner"], [role="navigation"], [role="complementary"],
[class*="advert"], [id*="advert"], [class*="ads-"], [class*="-ads"], [class*="ad-"],
[class*="cookie"], [class*="sidebar"], [class*="share"],
[class*="recommend"], [class*="related"], [class*="comment"] { display: none !important; }
`;

  return { base: base + controls, images, focus };
}

function buildCSS(st) {
  const p = parts();
  let css = p.base;
  if (st.hideImages) css += p.images;
  if (st.focus) css += p.focus;
  return css;
}

function layoutOnly() {
  return `
html, body { background-color: transparent !important; }
`;
}

module.exports = { buildCSS, layoutOnly, parts };
