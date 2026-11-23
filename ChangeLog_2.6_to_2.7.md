# Changelog

## 2.7.0

Changes from version 2.6.0 (commit `5cdc112` "Version 2.6").

### Version

- The app is versioned as **2.7.0** (`package.json` / `package-lock.json` 2.7.0, User Guide). The version shows next to the title in the left panel (v2.7).
- `README.md` links only this changelog. The earlier changelogs stay in the repository.

### Validation: new and extended verification codes

These codes came from comparing DEXPIViewer's report with an external verificator report (xlsx) for `UPP-AIL-P-XB-20022-01.enhanced.xml.Dexpi_2.0.xml`. The counts below are for the 2.01 version of that file, validated with `DiscProfile.xml`.

| Code | 2.6 | 2.7 | Change |
|------|----:|----:|--------|
| PRF-E08 | – | 2,383 | New |
| ERR-E12 | 0 | 10 | Extended to a general check |
| VAL-005 | 32 | 45 | Extended to every `<References>` element |

Reports on files that use standard properties the DISC profile does not allow will have many more errors than in 2.6, mostly from PRF-E08. Its severity can be changed in the severity settings if needed.

#### PRF-E08 — Class or property not allowed by the profile (new, Error)

A profile can restrict the DEXPI classes and properties a file may use with a `Profile/UsageConstraint` object (`AllowedClasses` and `AllowedProperties` string lists). `DiscProfile.xml` has one, with 294 classes and 332 properties. 2.6 did not read it.

- **Classes:** an object whose type comes from a standard model (Core, Plant, Process, Profile) must be in `AllowedClasses`. Classes a profile defines itself (`DiscProfile/…`) are not checked.
- **Properties:** every un-prefixed Data, Components or References property is resolved to the class that declares it, breadth-first up the meta-model hierarchy (profile classes included). `DeclaringClass.Property` must be in `AllowedProperties`. An inherited property is listed once under its declaring class, e.g. `FluidCode` on a GlobeValve is `Plant.Piping.PipingComponent.FluidCode`.
- Prefixed profile properties are left to ERR-E18, and properties no class declares to ERR-E07.
- If several loaded profiles have a UsageConstraint, their lists are merged: a class or property is allowed when any of them allows it.
- Example message: `DataProperty Plant.Piping.PipingNode.NominalDiameterTypeRepresentation on 'Plant/Piping.PipingNode' is not allowed by profile 'DiscProfile': it is not in the UsageConstraint AllowedProperties.`

This is the check behind the external verificator's "DataProperty … is not officially allowed for DISC" warnings (2,357 in the 2.0 file).

`src/validation.js`: `runProfileUsageConstraintValidation()` (new, exported), called from `runFullValidation()` after the ERR-E18 class-model check.

#### ERR-E12 — Reference target has the wrong class (extended)

ERR-E12 used to check only `OperatedValveReference.Valve`, by looking for "valve" in the target type name. It now checks every `<References property="P" objects="#id …">` against the ReferenceProperty `P` that the owner's class declares or inherits in the DEXPI 2.0 meta model (Plant or Process). Every target must be of the property's `ClassReference` type or a subclass, profile subclasses included. Examples:

| Property | Required target |
|----------|-----------------|
| `OperatedValveReference.Valve` | OperatedValve |
| `ProcessSignalGeneratingFunction.SensingLocation` | SensingLocation |
| `PipingNetworkSegment.SourceItem` / `TargetItem` | PipingSourceItem / PipingTargetItem |
| `SignalConveyingFunction.Source` / `Target` | SignalConveyingFunctionSource / …Target |
| `ConnectorLine.Source` / `Target` | NodePosition |
| `RepresentationGroup.Represents` | ConceptualObject |

Not checked: profile-prefixed reference properties, properties the class does not have (ERR-E07), missing targets (VAL-005), and targets of a class unknown to the meta model and loaded profiles (ERR-E07).

