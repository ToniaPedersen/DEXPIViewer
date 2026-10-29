# Changelog

## 2.2.3

Changes from version 2.2.2 (commit `64dfb89`).

### Version

- The app is versioned as **2.2.3** (`package.json` / `package-lock.json` 2.2.3).
- The version shows next to the title in the left panel and in the User Guide.

### Labels for draga.no (xBRIDGE) profiles

Profiles published from `draga.no` (the xBRIDGE / MIMS_Bridge export, e.g. `uri="https://draga.no/xbridge/profile/project-Project_TH"`) define no `Profile/LabelTemplate` on their symbols. Under the "Profile selected" rule almost every label was therefore blanked. The rule is now relaxed for these profiles only.

| Case (draga.no profile loaded) | 2.2.2 | 2.2.3 |
|---|---|---|
| Label with attribute references, symbol without LabelTemplates (or no profile symbol) | blank | resolved references |
| Segment line label referencing its PipingNetworkSystem (e.g. `8"-W47260-11200Y-NI`) | blank | resolved from the system |
| Literal-only label or Note line, profile has no LabelTemplates at all | blank | stored text |
| Same labels with **Profile labels** checked | blank | as unchecked |
| Linked line graphics without a symbol in the group (e.g. Note "MIN." markers) | dropped | drawn |
| Signal line type stored as `<prefix>/SignalConveyingFunctionTypeRepresentation` | not recognised | recognised |
| DiscProfile and other profiles | | unchanged |

On `0000-1-08-96706-rev4` with its `profile.xml`, 284 of 288 label texts are shown, up from 13.

Implementation (`src/dexpiParser.js`):

- new `isDragaProfile()`: the profile's `uri` host is `draga.no` or a subdomain;
- `isLabelReferenceAllowed()`: for draga.no profiles, a `PipingNetworkSegment`'s label may read its owning `PipingNetworkSystem`;
- "Profile selected" pass: labels of objects without a LabelTemplate-bearing symbol are resolved from their own fragments (or keep their stored text when the profile has no LabelTemplates and the label has no attribute reference), with `isDiscProfileLabel` cleared; literal Note lines keep their text under the same condition;
- signal line type: falls back to any `*/SignalConveyingFunctionTypeRepresentation` property;
- `isAllowedLine` filter skipped for draga.no profiles.

### User Guide

- `public/UserGuide.md`: version 2.2.3; section 5.10 *Profile Labels* gains *draga.no (xBRIDGE) profiles*.
- `public/UserGuide.html`: version 2.2.3 in the title and heading.

### Files changed

`package.json`, `package-lock.json`, `ChangeLog_2.1_to_2.2.md` (this section), `public/UserGuide.md`, `public/UserGuide.html`, `src/dexpiParser.js`.

## 2.2.2

Changes from version 2.2.1.

### Version

- The app is versioned as **2.2.2** (`package.json` / `package-lock.json` 2.2.2).
- The version shows next to the title in the left panel and in the User Guide.

### Heat trace ring on ND0248B tag bubbles

An ND0248B tag bubble now shows heat tracing the same way as an ND0248A instrument bubble: a dashed ring 1 mm outside its circle. The ring is drawn when the object the bubble represents (e.g. a valve) has an active `HeatTracingType`.

| Case | 2.2.1 | 2.2.2 |
|---|---|---|
| ND0248B in a label group, tagged object heat traced | no overlay | dashed ring outside the bubble |
| ND0248B in a symbol group, tagged object heat traced (inline) | straight dashed line under the bubble | dashed ring outside the bubble |
| ND0248B, tagged object not heat traced | no overlay | unchanged |
| ND0248A, other symbols and other labels | as before | unchanged |

Implementation:

- `src/dexpiParser.js`: new `HEAT_TRACE_RING_LABEL_SYMBOLS` (`ND0248B`) and `isHeatTraceRingLabel()`, which matches a symbol usage on its DiscProfile symbol name.
- `src/App.jsx`: the heat-trace overlay lets these bubbles through the "no overlay on labels" rule and draws them with `HeatTracePIF`.
- `src/imageCompare.js`: the PNG compare expects a ring around an ND0248B bubble when the tagged object is heat traced, and no ring otherwise.

### User Guide

- `public/UserGuide.md`: version 2.2.2; section 5.5 *Heat Trace Overlay* describes the actual overlay shapes and the ND0248B tag-bubble ring.
- `public/UserGuide.html`: version 2.2.2 in the title and heading.

### Files changed

