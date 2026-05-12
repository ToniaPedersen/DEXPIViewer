# DEXPIViewer — Batch Validation Guide

This guide explains how to run the DEXPIViewer validator against a folder of DEXPI 2.0 XML
files from the command line or PowerShell, how to supply DISC profile files, and where the
output reports are written.

---

## Prerequisites

| Requirement | Minimum version | Check |
|-------------|----------------|-------|
| Node.js     | 18 LTS or later | `node --version` |
| npm packages | installed | `npm install` (once, in the project root) |

All other dependencies (`@xmldom/xmldom`, React, Vite) are resolved by `npm install` from
`package.json`.  No browser is required for batch runs.

---

## The CLI script

`validate-cli.js` in the project root is the batch entry point.  It reuses exactly the same
parser and validation engine as the browser UI, polyfilling the browser's `DOMParser` with
`@xmldom/xmldom` so the same source files run under Node.js unchanged.

```
Usage:
  node validate-cli.js <file-or-folder> [options]

  npm run validate -- <file-or-folder> [options]   # npm shortcut

Options:
  --profile <file>   Load a DISC profile XML (repeatable for multiple profiles)
  --out <folder>     Write CSV reports to this folder instead of next to each input file
  --summary          Print the summary table to stdout only; do not write individual CSVs
  --help             Show built-in help
```

Exit code: `0` = no errors found in any file; `1` = at least one validation error detected.

---

## Validating a single file

```powershell
# From the DEXPIViewer project folder
node validate-cli.js "DISC TEST\DiscTest17_PRF_E04A_UnknownSymbol.xml"
```

Output:
```
Validating DiscTest17_PRF_E04A_UnknownSymbol.xml ... [x]  17 errors  3 warnings  48 info
  -> DISC TEST\DiscTest17_PRF_E04A_UnknownSymbol.csv
```

The `[x]` icon means errors were found. A `[!]` means warnings only; `[v]` means clean.

---

## Validating a folder — basic

Pass the folder path instead of a file. Every `.xml` file in the folder is processed.

```powershell
node validate-cli.js "DISC TEST"
```

Each file gets a `.csv` report written **in the same folder** as the XML:
```
DISC TEST\
  DiscTest01_UnknownDataProps_PipingNetworkSystem.csv
  DiscTest02_UnknownComponentsProps_CentrifugalPump.csv
  ...
```

---

## Validating with DISC profiles

Add `--profile` for each profile XML to load.  Profiles activate the PRF-E01 to PRF-E05
symbol and constraint rules that only fire when a profile is present.

### DEXPI DISC base profile only

```powershell
node validate-cli.js "DISC TEST" `
    --profile "DEXPI Standard and Profile\DiscProfile.xml"
```

### DISC base profile + FL0 process profile

```powershell
node validate-cli.js "DISC TEST" `
    --profile "DEXPI Standard and Profile\DiscProfile.xml" `
    --profile "DEXPI Standard and Profile\DiscProfile_FL0.xml"
```

Profiles are merged in the order supplied; later profiles override earlier ones when the same
constraint appears in both.

---

## Sending reports to a dedicated output folder

Use `--out` to keep validation reports separate from the source XML files.

```powershell
# Create a reports folder and write all CSVs there
node validate-cli.js "DISC TEST" `
    --profile "DEXPI Standard and Profile\DiscProfile.xml" `
    --profile "DEXPI Standard and Profile\DiscProfile_FL0.xml" `
    --out "validation-reports"
```

The `--out` folder is created automatically if it does not exist.

Output location:
```
validation-reports\
  DiscTest01_UnknownDataProps_PipingNetworkSystem.csv
  DiscTest02_UnknownComponentsProps_CentrifugalPump.csv
  ...
  DiscTest21_PRF_E04_E05_Combo.csv
```

---

## Summary-only mode (no CSV files written)

Use `--summary` when you only want the console overview — useful in CI pipelines or quick
triage runs where you do not need the per-issue detail.

```powershell
node validate-cli.js "DISC TEST" `
    --profile "DEXPI Standard and Profile\DiscProfile.xml" `
    --profile "DEXPI Standard and Profile\DiscProfile_FL0.xml" `
    --summary
