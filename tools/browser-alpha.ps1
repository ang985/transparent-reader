# 窗口透明工具 —— 让 Edge / Chrome 等任意窗口整体半透明，且不影响点击与输入
# 原理：给目标窗口加上 WS_EX_LAYERED 扩展样式 + SetLayeredWindowAttributes 设置整体 alpha
# 注意：本文件必须保存为 UTF-8 带 BOM，否则 PowerShell 5.1 按 ANSI 读取会导致中文乱码

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('WinAlpha' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class WinAlpha
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint crKey, byte bAlpha, uint dwFlags);
}
'@
}

$GWL_EXSTYLE      = -20
$WS_EX_LAYERED    = 0x80000
$WS_EX_TRANSPARENT = 0x20
$LWA_ALPHA        = 0x2

$script:target = [IntPtr]::Zero
$script:countdown = 0

function Get-TargetTitle {
    param([IntPtr]$h)
    if ($h -eq [IntPtr]::Zero) { return '(未选择窗口)' }
    try {
        $p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -eq $h } | Select-Object -First 1
        if ($p) {
            $t = $p.MainWindowTitle
            if ([string]::IsNullOrWhiteSpace($t)) { $t = $p.ProcessName }
            return ($p.ProcessName + '  ·  ' + $t)
        }
    } catch { }
    return '(窗口 ' + $h.ToString() + ')'
}

function Set-Alpha {
    param([IntPtr]$h, [int]$percent, [bool]$penetrate)
    if ($h -eq [IntPtr]::Zero) { return }
    $ex = [WinAlpha]::GetWindowLong($h, $GWL_EXSTYLE)
    $new = $ex -bor $WS_EX_LAYERED
    if ($penetrate) {
        $new = $new -bor $WS_EX_TRANSPARENT
    } else {
        $new = $new -band (-bnot $WS_EX_TRANSPARENT)
    }
    [void][WinAlpha]::SetWindowLong($h, $GWL_EXSTYLE, $new)

    $v = [int]([math]::Round($percent * 255 / 100))
    if ($v -lt 20) { $v = 20 }
    if ($v -gt 255) { $v = 255 }
    [void][WinAlpha]::SetLayeredWindowAttributes($h, 0, [byte]$v, $LWA_ALPHA)
}

function Clear-Alpha {
    param([IntPtr]$h)
    if ($h -eq [IntPtr]::Zero) { return }
    $ex = [WinAlpha]::GetWindowLong($h, $GWL_EXSTYLE)
    $new = ($ex -band (-bnot $WS_EX_LAYERED)) -band (-bnot $WS_EX_TRANSPARENT)
    [void][WinAlpha]::SetWindowLong($h, $GWL_EXSTYLE, $new)
}

$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = '窗口透明工具'
$script:form.Size = New-Object System.Drawing.Size(420, 290)
$script:form.StartPosition = 'CenterScreen'
$script:form.FormBorderStyle = 'FixedSingle'
$script:form.MaximizeBox = $false
$script:form.TopMost = $true
$script:form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$script:lblTip = New-Object System.Windows.Forms.Label
$script:lblTip.Text = '让 Edge / Chrome 等窗口整体半透明，鼠标键盘操作不受影响'
$script:lblTip.Location = New-Object System.Drawing.Point(18, 14)
$script:lblTip.Size = New-Object System.Drawing.Size(380, 20)
$script:form.Controls.Add($script:lblTip)

$script:btnPick = New-Object System.Windows.Forms.Button
$script:btnPick.Text = '① 选择窗口'
$script:btnPick.Location = New-Object System.Drawing.Point(18, 44)
$script:btnPick.Size = New-Object System.Drawing.Size(110, 32)
$script:form.Controls.Add($script:btnPick)

$script:lblTarget = New-Object System.Windows.Forms.Label
$script:lblTarget.Text = '(未选择窗口)'
$script:lblTarget.Location = New-Object System.Drawing.Point(140, 52)
$script:lblTarget.Size = New-Object System.Drawing.Size(250, 18)
$script:lblTarget.AutoEllipsis = $true
$script:lblTarget.ForeColor = [System.Drawing.Color]::DimGray
$script:form.Controls.Add($script:lblTarget)

