# 一次性脚本：为「悬浮阅读层」创建带自定义图标的桌面快捷方式
# 由 Windows 自己的 Shell API 生成，保证快捷方式结构合法
# 注意：本文件必须保存为 UTF-8 带 BOM，否则 PowerShell 5.1 会按 ANSI 读取，中文会乱码

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

# 项目目录 = 本脚本所在目录的上一级，不写死路径，移动文件夹后依然可用
$proj = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $proj 'node_modules\electron\dist\electron.exe'
$ico  = Join-Path $proj 'icon.ico'

$desk = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desk) -or -not (Test-Path $desk)) { $desk = 'D:\桌面' }

$lnkName = '悬浮阅读层.lnk'
$lnk     = Join-Path $desk $lnkName
$oldBat  = Join-Path $desk '悬浮阅读层.bat'

Write-Host ''
Write-Host '=== 悬浮阅读层 · 创建桌面图标 ===' -ForegroundColor Cyan
Write-Host ('项目目录: ' + $proj)
Write-Host ('桌面目录: ' + $desk)
Write-Host ''

try {
    if (-not (Test-Path $exe)) { throw "找不到程序文件: $exe" }
    if (-not (Test-Path $ico)) { throw "找不到图标文件: $ico" }
    if (-not (Test-Path $desk)) { throw "找不到桌面目录: $desk" }

    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath       = $exe
    $sc.Arguments        = '"' + $proj + '"'
    $sc.WorkingDirectory = $proj
    $sc.IconLocation     = $ico + ',0'
    $sc.Description      = '悬浮阅读层 · 透明阅读浮层'
    $sc.WindowStyle      = 1
    $sc.Save()

    Start-Sleep -Milliseconds 300

    if (-not (Test-Path $lnk)) { throw '快捷方式文件没有生成' }

    # 读回校验：确认系统真的存下了目标、参数、图标
    $verify = $shell.CreateShortcut($lnk)
    $okTarget = ($verify.TargetPath -eq $exe)
    $okArgs   = ($verify.Arguments -eq ('"' + $proj + '"'))
    $okIcon   = ($verify.IconLocation -like ($ico + '*'))

    $tagT = if ($okTarget) { '[OK]' } else { '[异常]' }
    $tagA = if ($okArgs)   { '[OK]' } else { '[异常]' }
    $tagI = if ($okIcon)   { '[OK]' } else { '[异常]' }

    Write-Host ('  目标路径: ' + $verify.TargetPath + '  ' + $tagT)
    Write-Host ('  启动参数: ' + $verify.Arguments + '  ' + $tagA)
    Write-Host ('  图标位置: ' + $verify.IconLocation + '  ' + $tagI)
    Write-Host ''

    if ($okTarget -and $okArgs -and $okIcon) {
        Write-Host '[成功] 桌面快捷方式已创建' -ForegroundColor Green
        Write-Host ('       ' + $lnk) -ForegroundColor Green

        if (Test-Path $oldBat) {
            try {
                Remove-Item $oldBat -Force -ErrorAction Stop
                Write-Host '[成功] 旧的 .bat 启动器已移除' -ForegroundColor Green
            } catch {
                Write-Host '[提示] 旧的 .bat 删不掉（可能被占用），可手动删除' -ForegroundColor Yellow
            }
        }
        Write-Host ''
        Write-Host '以后双击桌面图标即可启动。本脚本可保留下次重装时再用。'
    } else {
        Write-Host '[警告] 快捷方式已生成但参数不完整，已保留 .bat 备用' -ForegroundColor Yellow
    }
} catch {
    Write-Host ''
    Write-Host ('[错误] ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '旧的 .bat 启动器未改动，仍可正常使用。' -ForegroundColor Yellow
}

Write-Host ''
