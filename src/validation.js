// DEXPI Verificator – Validation Engine
// Implements: VAL-001..005, VAX-001..005, VAE-001..004, VAE-005, PRF-001..007, ERR-001..004, RPT-001..004

import { DEXPI_ALL_TYPES, DEXPI_STD_PREFIXES as _DEXPI_STD_PREFIXES } from "./dexpiTypes.js";

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
    "VAL-004": { level: "Warning", score: 2 },
    "VAL-005": { level: "Error",   score: 3 },
    "VAX-001": { level: "Warning", score: 2 },
    "VAX-002": { level: "Warning", score: 2 },
    "VAX-003": { level: "Warning", score: 2 },
    "VAX-004": { level: "Warning", score: 2 },
    "VAX-005": { level: "Info",    score: 1 },
    "VAE-001": { level: "Warning", score: 2 },
    "VAE-002": { level: "Warning", score: 2 },
    "VAE-003": { level: "Warning", score: 2 },
    "VAE-004": { level: "Warning", score: 2 },
    "VAE-005": { level: "Warning", score: 2 },
    "PRF":     { level: "Warning", score: 2 },
    "ERR-E01": { level: "Error",   score: 3 },
    "ERR":     { level: "Error",   score: 3 },
    "PRF-E01": { level: "Error",   score: 3 },
    "PRF-E02": { level: "Error",   score: 3 },
    "PRF-E04": { level: "Error",   score: 3 },
    "PRF-E05": { level: "Error",   score: 3 },
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

        // VAL-004: Missing IDs on model elements
        const isModelElement = node.type &&
            !node.type.startsWith("Core/Diagram") &&
            !node.type.includes("PersistentIdentifier") &&
            !node.type.includes("Label");
        if (isModelElement && !node.objectId) {
            const sev = resolveSeverity("VAL-004", severityConfig);
            issues.push({
                objectId: "(no id)", objectType: node.type, ruleId: "VAL-004",
                severity: sev.level, score: sev.score,
                description: `Object of type '${node.type}' has no id attribute. Persistent identification is required.`,
                location: loc, profileSource: "Base",
                suggestedCorrection: "Add a unique id attribute to this object."
            });
        }

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

const PARENT_PROP_RULES = {
    "actuatingsystems":         ["ActuatingSystem"],
    "pipingnetworksystems":     ["PipingNetworkSystem"],
    "pipingnetworksegments":    ["PipingNetworkSegment"],
    "processplants":            ["ProcessPlant"],
    "plantsystems":             ["PlantSystem"],
    "instrumentationfunctions": ["InstrumentationFunction","ProcessInstrumentationFunction","ProcessSafetyFunction"],
    "controlledactuator":       ["ControlledActuator"],
};

const EQUIPMENT_TYPES_FOR_E17 = [
    "Pump","Compressor","HeatExchanger","Vessel","Tank","Heater","Cooler",
    "Filter","Separator","Column","Reactor","Turbine","Blower","Fan",
    "GateValve","BallValve","ButterflyValve","CheckValve","SafetyValve",
    "ControlValve","WedgeGateValve","NeedleValve","PlugValve","DiaphragmValve",
    "GlobeValve","FlowInPipeOffPageConnector","FlowOutPipeOffPageConnector",
    "FlowInSignalOffPageConnector","FlowOutSignalOffPageConnector","Note",
];

