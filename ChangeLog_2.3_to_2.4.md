# Changelog

## 2.4.0

Changes from version 2.3.0 (commit `ff445ac` "Version 2.3", 2026-10-29).

### Version

- The app is versioned as **2.4.0** (`package.json` / `package-lock.json` 2.4.0, User Guide). The version shows next to the title in the left panel (v2.4).
- `README.md` links only this changelog. The earlier changelogs stay in the repository.

### Attribute references show the Type the file asks for

A label Text's `Core/Diagram.AttributeRepresentation` now shows exactly its `Type`: `Value` the value only, `Units` the unit only, `ValueAndUnits` both. Set point and alarm values (`SetPoint`, `AlarmValue`) used to get their unit added even for `Value`, so a file label built as Value + ` ` + Units showed the unit twice:

| UPP-AIL-P-XB-20021-01 (S22 LL alarm and three others) | Before | Now |
|---|---|---|
| `=` + AlarmValue (Value) + ` ` + AlarmValue (Units) | `23 barg barg` | `23 barg` |
| AlarmValue (Value) + AlarmValue (Units) | `120 °C°C` | `120°C` |

The profile's own LabelTemplate labels are unchanged: `SP = `, `H=` … still show the value with its unit. `src/dexpiParser.js`: `resolveTemplateFragments()`, `resolveFilteredTemplateFragments()` and the Mixed labels pass use the fragment's own `repType`; `labelRepType()` is used only for LabelTemplate placeholders.

### Mixed labels checkbox

A **Mixed labels** checkbox next to **Profile labels** (the two are mutually exclusive), like AKSODEXPIViewer 2.9's. A label of a catalogued profile symbol shows only the values of its AttributeRepresentation references that are LabelTemplate attributes of the object's profile symbols, joined by the literal that stands between those placeholders in the profile LabelTemplate; the file's LiteralText fragments and stored Text are not shown, nor are literals before the first or after the last value. Each profile label (one per LabelTemplate, the **Profile labels** overlay) is drawn as the default when none of its placeholder attributes is referenced, with a value, by a label of the object - e.g. UPP-AIL-P-XB-20021-01's off-page connector `SP_UPP_AIL_P_XB_20021_01_S118`, whose file labels reference `ReferencedDrawingDescriptor` but give the drawing number only as a literal, shows the profile's `<ReferencedDrawingNumber>` label. Notes, leader lines and labels without a profile symbol are drawn as with both unchecked.

- An attribute of an object is shown once per label; a Units reference after a Value reference to it is joined with a space (UPP-AIL-P-XB-20021-01's AlarmValue as Value, then as Units: `120 °C`, `23 barg`).
- `src/dexpiParser.js`: new pass after the label overlays: `primitive.mixedText` on catalogued-symbol label Texts, `attrs` and `mixedShow` on each `labelOverlays` entry, `mixedUsesDefaultLabel` on symbol placements.
- `src/App.jsx`: `showMixedLabels` state and checkbox; `renderPrimitive()` shows `mixedText`, `SymbolGraphic` draws the `labelOverlays` entries with `mixedShow`.
- `public/UserGuide.md`: *The Profile labels checkbox*.

Checked on DISC_EXAMPLE-14-13: all 21 catalogued-symbol labels show a mixed value (the same text as unchecked); 67 of the 88 placements with profile labels show their default label.

### Panning, zooming and fit as in xBridge

- **Pan:** drag with the left or middle mouse button, as in xBridge (`MIMS_Bridge_DEXPI` `ModelCanvas.vue`). Holding **Space** is no longer needed or used. A press that moves 2 px or less is a click and selects as before; the click that ends a pan does not select.
- **Fit:** double-clicking the drawing fits it to the window, like the **Fit** button.
- **Zoom:** the mouse-wheel zoom now stays anchored under the cursor. It used the view from when the drawing was loaded, so it drifted.
- The toolbar hint "Scroll to zoom · Space+drag to pan" is removed.

`src/App.jsx`: `panDragRef` / `suppressClickRef` with pointer events on the drawing viewport replace `spaceDown`, `panStart` and the Space key listeners; new `fitDrawingToWindow()` for the Fit button and double-click. `public/UserGuide.md`: section 5.1.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.3_to_2.4.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/dexpiParser.js`.