$script:lblAlpha = New-Object System.Windows.Forms.Label
$script:lblAlpha.Text = '② 不透明度'
$script:lblAlpha.Location = New-Object System.Drawing.Point(18, 92)
$script:lblAlpha.Size = New-Object System.Drawing.Size(80, 18)
$script:form.Controls.Add($script:lblAlpha)

$script:track = New-Object System.Windows.Forms.TrackBar
$script:track.Minimum = 20
$script:track.Maximum = 100
$script:track.Value = 85
$script:track.TickFrequency = 10
$script:track.Location = New-Object System.Drawing.Point(100, 84)
$script:track.Size = New-Object System.Drawing.Size(230, 45)
$script:form.Controls.Add($script:track)

$script:lblPercent = New-Object System.Windows.Forms.Label
$script:lblPercent.Text = '85%'
$script:lblPercent.Location = New-Object System.Drawing.Point(336, 92)
$script:lblPercent.Size = New-Object System.Drawing.Size(50, 18)
$script:form.Controls.Add($script:lblPercent)

$script:chkPen = New-Object System.Windows.Forms.CheckBox
$script:chkPen.Text = '③ 鼠标穿透（勾选后该窗口点不到，需在此取消）'
$script:chkPen.Location = New-Object System.Drawing.Point(18, 136)
$script:chkPen.Size = New-Object System.Drawing.Size(370, 22)
$script:form.Controls.Add($script:chkPen)

$script:btnReset = New-Object System.Windows.Forms.Button
$script:btnReset.Text = '恢复原样'
$script:btnReset.Location = New-Object System.Drawing.Point(18, 176)
$script:btnReset.Size = New-Object System.Drawing.Size(110, 32)
$script:form.Controls.Add($script:btnReset)

$script:lblStatus = New-Object System.Windows.Forms.Label
$script:lblStatus.Text = '点「选择窗口」后有 3 秒时间切到目标窗口'
$script:lblStatus.Location = New-Object System.Drawing.Point(18, 220)
$script:lblStatus.Size = New-Object System.Drawing.Size(380, 20)
$script:lblStatus.ForeColor = [System.Drawing.Color]::SteelBlue
$script:form.Controls.Add($script:lblStatus)

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 1000

$script:timer.Add_Tick({
    $script:countdown = $script:countdown - 1
    if ($script:countdown -gt 0) {
        $script:lblStatus.Text = '请现在切换到目标窗口…… ' + $script:countdown
        return
    }
    $script:timer.Stop()
    $h = [WinAlpha]::GetForegroundWindow()
    if ($h -eq $script:form.Handle) {
        $script:lblStatus.Text = '当前前台还是本工具，请重试'
        return
    }
    $script:target = $h
    $script:lblTarget.Text = Get-TargetTitle $h
    Set-Alpha -h $h -percent $script:track.Value -penetrate $script:chkPen.Checked
    $script:lblStatus.Text = '已应用，拖动滑块可继续微调'
})

$script:btnPick.Add_Click({
    $script:countdown = 3
    $script:lblStatus.Text = '请现在切换到目标窗口…… 3'
    $script:timer.Start()
})

$script:track.Add_ValueChanged({
    $script:lblPercent.Text = [string]$this.Value + '%'
    if ($script:target -ne [IntPtr]::Zero) {
        Set-Alpha -h $script:target -percent $this.Value -penetrate $script:chkPen.Checked
    }
})

$script:chkPen.Add_CheckedChanged({
    if ($script:target -ne [IntPtr]::Zero) {
        Set-Alpha -h $script:target -percent $script:track.Value -penetrate $this.Checked
    }
})

$script:btnReset.Add_Click({
    if ($script:target -eq [IntPtr]::Zero) {
        $script:lblStatus.Text = '还没有选择窗口'
        return
    }
    Clear-Alpha -h $script:target
    $script:lblStatus.Text = '已恢复该窗口的原始状态'
})

$script:form.Add_FormClosing({
    try {
        if ($script:target -ne [IntPtr]::Zero) { Clear-Alpha -h $script:target }
    } catch { }
})

[void]$script:form.ShowDialog()
