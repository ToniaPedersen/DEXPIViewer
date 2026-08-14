# DEXPI Viewer & Verificator

A browser-based viewer and validation engine for [DEXPI 2.0](https://dexpi.org) intelligent P&ID files, with full support for DISC profile validation.

**Live demo:** [toniapedersen.github.io/DEXPIViewer](https://toniapedersen.github.io/DEXPIViewer/)

---

## About

This tool was developed by **[Tonia Pedersen](https://github.com/toniapedersen)** at **[Draga AS](https://draga.sg)** and contributed freely to the DEXPI ecosystem as open source infrastructure for the industry.

It is intended to serve as a reference implementation for DEXPI 2.0 file parsing, graphical rendering, and validation — providing the community with a working, well-documented baseline that any tool vendor, operator, or EPC can build on.

---

## Features

- **Graphical viewer** — renders DEXPI 2.0 P&ID drawings directly in the browser from the XML, including symbols, piping lines, signal connectors, and labels
- **Heat trace overlay** — highlights heat-traced piping, components, and instruments directly on the P&ID, with colour-coded overlays derived from the DEXPI model and loaded DISC profile
- **Topology tree** — full structured view of the DEXPI object model with search, expand/collapse, and issue indicators
- **Object details** — data properties, references, referenced-by, parent and sub-components for any selected object
- **Connectivity map** — upstream/downstream/group tracing for piping and instrumentation networks
- **Validation engine** — 34 named rules across six rule families (VAL, ERR, VAX, VAE, PRF-E, PRF) covering XML well-formedness, schema compliance, structural integrity, engineering semantics, and DISC profile conformance; additional dynamic per-property profile rules generated from loaded profiles
- **Profile support** — load and validate against DISC profile files; stacked profiles with precedence rules; cross-profile symbol and attribute inheritance (attributes granted via `ClassExtension` or `DataProperty` inheritance in a base profile are honoured by all profiles that build on it)
- **Severity configuration** — per-rule severity overrides; export/import as JSON
- **CSV export** — full validation report as CSV for integration into QA workflows
- **CLI batch validator** — `validate-cli.js` for CI/CD pipelines and batch processing of multiple files

---

## Validation Rules

### VAL — Base Validation (DEXPI XML)

| Rule    | Default | Description |
|---------|---------|-------------|
| VAL-001 | Error   | XML is not well-formed (parse error) |
| VAL-004 | Warning | Model object has no `id` attribute |
| VAL-005 | Error   | Broken reference — `objects="…"` points to an ID not present in the file |

### ERR — XML Schema & Structural Correctness (DEXPI XML)

| Rule     | Default         | Description |
|----------|-----------------|-------------|
| ERR-E01  | Error           | XML cannot be parsed (fatal parse error; stops further ERR checks) |
| ERR-E02  | Error           | Import source URL does not match a known DEXPI 2.0 namespace |
| ERR-E03  | Error           | Unknown XML element tag (not in the DEXPI 2.0 schema) |
| ERR-E04  | Error           | Unknown attribute on an Object element |
| ERR-E05  | Error           | Object missing mandatory `type` attribute |
| ERR-E06  | Error           | Value in typed element (`Double`, `Integer`, `Boolean`, etc.) fails type check |
| ERR-E07  | Error           | Object type not in the DEXPI 2.0 Plant/Process Meta Model registry; or a Data/Components/References property name, required-property, or cardinality rule is violated per the meta model (including inherited properties) |
| ERR-E08  | Error           | Object placed under a `Components` property whose declared target class (per the Plant/Process Meta Model's `CompositionProperty`/`ClassReference`, including profile-declared subclasses) does not match the object's type or a subtype of it |
| ERR-E10  | Error           | Duplicate `id` attribute — two or more objects share the same ID |
| ERR-E11  | Error           | Duplicate `PersistentIdentifier` value across objects |
| ERR-E12  | Error           | `OperatedValveReference.Valve` references a non-valve type |
| ERR-E15  | Error           | `PlantMetaData` element is absent from the file |
| ERR-E16  | Error           | Graphical `Represents` reference points to a non-existent model object |
| ERR-E17  | Error           | Important equipment/valve/connector has no `RepresentationGroup` (orphaned model object) |
| ERR-E18  | Error           | Attribute used on an element whose class does not allow it per the loaded profile's `PropertyConstraint` definitions (or, absent a profile, per the base DEXPI 2.0 meta model); cross-profile class-model inheritance (`ClassExtension`, `DataProperty`) is honoured before raising |
| ERR-E19  | Error           | Attribute appears more times than the upper cardinality allows per the loaded profile (or the base DEXPI 2.0 meta model) |
| ERR-E20  | Error           | A `Core/Diagram.TextTemplate`'s `AttributeName` doesn't resolve to a value reachable from the owning object, per the DEXPI 2.0 meta model |

### VAX — Structural / Topology Validation (DEXPI XML)

| Rule    | Default | Description |
|---------|---------|-------------|
| VAX-001 | Warning | `ActuatingSystem` contains no `ControlledActuator` |
| VAX-003 | Warning | `PipingNetworkSystem` contains no `PipingNetworkSegment`; or `InstrumentationLoopFunction` contains no `ProcessInstrumentationFunction` |
| VAX-004 | Warning | `PipingNode` is not referenced by any connection (orphaned node) |
| VAX-005 | Info    | `PipingNetworkSegment` has no connections defined |

### VAE — Engineering / Semantic Validation (DEXPI XML)

| Rule    | Default | Description |
|---------|---------|-------------|
| VAE-001 | Warning | `OperatedValveReference` has no `Valve` reference; or major process equipment (Pump, Compressor, Vessel…) has no Nozzles |
| VAE-002 | Warning | `PipingNetworkSegment` contains no `PipingComponent` or subtype (Pipe, Valve, Fitting…) |
| VAE-003 | Warning | `ProcessInstrumentationFunction` has no tag, loop number, or function number, and is not a member of any `InstrumentationLoopFunction` |
| VAE-004 | Warning | Nozzle is not a child of a `ProcessEquipment` object via the `Nozzles` property |
| VAE-005 | Warning | `ConnectorLine` Source and Target are at the same position (zero-length connector) |
| VAE-006 | Warning | `ProcessInstrumentationFunction` is not the Source or Target of any `SignalConveyingFunction` or subtype |

### PRF-E — Profile File Validation (DiscProfile.xml itself)

| Rule    | Default | Description |
|---------|---------|-------------|
| PRF-E01 | Error   | Profile XML is not well-formed, or `PropertyConstraint` has an invalid `Lower`/`Upper` value |
| PRF-E02 | Error   | `ConstrainedType` in a `PropertyConstraint` is not from a known DEXPI 2.0 namespace (`Core/`, `Plant/`, `Profile/`, `DiscProfile/`) |

### PRF — Cross-check: DEXPI XML × DiscProfile.xml

| Rule | Default | Description |
|------|---------|-------------|
| PRF-E04 | Error   | A `SymbolUsage` in the drawing references a Symbol name not declared in the profile (or any profile in the loaded stack); or the symbol's allowed types do not match the model object's DEXPI type |
| PRF-E05 | Error   | A `PipingNodePosition` in the drawing does not align with any profile-defined connection point of the placed symbol (within 0.5 % of drawing size) |
| PRF-007 | Info    | A profile constraint was silently overridden by a later-loaded profile (logged when multiple profiles are stacked) |
| PRF-{profile}-{property} | Warning | A model object is missing a property that is required (`Lower ≥ 1`) by the loaded profile's `PropertyConstraint`; property name matching handles bare, slash-prefixed, and fully-qualified forms |

---

## Getting Started

```bash
npm install
npm run dev          # development server
npm run build        # production build
npm run validate -- <file.xml> [--profile profile.xml] [--out reports/] [--summary]
```

### CLI examples

```bash
# Validate a single file
node validate-cli.js plant.xml

# Validate with a DISC profile
node validate-cli.js plant.xml --profile DiscProfile.xml

# Batch validate a folder and write CSV reports
node validate-cli.js "DEXPI Example Files" --out reports --summary
```

---

## Architecture

The codebase is structured as three independent layers:

- **`src/dexpiParser.js`** — pure parser: reads DEXPI 2.0 XML into a flat object tree, graphical element list, connectivity map, and node position map. No UI dependencies.
- **`src/dexpiTypes.js`** — comprehensive registry of all DEXPI 2.0 Plant Meta Model types.
- **`src/plantHierarchy.js`** — auto-generated compact class hierarchy table (name → supertype) extracted from Plant.xml, used by the ERR-E18 attribute validator without bundling the full Plant.xml at runtime.
- **`src/validation.js`** — rule engine: all validation families, profile constraint parsing, CSV export. Runs identically in browser and Node.js.
- **`src/App.jsx`** — React UI built on top of the above modules.
- **`validate-cli.js`** — Node.js CLI wrapper for batch validation, reusing the same parser and engine as the browser.

The parser and validation engine have no browser dependencies and can be used as a standalone Node.js library.

---

## DEXPI Example Files

The `DEXPI Example Files/` folder contains the DISC DEXPI example files (blueprint + profile) for testing and demonstration.

The `ValidationErrTestFiles/` folder contains files that deliberately trigger specific validation rules, used for testing rule coverage.

Equinor also freely provides DEXPI 2.0 files for both P&ID and SCD (System Control Diagrams) through the Databricks `equinor_asa_p_id_and_scd_of_huldra` volume — see [Data sharing - Equinor](https://www.equinor.com/energy/data-sharing).

---

## Contributing

Contributions are welcome. Please open an issue before submitting a pull request for significant changes.

By contributing you agree that your contributions are licensed under the same MIT terms as the rest of the project.

---

## About DEXPI

[DEXPI](https://dexpi.org) (Data EXchange in the Process Industry) is the open industry standard for intelligent P&ID exchange, enabling interoperability between engineering tools across the process industry.


## Important Note

Validation results are provided to assist review and should be independently verified. This tool is being used by me in a current DEXPI project and is under active development. Rules are being updated regularly during the project — results may change between updates.