export function runXmlSchemaValidation(mainXml, flatTree, severityConfig, externalValidIds = new Set(), profileTypes = new Set()) {
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
    {
        const xmlLines = mainXml.split("\n");
        const refRe = /\bobjects=["']([^"']+)["']/g;
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
            // Standard DEXPI prefix but class not in registry — always Warning (registry may be incomplete)
            issues.push({
                objectId: objId, objectType: t, ruleId: "ERR-E07",
                severity: "Warning", score: 2,
                description: `Object type '${t}' has a standard DEXPI prefix but is not in the type registry. It may be a valid DEXPI 2.0 type — add it to dexpiTypes.js to suppress this warning.`,
                location: objId !== "(no id)" ? `//*[@id='${objId}']` : `//Object[@type='${t}']`,
                profileSource: "Base",
                suggestedCorrection: `Verify the class name in the DEXPI 2.0 specification, then add it to src/dexpiTypes.js.`
            });
        }
        // else: non-standard prefix declared as import (profile type) — prefix check is sufficient
    });

    // ERR-E08: Object placed under incompatible parent Components property
    doc.querySelectorAll("Components").forEach(comp => {
        const parentProp = (comp.getAttribute("property") || "").toLowerCase();
        const rule = PARENT_PROP_RULES[parentProp];
        if (!rule) return;
        for (const child of comp.children) {
            if (child.tagName !== "Object") continue;
            const childType = child.getAttribute("type") || "";
            if (!childType) continue;
            const childSuffix = childType.split(".").pop();
            const compatible = rule.some(r => childSuffix.includes(r) || childType.includes(r));
            if (!compatible) {
                const childId = child.getAttribute("id") || "(no id)";
                const directRep = childId !== "(no id)" && representedIds.has(childId);
                const visualContextId = directRep ? null : findNearestRepAncestor(child);
                const sev = resolveSeverity("ERR-E08", severityConfig);
                issues.push({
                    objectId: childId, objectType: childType, ruleId: "ERR-E08",
                    severity: sev.level, score: sev.score,
                    description: `Object of type '${childType}' is placed under Components[@property='${comp.getAttribute("property")}'], which does not permit this type per the Plant Meta Model.`,
                    location: childId !== "(no id)" ? `//*[@id='${childId}']` : `//Components[@property='${comp.getAttribute("property")}']`,
                    profileSource: "Base",
                    suggestedCorrection: `Move this object to the correct parent property for type '${childType}'.`,
                    ...(visualContextId ? { visualContextId } : {}),
                });
            }
        }
    });

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
    const treeMap = new Map(flatTree.filter(n => n.objectId).map(n => [n.objectId, n]));

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

        // VAX-002: OperatedValveReference target should be a valve type
        if (node.edgeLabel && node.edgeLabel.toLowerCase().includes("operatedvalve")) {
            node.refs.forEach(ref => {
                ref.objects.forEach(targetId => {
                    const target = treeMap.get(targetId);
                    if (target && !target.type.toLowerCase().includes("valve")) {
                        const sev = resolveSeverity("VAX-002", severityConfig);
                        issues.push({
                            objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "VAX-002",
                            severity: sev.level, score: sev.score,
                            description: `OperatedValveReference points to '${targetId}' (type '${target.type}') which is not a valve type.`,
                            location: `${loc}/References[@property='${ref.property}']`,
                            profileSource: "Base",
                            suggestedCorrection: "The reference should point to an OperatedValve or subtype."
                        });
                    }
                });
            });
        }

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

        // VAE-002: PipingNetworkSegment should contain at least one piping item
        if (typeSuffix === "PipingNetworkSegment") {
            const hasItems = node.children.some(c =>
                c.type.includes("PipingComponent") || c.type.includes("PipingItem") ||
                c.edgeLabel === "Items");
            if (!hasItems) {
                const sev = resolveSeverity("VAE-002", severityConfig);
                issues.push({
                    objectId: node.objectId || "(no id)", objectType: node.type, ruleId: "VAE-002",
                    severity: sev.level, score: sev.score,
                    description: `PipingNetworkSegment '${node.label}' contains no piping items. A segment should contain at least one piping component or instrument.`,
                    location: loc, profileSource: "Base",
                    suggestedCorrection: "Add piping items (valves, instruments, pipe runs, etc.) to this segment."
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

const KNOWN_PLANT_MM_PREFIXES = ["Core/","Plant/","Profile/"];

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
                description: `Profile '${profileName}': ConstrainedType='${ctVal}' is not from a known DEXPI 2.0 namespace (Core/, Plant/, Profile/).`,
                location: "//Object[@type='Profile/PropertyConstraint']", profileSource: profileName,
                suggestedCorrection: "ConstrainedType must reference a class in the DEXPI 2.0 Plant Meta Model."
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
                const shortProp = property.split(".").pop() || property;
                const hasProperty = node.data.some(d => {
                    const dp = d.property || "";
                    return dp === property || dp.endsWith("." + shortProp);
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
 */
function parseProfileSymbols(profileXml) {
    const symbolUsage = new Map();
    const symbolNodes = new Map();
    const parser = new DOMParser();
    const doc = parser.parseFromString(profileXml, "application/xml");
    if (doc.querySelector("parsererror")) return { symbolUsage, symbolNodes, typeToSymbols: new Map() };

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
        sym.querySelectorAll('Object[type="Profile/SymbolVariant"]').forEach(variant => {
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
                // Only store Piping-type NodePositions — Label and Instrumentation types
                // represent label anchors / instrument loop connections that are not
                // checked against PipingNodePositions in the drawing.
                const isPiping = npType === null || npType === "Profile/NodePositionType.Piping";
                if (x !== null && y !== null && isPiping) nodes.push({ x, y, dir: dir ?? 0 });
            });
        });
        if (nodes.length) symbolNodes.set(name, nodes);
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

    return { symbolUsage, symbolNodes, typeToSymbols };
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
// Return the "category" prefix of a normalised DEXPI type, e.g.
//   "Plant.ProcessEquipment.CentrifugalPump" → "Plant.ProcessEquipment"
//   "DiscProfile.InformationModel.Foo"       → "DiscProfile.InformationModel"
function typeCategory(normType) {
    const parts = normType.split(".");
    return parts.length >= 2 ? parts.slice(0, 2).join(".") : normType;
}

export function validateSymbolRules(mainXml, profileXml, profileName, severityConfig) {
    const issues = [];
    if (!mainXml || !profileXml) return issues;

    const { symbolUsage, symbolNodes, typeToSymbols } = parseProfileSymbols(profileXml);
    const parser = new DOMParser();
    const doc = parser.parseFromString(mainXml, "application/xml");
    if (doc.querySelector("parsererror")) return issues;

    // Build id → type map for all model objects
    const objectTypes = new Map();
    doc.querySelectorAll("Object[id]").forEach(o =>
        objectTypes.set(o.getAttribute("id"), o.getAttribute("type") || "")
    );

    // Compute drawing bounding box from all Position elements
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    doc.querySelectorAll('Data[property="Position"] AggregatedDataValue').forEach(agv => {
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

    // Inspect every Profile/SymbolUsage in the drawing
    doc.querySelectorAll('Object[type="Profile/SymbolUsage"]').forEach(su => {
        // Symbol name: "DiscProfile/PE037A" → strip prefix → "PE037A"
        // Use direct child iteration (avoids :scope quirks in XML-mode DOMParser)
        const symRefEl = Array.from(su.children).find(
            c => c.tagName === "References" && c.getAttribute("property") === "Symbol"
        );
        if (!symRefEl) return;
        const symName = (symRefEl.getAttribute("objects") || "").split("/").pop().replace(/^#/, "");

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

        // Determine which model object this RepresentationGroup represents
        let representsId = null;
        for (const child of topRepGroup.children) {
            if (child.tagName === "References" && child.getAttribute("property") === "Represents") {
                representsId = (child.getAttribute("objects") || "").replace(/^#/, "");
                break;
            }
        }
        const modelType     = representsId ? (objectTypes.get(representsId) || "") : "";
        const normModelType = modelType.replace(/\//g, ".");

        // ── PRF-E04: symbol type must match the model object's DEXPI type ───────
        const allowedTypes = symbolUsage.get(symName);
        if (modelType && allowedTypes && allowedTypes.length > 0) {
            // Skip decorator / label symbols (usage entirely Core.Diagram.*).
            const isDecorator = allowedTypes.every(at => at.startsWith("Core.Diagram."));
            if (!isDecorator) {
                const isAllowed = allowedTypes.some(at => at === normModelType);
                if (!isAllowed) {
                    // Rule 1 – only flag when the profile defines at least one dedicated
                    // symbol for this model type. If none exist, the object legitimately
                    // inherits symbols from a parent/base type (e.g. ProcessSafetyFunction
                    // has no own symbols and uses ProcessInstrumentationFunction symbols).
                    const profileHasSymbolsForType = typeToSymbols.has(normModelType);

                    // Rule 2 – within the same top-level category (e.g. Plant.ProcessEquipment)
                    // subtype symbol usage is acceptable (e.g. Nozzle using an AccessNozzle symbol).
                    const modelCat    = typeCategory(normModelType);
                    const symCatMatch = allowedTypes.some(at => typeCategory(at) === modelCat);

                    if (profileHasSymbolsForType && !symCatMatch) {
                        const sev = resolveSeverity("PRF-E04", severityConfig);
                        const validSymbols = [...(typeToSymbols.get(normModelType) || [])].join(", ");
                        issues.push({
                            objectId:    representsId || "(unknown)",
                            objectType:  modelType,
                            ruleId:      "PRF-E04",
                            severity:    sev.level,
                            score:       sev.score,
                            description: `Symbol '${symName}' (allowed for: ${allowedTypes.join(", ")}) is used to represent ` +
                                         `'${representsId}' of type '${modelType}'. ` +
                                         `Symbols permitted for this type: ${validSymbols || "(none defined)"}.`,
                            location:    representsId ? `//*[@id='${representsId}']` : "/",
                            profileSource: profileName,
                            suggestedCorrection: `Replace symbol '${symName}' with one of: ${validSymbols || "a symbol permitted for '" + normModelType + "'."}.`,
                        });
                    }
                }
            }
        }

        // ── PRF-E05: NodePositions must align with profile connection points ─────
        const profileNodeList = symbolNodes.get(symName);
        if (!profileNodeList || profileNodeList.length === 0) return;

        // Transform profile NodePositions from symbol-local to world coordinates
        // (symbol-local, Y-up math convention) to drawing world coordinates (Y-down SVG convention).
        // Because the drawing Y axis is inverted relative to the profile's local Y axis,
        // the Y component of the rotation uses negated signs:
        //   world.x = posX + lx·cos − ly·sin  (unchanged)
        //   world.y = posY − lx·sin − ly·cos  (Y-axis negated)
        const rad = (rotation * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const worldNodes = profileNodeList.map(np => {
            let lx = np.x * scaleX;
            let ly = np.y * scaleY;
            if (isMirrored) lx = -lx;
            return {
                x: posX + lx * cos - ly * sin,
                y: posY - lx * sin - ly * cos,   // Y-down: negate both sin and cos terms
            };
        });

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

                const nearEnough = worldNodes.some(
                    wn => Math.abs(npX - wn.x) <= marginX && Math.abs(npY - wn.y) <= marginY
                );
                if (!nearEnough) {
                    const sev = resolveSeverity("PRF-E05", severityConfig);
                    const expected = worldNodes.map(w => `(${w.x.toFixed(2)}, ${w.y.toFixed(2)})`).join(", ");
                    issues.push({
                        objectId:    representsId || "(unknown)",
                        objectType:  modelType,
                        ruleId:      "PRF-E05",
                        severity:    sev.level,
                        score:       sev.score,
                        description: `NodePosition '${npId}' at (${npX}, ${npY}) does not align with any ` +
                                     `profile connection point of symbol '${symName}' placed at (${posX}, ${posY}). ` +
                                     `Expected: ${expected}. Margin: ±(${marginX.toFixed(2)}, ${marginY.toFixed(2)}).`,
                        location:    `//*[@id='${npId}']`,
                        profileSource: profileName,
                        suggestedCorrection: `Move NodePosition '${npId}' to one of: ${expected}.`,
                    });
                }
            }
        }
    });

    return issues;
}

// ─── Full Validation Run ──────────────────────────────────────────────────────

export function runFullValidation({ mainXml, flatTree, profiles, severityConfig, externalValidIds = new Set() }) {
    const allIssues = [];

    // Collect all Object types declared in loaded profile XMLs so ERR-E07 skips them
    const profileTypes = new Set();
    (profiles || []).forEach(p => {
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
    allIssues.push(...runXmlSchemaValidation(mainXml, flatTree, severityConfig, externalValidIds, profileTypes));
    allIssues.push(...runStructuralValidation(flatTree, severityConfig));
    allIssues.push(...runEngineeringValidation(flatTree, severityConfig));

    if (profiles.length > 0) {
        const profileSets = profiles.map(p => ({ name: p.name, constraints: p.constraints }));
        const { mergedConstraints, overrideLog } = mergeProfileConstraints(profileSets);
        allIssues.push(...runProfileValidation(flatTree, mergedConstraints, overrideLog, severityConfig));
        profiles.forEach(p => {
            if (p.xml) allIssues.push(...validateProfileContent(p.xml, p.name, severityConfig));
            if (p.xml) allIssues.push(...validateSymbolRules(mainXml, p.xml, p.name, severityConfig));
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
