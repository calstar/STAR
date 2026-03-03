# open_firewall_web_gui.ps1
# Run ONCE in PowerShell (Admin) on Windows to expose the Web GUI to the LAN.
# Requires WSL2 mirrored networking (.wslconfig: networkingMode=mirrored).
# No port proxy needed — mirrored mode makes WSL2 ports available directly on Windows adapters.
#
# Usage:
#   Right-click -> "Run as Administrator"
#   or: powershell -ExecutionPolicy Bypass -File .\scripts\setup\open_firewall_web_gui.ps1

$rules = @(
    @{ Name = "Diablo FSW - Web GUI Frontend (3000)"; Port = 3000; Protocol = "TCP"; Desc = "Next.js frontend" },
    @{ Name = "Diablo FSW - Web GUI WebSocket (8081)"; Port = 8081; Protocol = "TCP"; Desc = "Backend WebSocket" },
    @{ Name = "Diablo FSW - Web GUI REST API (8082)"; Port = 8082; Protocol = "TCP"; Desc = "Backend REST API" }
)

Write-Host ""
Write-Host "Diablo FSW — Web GUI LAN Firewall Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

foreach ($rule in $rules) {
    Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Direction Inbound `
        -Protocol $rule.Protocol `
        -LocalPort $rule.Port `
        -Action Allow | Out-Null
    Write-Host "  ✅ $($rule.Desc) — TCP $($rule.Port) open" -ForegroundColor Green
}

# Get LAN IPs to show the user where to connect
$ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch "^127\." -and $_.IPAddress -notmatch "^169\." } |
    Select-Object -ExpandProperty IPAddress

Write-Host ""
Write-Host "Firewall rules applied. Connect from any LAN device:" -ForegroundColor Yellow
foreach ($ip in $ips) {
    Write-Host "   http://$($ip):3000" -ForegroundColor White
}
Write-Host ""
Write-Host "NOTE: If WSL2 is not in mirrored mode, add to %USERPROFILE%\.wslconfig:" -ForegroundColor DarkGray
Write-Host "   [wsl2]" -ForegroundColor DarkGray
Write-Host "   networkingMode=mirrored" -ForegroundColor DarkGray
Write-Host "Then restart WSL: wsl --shutdown" -ForegroundColor DarkGray
Write-Host ""