`package.json`, `package-lock.json`, `ChangeLog_2.1_to_2.2.md` (this section), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/dexpiParser.js`, `src/imageCompare.js`.

## 2.2.1

Changes from version 2.2 (commit `a26e737`, 2026-10-22).

### Version

- The app is versioned as **2.2.1** (`package.json` / `package-lock.json` 2.2.1).
- The version shows next to the title in the left panel and in the User Guide.

### Linked text only - the stored Text string is never drawn

The drawings are imported into an intelligent CAD tool that rebuilds every label from the attribute database. The viewer therefore draws only text that tool can rebuild: a **link**, never a cached string.

Every drawn text now comes from one of these sources:

- the **attribute references** of the Text's own `Core/Diagram.TextTemplate` (`Core/Diagram.AttributeRepresentation`), resolved against the referenced object's value; or
- **literals that belong to the symbol**: text in the symbol's own catalogue graphics, `Profile/LabelTemplate` literals, and `Core/Diagram.LiteralText` fragments that match them (any `LiteralText` fragment when no profile is loaded).

The stored `Core/Diagram.Text` → `Data property="Text"` value is **never drawn**, in any state.

| Case | 2.2 | 2.2.1 |
|---|---|---|
| No profile loaded, label Text without attribute reference | stored Text shown | nothing shown |
| No profile loaded, label Text with attribute references | resolved references | unchanged |
| Profile loaded, label Text without attribute reference | nothing shown | unchanged |
| Text outside a `Core/Diagram.Label` group, no attribute reference (e.g. a Text primitive in a `Core/Diagram.Static` group of a model object) | stored Text shown | nothing shown |
| Text outside a label group with attribute references | resolved references | unchanged |
| Text inside a symbol / shape catalogue definition | symbol's own text | unchanged |
| Profile labels checked, catalogued symbol | `Profile/LabelTemplate` overlay | unchanged |

Implementation:

- `src/dexpiParser.js`: a label without an attribute reference gets an empty `componentText` with or without a profile (it used to fall back to the stored text when no profile was loaded). A new final **"No Text.Text"** pass in `collectGraphicalElements()` marks every remaining drawn instance Text as `isComponentLabel` and gives it the filtered resolution of its attribute fragments, or nothing.
- `src/App.jsx`: `renderPrimitive()` draws `componentText` for every instance Text. `primitive.value` (the stored string) is used only for symbol catalogue primitives drawn by `SymbolGraphic`. The old `isProfileGoverned` / `hasProfileAttributeBacking` branches, which could no longer be reached, are removed. The **Profile labels** tooltip now matches the behaviour.

Visible effect: a label whose links are wrong in the file now shows that. Example from UPP-AIL-P-XB-20010-01: 41 of the 43 multi-Text instrument labels give every Text the same template. In 18 of them all three Texts reference `ProcessPlantIdentificationCode` + `PlantSystemIdentificationCode`, so each shows `A20` instead of `A-20` / `PST` / `0002A`. With **Profile labels** checked the profile's LabelTemplates show the intended tag. The fix belongs in the export, which must give each Text its own links.

### User Guide

- `public/UserGuide.md`: version 2.2.1; section 5.10 *Profile Labels* restructured into *Linked text only* and *The Profile labels checkbox*.
- `public/UserGuide.html`: version 2.2.1 in the title and heading.

### Files changed

`package.json`, `package-lock.json`, `ChangeLog_2.1_to_2.2.md` (this section), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/dexpiParser.js`.

## 2.2

Changes from version 2.1 (commit `d43693f` "version 2.1", 2026-10-16).

### Version

- The app is versioned as **2.2** (`package.json` / `package-lock.json` 2.2.0).
- The version shows next to the title in the left panel and in the User Guide.

### Profile labels - rule 'B' for rotation and mirroring

DISC DEXPI rule **'B'** (requirements document, ANNEX B *Profile Label Text under Rotation and Mirroring*) now applies to the placement of **every** profile label template. The 2.1 rule decided per symbol axis whether the symbol extends to both sides of its origin (the label "keeps its side") or lies on one side (the label "follows the symbol"). That distinction is removed:

| Template offset | 2.1 | 2.2 (rule B, all symbols) |
|---|---|---|
| y offset (above / below) | flipped back when the symbol extends to both sides of its origin on y and the text is turned over | always follows the symbol's rotation, never flipped back |
| x offset (left / right) | flipped back only when the symbol extends to both sides of its origin on x and the text is turned over | always flipped when the text is turned over (rotation 90° and 180°), and mirrored with the symbol |