```

Example output:
```
Loaded 2 profile(s): DiscProfile, DiscProfile_FL0
Validating DiscTest01_UnknownDataProps_PipingNetworkSystem.xml ... [x]  4 errors  0 warnings  42 info
Validating DiscTest02_UnknownComponentsProps_CentrifugalPump.xml ... [x]  2 errors  0 warnings  42 info
Validating DiscTest17_PRF_E04A_UnknownSymbol.xml ... [x]  17 errors  3 warnings  48 info
Validating DiscTest18_PRF_E04B_WrongSymbolType.xml ... [x]  16 errors  3 warnings  48 info
Validating DiscTest19_PRF_E05_MisalignedNodePositions.xml ... [x]  0 errors  9 warnings  42 info
...
-----------------------------------------------------------------------
File                                           Errors  Warnings  Info
-----------------------------------------------------------------------
DiscTest01_...                                      4         0    42
DiscTest02_...                                      2         0    42
DiscTest17_...                                     17         3    48
DiscTest18_...                                     16         3    48
DiscTest19_...                                      0         9    42
...
-----------------------------------------------------------------------
TOTAL                                             xxx        xx   xxx
```

---

## PowerShell scripts

### One-liner: validate DISC TEST folder with both profiles, reports to a timestamped folder

```powershell
$timestamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$outDir    = "validation-reports\$timestamp"

node validate-cli.js "DISC TEST" `
    --profile "DEXPI Standard and Profile\DiscProfile.xml" `
    --profile "DEXPI Standard and Profile\DiscProfile_FL0.xml" `
    --out $outDir

Write-Host "Reports written to: $outDir"
```

### Full script: validate, log output, check exit code

Save as `Run-Validation.ps1` in the project root:

```powershell
<#
.SYNOPSIS
    Batch-validate all DEXPI XML files in a folder and capture results.

.PARAMETER InputFolder
    Path to the folder containing DEXPI XML files (default: "DISC TEST").

.PARAMETER ProfileBase
    Path to the DiscProfile.xml file (default: standard location in this repo).

.PARAMETER ProfileFL0
    Path to the DiscProfile_FL0.xml file. Omit to skip FL0 profile rules.

.PARAMETER OutFolder
    Folder where CSV reports are written. Defaults to "validation-reports\<timestamp>".

.PARAMETER SummaryOnly
    If set, suppresses CSV output and prints only the summary table.

.EXAMPLE
    .\Run-Validation.ps1 -InputFolder "DISC TEST"

.EXAMPLE
    .\Run-Validation.ps1 -InputFolder "DEXPI Example Files" -SummaryOnly
#>

param(
    [string] $InputFolder = "DISC TEST",
    [string] $ProfileBase = "DEXPI Standard and Profile\DiscProfile.xml",
    [string] $ProfileFL0  = "DEXPI Standard and Profile\DiscProfile_FL0.xml",
    [string] $OutFolder   = "",
    [switch] $SummaryOnly
)

Set-Location $PSScriptRoot

# Build output folder name if not supplied
if (-not $OutFolder) {
    $timestamp = Get-Date -Format "yyyy-MM-dd_HHmm"
    $OutFolder = "validation-reports\$timestamp"
}

# Build argument list
$nodeArgs = @("validate-cli.js", $InputFolder)

if (Test-Path $ProfileBase) {
    $nodeArgs += "--profile", $ProfileBase
} else {
    Write-Warning "Base profile not found: $ProfileBase"
}

if ($ProfileFL0 -and (Test-Path $ProfileFL0)) {
    $nodeArgs += "--profile", $ProfileFL0
}

if ($SummaryOnly) {
    $nodeArgs += "--summary"
} else {
    $nodeArgs += "--out", $OutFolder
}

# Run the validator, capturing stdout+stderr and echoing to console
Write-Host "Running: node $($nodeArgs -join ' ')" -ForegroundColor Cyan
$output = node @nodeArgs 2>&1 | Tee-Object -Variable lines
$exitCode = $LASTEXITCODE

# Write the console log to file alongside the CSVs
if (-not $SummaryOnly) {
    New-Item -ItemType Directory -Force -Path $OutFolder | Out-Null
    $logPath = Join-Path $OutFolder "validation-run.log"
    $lines | Set-Content $logPath -Encoding UTF8
    Write-Host "`nLog saved to: $logPath" -ForegroundColor Cyan
    Write-Host "CSV reports in: $OutFolder" -ForegroundColor Cyan
}

# Report exit status
if ($exitCode -eq 0) {
    Write-Host "`nResult: PASS — no validation errors found." -ForegroundColor Green
} else {
    Write-Host "`nResult: FAIL — one or more files have validation errors." -ForegroundColor Red
}

exit $exitCode
```

Run it:

```powershell
# Default: DISC TEST folder, both profiles, timestamped reports folder
.\Run-Validation.ps1

