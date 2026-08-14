// DEXPI Verificator – Validation Engine
// Implements: VAL-001..005, VAX-001, VAX-003..005, VAE-001..006, PRF-001..007, ERR-E01..E20, RPT-001..004
// (VAX-002 removed: duplicated ERR-E12's OperatedValveReference.Valve target-type check.)

import { DEXPI_ALL_TYPES, DEXPI_STD_PREFIXES as _DEXPI_STD_PREFIXES } from "./dexpiTypes.js";
// Auto-generated meta-model data for Plant (P&ID) and Process (PFD/PBD).
// Regenerate: python3 scripts/genMetaModel.py
import { PLANT_HIERARCHY, PLANT_PROPS, PROCESS_HIERARCHY, PROCESS_PROPS } from "./metaModel.js";

// ─── Connection-point margin (fraction of drawing bounding-box per axis) ──────
// The NodePosition in the drawing must be within this fraction of the drawing
// size from the profile-defined connection point of the placed symbol.
// 0.005 = 0.5 % – tight enough to catch mis-wired nozzles (typically > 1 unit off
// in a ~200-800 unit drawing) while ignoring sub-pixel rounding errors.
export const CONNECTION_MARGIN_X_PCT = 0.005;
export const CONNECTION_MARGIN_Y_PCT = 0.005;

// ─── Severity helpers ────────────────────────────────────────────────────────

export const DEFAULT_SEVERITIES = {
    "VAL-001": { level: "Error",   score: 3 },
    "VAL-004": { level: "Info",    score: 1 },
    "VAL-005": { level: "Error",   score: 3 },
    "VAX-001": { level: "Warning", score: 2 },
    "VAX-003": { level: "Warning", score: 2 },
    "VAX-004": { level: "Warning", score: 2 },
    "VAX-005": { level: "Info",    score: 1 },
    "VAE-001": { level: "Warning", score: 2 },
    "VAE-002": { level: "Warning", score: 2 },
    "VAE-003": { level: "Warning", score: 2 },
    "VAE-004": { level: "Warning", score: 2 },
    "VAE-005": { level: "Warning", score: 2 },
    "VAE-006": { level: "Warning", score: 2 },
    "PRF":     { level: "Warning", score: 2 },
    // ERR-E** — DEXPI_XML_Schema.xsd / container-structure checks (E01-E06, E10,
    // E11, E15-E17) and Plant/Process meta-model checks (E07, E08, E12, E18-E20)
    // are all treated as hard errors: a file that violates the XML schema or the
    // Plant/Process model is not a valid DEXPI 2.0 file, regardless of which of
    // the two categories the specific rule falls into.
    "ERR-E01": { level: "Error",   score: 3 },
    "ERR-E02": { level: "Error",   score: 3 },
    "ERR-E03": { level: "Error",   score: 3 },
    "ERR-E04": { level: "Error",   score: 3 },
    "ERR-E05": { level: "Error",   score: 3 },
    "ERR-E06": { level: "Error",   score: 3 },
    "ERR-E07": { level: "Error",   score: 3 },
    "ERR-E08": { level: "Error",   score: 3 },
    "ERR-E10": { level: "Error",   score: 3 },
    "ERR-E11": { level: "Error",   score: 3 },
    "ERR-E12": { level: "Error",   score: 3 },
    "ERR-E15": { level: "Error",   score: 3 },
    "ERR-E16": { level: "Error",   score: 3 },
    "ERR-E17": { level: "Error",   score: 3 },
    "ERR-E18": { level: "Error",   score: 3 },
    "ERR-E19": { level: "Error",   score: 3 },
    "ERR-E20": { level: "Error",   score: 3 },
    "ERR":     { level: "Error",   score: 3 },
    "PRF-E01": { level: "Error",   score: 3 },
    "PRF-E02": { level: "Error",   score: 3 },
    "PRF-E04": { level: "Error",   score: 3 },
    "PRF-E05": { level: "Warning", score: 2 },
    "PRF-E06": { level: "Error",   score: 3 },
};