- Text direction is unchanged: left to right at 0°/180°, bottom to top at 90°/270°, never upside down or right to left.
- Alignment is unchanged in principle: Left/Right swap for a mirrored symbol, Top/Bottom swap when the text is turned over, so the text grows away from the symbol.
- The symbol-extent test (`bothSides()` on the symbol variant's MinX/MaxX/MinY/MaxY) is removed from `labelOverlayPlacement()` in `src/App.jsx`.
- Verified against the 32 cases of the ANNEX B tables, for a one-sided (ND0249A) and a two-sided (valve) symbol.
- Visible effect: labels on two-sided symbols at 90° / 180° move, e.g. reducers, and off-page connectors at 180° whose descriptor now sits below the origin. Labels stored in the file are still drawn exactly as written.

### Equipment boxes (DiscProfile 0.6.6, ND0300-ND0310)

- **'A' part drawn without a model object.** A `Core/Diagram.Static` or label group placed directly in the Diagram's `Groups` (no RepresentationGroup around it) is now traversed and drawn. A DiscProfile symbol placed with no `Represents` of its own (the equipment box frame ND03xxA) is kept as an unlinked, non-selectable profile graphic. One whose `Represents` names a missing object is still dropped.
- **'B' part values from the Chambers.** A label of an equipment may read attributes the equipment does not carry from its composed `Chamber`s (`Components property="Chambers"`).
- **Hot / cold side by ChamberFunction.** When a label template is repeated in the same symbol variant (ND0309B: the design pressure and temperature lines once for the hot side, once for the cold side), the 1st occurrence reads the Chamber with `ChamberFunction` `ChamberFunctionClassification.Cooling` (hot side) and the 2nd the one with `Heating` (cold side), via `chamberForSide()` in `src/dexpiParser.js`. Without the expected function the Chambers not claimed by another side are used in file order. A side with no Chamber stays blank instead of repeating another chamber's values.
- **1 decimal.** Numbers and PhysicalQuantity values in the equipment box value columns (`DiscProfile/ND0300B`...`ND0310B`) are shown with exactly 1 decimal, rounded half away from zero on the decimal value (`130` → `130.0`, `56.55` → `56.6`). This applies to the Profile labels overlay and to the box's own label texts (`formatNumber()`, `labelDecimals()`).
- **'&' and '/' shown.** Only a quoted literal makes a template a VB-style formula (`unwrapLabelFormula()`). `<A> & <B> / <C>` has no quotes, so its `&` and `/` are plain text shown between the values: `FV & 130.0 / 90.0`.
- **Profile separators in instance labels.** When an instance label joins two attributes that the profile template puts side by side, the profile's separator is shown (e.g. ` & `) instead of the instance's own literal (`labelTemplateGapsForSymbol()`).

### Units and full vacuum in labels

- Set point and alarm labels (`SetPoint`, `AlarmValue`: `SP = `, `HH=`, `H=`, `L=`, `LL=`) always show the value with its unit (`SP = 6 barg`), whatever the template or instance `AttributeRepresentation` Type asks for (`labelRepType()`).
- A pressure at full vacuum is shown as `FV`: a gauge pressure of -1 atm (-1.01325 barg and the usual rounded -1.0 / -1.013 barg, within 1.5 %, in bar, mbar, kPa, MPa, Pa or psi) or an absolute pressure of 0 (`isFullVacuum()`).

### Label update script - `scripts/Update-DexpiLabels.ps1`

- `Get-LabelPlacement` implements rule 'B' (x offset flipped when the text is turned over, y offset never flipped, symbol-extent test removed). The STEP 3 description in the script header is updated.
- Tested with the 32 ANNEX B cases for both a one-sided and a two-sided symbol: 0 mismatches (2.1: 16 mismatches for the two-sided symbol).
- End-to-end on UPP-AIL-P-XB-24010-01 (DEXPI 2.0, ND0309 update): same counts as with 2.1 (7 groups repaired, 113 new labels); 13 of 341 generated label texts change position or alignment, all on two-sided symbols at 90°/180°.
- `scripts/` is not tracked in git. The updated script and its reference test (`LabelPlacementRuleB.ps1`, `Test-LabelPlacementRuleB.ps1`) are in `DISCDEXPI\Claude outputs\Handoff_LabelPlacement_RuleB\`.

### User Guide

- `public/UserGuide.md`: version 2.2; section 5.10 *Rotation and mirroring* rewritten for rule 'B'; new subsection *Equipment boxes* (A/B parts, Chambers and ChamberFunction, 1 decimal, separators); set point / alarm units and `FV`; section 10.6 refers to rule 'B'.
- `public/UserGuide.html`: version 2.2 in the title and heading.

### Files changed

`package.json`, `package-lock.json`, `ChangeLog_2.1_to_2.2.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/dexpiParser.js`; outside git: `scripts/Update-DexpiLabels.ps1`.
