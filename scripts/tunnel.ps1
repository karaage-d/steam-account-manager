<#
  ★★★ 这个文件必须存成「UTF-8 带 BOM」★★★

  原因：双击 .bat 时跑的是 Windows PowerShell 5.1，它读 .ps1 默认按**系统 ANSI
  编码（中文系统上是 GBK）**解码。如果文件是无 BOM 的 UTF-8，里面的中文会全变成
  乱码，个别字符还会吃掉字符串的结束引号 —— 报错却指向几十行之外，
  看起来像"括号没配对"，非常难查。实测踩过。

  如果你以后用别的编辑器改这个文件，记得保存为 "UTF-8 with BOM"。
  用 PowerShell 重新加 BOM 的办法：
    $p = '.\scripts\tunnel.ps1'
    $t = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($true))

  ─────────────────────────────────────────────────────────────
  启动 Cloudflare 临时隧道，把本机的账号管理器暴露到公网。
  起点：给闲管家当「接口网关」用。

  双击同目录的「启动闲管家隧道.bat」即可，不用手动敲命令。

  做完三件事：
    ① 检查账号管理器在不在跑（不在跑就提示）
    ② 起隧道，等它分配到一个 https://xxx.trycloudflare.com 地址
    ③ 把地址打印出来 + 自动复制到剪贴板，直接粘到闲管家后台就行
#>
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$port = if ($env:VAULT_PORT) { $env:VAULT_PORT } else { 8787 }
$base = "http://127.0.0.1:$port"

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

Say ''
Say '════════════════════════════════════════════════════' 'DarkGray'
Say '   闲管家隧道 · 把本机账号管理器开到公网' 'White'
Say '════════════════════════════════════════════════════' 'DarkGray'
Say ''

# ---------- ① 找 cloudflared ----------
$candidates = @(
  "$env:ProgramFiles\cloudflared\cloudflared.exe",
  "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe",
  "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
)
$cf = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cf) {
  # ★ 别用 `?.` ★ 那是 PowerShell 7+ 的语法，而双击 .bat 跑的是
  #   Windows PowerShell 5.1 —— 解析器会在这一行直接崩，
  #   而且报错位置会串到几十行之后，非常难查。实测踩过。
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { $cf = $cmd.Path }
}

if (-not $cf) {
  Say '  ✗ 没找到 cloudflared' 'Red'
  Say ''
  Say '  装一个（任选其一）：' 'Yellow'
  Say '    winget install Cloudflare.cloudflared' 'Gray'
  Say '    或去 https://github.com/cloudflare/cloudflared/releases 下载' 'Gray'
  Say ''
  exit 1
}
try {
  $cfVer = (& $cf --version 2>&1 | Out-String).Trim()
  Say "  ✓ cloudflared  $cfVer" 'DarkGray'
} catch {
  Say '  ✓ cloudflared  已找到' 'DarkGray'
}

# ---------- ② 账号管理器在跑吗 ----------
$alive = $false
try {
  $r = Invoke-RestMethod "$base/api/health" -TimeoutSec 5
  $alive = $true
  Say "  ✓ 账号管理器  $($r.service) $($r.version)  已解锁=$($r.unlocked)" 'Green'
} catch {
  Say "  ⚠ 账号管理器没在跑（$base 连不上）" 'Yellow'
  Say '    隧道照样能起，但闲管家调进来会失败。先双击「启动.bat」。' 'DarkGray'
}
Say ''

# ---------- ③ 起隧道 ----------
$log = Join-Path $env:TEMP 'cloudflared-tunnel.log'
Remove-Item $log -Force -ErrorAction SilentlyContinue

Say '  正在申请临时地址…' 'DarkGray'
$proc = Start-Process -FilePath $cf `
  -ArgumentList @('tunnel', '--url', "http://localhost:$port", '--no-autoupdate', '--logfile', $log) `
  -WindowStyle Hidden -PassThru

$url = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 600
  if (Test-Path $log) {
    $m = [regex]::Match((Get-Content $log -Raw -ErrorAction SilentlyContinue),
      'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com')
    if ($m.Success) { $url = $m.Value; break }
  }
  if ($proc.HasExited) { break }
}

if (-not $url) {
  Say '  ✗ 没能拿到地址' 'Red'
  Say '    常见原因：网络连不上 Cloudflare（试试开代理），或隧道被墙。' 'Yellow'
  if (Test-Path $log) { Say ''; Say '  —— cloudflared 日志末尾 ——' 'DarkGray'; Get-Content $log -Tail 12 | ForEach-Object { Say "  $_" 'DarkGray' } }
  if (-not $proc.HasExited) { $proc.Kill() }
  exit 1
}

