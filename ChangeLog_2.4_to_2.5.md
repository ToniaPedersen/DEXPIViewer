# Changelog

## 2.5.0

Changes from version 2.4.0 (commit `b876e77` "Version 2.4"), including commit `895fee1` "small update to label display".

### Version

- The app is versioned as **2.5.0** (`package.json` / `package-lock.json` 2.5.0, User Guide). The version shows next to the title in the left panel (v2.5).
- `README.md` links only this changelog. The earlier changelogs stay in the repository.

### Mixed labels keep the file's label as it is

With **Mixed labels**, a label of a profile symbol that is a valid representation (it references, with a value, at least one LabelTemplate attribute of the object's profile symbols) is now shown exactly as with both checkboxes unticked. It is no longer rebuilt from the profile LabelTemplate's values and in-between literals, so a difference from the profile label stays visible:

| UPP-AIL-P-XB-20010-01 | File label | 2.4 Mixed | 2.5 Mixed |
|---|---|---|---|
| PipeReducer `SP07CCC5CECE4F4E6C93CB80DE30900FA0` (ND0077 `<NominalDiameterRepresentationIn>x<NominalDiameterRepresentationOut>`) | In + Out, no literal | `1200x1000` | `12001000` |
| ProcessInstrumentationFunction `SP9EAF186D388D4658B2EE36852DD0F73E` (label template A) | ProcessPlantIdentificationCode + PlantSystemIdentificationCode | `A-20` | `A20` |

On that drawing, 61 of the 282 Mixed-labels texts had been changed this way; now none are. The other Mixed labels rules are unchanged. A profile symbol's label that references none of its label attributes with a value is not drawn. Each profile label is drawn as the default when none of its placeholder attributes is used by a file label of the object (90 placements on UPP-AIL-P-XB-20010-01).

- `src/dexpiParser.js`: the Mixed labels pass sets `primitive.mixedText` to `componentText`; the LabelTemplate literal-joining code (`templateParts`, `templatesById`) is removed.
- `public/UserGuide.md`: *The Profile labels checkbox*; the sentence on joining Units to Value under Mixed labels is removed.

### Literal-only labels show their LiteralText fragments (commit `895fee1`)

A purely literal label (e.g. a NoteText continuation line, or a label when the profile defines no LabelTemplates) now shows its TextTemplate's LiteralText fragments, never the stored `<Data property="Text">` string. A literal label without a TextTemplate shows nothing. `src/dexpiParser.js`: `literalFragmentsText()`.

### ERR-E08: objects under a Components property the parent does not have

ERR-E08 used to check only children of a Components property that the parent class defines. It now also reports every child Object placed under a Components property that the parent class does not define at all, directly or by inheritance, in the Plant/Process meta model or any loaded profile. ERR-E07 still reports the undefined property on the parent. The message lists where the child's type is allowed, and the suggested correction says where to move it.

Example from UPP-AIL-P-XB-20010-01: thermowell A-20TW0003, `Plant/Piping.Sensorwell` `SP6F8AFB9170634EA5A067DE5D085009BE`, is nested in `MeasuringLineFunction` `SG8A7038C6DC2340F9A4067EEF56F90EF2` as `Components[@property='Items']`. `SignalConveyingFunction` and its subtypes have no Components properties, and a Sensorwell belongs in `PipingNetworkSegment.Items`; the ProcessSignalGeneratingFunction already points to it through `SensingLocation`. The file gets 17 new ERR-E08 errors (Sensorwells and a Flange in MeasuringLineFunction `Items`, PropertyBreaks in `PipingNetworkSystem.Items`, PipingNodes in `FlowOutSignalOffPageConnector.Nodes`); no other findings changed.

- `src/validation.js`: ERR-E08 block in `runXmlSchemaValidation()`; new `allowedCompositionHosts()`; ERR-E08 short description is now "Object under the wrong or an undefined Components property".
- `public/UserGuide.md`: ERR-E08 row.

### DXF export

A **DXF** button saves the whole drawing (not just the current view) as an AutoCAD R12 ASCII DXF with vector geometry: LINE / POLYLINE, CIRCLE and ARC, and TEXT with height, rotation and alignment. Elements go on the layers SYMBOLS, LINES, LABELS and HEAT_TRACE; stroke colours map to the nearest AutoCAD colour index, and each dash pattern gets its own LTYPE. Y is flipped and `$INSUNITS` is millimetres. The BG image, image-compare markers and selection/connectivity highlights are left out; elements hidden by **Hide elements with issues** stay hidden.

- `src/dxfExport.js` (new): `svgToDxf()`.
- `src/App.jsx`: `exportAsDxf()`, `cleanExport` state, `data-dxf-root` / `data-dxf-layer` attributes (`dxfLayerFor()`).

### Toolbar

- **PNG**, **PDF** and **DXF** (was **Save PNG** / **Save PDF**) are one button group at the right-hand end of the centre toolbar, with a download icon.
- **Fit** and **BG PNG** (was **BG Image**) sit next to them with icons; **BG PNG** is blue while an image is loaded. **BG Controls** is now a sliders icon button.

### Validation tab: badges and Hide elements with issues

- The badge row under **Run Validation** has an **All** badge; the badges are the severity filter of the Validation tab, and the active one is outlined. The All / Error / Warning / Info buttons at the top of the Validation tab are removed.
- Each code group header in the Validation tab shows the code's short description.
- **Hide elements with issues** moved from the centre toolbar to the Validation tab. The All / All Errors / None / Custom mode list is removed: **Codes… (n/m)** opens the code list with **All** (every code found) and **None** (clear) buttons, and each code shows its severity colour and short description.
- `src/App.jsx`: `HIDE_ISSUES_DEFAULT` without `mode`; `setAllHideCodes()`; `describeCode` imported from `src/validation.js`.

### User Guide

`public/UserGuide.md`: version line; 2.4 *Running Validation* (badges); 4.2 *Validation Tab* (code groups, Hide elements with issues); 5.7 *Background Image* (BG PNG, sliders button); 5.8 *Exporting the Drawing* (PNG / PDF / DXF); *The Profile labels checkbox* (Mixed labels); ERR-E08 row. `public/UserGuide.html`: title version.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.4_to_2.5.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/dexpiParser.js`, `src/dxfExport.js` (new), `src/validation.js`.
