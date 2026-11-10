"""窗口探测 + 按键注入（Windows / x64），用于验证悬浮阅读层的多页签行为。

用法：
  python probe.py list                    列出所有可见顶层窗口（标题/进程/矩形）
  python probe.py epids                   列出所有 electron.exe 的 pid
  python probe.py focus                   打印当前前台窗口标题
  python probe.py key ctrl+tab
  python probe.py key ctrl+shift+tab
  python probe.py key esc
  python probe.py key alt+q
"""
import ctypes
import ctypes.wintypes as wt
import json
import subprocess
import sys

user32 = ctypes.WinDLL('user32', use_last_error=True)

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, wt.LPARAM]
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.GetForegroundWindow.restype = wt.HWND


class RECT(ctypes.Structure):
    _fields_ = [('left', ctypes.c_long), ('top', ctypes.c_long),
                ('right', ctypes.c_long), ('bottom', ctypes.c_long)]


def _title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if not n:
        return ''
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def list_windows(only_visible=True):
    out = []

    def cb(hwnd, _lp):
        vis = bool(user32.IsWindowVisible(hwnd))
        if only_visible and not vis:
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        r = RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        out.append({
            'hwnd': int(hwnd),
            'pid': pid.value,
            'title': _title(hwnd),
            'visible': vis,
            'rect': [r.left, r.top, r.right - r.left, r.bottom - r.top],
        })
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return out


def electron_pids():
    """用 tasklist 拿 electron.exe 的 pid（避免依赖 psutil）。"""
    try:
        txt = subprocess.check_output(['tasklist', '/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'],
                                      stderr=subprocess.DEVNULL).decode('gbk', 'ignore')
    except Exception:
        return set()
    pids = set()
    for line in txt.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == 'electron.exe':
            try:
                pids.add(int(parts[1]))
            except ValueError:
                pass
    return pids


# ---------------- 按键注入 ----------------
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008

VK = {
    'ctrl': 0x11, 'shift': 0x10, 'alt': 0x12, 'win': 0x5B,
    'tab': 0x09, 'esc': 0x1B, 'enter': 0x0D, 'space': 0x20,
    'f': 0x46, 'q': 0x51, 'p': 0x50, 't': 0x54, 's': 0x53, 'r': 0x52,
    'w': 0x57, 'a': 0x41, 'b': 0x42, 'g': 0x47,
}
for _d in '1234567890':
    VK[_d] = 0x30 + int(_d)


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wt.WORD), ('wScan', wt.WORD), ('dwFlags', wt.DWORD),
                ('time', wt.DWORD), ('dwExtraInfo', ctypes.c_void_p)]


class _U(ctypes.Union):
    _fields_ = [('ki', KEYBDINPUT), ('pad', ctypes.c_byte * 32)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', wt.DWORD), ('u', _U)]


user32.SendInput.argtypes = [wt.UINT, ctypes.POINTER(INPUT), ctypes.c_int]


def _send(vk, up=False):
    inp = INPUT(type=INPUT_KEYBOARD)
    inp.u.ki = KEYBDINPUT(wVk=vk, wScan=0,
                          dwFlags=KEYEVENTF_KEYUP if up else 0,
                          time=0, dwExtraInfo=None)
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', ctypes.c_long), ('dy', ctypes.c_long), ('mouseData', wt.DWORD),
                ('dwFlags', wt.DWORD), ('time', wt.DWORD), ('dwExtraInfo', ctypes.c_void_p)]


def _mouse(flags):
    inp = INPUT(type=0)   # 0 = INPUT_MOUSE
    inp.u.pad = (ctypes.c_byte * 32)()
    mi = MOUSEINPUT(0, 0, 0, flags, 0, None)
    ctypes.memmove(ctypes.byref(inp.u), ctypes.byref(mi), ctypes.sizeof(mi))
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


def press(combo):
    keys = [k.strip().lower() for k in combo.split('+') if k.strip()]
    vks = []
    for k in keys:
        if k not in VK:
            raise SystemExit('unknown key: ' + k)
        vks.append(VK[k])
    for vk in vks:
        _send(vk, False)
    for vk in reversed(vks):
        _send(vk, True)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    if cmd == 'activate':
        # 按标题（子串）把那扇窗口拿到前台：测试里不依赖鼠标点击坐标
        want = sys.argv[2]
        rows = [r for r in list_windows(only_visible=False) if want in r['title'] and r['visible']]
        if not rows:
            print('not found: ' + want)
            return
        hwnd = rows[0]['hwnd']
        user32.ShowWindow(hwnd, 9)          # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
        user32.SetFocus(hwnd)
        import time
        time.sleep(0.3)
        print(json.dumps({'hwnd': hwnd, 'foreground': _title(user32.GetForegroundWindow())}, ensure_ascii=False))
    elif cmd == 'list':
        rows = list_windows()
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    elif cmd == 'epids':
        print(json.dumps(sorted(electron_pids())))
    elif cmd == 'focus':
        hwnd = user32.GetForegroundWindow()
        print(json.dumps({'hwnd': int(hwnd), 'title': _title(hwnd)}, ensure_ascii=False))
    elif cmd == 'key':
        press(sys.argv[2])
        print('sent ' + sys.argv[2])
    elif cmd == 'click':
        x, y = int(sys.argv[2]), int(sys.argv[3])
        user32.SetCursorPos(x, y)
        import time
        time.sleep(0.15)
        _mouse(0x0002 if len(sys.argv) < 5 else 0x0002)  # LEFTDOWN（下面再补 UP）
        _mouse(0x0004)
        print('click %d,%d' % (x, y))
    elif cmd == 'move':
        x, y = int(sys.argv[2]), int(sys.argv[3])
        user32.SetCursorPos(x, y)
        print('move %d,%d' % (x, y))
    else:
        print('unknown cmd: ' + cmd)


if __name__ == '__main__':
    main()