# ---------- ④ 让服务端记住这个公网地址 ----------
# ★ 为什么要有这一步 ★
#   闲管家的「接口网关」必须填公网地址。但我们的面板通常是从
#   http://127.0.0.1:8787 打开的，服务端不知道隧道给了什么地址，
#   面板上就会显示成 127.0.0.1 —— 照抄进闲管家必然连不上（实测踩过）。
#   这里从公网地址探活一次，服务端就把这个地址记下来了，
#   之后不管从哪个地址打开面板，都能显示正确的公网地址。

# ★★★ 探活必须绕开系统代理 ★★★
#   实测（逐个变体比对得出的结论）：
#     · 走系统代理（本机开着 127.0.0.1:7890）→ "基础连接已经关闭: 发送时发生错误"
#     · 不走代理                              → 成功
#     · 关证书吊销检查                        → 没用（我一开始判断错了方向）
#   PowerShell 5.1 的 Invoke-RestMethod 默认沿用 IE/系统代理设置，
#   而这个隧道地址经那个代理会断。所以探活单独用 HttpWebRequest + 空代理，
#   不动全局设置，只影响这一个请求。
function Test-Tunnel([string]$u, [int]$timeoutMs = 10000) {
  $req = [System.Net.HttpWebRequest]::Create($u)
  $req.Proxy = New-Object System.Net.WebProxy   # 空的 = 不走代理
  $req.Timeout = $timeoutMs
  $req.KeepAlive = $false
  $resp = $req.GetResponse()
  $resp.Close()
}

Say '  正在通知账号管理器记住公网地址…' 'DarkGray'
$seeded = $false
$seedErr = ''
for ($i = 0; $i -lt 15; $i += 1) {
  try {
    Test-Tunnel "$url/api/health"
    $seeded = $true
    break
  } catch {
    $seedErr = $_.Exception.Message
    Start-Sleep -Seconds 2
  }
}

# ---------- ⑤ 打印 + 复制 ----------
Say ''
Say '════════════════════════════════════════════════════' 'DarkGray'
Say '   ✓ 隧道已就绪' 'Green'
Say ''
Say "   $url" 'Cyan'
Say '════════════════════════════════════════════════════' 'DarkGray'
Say ''

try {
  Set-Clipboard -Value $url
  Say '  ✓ 地址已复制到剪贴板，直接粘到闲管家后台的「接口网关」' 'Green'
} catch {
  Say '  （复制到剪贴板失败，手动选中上面那行复制即可）' 'DarkGray'
}

Say ''
if ($seeded) {
  Say '  ✓ 已通知账号管理器记住这个公网地址' 'Green'
  Say '    （面板「闲管家对接」里的「接口网关」会自动显示它）' 'DarkGray'
} else {
  Say '  ⚠ 探活没成功 —— 隧道可能还没完全生效，等几秒刷新面板再试' 'Yellow'
  if ($seedErr) { Say "     原因：$seedErr" 'DarkGray' }
  Say '     如果一直失败，看面板上有没有橙色警告框；' 'DarkGray'
  Say '     实在不行，把 .bat 窗口里那个地址手动填进闲管家也行。' 'DarkGray'
}
Say ''
Say '  填到闲管家「货源授权信息」：' 'Yellow'
Say "     接口网关：$url" 'White'
Say "     AppKey  ：（我们面板里的「商户 ID」，建议填纯数字）" 'White'
Say "     AppSecret：（我们面板里点「随机生成」后复制的那串）" 'White'
Say ''
Say '  ⚠ 这个地址是临时的：关掉这个窗口 / 重启电脑 就会失效。' 'Yellow'
Say '    失效后重新双击本文件，把新地址再填一次闲管家后台即可。' 'DarkGray'
Say ''
Say '  想停掉隧道：直接关掉这个窗口，或者按 Ctrl+C。' 'DarkGray'
Say ''

# ---------- ⑥ 保持运行 + 转发日志 ----------
$lastLen = 0
try {
  while (-not $proc.HasExited) {
    Start-Sleep -Seconds 2
    if (Test-Path $log) {
      $lines = Get-Content $log -ErrorAction SilentlyContinue
      if ($lines.Count -gt $lastLen) {
        $new = $lines | Select-Object -Skip $lastLen
        $lastLen = $lines.Count
        foreach ($l in $new) {
          # 只显示有点意义的行，避免刷屏
          if ($l -match 'ERR|WRN|error|Registered tunnel|Unregistered|retry') {
            Say "  $l" 'DarkGray'
          }
        }
      }
    }
  }
  Say ''
  Say '  隧道已断开。' 'Yellow'
} finally {
  if (-not $proc.HasExited) { $proc.Kill() }
}
