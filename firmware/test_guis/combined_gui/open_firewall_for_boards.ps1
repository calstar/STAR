# open_firewall_for_boards.ps1
# Run this ONCE in PowerShell (Admin) on Windows to allow UDP from the avionics boards.
# With WSL2 mirrored networking, WSL listens directly on Windows ports — no port forwarding needed.
# This script just opens the Windows Firewall for inbound UDP on port 5006.

$ruleName = "Diablo FSW - Avionics UDP 5006"

# Remove existing rule if present (clean re-apply)
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

# Allow inbound UDP 5006 from the avionics subnet (192.168.2.x)
New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Protocol UDP `
    -LocalPort 5006 `
    -RemoteAddress "192.168.2.0/24" `
    -Action Allow

Write-Host "✅ Firewall rule '$ruleName' added." -ForegroundColor Green
Write-Host "   UDP port 5006 is now open for 192.168.2.0/24"
Write-Host ""
Write-Host "NOTE: Make sure .wslconfig has networkingMode=mirrored and WSL was restarted."
