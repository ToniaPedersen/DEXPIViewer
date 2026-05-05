param(
    [string]$File = (Join-Path $PSScriptRoot "src\dexpiTypes.js")
)

if (!(Test-Path $File)) {
    Write-Error "File not found: $File"
    exit 1
}

$backup = "$File.bak"
Copy-Item $File $backup -Force
Write-Host "Backup created: $backup"

$content = Get-Content $File -Raw

# Fix dexpiTypes.js duplicated/corrupted tail:
# Keep everything through the first complete DEXPI_STD_PREFIXES export block.
$endPattern = '(?s)(export\s+const\s+DEXPI_STD_PREFIXES\s*=\s*new\s+Set\s*\(\s*\[\s*.*?\]\s*\)\s*;)'

$m = [regex]::Match($content, $endPattern)

if ($m.Success) {
    $fixed = $content.Substring(0, $m.Index + $m.Length).TrimEnd() + "`r`n"
} else {
    $fixed = $content
}

# Existing fixes for corrupted AI-generated tails
$patterns = @(
    '(?s)\r?\n\s*w\)\);\s*\r?\n.*$',
    '(?s)\r?\n\s*th\);\s*\r?\n.*$',
    '(?s)\r?\n\s*[a-zA-Z]{1,4}\);\s*\r?\n\s*const\s+[a-zA-Z_$][\w$]*\s*=.*$'
)

foreach ($pattern in $patterns) {
    $fixed = [regex]::Replace($fixed, $pattern, "`r`n")
}

Set-Content -Path $File -Value $fixed -Encoding UTF8

Write-Host "Cleaned: $File"

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    node --check $File
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Node syntax check: PASS"
    } else {
        Write-Host "Node syntax check: FAIL"
        Write-Host "Restoring backup..."
        Copy-Item $backup $File -Force
        exit 1
    }
} else {
    Write-Host "Node not found; skipped syntax check."
}