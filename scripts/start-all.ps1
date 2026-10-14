<#
  ★★★ 这个文件必须存成「UTF-8 带 BOM」★★★
  双击时跑的是 Windows PowerShell 5.1，它读 .ps1 默认按系统 ANSI 编码
  （中文系统上是 GBK）解码。无 BOM 的 UTF-8 会让中文全变乱码，
  个别字符还会吃掉字符串引号 —— 报错位置却指向几十行之后。实测踩过。
  重新加 BOM 的办法：
    $p='.\scripts\start-all.ps1'
    $t=[System.IO.File]::ReadAllText($p,[System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($p,$t,[System.Text.UTF8Encoding]::new($true))

  ─────────────────────────────────────────────────────────────
  一键启动：把三样东西按正确顺序拉起来

    ① 账号管理器服务（端口 8787）
    ② 闲管家隧道（拿到公网地址）
    ③ ★ 等你输主密码解锁 ★ ← 这一步不能省
    ④ 改密 worker

  ★ 为什么必须等你解锁了才起 worker ★
    worker 要读账号密码去登 Steam。保险库没解锁时，
    服务端没有解密密钥，worker 拿不到任何东西 ——
    它起来了也只是空转。所以顺序必须是"人先登录，机器再干活"。

  其他两个等待也是必要的：
    · 隧道启动时会探 127.0.0.1:8787 —— 服务没起来它就探不通，
      界面里「接口网关」就显示不出公网地址
    · worker 启动时会连管理器 —— 服务没起来它直接报"连不上"
#>
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ROOT = Split-Path -Parent $PSScriptRoot
$PORT = if ($env:VAULT_PORT) { $env:VAULT_PORT } else { '8787' }
$BASE = "http://127.0.0.1:$PORT"
$TUNNEL_LOG = Join-Path $env:TEMP 'cloudflared-tunnel.log'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step($n, $msg) { Write-Host ''; Write-Host "  [$n] $msg" -ForegroundColor White }

# ---------- 工具 ----------
# ★ 所有网络探测都必须绕开系统代理 ★
#   PowerShell 5.1 的 Invoke-RestMethod 默认沿用 IE/系统代理。
#   本机若开着代理（如 127.0.0.1:7890），探测本地服务或隧道地址都会被弄断，
#   报 "基础连接已经关闭: 发送时发生错误"。实测踩过 —— 而且很容易被误判成
#   "隧道挂了"，其实隧道好好的。所以统一用 HttpWebRequest + 空代理。
function Get-Web([string]$u, [int]$timeoutMs = 3000) {
  try {
    $req = [System.Net.HttpWebRequest]::Create($u)
    $req.Proxy = New-Object System.Net.WebProxy
    $req.Timeout = $timeoutMs
    $req.KeepAlive = $false
    $resp = $req.GetResponse()
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $text = $reader.ReadToEnd()
    $reader.Close()
    $resp.Close()
    return $text
  } catch {
    return $null
  }
}

function Test-Url([string]$u, [int]$timeoutMs = 3000) {
  return ((Get-Web $u $timeoutMs) -ne $null)
}

# 读健康信息，拿 unlocked 状态（这是判断"你登录了没"的依据）
function Get-Health {
  $t = Get-Web "$BASE/api/health" 3000
  if (-not $t) { return $null }
  try { return ($t | ConvertFrom-Json) } catch { return $null }
}

function Get-TunnelUrl {
  if (-not (Test-Path $TUNNEL_LOG)) { return $null }
  try {
    $m = [regex]::Match((Get-Content $TUNNEL_LOG -Raw -ErrorAction SilentlyContinue),
      'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com')
    if ($m.Success) { return $m.Value }
  } catch { }
  return $null
}

function Start-InWindow([string]$title, [string]$command, [string]$workDir = $ROOT) {
  # /k 让窗口在程序退出后保留，方便看报错
  $full = "title $title & chcp 65001 >nul & cd /d `"$workDir`" & $command"
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $full -WorkingDirectory $workDir | Out-Null
}

# ★ 找 worker 进程 ★
#   worker 是 `node index.mjs` 起的，**命令行里只有 index.mjs，没有 worker 这个路径**
#   （路径在工作目录里）。一开始按 `*worker*index.mjs*` 找，永远找不到。实测踩过。
#   为什么不会误认成服务：服务是 `node scripts\launch.mjs`，命令行里没有 index.mjs。
function Get-WorkerProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*index.mjs*' -and $_.CommandLine -notlike '*launch.mjs*' }
}

Write-Host ''
Write-Host '════════════════════════════════════════════════════' -ForegroundColor DarkGray
Write-Host '   Steam 账号管理器 · 一键启动' -ForegroundColor White
Write-Host '════════════════════════════════════════════════════' -ForegroundColor DarkGray

# ---------- 检查 Node ----------
Step '0' '检查环境…'
$node = (Get-Command node -ErrorAction SilentlyContinue).Path
if (-not $node) {
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe",
                   "$env:LOCALAPPDATA\Programs\nodejs\node.exe", 'D:\node.exe')) {
    if (Test-Path $p) { $node = $p; break }
  }
}
if (-not $node) {
  Say '    x 找不到 Node.js' 'Red'
  Say '      去 https://nodejs.org/ 下载 LTS 版装上，然后重跑本文件。' 'Yellow'
  Read-Host '  按回车关闭' | Out-Null
  exit 1
}
Say "    ok Node  $node" 'DarkGray'
Say "    ok 项目  $ROOT" 'DarkGray'

# ---------- ① 账号管理器 ----------
Step '1' '启动账号管理器（服务）…'

$health = Get-Health
if ($health) {
  Say '    . 已经在跑了，跳过' 'DarkGray'
} else {
  Start-InWindow '账号管理器' 'call "启动.bat"'
  Say '    已在新窗口启动，等它就绪…' 'DarkGray'

  $health = $null
  for ($i = 1; $i -le 90; $i += 1) {
    Start-Sleep -Seconds 1
    $health = Get-Health
    if ($health) { break }
    if ($i % 15 -eq 0) { Say "      等了 $i 秒…（首次运行要装依赖、构建界面，会慢）" 'DarkGray' }
  }
  if ($health) {
    Say "    ok 服务就绪（等了约 $i 秒）  $BASE" 'Green'
  } else {
    Say '    x 等了 90 秒还没起来' 'Red'
    Say '      去「账号管理器」那个窗口看报错。' 'Yellow'
    Read-Host '  按回车关闭' | Out-Null
    exit 1
  }
}

# ---------- ② 闲管家隧道 ----------
Step '2' '启动闲管家隧道…'

$url = Get-TunnelUrl
if ($url -and (Test-Url "$url/api/health" 8000)) {
  Say "    . 已经在跑：$url" 'DarkGray'
} else {
  Remove-Item $TUNNEL_LOG -Force -ErrorAction SilentlyContinue
  Start-InWindow '闲管家隧道' 'call "启动闲管家隧道.bat"'
  Say '    已在新窗口启动，等它分配到公网地址…' 'DarkGray'

  $url = $null
  for ($i = 1; $i -le 60; $i += 1) {
    Start-Sleep -Seconds 1
    $u = Get-TunnelUrl
    if ($u -and (Test-Url "$u/api/health" 8000)) { $url = $u; break }
    if ($i % 15 -eq 0) { Say "      等了 $i 秒…" 'DarkGray' }
  }
  if ($url) {
    Say "    ok 隧道就绪  $url" 'Green'
    try { Set-Clipboard -Value $url } catch { }
    Say '      地址已复制到剪贴板（填闲管家后台的「接口网关」用）' 'DarkGray'
  } else {
    Say '    ! 没等到可用的公网地址' 'Yellow'
    Say '      去「闲管家隧道」那个窗口看报错。' 'DarkGray'
    Say '      （隧道没起来不影响自己用界面，只是闲管家发不了货）' 'DarkGray'
  }
}

# ---------- ③ ★ 等你解锁 ★ ----------
Step '3' '等你登录账号管理器…'

$health = Get-Health
if ($health -and $health.unlocked) {
  Say '    . 保险库已经是解锁状态，跳过' 'DarkGray'
} else {
  Write-Host ''
  Write-Host '    +--------------------------------------------+' -ForegroundColor Yellow
  Write-Host '    |  请到浏览器里输入主密码，进入账号管理器      |' -ForegroundColor Yellow
  Write-Host '    +--------------------------------------------+' -ForegroundColor Yellow
  Write-Host ''
  Say "    地址： $BASE" 'Cyan'
  Say '    （浏览器一般已经自动打开了；没开就手动访问上面这个）' 'DarkGray'
  Say ''
  Say '    ★ 必须等你输完密码，worker 才有意义 ★' 'Yellow'
  Say '      没解锁时服务端没有解密密钥，worker 拿不到账号密码，' 'DarkGray'
  Say '      起来了也只是空转。所以这里会一直等你。' 'DarkGray'
  Say ''

  $unlocked = $false
  for ($i = 1; $i -le 900; $i += 1) {
    Start-Sleep -Seconds 1
    $h = Get-Health
    if ($h -and $h.unlocked) { $unlocked = $true; break }
    if ($i % 20 -eq 0) { Say "      还在等你输密码…（已等 $([math]::Round($i/60,1)) 分钟）" 'DarkGray' }
  }

  if ($unlocked) {
    Say "    ok 已解锁（等了约 $i 秒），可以启动 worker 了" 'Green'
  } else {
    Say '    ! 等了 15 分钟还没解锁' 'Yellow'
    Say '      worker 先不启了 —— 现在启它也没用。' 'DarkGray'
    Say '      你输完密码后，单独去 worker 目录跑一次即可：' 'DarkGray'
    Say "        cd `"$ROOT\worker`"" 'White'
    Say '        npm start' 'White'
    Write-Host ''
    Read-Host '  按回车关闭' | Out-Null
    exit 0
  }
}

# ---------- ④ 改密 worker ----------
Step '4' '启动改密 worker…'

$w = Get-WorkerProcess
if ($w) {
  Say "    . 已经在跑了（PID $($w.ProcessId -join ',')），跳过" 'DarkGray'
} else {
  # ★ 直接用 node 全路径，不走 npm ★
  #   这台机器的 npm 在 D:\npm.cmd，而 D:\ 不一定在新开的 cmd 窗口的 PATH 里
  #   —— `npm start` 会报"不是内部或外部命令"，窗口一闪就没了。
  #   前面已经找到 node 的绝对路径了，直接用它最稳（等价于 npm start）。
  $workerDir = Join-Path $ROOT 'worker'
  Start-InWindow '改密 Worker' "`"$node`" index.mjs" $workerDir
  Say '    已在新窗口启动，等它连上管理器…' 'DarkGray'
  $w2 = $null
  for ($i = 1; $i -le 20; $i += 1) {
    Start-Sleep -Seconds 1
    $w2 = Get-WorkerProcess
    if ($w2) { break }
  }
  if ($w2) {
    Say "    ok worker 已启动（PID $($w2.ProcessId -join ',')，等了 $i 秒）" 'Green'
  } else {
    Say '    ! 没检测到 worker 进程' 'Yellow'
    Say '      去看「改密 Worker」那个窗口：' 'DarkGray'
    Say '        . 里面日志在滚 -> 其实起来了，只是本脚本查进程的方式不适用' 'DarkGray'
    Say '        . 窗口一闪就没了 -> worker\.env 或依赖问题' 'DarkGray'
  }
}

# ---------- 总结 ----------
$health = Get-Health
Write-Host ''
Write-Host '════════════════════════════════════════════════════' -ForegroundColor DarkGray
Write-Host '   启动完毕' -ForegroundColor Green
Write-Host '════════════════════════════════════════════════════' -ForegroundColor DarkGray
Write-Host ''
Write-Host '   账号管理器   ' -NoNewline; Write-Host $BASE -ForegroundColor Cyan
if ($url) {
  Write-Host '   公网地址     ' -NoNewline; Write-Host $url -ForegroundColor Cyan
  Write-Host '                （这个填到闲管家后台的「接口网关」）' -ForegroundColor DarkGray
}
Write-Host ''
Write-Host '   自检：' -ForegroundColor White
Write-Host '     服务       ' -NoNewline
if ($health) { Write-Host 'ok 在跑' -ForegroundColor Green } else { Write-Host 'x 没响应' -ForegroundColor Red }
Write-Host '     保险库     ' -NoNewline
if ($health -and $health.unlocked) { Write-Host 'ok 已解锁' -ForegroundColor Green }
else { Write-Host 'x 未解锁（worker 做不了事）' -ForegroundColor Red }
Write-Host '     隧道       ' -NoNewline
if ($url) { Write-Host 'ok 在跑' -ForegroundColor Green } else { Write-Host '! 没拿到地址' -ForegroundColor Yellow }
Write-Host '     worker     ' -NoNewline
if (Get-WorkerProcess) { Write-Host 'ok 在跑' -ForegroundColor Green } else { Write-Host '! 没检测到' -ForegroundColor Yellow }
Write-Host ''
Write-Host '   ! 三个窗口都别关：' -ForegroundColor Yellow
Write-Host '      . 关服务   -> 界面打不开、闲管家发不了货' -ForegroundColor DarkGray
Write-Host '      . 关隧道   -> 闲管家连不上、发不了货（地址会变）' -ForegroundColor DarkGray
Write-Host '      . 关worker -> 账号卡在「待改密」，回不到「可用」' -ForegroundColor DarkGray
Write-Host ''
Write-Host '   每天关机重开，双击「一键启动.bat」再来一遍即可。' -ForegroundColor DarkGray
Write-Host ''
