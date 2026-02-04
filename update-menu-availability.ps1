# update-menu-availability.ps1
# Quick menu availability updater

param(
    [string]$Action = "status",
    [int]$ItemId = 0,
    [int]$RestaurantId = 1,
    [string]$OwnerKey = ""
)

$API_URL = "http://localhost:3000"

function Show-Menu {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  Restaurant Menu Availability Manager" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan

    $response = Invoke-RestMethod -Uri "$API_URL/menu/api/menu/status/$RestaurantId"
    
    Write-Host "📊 Status:" -ForegroundColor Yellow
    Write-Host "   Available: $($response.available)" -ForegroundColor Green
    Write-Host "   Out of Stock: $($response.unavailable)`n" -ForegroundColor Red

    Write-Host "📋 Menu Items:`n" -ForegroundColor Yellow
    foreach ($item in $response.items) {
        $status = if ($item.available) { "✅" } else { "❌" }
        $color = if ($item.available) { "Green" } else { "Red" }
        Write-Host "  $status $($item.id). $($item.name) - ₹$($item.price)" -ForegroundColor $color
    }
}

function Toggle-Item {
    param([int]$Id)
    
    $body = @{
        restaurantId = $RestaurantId
        ownerKey = $OwnerKey
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "$API_URL/menu/api/menu/toggle/$Id" `
                                   -Method POST `
                                   -Body $body `
                                   -ContentType "application/json"
    
    Write-Host "`n✅ $($response.itemName) - $($response.status)" -ForegroundColor Green
}

# Main execution
if ($Action -eq "status") {
    Show-Menu
}
elseif ($Action -eq "toggle" -and $ItemId -gt 0) {
    Toggle-Item -Id $ItemId
    Show-Menu
}
else {
    Write-Host "`nUsage:" -ForegroundColor Yellow
    Write-Host "  View menu:    .\update-menu-availability.ps1 -Action status"
    Write-Host "  Toggle item:  .\update-menu-availability.ps1 -Action toggle -ItemId 15 -OwnerKey 'your_key'"
}