On the 2.01 file it finds `SensingLocation` pointing to a ProcessInstrumentationFunction (6) or a FlowOut signal off-page connector (1), `SignalConveyingFunction.Target` pointing to a CoriolisMassFlowMeter (2), and `SourceItem` pointing to a FlowOut pipe off-page connector (on a Pipe and its segment, reported as 1 + 1). The external verificator reports the first three as Type Errors.

The code description is now "Reference target has the wrong class". `src/validation.js`: `runXmlSchemaValidation()`.

#### VAL-005 — Broken reference to a missing ID (extended)

VAL-005 only checked objects in the parsed tree, which carries objects with an id. Broken references on graphics without an id were never reported. It now also scans every `<References>` element in the document and reports each `#id` whose target is not in the file, without repeating the issues already found. Non-`#` tokens such as `DiscProfile/ND0004` are left to PRF-E04.

On the 2.01 file this adds 13 issues: 12 `Core/Diagram.ConnectorLine` `Source` / `Target` references to missing `_PNP` / `_INP` node positions, and 1 broken `RepresentationGroup.Represents`. Each has its line number. For an owner without an id, the issue points to the nearest enclosing object with an id, or else to the object the enclosing RepresentationGroup represents, so it can be selected in the viewer.

`src/validation.js`: `runBaseValidation()`.

#### ERR-E18 — Profile property on a class the profile does not declare it for (extended)

ERR-E18 is now also raised for a `Prefix/Name` Data, Components or References property that the loaded profile does not declare, as the right kind of property, on the object's class or any supertype. Examples: `DiscProfile/Sequence` on a ProcessInstrumentationFunction, or a profile class name used as a property (`DiscProfile/AreaBreak`). Pairs already reported by the PropertyConstraint-driven ERR-E18 are not repeated. The code description is now "Property not allowed on this class (profile)".

`src/validation.js`: `runProfilePropertyClassValidation()` (new, exported), called from `runFullValidation()`.

#### Shared helpers

`src/validation.js`: `scanObjectLines()` gives line numbers for every `<Object>` and its properties, including objects without an id. `nearestObjectId()` and `childElementsByTag()` (works with xmldom, which has no `.children`) are used by the new checks. The checks give the same results in the browser and in `validate-cli.js`.

### Drawing: selection highlight

- The selection highlight is now drawn on top of the primitive instead of under it, at least 2 px wide and fully opaque. Before, a thin black original line, such as a label's leader PolyLine, covered the highlight completely.
- In the graphical model, selecting anything inside a `Core/Diagram.Label` (e.g. a PropertyBreak's label SymbolUsage or its leader PolyLine) highlights the whole Label, so the symbol and its leader line light up together.

`src/App.jsx`: `highlightPrimitive()`, `PrimitiveGraphic`, `graphHighlightNodeIds`.

### Left panel: fixed header rows and icon buttons

- In the Topology, Validation and Folder tabs only the list scrolls. The search box, buttons and headers stay in place.
- The Topology tab's **Conceptual model** / **Graphical model** and **Expand all** / **Collapse all** buttons are now one row of icon buttons. Each has a tooltip with its name.

`src/App.jsx`: `S.pane`, `S.paneList`, Topology / Validation / Folder tabs.

### Signal lines: instrument tubing

`InstrumentTubingConveying` signal lines are drawn as a plain continuous line with no glyph. `src/dexpiParser.js`: `SIGNAL_CONVEYING_SOLID_TYPES`.

### User Guide and README

- `public/UserGuide.md`: version line; 2.x load modes (PRF-E01–E08); 4.1 *Topology Tab* (icon buttons, fixed header rows); verification code tables (VAL-005, ERR-E12, ERR-E18, PRF-E08).
- `public/UserGuide.html`: title version.
- `README.md`: version line; rule tables (VAL-005, ERR-E12, ERR-E18, PRF-E08).

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.6_to_2.7.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/dexpiParser.js`, `src/validation.js`.
