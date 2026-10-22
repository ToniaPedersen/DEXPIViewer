# Note: H / HH / L / LL alarm labels on DiscProfile instrument symbols

*Recorded 2026-10-22*

## Rule

DiscProfile instrument symbols (e.g. **ND0006**, also ND0270 / ND0271) define four alarm
LabelTemplates:

| Label | Template text                                        | Shown only when the PIF has a SignalConveyingFunction with `PortStatus` = |
|-------|------------------------------------------------------|---------------------------------------------------------------------------|
| H     | `'H=' & SignalConveyingFunction:<AlarmValue>`        | `StatusHighPort`                                                          |
| HH    | `'HH=' & SignalConveyingFunction:<AlarmValue>`       | `StatusHighHighPort`                                                      |
| L     | `'L=' & SignalConveyingFunction:<AlarmValue>`        | `StatusLowPort`                                                           |
| LL    | `'LL=' & SignalConveyingFunction:<AlarmValue>`       | `StatusLowLowPort`                                                        |

* No SignalConveyingFunction with the matching `PortStatus` means that label is **not shown**.
  There is no fallback by position, so another alarm's signal never fills the slot.
* A matching one with `DiscProfile/AlarmValue` shows the value **with units**
  (`ValueAndUnits`, e.g. `HH=80 °C`). The value is read only from that specific
  SignalConveyingFunction, never from a sibling.
* A matching one without an AlarmValue still shows the literal prefix (e.g. `L=`).

## Implementation (src/dexpiParser.js)

* `PORT_STATUS_HINTS` / `extractPortStatusHint()` map the template's `H=`/`HH=`/`L=`/`LL=`
  (and `HHH=`/`LLL=`) prefix to the PortStatus literal.
* `pickRoleChild()` returns only the SignalConveyingFunction child whose own `PortStatus` matches,
  or `null`.
* `resolveProfileLabelFallback()` suppresses the whole template when `pickRoleChild()` returns
  `null`. Otherwise it renders `fragmentValueToText(lookupProperty(target, "AlarmValue"), "ValueAndUnits")`.
* The results go to `el.labelOverlays`, which App.jsx draws when "Profile labels" is checked.

## Verified case: UPP-AIL-P-XB-24010-01 (Aibel), PIF `SP57F545C58B2D4D50AFC5C56E7623E256` (A-24TIC0002, ND0006)

Its SignalConveyingFunctions `SP6C11BF84ABAE481480F334F076575311_CL_1` and `_CL_4` have
**no PortStatus**, so no H/HH/L/LL label may appear. Parser output with the current source:

| Test data                                                                     | Overlays                                         |
|-------------------------------------------------------------------------------|--------------------------------------------------|
| As delivered                                                                  | `A-24`, `TIC`, `0002`, `SP = 35` (no H/L)        |
| CL_1 = StatusHighHighPort, AlarmValue 80 °C; CL_4 = StatusLowLowPort, 5 °C    | + `HH=80 °C`, `LL=5 °C`                          |
| CL_1 = StatusHighPort, AlarmValue 60 °C; CL_4 = StatusLowPort, no AlarmValue  | + `H=60 °C`, `L=`                                |

**Caution:** `dist/` (built 2026-07-24) predates this logic. Rebuild (`npm run build`) or use
`npm run dev` and hard-reload before checking in the browser.

## Verified case: UPP-AIL-P-XB-20010-01, PIF `SP419345D08D814DCAAC248AD4AECA5757` (A-20PST0002, ND0006)

This PIF **does** have matching SignalConveyingFunctions:
`SP2D47…_SG3B66…` is `StatusLowLowPort` and `SP732E…_SG900B…` is `StatusHighHighPort`.
Neither carries an AlarmValue. A third one, `SPFD98…_CL_2`, has no PortStatus.

The current parser produces `A-20`, `PST`, `0002`, `HH=`, `LL=` and **no H= / L=**, which is correct.
The drawing's own Texts "HH" and "LL" (like "A-20", "PST", "0002") are component labels. Their
TextTemplate references `SPPID: AlarmH`, which resolves to nothing, so `componentText` is empty.
App.jsx never shows a component label's literal Text, so these are hidden in **both** "Profile labels"
states, as designed. The "75 barg" text near the instrument is a Core/Note (NoteText), which is never
profile-governed and always shows.

## Fix 2026-10-22: literal-only H / L templates (DISCDEXPI_2026Pack profile)

The viewer loads its default profile from
`ToniaPedersen/DISCDEXPI_2026Pack/main/Profile/xml/DiscProfile.xml`, not from the local
`DEXPI/xml/DiscProfile.xml`. In that profile, the H and L LabelTemplates of **ND0006, ND0269,
ND0270 and ND0271** are plain literals (`'H'`, `'L'`) with no AlarmValue placeholder.
`resolveProfileLabelFallback()` returned literal-only templates unconditionally, so H / L were
always drawn. On A-20PST0002 (`SP419345D08D814DCAAC248AD4AECA5757`) this happened even though only
StatusHighHighPort and StatusLowLowPort signals exist.

Fix: `literalPortStatusHint()` and `hasSignalWithPortStatus()` were added. A literal-only template that is just an alarm
level (`H`, `HH`, `L`, `LL`, `HHH`, `LLL`, optionally followed by `=`) is now shown only when the PIF has a
SignalConveyingFunction with the matching PortStatus.

| File / PIF                                         | Pack profile, before                 | Pack profile, after              |
|----------------------------------------------------|--------------------------------------|----------------------------------|
| 20010-01 / SP419345… (HH + LL signals)             | `H`, `HH=`, `L`, `LL=`               | `HH=`, `LL=`                     |
| 24010-01 / SP57F545… (no PortStatus)               | `H`, `L` (+ HH=/LL= suppressed)      | none                             |
| 24010-01 test copy with StatusHighPort / StatusLowPort | –                                | `H`, `L`                         |
