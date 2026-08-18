# DEXPI Viewer & Verificator — User Guide

A browser-based viewer and validation engine for [DEXPI 2.0](https://dexpi.org) intelligent P&ID files, with full support for DISC profile validation.

Developed by **Tonia Pedersen** at **[Draga AS](https://draga.no)**.

**Live demo:** [toniapedersen.github.io/DEXPIViewer](https://toniapedersen.github.io/DEXPIViewer/)

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Getting Started](#2-getting-started)
3. [Interface Overview](#3-interface-overview)
4. [Left Panel](#4-left-panel)
5. [Centre Panel — P&ID Drawing](#5-centre-panel-p-id-drawing)
6. [Right Panel — Object Details](#6-right-panel-object-details)
7. [Validation Rules Reference](#7-validation-rules-reference)
8. [Severity Configuration](#8-severity-configuration)
9. [CSV Export](#9-csv-export)
10. [Command-Line Batch Validation](#10-command-line-batch-validation)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Introduction

DEXPI Viewer & Verificator reads DEXPI 2.0 XML files and provides three integrated capabilities:

- **Graphical rendering** — renders the P&ID drawing directly from the XML, including symbols, piping lines, signal connectors, heat trace overlays, and labels.
- **Object model exploration** — structured topology tree with full property, reference, and connectivity details for every object.
- **Validation** — 38+ named rules covering XML well-formedness, DEXPI schema conformance, engineering semantics, and DISC profile compliance.

The application runs entirely in the browser with no server component. A companion command-line tool (`validate-cli.js`) provides the same validation engine for CI/CD pipelines and batch processing.

---

## 2. Getting Started

### 2.1 Opening the Application

Open the application in any modern browser by navigating to the [hosted URL](https://toniapedersen.github.io/DEXPIViewer), or run a local development server:

```bash
npm install
npm run dev
```

All processing happens locally in the browser — no data is sent to any server.

### 2.2 Loading a DEXPI XML File

In the left panel, click **Load DEXPI XML** and select a DEXPI 2.0 XML file. The drawing renders immediately in the centre panel and the topology tree populates in the left panel.

### 2.3 Profile Modes

Two load modes are available at the top of the left panel:

| Mode | Description |
|------|-------------|
| **With profile** | Enables the **DiscProfile.xml** button and profile-specific rules (PRF-E01–E05, VAL-004, ERR-E18, ERR-E19). Use when validating against DISC profile requirements. |
| **Internal** | Profile loading is disabled. Only DEXPI base rules fire. Use for quick structural checks without profile constraints. |

To load profiles:

1. Click **DiscProfile.xml** to load the main DISC base profile.
2. Click **+ Profile** to load additional profiles (e.g. `DiscProfile_FL0.xml`).

Profiles stack in load order — later profiles override constraints from earlier ones where the same constraint appears in both.

> **Note:** Profile rules are inactive until at least one profile is loaded.

### 2.4 Running Validation

After loading a file, click the **Run Validation** button (blue, full-width, in the left panel). The engine runs all applicable rules and displays a summary badge row:

- 🔴 **Red badge** — number of Errors
- 🟡 **Amber badge** — number of Warnings
- 🔵 **Blue badge** — number of Info items

Clicking any badge filters the Validation tab to that severity level. The Validation tab label updates to show the total issue count.

---

## 3. Interface Overview

The application is divided into three panels:

| Area | Description |
|------|-------------|
| **Left panel** | File loading, Topology tree, Validation results, and severity Config tabs. |
| **Centre panel** | Interactive P&ID drawing: rendered graphical view of the DEXPI XML. |
| **Right panel** | Object details, Connections map, and per-object Issues for the selected item. |

All three panels can be collapsed by clicking the arrow button (`<` / `>`) at their edge to give more space to the drawing.

---

## 4. Left Panel

### 4.1 Topology Tab

The Topology tab shows the full DEXPI object model as an expandable tree, organised by containment (e.g. `PlantModel` → `PipingNetworkSystem` → `PipingNetworkSegment`).

Each node displays:
- The object label or tag name (e.g. pump tag `P-101`).
- A coloured dot if validation issues exist: 🔴 red for errors, 🟡 amber for warnings.

Controls above the tree:

- **Search** — type any part of a tag name, object ID, type name, or persistent identifier to filter the tree in real time.
- **Expand all / Collapse all** — expand or collapse the entire tree in one click.

Clicking any node selects it, highlights its graphical counterpart in the drawing, and populates the right panel with its details.

### 4.2 Validation Tab

Lists all validation issues from the last run. Each row shows:

- Severity badge (Error / Warning / Info)
- Rule ID (e.g. `ERR-E07`)
- Object ID and type
- Issue description and suggested correction

Filter buttons at the top let you show **All** issues or filter to a single severity level. Clicking an issue row selects the associated object and navigates to it in the topology tree.

The **CSV** button exports the full issue list as a spreadsheet-compatible file.

### 4.3 Config Tab

Allows per-rule severity overrides. For each rule that has fired, you can change its severity level (Error, Warning, Info, or Ignore). Setting a rule to **Ignore** suppresses it from all displays and counts without re-running validation.

- **Export JSON** — saves the current severity overrides to a JSON file.
- **Import JSON** — loads a previously saved configuration, restoring all overrides.
- **↺** reset button — reverts that rule to its default severity.

---

## 5. Centre Panel — P&ID Drawing

The centre panel renders the DEXPI drawing graphically from the XML data. Symbols, piping lines, signal lines, labels, and connectors are drawn using the geometry defined in the loaded profile's symbol catalogue.

### 5.1 Navigation

| Action | How |
|--------|-----|
| Zoom | Scroll the mouse wheel over the drawing (zooms toward the cursor) |
| Pan | Hold **Space** and drag |
| Fit to window | Click the **Fit** button in the centre toolbar |
| Export view | Click **Save PNG** / **Save PDF** in the centre toolbar (see 5.8, below) |

### 5.2 Selecting Objects

Click any symbol or piping line in the drawing to select it. The selected object is highlighted with a red outline (orange for label elements) and its details appear in the right panel. The corresponding node in the topology tree is also highlighted.

### 5.3 Connectivity Mode

Check **Connectivity** in the centre toolbar to enable connectivity highlighting. When an object is selected, the drawing colour-codes its network neighbours:

| Colour | Meaning |
|--------|---------|
| 🔵 Blue | Upstream objects (flow into the selected item) |
| 🟢 Green | Downstream objects (flow out from the selected item) |
| 🟣 Purple | Group members (same piping network segment or instrumentation loop) |

A legend is shown in the lower-left corner while the checkbox is checked. The highlight is off by default.

### 5.4 Sub-Components

Check **Sub-components** to have a selection also highlight (in red) every child object of the selected item, plus any object it references (e.g. a driven equipment's reference to its motor) other than connectivity refs — useful when selecting a container such as a `PipingNetworkSystem` or `PipingNetworkSegment`. Off by default, so selecting a large container only highlights the container itself.

### 5.5 Heat Trace Overlay

When a DISC profile is loaded, heat-traced elements are detected automatically from the `HeatTracingType` data property. The overlay only activates when `HeatTracingType` is `ElectricalHeatTracingSystem`, `HeatTracingSystem`, `SteamHeatTracingSystem`, or `TubularHeatTracingSystem`; the overlay draws coloured dashed highlights on top of the main drawing — no toggle needed:

- **Piping segments** — dashed overlay on connector lines.
- **Inline components** (valves, fittings, nozzles) — dashed bounding box around the symbol.
- **Instruments** (`ProcessInstrumentationFunction`) — dashed rectangle around the symbol.

### 5.6 Line Boost

**Line Boost** is a percentage multiplier applied to the drawn stroke width of every connector/centerline in the drawing — 100% (the default) is a no-op; raise it to bulk up thin piping and signal lines, e.g. to match the weight of a loaded BG reference image.

Check **Include symbol outlines** to also apply the same percentage to symbol outline strokes. Left unchecked (the default), only connector/centerlines are boosted and symbol geometry renders at its exact drawn weight.

### 5.7 Background Image

Click **BG Image** to overlay a reference image behind the P&ID drawing. Once one is loaded, **BG Controls** appears with:

| Control | Description |
|---------|-------------|
| Visible | Toggle the overlay on or off |
| Blend | -1 to 1. Centered (0) shows the BG image and the DEXPI drawing both fully visible. Drag right to fade out the BG image; drag left to fade out the DEXPI drawing. |
| Scale | Uniform scale factor applied to the auto-fit size (native aspect ratio is always preserved) |
| X / Y | Offset, in drawing units, from the auto-fit (centered) position — not screen pixels, so the range scales with the drawing's own size |
| Reset fit | Sets scale back to 1 and X/Y back to 0, returning to the auto-fit (centered, aspect-correct) placement |
| ⬇ Download PNG with placement | PNG only. Embeds the current Scale / X / Y directly into a copy of the loaded PNG's own file metadata and downloads it. The original file you selected is left untouched — this always hands you a new file. |
| Clear Default | Shown only once the loaded PNG carries an embedded placement. Downloads a copy of the PNG with that embedded placement removed. |
| Remove | Clear the background image |

The image is placed inside the same coordinate space as the drawing, so it pans and zooms in lockstep with it — it stays aligned at any zoom level, not just the level it was set up at.

#### Saving and reloading a placement

Unlike the other BG Controls, the placement isn't kept in the browser — it travels with the image file itself. Once you've dialed in the Scale/X/Y for a PNG, click **⬇ Download PNG with placement** to save it: the values are written into a small text chunk embedded in the PNG's own bytes, alongside the pixel data.

The next time that downloaded PNG is loaded as a BG image — in this app, on another machine, or in a different browser — the embedded Scale/X/Y is read automatically and applied immediately, instead of falling back to the auto-fit placement. No extra step is needed; it just works the way opening any other file with saved settings would.

Only PNG files support an embedded placement (the file format used for the underlying metadata chunk is PNG-specific). Other image types can still be used as a BG image, but their placement resets to auto-fit each time they're reloaded and the download/clear-default buttons stay disabled for them.

### 5.8 Exporting the Drawing

Use **Save PNG** or **Save PDF** in the centre toolbar to save exactly what's currently in the drawing viewport — the DEXPI drawing plus the BG image overlay, if one is loaded and visible — as a file. Both buttons are disabled until a drawing is loaded, and while an export is in progress.

- **Save PNG** — rasterizes the current view to a PNG at a fixed long-edge resolution, aspect ratio matching the current view.
- **Save PDF** — the same rendering, embedded as a single full-page image in a PDF (long edge ~420mm, A3-ish). DEXPI drawing coordinates aren't reliably tied to real-world units, so this is a print-friendly fit rather than a to-scale export.

The downloaded file name is derived from the drawing number where available.

### 5.9 Signal-Conveying Line Styles

When a `SignalConveyingFunction` carries the DiscProfile custom attribute `SignalConveyingFunctionTypeRepresentation` — added by the `SignalConveyingFunctionExtension` class extension (rdl_uri `.../SignalConveyingFunctionTypeRepresentationAssignmentClass`) — its drawn connector line is decorated automatically to indicate the signal type, independent of whatever line style is encoded in the file's own graphics. No configuration is required; the viewer reads the attribute directly from the loaded DEXPI XML whenever it's present. This decoration applies only to `SignalConveyingFunction` itself — its concrete subtypes `MeasuringLineFunction` and `SignalLineFunction` are never decorated, even if they happen to carry the same attribute.

| `SignalConveyingFunctionTypeRepresentation` value | Line decoration |
|---|---|
| `ElectricalSignalConveying` | Solid line with a repeated italic **E** |
| `HydraulicSignalConveying` | Solid line with a repeated upright **L** |
| `BusSignalConveying` | Solid line with a repeated small circle |
| `PneumaticSignalConveying` | Solid line with a repeated **^** chevron |
| `CapillarySignalConveying` | Solid line with a repeated small **x** |
| `UndefinedSignalConveying` | Solid line with a repeated **/** slash |
| `ElectromagneticGuidedSignalConveying` | Solid line with a repeated **∿** squiggle |
| `ElectromagneticUnguidedSignalConveying` | Line hidden entirely — only the repeated **∿** squiggle is drawn, since there is no physical conductor to depict |
| `SignalConveying` (plain, no sub-type) | Dashed line, no repeated mark |
| Attribute absent | Line drawn exactly as encoded in the file, unchanged |

Selecting a decorated line, or highlighting it via Connectivity mode, recolours both the line and its repeated mark together.

### 5.10 Profile Labels

Once a DiscProfile.xml is loaded, a **Profile labels** checkbox appears in the centre toolbar. It controls whether a label's displayed text comes from the loaded profile's own attribute-driven definitions, or from the literal text baked into the DEXPI file.

**Checked** — text shown comes *only* from a placed DiscProfile catalog symbol. A label belonging to a symbol placed from the loaded DiscProfile.xml always shows the value built from that *symbol's own* catalog `Profile/LabelTemplate` (e.g. an `<ObjectDisplayName>` placeholder resolved against the represented object) — never the instance's own literal text or its own `Core/Diagram.TextTemplate`.

**Unchecked** — the raw literal `<Data property="Text">` string is no longer shown for a Profile-governed label once a DiscProfile.xml is loaded. Instead:
- If there is no real attribute backing at all (no `TextTemplate` on the instance and no `LabelTemplate` on the symbol, or either exists but references no attribute), nothing is shown — a purely literal label isn't something the loaded profile has any say over.
- Otherwise, the attribute-resolved value is shown, with any attribute reference that isn't actually valid for the placed symbol (see PRF-E06 in the [Validation Rules Reference](#7-validation-rules-reference)) suppressed rather than displayed.

Text driven by a `TextTemplate`/`LabelTemplate` always renders at its true absolute size regardless of the symbol's own placement scale, and reads left-to-right or bottom-to-top rather than upside-down or right-to-left.

### 5.11 Draw Order — Send to Back

Symbols and lines are drawn in the order they appear in the file, and whichever one paints last sits on top — both visually and for click handling. When two objects overlap (for example a large composite symbol drawn over smaller items nested or positioned underneath it), the top one intercepts every click, making the item(s) beneath it impossible to select directly in the drawing.

To work around this:

1. Select the covering object (in the drawing or the topology tree).
2. In the right panel's **Object** tab, click **⇩ Send to Back** next to the object ID (only shown when the selection has a graphical Symbol Usage). This moves every graphic belonging to that object behind everything else in the drawing.
3. The item(s) that were hidden underneath are now on top and can be clicked normally.

The button toggles to **↺ Restore order** for any object currently sent to back, so you can undo it individually. A **Reset Z-Order (n)** button also appears in the centre toolbar whenever one or more objects have been sent to back, letting you restore the original draw order for all of them at once.

> **Note:** This only changes the on-screen draw/click order for the current session — it is not written back to the DEXPI XML file, and resets automatically whenever a new file is loaded.

---

## 6. Right Panel — Object Details

### 6.1 Object Tab

| Section | Content |
|---------|---------|
| Label and type | Display name and full DEXPI type string (e.g. `Plant/Piping.CentrifugalPump`) |
| Object ID | The XML `id` attribute value |
| Persistent Identifiers | Any `Core/PersistentIdentifier` children with their context values |
| Data | All data properties with values and units of measure |
| References | Outgoing references — blue (valid) or red (broken) clickable links |
| Referenced By | Objects elsewhere in the file that reference this object |
| Parent Component | The containing object with its issue status dot |
| Sub-Components | Children of this object — click any to navigate to it |
| Symbol Usage | For each graphical symbol placement representing this object: its Symbol reference (e.g. `ND0006`), Scale X, Scale Y, Is Mirrored, and Rotation |
| Label SymbolUsage | Same fields as Symbol Usage, shown separately for any symbol placement that sits inside a `Core/Diagram.Label` group (e.g. a special-item-number balloon) rather than the object's own body |

Whenever the selection has a Symbol Usage or Label SymbolUsage, a **Send to Back** button appears next to the Object ID — see section 5.11, "Draw Order — Send to Back," in the [Centre Panel](#5-centre-panel-p-id-drawing) chapter for details on using it to select items hidden behind an overlapping symbol.

### 6.2 Connections Tab

Shows the connectivity map for the selected object:

- **Upstream** — objects that connect into the selected item.
- **Downstream** — objects the selected item connects into.
- **Group** — objects sharing the same network segment or loop.

`FlowIn` and `FlowOut` off-page connectors are colour-coded blue and green respectively. Clicking any entry navigates to that object.

### 6.3 Issues Tab

Lists all validation issues associated with the selected object — severity, rule ID, description, and suggested correction. Only populated after **Run Validation** has been executed.

---

## 7. Validation Rules Reference

Rules marked **Profile required** only fire when at least one profile XML has been loaded.

### VAL — Base Validation

| Rule | Default | Description | Profile required |
|------|---------|-------------|:---:|
| VAL-001 | Error | XML is not well-formed (parse error). | |
| VAL-004 | Info | Model object of a DISC-required type has no `id` attribute, or has no graphical `RepresentationGroup` in the drawing. | ✓ |
| VAL-005 | Error | Broken reference — `objects="…"` points to an ID not present in the file. | |

### ERR — XML Schema & Structural Correctness

| Rule | Default | Description | Profile required |
|------|---------|-------------|:---:|
| ERR-E01 | Error | XML cannot be parsed (fatal error; stops further ERR checks). | |
| ERR-E02 | Error | Import source URL does not match a known DEXPI 2.0 namespace. | |
| ERR-E03 | Error | Unknown XML element tag (not in the DEXPI 2.0 schema). | |
| ERR-E04 | Error | Unknown attribute on an Object element. | |
| ERR-E05 | Error | Object missing mandatory `type` attribute. | |
| ERR-E06 | Error | Value in a typed element (`Double`, `Integer`, `Boolean`, etc.) fails type check. | |
| ERR-E07 | Error | Object type not in the DEXPI 2.0 Plant Meta Model registry; or property name / multiplicity violated. | |
| ERR-E08 | Error | Object placed under an incompatible `Components` property for its type. | |
| ERR-E10 | Error | Duplicate `id` attribute — two or more objects share the same ID. | |
| ERR-E11 | Error | Duplicate `PersistentIdentifier` value across objects. | |
| ERR-E12 | Error | `OperatedValveReference.Valve` references a non-valve type. | |
| ERR-E15 | Error | `PlantMetaData` element is absent from the file. | |
| ERR-E16 | Error | Graphical `Represents` reference points to a non-existent model object. | |
| ERR-E17 | Error | Important equipment, valve, or connector has no `RepresentationGroup` (orphaned model object). | |
| ERR-E18 | Error | Attribute used on a class that does not allow it per the loaded profile's `PropertyConstraint` definitions. | ✓ |
| ERR-E19 | Error | Attribute appears more times than the upper cardinality allows per the loaded profile. | ✓ |
| ERR-E20 | Error | A `Core/Diagram.TextTemplate`'s `AttributeName` doesn't resolve to a value anywhere reachable from the owning object (direct property, or a nested/related object up to two hops out). Skipped when the loaded profile itself recognises the attribute name somewhere in its own LabelTemplate catalogue, since such attributes are legitimately optional. | |

### VAX — Structural / Topology Validation

| Rule | Default | Description | Profile required |
|------|---------|-------------|:---:|
| VAX-001 | Warning | `ActuatingSystem` contains no `ControlledActuator`. | |
| VAX-003 | Warning | `PipingNetworkSystem` contains no `PipingNetworkSegment`; or `InstrumentationLoopFunction` contains no `ProcessInstrumentationFunction`. | |
| VAX-004 | Warning | `PipingNode` is not referenced by any connection (orphaned node). | |
| VAX-005 | Info | `PipingNetworkSegment` has no connections defined. | |

### VAE — Engineering / Semantic Validation

| Rule | Default | Description | Profile required |
|------|---------|-------------|:---:|
| VAE-001 | Warning | `OperatedValveReference` has no `Valve` reference; or major process equipment has no Nozzles. | |
| VAE-002 | Warning | `PipingNetworkSegment` contains no `PipingComponent` or subtype. | |
| VAE-003 | Warning | `ProcessInstrumentationFunction` has no tag, loop number, or function number, and is not a member of any `InstrumentationLoopFunction`. | |
| VAE-004 | Warning | Nozzle is not a child of a `ProcessEquipment` object via the `Nozzles` property. | |
| VAE-005 | Warning | `ConnectorLine` Source and Target are at the same position (zero-length connector). | |
| VAE-006 | Warning | `ProcessInstrumentationFunction` is not the Source or Target of any `SignalConveyingFunction` or subtype. | |

### PRF-E — Profile File Validation

| Rule | Default | Description | Profile required |
|------|---------|-------------|:---:|
| PRF-E01 | Error | Profile XML is not well-formed, or `PropertyConstraint` has an invalid `Lower`/`Upper` value. | ✓ |
| PRF-E02 | Error | `ConstrainedType` in a `PropertyConstraint` is not from a known DEXPI 2.0 namespace. | ✓ |

### PRF — Cross-check: DEXPI XML × DiscProfile.xml

| Rule | Default | Description | Profile required |
|------|---------|-------------|:---:|
| PRF-E04 | Error | A `SymbolUsage` references a Symbol not declared in the profile, or the symbol's allowed types do not match the model object's DEXPI type. | ✓ |
| PRF-E05 | Warning | A `PipingNodePosition` does not align with any profile-defined piping connection point of the placed symbol (within 0.5% of drawing size); or the connection point is designated as Auxiliary (actuator/operator port — piping must not be routed there). | ✓ |
| PRF-E06 | Error | A `Core/Diagram.TextTemplate`'s `AttributeName` is not one of the attribute placeholders the placed symbol's own catalog `Profile/LabelTemplate`(s) actually define — even if that attribute happens to resolve to a real value elsewhere (see ERR-E20 above, which checks resolvability rather than the symbol's own declared placeholder set). | ✓ |
| PRF-007 | Info | A profile constraint was silently overridden by a later-loaded profile (logged when multiple profiles are stacked). | ✓ |
| PRF-{profile}-{property} | Warning | A model object is missing a property that is required (`Lower ≥ 1`) by the loaded profile's `PropertyConstraint`. Generated dynamically per property. | ✓ |

---

## 8. Severity Configuration

Every rule has a default severity. These can be overridden per-installation using the Config tab.

| Severity | Colour | Effect |
|----------|--------|--------|
| Error | 🔴 Red | Increments the error count; exit code 1 in the CLI |
| Warning | 🟡 Amber | Increments the warning count |
| Info | 🔵 Blue | Informational only |
| Ignore | — | Rule is completely suppressed from all displays and counts |

Severity configurations can be exported to JSON and shared across projects or teams. Import the JSON file via the Config tab to restore the configuration in any session.

> **Note:** Severity overrides apply only to the current browser session unless saved and re-imported. They are not stored in the DEXPI XML file.

---

## 9. CSV Export

Click the **CSV** button (in the left panel toolbar or the Validation tab) to export all validation results. The file uses UTF-8 encoding with CRLF line endings and double-quoted fields — it opens directly in Excel.

> If special characters appear garbled in Excel, use **Data → From Text/CSV** and select UTF-8 encoding.

Columns in the CSV file:

| Column | Description |
|--------|-------------|
| Object ID | The `id` attribute of the failing XML element |
| Line Number | Source line in the XML file (where available) |
| Object Type | DEXPI type string, e.g. `Plant/Piping.GateValve` |
| Rule ID | Validation rule, e.g. `ERR-E07`, `PRF-E04`, `VAL-004` |
| Severity | `Error`, `Warning`, or `Info` |
| Severity Score | `3` (Error), `2` (Warning), `1` (Info) |
| Rule Description | Human-readable description of the issue |
| Location (XPath) | XPath to locate the element, e.g. `//*[@id='GateValve1']` |
| Profile Source | `Base` for DEXPI standard rules, or the profile name for PRF rules |
| Suggested Correction | Recommended fix |

---

## 10. Command-Line Batch Validation

`validate-cli.js` provides the same validation engine as the browser for use in terminals, CI/CD pipelines, and automated QA workflows. Results are identical to the browser UI.

### 10.1 Prerequisites

- Node.js 18 LTS or later
- `npm install` run once in the project root

### 10.2 Usage

```
node validate-cli.js <file-or-folder> [options]

npm run validate -- <file-or-folder> [options]   # npm shortcut
```

| Option | Description |
|--------|-------------|
| `--profile <file>` | Load a DISC profile XML. Repeatable for multiple profiles. |
| `--out <folder>` | Write CSV reports to this folder instead of next to each input file. |
| `--summary` | Print the summary table to stdout only; do not write CSV files. |
| `--help` | Show built-in help. |

Exit code: `0` = no errors found; `1` = at least one error detected.

### 10.3 Examples

```powershell
# Validate a single file
node validate-cli.js plant.xml

# Validate a folder with the DISC base profile
node validate-cli.js "DISC TEST" `
    --profile "DEXPI Standard and Profile\DiscProfile.xml"

# Validate with base + FL0 profiles, reports to a timestamped folder
node validate-cli.js "DISC TEST" `
    --profile "DEXPI Standard and Profile\DiscProfile.xml" `
    --profile "DEXPI Standard and Profile\DiscProfile_FL0.xml" `
    --out "validation-reports\2026-05-21"

# Summary-only mode (no CSV files written — useful in CI)
node validate-cli.js "DISC TEST" --profile DiscProfile.xml --summary
```

### 10.4 Console Output

Each file produces one line:

```
Validating MyFile.xml ... [x]  4 errors  2 warnings  18 info
```

| Icon | Meaning |
|------|---------|
| `[v]` | Clean — no errors or warnings |
| `[!]` | Warnings only |
| `[x]` | One or more errors |

When `--summary` is used, a totals table is printed after all files are processed.

### 10.5 PowerShell Script

A reusable PowerShell script (`Run-Validation.ps1`) is included in the project root:

```powershell
# Default: DISC TEST folder, both profiles, timestamped output folder
.\Run-Validation.ps1

# Summary only — no CSV files
.\Run-Validation.ps1 -SummaryOnly

# Custom input folder and output location
.\Run-Validation.ps1 -InputFolder "My Files" -OutFolder "C:\Reports"
```

The script creates a timestamped output folder automatically and writes a `validation-run.log` alongside the CSV reports.

---

## 11. Troubleshooting

**No PRF-Exx rules fire**
Profile rules only activate when at least one profile XML is loaded. In the browser, ensure **With profile** mode is selected and a profile file has been loaded. In the CLI, ensure `--profile` is supplied.

**Validation results differ between browser and CLI**
Both use the same engine. Check that the same profile files are loaded in both, and that severity overrides in the browser Config tab have not been applied.

**CLI: `Cannot find module '@xmldom/xmldom'`**
Run `npm install` in the project root to restore all dependencies.

**CLI: `node: command not found`**
Node.js is not on the PATH. Install from [nodejs.org](https://nodejs.org) or add the Node install folder to the `PATH` environment variable.

**Excel shows garbled characters in the CSV**
Use **Data → From Text/CSV** in Excel and select UTF-8 encoding.

**Drawing renders blank or partially**
The file may reference profile symbols that are not loaded. Load the appropriate `DiscProfile.xml` (and FL0 profile if needed) — the parser re-runs automatically when a new profile is added.

**Background image does not align with the drawing**
The image is auto-fit (centered, aspect-correct) into the drawing extents on load and rendered inside the same coordinate space as the drawing, so it stays aligned at any pan/zoom level. Use the Scale and X/Y controls in BG Controls, or click **Reset fit** to snap back to the auto-fit placement — offsets are in drawing units, not screen pixels. If you're reloading a PNG you've previously aligned, make sure you're loading the copy downloaded via **⬇ Download PNG with placement** (see 5.7) — the original file you first selected was never modified and has no embedded placement.

**Background image placement resets every time I reopen the file**
Only PNG images can carry a saved placement, and only once you've explicitly downloaded a copy with it embedded (5.7). Reopening the original, unmodified file — or a non-PNG image — always starts at the auto-fit placement, by design.