export function resolveSeverity(ruleId, severityConfig) {
    if (severityConfig && severityConfig[ruleId]) return severityConfig[ruleId];
    // Check specific rule first, then prefix fallback
    if (DEFAULT_SEVERITIES[ruleId]) return DEFAULT_SEVERITIES[ruleId];
    if (ruleId.startsWith("PRF-")) {
        return severityConfig?.["PRF"] || DEFAULT_SEVERITIES["PRF"];
    }
    const prefix = ruleId.split("-").slice(0, 2).join("-");
    const firstPart = ruleId.split("-")[0];
    return DEFAULT_SEVERITIES[prefix] || DEFAULT_SEVERITIES[firstPart] || { level: "Info", score: 1 };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function directChildren(node, tag) {
    if (!node?.children) return [];
    return Array.from(node.children).filter(c => c.tagName === tag);
}

function getDataText(obj, property) {
    const data = directChildren(obj, "Data").find(d => d.getAttribute("property") === property);
    if (!data) return null;
    const child = data.firstElementChild;
    return child ? child.textContent.trim() : null;
}

// ─── Meta-Model Validator ───────────────────────────────────────────────────────────────────
//
// Builds runtime lookup from the compact metaModel.js tables.
// classPropMap: classSuffix → {
//   d:  Set<propName>,            // allowed Data property names
//   c:  Set<propName>,            // allowed Components property names
//   r:  Set<propName>,            // allowed References property names
//   dm: Map<propName,{lo,up}>,    // multiplicity for Data props
//   cm: Map<propName,{lo,up}>,    // multiplicity for Components props
//   rm: Map<propName,{lo,up}>,    // multiplicity for References props
//   ct: Map<propName,targetSuffix>, // required child/target class for Components props
//   rt: Map<propName,targetSuffix>, // required target class for References props
// }
// lo = lower bound (int), up = upper bound (int) or null (unbounded).
// targetSuffix = the class (or abstract class) suffix an object placed in that
// Components/References slot must be an instance-or-subtype of, per the
// meta-model's <ClassReference type="..."/> declaration for that property.
// Inheritance is computed once via fixpoint and cached.

function buildMetaModelLookup(hierarchyPairs, propRows) {
    // Parse "name:L:U" (Data) or "name:L:U:T" (Components/References) entries
    // from a pipe-separated CSV string.
    // Returns { set: Set<name>, mul: Map<name,{lo,up}>, target: Map<name,targetSuffix> }
    function parsePropCsv(csv) {
        const set = new Set();
        const mul = new Map();
        const target = new Map();
        if (!csv) return { set, mul, target };
        for (const entry of csv.split("|")) {
            if (!entry) continue;
            const parts = entry.split(":");
            const name = parts[0];
            if (!name) continue;
            const lo = parts.length > 1 && parts[1] !== "" ? parseInt(parts[1], 10) : 0;
            const up = parts.length > 2 ? (parts[2] === "" ? null : parseInt(parts[2], 10)) : null;
            const t  = parts.length > 3 ? parts[3] : "";
            set.add(name);
            mul.set(name, { lo, up });
            if (t) target.set(name, t);
        }
        return { set, mul, target };
    }

    const hier = new Map();
    for (const [cls, sup] of hierarchyPairs) {
        if (!hier.has(cls)) hier.set(cls, new Set());
        hier.get(cls).add(sup);
    }

    const direct = new Map();
    for (const [cls, dcsv, ccsv, rcsv] of propRows) {
        const dp = parsePropCsv(dcsv);
        const cp = parsePropCsv(ccsv);
        const rp = parsePropCsv(rcsv);
        direct.set(cls, {
            d: dp.set, dm: dp.mul,
            c: cp.set, cm: cp.mul, ct: cp.target,
            r: rp.set, rm: rp.mul, rt: rp.target,
        });
    }

    // Fixpoint: propagate parent props (names + multiplicity + target type) to
    // subclasses. Child's own declaration takes precedence over inherited one.
    let changed = true;
    while (changed) {
        changed = false;
        for (const [cls, supers] of hier) {
            if (!direct.has(cls)) {
                direct.set(cls, {
                    d: new Set(), dm: new Map(),
                    c: new Set(), cm: new Map(), ct: new Map(),
                    r: new Set(), rm: new Map(), rt: new Map(),
                });
            }
            const entry = direct.get(cls);
            for (const sup of supers) {
                const supEntry = direct.get(sup);
                if (!supEntry) continue;
                for (const [k, mk, tk] of [["d","dm",null], ["c","cm","ct"], ["r","rm","rt"]]) {
                    for (const [prop, mul] of supEntry[mk]) {
                        if (!entry[k].has(prop)) {
                            entry[k].add(prop);
                            entry[mk].set(prop, mul);
                            if (tk && supEntry[tk].has(prop)) entry[tk].set(prop, supEntry[tk].get(prop));
                            changed = true;
                        }
                    }
                }
            }
        }
    }
    return { classPropMap: direct, hierarchy: hier };
}

// Detect document meta-model from Import elements.
// Returns "Plant" (P&ID), "Process" (PFD/PBD), or "Unknown".
function detectMetaModel(doc) {
    for (const imp of doc.querySelectorAll("Import")) {
        const src = imp.getAttribute("source") || "";
        if (src.includes("Plant.xml"))   return "Plant";
        if (src.includes("Process.xml")) return "Process";
    }
    if (doc.querySelector('Object[type^="Plant/"]'))   return "Plant";
    if (doc.querySelector('Object[type^="Process/"]')) return "Process";
    return "Unknown";
}

// Module-level cache — built once per session
let _plantLookup = null, _processLookup = null;
function getMetaModelLookup(modelName) {
    if (modelName === "Plant") {
        if (!_plantLookup)   _plantLookup   = buildMetaModelLookup(PLANT_HIERARCHY,   PLANT_PROPS);
        return _plantLookup;
    }
    if (modelName === "Process") {
        if (!_processLookup) _processLookup = buildMetaModelLookup(PROCESS_HIERARCHY, PROCESS_PROPS);
        return _processLookup;
    }
    return null;
}

// ─── Base Validation (VAL) ────────────────────────────────────────────────────

export function runBaseValidation(mainXml, flatTree, severityConfig, externalValidIds = new Set()) {
    const issues = [];

    // VAL-001: XML well-formedness
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(mainXml, "application/xml");
        const parseErr = doc.querySelector("parsererror");
        if (parseErr) {
            const sev = resolveSeverity("VAL-001", severityConfig);
            issues.push({
                objectId: "(document)", objectType: "(document)", ruleId: "VAL-001",
                severity: sev.level, score: sev.score,
                description: "XML is not well-formed: " + (parseErr.textContent || "parse error").slice(0, 200),
                location: "/", profileSource: "Base",
                suggestedCorrection: "Correct the XML syntax error before re-submitting."
            });
        }
    } catch (_) { /* ignore */ }

    const allIds = new Set();
    flatTree.forEach(n => { if (n.objectId) allIds.add(n.objectId); });

    // Build a map: referenced-targetId → line number where objects="#targetId" appears
    // This lets ERR-E09 (VAL-005) point to the exact line of the broken reference
    const refLineMap = new Map();
    {
        const xmlLines = mainXml.split("\n");
        // Match objects="..." or objects='...' — values may be space-separated id lists or "#id" forms
        const refRe = /\bobjects=["']([^"']+)["']/g;
        xmlLines.forEach((line, i) => {
            let m;
            refRe.lastIndex = 0;
            while ((m = refRe.exec(line)) !== null) {
                // Split on whitespace; each token may have a leading '#'
                m[1].split(/\s+/).forEach(token => {
                    const id = token.replace(/^#/, "");
                    if (id && !refLineMap.has(id)) refLineMap.set(id, i + 1);
                });
            }
        });
    }

    flatTree.forEach(node => {
        const loc = node.objectId ? `//*[@id='${node.objectId}']` : `(type: ${node.type})`;

        // VAL-004: Missing id check — moved to runDiscProfileGraphicalValidation.
        // Only applies when a DISC profile is loaded (this is a DISC-specific rule).

        // VAL-005: Referential integrity (skip known cross-file model references)
        node.refs.forEach(ref => {
            ref.objects.forEach(targetId => {
                if (externalValidIds.has(targetId)) return;
                if (!allIds.has(targetId)) {
                    const sev = resolveSeverity("VAL-005", severityConfig);
                    // Use the line where the broken objects="#targetId" reference appears,
                    // falling back to the line of the owning object
                    const refLine = refLineMap.get(targetId);
                    issues.push({
                        objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "VAL-005",
                        severity: sev.level, score: sev.score,
                        description: `Broken reference: '${ref.property}' references object '${targetId}' which is not present in this file.`,
                        location: `${loc}/References[@property='${ref.property}']`,
                        profileSource: "Base",
                        suggestedCorrection: `Ensure object '${targetId}' is included in the file, or remove/correct the reference.`,
                        ...(refLine !== undefined ? { lineNumber: refLine } : {})
                    });
                }
            });
        });
    });

    return issues;
}

// ─── XML Schema / Referential Validation (ERR-E02..E17) ──────────────────────

const KNOWN_DEXPI_SOURCES = new Set([
    "https://data.dexpi.org/models/2.0.0/Core.xml",
    "https://data.dexpi.org/models/2.0.0/Plant.xml",
    "https://data.dexpi.org/models/2.0.0/MetaData.xml",
    "https://data.dexpi.org/models/2.0.0/Profile.xml",
    "http://www.dexpi.org/specification/Temp/Profile",
]);

const ALLOWED_XML_TAGS = new Set([
    "Model","Import","Object","Components","Data","References",
    "DataReference","AggregatedDataValue","String","Double","Float",
    "Integer","Boolean","Enumeration","EnumerationValue",
    "DateTime","Undefined",
]);

const ALLOWED_OBJECT_ATTRS = new Set(["id","type","name"]);

// Known DEXPI 2.0 Plant Meta Model types (Core/, Plant/, Profile/ namespaces)
// ERR-E07: use the comprehensive type registry from dexpiTypes.js
// To add missing types, edit src/dexpiTypes.js — do NOT patch this file.
const KNOWN_DEXPI_TYPES = DEXPI_ALL_TYPES;
const DEXPI_STD_PREFIXES = _DEXPI_STD_PREFIXES;

function isKnownTypePrefix(t) {
    return t.startsWith("Core/") || t.startsWith("Plant/") || t.startsWith("Profile/");
}

const EQUIPMENT_TYPES_FOR_E17 = [
    "Pump","Compressor","HeatExchanger","Vessel","Tank","Heater","Cooler",
    "Filter","Separator","Column","Reactor","Turbine","Blower","Fan",
    "GateValve","BallValve","ButterflyValve","CheckValve","SafetyValve",
    "ControlValve","WedgeGateValve","NeedleValve","PlugValve","DiaphragmValve",
    "GlobeValve","FlowInPipeOffPageConnector","FlowOutPipeOffPageConnector",
    "FlowInSignalOffPageConnector","FlowOutSignalOffPageConnector","Note",
];

export function runXmlSchemaValidation(mainXml, flatTree, severityConfig, externalValidIds = new Set(), profileTypes = new Set(), profileExtProps = new Set(), compositionMap = null) {
    const issues = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(mainXml, "application/xml");
    if (doc.querySelector("parsererror")) {
        const parseErrText = (doc.querySelector("parsererror")?.textContent || "parse error").slice(0, 300);
        const sev = resolveSeverity("ERR-E01", severityConfig);
        issues.push({
            objectId: "(document)", objectType: "(document)", ruleId: "ERR-E01",
            severity: sev.level, score: sev.score,
            description: "XML is not well-formed: the file cannot be parsed as valid XML. " + parseErrText,
            location: "/", profileSource: "Base",
            suggestedCorrection: "Correct the XML syntax error (e.g. unclosed tags, mismatched elements) before re-submitting."
        });
        return issues;
    }

    const allLocalIds = new Set();
    doc.querySelectorAll("Object[id]").forEach(o => allLocalIds.add(o.getAttribute("id")));

    // Build objectId → line-number map from the raw XML text (DOMParser doesn't expose line info)
    const lineNumberMap = new Map();
    // Build referencedId → line-number map for objects="..." attributes (used by ERR-E12 etc.)
    const refLineMap = new Map();
    // Build "objectId::tagName::propertyName" → line-number map, scoped to the
    // specific Object each Data/Components/References element belongs to (via a
    // simple <Object>/</Object> nesting stack). Used by ERR-E07 so a reported
    // issue points at the actual offending property line (e.g. the line with
    // <Components property="SignalConnectors">), not just the containing
    // object's own opening-tag line.
    const propertyLineMap = new Map();
    {
        const xmlLines = mainXml.split("\n");
        const refRe = /\bobjects=["']([^"']+)["']/g;
        const objOpenRe = /<Object\b([^>]*?)(\/)?>/;
        const idAttrRe = /\bid=["']([^"']+)["']/;
        const propTagRe = /<(Components|Data|References)\b[^>]*\bproperty=["']([^"']+)["']/;
        const objStack = []; // ids ("" = anonymous) of currently-open <Object> ancestors
        xmlLines.forEach((line, i) => {
            // Match id="..." or id='...' anywhere on the line
            const m = line.match(/\bid=["']([^"']+)["']/);
            if (m) lineNumberMap.set(m[1], i + 1);
            // Match objects="..." — collect all referenced ids on this line
            refRe.lastIndex = 0;
            let rm;
            while ((rm = refRe.exec(line)) !== null) {
                rm[1].split(/\s+/).forEach(token => {
                    const id = token.replace(/^#/, "");
                    if (id && !refLineMap.has(id)) refLineMap.set(id, i + 1);
                });
            }

            // Record this line against the innermost currently-open object, using
            // the stack state as it stood BEFORE any Object open/close on this same
            // line (a property tag never shares a line with an Object open/close
            // in this XML format, but this ordering is defensive either way).
            const propTag = line.match(propTagRe);
            if (propTag) {
                const ownerId = objStack.length ? objStack[objStack.length - 1] : "";
                if (ownerId) {
                    const key = `${ownerId}::${propTag[1]}::${propTag[2]}`;
                    if (!propertyLineMap.has(key)) propertyLineMap.set(key, i + 1);
                }
            }

            // Maintain the Object-nesting stack.
            const objOpen = line.match(objOpenRe);
            if (objOpen) {
                const selfClosing = !!objOpen[2];
                if (!selfClosing) {
                    const idm = objOpen[1].match(idAttrRe);
                    objStack.push(idm ? idm[1] : "");
                }
                // self-closing <Object .../> has no children — nothing to push
            }
            if (/<\/Object>/.test(line)) objStack.pop();
        });
    }

    // Build representedIds early so all rules can use it for visual context lookup
    const representedIds = new Set();
    doc.querySelectorAll('References[property="Represents"]').forEach(ref => {
        (ref.getAttribute("objects") || "").split(/\s+/)
            .filter(t => t.startsWith("#")).forEach(t => representedIds.add(t.slice(1)));
    });

    // Walk up from a DOM element to find nearest ancestor Object with a graphical representation
    function findNearestRepAncestor(el) {
        let node = el.parentElement;
        while (node) {
            if (node.tagName === "Object") {
                const nid = node.getAttribute("id");
                if (nid && representedIds.has(nid)) return nid;
            }
            node = node.parentElement;
        }
        return null;
    }

    // ERR-E02: Import source not matching known DEXPI 2.0 namespace
    doc.querySelectorAll("Import").forEach(imp => {
        const src = imp.getAttribute("source") || "";
        const prefix = imp.getAttribute("prefix") || "";
        if (["Core","Plant","MetaData"].includes(prefix) && !KNOWN_DEXPI_SOURCES.has(src)) {
            const sev = resolveSeverity("ERR-E02", severityConfig);
            issues.push({
                objectId: "(document)", objectType: "Import", ruleId: "ERR-E02",
                severity: sev.level, score: sev.score,
                description: `Import source '${src}' for prefix '${prefix}' does not match a known DEXPI 2.0 schema namespace.`,
                location: `//Import[@prefix='${prefix}']`, profileSource: "Base",
                suggestedCorrection: `Use the official DEXPI 2.0 URL: 'https://data.dexpi.org/models/2.0.0/${prefix}.xml'.`
            });
        }
    });

    // ERR-E03: Unknown XML element tags
    function walkForUnknownTags(node) {
        for (const child of node.children) {
            if (!ALLOWED_XML_TAGS.has(child.tagName)) {
                const nearestObj = child.closest("Object[id]");
                const objectId = nearestObj ? nearestObj.getAttribute("id") : "(document)";
                const sev = resolveSeverity("ERR-E03", severityConfig);
                issues.push({
                    objectId: objectId, objectType: child.tagName, ruleId: "ERR-E03",
                    severity: sev.level, score: sev.score,
                    description: `Unknown element <${child.tagName}> is not defined in the DEXPI 2.0 XML schema.`,
                    location: objectId !== "(document)" ? `//*[@id='${objectId}']/<${child.tagName}>` : `//${child.tagName}`,
                    profileSource: "Base",
                    suggestedCorrection: `Remove or replace <${child.tagName}> with a valid DEXPI 2.0 element.`
                });
            } else {
                walkForUnknownTags(child);
            }
        }
    }
    walkForUnknownTags(doc.documentElement);

    // ERR-E04: Unknown attributes on Object elements
    doc.querySelectorAll("Object").forEach(obj => {
        for (const attr of obj.attributes) {
            if (!ALLOWED_OBJECT_ATTRS.has(attr.name)) {
                const objId = obj.getAttribute("id") || "(no id)";
                const sev = resolveSeverity("ERR-E04", severityConfig);
                issues.push({
                    objectId: objId, objectType: obj.getAttribute("type") || "(no type)", ruleId: "ERR-E04",
                    severity: sev.level, score: sev.score,
                    description: `Attribute '${attr.name}' is not permitted on Object elements by the DEXPI 2.0 schema.`,
                    location: objId !== "(no id)" ? `//*[@id='${objId}']/@${attr.name}` : `//Object/@${attr.name}`,
                    profileSource: "Base",
                    suggestedCorrection: `Remove the '${attr.name}' attribute.`
                });
            }
        }
    });

    // ERR-E05: Object missing mandatory 'type' attribute
    doc.querySelectorAll("Object").forEach(obj => {
        if (!obj.getAttribute("type") && !obj.getAttribute("name")) {
            const objId = obj.getAttribute("id") || "(no id)";
            const sev = resolveSeverity("ERR-E05", severityConfig);
            issues.push({
                objectId: objId, objectType: "(no type)", ruleId: "ERR-E05",
                severity: sev.level, score: sev.score,
                description: `Object${objId !== "(no id)" ? ` with id='${objId}'` : ""} is missing the mandatory 'type' attribute.`,
                location: objId !== "(no id)" ? `//*[@id='${objId}']` : "(unknown location)",
                profileSource: "Base",
                suggestedCorrection: "Add a 'type' attribute to this Object element."
            });
        }
    });

    // ERR-E06: Attribute value type mismatch
    const typeChecks = {
        Double:  v => !isNaN(parseFloat(v)) && isFinite(parseFloat(v)),
        Float:   v => !isNaN(parseFloat(v)) && isFinite(parseFloat(v)),
        Integer: v => /^-?\d+$/.test(v.trim()),
        Boolean: v => ["true","false","0","1"].includes(v.trim().toLowerCase()),
    };
    Object.entries(typeChecks).forEach(([tag, validate]) => {
        doc.querySelectorAll(tag).forEach(el => {
            const val = (el.textContent || "").trim();
            if (val && !validate(val)) {
                const dataEl = el.closest("Data");
                const prop = dataEl?.getAttribute("property") || "(unknown)";
                const objEl = el.closest("Object");
                const objId = objEl?.getAttribute("id") || "(no id)";
                const sev = resolveSeverity("ERR-E06", severityConfig);
                issues.push({
                    objectId: objId, objectType: objEl?.getAttribute("type") || "(no type)", ruleId: "ERR-E06",
                    severity: sev.level, score: sev.score,
                    description: `Value '${val}' in <${tag}> for property '${prop}' is not a valid ${tag}.`,
                    location: objId !== "(no id)" ? `//*[@id='${objId}']/Data[@property='${prop}']` : `//Data[@property='${prop}']/${tag}`,
                    profileSource: "Base",
                    suggestedCorrection: `Provide a valid ${tag} value for '${prop}'.`
                });
            }
        });
    });

    // ERR-E07: Object type not from a known DEXPI namespace / Plant Meta Model class
    const _importedPrefixes = new Set(["Core","Plant","Profile","MetaData"]);
    doc.querySelectorAll("Import").forEach(imp => {
        const px = imp.getAttribute("prefix"); if (px) _importedPrefixes.add(px);
    });
    doc.querySelectorAll("Object[type]").forEach(obj => {
        const t = obj.getAttribute("type") || "";
        const typePrefix = t.split("/")[0];
        if (!t) return;
        // Skip types explicitly defined in loaded profile files
        if (profileTypes.has(t)) return;
        const objId = obj.getAttribute("id") || "(no id)";
        const sev = resolveSeverity("ERR-E07", severityConfig);
        if (!_importedPrefixes.has(typePrefix)) {
            // Prefix not declared in any Import element
            issues.push({
                objectId: objId, objectType: t, ruleId: "ERR-E07",
                severity: sev.level, score: sev.score,
                description: `Object type '${t}' uses prefix '${typePrefix}' which is not declared in any Import element.`,
                location: objId !== "(no id)" ? `//*[@id='${objId}']` : `//Object[@type='${t}']`,
                profileSource: "Base",
                suggestedCorrection: "Declare a matching Import element or use a type from the DEXPI 2.0 Plant Meta Model."
            });
        } else if (DEXPI_STD_PREFIXES.has(typePrefix) && !KNOWN_DEXPI_TYPES.has(t)) {
            // Standard DEXPI prefix but class not in registry
            issues.push({
                objectId: objId, objectType: t, ruleId: "ERR-E07",
                severity: sev.level, score: sev.score,
                description: `Object type '${t}' has a standard DEXPI prefix but is not in the type registry. It may be a valid DEXPI 2.0 type — add it to dexpiTypes.js to suppress this warning.`,
                location: objId !== "(no id)" ? `//*[@id='${objId}']` : `//Object[@type='${t}']`,
                profileSource: "Base",
                suggestedCorrection: `Verify the class name in the DEXPI 2.0 specification, then add it to src/dexpiTypes.js.`
            });
        }
        // else: non-standard prefix declared as import (profile type) — prefix check is sufficient
    });

    // ERR-E07 (expanded): validate Data / Components / References property names
    // against the DEXPI 2.0 meta model for this document’s model type.
    // Only bare property names are checked (unprefixed). Prefixed properties
    // (e.g. "DiscProfile/TagType") come from profiles/extensions and are allowed.
    {
        const modelName  = detectMetaModel(doc);
        const mmLookup   = getMetaModelLookup(modelName);
        if (mmLookup) {
            const { classPropMap } = mmLookup;
            const localProp = p => (p || "").split(/[\.\//]/).pop();

            doc.querySelectorAll("Object[type]").forEach(obj => {
                const t = obj.getAttribute("type") || "";
                if (!t) return;
                if (profileTypes.has(t)) return; // profile-defined type: skip
                const typeSuffix = t.split(/[\.\//]/).pop();
                const allowed = classPropMap.get(typeSuffix);
                if (!allowed) return; // unknown class: already handled by type-check above

                const objId = obj.getAttribute("id") || "(no id)";
                const loc   = objId !== "(no id)" ? `//*[@id='${objId}']` : `//Object[@type='${t}']`;

                for (const child of obj.children) {
                    const prop  = child.getAttribute("property") || "";
                    const local = localProp(prop);
                    if (!local) continue;
                    // Prefixed properties (containing "/" or ".") come from profiles
                    // or meta-data conventions — skip.
                    if (prop.includes("/") || prop.includes(".")) continue;
                    // Allow bare properties added by any loaded profile's ClassExtension.
                    if (profileExtProps.has(local)) continue;

                    let kind = null, set = null;
                    if (child.tagName === "Data")       { kind = "Data";       set = allowed.d; }
                    else if (child.tagName === "Components") { kind = "Components"; set = allowed.c; }
                    else if (child.tagName === "References") { kind = "References"; set = allowed.r; }
                    if (!set || set.has(local)) continue;

                    const propSev = resolveSeverity("ERR-E07", severityConfig);
                    // Point at the specific offending property line (e.g. the
                    // <Components property="SignalConnectors"> line) rather than
                    // just the containing object's own opening-tag line.
                    const propLine = propertyLineMap.get(`${objId}::${child.tagName}::${local}`);
                    issues.push({
                        objectId: objId, objectType: t, ruleId: "ERR-E07",
                        severity: propSev.level, score: propSev.score,
                        description: `${kind} property '${prop}' is not defined for class '${t}' in the DEXPI 2.0 ${modelName} Meta Model (including inherited properties). ` +
                                     `If this is a profile extension, use a namespaced form (e.g. 'DiscProfile/${prop}').`,
                        location: loc,
                        profileSource: "Base",
                        suggestedCorrection: `Check the property name against the DEXPI 2.0 ${modelName} Meta Model, or prefix it with the profile namespace.`,
                        ...(propLine !== undefined ? { lineNumber: propLine } : {}),
                    });
                }
            });

            // ── ERR-E07 multiplicity sub-checks ──────────────────────────────
            // For every Object whose type is known to the meta-model, verify:
            //   (a) required properties (lo >= 1) are present
            //   (b) bounded properties (up = 1) do not appear more than once
            // Only bare (unprefixed) property names are examined; prefixed ones
            // come from profiles/extensions and are out of scope here.
            doc.querySelectorAll("Object[type]").forEach(obj => {
                const t = obj.getAttribute("type") || "";
                if (!t || profileTypes.has(t)) return;

                // Skip diagram/graphical representation objects entirely.
                // Types in */Diagram.* packages (e.g. Core/Diagram.PolyLine,
                // Plant/Diagram.PipingNodePosition) are structural/geometric elements
                // whose meta-model multiplicity (e.g. PolyLine.Points lower=2) counts
                // entries *within* an AggregatedDataValue array, not the number of
                // sibling Data elements.  Our element-count approach cannot handle array
                // semantics, so these objects would generate false positives.
                if (t.includes("/Diagram.")) return;

                const typeSuffix = t.split(/[\.\//]/).pop();
                const allowed = classPropMap.get(typeSuffix);
                if (!allowed) return;

                const objId = obj.getAttribute("id") || "(no id)";
                const loc   = objId !== "(no id)" ? `//*[@id='${objId}']` : `//Object[@type='${t}']`;
                const sev   = resolveSeverity("ERR-E07", severityConfig);

                // Count bare occurrences of each (tagName, propName) pair
                const propCounts = new Map(); // key: "Data:Name" | "Components:Name" | "References:Name"
                for (const child of obj.children) {
                    const tag = child.tagName;
                    if (tag !== "Data" && tag !== "Components" && tag !== "References") continue;
                    const prop  = child.getAttribute("property") || "";
                    if (prop.includes("/") || prop.includes(".")) continue; // prefixed → skip
                    const local = localProp(prop);
                    if (!local) continue;
                    const key = `${tag}:${local}`;
                    propCounts.set(key, (propCounts.get(key) || 0) + 1);
                }

                for (const [mk, tagName] of [["dm","Data"], ["cm","Components"], ["rm","References"]]) {
                    const mulMap = allowed[mk];
                    if (!mulMap) continue;
                    for (const [propName, mul] of mulMap) {
                        if (profileExtProps.has(propName)) continue;
                        const count = propCounts.get(`${tagName}:${propName}`) || 0;

                        // (a) Required but absent
                        if (mul.lo >= 1 && count < mul.lo) {
                            issues.push({
                                objectId: objId, objectType: t, ruleId: "ERR-E07",
                                severity: sev.level, score: sev.score,
                                description: `Required ${tagName} property '${propName}' is missing on '${t}' ` +
                                    `(lower bound = ${mul.lo} per the DEXPI 2.0 ${modelName} Meta Model).`,
                                location: loc, profileSource: "Base",
                                suggestedCorrection: `Add ${tagName} property '${propName}' with at least ${mul.lo} value(s).`
                            });
                        }

                        // (b) Bounded but duplicated (up = 1, count > 1)
                        if (mul.up !== null && count > mul.up) {
                            const propLine = propertyLineMap.get(`${objId}::${tagName}::${propName}`);
                            issues.push({
                                objectId: objId, objectType: t, ruleId: "ERR-E07",
                                severity: sev.level, score: sev.score,
                                description: `${tagName} property '${propName}' on '${t}' appears ${count} time(s) ` +
                                    `but the DEXPI 2.0 ${modelName} Meta Model allows at most ${mul.up}.`,
                                location: loc, profileSource: "Base",
                                suggestedCorrection: `Remove the duplicate ${tagName} '${propName}' entry, keeping only one.`,
                                ...(propLine !== undefined ? { lineNumber: propLine } : {}),
                            });
                        }
                    }
                }
            });
        }
    }

    // ERR-E08: Object placed under incompatible parent Components property.
    // Schema-driven: for every Components[@property=P] under an Object of type T,
    // resolve the required child/target class (ClassReference) that the DEXPI 2.0
    // meta model (plus any loaded profile's own class model) declares for P on T
    // - by direct declaration or inheritance - and flag any child Object whose own
    // type is not that class or a (transitive) subtype of it. This generalises the
    // old hardcoded, name-only PARENT_PROP_RULES table to the full Plant/Process
    // meta model, and also catches composition properties whose target type is
    // known but simply has never been hand-curated into a rule table.
    if (compositionMap) {
        const localPropName = p => (p || "").split(/[.\/]/).pop();
        doc.querySelectorAll("Components").forEach(comp => {
            const parentObj = comp.parentElement;
            if (!parentObj || parentObj.tagName !== "Object") return;
            const parentType = parentObj.getAttribute("type") || "";
            if (!parentType) return;
            const parentSuffix = parentType.split(/[.\/]/).pop();
            const propLocal = localPropName(comp.getAttribute("property") || "");
            if (!propLocal) return;

            const clsEntry = compositionMap.classComposition.get(parentSuffix);
            const propEntry = clsEntry ? clsEntry.get(propLocal) : null;
            // No known declaration for this (class, property) combination — either
            // it's genuinely invalid (already reported by ERR-E07's property-name
            // check) or it's a profile extension property with no target on record.
            // Nothing further to check here without a target type.
            if (!propEntry || !propEntry.target) return;

            for (const child of comp.children) {
                if (child.tagName !== "Object") continue;
                const childType = child.getAttribute("type") || "";
                if (!childType) continue;
                const childSuffix = childType.split(/[.\/]/).pop();
                if (isSubtypeOrSelf(childSuffix, propEntry.target, compositionMap.closure)) continue;

                const childId = child.getAttribute("id") || "(no id)";
                const directRep = childId !== "(no id)" && representedIds.has(childId);
                const visualContextId = directRep ? null : findNearestRepAncestor(child);
                const sev = resolveSeverity("ERR-E08", severityConfig);
                issues.push({
                    objectId: childId, objectType: childType, ruleId: "ERR-E08",
                    severity: sev.level, score: sev.score,
                    description: `Object of type '${childType}' is placed under Components[@property='${comp.getAttribute("property")}'] of '${parentType}', but the DEXPI 2.0 Plant Meta Model requires this property's items to be of type '${propEntry.target}' (or a subtype). '${childSuffix}' is not compatible.`,
                    location: childId !== "(no id)" ? `//*[@id='${childId}']` : `//Components[@property='${comp.getAttribute("property")}']`,
                    profileSource: "Base",
                    suggestedCorrection: `Move this object to the correct parent property for type '${childType}', or verify '${childType}' is the intended class here.`,
                    ...(visualContextId ? { visualContextId } : {}),
                });
            }
        });
    }

    // ERR-E10: Duplicate id attributes
    const idCounts = new Map();
    doc.querySelectorAll("Object[id]").forEach(o => {
        const id = o.getAttribute("id");
        idCounts.set(id, (idCounts.get(id) || 0) + 1);
    });
    idCounts.forEach((count, id) => {
        if (count > 1) {
            const sev = resolveSeverity("ERR-E10", severityConfig);
            issues.push({
                objectId: id, objectType: "(multiple)", ruleId: "ERR-E10",
                severity: sev.level, score: sev.score,
                description: `Duplicate id='${id}': ${count} objects share this identifier. IDs must be unique within the file.`,
                location: `//*[@id='${id}']`, profileSource: "Base",
                suggestedCorrection: `Assign a unique id to each object. Remove the duplicate occurrence of id='${id}'.`
            });
        }
    });

    // ERR-E11: Duplicate PersistentIdentifier values
    const pidSeen = new Map();
    doc.querySelectorAll('Object[type="Core/PersistentIdentifier"]').forEach(pidObj => {
        const ctxEl = [...pidObj.querySelectorAll("Data")].find(d => d.getAttribute("property") === "Context");
        const valEl = [...pidObj.querySelectorAll("Data")].find(d => d.getAttribute("property") === "Value");
        const ctx = ctxEl?.querySelector("String")?.textContent?.trim() || "";
        const val = valEl?.querySelector("String")?.textContent?.trim() || "";
        if (!val) return;
        const key = `${ctx}::${val}`;
        const ownerObj = pidObj.parentElement?.parentElement;
        const ownerId = ownerObj?.getAttribute("id") || null;
        if (!ownerId) return; // skip anonymous owners
        if (!pidSeen.has(key)) pidSeen.set(key, []);
        if (!pidSeen.get(key).includes(ownerId)) pidSeen.get(key).push(ownerId);
    });
    pidSeen.forEach((owners, key) => {
        if (owners.length > 1) {
            const [ctx, val] = key.split("::");
            const sev = resolveSeverity("ERR-E11", severityConfig);
            issues.push({
                objectId: owners.slice(0, 3).join(", ") + (owners.length > 3 ? "…" : ""),
                objectType: "Core/PersistentIdentifier", ruleId: "ERR-E11",
                severity: sev.level, score: sev.score,
                description: `PersistentIdentifier value '${val}' (context: '${ctx || "(none)"}') is shared by ${owners.length} objects: ${owners.slice(0, 4).join(", ")}${owners.length > 4 ? "…" : ""}. PersistentIDs must be unique.`,
                location: `//Object[@type='Core/PersistentIdentifier']`, profileSource: "Base",
                suggestedCorrection: "Assign unique PersistentIdentifier values to each object."
            });
        }
    });

    // ERR-E12: Reference target wrong type for relationship
    // OperatedValveReference.Valve must point to a valve type
    const flatMap = new Map(flatTree.filter(n => n.objectId).map(n => [n.objectId, n]));
    flatTree.forEach(node => {
        if (!node.type.includes("OperatedValveReference")) return;
        const loc = node.objectId ? `//*[@id='${node.objectId}']` : "(OperatedValveReference)";
        node.refs.forEach(ref => {
            if (ref.property.toLowerCase() !== "valve") return;
            ref.objects.forEach(targetId => {
                const target = flatMap.get(targetId);
                if (!target) return;
                const ts = target.type.split(".").pop().toLowerCase();
                const isValve = ts.includes("valve") || ts.includes("gate") || ts.includes("ball") || ts.includes("butterfly") || ts.includes("check");
                if (!isValve) {
                    const sev = resolveSeverity("ERR-E12", severityConfig);
                    const refLine = refLineMap.get(targetId);
                    issues.push({
                        objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "ERR-E12",
                        severity: sev.level, score: sev.score,
                        description: `OperatedValveReference.Valve references '${targetId}' (type '${target.type}') which is not a valve type.`,
                        location: `${loc}/References[@property='Valve']`, profileSource: "Base",
                        suggestedCorrection: "Change the Valve reference to point to an object of a valve type.",
                        targetObjectId: targetId,
                        ...(refLine !== undefined ? { lineNumber: refLine } : {})
                    });
                }
            });
        });
    });

    // ERR-E15: PlantMetaData element absent
    if (!doc.querySelector('Object[type="Plant/Diagram.PlantMetaData"]')) {
        const sev = resolveSeverity("ERR-E15", severityConfig);
        issues.push({
            objectId: "(document)", objectType: "(document)", ruleId: "ERR-E15",
            severity: sev.level, score: sev.score,
            description: "PlantMetaData element (type='Plant/Diagram.PlantMetaData') is absent from the file.",
            location: "/", profileSource: "Base",
            suggestedCorrection: "Add a PlantMetaData element to the diagram section of the file."
        });
    }

    // ERR-E16: Orphaned graphical elements (Represents → non-existent object)
    doc.querySelectorAll('References[property="Represents"]').forEach(ref => {
        const targets = (ref.getAttribute("objects") || "").split(/\s+/).filter(Boolean);
        targets.forEach(t => {
            if (!t.startsWith("#")) return; // skip cross-file model refs
            const targetId = t.slice(1);
            if (!allLocalIds.has(targetId) && !externalValidIds.has(targetId)) {
                const parentObj = ref.closest("Object");
                const sev = resolveSeverity("ERR-E16", severityConfig);
                issues.push({
                    objectId: parentObj?.getAttribute("id") || "(no id)",
                    objectType: parentObj?.getAttribute("type") || "(no type)",
                    ruleId: "ERR-E16",
                    severity: sev.level, score: sev.score,
                    description: `Graphical Represents reference points to '${t}' which has no corresponding model object (orphaned graphical element).`,
                    location: "//References[@property='Represents']", profileSource: "Base",
                    suggestedCorrection: `Remove or correct the Represents reference to '${t}'.`
                });
            }
        });
    });

    // ERR-E17: Orphaned model objects (important equipment with no graphical representation)
    // (representedIds already built above)
    flatTree.forEach(node => {
        if (!node.objectId || !node.type) return;
        const suffix = node.type.split(".").pop();
        if (!EQUIPMENT_TYPES_FOR_E17.some(eq => suffix.includes(eq))) return;
        if (!representedIds.has(node.objectId)) {
            const sev = resolveSeverity("ERR-E17", severityConfig);
            issues.push({
                objectId: node.objectId, objectType: node.type, ruleId: "ERR-E17",
                severity: sev.level, score: sev.score,
                description: `Model object '${node.label || node.objectId}' (${node.objectId}) of type '${suffix}' has no graphical RepresentationGroup (orphaned model object).`,
                location: `//*[@id='${node.objectId}']`, profileSource: "Base",
                suggestedCorrection: "Add a RepresentationGroup with a Represents reference pointing to this object."
            });
        }
    });

    // VAE-005: ConnectorLine Source and Target at the same position (zero-length connector)
    {
        // Build NodePosition id → {x,y} map
        const nodePositions = new Map();
        doc.querySelectorAll([
            'Object[type="Plant/Diagram.PipingNodePosition"]',
            'Object[type="Plant/Diagram.InstrumentationNodePosition"]',
            'Object[type="Core/Diagram.NodePosition"]',
        ].join(",")).forEach(np => {
            const id = np.getAttribute("id");
            if (!id) return;
            const posData = Array.from(np.children).find(c =>
                c.tagName === "Data" && c.getAttribute("property") === "Position");
            if (!posData) return;
            const agv = posData.querySelector("AggregatedDataValue");
            if (!agv) return;
            let x = null, y = null;
            for (const d of agv.children) {
                const v = d.querySelector("Double") || d.querySelector("Integer");
                if (!v) continue;
                const p = d.getAttribute("property");
                if (p === "X") x = parseFloat(v.textContent);
                if (p === "Y") y = parseFloat(v.textContent);
            }
            if (x !== null && y !== null) nodePositions.set(id, { x, y });
        });

        doc.querySelectorAll('Object[type="Core/Diagram.ConnectorLine"]').forEach(cl => {
            const clId = cl.getAttribute("id") || null;
            let sourceId = null, targetId = null;
            for (const child of cl.children) {
                if (child.tagName !== "References") continue;
                const prop = child.getAttribute("property");
                const raw = (child.getAttribute("objects") || "").split(/\s+/).filter(Boolean)[0];
                const id = raw ? raw.replace(/^#/, "") : null;
                if (prop === "Source" && id) sourceId = id;
                if (prop === "Target" && id) targetId = id;
            }
            if (!sourceId || !targetId) return;
            const src = nodePositions.get(sourceId);
            const tgt = nodePositions.get(targetId);
            if (!src || !tgt) return;
            if (src.x === tgt.x && src.y === tgt.y) {
                const sev = resolveSeverity("VAE-005", severityConfig);
                const objId = clId || "(no id)";
                issues.push({
                    objectId: objId, objectType: "Core/Diagram.ConnectorLine", ruleId: "VAE-005",
                    severity: sev.level, score: sev.score,
                    description: `ConnectorLine '${objId}' has Source ('${sourceId}') and Target ('${targetId}') at the same position (${src.x}, ${src.y}). The connection has zero length.`,
                    location: objId !== "(no id)" ? `//*[@id='${objId}']` : "//Object[@type='Core/Diagram.ConnectorLine']",
                    profileSource: "Base",
                    suggestedCorrection: `Move the Source or Target NodePosition to a distinct coordinate so the connector line has non-zero length.`,
                });
            }
        });
    }

    // ── Post-processing: stamp line numbers onto all issues ─────────────────────
    issues.forEach(iss => {
        if (iss.lineNumber !== undefined) return; // already set
        const id = iss.objectId;
        if (id && !id.startsWith("(")) {
            const ln = lineNumberMap.get(id) || lineNumberMap.get(id.split(",")[0].trim());
            if (ln) iss.lineNumber = ln;
        }
    });

    // ── Post-processing: annotate causedBy for known causal chains ────────────
    // Build objectId → issues index
    const _issuesByObj = new Map();
    issues.forEach(iss => {
        if (!iss.objectId || iss.objectId.startsWith("(")) return;
        if (!_issuesByObj.has(iss.objectId)) _issuesByObj.set(iss.objectId, []);
        _issuesByObj.get(iss.objectId).push(iss);
    });
    // ERR-E12: caused by issues on the referenced target object
    issues.forEach(iss => {
        if (iss.ruleId !== "ERR-E12" || !iss.targetObjectId) return;
        const parents = (_issuesByObj.get(iss.targetObjectId) || [])
            .map(ti => ({ ruleId: ti.ruleId, objectId: ti.objectId, description: ti.description }));
        if (parents.length) iss.causedBy = parents;
    });
    // Same-objectId: secondary issues (not ERR-E12) point to the most-severe sibling
    _issuesByObj.forEach((grp) => {
        if (grp.length < 2) return;
        const primary = grp[0]; // first (highest-priority in insertion order) is the primary
        grp.slice(1).forEach(iss => {
            if (!iss.causedBy && iss.ruleId !== primary.ruleId) {
                iss.causedBy = [{ ruleId: primary.ruleId, objectId: primary.objectId, description: primary.description }];
            }
        });
    });

    return issues;
}


// ─── Structural Validation (VAX) ──────────────────────────────────────────────

export function runStructuralValidation(flatTree, severityConfig) {
    const issues = [];

    // Build set of PipingNode IDs referenced by connections
    const connectedNodeIds = new Set();
    flatTree.forEach(node => {
        node.refs.forEach(ref => {
            const p = ref.property.toLowerCase();
            if (p.includes("startnode") || p.includes("endnode") ||
                p.includes("source") || p.includes("target") || p.includes("node")) {
                ref.objects.forEach(id => connectedNodeIds.add(id));
            }
        });
    });

    flatTree.forEach(node => {
        const loc = node.objectId ? `//*[@id='${node.objectId}']` : `(type: ${node.type})`;
        const typeSuffix = node.type.split(".").pop();

        // VAX-003: PipingNetworkSystem must contain at least one segment
        if (typeSuffix === "PipingNetworkSystem") {
            const hasSegments = node.children.some(c =>
                c.type.includes("PipingNetworkSegment") || c.edgeLabel === "Segments");
            if (!hasSegments) {
                const sev = resolveSeverity("VAX-003", severityConfig);
                issues.push({
                    objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "VAX-003",
                    severity: sev.level, score: sev.score,
                    description: `PipingNetworkSystem '${node.label}' contains no PipingNetworkSegments (minimum 1 required).`,
                    location: loc, profileSource: "Base",
                    suggestedCorrection: "Add at least one PipingNetworkSegment to this PipingNetworkSystem."
                });
            }
        }

        // VAX-003: InstrumentationLoopFunction must contain at least one ProcessInstrumentationFunction
        // PIFs may be nested as Components (children) or referenced via ProcessInstrumentationFunctions property
        if (typeSuffix === "InstrumentationLoopFunction") {
            const hasPIFChildren = node.children.some(c =>
                c.type.includes("ProcessInstrumentationFunction") || c.type.includes("InstrumentationFunction"));
            const hasPIFRefs = node.refs.some(r =>
                (r.property === "ProcessInstrumentationFunctions" ||
                 r.property.toLowerCase().includes("processinstrumentation") ||
                 r.property.toLowerCase().includes("instrumentationfunction")) &&
                r.objects.length > 0);
            if (!hasPIFChildren && !hasPIFRefs) {
                const sev = resolveSeverity("VAX-003", severityConfig);
                issues.push({
                    objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "VAX-003",
                    severity: sev.level, score: sev.score,
                    description: `InstrumentationLoopFunction '${node.label}' contains no ProcessInstrumentationFunction elements (neither as Components children nor via ProcessInstrumentationFunctions references).`,
                    location: loc, profileSource: "Base",
                    suggestedCorrection: "Add at least one ProcessInstrumentationFunction to this loop, either as a nested Component or a References.ProcessInstrumentationFunctions entry."
                });
            }
        }

        // VAX-001: ActuatingSystem must have a ControlledActuator
        if (typeSuffix === "ActuatingSystem") {
            const hasActuator = node.children.some(c =>
                c.type.includes("ControlledActuator") || c.edgeLabel === "ControlledActuator") ||
                node.refs.some(r => r.property.toLowerCase().includes("controlledactuator"));
            if (!hasActuator) {
                const sev = resolveSeverity("VAX-001", severityConfig);
                issues.push({
                    objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "VAX-001",
                    severity: sev.level, score: sev.score,
                    description: `ActuatingSystem '${node.label}' has no ControlledActuator. An ActuatingSystem must contain at least one ControlledActuator.`,
                    location: loc, profileSource: "Base",
                    suggestedCorrection: "Add a ControlledActuator to this ActuatingSystem."
                });
            }
        }

        // (VAX-002 removed — duplicated ERR-E12's OperatedValveReference.Valve
        // target-type check, less precisely, since it inspected every reference
        // on the node instead of just the "Valve" property. ERR-E12 covers this.)

        // VAX-004: PipingNode orphan check
        if (typeSuffix === "PipingNode" && node.objectId && !connectedNodeIds.has(node.objectId)) {
            const sev = resolveSeverity("VAX-004", severityConfig);
            issues.push({
                objectId: node.objectId, objectType: node.type, ruleId: "VAX-004",
                severity: sev.level, score: sev.score,
                description: `PipingNode '${node.objectId}' is not referenced by any connection. Orphaned nodes indicate incomplete piping network connectivity.`,
                location: loc, profileSource: "Base",
                suggestedCorrection: "Connect this piping node to a pipe connection, or remove if unused."
            });
        }

        // VAX-005: PipingNetworkSegment should have connections defined
        if (typeSuffix === "PipingNetworkSegment") {
            const hasConns = node.refs.some(r => {
                const p = r.property.toLowerCase();
                return p.includes("connection") || p.includes("start") || p.includes("end");
            }) || node.children.some(c =>
                c.type.includes("Connection") || c.edgeLabel === "Connections");
            if (!hasConns) {
                const sev = resolveSeverity("VAX-005", severityConfig);
                issues.push({
                    objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "VAX-005",
                    severity: sev.level, score: sev.score,
                    description: `PipingNetworkSegment '${node.label}' has no connections defined. A segment should have at least start and end connections.`,
                    location: loc, profileSource: "Base",
                    suggestedCorrection: "Add Connections (start/end PipingNetworkSegmentConnections) to this segment."
                });
            }
        }
    });

    return issues;
}

// ─── Engineering / Semantic Validation (VAE) ──────────────────────────────────

export function runEngineeringValidation(flatTree, severityConfig) {
    const issues = [];

    // Build set of PIF ids that belong to any InstrumentationLoopFunction (via Components or References).
    // These get their identification from the loop context, so they are exempt from the standalone VAE-003 check.
    const loopMemberPifIds = new Set();
    flatTree.forEach(node => {
        if (!node.type.includes("InstrumentationLoopFunction")) return;
        // Children (Components)
        node.children.forEach(c => {
            if (c.type.includes("ProcessInstrumentationFunction") || c.type.includes("InstrumentationFunction"))
                if (c.objectId) loopMemberPifIds.add(c.objectId);
        });
        // References (ProcessInstrumentationFunctions property)
        node.refs.forEach(ref => {
            if (ref.property === "ProcessInstrumentationFunctions" ||
                ref.property.toLowerCase().includes("processinstrumentation"))
                ref.objects.forEach(id => loopMemberPifIds.add(id));
        });
    });

    // Build set of OperatedValveReference ids that have a Valve reference, and the valve ids they point to.
    // Used by the corrected VAE-001 which validates OperatedValveReference → Valve relationships.
    const flatMap = new Map(flatTree.filter(n => n.objectId).map(n => [n.objectId, n]));
    flatTree.forEach(node => {
        if (!node.type.includes("OperatedValveReference")) return;
        const hasValveRef = node.refs.some(r => r.property.toLowerCase() === "valve" && r.objects.length > 0);
        if (!hasValveRef) {
            const loc = node.objectId ? `//*[@id='${node.objectId}']` : "(OperatedValveReference)";
            const sev = resolveSeverity("VAE-001", severityConfig);
            issues.push({
                objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "VAE-001",
                severity: sev.level, score: sev.score,
                description: `OperatedValveReference '${node.objectId || "(no id)"}' has no Valve reference. An ActuatingSystem's OperatedValveReference must point to an OperatedValve type or sub-type.`,
                location: loc, profileSource: "Base",
                suggestedCorrection: "Add a References[@property='Valve'] pointing to an OperatedValve or valve subtype on this OperatedValveReference."
            });
        }
    });

    flatTree.forEach(node => {
        const loc = node.objectId ? `//*[@id='${node.objectId}']` : `(type: ${node.type})`;
        const typeSuffix = node.type.split(".").pop();
        const typeLC = typeSuffix.toLowerCase();

        // VAE-001: Major process equipment should have nozzles
        if (typeLC.includes("pump") || typeLC.includes("compressor") ||
            typeLC.includes("heatexchanger") || typeLC.includes("vessel") || typeLC === "tank") {
            const hasNozzles = node.children.some(c => c.type.includes("Nozzle") || c.edgeLabel === "Nozzles");
            if (!hasNozzles) {
                const sev = resolveSeverity("VAE-001", severityConfig);
                issues.push({
                    objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "VAE-001",
                    severity: sev.level, score: sev.score,
                    description: `Equipment '${node.label}' of type '${typeSuffix}' has no Nozzles. Process equipment requires at least one nozzle for piping connectivity.`,
                    location: loc, profileSource: "Base",
                    suggestedCorrection: "Add Nozzle components to this equipment item."
                });
            }
        }

        // VAE-002: PipingNetworkSegment should contain at least one PipingComponent (or subtype).
        // In the DEXPI Plant Meta Model, PipingComponent subtypes include Pipe, all Valve types,
        // Fittings, FlowMeasuringElements, etc. — essentially every Plant/Piping.* type that is
        // not a network/structural type. We match by namespace prefix and exclude the non-component
        // structural types. Children may sit under any Components property (Items, Connections, etc.).
        if (typeSuffix === "PipingNetworkSegment") {
            // Types in the Plant/Piping namespace that are NOT PipingComponent subtypes.
            const PIPING_NON_COMPONENT_SUFFIXES = new Set([
                "PipingNetworkSegment", "PipingNetworkSystem", "PipingNode", "PropertyBreak",
            ]);
            const isPipingComponent = t => {
                if (!t) return false;
                // Explicit string match for legacy / profile types
                if (t.includes("PipingComponent") || t.includes("PipingItem")) return true;
                // Any Plant/Piping.* type that is not a network/structural container
                if (t.startsWith("Plant/Piping.")) {
                    const suffix = t.split(".").pop();
                    return !PIPING_NON_COMPONENT_SUFFIXES.has(suffix);
                }
                return false;
            };
            const hasItems = node.children.some(c => isPipingComponent(c.type));
            if (!hasItems) {
                const sev = resolveSeverity("VAE-002", severityConfig);
                issues.push({
                    objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "VAE-002",
                    severity: sev.level, score: sev.score,
                    description: `PipingNetworkSegment '${node.label || node.objectId}' contains no PipingComponent or subtype. A segment should contain at least one piping component (Pipe, Valve, Fitting, etc.).`,
                    location: loc, profileSource: "Base",
                    suggestedCorrection: "Add at least one PipingComponent subtype (e.g. Pipe, Valve, Fitting) to this PipingNetworkSegment."
                });
            }
        }

        // VAE-003: ProcessInstrumentationFunction must have a tag/identifier
        // Exempt PIFs that are members of a loop — they inherit identification from their loop.
        if (typeSuffix === "ProcessInstrumentationFunction" && node.objectId) {
            if (loopMemberPifIds.has(node.objectId)) {
                // PIF is part of a loop — skip the standalone tag check
            } else {
                // Check own TagName, InstrumentationLoopFunctionNumber, or InstrumentationFunctionNumber
                const hasFunctionNumber = node.data.some(d => {
                    const p = (d.property || "").toLowerCase();
                    return p.includes("functionnumber") || p.includes("loopnumber");
                });
                if (!node.tagName && !node.loopNum && !hasFunctionNumber) {
                    const sev = resolveSeverity("VAE-003", severityConfig);
                    issues.push({
                        objectId: node.objectId, objectType: node.type, ruleId: "VAE-003",
                        severity: sev.level, score: sev.score,
                        description: `ProcessInstrumentationFunction '${node.objectId}' has no TagName, InstrumentationLoopFunctionNumber, or InstrumentationFunctionNumber, and is not a member of any InstrumentationLoopFunction. Instrumentation functions must be identified by a tag or loop context.`,
                        location: loc, profileSource: "Base",
                        suggestedCorrection: "Add a TagName Data property, or add an InstrumentationLoopFunctionNumber, or reference this PIF from an InstrumentationLoopFunction via its ProcessInstrumentationFunctions property."
                    });
                }
            }
        }

        // VAE-004: Nozzle must be a child of a ProcessEquipment object via the 'Nozzles' property
        if (typeSuffix === "Nozzle" && node.objectId) {
            if (node.edgeLabel !== "Nozzles") {
                const sev = resolveSeverity("VAE-004", severityConfig);
                issues.push({
                    objectId: node.objectId, objectType: node.type, ruleId: "VAE-004",
                    severity: sev.level, score: sev.score,
                    description: `Nozzle '${node.label || node.objectId}' is not related to a ProcessEquipment item through the 'Nozzles' Components property (current parent property: '${node.edgeLabel || "(none)"}').`,
                    location: loc, profileSource: "Base",
                    suggestedCorrection: "Move this Nozzle inside a ProcessEquipment object's Components[@property='Nozzles'] collection."
                });
            }
        }
    });

    // VAE-006: ProcessInstrumentationFunction not connected to any SignalConveyingFunction or subtype.
    // In a well-formed DEXPI model every PIF should appear as the Source or Target of at least one
    // signal line (MeasuringLineFunction, SignalConveyingFunction, ActuatingLineFunction, etc.).
    // A PIF that is referenced by no signal line is either unconnected or its signal lines are missing.
    {
        // Types that convey instrument signals and whose Source/Target refs must include the PIF.
        const SCF_KEYWORDS = [
            "SignalConveyingFunction", "MeasuringLineFunction",
            "ActuatingLineFunction",   "ControlLineFunction",
            "SignalBranchFunction",
        ];

        // Collect every ID that appears as Source or Target of any signal-conveying function.
        const scfRefIds = new Set();
        flatTree.forEach(node => {
            if (!SCF_KEYWORDS.some(kw => node.type.includes(kw))) return;
            node.refs.forEach(ref => {
                if (ref.property === "Source" || ref.property === "Target") {
                    ref.objects.forEach(id => scfRefIds.add(id));
                }
            });
        });

        // Flag every ProcessInstrumentationFunction whose objectId is absent from those refs.
        flatTree.forEach(node => {
            if (!node.type.includes("ProcessInstrumentationFunction")) return;
            if (!node.objectId) return;
            if (scfRefIds.has(node.objectId)) return;   // connected — OK
            const sev = resolveSeverity("VAE-006", severityConfig);
            issues.push({
                objectId: node.objectId, objectType: node.type, ruleId: "VAE-006",
                severity: sev.level, score: sev.score,
                description: `ProcessInstrumentationFunction '${node.label || node.objectId}' is not the Source or Target of any SignalConveyingFunction or subtype (MeasuringLineFunction, ActuatingLineFunction, etc.). Every instrumentation function should be connected to a signal line.`,
                location: `//*[@id='${node.objectId}']`, profileSource: "Base",
                suggestedCorrection: "Add a MeasuringLineFunction or SignalConveyingFunction whose Source or Target references this ProcessInstrumentationFunction, or verify that the signal connection exists and the reference is not broken."
            });
        });
    }

    return issues;
}

// (Built-in DEXPI 2.0 Model Attribute Validation, formerly here as
// DEXPI_BUILT_IN_ATTRIBUTE_RULES / runBuiltInAttributeValidation, has been
// removed. It hand-maintained a small hardcoded table of 4 properties
// (HeatTracingType, CreatorName, DrawingName, DrawingNumber) duplicating what
// ERR-E07 already derives generically from the auto-generated Plant/Process
// meta-model (src/metaModel.js, from Core.xml/Plant.xml/Process.xml) — for
// every Data property on every class, not just these 4 — including the same
// "not defined for class" and cardinality checks. The hardcoded table was
// also stale: it restricted HeatTracingType to "Plant/Piping.*", but the real
// meta-model also grants it to Plant/Instrumentation.OfflineMeasuringElement,
// so it would have flagged a legitimate use as an error. ERR-E07 alone (plus
// any loaded profile's own PropertyConstraint-driven ERR-E18/E19 checks, see
// runAttributeConstraintValidation below) now covers this ground correctly.)

// ─── Profile Class-Model Attribute Map ───────────────────────────────────────
//
// Parses one or more profile XMLs to build a map of:
//   localAttributeName → Set<classTypeSuffix>
// derived from DataProperty declarations on ConcreteClass / ClassExtension /
// AbstractClass nodes (the DEXPI class model, distinct from PropertyConstraint).
// Used by ERR-E18 to allow attributes that the class model grants via inheritance
// even when no PropertyConstraint entry covers the combination.
//
function buildProfileAttributeMap(profileXmlList) {
    // attrLocal → Set<type suffix>
    const attrToTypes = new Map();
    // classSuffix → Set<superType suffixes>
    const hierarchy   = new Map();
    // classSuffix → Set<attr locals declared directly on it>
    const classAttrs  = new Map();

    // Seed hierarchy from the Plant meta-model so Plant-model types
    // (e.g. ButterflyValve → OperatedValve) are available for ERR-E18
    // attribute inheritance without bundling the full Plant.xml.
    for (const [cls, sup] of PLANT_HIERARCHY) {
        if (!hierarchy.has(cls)) hierarchy.set(cls, new Set());
        hierarchy.get(cls).add(sup);
    }

    // Seed classAttrs from the base Plant meta-model's own native Data
    // property declarations (PLANT_PROPS) too - not just profile-declared
    // ClassExtension/ConcreteClass DataProperty grants. Some attributes an
    // ERR-E18 built-in rule cares about (e.g. HeatTracingType, natively
    // defined on PipingComponent per PLANT_PROPS) are base DEXPI 2.0
    // attributes, not profile extensions - a DiscProfile-redeclared
    // subclass (e.g. "DiscProfile/InformationModel.WedgeGateValve", whose
    // own superTypes chain reaches "PipingComponent" via
    // "Plant/Piping.OperatedValve") needs to inherit that NATIVE grant the
    // same way it inherits a profile-declared one, via the fixpoint
    // propagation below - without this seed, PipingComponent would have no
    // classAttrs entry at all (since no profile ClassExtension re-declares
    // an attribute the base model already grants), and the whole chain
    // would incorrectly appear unbacked.
    for (const [cls, dcsv] of PLANT_PROPS) {
        if (!dcsv) continue;
        if (!classAttrs.has(cls)) classAttrs.set(cls, new Set());
        for (const entry of dcsv.split("|")) {
            const name = entry.split(":")[0];
            if (name) classAttrs.get(cls).add(name);
        }
    }

    const parser = new DOMParser();
    for (const profileXml of profileXmlList) {
        if (!profileXml) continue;
        const doc = parser.parseFromString(profileXml, "application/xml");
        if (doc.querySelector("parsererror")) continue;

        // Collect class definitions: ConcreteClass, AbstractClass, ClassExtension
        //
        // ClassExtension is special: its `name` is the extension's own identifier
        // (e.g. "InlineMeasuringElementExtension") but its DataProperty entries extend
        // the class named by `baseType` (e.g. "Plant/Piping.InlineMeasuringElement").
        // Key ClassExtension entries on the baseType suffix so subclasses that list
        // the base type in superTypes correctly inherit the extended attributes.

        // ConcreteClass / AbstractClass
        ["ConcreteClass", "AbstractClass"].forEach(tag => {
            doc.querySelectorAll(tag).forEach(cls => {
                const rawName = cls.getAttribute("name") || "";
                if (!rawName) return;
                const suffix = rawName.split(/[.\/]/).pop();

                // Supertype hierarchy
                const supers = (cls.getAttribute("superTypes") || "").trim();
                if (supers) {
                    if (!hierarchy.has(suffix)) hierarchy.set(suffix, new Set());
                    supers.split(/\s+/).forEach(s => {
                        const ss = s.split(/[.\/]/).pop();
                        if (ss) hierarchy.get(suffix).add(ss);
                    });
                }

                // DataProperty entries declared directly on this class
                cls.querySelectorAll("DataProperty").forEach(dp => {
                    const propName = dp.getAttribute("name") || "";
                    const loc = propName.split(/[.\/]/).pop();
                    if (!loc) return;
                    if (!classAttrs.has(suffix)) classAttrs.set(suffix, new Set());
                    classAttrs.get(suffix).add(loc);
                });
            });
        });

        // ClassExtension — key on the baseType suffix (the class being extended),
        // not on the extension's own name, so inheritance propagation works correctly.
        doc.querySelectorAll("ClassExtension").forEach(cls => {
            const baseType = cls.getAttribute("baseType") || "";
            if (!baseType) return;
            const suffix = baseType.split(/[.\/]/).pop(); // e.g. "InlineMeasuringElement"

            cls.querySelectorAll("DataProperty").forEach(dp => {
                const propName = dp.getAttribute("name") || "";
                const loc = propName.split(/[.\/]/).pop();
                if (!loc) return;
                if (!classAttrs.has(suffix)) classAttrs.set(suffix, new Set());
                classAttrs.get(suffix).add(loc);
            });
        });
    }

    // Propagate: subclass inherits all attrs from supertypes (fixpoint)
    let changed = true;
    while (changed) {
        changed = false;
        for (const [cls, supers] of hierarchy) {
            for (const sup of supers) {
                const supAttrs = classAttrs.get(sup);
                if (!supAttrs) continue;
                if (!classAttrs.has(cls)) classAttrs.set(cls, new Set());
                for (const a of supAttrs) {
                    if (!classAttrs.get(cls).has(a)) {
                        classAttrs.get(cls).add(a);
                        changed = true;
                    }
                }
            }
        }
    }

    // Invert: attrLocal → Set<classSuffix>
    for (const [cls, attrs] of classAttrs) {
        for (const attr of attrs) {
            if (!attrToTypes.has(attr)) attrToTypes.set(attr, new Set());
            attrToTypes.get(attr).add(cls);
        }
    }

    return attrToTypes; // Map<attrLocal, Set<typeSuffix>>
}

// ─── Profile Class-Model Composition Map ─────────────────────────────────────
//
// Generalises ERR-E08 (parent/child containment) the same way buildProfileAttributeMap()
// generalises ERR-E18 for attributes: builds, per document meta-model (Plant or
// Process), a full class hierarchy (base meta-model + any profile-declared
// ConcreteClass/AbstractClass/ClassExtension superTypes) together with a map of
// which CompositionProperty names each class allows and what target class
// (ClassReference type) each one requires - including inherited declarations
// and declarations added purely by a loaded profile (e.g. a DiscProfile
// ClassExtension that legitimately adds a new Components slot to a base class).
//
// Returns:
//   { hierarchy, closure, classComposition }
//     hierarchy        — Map<classSuffix, Set<directSuperSuffix>>
//     closure           — Map<classSuffix, Set<selfAndAllAncestorSuffixes>>
//     classComposition — Map<classSuffix, Map<propName, {target, lo, up}>>
//
function buildProfileCompositionMap(hierarchyPairs, propRows, profileXmlList) {
    const hierarchy = new Map();
    for (const [cls, sup] of hierarchyPairs) {
        if (!hierarchy.has(cls)) hierarchy.set(cls, new Set());
        hierarchy.get(cls).add(sup);
    }

    // classSuffix → Map<propName, {target, lo, up}>, direct (non-inherited) declarations only.
    const classComposition = new Map();
    function addDirect(cls, name, target, lo, up) {
        if (!name) return;
        if (!classComposition.has(cls)) classComposition.set(cls, new Map());
        classComposition.get(cls).set(name, { target: target || "", lo, up });
    }

    // Seed from the base meta-model's own direct CompositionProperty declarations
    // (propRows = PLANT_PROPS or PROCESS_PROPS, whichever matches the document).
    for (const [cls, , ccsv] of propRows) {
        if (!ccsv) continue;
        for (const entry of ccsv.split("|")) {
            if (!entry) continue;
            const parts = entry.split(":");
            const name = parts[0];
            const lo = parts.length > 1 && parts[1] !== "" ? parseInt(parts[1], 10) : 0;
            const up = parts.length > 2 ? (parts[2] === "" ? null : parseInt(parts[2], 10)) : null;
            const target = parts.length > 3 ? parts[3] : "";
            addDirect(cls, name, target, lo, up);
        }
    }

    const parser = new DOMParser();
    for (const profileXml of profileXmlList) {
        if (!profileXml) continue;
        const doc = parser.parseFromString(profileXml, "application/xml");
        if (doc.querySelector("parsererror")) continue;

        function readComposition(cls, keySuffix) {
            // Only direct children so nested class defs (if any) aren't picked up.
            for (const child of cls.children ? Array.from(cls.children) : []) {
                if (child.tagName !== "CompositionProperty") continue;
                const name = child.getAttribute("name") || "";
                const loc  = name.split(/[.\/]/).pop();
                if (!loc) continue;
                const lo = parseInt(child.getAttribute("lower") || "0", 10);
                const up = child.getAttribute("upper") === "1" ? 1 : null;
                const classRef = child.querySelector("ClassReference") ||
                    Array.from(child.getElementsByTagName ? child.getElementsByTagName("ClassReference") : []).find(() => true);
                const targetRaw = classRef ? (classRef.getAttribute("type") || "") : "";
                const target = targetRaw.split(/[.\/]/).pop();
                addDirect(keySuffix, loc, target, lo, up);
            }
        }

        // ConcreteClass / AbstractClass — profile-declared classes and their own hierarchy edges.
        ["ConcreteClass", "AbstractClass"].forEach(tag => {
            Array.from(doc.getElementsByTagName(tag)).forEach(cls => {
                const rawName = cls.getAttribute("name") || "";
                if (!rawName) return;
                const suffix = rawName.split(/[.\/]/).pop();
                const supers = (cls.getAttribute("superTypes") || "").trim();
                if (supers) {
                    if (!hierarchy.has(suffix)) hierarchy.set(suffix, new Set());
                    supers.split(/\s+/).forEach(s => {
                        const ss = s.split(/[.\/]/).pop();
                        if (ss) hierarchy.get(suffix).add(ss);
                    });
                }
                readComposition(cls, suffix);
            });
        });

        // ClassExtension — key on the baseType suffix (the class being extended),
        // so a new Components slot legitimately propagates to that class and its subclasses.
        Array.from(doc.getElementsByTagName("ClassExtension")).forEach(cls => {
            const baseType = cls.getAttribute("baseType") || "";
            if (!baseType) return;
            const suffix = baseType.split(/[.\/]/).pop();
            readComposition(cls, suffix);
        });
    }

    // Fixpoint: propagate parent composition entries to subclasses (child's own
    // declaration for the same property name takes precedence over inherited one).
    let changed = true;
    while (changed) {
        changed = false;
        for (const [cls, supers] of hierarchy) {
            if (!classComposition.has(cls)) classComposition.set(cls, new Map());
            const entry = classComposition.get(cls);
            for (const sup of supers) {
                const supEntry = classComposition.get(sup);
                if (!supEntry) continue;
                for (const [name, info] of supEntry) {
                    if (!entry.has(name)) {
                        entry.set(name, info);
                        changed = true;
                    }
                }
            }
        }
    }

    // Ancestor closure (self + all transitive supertypes), used to check whether
    // a child object's type satisfies a composition property's required target type.
    const closure = new Map();
    function ancestorsOf(cls) {
        if (!closure.has(cls)) closure.set(cls, new Set([cls]));
        return closure.get(cls);
    }
    changed = true;
    while (changed) {
        changed = false;
        for (const [cls, supers] of hierarchy) {
            const set = ancestorsOf(cls);
            for (const sup of supers) {
                if (!set.has(sup)) { set.add(sup); changed = true; }
                for (const a of ancestorsOf(sup)) {
                    if (!set.has(a)) { set.add(a); changed = true; }
                }
            }
        }
    }

    return { hierarchy, closure, classComposition };
}

// Is `childSuffix` the same type as, or a (transitive) subtype of, `targetSuffix`?
function isSubtypeOrSelf(childSuffix, targetSuffix, closure) {
    if (!childSuffix || !targetSuffix) return true; // insufficient info — don't flag
    if (childSuffix === targetSuffix) return true;
    const anc = closure.get(childSuffix);
    if (!anc) return true; // unknown class — handled elsewhere, don't double-flag here
    return anc.has(targetSuffix);
}

// ─── Attribute Constraint Validation (ERR-E18, ERR-E19) ─────────────────────
//
// ERR-E18: A Data property appears on an element whose class does not allow it
//          according to any loaded profile's PropertyConstraint definitions.
//          Only fires for properties that ARE constrained somewhere in a profile
//          (to avoid false positives on standard DEXPI properties with no explicit
//          constraint).
//
// ERR-E19: A Data property appears more times than the upper cardinality allows
//          on a given element type, per the profile PropertyConstraint.

export function runAttributeConstraintValidation(flatTree, allConstraints, severityConfig, profileAttrMap = new Map()) {
    const issues = [];
    if (!allConstraints || allConstraints.length === 0) return issues;

    // Normalise a property string to its local name for loose matching.
    // "DiscProfile/HeatTracingType" → "HeatTracingType"
    // "Plant.Piping.HeatTracingType" → "HeatTracingType"
    const localName = p => p.split("/").pop().split(".").pop();

    // Build lookup: localName(property) → [{ constrainedType, upper, profileName, property }]
    const byLocal = new Map();
    for (const c of allConstraints) {
        const loc = localName(c.property);
        if (!byLocal.has(loc)) byLocal.set(loc, []);
        byLocal.get(loc).push(c);
    }

    // Does a node type match a constrainedType?
    // Supports: exact match, slash→dot normalisation, or bare suffix match.
    function typeMatches(nodeType, constrainedType) {
        if (!nodeType || !constrainedType) return false;
        if (nodeType === constrainedType) return true;
        // Normalise separators: "Plant/Piping.Pipe" ↔ "Plant.Piping.Pipe"
        const norm = s => s.replace("/", ".");
        if (norm(nodeType) === norm(constrainedType)) return true;
        // Suffix match: catches "Pipe" matching "Plant.Piping.Pipe"
        const nSuffix = nodeType.split(/[./]/).pop();
        const cSuffix = constrainedType.split(/[./]/).pop();
        return nSuffix === cSuffix;
    }

    for (const node of flatTree) {
        if (!node.type || !node.data || node.data.length === 0) continue;

        // Count occurrences of each property on this node
        const propCounts = new Map();
        for (const d of node.data) {
            const p = d.property;
            if (p) propCounts.set(p, (propCounts.get(p) || 0) + 1);
        }

        for (const [prop, count] of propCounts) {
            const loc = localName(prop);
            const entries = byLocal.get(loc);
            if (!entries || entries.length === 0) continue; // not constrained by any profile

            // Constraints that match this node's type
            const forType = entries.filter(c => typeMatches(node.type, c.constrainedType));
            const loc2 = node.objectId ? `//*[@id='${node.objectId}']` : `(type: ${node.type})`;

            if (forType.length === 0) {
                // ERR-E18: property is profile-constrained but not for this element type.
                // Before raising, check if the class model (DataProperty declarations on
                // ConcreteClass / ClassExtension / AbstractClass) grants the attribute to
                // this element's type via direct declaration or inheritance.
                const nodeSuffix = (node.type || "").split(/[.\/]/).pop();
                const classModelAllows =
                    profileAttrMap.has(loc) && profileAttrMap.get(loc).has(nodeSuffix);
                if (!classModelAllows) {
                    const profileName = entries[0].profileName;
                    const allowed = [...new Set(entries.map(e => e.constrainedType))].join(", ");
                    const sev = resolveSeverity("ERR-E18", severityConfig);
                    issues.push({
                        objectId: node.objectId || "(no id)",
                        objectType: node.type,
                        ruleId: "ERR-E18",
                        severity: sev.level, score: sev.score,
                        description: `Attribute '${prop}' is not defined for class '${node.type}' (profile: '${profileName}'). ` +
                                     `It is only allowed on: ${allowed}.`,
                        location: loc2,
                        profileSource: profileName,
                        suggestedCorrection: `Remove attribute '${prop}' from this element, or verify the element class is correct.`
                    });
                }
            } else {
                // ERR-E19: property present more times than upper cardinality allows
                const upper = Math.min(...forType.map(c => c.upper));
                if (isFinite(upper) && count > upper) {
                    const mc = forType[0];
                    const sev = resolveSeverity("ERR-E19", severityConfig);
                    issues.push({
                        objectId: node.objectId || "(no id)",
                        objectType: node.type,
                        ruleId: "ERR-E19",
                        severity: sev.level, score: sev.score,
                        description: `Attribute '${prop}' appears ${count} time(s) on '${node.type}' ` +
                                     `but the maximum allowed is ${upper} (profile: '${mc.profileName}').`,
                        location: loc2,
                        profileSource: mc.profileName,
                        suggestedCorrection: `Reduce '${prop}' occurrences to at most ${upper} on this element.`
                    });
                }
            }
        }
    }

    return issues;
}

// ─── Profile Parsing ──────────────────────────────────────────────────────────

export function parseProfileConstraints(profileXml, profileName) {
    if (!profileXml) return [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(profileXml, "application/xml");
    if (doc.querySelector("parsererror")) return [];

    const constraints = [];
    doc.querySelectorAll('Object[type="Profile/PropertyConstraint"]').forEach(obj => {
        const constrainedType = getDataText(obj, "ConstrainedType");
        const lowerStr = getDataText(obj, "Lower");
        const upperStr = getDataText(obj, "Upper");
        const property  = getDataText(obj, "Property");
        const typeHint  = getDataText(obj, "Type");
        if (!constrainedType || !property) return;
        const lower = lowerStr !== null ? parseInt(lowerStr, 10) : 0;
        const upper = upperStr !== null ? parseInt(upperStr, 10) : Infinity;
        constraints.push({ constrainedType, lower, upper, property, typeHint, profileName });
    });

    return constraints;
}

// ─── Profile Content Validation (PRF-E01, PRF-E02) ───────────────────────────

// DiscProfile/ covers types defined in the DISC profile model itself
// (e.g. DiscProfile/InformationModel.LogicalBreak, TieInPoint, …)
const KNOWN_PLANT_MM_PREFIXES = ["Core/","Plant/","Profile/","DiscProfile/"];

export function validateProfileContent(profileXml, profileName, severityConfig) {
    const issues = [];
    if (!profileXml) return issues;
    const parser = new DOMParser();
    const doc = parser.parseFromString(profileXml, "application/xml");
    if (doc.querySelector("parsererror")) {
        const sev = resolveSeverity("PRF-E01", severityConfig);
        issues.push({
            objectId: "(profile)", objectType: profileName, ruleId: "PRF-E01",
            severity: sev.level, score: sev.score,
            description: `Profile '${profileName}' cannot be parsed as valid XML.`,
            location: "/", profileSource: profileName,
            suggestedCorrection: "Fix XML syntax errors in the profile file."
        });
        return issues;
    }

    doc.querySelectorAll('Object[type="Profile/PropertyConstraint"]').forEach(obj => {
        // PRF-E01: invalid Lower/Upper (inline attribute format)
        const lowerAttr = obj.getAttribute("Lower");
        const upperAttr = obj.getAttribute("Upper");
        [[lowerAttr,"Lower"],[upperAttr,"Upper"]].forEach(([val, name]) => {
            if (val !== null && !/^-?\d+$/.test(val.trim())) {
                const sev = resolveSeverity("PRF-E01", severityConfig);
                issues.push({
                    objectId: "(profile constraint)", objectType: "Profile/PropertyConstraint", ruleId: "PRF-E01",
                    severity: sev.level, score: sev.score,
                    description: `Profile '${profileName}': PropertyConstraint has invalid ${name}='${val}' (must be integer).`,
                    location: "//Object[@type='Profile/PropertyConstraint']", profileSource: profileName,
                    suggestedCorrection: `Set ${name} to a valid integer value (e.g. 0 or 1).`
                });
            }
        });

        // PRF-E01: invalid Lower/Upper (Data child format)
        ["Lower","Upper"].forEach(propName => {
            const dataEl = [...(obj.querySelectorAll("Data")||[])].find(d => d.getAttribute("property") === propName);
            if (!dataEl) return;
            const strEl = dataEl.querySelector("String");
            if (strEl && !dataEl.querySelector("Integer")) {
                const val = strEl.textContent?.trim() || "";
                if (!/^-?\d+$/.test(val)) {
                    const sev = resolveSeverity("PRF-E01", severityConfig);
                    issues.push({
                        objectId: "(profile constraint)", objectType: "Profile/PropertyConstraint", ruleId: "PRF-E01",
                        severity: sev.level, score: sev.score,
                        description: `Profile '${profileName}': PropertyConstraint ${propName}='${val}' is not a valid integer.`,
                        location: "//Object[@type='Profile/PropertyConstraint']", profileSource: profileName,
                        suggestedCorrection: `Use an <Integer> element with a valid integer value for ${propName}.`
                    });
                }
            }
        });

        // PRF-E02: ConstrainedType not from a known namespace
        const ctAttr = obj.getAttribute("ConstrainedType");
        const ctDataEl = [...(obj.querySelectorAll("Data")||[])].find(d => d.getAttribute("property") === "ConstrainedType");
        const ctVal = ctAttr || ctDataEl?.querySelector("String")?.textContent?.trim() || null;
        if (ctVal && !KNOWN_PLANT_MM_PREFIXES.some(p => ctVal.startsWith(p))) {
            const sev = resolveSeverity("PRF-E02", severityConfig);
            issues.push({
                objectId: "(profile constraint)", objectType: "Profile/PropertyConstraint", ruleId: "PRF-E02",
                severity: sev.level, score: sev.score,
                description: `Profile '${profileName}': ConstrainedType='${ctVal}' is not from a known DEXPI 2.0 namespace (Core/, Plant/, Profile/, DiscProfile/).`,
                location: "//Object[@type='Profile/PropertyConstraint']", profileSource: profileName,
                suggestedCorrection: "ConstrainedType must reference a class in the DEXPI 2.0 Plant Meta Model or DISC profile model (DiscProfile/)."
            });
        }
    });
    return issues;
}


// ─── Profile Precedence Merge (PRF-005, PRF-006, PRF-007) ────────────────────

export function mergeProfileConstraints(profileSets) {
    const map = new Map();
    const overrideLog = [];

    profileSets.forEach(({ name, constraints }) => {
        constraints.forEach(c => {
            const key = `${c.constrainedType}::${c.property}`;
            if (map.has(key)) {
                const prev = map.get(key);
                overrideLog.push({
                    key, property: c.property, constrainedType: c.constrainedType,
                    overriddenProfile: prev.profileName, overridingProfile: name,
                });
            }
            map.set(key, { ...c, profileName: name });
        });
    });

    return { mergedConstraints: Array.from(map.values()), overrideLog };
}

// ─── Profile Validation (PRF-001, PRF-002) ───────────────────────────────────

export function runProfileValidation(flatTree, mergedConstraints, overrideLog, severityConfig) {
    const issues = [];

    overrideLog.forEach(entry => {
        issues.push({
            objectId: "(rule override)", objectType: "", ruleId: "PRF-007",
            severity: "Info", score: 1,
            description: `Rule for '${entry.property}' on type '${entry.constrainedType}' from profile '${entry.overriddenProfile}' was overridden by profile '${entry.overridingProfile}'.`,
            location: "(profile metadata)", profileSource: entry.overridingProfile,
            suggestedCorrection: "Review profile load order if this override is unintended."
        });
    });

    mergedConstraints.forEach(c => {
        const { constrainedType, lower, property, profileName } = c;

        const matching = flatTree.filter(node => {
            if (!node.type) return false;
            if (node.type === constrainedType) return true;
            const typeSuffix = node.type.split(".").pop();
            const constraintSuffix = constrainedType.split(".").pop();
            return typeSuffix === constraintSuffix && typeSuffix !== constrainedType;
        });

        if (lower >= 1) {
            matching.forEach(node => {
                // shortProp: local name after the last "." or "/" separator.
                // e.g. "Core/Diagram.MetaData.DrawingNumber"                          → "DrawingNumber"
                //      "DiscProfile/InformationModel.NozzleExtension.IsVirtualMount"  → "IsVirtualMount"
                const shortProp = property.split(/[.\/]/).pop() || property;
                // dpLocal: same normalisation applied to the actual stored property name.
                // DEXPI files use several forms:
                //   "DrawingNumber"                            (bare)
                //   "DiscProfile/ProcessInstrumentationFunctionLocation"  (slash-prefixed)
                //   "Core/Diagram.MetaData.DrawingNumber"     (fully-qualified)
                const dpLocal = dp => (dp || "").split(/[.\/]/).pop();
                const hasProperty = node.data.some(d => {
                    const dp = d.property || "";
                    return dp === property            // exact fully-qualified match
                        || dpLocal(dp) === shortProp; // local-name match (handles bare,
                                                      // slash-prefixed, and dotted forms)
                });
                if (!hasProperty) {
                    const ruleId = `PRF-${profileName}-${shortProp}`;
                    const sev = resolveSeverity(ruleId, severityConfig) ||
                                resolveSeverity("PRF", severityConfig);
                    const loc = node.objectId ? `//*[@id='${node.objectId}']` : `(type: ${node.type})`;
                    issues.push({
                        objectId: node.objectId || "(no id)", objectType: node.type, ruleId,
                        severity: sev.level, score: sev.score,
                        description: `Missing required property '${shortProp}' on '${node.type}' (required by profile '${profileName}').`,
                        location: loc, profileSource: profileName,
                        suggestedCorrection: `Add Data property '${property}' to this object.`
                    });
                }
            });
        }
    });

    return issues;
}

// ─── Profile Symbol Rules (PRF-E04, PRF-E05) ─────────────────────────────────

/**
 * Parse a profile XML and extract:
 *   symbolUsage : Map<symbolName, string[]>    – normalised DEXPI type strings allowed for the symbol
 *   symbolNodes : Map<symbolName, {x,y,dir}[]> – profile connection points in symbol-local coords
 *   labelTemplateAttrs : Map<symbolName, Set<attrName>> – bare AttributeName placeholders
 *     (e.g. "ObjectDisplayName") referenced across ALL of the symbol's variants' own
 *     Profile/LabelTemplate.Text values — see PRF-E06 below.
 */
// Matches an optional "RoleName:" role-path prefix followed by a bare
// "<AttrName>" placeholder inside a Profile/LabelTemplate.Text value — same
// convention as dexpiParser.js's resolveProfileLabelFallback() placeholder
// regex. Only the bare attribute name (capture group 1) is kept; the
// role-path prefix (if any) names a related object's class, not part of the
// attribute name itself.
const LABEL_TEMPLATE_PLACEHOLDER_RE = /(?:[A-Za-z][A-Za-z0-9_]*:)?<([^<>]+)>/g;

function parseProfileSymbols(profileXml) {
    const symbolUsage = new Map();
    const symbolNodes = new Map();
    // Auxiliary NodePositions (Type = Profile/NodePositionType.Auxiliary) represent
    // actuator/valve-operator connection points. A PipingNodePosition in the drawing
    // must NOT align with these — pipes cannot attach to actuator ports.
    const auxiliaryNodes = new Map();
    const labelTemplateAttrs = new Map();
    const parser = new DOMParser();
    const doc = parser.parseFromString(profileXml, "application/xml");
    if (doc.querySelector("parsererror")) return { symbolUsage, symbolNodes, auxiliaryNodes, labelTemplateAttrs, typeToSymbols: new Map() };

    doc.querySelectorAll('Object[type="Profile/Symbol"]').forEach(sym => {
        const name = sym.getAttribute("name");
        if (!name) return;

        // MetaData/usage – direct Data children only (not inside variant geometry)
        const usages = [];
        for (const child of sym.children) {
            if (child.tagName === "Data" && child.getAttribute("property") === "MetaData/usage") {
                const str = child.querySelector("String");
                if (str) usages.push(str.textContent.trim());
            }
        }
        if (usages.length) symbolUsage.set(name, usages);

        // Also build reverse map: non-decorator usage type → list of allowed symbol names
        // (used later to determine whether the profile defines ANY symbol for a given type)

        // NodePositions are inside Profile/SymbolVariant children
        const nodes = [];
        const auxNodes = [];
        const attrs = new Set();
        sym.querySelectorAll('Object[type="Profile/SymbolVariant"]').forEach(variant => {
            const ltComp = Array.from(variant.children).find(
                c => c.tagName === "Components" && c.getAttribute("property") === "LabelTemplates"
            );
            if (ltComp) {
                Array.from(ltComp.children).filter(c => c.tagName === "Object").forEach(lt => {
                    const textEl = Array.from(lt.children).find(
                        c => c.tagName === "Data" && c.getAttribute("property") === "Text"
                    );
                    const str = textEl?.querySelector("String");
                    const text = str ? str.textContent : "";
                    if (!text) return;
                    LABEL_TEMPLATE_PLACEHOLDER_RE.lastIndex = 0;
                    let m;
                    while ((m = LABEL_TEMPLATE_PLACEHOLDER_RE.exec(text)) !== null) attrs.add(m[1]);
                });
            }
            variant.querySelectorAll('Object[type="Profile/NodePosition"]').forEach(np => {
                let x = null, y = null, dir = null, npType = null;
                for (const data of np.children) {
                    const prop = data.getAttribute("property");
                    if (prop === "Position") {
                        const agv = data.querySelector("AggregatedDataValue");
                        if (agv) {
                            for (const d of agv.children) {
                                const v = d.querySelector("Double") || d.querySelector("Integer");
                                if (d.getAttribute("property") === "X" && v) x = parseFloat(v.textContent);
                                if (d.getAttribute("property") === "Y" && v) y = parseFloat(v.textContent);
                            }
                        }
                    }
                    if (prop === "Directions") {
                        const v = data.querySelector("Double");
                        if (v) dir = parseFloat(v.textContent);
                    }
                    if (prop === "Type") {
                        const dr = data.querySelector("DataReference");
                        if (dr) npType = dr.getAttribute("data") || null;
                    }
                }
                if (x === null || y === null) return;
                const isPiping    = npType === null || npType === "Profile/NodePositionType.Piping";
                const isAuxiliary = npType === "Profile/NodePositionType.Auxiliary";
                // Piping-type NodePositions: the legal pipe-connection points.
                if (isPiping)    nodes.push({ x, y, dir: dir ?? 0 });
                // Auxiliary NodePositions: actuator/operator ports — piping must NOT connect here.
                // Store separately so the validator can issue a targeted PRF-E05 sub-message.
                if (isAuxiliary) auxNodes.push({ x, y, dir: dir ?? 0 });
                // Label / Instrumentation types are intentionally skipped — instrument
                // balloon nodes can be spatially far from the symbol body, making
                // distance checks meaningless for them.
            });
        });
        if (nodes.length)    symbolNodes.set(name, nodes);
        if (auxNodes.length) auxiliaryNodes.set(name, auxNodes);
        if (attrs.size)      labelTemplateAttrs.set(name, attrs);
    });

    // Build reverse map: dexpi-type → Set<symbolName> (non-decorator symbols only)
    const typeToSymbols = new Map();
    symbolUsage.forEach((usages, symName) => {
        if (usages.every(u => u.startsWith("Core.Diagram."))) return; // skip decorators
        usages.forEach(u => {
            if (!typeToSymbols.has(u)) typeToSymbols.set(u, new Set());
            typeToSymbols.get(u).add(symName);
        });
    });

    return { symbolUsage, symbolNodes, auxiliaryNodes, labelTemplateAttrs, typeToSymbols };
}

/**
 * Validate symbol usage rules against a loaded profile:
 *
 *   PRF-E04 – a Profile/SymbolUsage in the drawing uses a symbol that is NOT
 *             listed as allowed for the model object's DEXPI type in the profile.
 *
 *   PRF-E05 – a NodePosition in the drawing (connection point for a pipe or
 *             instrument) does not align with any profile-defined connection
 *             point of the placed symbol, within CONNECTION_MARGIN_X/Y_PCT.
 */
// ─── Profile Class Hierarchy (for PRF-E04 Sub-rule B) ────────────────────────
//
// Extracts classSuffix → superSuffix pairs from a profile's own ConcreteClass /
// AbstractClass declarations (their `superTypes` attribute), e.g. the DISC
// profile's "ShellAndFixedTubeHeatExchanger" ConcreteClass declares
// superTypes="Plant/ProcessEquipment.HeatExchanger", yielding the pair
// ["ShellAndFixedTubeHeatExchanger", "HeatExchanger"]. Cached per profile XML
// string since validateSymbolRules() may be invoked once per loaded profile.
const _profileClassPairsCache = new Map();
function extractProfileClassPairs(profileXml) {
    if (_profileClassPairsCache.has(profileXml)) return _profileClassPairsCache.get(profileXml);
    const pairs = [];
    if (profileXml) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(profileXml, "application/xml");
        if (!doc.querySelector("parsererror")) {
            ["ConcreteClass", "AbstractClass"].forEach(tag => {
                doc.querySelectorAll(tag).forEach(cls => {
                    const rawName = cls.getAttribute("name") || "";
                    if (!rawName) return;
                    const suffix = rawName.split(/[.\/]/).pop();
                    const supers = (cls.getAttribute("superTypes") || "").trim();
                    if (!supers) return;
                    supers.split(/\s+/).forEach(s => {
                        const ss = s.split(/[.\/]/).pop();
                        if (ss) pairs.push([suffix, ss]);
                    });
                });
            });
        }
    }
    _profileClassPairsCache.set(profileXml, pairs);
    return pairs;
}

// Combines the base Plant/Process meta-model hierarchy with every loaded
// profile's own class hierarchy (profile-redeclared/extended subclasses such
// as DiscProfile's "ShellAndFixedTubeHeatExchanger" or "ProcessSafetyFunction")
// into a single classSuffix → Set<superSuffix> map.
function buildProfileClassHierarchy(profileXmlList, baseHierarchyPairs) {
    const hierarchy = new Map();
    for (const [cls, sup] of baseHierarchyPairs) {
        if (!hierarchy.has(cls)) hierarchy.set(cls, new Set());
        hierarchy.get(cls).add(sup);
    }
    for (const profileXml of profileXmlList) {
        for (const [cls, sup] of extractProfileClassPairs(profileXml)) {
            if (!hierarchy.has(cls)) hierarchy.set(cls, new Set());
            hierarchy.get(cls).add(sup);
        }
    }
    return hierarchy;
}

// BFS up the class hierarchy: is `childSuffix` the same as, or a (transitive)
// subclass of, `ancestorSuffix`?
function isDescendantOrSelf(hierarchy, childSuffix, ancestorSuffix) {
    if (childSuffix === ancestorSuffix) return true;
    const seen = new Set([childSuffix]);
    const queue = [childSuffix];
    while (queue.length) {
        const cur = queue.shift();
        const supers = hierarchy.get(cur);
        if (!supers) continue;
        for (const s of supers) {
            if (s === ancestorSuffix) return true;
            if (!seen.has(s)) { seen.add(s); queue.push(s); }
        }
    }
    return false;
}

export function validateSymbolRules(mainXml, profileXml, profileName, severityConfig, allProfileXmlStrings = []) {
    const issues = [];
    if (!mainXml || !profileXml) return issues;

    const { symbolUsage, symbolNodes, auxiliaryNodes, labelTemplateAttrs, typeToSymbols } = parseProfileSymbols(profileXml);

    // Combined symbol set across all loaded profiles — used by PRF-E04 to avoid
    // false positives when a SymbolUsage references a symbol defined in a different
    // profile in the stack (e.g. "DiscProfile/PP003A" referenced while validating
    // "DiscProfile_FL0", but PP003A is declared in the base DiscProfile model).
    const allKnownSymbols = new Set(symbolUsage.keys());
    for (const xml of allProfileXmlStrings) {
        if (!xml || xml === profileXml) continue;
        const { symbolUsage: otherSymbols } = parseProfileSymbols(xml); // auxiliaryNodes not needed for cross-profile symbol lookup
        for (const name of otherSymbols.keys()) allKnownSymbols.add(name);
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(mainXml, "application/xml");
    if (doc.querySelector("parsererror")) return issues;

    // Combined class hierarchy (base Plant/Process meta-model + every loaded
    // profile's own ConcreteClass/AbstractClass superTypes) — used by PRF-E04
    // Sub-rule B below to check whether a placed symbol's declared usage
    // type(s) and the represented object's actual type are related by true
    // subclass/superclass inheritance, rather than a coarse "same top-level
    // category" guess.
    const modelName = detectMetaModel(doc);
    const baseHierarchyPairs = modelName === "Process" ? PROCESS_HIERARCHY : PLANT_HIERARCHY;
    const classHierarchy = buildProfileClassHierarchy([profileXml, ...allProfileXmlStrings], baseHierarchyPairs);

    // Build id → type map for all model objects
    const objectTypes = new Map();
    doc.querySelectorAll("Object[id]").forEach(o =>
        objectTypes.set(o.getAttribute("id"), o.getAttribute("type") || "")
    );

    // Build owning-object id → [{attrName, el}, ...] for every
    // Core/Diagram.AttributeRepresentation in the drawing — used by PRF-E06
    // below to cross-check each represented object's own TextTemplate
    // AttributeName(s) against the placed symbol's own Profile/LabelTemplate
    // placeholders (labelTemplateAttrs, from parseProfileSymbols above).
    const attrRepsByTargetId = new Map();
    doc.querySelectorAll('Object[type="Core/Diagram.AttributeRepresentation"]').forEach(attrRep => {
        const attrNameEl = Array.from(attrRep.children).find(
            c => c.tagName === "Data" && c.getAttribute("property") === "AttributeName"
        );
        const attrName = attrNameEl?.querySelector("String")?.textContent?.trim();
        if (!attrName) return;
        const objRefEl = Array.from(attrRep.children).find(
            c => c.tagName === "References" && c.getAttribute("property") === "Object"
        );
        const rawTarget = (objRefEl?.getAttribute("objects") || "").split(/\s+/).filter(Boolean)[0];
        const targetId = rawTarget ? rawTarget.replace(/^#/, "") : null;
        if (!targetId) return;
        if (!attrRepsByTargetId.has(targetId)) attrRepsByTargetId.set(targetId, []);
        attrRepsByTargetId.get(targetId).push(attrName);
    });

    // Compute drawing bounding box from all Position elements
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    doc.querySelectorAll('Data[property="Position"] > AggregatedDataValue').forEach(agv => {
        for (const d of agv.children) {
            const v = d.querySelector("Double");
            if (!v) continue;
            const val = parseFloat(v.textContent);
            if (isNaN(val)) continue;
            if (d.getAttribute("property") === "X") { minX = Math.min(minX, val); maxX = Math.max(maxX, val); }
            if (d.getAttribute("property") === "Y") { minY = Math.min(minY, val); maxY = Math.max(maxY, val); }
        }
    });
    const drawW  = (isFinite(maxX) && isFinite(minX)) ? Math.max(maxX - minX, 1) : 1000;
    const drawH  = (isFinite(maxY) && isFinite(minY)) ? Math.max(maxY - minY, 1) : 1000;
    const marginX = drawW * CONNECTION_MARGIN_X_PCT;
    const marginY = drawH * CONNECTION_MARGIN_Y_PCT;

    // Helper: read x,y from a Data[property="Position"] child of an element
    const getPos = (el) => {
        let px = null, py = null;
        for (const data of el.children) {
            if (data.tagName !== "Data" || data.getAttribute("property") !== "Position") continue;
            const agv = data.querySelector("AggregatedDataValue");
            if (!agv) continue;
            for (const d of agv.children) {
                const v = d.querySelector("Double");
                if (!v) continue;
                if (d.getAttribute("property") === "X") px = parseFloat(v.textContent);
                if (d.getAttribute("property") === "Y") py = parseFloat(v.textContent);
            }
        }
        return { px, py };
    };

    // Helper: walk up the DOM from `el` and return the first Object that has a
    // References[@property="Represents"] child, plus the referenced id.
    // This handles profiles where the Represents ref is on an ancestor RepresentationGroup
    // rather than the immediate parent (e.g. multi-level Aibel symbol groups).
    function findRepresentsAncestor(el) {
        let node = el.parentElement;
        while (node) {
            if (node.tagName === "Object") {
                for (const ch of node.children) {
                    if (ch.tagName === "References" && ch.getAttribute("property") === "Represents") {
                        const raw = (ch.getAttribute("objects") || "").replace(/^#/, "");
                        if (raw) return { representsId: raw, repGroupEl: node };
                    }
                }
            }
            node = node.parentElement;
        }
        return { representsId: null, repGroupEl: null };
    }

    // A single RepresentationGroup can legitimately contain more than one
    // Profile/SymbolUsage sibling (e.g. a composite symbol built from several
    // sub-symbols, or a duplicated placement in the source data) that all
    // resolve to the same represented model object (representsId) via
    // findRepresentsAncestor(). PRF-E04 Sub-rule A/B and PRF-E06 below check
    // properties of the (representsId, symName) pair itself — not of the
    // individual SymbolUsage placement — so re-running them once per sibling
    // re-emits byte-identical issues. This set tracks which (rule, key) pairs
    // have already been fully checked so each is only evaluated once, while
    // still reporting once per genuinely distinct underlying problem (e.g.
    // three separate broken AttributeRepresentation Fragments on the same
    // object still produce three PRF-E06 issues — just not multiplied by the
    // number of sibling SymbolUsages that happen to share that symbol).
    const checkedOnce = new Set();

    // Inspect every Profile/SymbolUsage in the drawing
    doc.querySelectorAll('Object[type="Profile/SymbolUsage"]').forEach(su => {
        // Symbol name: "DiscProfile/PE037A" → strip prefix → "PE037A"
        // Use direct child iteration (avoids :scope quirks in XML-mode DOMParser)
        const symRefEl = Array.from(su.children).find(
            c => c.tagName === "References" && c.getAttribute("property") === "Symbol"
        );
        if (!symRefEl) return;
        const symRefObjects = symRefEl.getAttribute("objects") || "";
        const symName = symRefObjects.split("/").pop().replace(/^#/, "");

        // ── PRF-E04 Sub-rule A: symbol must exist in the profile ─────────────
        // Checked here — before any RepresentationGroup navigation — so that
        // deeply-nested or non-standard group structures never bypass it.
        if (symName && !allKnownSymbols.has(symName)) {
            // Walk up to find context (best-effort; may be null for orphaned usages)
            const { representsId: qId } = findRepresentsAncestor(su);
            const dedupKeyA = `E04A::${qId || "(unknown)"}::${symName}`;
            if (checkedOnce.has(dedupKeyA)) return;
            checkedOnce.add(dedupKeyA);
            const qType = qId ? (objectTypes.get(qId) || "") : "";
            const sev = resolveSeverity("PRF-E04", severityConfig);
            issues.push({
                objectId:    qId || "(unknown)",
                objectType:  qType,
                ruleId:      "PRF-E04",
                severity:    sev.level,
                score:       sev.score,
                description: `SymbolUsage references symbol '${symName}' (${symRefObjects}) which is not defined in profile '${profileName}'. Every SymbolUsage Symbol reference must resolve to a Profile/Symbol declared in the active profile.`,
                location:    qId ? `//*[@id='${qId}']` : "/",
                profileSource: profileName,
                suggestedCorrection: `Use a symbol name declared as a Profile/Symbol in '${profileName}', or add the missing symbol definition to the profile.`,
            });
            return; // Can't meaningfully check PRF-E05 without the symbol definition
        }

        // Read placement parameters
        let posX = 0, posY = 0, rotation = 0, scaleX = 1, scaleY = 1, isMirrored = false;
        const { px, py } = getPos(su);
        if (px !== null) posX = px;
        if (py !== null) posY = py;
        for (const data of su.children) {
            const prop = data.getAttribute("property");
            if (prop === "Rotation")   { const v = data.querySelector("Double");  if (v) rotation   = parseFloat(v.textContent); }
            if (prop === "ScaleX")     { const v = data.querySelector("Double");  if (v) scaleX     = parseFloat(v.textContent); }
            if (prop === "ScaleY")     { const v = data.querySelector("Double");  if (v) scaleY     = parseFloat(v.textContent); }
            if (prop === "IsMirrored") { const v = data.querySelector("Boolean"); if (v) isMirrored = v.textContent.trim().toLowerCase() === "true"; }
        }

        // Navigate upward: SymbolUsage → Components[Elements] → Static → Components[Groups] → RepresentationGroup
        const elementsComp = su.parentElement;            // Components property="Elements"
        const staticEl     = elementsComp?.parentElement; // Object type="Core/Diagram.Static"
        const groupsComp   = staticEl?.parentElement;     // Components property="Groups"
        const topRepGroup  = groupsComp?.parentElement;   // Object type="Core/Diagram.RepresentationGroup"
        if (!topRepGroup || topRepGroup.getAttribute("type") !== "Core/Diagram.RepresentationGroup") return;

        // Determine which model object this RepresentationGroup represents.
        // Walk upward through the DOM — some profiles nest Static inside sub-RepGroups
        // whose ancestor (not immediate parent) carries the Represents reference.
        const { representsId } = findRepresentsAncestor(staticEl);
        const modelType     = representsId ? (objectTypes.get(representsId) || "") : "";
        const normModelType = modelType.replace(/\//g, ".");

        // ── PRF-E04 Sub-rule B: symbol's allowed types must match the model type ─
        const dedupKeyB = `E04B::${representsId || "(unknown)"}::${symName}`;
        const alreadyCheckedB = checkedOnce.has(dedupKeyB);
        checkedOnce.add(dedupKeyB);
        const allowedTypes = symbolUsage.get(symName);
        if (!alreadyCheckedB && modelType && allowedTypes && allowedTypes.length > 0) {
            // Only consider usages that are valid DEXPI type strings (dot-separated namespaced
            // types). File-path usages (e.g. "\Piping\Valves\...sym") from non-standard profiles
            // are not comparable to DEXPI type strings and are skipped.
            const dexpiUsages = allowedTypes.filter(at =>
                /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z]/.test(at)
            );

            // Skip decorator / label symbols (usage entirely Core.Diagram.*).
            const isDecorator = dexpiUsages.length > 0 && dexpiUsages.every(at => at.startsWith("Core.Diagram."));
            if (!isDecorator && dexpiUsages.length > 0) {
                const modelSuffix = normModelType.split(".").pop();
                // Allowed when: (a) an exact type-string match, or (b) the model
                // type and one of the symbol's declared usage types are related
                // by true class-hierarchy inheritance in either direction. This
                // covers both directions of legitimate fallback — e.g. a generic
                // Nozzle object using a symbol declared only for its AccessNozzle
                // subtype, or a ProcessSafetyFunction object (which has no symbols
                // of its own) using a symbol declared for its ProcessInstrumentationFunction
                // supertype — while correctly REJECTING sibling-class swaps, such
                // as a TubularHeatExchanger-typed object using a symbol whose
                // profile usage is the unrelated sibling subclass
                // ShellAndFixedTubeHeatExchanger (both are distinct subclasses of
                // HeatExchanger, so neither is an ancestor of the other).
                const isAllowed = dexpiUsages.some(at => {
                    if (at === normModelType) return true;
                    const atSuffix = at.split(".").pop();
                    if (atSuffix === modelSuffix) return true;
                    return isDescendantOrSelf(classHierarchy, modelSuffix, atSuffix) ||
                           isDescendantOrSelf(classHierarchy, atSuffix, modelSuffix);
                });
                if (!isAllowed) {
                    const sev = resolveSeverity("PRF-E04", severityConfig);
                    const validSymbols = [...(typeToSymbols.get(normModelType) || [])].join(", ");
                    issues.push({
                        objectId:    representsId || "(unknown)",
                        objectType:  modelType,
                        ruleId:      "PRF-E04",
                        severity:    sev.level,
                        score:       sev.score,
                        description: `Symbol '${symName}' (allowed for: ${dexpiUsages.join(", ")}) is used to represent ` +
                                     `'${representsId}' of type '${modelType}'. Neither an exact match nor a subclass/` +
                                     `superclass relationship exists between '${modelSuffix}' and the symbol's permitted ` +
                                     `type(s) per the profile's class model. ` +
                                     `Symbols permitted for this type: ${validSymbols || "(none defined)"}.`,
                        location:    representsId ? `//*[@id='${representsId}']` : "/",
                        profileSource: profileName,
                        suggestedCorrection: `Replace symbol '${symName}' with one of: ${validSymbols || "a symbol permitted for '" + normModelType + "'."}, or correct the object's class type to match the symbol used.`,
                    });
                }
            }
        }

        // ── PRF-E06: TextTemplate AttributeName not offered by the placed symbol ──
        // representsId's own Core/Diagram.AttributeRepresentation Fragment(s) (if
        // any) name an AttributeName that should match one of the placeholders the
        // PLACED symbol's own Profile/LabelTemplate(s) actually define (e.g. symbol
        // 'ND0192A' only offers ObjectDisplayName, NominalDiameterRepresentation,
        // ValveDataSheet, TrimType, LockMechanism) — referencing an attribute the
        // symbol doesn't offer at all (e.g. 'ItemTag') is flagged even if that
        // attribute happens to resolve fine elsewhere (see ERR-E20, which checks
        // resolvability rather than the profile's own declared placeholder set).
        // Only checked when the symbol defines at least one LabelTemplate with a
        // placeholder at all — a symbol with none simply isn't modelled for this
        // check and shouldn't produce false positives.
        {
            const dedupKeyE06 = `E06::${representsId || "(unknown)"}::${symName}`;
            const alreadyCheckedE06 = checkedOnce.has(dedupKeyE06);
            checkedOnce.add(dedupKeyE06);
            const allowedAttrs = labelTemplateAttrs.get(symName);
            if (!alreadyCheckedE06 && allowedAttrs && allowedAttrs.size && representsId) {
                const usedAttrs = attrRepsByTargetId.get(representsId) || [];
                usedAttrs.forEach(attrName => {
                    const bare = attrName.split("/").pop();
                    if (allowedAttrs.has(attrName) || allowedAttrs.has(bare)) return;
                    const sev = resolveSeverity("PRF-E06", severityConfig);
                    issues.push({
                        objectId:    representsId,
                        objectType:  modelType,
                        ruleId:      "PRF-E06",
                        severity:    sev.level,
                        score:       sev.score,
                        description: `Invalid Text Template attribute used: AttributeName '${attrName}' referenced for '${representsId}' is not a valid attribute for symbol '${symName}', which only allows: ${[...allowedAttrs].join(", ")}.`,
                        location:    `//*[@id='${representsId}']`,
                        profileSource: profileName,
                        suggestedCorrection: `Change the AttributeName to one of: ${[...allowedAttrs].join(", ")}, or remove this Fragment.`,
                    });
                });
            }
        }

        // ── PRF-E05: NodePositions must align with profile connection points ─────
        const profileNodeList = symbolNodes.get(symName);
        const profileAuxList  = auxiliaryNodes.get(symName) || [];
        // A symbol with no piping connection points at all cannot be checked.
        if ((!profileNodeList || profileNodeList.length === 0) && profileAuxList.length === 0) return;

        // Transform both piping and auxiliary NodePositions from symbol-local to world
        // coordinates (Y-down SVG convention):
        //   world.x = posX + lx·cos − ly·sin  (unchanged)
        //   world.y = posY − lx·sin − ly·cos  (Y-axis negated relative to symbol-local)
        const rad = (rotation * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const toWorld = np => {
            let lx = np.x * scaleX;
            let ly = np.y * scaleY;
            if (isMirrored) lx = -lx;
            return { x: posX + lx * cos - ly * sin, y: posY - lx * sin - ly * cos };
        };
        // Deduplicate world-coordinate lists (multiple identical variants in the profile
        // can produce repeated entries for the same physical connection point).
        const dedupWorld = arr => {
            const seen = new Set();
            return arr.filter(w => {
                const key = `${w.x.toFixed(4)},${w.y.toFixed(4)}`;
                if (seen.has(key)) return false;
                seen.add(key); return true;
            });
        };
        const worldNodes    = dedupWorld((profileNodeList || []).map(toWorld));
        const worldAuxNodes = dedupWorld(profileAuxList.map(toWorld));

        // Check only Piping-type NodePositions in direct sub-RepresentationGroups.
        // Instrumentation and Label NodePositions are intentionally excluded: instrument
        // connection nodes (InstrumentationNodePosition) can be spatially far from the
        // instrument balloon body, making distance checks meaningless for them.
        const groupsEl = groupsComp;
        if (!groupsEl) return;
        for (const subRg of groupsEl.children) {
            if (subRg.getAttribute("type") !== "Core/Diagram.RepresentationGroup") continue;
            const npComp = Array.from(subRg.children).find(
                c => c.tagName === "Components" && c.getAttribute("property") === "NodePositions"
            );
            if (!npComp) continue;
            for (const npObj of npComp.children) {
                // Only check Piping node positions; skip Instrumentation/Label types
                const npObjType = npObj.getAttribute("type") || "";
                if (!npObjType.includes("PipingNodePosition")) continue;
                const npId = npObj.getAttribute("id") || "(no id)";
                const { px: npX, py: npY } = getPos(npObj);
                if (npX === null || npY === null) continue;

                const withinMargin = (wn) => Math.abs(npX - wn.x) <= marginX && Math.abs(npY - wn.y) <= marginY;
                const nearPiping   = worldNodes.some(withinMargin);
                if (nearPiping) continue; // ✓ correctly connected to a piping port

                const nearAuxiliary = worldAuxNodes.some(withinMargin);
                const sev = resolveSeverity("PRF-E05", severityConfig);

                if (nearAuxiliary) {
                    // PRF-E05 sub-type: pipe is connected to an Auxiliary (actuator) port.
                    // Auxiliary ports are intended for valve-operator connections only;
                    // piping must not be routed to them.
                    const pipingExpected = worldNodes.map(w => `(${w.x.toFixed(2)}, ${w.y.toFixed(2)})`).join(", ");
                    issues.push({
                        objectId:    representsId || "(unknown)",
                        objectType:  modelType,
                        ruleId:      "PRF-E05",
                        severity:    sev.level,
                        score:       sev.score,
                        description: `NodePosition '${npId}' at (${npX}, ${npY}) is connected to an Auxiliary ` +
                                     `(actuator/operator) port of symbol '${symName}'. ` +
                                     `Auxiliary ports are reserved for valve-operator connections; ` +
                                     `piping connections must use the designated piping ports. ` +
                                     `Expected piping ports: ${pipingExpected}.`,
                        location:    `//*[@id='${npId}']`,
                        profileSource: profileName,
                        suggestedCorrection: `Move NodePosition '${npId}' to one of the designated piping ports: ${pipingExpected}.`,
                    });
                } else {
                    // PRF-E05: PipingNodePosition is not near any profile connection point at all.
                    const allExpected = [...worldNodes, ...worldAuxNodes].map(w => `(${w.x.toFixed(2)}, ${w.y.toFixed(2)})`).join(", ");
                    issues.push({
                        objectId:    representsId || "(unknown)",
                        objectType:  modelType,
                        ruleId:      "PRF-E05",
                        severity:    sev.level,
                        score:       sev.score,
                        description: `NodePosition '${npId}' at (${npX}, ${npY}) does not align with any ` +
                                     `profile connection point of symbol '${symName}' placed at (${posX}, ${posY}). ` +
                                     `Expected: ${allExpected}. Margin: ±(${marginX.toFixed(2)}, ${marginY.toFixed(2)}).`,
                        location:    `//*[@id='${npId}']`,
                        profileSource: profileName,
                        suggestedCorrection: `Move NodePosition '${npId}' to one of: ${allExpected}.`,
                    });
                }
            }
        }
    });

    return issues;
}

// ─── DISC Profile: Graphical Representation Check (VAL-004) ──────────────────
//
// Builds the complete set of descendant type-suffixes for a list of base types
// using the Plant meta-model inheritance pairs [[childSuffix, parentSuffix], ...].
// Returns a Set that includes the base types themselves plus all subtypes.
function buildDescendantSet(baseTypes, hierarchyPairs) {
    const descendants = new Set(baseTypes);
    // Build parent → children map for BFS expansion
    const childrenOf = new Map();
    for (const [child, parent] of hierarchyPairs) {
        if (!childrenOf.has(parent)) childrenOf.set(parent, new Set());
        childrenOf.get(parent).add(child);
    }
    const queue = [...baseTypes];
    while (queue.length) {
        const t = queue.shift();
        for (const c of (childrenOf.get(t) || [])) {
            if (!descendants.has(c)) { descendants.add(c); queue.push(c); }
        }
    }
    return descendants;
}

// Lazily-computed Group 1 type set (PlantStructureItem, Note + all subtypes).
// Used by runDiscProfileGraphicalValidation for both the missing-id check and
// the graphical representation check (DISC profile only).
let _val004Group1Cache = null;
function getVal004Group1() {
    if (!_val004Group1Cache) {
        _val004Group1Cache = buildDescendantSet(
            ["PlantStructureItem", "Note"],
            PLANT_HIERARCHY
        );
    }
    return _val004Group1Cache;
}

// VAL-004 — only runs when a DISC Profile is loaded (DISC-specific rule).
//
// Performs two checks:
//   1. Missing id attribute — Group 1 types (PlantStructureItem, Note + subtypes)
//      must always have a persistent id.
//   2. Missing graphical representation — Group 1 types must always be drawn;
//      Group 2 types (equipment, instruments, piping, off-page connectors, etc.)
//      must be drawn if they have a graphical RepresentationGroup.
//
// Returns Info-severity issues for each failing object.
function runDiscProfileGraphicalValidation(mainXml, flatTree, severityConfig) {
    const issues = [];

    // Collect all object IDs that are the target of a Represents reference
    // in the graphical layer.
    const representedIds = new Set();
    const parser = new DOMParser();
    const doc = parser.parseFromString(mainXml, "application/xml");
    if (doc.querySelector("parsererror")) return issues;
    doc.querySelectorAll('References[property="Represents"]').forEach(ref => {
        (ref.getAttribute("objects") || "").split(/\s+/)
            .filter(t => t.startsWith("#"))
            .forEach(t => representedIds.add(t.slice(1)));
    });

    // ── Group 1 type set ──────────────────────────────────────────────────────────────
    const ALWAYS_REQUIRED = getVal004Group1();

    // ── VAL-004 check 1: Missing id attribute (Group 1 only, DISC profile only) ──────
    flatTree.forEach(node => {
        if (!node.objectId && node.type) {
            const suffix = node.type.split(".").pop();
            if (ALWAYS_REQUIRED.has(suffix)) {
                const sev = resolveSeverity("VAL-004", severityConfig);
                const loc = `(type: ${node.type})`;
                issues.push({
                    objectId: "(no id)", objectType: node.type, ruleId: "VAL-004",
                    severity: sev.level, score: sev.score,
                    description: `Object of type '${node.type}' has no id attribute. Persistent identification is required.`,
                    location: loc, profileSource: "DISC",
                    suggestedCorrection: "Add a unique id attribute to this object."
                });
            }
        }
    });

    // ── Group 2: require graphical representation; id required only if drawn ────────
    //
    // Type-expansion rules (per DISC Profile specification):
    //   "or subtypes"        → full BFS expansion through PLANT_HIERARCHY
    //   "or direct subtypes" → only immediate children in the hierarchy (one level)
    //   (unlabelled)         → exact type suffix match only
    //
    // Exact off-page connector types (leaf types in the hierarchy — no subtypes needed)
    const OFF_PAGE_EXACT = new Set([
        "FlowInPipeOffPageConnector",
        "FlowOutPipeOffPageConnector",
        "FlowInSignalOffPageConnector",
        "FlowOutSignalOffPageConnector",
    ]);

    // Types expanded with ALL subtypes (full BFS)
    // Note: the DEXPI meta-model base class for equipment is "ProcessEquipment",
    // which covers Pump, Compressor, HeatExchanger, Vessel, Column, etc.
    const WITH_ALL_SUBTYPES = buildDescendantSet(
        ["Nozzle", "ProcessColumnComponent", "ProcessEquipment", "ProcessVesselComponent", "PipingComponent"],
        PLANT_HIERARCHY
    );
    ["Nozzle", "ProcessColumnComponent", "ProcessEquipment", "ProcessVesselComponent", "PipingComponent"]
        .forEach(t => WITH_ALL_SUBTYPES.add(t));

    // Exact types with no subtype expansion.
    // Rule: where the specification does not say "or subtypes" / "or direct subtypes",
    // only the named class itself is checked — no descendant expansion.
    const EXACT_ONLY = new Set([
        "PipingNetworkSystem",
        "ControlledActuator",
        "ProcessInstrumentationFunction",  // exact only — no subtype qualifier given
        "SignalConveyingFunction",          // exact only — no subtype qualifier given
        "SignalLineFunction",               // exact only — listed separately by name
    ]);

    // Combined Group 2
    const GROUP2 = new Set([...OFF_PAGE_EXACT, ...WITH_ALL_SUBTYPES, ...EXACT_ONLY]);

    flatTree.forEach(node => {
        if (!node.type) return;
        const typeSuffix = node.type.split(".").pop();

        // ── Group 1: always-required graphical representation ─────────────────
        if (ALWAYS_REQUIRED.has(typeSuffix)) {
            if (!node.objectId) return; // missing-id case handled in check 1 above
            if (!representedIds.has(node.objectId)) {
                const sev = resolveSeverity("VAL-004", severityConfig);
                issues.push({
                    objectId: node.objectId, objectType: node.type, ruleId: "VAL-004",
                    severity: sev.level, score: sev.score,
                    description: `Object '${node.objectId}' of type '${node.type}' has no graphical ` +
                                 `RepresentationGroup. Per the DISC Profile, objects of this type ` +
                                 `must be represented graphically on the P&ID.`,
                    location: `//*[@id='${node.objectId}']`, profileSource: "Base",
                    suggestedCorrection: `Add a RepresentationGroup with ` +
                                 `References[@property='Represents'] pointing to '${node.objectId}'.`,
                });
            }
            return;
        }

        // ── Group 2: graphical representation required; id required only if drawn ─
        if (!GROUP2.has(typeSuffix) || !node.objectId) return;

        if (!representedIds.has(node.objectId)) {
            const sev = resolveSeverity("VAL-004", severityConfig);
            issues.push({
                objectId: node.objectId, objectType: node.type, ruleId: "VAL-004",
                severity: sev.level, score: sev.score,
                description: `Object '${node.objectId}' of type '${node.type}' has no graphical ` +
                             `RepresentationGroup. Per the DISC Profile, objects of this type ` +
                             `must be represented graphically on the P&ID.`,
                location: `//*[@id='${node.objectId}']`, profileSource: "DISC",
                suggestedCorrection: `Add a RepresentationGroup with ` +
                             `References[@property='Represents'] pointing to '${node.objectId}'.`,
            });
        }
    });

    return issues;
}


// Union of every bare AttributeName referenced anywhere across ALL of a set
// of loaded profile XMLs' own Profile/LabelTemplate placeholders — i.e.
// every symbol's labelTemplateAttrs (see parseProfileSymbols()) flattened
// together, regardless of which specific symbol each one belongs to. Used
// by runTextTemplateAttributeValidation() (ERR-E20) below to recognise a
// currently-unresolved instance AttributeName as a real, profile-defined
// attribute (just not populated for this particular instance) rather than
// a broken/typo'd reference.
function collectProfileLabelTemplateAttrNames(profileXmlList) {
    const all = new Set();
    for (const xml of profileXmlList) {
        if (!xml) continue;
        const { labelTemplateAttrs } = parseProfileSymbols(xml);
        for (const attrs of labelTemplateAttrs.values()) {
            for (const a of attrs) all.add(a);
        }
    }
    return all;
}

// ─── Text Template Attribute Reference Validation (ERR-E20) ──────────────────
//
// A Core/Diagram.TextTemplate builds up a label's displayed text from
// Core/Diagram.AttributeRepresentation Fragments, each naming an
// AttributeName and a References[@property="Object"] pointing at the
// "owning" object whose attribute value should be substituted in (see
// dexpiParser.js's resolveTemplateFragments()/renderPrimitive() — this is
// exactly what "Profile labels" renders). If AttributeName doesn't actually
// resolve to anything on that object — a typo, or a Fragment copy/pasted
// from a different object's template and left pointing at the wrong
// attribute (e.g. a literal "SPPID: AlarmH" that exists nowhere in the
// file) — the Fragment silently renders as blank text at runtime, with no
// other indication anything is wrong. This rule surfaces that explicitly.
//
// Resolution mirrors dexpiParser.js's ownProperty()/lookupProperty(): a
// direct Data property on the owning object (matched as written, as its
// bare/last-segment name, or under a "DiscProfile/" prefix), or the same
// on a nested id-bearing descendant or any References target up to two
// hops out — since several legitimate attributes (e.g.
// ProcessPlantIdentificationCode on a ProcessPlant reached via
// ParentStructure) live on a related object rather than the owning object
// itself.
//
// profileLabelAttrNames (bare attribute names referenced anywhere across
// EVERY loaded profile's own Profile/LabelTemplate placeholders, regardless
// of which symbol they belong to — see collectProfileLabelTemplateAttrNames()
// below) exempts a currently-unresolved AttributeName from this check
// entirely when the profile itself recognises it as a real, legitimate
// attribute name (e.g. "NominalDiameterRepresentation") - such attributes
// are, by the profile's own design, sometimes populated and sometimes not
// (not mandatory), so a blank one isn't a defect. An AttributeName the
// profile doesn't recognise at all (e.g. a genuine typo like "SPPID:
// AlarmH") still gets flagged.
function runTextTemplateAttributeValidation(mainXml, severityConfig, profileLabelAttrNames = new Set()) {
    const issues = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(mainXml, "application/xml");
    if (doc.querySelector("parsererror")) return issues;

    const propsById = new Map();            // id -> Set<direct Data property name>
    const typeById = new Map();              // id -> type
    const childrenByParentId = new Map();    // id -> [nested id-bearing descendant id, ...]
    const referencesByParentId = new Map();  // id -> [any References target id, ...]
    const lineNumberMap = new Map();         // id -> line number (for issue location)

    {
        const xmlLines = mainXml.split("\n");
        xmlLines.forEach((line, i) => {
            const m = line.match(/\bid=["']([^"']+)["']/);
            if (m && !lineNumberMap.has(m[1])) lineNumberMap.set(m[1], i + 1);
        });
    }

    doc.querySelectorAll("Object[id]").forEach(el => {
        const id = el.getAttribute("id");
        typeById.set(id, el.getAttribute("type") || "");

        const props = new Set();
        directChildren(el, "Data").forEach(d => {
            const prop = d.getAttribute("property");
            if (prop) props.add(prop);
        });
        if (props.size) propsById.set(id, props);

        let p = el.parentNode;
        while (p && (typeof p.getAttribute !== "function" || !p.getAttribute("id"))) p = p.parentNode;
        const parentId = p && typeof p.getAttribute === "function" ? p.getAttribute("id") : null;
        if (parentId && parentId !== id) {
            if (!childrenByParentId.has(parentId)) childrenByParentId.set(parentId, []);
            childrenByParentId.get(parentId).push(id);
        }

        const refTargets = [];
        directChildren(el, "References").forEach(r => {
            (r.getAttribute("objects") || "").split(/\s+/).filter(Boolean).forEach(tok => {
                refTargets.push(tok.replace(/^#/, ""));
            });
        });
        if (refTargets.length) referencesByParentId.set(id, refTargets);
    });

    function ownProperty(objectId, attributeName) {
        if (!objectId || !attributeName) return false;
        const props = propsById.get(objectId);
        if (!props) return false;
        const bare = attributeName.split("/").pop();
        return props.has(attributeName) || props.has(bare) || props.has(`DiscProfile/${bare}`);
    }

    function lookupProperty(objectId, attributeName) {
        if (ownProperty(objectId, attributeName)) return true;
        if (!objectId) return false;
        const seen = new Set([objectId]);
        let frontier = [objectId];
        for (let depth = 0; depth < 2 && frontier.length; depth++) {
            const next = [];
            for (const id of frontier) {
                const neighborIds = [...(childrenByParentId.get(id) || []), ...(referencesByParentId.get(id) || [])];
                for (const nid of neighborIds) {
                    if (!nid || seen.has(nid)) continue;
                    seen.add(nid);
                    if (ownProperty(nid, attributeName)) return true;
                    next.push(nid);
                }
            }
            frontier = next;
        }
        return false;
    }

    doc.querySelectorAll('Object[type="Core/Diagram.AttributeRepresentation"]').forEach(attrRep => {
        const attrName = getDataText(attrRep, "AttributeName");
        if (!attrName) return;

        const objRef = directChildren(attrRep, "References").find(r => r.getAttribute("property") === "Object");
        const rawTarget = (objRef?.getAttribute("objects") || "").split(/\s+/).filter(Boolean)[0];
        const targetId = rawTarget ? rawTarget.replace(/^#/, "") : null;
        if (!targetId) return; // no owning object named — nothing to validate against
        if (!typeById.has(targetId)) return; // broken reference — already reported by VAL-005/ERR-E16

        if (lookupProperty(targetId, attrName)) return; // resolves fine

        const bareAttrName = attrName.split("/").pop();
        if (profileLabelAttrNames.has(attrName) || profileLabelAttrNames.has(bareAttrName)) return; // a real, profile-recognised attribute that's just not populated for this instance — not mandatory

        const targetType = typeById.get(targetId) || "(unknown)";
        const sev = resolveSeverity("ERR-E20", severityConfig);
        issues.push({
            objectId: targetId, objectType: targetType, ruleId: "ERR-E20",
            severity: sev.level, score: sev.score,
            description: `Invalid Text Template Attribute Reference: AttributeName '${attrName}' is not a valid or reachable attribute of the owning object '${targetId}' (type '${targetType}'). This TextTemplate Fragment will resolve to blank text.`,
            location: `//*[@id='${targetId}']`, profileSource: "Base",
            suggestedCorrection: `Correct the AttributeName to a valid property of '${targetType}' (or an object it directly references), or remove this Fragment.`,
            ...(lineNumberMap.has(targetId) ? { lineNumber: lineNumberMap.get(targetId) } : {}),
        });
    });

    return issues;
}

// ─── Full Validation Run ──────────────────────────────────────────────────────

export function runFullValidation({ mainXml, flatTree, profiles, severityConfig, externalValidIds = new Set(), discXml = null, discXmlName = "DiscProfile" }) {
    const allIssues = [];

    // Collect all Object types declared in loaded profile XMLs so ERR-E07 skips them
    const profileTypes = new Set();
    const allProfileXmls = [
        ...(discXml ? [{ xml: discXml, name: discXmlName }] : []),
        ...(profiles || []),
    ];
    allProfileXmls.forEach(p => {
        if (!p.xml) return;
        const parser = new DOMParser();
        const profileDoc = parser.parseFromString(p.xml, "application/xml");
        profileDoc.querySelectorAll("Object[type]").forEach(obj => {
            const t = obj.getAttribute("type");
            if (t) profileTypes.add(t);
        });
        // Also collect ConcreteClass names defined in the profile schema (Class elements)
        profileDoc.querySelectorAll("Class[name]").forEach(cls => {
            const ns = cls.getAttribute("namespace") || cls.getAttribute("package") || "";
            const nm = cls.getAttribute("name") || "";
            if (ns && nm) profileTypes.add(`${ns}/${nm}`);
            else if (nm) profileTypes.add(nm);
        });
    });

    allIssues.push(...runBaseValidation(mainXml, flatTree, severityConfig, externalValidIds));
    // Collect all bare DataProperty / CompositionProperty / ReferenceProperty names
    // declared in loaded profile ClassExtensions and ConcreteClasses.
    // Used by ERR-E07 to avoid flagging valid profile-extended properties.
    const profileExtProps = new Set();
    allProfileXmls.forEach(p => {
        if (!p.xml) return;
        const parser = new DOMParser();
        const profileDoc = parser.parseFromString(p.xml, "application/xml");
        ["ClassExtension","ConcreteClass","AbstractClass"].forEach(tag => {
            profileDoc.querySelectorAll(tag).forEach(cls => {
                ["DataProperty","CompositionProperty","ReferenceProperty"].forEach(pt => {
                    cls.querySelectorAll(pt).forEach(dp => {
                        const pn = dp.getAttribute("name") || "";
                        if (pn && !pn.includes("/") && !pn.includes(".")) profileExtProps.add(pn);
                    });
                });
            });
        });
    });

    // Schema-driven composition (parent/child containment) map for ERR-E08 —
    // combines the base DEXPI 2.0 meta model (Plant or Process, whichever this
    // document uses) with any loaded profile's own class model (ClassExtension /
    // ConcreteClass CompositionProperty declarations), so a profile-declared type
    // like a DiscProfile valve subclass is correctly recognised as a subtype of
    // its base Plant/Piping class when checking containment compatibility.
    const compositionModelName = (() => {
        try {
            const doc = new DOMParser().parseFromString(mainXml, "application/xml");
            return detectMetaModel(doc);
        } catch { return "Unknown"; }
    })();
    const compositionMap = buildProfileCompositionMap(
        compositionModelName === "Process" ? PROCESS_HIERARCHY : PLANT_HIERARCHY,
        compositionModelName === "Process" ? PROCESS_PROPS     : PLANT_PROPS,
        allProfileXmls.map(p => p.xml).filter(Boolean)
    );

    allIssues.push(...runXmlSchemaValidation(mainXml, flatTree, severityConfig, externalValidIds, profileTypes, profileExtProps, compositionMap));
    // Every attribute name ANY loaded profile's own LabelTemplate catalog
    // recognises anywhere, across every symbol - see
    // collectProfileLabelTemplateAttrNames() and runTextTemplateAttributeValidation() (ERR-E20).
    const profileLabelAttrNames = collectProfileLabelTemplateAttrNames(allProfileXmls.map(p => p.xml));
    allIssues.push(...runTextTemplateAttributeValidation(mainXml, severityConfig, profileLabelAttrNames));
    allIssues.push(...runStructuralValidation(flatTree, severityConfig));
    allIssues.push(...runEngineeringValidation(flatTree, severityConfig));

    // Build full XML string list for cross-profile symbol lookup in PRF-E04.
    // Profiles build on one another in load order; a symbol declared in the base
    // DiscProfile model is referenced by prefix "DiscProfile/" regardless of which
    // additional profile is being validated.
    const allProfileXmlStrings = [
        ...(profiles.map(p => p.xml).filter(Boolean)),
        ...(discXml && !profiles.some(p => p.xml === discXml) ? [discXml] : []),
    ];
    // Class-model attribute map (ClassExtension/ConcreteClass DataProperty
    // declarations) from all loaded profile XMLs - built unconditionally
    // (not gated on any Profile/PropertyConstraint existing) since a
    // ClassExtension alone is enough to legitimately grant an attribute to a
    // class. Plant.xml hierarchy is pre-seeded inside buildProfileAttributeMap
    // via PLANT_CLASS_SUPERTYPES — no need to pass Plant.xml raw text. Used by
    // the profile PropertyConstraint-driven ERR-E18/E19 check further down, so
    // a profile ClassExtension grant is honoured even when no explicit
    // PropertyConstraint entry covers a given class/attribute combination.
    const profileAttrMap = buildProfileAttributeMap(allProfileXmlStrings);

    if (profiles.length > 0) {
        const profileSets = profiles.map(p => ({ name: p.name, constraints: p.constraints }));
        const { mergedConstraints, overrideLog } = mergeProfileConstraints(profileSets);
        allIssues.push(...runProfileValidation(flatTree, mergedConstraints, overrideLog, severityConfig));
        profiles.forEach(p => {
            if (p.xml) allIssues.push(...validateProfileContent(p.xml, p.name, severityConfig));
            if (p.xml) allIssues.push(...validateSymbolRules(mainXml, p.xml, p.name, severityConfig, allProfileXmlStrings));
        });
        // VAL-004 (graphical representation): only meaningful when a DISC profile is active,
        // since it checks that engineering objects required by the profile appear on the diagram.
        allIssues.push(...runDiscProfileGraphicalValidation(mainXml, flatTree, severityConfig));
    }

    // Run symbol rules against the disc profile (loaded via "DiscProfile.xml" button) if it
    // was not already included as a "+ Profile" entry. This ensures PRF-E04 fires for symbol
    // references that are not defined in any profile in the stack.
    if (discXml) {
        const alreadyValidated = (profiles || []).some(p => p.xml === discXml);
        if (!alreadyValidated) {
            allIssues.push(...validateSymbolRules(mainXml, discXml, discXmlName, severityConfig, allProfileXmlStrings));
        }
    }

    // ERR-E18 / ERR-E19: attribute-class and cardinality checks.
    // Collect ALL PropertyConstraints: from the DISC profile plus any manually added profiles.
    // This gives a complete picture of which attributes are allowed on which element classes.
    {
        const allConstraints = [
            ...(profiles.flatMap(p => p.constraints || [])),
        ];
        if (discXml) {
            allConstraints.push(...parseProfileConstraints(discXml, discXmlName));
        }
        if (allConstraints.length > 0) {
            allIssues.push(...runAttributeConstraintValidation(flatTree, allConstraints, severityConfig, profileAttrMap));
        }
    }

    // ── Post-processing: stamp line numbers onto every remaining issue ──────────
    // Several rule-producing functions (validateSymbolRules/PRF-E04/E05/E06,
    // runAttributeConstraintValidation/ERR-E18/E19, runStructuralValidation/VAX,
    // runEngineeringValidation/VAE, etc.) don't set `lineNumber` themselves —
    // only runBaseValidation and a couple of ERR-E** rules do. Rather than thread
    // a line-number map through every one of those functions, do one final pass
    // here over the combined result: for any issue still missing a lineNumber,
    // find the line matching the error best for that element — the first
    // occurrence of `id="<objectId>"` in the source XML — and stamp it there.
    {
        const lineNumberMap = new Map(); // id -> first line number it appears on
        const xmlLines = mainXml.split("\n");
        const idRe = /\bid=["']([^"']+)["']/;
        for (let i = 0; i < xmlLines.length; i++) {
            const m = xmlLines[i].match(idRe);
            if (m && !lineNumberMap.has(m[1])) lineNumberMap.set(m[1], i + 1);
        }
        allIssues.forEach(iss => {
            if (iss.lineNumber !== undefined) return; // already set by its own rule
            const id = iss.objectId;
            if (!id || id.startsWith("(")) return;
            // Some issues report multiple ids as a comma-separated list (e.g. ERR-E11) —
            // use the first one's line as the representative location.
            const firstId = id.split(",")[0].trim();
            const ln = lineNumberMap.get(id) || lineNumberMap.get(firstId);
            if (ln) iss.lineNumber = ln;
        });
    }

    return allIssues;
}

// ─── CSV Export (RPT-002, RPT-003) ────────────────────────────────────────────

export function exportCSV(issues) {
    const headers = [
        "Object ID", "Line Number", "Object Type", "Rule ID", "Severity", "Severity Score",
        "Rule Description", "Location (XPath)", "Profile Source", "Suggested Correction"
    ];
        const escape = v => (v2 => `"${v2.replace(/"/g, '""')}"`)(String(v ?? ""));
    const rows = issues.map(i => [
        i.objectId, i.lineNumber ?? "", i.objectType, i.ruleId, i.severity, i.score,
        i.description, i.location, i.profileSource, i.suggestedCorrection
    ].map(escape).join(","));
    return [headers.join(","), ...rows].join("\r\n");
}

export function downloadCSV(issues, filename = "validation-report.csv") {
    const csv = exportCSV(issues);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
