# Changelog

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
