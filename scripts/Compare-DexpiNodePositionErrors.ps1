<#
.SYNOPSIS
    Annotates a DEXPI node-position error report with a real-error-vs-rounding-noise
    classification, computed from the actual symbol geometry in a DiscProfile.xml.

.DESCRIPTION
    Third-party DEXPI validators often flag PipingNodePosition / InstrumentationNodePosition
    coordinates as invalid ("not a valid PipingNodePosition for Symbol NDxxxx", "not on the
    diagram grid...") without saying how far off, or why. Many of these are floating-point
    noise from Smart P&ID's rotation/scale export math, not real placement mistakes.

    This script re-derives, for every flagged line, the symbol placement (position, rotation,
    scale, mirror) that owns that NodePosition, transforms the symbol's own connection-point
    geometry (from DiscProfile.xml) into world coordinates, and measures the distance between
    the flagged point and its nearest valid connection point. That distance is what separates
    genuine rounding noise from a real placement error - the same approach, and the same
    world-transform formula, used by this project's own PRF-E05 check in src/validation.js.

    Each output row is classified as one of:
      ROUNDING_NOISE              - within 0.0001 units of a valid connection point (safe to
                                     snap on import)
      BORDERLINE                  - a Piping node 0.0001-0.01 units off (small, spot-check)
      REAL_ERROR_CONFIRMED        - a Piping node > 0.01 units from any valid connection point
                                     of its own symbol (not explainable by rounding)
      NOT_VERIFIABLE_BY_GEOMETRY  - only the Grid/Instrumentation check fired, never Piping.
                                     This project's own validator deliberately does not distance-
                                     check InstrumentationNodePosition against the symbol body
                                     (instrument leader lines legitimately run far from the
                                     bubble), so this distance isn't a meaningful validity signal.
      SYMBOL_MISSING_FROM_PROFILE - the referenced symbol isn't defined in DiscProfile.xml at all
      SYMBOL_HAS_NO_NODES_DEFINED - the symbol is defined but has zero Profile/NodePosition
                                     entries in any of its variants - a profile authoring gap
      NO_SYMBOL_PLACED            - the flagged node has no drawn symbol nearby at all (a bare
                                     piping/instrumentation topology point, e.g. a PropertyBreak)

.PARAMETER DexpiFile
    Path to the DEXPI 2.0 P&ID XML instance that was validated (the file the error list is about).
    Optional - falls back to the $DefaultDexpiFile variable near the top of the script.

.PARAMETER ProfileFile
    Path to the DiscProfile.xml (or equivalent Profile model XML) that defines the symbols'
    connection-point geometry. Optional - falls back to $DefaultProfileFile.

.PARAMETER ErrorListFile
    Path to the original validator error report, as plain tab-separated text with a header row:
        Line<TAB>Location<TAB>Level<TAB>Type<TAB>Description
    "Type" must be one of: "Node Position Error (Piping)", "Node Position Error (Instrumentation)",
    "Grid Alignment Error (InstrumentationNodePosition)" - i.e. copy/pasted straight from the
    validator's report table. Optional - falls back to $DefaultErrorListFile.

.PARAMETER OutputFile
    Where to write the annotated CSV. Optional - falls back to $DefaultOutputFile (or, if that's
    left blank, "<ErrorListFile>.annotated.csv" next to the input error list).

.EXAMPLE
    .\Compare-DexpiNodePositionErrors.ps1
    Uses the four $Default... paths hardcoded near the top of the script - edit those once and
    just re-run the script with no arguments each time you get a new error list.

.EXAMPLE
    .\Compare-DexpiNodePositionErrors.ps1 -DexpiFile .\MyPlant.xml -ProfileFile ".\DEXPI Standard and Profile\DiscProfile.xml" -ErrorListFile .\errors.txt
    Overrides one or more of the defaults on the command line for a one-off run.

.NOTES
    Requires PowerShell 5.1+ (Windows PowerShell or PowerShell 7/pwsh). No external modules.
#>
[CmdletBinding()]
param(
    [string]$DexpiFile,
    [string]$ProfileFile,
    [string]$ErrorListFile,
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Xml.Linq

# ── User-editable defaults ─────────────────────────────────────────────────────
# Edit these four paths to point at your files, then you can just run:
#     .\Compare-DexpiNodePositionErrors.ps1
# with no arguments at all. Any of the four can still be overridden on the
# command line (e.g. -DexpiFile .\Other.xml) - a passed-in argument always wins
# over the default below.
$DefaultDexpiFile     = 'C:\GitHub\DEXPIViewer\ValidationErrTestFiles\UPPAILPXB2401001.enhanced.xml.Dexpi_2.0_updated.xml'
$DefaultProfileFile   = 'C:\GitHub\DEXPIViewer\DEXPI Standard and Profile\DiscProfile.xml'
$DefaultErrorListFile = 'C:\GitHub\DEXPIViewer\ValidationErrTestFiles\errors.txt'
$DefaultOutputFile    = 'C:\GitHub\DEXPIViewer\ValidationErrTestFiles\errors.annotated.csv'
# ────────────────────────────────────────────────────────────────────────────────

if (-not $DexpiFile)     { $DexpiFile     = $DefaultDexpiFile }
if (-not $ProfileFile)   { $ProfileFile   = $DefaultProfileFile }
if (-not $ErrorListFile) { $ErrorListFile = $DefaultErrorListFile }
if (-not $OutputFile) {
    $OutputFile = if ($DefaultOutputFile) {
        $DefaultOutputFile
    } else {
        [System.IO.Path]::ChangeExtension($ErrorListFile, $null).TrimEnd('.') + '.annotated.csv'
    }
}

foreach ($pair in @(
        @{ Name = 'DexpiFile';     Path = $DexpiFile },
        @{ Name = 'ProfileFile';   Path = $ProfileFile },
        @{ Name = 'ErrorListFile'; Path = $ErrorListFile }
    )) {
    if (-not (Test-Path -LiteralPath $pair.Path -PathType Leaf)) {
        throw "$($pair.Name) not found: '$($pair.Path)'. Edit the `$Default$($pair.Name) variable near the top of the script, or pass -$($pair.Name) <path>."
    }
}

# Rounding tolerance: a delta at or below this (world units) is treated as floating-point noise.
$ROUNDING_EPS = 0.0001
# Above the rounding tolerance but at or below this, a Piping mismatch is flagged as borderline
# rather than a confirmed real error.
$BORDERLINE_EPS = 0.01

# ── XML helpers ────────────────────────────────────────────────────────────────

function Get-ChildData {
    param($Element, [string]$PropertyName)
    foreach ($d in $Element.Elements('Data')) {
        $p = $d.Attribute('property')
        if ($p -and $p.Value -eq $PropertyName) { return $d }
    }
    return $null
}

function Get-PointXY {
    # Reads a <Data property="Position"><AggregatedDataValue type="Core/Diagram.Point">
    #   <Data property="X"><Double>..</Double></Data><Data property="Y">..</Data>
    # </AggregatedDataValue></Data> structure directly under $Element.
    param($Element)
    $posData = Get-ChildData -Element $Element -PropertyName 'Position'
    if (-not $posData) { return $null }
    $agv = $posData.Element('AggregatedDataValue')
    if (-not $agv) { return $null }
    $x = $null; $y = $null
    foreach ($d in $agv.Elements('Data')) {
        $p = $d.Attribute('property')
        if (-not $p) { continue }
        $valEl = $d.Element('Double')
        if (-not $valEl) { $valEl = $d.Element('Integer') }
        if (-not $valEl) { continue }
        $v = [double]::Parse($valEl.Value, [System.Globalization.CultureInfo]::InvariantCulture)
        if ($p.Value -eq 'X') { $x = $v }
        elseif ($p.Value -eq 'Y') { $y = $v }
    }
    if ($null -ne $x -and $null -ne $y) {
        return [pscustomobject]@{ X = $x; Y = $y }
    }
    return $null
}

# ── DiscProfile.xml: symbol -> connection-point geometry ──────────────────────

function Read-DexpiProfile {
    param([string]$Path)

    Write-Host "Loading profile: $Path"
    $doc = [System.Xml.Linq.XDocument]::Load($Path)

    $symbolNodes = @{}   # name -> List[ {X,Y} ]  (Piping-type connection points)
    $symbolAux   = @{}   # name -> List[ {X,Y} ]  (Auxiliary/actuator-type connection points)
    $symbolInfo  = @{}   # name -> @{ Variants; Nodes; Usages }

    foreach ($sym in $doc.Descendants('Object')) {
        $typeAttr = $sym.Attribute('type')
        if (-not $typeAttr -or $typeAttr.Value -ne 'Profile/Symbol') { continue }
        $nameAttr = $sym.Attribute('name')
        if (-not $nameAttr) { continue }
        $name = $nameAttr.Value

        $usages = New-Object System.Collections.Generic.List[string]
        foreach ($d in $sym.Elements('Data')) {
            $p = $d.Attribute('property')
            if ($p -and $p.Value -eq 'MetaData/usage') {
                $s = $d.Element('String')
                if ($s) { $usages.Add($s.Value) }
            }
        }

        $nodeList = New-Object System.Collections.Generic.List[object]
        $auxList  = New-Object System.Collections.Generic.List[object]
        $variantCount = 0

        foreach ($variant in $sym.Descendants('Object')) {
            $vType = $variant.Attribute('type')
            if (-not $vType -or $vType.Value -ne 'Profile/SymbolVariant') { continue }
            $variantCount++
            foreach ($npObj in $variant.Descendants('Object')) {
                $npType = $npObj.Attribute('type')
                if (-not $npType -or $npType.Value -ne 'Profile/NodePosition') { continue }
                $pt = Get-PointXY -Element $npObj
                if (-not $pt) { continue }

                $nodeTypeVal = $null
                $typeData = Get-ChildData -Element $npObj -PropertyName 'Type'
                if ($typeData) {
                    $dr = $typeData.Element('DataReference')
                    if ($dr) {
                        $dv = $dr.Attribute('data')
                        if ($dv) { $nodeTypeVal = $dv.Value }
                    }
                }

                if ($nodeTypeVal -eq 'Profile/NodePositionType.Auxiliary') {
                    $auxList.Add($pt)
                } else {
                    # $nodeTypeVal is $null or Profile/NodePositionType.Piping -> a piping port
                    $nodeList.Add($pt)
                }
            }
        }

        if ($symbolNodes.ContainsKey($name)) {
            # A symbol name repeated in the file (unusual, but merge defensively).
            foreach ($n in $nodeList) { $symbolNodes[$name].Add($n) }
            foreach ($a in $auxList) { $symbolAux[$name].Add($a) }
            $symbolInfo[$name].Nodes    += ($nodeList.Count + $auxList.Count)
            $symbolInfo[$name].Variants += $variantCount
            foreach ($u in $usages) { $symbolInfo[$name].Usages.Add($u) }
        } else {
            $symbolNodes[$name] = $nodeList
            $symbolAux[$name]   = $auxList
            $symbolInfo[$name]  = [pscustomobject]@{
                Variants = $variantCount
                Nodes    = ($nodeList.Count + $auxList.Count)
                Usages   = $usages
            }
        }
    }

    Write-Host ("  {0} symbols loaded, {1} with at least one connection point defined" -f `
        $symbolInfo.Count, ($symbolInfo.Values | Where-Object { $_.Nodes -gt 0 } | Measure-Object).Count)

    return [pscustomobject]@{ Nodes = $symbolNodes; Aux = $symbolAux; Info = $symbolInfo }
}

# ── World-coordinate transform (matches src/validation.js PRF-E05) ────────────
#   world.x = posX + lx*cos - ly*sin
#   world.y = posY - lx*sin - ly*cos
#   where lx = localX*scaleX (negated if mirrored), ly = localY*scaleY

function Convert-LocalToWorld {
    param([double]$LocalX, [double]$LocalY, $Transform)
    $rad = $Transform.Rotation * [Math]::PI / 180.0
    $cos = [Math]::Cos($rad)
    $sin = [Math]::Sin($rad)
    $lx = $LocalX * $Transform.ScaleX
    $ly = $LocalY * $Transform.ScaleY
    if ($Transform.Mirrored) { $lx = -$lx }
    $wx = $Transform.PosX + ($lx * $cos) - ($ly * $sin)
    $wy = $Transform.PosY - ($lx * $sin) - ($ly * $cos)
    return [pscustomobject]@{ X = $wx; Y = $wy }
}

function Get-SymbolUsageTransform {
    param($SymbolUsageElement)
    $rot = 0.0; $scaleX = 1.0; $scaleY = 1.0; $mirrored = $false; $symName = $null

    $pt = Get-PointXY -Element $SymbolUsageElement
    $posX = $null; $posY = $null
    if ($pt) { $posX = $pt.X; $posY = $pt.Y }

    foreach ($d in $SymbolUsageElement.Elements('Data')) {
        $p = $d.Attribute('property')
        if (-not $p) { continue }
        switch ($p.Value) {
            'Rotation' {
                $v = $d.Element('Double'); if (-not $v) { $v = $d.Element('Integer') }
                if ($v) { $rot = [double]::Parse($v.Value, [System.Globalization.CultureInfo]::InvariantCulture) }
            }
            'ScaleX' {
                $v = $d.Element('Double'); if (-not $v) { $v = $d.Element('Integer') }
                if ($v) { $scaleX = [double]::Parse($v.Value, [System.Globalization.CultureInfo]::InvariantCulture) }
            }
            'ScaleY' {
                $v = $d.Element('Double'); if (-not $v) { $v = $d.Element('Integer') }
                if ($v) { $scaleY = [double]::Parse($v.Value, [System.Globalization.CultureInfo]::InvariantCulture) }
            }
            'IsMirrored' {
                $v = $d.Element('Boolean')
                if ($v) { $mirrored = ($v.Value.Trim().ToLowerInvariant() -eq 'true') }
            }
        }
    }

    foreach ($r in $SymbolUsageElement.Elements('References')) {
        $p = $r.Attribute('property')
        if ($p -and $p.Value -eq 'Symbol') {
            $objsAttr = $r.Attribute('objects')
            if ($objsAttr) {
                $parts = $objsAttr.Value -split '/'
                $symName = $parts[$parts.Count - 1]
            }
        }
    }

    return [pscustomobject]@{
        PosX = $posX; PosY = $posY; Rotation = $rot
        ScaleX = $scaleX; ScaleY = $scaleY; Mirrored = $mirrored; SymName = $symName
    }
}

function Find-SymbolUsageAncestor {
    # Walks up from a NodePosition <Object> to the nearest ancestor
    # Core/Diagram.RepresentationGroup that owns a Components[@property='Groups'] child, and
    # returns the Profile/SymbolUsage found inside it (if any). Stops climbing as soon as that
    # scope boundary is found - even when it turns out to hold no SymbolUsage (e.g. a
    # PropertyBreak's Groups component only nests further NodePosition-only groups) - because
    # climbing PAST that boundary would attribute a physically unrelated, distant SymbolUsage
    # to this node, which is worse than reporting "no symbol usage found".
    param($Element)
    $node = $Element.Parent
    while ($null -ne $node) {
        $typeAttr = $node.Attribute('type')
        if ($node.Name.LocalName -eq 'Object' -and $typeAttr -and $typeAttr.Value -eq 'Core/Diagram.RepresentationGroup') {
            $groupsComp = $null
            foreach ($child in $node.Elements()) {
                if ($child.Name.LocalName -eq 'Components') {
                    $cp = $child.Attribute('property')
                    if ($cp -and $cp.Value -eq 'Groups') { $groupsComp = $child; break }
                }
            }
            if ($null -ne $groupsComp) {
                $suFound = $null
                foreach ($su in $groupsComp.Descendants('Object')) {
                    $st = $su.Attribute('type')
                    if ($st -and $st.Value -eq 'Profile/SymbolUsage') { $suFound = $su; break }
                }
                return $suFound
            }
        }
        $node = $node.Parent
    }
    return $null
}

# ── DEXPI instance: for every flagged line, resolve symbol + nearest valid point ──

function Resolve-FlaggedNodePositions {
    param([string]$Path, [hashtable]$FlaggedLines, $ProfileData)

    Write-Host "Loading DEXPI instance: $Path"
    $doc = [System.Xml.Linq.XDocument]::Load($Path, [System.Xml.Linq.LoadOptions]::SetLineInfo)

    $results = @{}   # line number -> resolved entry
    $wantedTypes = @('Plant/Diagram.PipingNodePosition', 'Plant/Diagram.InstrumentationNodePosition', 'Core/Diagram.NodePosition')

    foreach ($obj in $doc.Descendants('Object')) {
        $typeAttr = $obj.Attribute('type')
        if (-not $typeAttr -or ($wantedTypes -notcontains $typeAttr.Value)) { continue }

        $li = [System.Xml.IXmlLineInfo]$obj
        if (-not $li.HasLineInfo()) { continue }
        $ln = $li.LineNumber
        if (-not $FlaggedLines.ContainsKey($ln)) { continue }

        $idAttr = $obj.Attribute('id')
        $id = if ($idAttr) { $idAttr.Value } else { '(no id)' }
        $pt = Get-PointXY -Element $obj
        $x = $null; $y = $null
        if ($pt) { $x = $pt.X; $y = $pt.Y }

        $entry = [pscustomobject]@{
            Line = $ln; Id = $id; NodeType = ($typeAttr.Value -split '\.')[-1]
            X = $x; Y = $y; Symbol = $null; Delta = $null; NearestX = $null; NearestY = $null
        }

        $su = Find-SymbolUsageAncestor -Element $obj
        if ($null -eq $su) {
            $results[$ln] = $entry
            continue
        }

        $t = Get-SymbolUsageTransform -SymbolUsageElement $su
        $entry.Symbol = $t.SymName

        if ($null -eq $t.PosX -or $null -eq $x -or $null -eq $t.SymName) {
            $results[$ln] = $entry
            continue
        }

        $candidates = New-Object System.Collections.Generic.List[object]
        if ($ProfileData.Nodes.ContainsKey($t.SymName)) { foreach ($c in $ProfileData.Nodes[$t.SymName]) { $candidates.Add($c) } }
        if ($ProfileData.Aux.ContainsKey($t.SymName))   { foreach ($c in $ProfileData.Aux[$t.SymName])   { $candidates.Add($c) } }

        $best = $null; $bestX = $null; $bestY = $null
        foreach ($c in $candidates) {
            $w = Convert-LocalToWorld -LocalX $c.X -LocalY $c.Y -Transform $t
            $dx = $w.X - $x; $dy = $w.Y - $y
            $d = [Math]::Sqrt(($dx * $dx) + ($dy * $dy))
            if ($null -eq $best -or $d -lt $best) { $best = $d; $bestX = $w.X; $bestY = $w.Y }
        }
        if ($null -ne $best) {
            $entry.Delta = $best; $entry.NearestX = $bestX; $entry.NearestY = $bestY
        }

        $results[$ln] = $entry
    }

    return $results
}

# ── Error list parsing ─────────────────────────────────────────────────────────

function Read-ErrorList {
    param([string]$Path)

    $lines = Get-Content -LiteralPath $Path
    if ($lines.Count -eq 0) { throw "Error list file '$Path' is empty." }

    $startIdx = 0
    if ($lines[0] -match '^\s*Line\s*\t') { $startIdx = 1 }   # skip header row if present

    $rows = New-Object System.Collections.Generic.List[object]
    for ($i = $startIdx; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split "`t"
        if ($parts.Count -lt 5) {
            Write-Warning "Skipping malformed row $($i + 1): expected 5 tab-separated fields, got $($parts.Count)"
            continue
        }
        $lineNum = 0
        if (-not [int]::TryParse($parts[0].Trim(), [ref]$lineNum)) {
            Write-Warning "Skipping row $($i + 1): '$($parts[0])' is not a line number"
            continue
        }
        $typeText = $parts[3].Trim()
        $code = $null
        if ($typeText -match 'Grid Alignment') { $code = 'G' }
        elseif ($typeText -match 'Piping') { $code = 'P' }
        elseif ($typeText -match 'Instrumentation') { $code = 'I' }
        else {
            Write-Warning "Skipping row $($i + 1): unrecognised Type '$typeText'"
            continue
        }
        # Description may itself contain tabs only in unusual cases; rejoin any trailing fields.
        $description = ($parts[4..($parts.Count - 1)] -join "`t").Trim()

        $rows.Add([pscustomobject]@{
            Line = $lineNum; Location = $parts[1].Trim(); Level = $parts[2].Trim()
            TypeText = $typeText; Description = $description; Code = $code
        })
    }
    return $rows
}

# ── Classification ──────────────────────────────────────────────────────────────

function Get-NodeClassification {
    param($Entry, [string]$Code, [hashtable]$SymbolInfo)

    if ($null -eq $Entry -or $null -eq $Entry.Delta) {
        if ($null -eq $Entry -or $null -eq $Entry.Symbol) {
            return [pscustomobject]@{
                Tier = 'NO_SYMBOL_PLACED'
                Note = 'bare piping/instrumentation node with no drawn symbol nearby (e.g. a topology-only point such as a PropertyBreak) - nothing to check against'
            }
        }
        $sym = $Entry.Symbol
        if (-not $SymbolInfo.ContainsKey($sym)) {
            return [pscustomobject]@{
                Tier = 'SYMBOL_MISSING_FROM_PROFILE'
                Note = "'$sym' is not defined in the supplied DiscProfile.xml at all"
            }
        }
        $info = $SymbolInfo[$sym]
        if ($info.Nodes -eq 0) {
            return [pscustomobject]@{
                Tier = 'SYMBOL_HAS_NO_NODES_DEFINED'
                Note = "'$sym' is defined in DiscProfile.xml but has zero Profile/NodePosition entries in any of its $($info.Variants) variant(s) - profile authoring gap; this node can never validate until the profile defines connection points for this symbol"
            }
        }
        return [pscustomobject]@{ Tier = 'UNRESOLVED'; Note = 'could not resolve position data for this node' }
    }

    $d = $Entry.Delta
    if ($d -le $ROUNDING_EPS) {
        return [pscustomobject]@{
            Tier = 'ROUNDING_NOISE'
            Note = ("matches a valid connection point of symbol '{0}' to within {1:E2} units (floating-point noise) - safe to snap on import" -f $Entry.Symbol, $d)
        }
    }
    if ($Code -eq 'P') {
        if ($d -le $BORDERLINE_EPS) {
            return [pscustomobject]@{
                Tier = 'BORDERLINE'
                Note = ("piping node is {0:F4} units from its nearest valid connection point - small but non-zero, worth a spot-check" -f $d)
            }
        }
        return [pscustomobject]@{
            Tier = 'REAL_ERROR_CONFIRMED'
            Note = ("piping node is {0:F3} units from the nearest valid connection point of symbol '{1}' (nearest valid point: {2:F3}, {3:F3}) - not explainable by rounding" -f $d, $Entry.Symbol, $Entry.NearestX, $Entry.NearestY)
        }
    }
    return [pscustomobject]@{
        Tier = 'NOT_VERIFIABLE_BY_GEOMETRY'
        Note = "only flagged via the Grid/Instrumentation check, never the Piping check; instrument leader lines legitimately run far from the symbol body, so distance-from-symbol is not a meaningful validity signal for these - likely a grid-snap false positive, but not independently confirmed"
    }
}

# ── Main ─────────────────────────────────────────────────────────────────────────

Write-Host "=== DEXPI Node Position Error Annotator ==="

Write-Host "`nStep 1/4: Reading error list..."
$errorRows = Read-ErrorList -Path $ErrorListFile
$flaggedLines = @{}
foreach ($r in $errorRows) { $flaggedLines[$r.Line] = $true }
Write-Host ("  {0} rows read, {1} unique flagged lines" -f $errorRows.Count, $flaggedLines.Count)

Write-Host "`nStep 2/4: Reading DiscProfile.xml..."
$profileData = Read-DexpiProfile -Path $ProfileFile

Write-Host "`nStep 3/4: Reading DEXPI instance and computing distances to valid connection points..."
$resolved = Resolve-FlaggedNodePositions -Path $DexpiFile -FlaggedLines $flaggedLines -ProfileData $profileData
Write-Host ("  Resolved {0} of {1} flagged lines to an XML object" -f $resolved.Count, $flaggedLines.Count)

Write-Host "`nStep 4/4: Classifying and writing annotated CSV..."
$outRows = New-Object System.Collections.Generic.List[object]
foreach ($r in $errorRows) {
    $entry = $resolved[$r.Line]
    $cls = Get-NodeClassification -Entry $entry -Code $r.Code -SymbolInfo $profileData.Info

    $delta = ''
    $nearest = ''
    if ($entry -and $null -ne $entry.Delta) {
        $delta = '{0:F6}' -f $entry.Delta
        $nearest = '({0:F6}, {1:F6})' -f $entry.NearestX, $entry.NearestY
    }

    $outRows.Add([pscustomobject]@{
        Line                   = $r.Line
        Location               = $r.Location
        Level                  = $r.Level
        Type                   = $r.TypeText
        Description            = $r.Description
        Classification         = $cls.Tier
        DeltaFromValidPosition = $delta
        NearestValidPosition   = $nearest
        Note                   = $cls.Note
    })
}

$outRows | Export-Csv -LiteralPath $OutputFile -NoTypeInformation -Encoding UTF8

Write-Host ("`nWrote {0} rows to {1}" -f $outRows.Count, $OutputFile)
Write-Host "`nClassification summary:"
$outRows | Group-Object Classification | Sort-Object Count -Descending | ForEach-Object {
    Write-Host ("  {0,-28} {1}" -f $_.Name, $_.Count)
}