# Custom folder, summary only, no CSV files
.\Run-Validation.ps1 -InputFolder "DEXPI Example Files" -SummaryOnly

# Specific output folder
.\Run-Validation.ps1 -InputFolder "DEXPI Test" -OutFolder "C:\Reports\DEXPI-Test"
```

---

## Output: CSV report format

Each CSV report contains one row per validation issue with these columns:

| Column | Description |
|--------|-------------|
| Object ID | `id` attribute of the failing XML element |
| Line Number | Source line in the XML file (where available) |
| Object Type | DEXPI type string, e.g. `Plant/Piping.GateValve` |
| Rule ID | Validation rule, e.g. `ERR-E07`, `PRF-E04`, `VAL-004` |
| Severity | `Error`, `Warning`, or `Info` |
| Severity Score | `3` (Error), `2` (Warning), `1` (Info) |
| Rule Description | Human-readable description of the issue |
| Location (XPath) | XPath expression to locate the element, e.g. `//*[@id='GateValve1']` |
| Profile Source | `Base` for DEXPI standard rules, or profile name for PRF rules |
| Suggested Correction | Recommended fix |

The CSV uses UTF-8 encoding with CRLF line endings and double-quoted fields.  It opens
directly in Excel; use **Data → From Text/CSV** and select UTF-8 if special characters appear
garbled.

---

## Validation rules summary

| Rule | Severity | Fires when |
|------|----------|------------|
| `ERR-E06` | Error | Data element contains a value of the wrong type (e.g. text in a `<Double>`) |
| `ERR-E07` | Error | Object type unknown, property name not in meta-model, or multiplicity violated |
| `ERR-E08` | Error | An Object appears inside a composition that does not allow its type |
| `ERR-E09` | Error | A Reference points to an id that does not exist in the file |
| `ERR-E10` | Error | Duplicate `id` attribute values |
| `ERR-E15` | Error | Required top-level metadata object (e.g. `PlantMetaData`) is absent |
| `ERR-E18` | Error | An attribute is not permitted on the given class by the active profile |
| `PRF-E01` | Error | Profile constraint has an invalid `Lower`/`Upper` value |
| `PRF-E02` | Error | Profile constraint references an unknown namespace in `ConstrainedType` |
| `PRF-E04` | Error | `SymbolUsage` references a symbol not defined in the profile, or a symbol designated for a different DEXPI type |
| `PRF-E05` | Warning | A `PipingNodePosition` does not align with any profile-defined piping connection point of the placed symbol, or is connected to an Auxiliary (actuator/operator) port — piping must not be routed to actuator ports |
| `VAL-004` | Info | Object has no graphical representation (no `RepresentationGroup`) |

---

## Folder layout reference

```
DEXPIViewer\                          ← project root (run all commands from here)
│
├─ validate-cli.js                    ← CLI batch validator
├─ src\
│   ├─ validation.js                  ← validation engine (shared with browser UI)
│   └─ dexpiParser.js                 ← DEXPI XML parser
│
├─ DEXPI Standard and Profile\
│   ├─ DiscProfile.xml                ← DISC base profile
│   ├─ DiscProfile_FL0.xml            ← FL0 process profile
│   └─ ...
│
├─ DISC TEST\                         ← 21 test XML files (base + FL0 + PRF errors)
│   ├─ DiscTest01_...xml
│   └─ ...
│
├─ DEXPI Test\                        ← 10 Plant meta-model error test files
│   ├─ Test01_...xml
│   └─ ...
│
└─ validation-reports\                ← created by --out (not committed to git)
    └─ 2026-05-12_1430\
        ├─ DiscTest01_....csv
        ├─ DiscTest02_....csv
        └─ validation-run.log
```

---

## Troubleshooting

**`node: command not found`**
Node.js is not on the PATH.  Install from https://nodejs.org or add the Node install folder
to `$env:PATH` in your PowerShell profile.

**`Error: Cannot find module '@xmldom/xmldom'`**
Run `npm install` once in the project root to restore all dependencies.

**`SyntaxError` or `ERR_UNKNOWN_FILE_EXTENSION`**
Ensure `package.json` contains `"type": "module"` (it does by default in this project).
Also check that `node --version` is 18 or later.

**Files are processed but no PRF-Exx rules fire**
The `--profile` flag was not supplied.  Profile rules (PRF-E01 to PRF-E05) only activate
when at least one profile XML is loaded.

**Exit code is `1` even though the summary shows zero errors**
One of the files threw a parse exception (shown as `[!] ERROR - ...` in the output).  Check
that all XML files in the folder are well-formed.
