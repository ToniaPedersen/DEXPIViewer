#!/usr/bin/env python3
"""
genMetaModel.py — Generate src/metaModel.js from the DEXPI 2.0 meta-model XML files.

Usage (from the project root):
    python3 scripts/genMetaModel.py > src/metaModel.js
    python3 scripts/genMetaModel.py /path/to/DEXPI/xml > src/metaModel.js

Input files (from the project's DEXPI/xml folder by default):
    Core.xml    — shared base classes (Diagram, PhysicalQuantities, identifiers, etc.)
    Plant.xml   — P&ID-specific classes (equipment, piping, instruments, etc.)
    Process.xml — PFD/PBD-specific classes (process connections, activities, etc.)

Output:
    A JavaScript ES-module exporting four constants:
        PLANT_HIERARCHY   — inheritance pairs for the Plant model (Core + Plant)
        PLANT_PROPS       — property declarations for the Plant model
        PROCESS_HIERARCHY — inheritance pairs for the Process model (Core + Process)
        PROCESS_PROPS     — property declarations for the Process model

Property entry format:
    DataProperty:                        "name:L:U"
    CompositionProperty / ReferenceProperty: "name:L:U:T"
        name = property name (unqualified local name)
        L    = lower bound integer (0 = optional, 1+ = required, minimum count)
        U    = upper bound string  ("1" = at most one allowed, "" = unbounded)
        T    = target class suffix — the class (or abstract class) suffix named by
               the property's <ClassReference type="..."/> (possibly nested inside
               a <BoundClass> wrapper for generic/parameterised properties). This is
               the type (or supertype) that any object placed in this Components/
               References slot must be an instance of, per the DEXPI meta model.
               Empty string if no ClassReference could be found (should not occur
               for well-formed CompositionProperty/ReferenceProperty declarations).

Each class row is: [classSuffix, dataCsv, compositionCsv, referenceCsv]
    where each csv is a pipe-separated list of entries for that property kind
    (DataProperty | CompositionProperty | ReferenceProperty).

Inheritance is NOT pre-computed here — only direct (declared) properties are
emitted. The runtime buildMetaModelLookup() in validation.js performs a fixpoint
propagation to fold inherited properties (including target types) into each
class's entry.

Why class suffixes?
    The meta-model XML uses fully qualified names like "Plant/ProcessEquipment.Pump"
    or cross-file references like "Core/Identification.PersistentIdentifier".
    We strip everything down to the local suffix (e.g. "Pump", "PersistentIdentifier")
    because that is also how DEXPI instance files write the type attribute:
        type="Plant/ProcessEquipment.Pump" → suffix → "Pump"
    This lets validation.js look up a class by the tail of its type string.
"""

import xml.etree.ElementTree as ET, sys, os

# ── Path configuration ────────────────────────────────────────────────────────
# Folder containing Core.xml, Plant.xml, Process.xml. Defaults to the
# DEXPI/xml folder shipped in this repo (relative to this script's location),
# so the generator works out of the box on any checkout. Override with an
# explicit path as the first CLI argument if needed.
MODELS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "DEXPI", "xml"
)


# ── Name helpers ──────────────────────────────────────────────────────────────

def suffix(name):
    """Extract the local (unqualified) suffix from a DEXPI qualified name.

    DEXPI uses two qualification styles:
      - Package-qualified:  "Plant/ProcessEquipment.Pump"  → "Pump"
      - File-relative:      "/ProcessEquipment.Pump"       → "Pump"
      - Simple:             "Pump"                         → "Pump"

    We split on "/" first (removes file/package prefix) then on "." (removes
    namespace prefix), keeping the rightmost segment in both cases.
    """
    return (name or "").split("/")[-1].split(".")[-1]


def resolve_supertypes(raw_supers_str):
    """Parse the superTypes attribute value into a list of local suffix strings.

    In the meta-model XML, superTypes is a *space-separated* attribute on
    ConcreteClass / AbstractClass elements, e.g.:
        superTypes="/Equipment.Equipment Core/Identification.Named"

    Each token is a qualified name; we reduce each to its local suffix so that
    the output hierarchy pairs reference the same short names used in prop rows.
    Tokens that reduce to an empty string are skipped.
    """
    result = []
    for s in raw_supers_str.split():
        if s:
            result.append(suffix(s))
    return result


def target_suffix(prop_el):
    """Find the target class suffix for a CompositionProperty/ReferenceProperty.

    The target is declared as a <ClassReference type="..."/> child. For simple
    properties this is a direct child; for generic/parameterised properties
    (e.g. Process.xml's QualifiedValue-bound properties) it is nested inside a
    <BoundClass> wrapper. We search all descendants (not just direct children)
    and take the first ClassReference found — every CompositionProperty and
    ReferenceProperty in Core/Plant/Process.xml has exactly one.
    """
    for cr in prop_el.iter("ClassReference"):
        t = cr.get("type", "")
        if t:
            return suffix(t)
    return ""


