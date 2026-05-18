# GpuViewR Agent installer — Windows (NVIDIA only, GPU stats)
#
# Hub URL is substituted at the time the hub serves this script,
# so the version you fetched with iwr already knows where to call
# home. Re-running the installer is safe: it re-downloads the
# bundle and re-renders the scheduled task + env file.
#
# Usage A (recommended — paste the one-liner from the hub UI):
#   Set-ExecutionPolicy Bypass -Scope Process -Force
#   $env:GPVR_HUB_URL = '__HUB_URL__'
#   $env:GPVR_TOKEN   = '<host_id>.<secret>'
#   iex (iwr "$env:GPVR_HUB_URL/install.ps1" -UseBasicParsing).Content
#
# Usage B (download then run with explicit params):
#   iwr __HUB_URL__/install.ps1 -OutFile install.ps1
#   .\install.ps1 -Url __HUB_URL__ -Token <host_id>.<secret>
#
# Uninstall:
#   .\install.ps1 -Uninstall
#
# Requirements: Windows 10/11, Node.js 22+, NVIDIA driver (nvidia-smi.exe
# resolvable in PATH or at C:\Windows\System32\nvidia-smi.exe).
# AMD on Windows is not supported (no rocm-smi).

param(
  [string]$Url     = $env:GPVR_HUB_URL,
  [string]$Token   = $env:GPVR_TOKEN,
  [int]   $TickMs  = 1000,
  [string]$Features = 'gpu',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$InstallDir = "$env:ProgramData\GpuViewR-Agent"
$BinPath    = Join-Path $InstallDir 'agent.mjs'
$EnvPath    = Join-Path $InstallDir 'agent.env.ps1'
$LauncherPs = Join-Path $InstallDir 'launcher.ps1'
$TaskName   = 'GpuViewR Agent'

function Die($msg)  { Write-Host "x $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "+ $msg" -ForegroundColor Green }
function Say($msg)  { Write-Host "  $msg" }

# ──────────────────────────────────────────────────────────────────────
# Preflight
# ──────────────────────────────────────────────────────────────────────
if (-not $IsWindows -and $PSVersionTable.Platform -and $PSVersionTable.Platform -ne 'Win32NT') {
  Die "This installer runs on Windows only. Use install.sh for Linux."
}

# Elevation check — Register-ScheduledTask + write to ProgramData both
# need admin. Fail fast with a helpful message instead of a cryptic
# Access Denied halfway through.
$principal = [Security.Principal.WindowsPrincipal]::new(
  [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Die "Must run as Administrator. Right-click PowerShell -> Run as administrator, then paste the install command again."
}

# ──────────────────────────────────────────────────────────────────────
# Uninstall path — handled BEFORE arg validation so users can clean up
# even if they no longer have a valid token.
# ──────────────────────────────────────────────────────────────────────
if ($Uninstall) {
  Say "Uninstalling GpuViewR Agent..."
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  Ok "Removed."
  exit 0
}

# ──────────────────────────────────────────────────────────────────────
# Validate args
# ──────────────────────────────────────────────────────────────────────
if (-not $Url)   { Die "Missing -Url (or `$env:GPVR_HUB_URL). Use the URL printed by the hub UI." }
if (-not $Token) { Die "Missing -Token (or `$env:GPVR_TOKEN). Get it from the hub's 'Add Host' modal — shown once." }

if ($Token -notmatch '\.') {
  Die "Invalid -Token: missing '.'. Expected <host_id>.<secret> from the hub UI. Got: $Token"
}
$dot      = $Token.IndexOf('.')
$HostId   = $Token.Substring(0, $dot)
$Secret   = $Token.Substring($dot + 1)
# Tolerate a "gpvr_" prefix if the user pasted the whole composite.
if ($HostId.StartsWith('gpvr_')) { $HostId = $HostId.Substring(5) }
if (-not $HostId -or -not $Secret) {
  Die "Invalid -Token (parsed host_id=<$HostId>, secret=<...$($Secret.Length) chars>)."
}

# ──────────────────────────────────────────────────────────────────────
# Node 22+ — auto-install via winget when missing or too old.
#
# Mirrors install.sh.tpl's NodeSource auto-install: the user should not
# have to manually grab Node before re-running the installer. winget is
# built-in on Win10 1809+ and Win11 (App Installer); older SKUs fall
# back to the "go to nodejs.org" error.
#
# After install, the new node.exe path isn't in $env:Path of the current
# session yet — refresh from the registry so subsequent Get-Command
# calls (and the `node -v` exec) find it without requiring a logoff.
# ──────────────────────────────────────────────────────────────────────
function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-NodeMajor {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  try {
    $ver = (& node -v 2>$null) -replace '^v',''
    return @{ Command = $cmd; Version = $ver; Major = [int]($ver.Split('.')[0]) }
  } catch { return $null }
}

$node = Get-NodeMajor
if (-not $node -or $node.Major -lt 22) {
  $reason = if (-not $node) { 'not found' } else { "v$($node.Version) is too old (need 22+)" }
  Say "Node.js $reason — attempting auto-install via winget..."

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Die "Node.js 22+ not found and winget is not available on this system. Install Node.js LTS from https://nodejs.org/en/download (the .msi installer) then re-run this script."
  }

  # `winget install` exits 0 on success, non-zero on failure. Source +
  # package agreements are auto-accepted so the install is non-interactive.
  # OpenJS.NodeJS.LTS pulls the current Node LTS major (22.x as of writing,
  # bumps automatically when winget's repo advances).
  & winget install --id OpenJS.NodeJS.LTS --silent `
    --accept-source-agreements --accept-package-agreements
  $wingetExit = $LASTEXITCODE
  if ($wingetExit -ne 0) {
    Die "winget install OpenJS.NodeJS.LTS failed (exit $wingetExit). Install Node.js 22+ manually from https://nodejs.org/en/download then re-run this script."
  }

  Refresh-Path
  $node = Get-NodeMajor
  if (-not $node -or $node.Major -lt 22) {
    Die "winget reported success but node.exe is still missing from PATH. Reopen PowerShell as Administrator and re-run this script."
  }
  Ok "Node.js v$($node.Version) installed via winget at $($node.Command.Path)"
} else {
  Ok "Node.js v$($node.Version) at $($node.Command.Path)"
}

# ──────────────────────────────────────────────────────────────────────
# nvidia-smi check — warn but don't fail. The agent will boot and the
# hub will mark the host as online; the failure mode (no GPU samples
# arriving) is much easier to diagnose from the hub UI than a hard
# install-time exit, and AMD-on-Windows users who paste this script
# get a clear runtime signal instead of a cryptic install abort.
# ──────────────────────────────────────────────────────────────────────
$smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if ($smi) {
  $gpuName = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)
  Ok "nvidia-smi.exe at $($smi.Path) — $gpuName"
} else {
  Say "WARNING: nvidia-smi.exe not found in PATH. The agent will start but won't collect GPU samples."
  Say "         AMD GPUs on Windows are not supported (no rocm-smi equivalent)."
}

# ──────────────────────────────────────────────────────────────────────
# Install dir + bundle download
# ──────────────────────────────────────────────────────────────────────
if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

# Normalize hub URL: accept http(s):// or ws(s):// from the user; we
# need http(s):// for the bundle download and ws(s):// for the WS env.
$HttpUrl = $Url -replace '^ws:','http:' -replace '^wss:','https:'
$WsUrl   = $Url -replace '^http:','ws:'  -replace '^https:','wss:'
$HttpUrl = $HttpUrl.TrimEnd('/')
$WsUrl   = $WsUrl.TrimEnd('/')

Say "Downloading agent bundle from $HttpUrl/agent.mjs..."
try {
  Invoke-WebRequest -Uri "$HttpUrl/agent.mjs" -OutFile $BinPath -UseBasicParsing
} catch {
  Die "Failed to download agent.mjs: $($_.Exception.Message)"
}
Ok "Bundle saved to $BinPath"

# ──────────────────────────────────────────────────────────────────────
# Env file — sourced by launcher.ps1 before invoking node. We use a
# .ps1 fragment instead of a .env because Scheduled Task actions don't
# support per-action environment variables on Win10 1809 the same way
# Linux systemd EnvironmentFile= does. The launcher approach is the
# portable equivalent.
# ──────────────────────────────────────────────────────────────────────
@"
# Generated by install.ps1 — do not edit. Re-run the installer to update.
`$env:HUB_URL     = '$WsUrl/agent'
`$env:HOST_ID     = '$HostId'
`$env:AGENT_TOKEN = '$Secret'
`$env:TICK_MS     = '$TickMs'
`$env:FEATURES    = '$Features'
`$env:LOG_LEVEL   = 'info'
"@ | Set-Content -Path $EnvPath -Encoding UTF8

# ACL: only SYSTEM + Administrators can read the env file (it contains
# the agent token). Defense in depth — ProgramData's default ACL
# already keeps the file out of non-admin Users, but stripping
# inheritance makes the intent explicit and protects against weird
# domain policies inheriting wider ACLs.
#
# Identity references are SIDs, not name strings. Resolving
# 'NT AUTHORITY\SYSTEM' / 'BUILTIN\Administrators' via LSA fails on
# some Windows installs — observed on VPN'd / domain-joined /
# localized hosts with "Impossible de traduire certaines ou toutes
# les références d'identité." SIDs are language-independent and need
# no name resolution. Hardcoded well-known SIDs:
#   S-1-5-18      = LocalSystem
#   S-1-5-32-544  = BuiltinAdministrators
#
# Wrapped in try/catch so a future ACL surprise downgrades to a warn
# instead of aborting the whole install — the bundle and Scheduled
# Task are more important than the strict ACL.
try {
  $acl = Get-Acl $EnvPath
  $acl.SetAccessRuleProtection($true, $false)  # disable inheritance
  $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
  $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $adminSid  = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
    $systemSid, 'FullControl', 'Allow')))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
    $adminSid,  'FullControl', 'Allow')))
  Set-Acl -Path $EnvPath -AclObject $acl
  Ok "Env file ACL: SYSTEM + Administrators only."
} catch {
  Say "WARNING: failed to tighten ACL on $EnvPath ($($_.Exception.Message))."
  Say "         Falling back to the default ProgramData ACL (SYSTEM + Administrators full,"
  Say "         Users read-only). The agent token is still not world-readable."
}

# ──────────────────────────────────────────────────────────────────────
# Launcher — sources the env file then supervises node in a while-loop.
# The loop also handles hub-pushed agent updates: the agent writes the
# new bundle to agent.mjs.pending and exits; the launcher swaps it in
# before the next iteration. Without this loop a `process.exit(0)` from
# the agent (clean exit after update) would NOT trigger a Task Scheduler
# restart from an AtStartup trigger — the agent would stay dead until
# reboot. The loop makes the launcher itself the supervisor.
# ──────────────────────────────────────────────────────────────────────
$LogPath = Join-Path $InstallDir 'agent.log'

@"
# Generated by install.ps1 — do not edit. Re-run the installer to update.
`$ErrorActionPreference = 'Continue'
`$bin     = '$BinPath'
`$pending = `"`$bin.pending`"
`$envFile = '$EnvPath'
`$node    = '$($node.Command.Path)'
`$logFile = '$LogPath'

# Helper: timestamped append to the log file. The scheduled task runs
# hidden under SYSTEM so there's no console to write to — without this
# log, a crashing node process is completely invisible. Operator can
# tail it via `Get-Content '$LogPath' -Wait`.
function Write-Log(`$msg) {
    `$ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -Path `$logFile -Value "[`$ts] [launcher] `$msg"
}

Write-Log "supervisor started; node=`$node bin=`$bin"

while (`$true) {
    # Swap in any hub-pushed update before launching node. Move-Item
    # -Force overwrites the destination; the previous node process has
    # already exited by the time we reach this line so the file isn't
    # locked.
    if (Test-Path `$pending) {
        try {
            Move-Item -Force `$pending `$bin
            Write-Log "swapped pending bundle into `$bin"
        } catch {
            Write-Log "failed to swap pending bundle: `$(`$_.Exception.Message)"
        }
    }

    . `$envFile
    # `*>>` redirects ALL streams (stdout, stderr, warning, verbose) to
    # the log file in append mode. Without this the user has no way to
    # diagnose a node crash in production — `Get-ScheduledTaskInfo`
    # only shows the wrapper's exit code, never the inner error.
    & `$node `$bin *>> `$logFile
    `$exitCode = `$LASTEXITCODE
    Write-Log "node exited with code `$exitCode; respawning in 5s"

    # Short backoff before respawning. Mirrors systemd's RestartSec=5
    # so the agent comes back within seconds of a clean update exit.
    # Longer for crash loops would be nicer but adds state; keep it
    # simple — operators can watch agent.log to spot crash loops.
    Start-Sleep -Seconds 5
}
"@ | Set-Content -Path $LauncherPs -Encoding UTF8

# ──────────────────────────────────────────────────────────────────────
# Scheduled Task — run at boot, restart on failure, run as SYSTEM so
# it survives user logout. NetworkService would be slightly safer but
# can't always read nvidia-smi without driver-installer ACL tweaks; on
# a single-user dev machine SYSTEM is the path of least friction.
# ──────────────────────────────────────────────────────────────────────
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherPs`""

$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT15S'  # let the network come up before the WS dials

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 9999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal `
  -UserId 'SYSTEM' `
  -LogonType ServiceAccount `
  -RunLevel Highest

# Unregister first to allow re-install with a different config.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "GpuViewR — pushes GPU metrics to $WsUrl/agent" | Out-Null

Ok "Scheduled task '$TaskName' registered."

# Start it now so the user doesn't have to reboot to validate.
Start-ScheduledTask -TaskName $TaskName
Ok "Task started."

Say ""
Say "Hub URL : $WsUrl/agent"
Say "Host ID : $HostId"
Say "Bundle  : $BinPath"
Say "Task    : $TaskName"
Say ""
Say "Verify the agent is talking to the hub on the /fleet view of $HttpUrl."
Say ""
Say "Tail the agent log (most useful for diagnosing connect failures):"
Say "  Get-Content '$LogPath' -Wait"
Say ""
Say "Task status + last exit code:"
Say "  Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Say ""
Say "To uninstall later (paste in elevated PowerShell):"
Say "  iwr $HttpUrl/install.ps1 -OutFile `$env:TEMP\gpvr-uninstall.ps1 -UseBasicParsing"
Say "  & `$env:TEMP\gpvr-uninstall.ps1 -Uninstall"
