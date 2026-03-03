# open_firewall_web_gui.ps1
# Run ONCE in PowerShell (Admin) on Windows to expose the Web GUI to the LAN.
# Requires WSL2 mirrored networking (.wslconfig: networkingMode=mirrored).
#
# Fixes applied:
#   1. Windows Firewall rules for all Web GUI ports (TCP 3000, 8081, 8100, 8101)
#   2. ICMP (ping) inbound rule so LAN devices can ping this machine
#   3. Hyper-V / WSL2 firewall rules - WSL2 mirrored mode has its OWN firewall
#      separate from Windows Firewall; without this, LAN traffic is silently dropped
#      even with Windows Firewall fully disabled.
#   4. Patches .wslconfig with firewall=false as a fallback if Hyper-V rules are
#      not supported on this Windows version.
#
# Usage:
#   Right-click -> "Run as Administrator"
#   or: powershell -ExecutionPolicy Bypass -File .\scripts\setup\open_firewall_web_gui.ps1

if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-Host "ERROR: Run this script as Administrator." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Diablo FSW - Web GUI LAN Firewall Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# -- 1. Windows Firewall: TCP ports -------------------------------------------
$tcpRules = @(
    @{ Name = "Diablo FSW - Web GUI Frontend (3000)";         Port = 3000; Desc = "Next.js frontend" },
    @{ Name = "Diablo FSW - Web GUI WebSocket (8081)";        Port = 8081; Desc = "Backend WebSocket" },
    @{ Name = "Diablo FSW - Calibration Sidecar HTTP (8100)"; Port = 8100; Desc = "Calibration HTTP" },
    @{ Name = "Diablo FSW - Calibration Sidecar WS (8101)";   Port = 8101; Desc = "Calibration WebSocket" }
)

Write-Host "  Windows Firewall - TCP ports:" -ForegroundColor Yellow
foreach ($rule in $tcpRules) {
    Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    New-NetFirewallRule `
        -DisplayName   $rule.Name `
        -Direction     Inbound `
        -Protocol      TCP `
        -LocalPort     $rule.Port `
        -Action        Allow `
        -Profile       Any `
        -InterfaceType Any | Out-Null
    Write-Host "    OK  $($rule.Desc) - TCP $($rule.Port)" -ForegroundColor Green
}

# -- 2. Windows Firewall: ICMP (ping) -----------------------------------------
Write-Host ""
Write-Host "  Windows Firewall - ICMP (ping):" -ForegroundColor Yellow
Enable-NetFirewallRule -Name "FPS-ICMP4-ERQ-In" -ErrorAction SilentlyContinue
Write-Host "    OK  ICMPv4 echo (ping) enabled" -ForegroundColor Green

# -- 3. Hyper-V / WSL2 firewall rules -----------------------------------------
# WSL2 mirrored mode uses a Hyper-V firewall separate from Windows Firewall.
# Disabling Windows Firewall does NOT disable this. Requires Windows 11 23H2+.
Write-Host ""
Write-Host "  Hyper-V / WSL2 firewall rules:" -ForegroundColor Yellow
$wslVmCreatorId = "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}"
$hyperVSupported = $false

try {
    Remove-NetFirewallHyperVRule -Name "Diablo-FSW-WebGUI" -ErrorAction SilentlyContinue
    New-NetFirewallHyperVRule `
        -Name        "Diablo-FSW-WebGUI" `
        -DisplayName "Diablo FSW Web GUI (WSL2)" `
        -Direction   Inbound `
        -VMCreatorId $wslVmCreatorId `
        -Protocol    TCP `
        -LocalPorts  3000,8081,8100,8101 `
        -Action      Allow | Out-Null
    Write-Host "    OK  Hyper-V WSL2 firewall rule added (TCP 3000, 8081, 8100, 8101)" -ForegroundColor Green
    $hyperVSupported = $true
} catch {
    Write-Host "    WARN  Hyper-V firewall cmdlets not available (need Windows 11 23H2+)" -ForegroundColor Yellow
    Write-Host "          Falling back to firewall=false in .wslconfig" -ForegroundColor Yellow
}

# -- 4. Patch .wslconfig with firewall=false (fallback) -----------------------
if (-not $hyperVSupported) {
    Write-Host ""
    Write-Host "  Patching .wslconfig:" -ForegroundColor Yellow
    $wslConfigPath = "$env:USERPROFILE\.wslconfig"
    $content = if (Test-Path $wslConfigPath) { Get-Content $wslConfigPath -Raw } else { "" }

    if ($content -notmatch "firewall\s*=") {
        if ($content -match "\[wsl2\]") {
            $content = $content -replace "(\[wsl2\])", "`$1`nfirewall=false"
        } else {
            $content += "`n[wsl2]`nfirewall=false`n"
        }
        Set-Content $wslConfigPath $content
        Write-Host "    OK  firewall=false added to .wslconfig" -ForegroundColor Green
        Write-Host "    ACTION REQUIRED: Restart WSL2 now: wsl --shutdown" -ForegroundColor Magenta
    } else {
        Write-Host "    SKIP  firewall= already set in .wslconfig" -ForegroundColor DarkGray
    }
}

# -- Summary ------------------------------------------------------------------
$ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch "^127\." -and $_.IPAddress -notmatch "^169\." -and $_.IPAddress -notmatch "^10\." } |
    Select-Object -ExpandProperty IPAddress

Write-Host ""
Write-Host "Done. Connect from any LAN device:" -ForegroundColor Cyan
foreach ($ip in $ips) {
    Write-Host "   http://$($ip):3000" -ForegroundColor White
}
if ($hyperVSupported) {
    Write-Host ""
    Write-Host "No WSL restart needed - Hyper-V rules apply immediately." -ForegroundColor DarkGray
}
Write-Host ""