# ── XML parser ────────────────────────────────────────────────────────────────

def parse_xml(path):
    """Parse one DEXPI meta-model XML file and return its hierarchy and properties.

    Returns:
        pairs — list of (childSuffix, parentSuffix) tuples representing the
                declared inheritance edges for every class in the file.
        props — dict mapping classSuffix → {"d": [...], "c": [...], "r": [...]}
                where each list holds "name:L:U" entries for DataProperty,
                CompositionProperty, and ReferenceProperty children respectively.

    Parsing strategy:
        root.iter() performs a depth-first walk of the entire XML tree, which
        correctly handles classes nested inside <Package> elements (as seen in
        Core.xml where classes live inside DataTypes, Diagram, etc. packages).
        We filter to only ConcreteClass and AbstractClass tags; all other elements
        (Package, AggregatedDataType, EnumerationType, etc.) are skipped.

    Property bounds:
        Each property child carries optional lower="N" and upper="1" attributes.
        - lower defaults to "0" when absent → property is optional.
        - upper="1" means at most one occurrence is allowed (bounded).
        - Absent upper means unbounded (no maximum).
        We encode this as the ":L:U" suffix on the property name.
    """
    root = ET.parse(path).getroot()
    pairs = []
    props = {}

    for cls in root.iter():
        # Only process class-defining elements; skip packages, enumerations, etc.
        if cls.tag not in ("ConcreteClass", "AbstractClass"):
            continue

        raw_name = cls.get("name", "")
        if not raw_name:
            continue  # Unnamed element — skip (should not occur in valid meta-model)
        cls_s = suffix(raw_name)

        # ── Inheritance edges ─────────────────────────────────────────────────
        # superTypes is a space-separated list of qualified parent class names.
        # We emit one (child, parent) pair per declared parent so that the
        # JS runtime can propagate inherited properties via fixpoint iteration.
        for sup_s in resolve_supertypes(cls.get("superTypes", "")):
            if sup_s:
                pairs.append((cls_s, sup_s))

        # ── Property declarations ─────────────────────────────────────────────
        # Iterate only direct children of the class element (not grandchildren).
        # This avoids picking up properties from nested anonymous types if any.
        d_props, c_props, r_props = [], [], []
        for child in cls:
            pname = child.get("name", "")
            if not pname:
                continue  # Unnamed property — skip

            # Decode multiplicity bounds from XML attributes.
            lo = int(child.get("lower", "0"))          # default: optional (0)
            up = "1" if child.get("upper") == "1" else ""  # "" = unbounded

            if child.tag == "DataProperty":
                # Compact encoding: "PropertyName:lowerBound:upperBound"
                # Examples: "TagName:0:1", "Context:1:1", "Impellers:0:"
                d_props.append(f"{pname}:{lo}:{up}")
            elif child.tag in ("CompositionProperty", "ReferenceProperty"):
                # Compact encoding: "PropertyName:lowerBound:upperBound:targetSuffix"
                # Example: "Items:0::PipingNetworkSegmentItem"
                entry = f"{pname}:{lo}:{up}:{target_suffix(child)}"
                if child.tag == "CompositionProperty": c_props.append(entry)
                else:                                  r_props.append(entry)
            # Other child tags (Constraint, Documentation, etc.) are ignored.

        # Only record the class if it has at least one property — classes with
        # no direct properties inherit everything from parents at runtime.
        if d_props or c_props or r_props:
            if cls_s not in props:
                props[cls_s] = {"d": [], "c": [], "r": []}
            props[cls_s]["d"].extend(d_props)
            props[cls_s]["c"].extend(c_props)
            props[cls_s]["r"].extend(r_props)

    return pairs, props


# ── Merge helper ──────────────────────────────────────────────────────────────

def merge(pairs_a, props_a, pairs_b, props_b):
    """Merge two parse results (e.g. Core + Plant, or Core + Process).

    Hierarchy pairs are concatenated and deduplicated (preserving order via
    dict.fromkeys) so that cross-file inheritance edges from both files are
    available in the combined table.

    Properties are merged per class, with the second file (pairs_b / props_b)
    taking precedence over the first when the same property name appears in
    both.  This matters when a domain file (Plant.xml, Process.xml) overrides
    or extends a definition that was first introduced in Core.xml.

    Deduplication within a property list uses the property name as the key,
    so later entries replace earlier ones for the same name.
    """
    # Combine hierarchy pairs, removing exact duplicates while keeping order.
    pairs = list(dict.fromkeys(pairs_a + pairs_b))

    props = {}
    for p in (props_a, props_b):
        for cls, v in p.items():
            if cls not in props:
                props[cls] = {"d": [], "c": [], "r": []}
            for k in "dcr":
                # Build a name→entry map so that later entries override earlier
                # ones for the same property name (props_b wins over props_a).
                seen = {}
                for e in props[cls][k] + v[k]:
                    seen[e.split(":")[0]] = e   # key = property name before first ":"
                props[cls][k] = list(seen.values())
    return pairs, props


# ── Output serialisers ────────────────────────────────────────────────────────

def to_rows(props):
    """Convert the props dict to a sorted list of (cls, dataCsv, compCsv, refCsv) tuples.

    Sorting by class name produces a stable, diff-friendly output so that
    re-running the script on unchanged XML files yields an identical JS file.
    The three CSV strings use "|" as separator because property names and the
    ":L:U" encoding never contain "|".
    """
    rows = []
    for cls in sorted(props.keys()):
        p = props[cls]
        rows.append((cls, "|".join(p["d"]), "|".join(p["c"]), "|".join(p["r"])))
    return rows


def js_pairs(pairs):
    """Serialise hierarchy pairs as a JS array-of-arrays literal.

    Each element is ["childSuffix","parentSuffix"].  One pair per line for
    readability; the outer brackets are on their own lines.
    """
    return "[\n" + ",\n".join(f'  ["{a}","{b}"]' for a, b in pairs) + "\n]"

def js_rows(rows):
    """Serialise property rows as a JS array-of-arrays literal.

    Each element is ["classSuffix","dataCsv","compositionCsv","referenceCsv"].
    Empty csv strings are represented as "" (empty JS string).
    """
    return "[\n" + ",\n".join(f'  ["{c}","{d}","{comp}","{r}"]' for c,d,comp,r in rows) + "\n]"


# ── Main ──────────────────────────────────────────────────────────────────────
# Parse each meta-model XML file independently, then merge:
#   Plant model  = Core base classes  + Plant domain classes
#   Process model = Core base classes + Process domain classes
#
# Core classes (e.g. Named, PersistentIdentifier, ShapeUsage) must be present
# in both merged sets because Plant and Process objects can inherit from them.

core_pairs, core_props = parse_xml(f"{MODELS}/Core.xml")
plant_pairs, plant_props = parse_xml(f"{MODELS}/Plant.xml")
proc_pairs,  proc_props  = parse_xml(f"{MODELS}/Process.xml")

# Build the two combined models.
pl_pairs, pl_props = merge(core_pairs, core_props, plant_pairs, plant_props)
pr_pairs, pr_props = merge(core_pairs, core_props, proc_pairs,  proc_props)

# Convert props dicts to sorted row tuples ready for JS serialisation.
pl_rows = to_rows(pl_props)
pr_rows = to_rows(pr_props)

# Progress summary written to stderr so stdout stays clean for the JS output.
print(f"Plant: {len(pl_pairs)} hierarchy pairs, {len(pl_rows)} class rows", file=sys.stderr)
print(f"Process: {len(pr_pairs)} hierarchy pairs, {len(pr_rows)} class rows", file=sys.stderr)

# Spot-checks — verify a handful of well-known classes are parsed correctly.
# These print to stderr and are not part of the generated JS output.
for cls, d, c, r in pl_rows:
    if cls == "CentrifugalPump":
        # Should have an unbounded CompositionProperty "Impellers" (upper absent → "")
        print(f"CHECK CentrifugalPump: d={d[:80]} c={c} r={r}", file=sys.stderr)
    if cls == "PipingNetworkSystem":
        # Should have multiple DataProperties, all with lower=0
        print(f"CHECK PipingNetworkSystem: d={d[:80]}", file=sys.stderr)
    if cls == "PhysicalQuantity":
        # AggregatedDataType — should NOT appear (not a ConcreteClass/AbstractClass)
        print(f"CHECK PhysicalQuantity: d={d}", file=sys.stderr)
    if cls == "PersistentIdentifier":
        # Core class — both Context and Value have lower=1, upper=1 → required
        print(f"CHECK PersistentIdentifier: d={d}", file=sys.stderr)

# ── Emit JavaScript ───────────────────────────────────────────────────────────
js = f"""// Auto-generated from Core.xml + Plant.xml + Process.xml (DEXPI/xml folder)
// Regenerate: python3 scripts/genMetaModel.py > src/metaModel.js
// Format: hierarchy = [[classSuffix, superSuffix], ...]
//         props     = [[classSuffix, dataCsv, compCsv, refCsv], ...]
// Data property entry:                  "name:L:U"    L=lower (int), U="1" bounded or "" unbounded.
// Composition/Reference property entry: "name:L:U:T"  T=target class suffix (ClassReference type).
// Direct declarations only; inheritance computed at runtime in validation.js.

export const PLANT_HIERARCHY = {js_pairs(pl_pairs)};

export const PLANT_PROPS = {js_rows(pl_rows)};

export const PROCESS_HIERARCHY = {js_pairs(pr_pairs)};

export const PROCESS_PROPS = {js_rows(pr_rows)};
"""

print(js)
