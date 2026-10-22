// DEXPI XML parser utilities â€" shared between App.jsx and validation engine
import { PLANT_HIERARCHY, PLANT_PROPS } from "./metaModel.js";
import { UNIT_SYMBOLS } from "./unitSymbols.js";

export function qsa(node, selector) { return Array.from(node.querySelectorAll(selector)); }

export function directChildrenByTag(node, tag) {
    if (!node?.children) return [];
    return Array.from(node.children).filter(c => c?.tagName === tag);
}

export function directComponentsObjects(node, property = null) {
    if (!node) return [];
    const comps = directChildrenByTag(node, "Components").filter(c => !property || c.getAttribute("property") === property);
    return comps.flatMap(c => directChildrenByTag(c, "Object"));
}

export function dataValue(dataNode) {
    if (!dataNode) return null;
    const first = dataNode.firstElementChild;
    if (!first) return null;
    if (first.tagName === "String") return first.textContent || "";
    if (first.tagName === "Boolean") return (first.textContent || "").trim() === "true";
    if (first.tagName === "Integer") return parseInt(first.textContent || "0", 10);
    if (first.tagName === "Double") return parseFloat(first.textContent || "0");
    if (first.tagName === "Undefined") return null;
    if (first.tagName === "DataReference") return { kind: "DataReference", value: first.getAttribute("data") || "" };
    if (first.tagName === "AggregatedDataValue") return aggregatedValue(first);
    return first.textContent?.trim() || null;
}

export function getData(node, property) {
    if (!node) return undefined;
    return directChildrenByTag(node, "Data").find(d => d.getAttribute("property") === property);
}

export function aggregatedValue(aggNode) {
    if (!aggNode || typeof aggNode.getAttribute !== "function") return null;
    const type = aggNode.getAttribute("type") || "";
    if (type === "Core/Diagram.Point") return { x: numberFromData(aggNode, "X"), y: numberFromData(aggNode, "Y") };
    if (type === "Core/Diagram.Color") return { r: intFromData(aggNode, "R", 0), g: intFromData(aggNode, "G", 0), b: intFromData(aggNode, "B", 0) };
    if (type === "Core/Diagram.Stroke") return parseStroke(aggNode);
    if (type === "Core/Diagram.TextStyle") return {
        color: aggregatedValue(getData(aggNode, "Color")?.firstElementChild),
        font: valueFromData(aggNode, "Font") || "Arial",
        size: numberFromData(aggNode, "Height") || 3.5,
        horizontal: refName(valueFromData(aggNode, "HorizontalAlignment")) || "Center",
        vertical: refName(valueFromData(aggNode, "VerticalAlignment")) || "Center",
    };
    if (type === "Core/DataTypes.MultiLanguageString") {
        const items = directChildrenByTag(aggNode, "Data").filter(d => d.getAttribute("property") === "SingleLanguageStrings");
        return items.map(d => aggregatedValue(d.firstElementChild)).filter(Boolean).map(v => v.value).join(" ");
    }
    if (type === "Core/DataTypes.SingleLanguageString") return {
        language: valueFromData(aggNode, "Language") || "",
        value: valueFromData(aggNode, "Value") || ""
    };
    if (type === "Core/PhysicalQuantities.PhysicalQuantity") {
        const unitRaw = valueFromData(aggNode, "Unit");
        const unitRef = (unitRaw && unitRaw.kind === "DataReference") ? unitRaw.value : (unitRaw || "");
        // unit shown by its Core.xml symbol (MetaData/un_symbol, see unitSymbols.js),
        // e.g. PressureGaugeUnit.Bar -> "barg"; falls back to the literal name
        const unitKey = unitRef.split("/").pop().split(".").slice(-2).join(".");
        const unitSymbol = UNIT_SYMBOLS[unitKey] || unitRef.split(".").pop() || unitRef;
        const value = valueFromData(aggNode, "Value");
        return { kind: "PhysicalQuantity", value, unit: unitSymbol, unitRef };
    }
    // Generic fallback: collect all Data children as key/value pairs for display
    const children = directChildrenByTag(aggNode, "Data");
    if (children.length > 0) {
        const entries = {};
        children.forEach(d => {
            const prop = d.getAttribute("property") || "";
            const shortProp = prop.split(".").pop() || prop;
            const val = dataValue(d);
            entries[shortProp] = val;
        });
        return { kind: "AggregatedValue", type: type.split(".").pop() || type, entries };
    }
    return { kind: "AggregatedValue", type: type.split(".").pop() || type, entries: {} };
}

export function valueFromData(node, property) { return dataValue(getData(node, property)); }
export function numberFromData(node, property, fallback = 0) { const v = valueFromData(node, property); return typeof v === "number" ? v : fallback; }
export function intFromData(node, property, fallback = 0) { const v = valueFromData(node, property); return Number.isInteger(v) ? v : fallback; }

export function parseColor(value) {
    if (!value) return "#000000";
    const r = (value.r ?? 0).toString(16).padStart(2, "0");
    const g = (value.g ?? 0).toString(16).padStart(2, "0");
    const b = (value.b ?? 0).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
}

export function refName(value) {
    if (!value) return "";
    if (typeof value === "string") return value.split(".").pop().split("/").pop();
    if (value.kind === "DataReference") return value.value.split(".").pop().split("/").pop();
    return "";
}

// Enumeration literals the profile gives an Abbreviation, e.g.
//   <Package name="InformationModel"><Package name="ProcessInstrumentationFunctionTypeCodes">
//     <Object name="ProcessShutdown" ...><Data property="Abbreviation"><String>PSD</String>
// keyed by the DataReference an instance uses for it:
//   "DiscProfile/InformationModel.ProcessInstrumentationFunctionTypeCodes.ProcessShutdown" -> "PSD"
// Display only - condition matching keeps using the literal name (refName()).
export function buildEnumAbbreviationMap(discDoc) {
    const map = new Map();
    const root = discDoc?.documentElement;
    if (!root) return map;
    const modelName = root.getAttribute("name") || "DiscProfile";
    const walk = (pkg, path) => {
        for (const child of Array.from(pkg.children)) {
            if (child.tagName === "Package") { walk(child, [...path, child.getAttribute("name") || ""]); continue; }
            if (child.tagName !== "Object") continue;
            const name = child.getAttribute("name");
            const abbrEl = Array.from(child.children).find(c => c.tagName === "Data" && c.getAttribute("property") === "Abbreviation");
            const abbr = abbrEl?.querySelector("String")?.textContent?.trim();
            if (name && abbr) map.set(`${modelName}/${[...path, name].join(".")}`, abbr);
        }
    };
    walk(root, []);
    return map;
}

// An enumeration value can also be carried as a reference property to a
// profile literal rather than a Data value, e.g. on ControlledActuator2 in
// DISC_EXAMPLE-14-10:
//   <References objects="DiscProfile/InformationModel.ControlledActuatorTypeCodes.Motor" property="DiscProfile/TypeCode"/>
// (a prefixed, non-"#" target). Returned as [property, DataReference] pairs
// so labels can resolve them exactly like a Data DataReference.
export function enumReferenceValues(el) {
    const out = [];
    for (const r of Array.from(el.children || [])) {
        if (r.tagName !== "References") continue;
        const prop = r.getAttribute("property") || "";
        const target = (r.getAttribute("objects") || "").trim();
        if (!prop || !target || target.startsWith("#") || /\s/.test(target) || !target.includes("/")) continue;
        out.push([prop, { kind: "DataReference", value: target }]);
    }
    return out;
}

/** Display text for an enumeration DataReference: the profile Abbreviation when there is one, else the literal name. */
export function enumDisplayName(value, abbreviations) {
    const ref = typeof value === "string" ? value : value?.kind === "DataReference" ? value.value : "";
    return (ref && abbreviations?.get(ref)) || refName(value);
}

export function parseStroke(node) {
    const color = aggregatedValue(getData(node, "Color")?.firstElementChild);
    const width = numberFromData(node, "Width", 0.25);
    const dashStyle = refName(valueFromData(node, "DashStyle")) || "Solid";
    // Covers every Core/Diagram.DashStyle literal (ShortDash, LongDash and the
    // combined styles used to fall through to "" and render as solid).
    const dashMap = {
        Solid: "", Dash: `${4 * width} ${2 * width}`, Dot: `${width} ${2 * width}`,
        ShortDash: `${2 * width} ${2 * width}`, LongDash: `${8 * width} ${2 * width}`,
        DashDot: `${4 * width} ${2 * width} ${width} ${2 * width}`,
        DashDotDot: `${4 * width} ${2 * width} ${width} ${2 * width} ${width} ${2 * width}`,
        DashShortDash: `${4 * width} ${2 * width} ${2 * width} ${2 * width}`,
        LongDashShortDash: `${8 * width} ${2 * width} ${2 * width} ${2 * width}`,
        LongDashShortDashShortDash: `${8 * width} ${2 * width} ${2 * width} ${2 * width} ${2 * width} ${2 * width}`,
    };
    return { color: parseColor(color), width, dashStyle, dashArray: dashMap[dashStyle] || "", dashOffset: numberFromData(node, "Offset", 0) };
}

export function parseFill(node) {
    const style = refName(valueFromData(node, "FillStyle")) || "Transparent";
    const color = aggregatedValue(getData(node, "Color")?.firstElementChild);
    return { style, color: parseColor(color) };
}

export function parsePointsFromData(dataNode) {
    return directChildrenByTag(dataNode, "AggregatedDataValue").map(p => aggregatedValue(p)).filter(Boolean);
}

// Reads a Core/Diagram.Text|LiteralText object's optional Template
// (Components property="Template" > Object type="Core/Diagram.TextTemplate"
// > Components property="Fragments" > Object[]) and returns an ordered,
// unresolved list of fragment descriptors, or null when there is no
// Template at all. Each fragment is one of:
//   { kind: "attr", attributeName, objectId, repType }   — Core/Diagram.AttributeRepresentation
//   { kind: "literal", text }                            — Core/Diagram.LiteralText (as a fragment)
// See resolveTemplateFragments() in collectGraphicalElements() for how
// these get turned into displayed text (profileText).
function parseTextTemplateFragments(objectNode) {
    const templateObj = directComponentsObjects(objectNode, "Template")[0];
    if (!templateObj) return null;
    const fragments = directComponentsObjects(templateObj, "Fragments").map(f => {
        const ftype = f.getAttribute("type") || "";
        if (ftype === "Core/Diagram.AttributeRepresentation") {
            return {
                kind: "attr",
                attributeName: valueFromData(f, "AttributeName") || "",
                objectId: referenceTargets(f, "Object")[0] || null,
                repType: refName(valueFromData(f, "Type")) || "Value",
            };
        }
        if (ftype === "Core/Diagram.LiteralText") {
            return { kind: "literal", text: valueFromData(f, "Text") || "" };
        }
        return null;
    }).filter(Boolean);
    return fragments.length ? fragments : null;
}

export function parsePrimitive(objectNode, idx) {
    if (!objectNode || typeof objectNode.getAttribute !== "function") return null;
    const type = objectNode.getAttribute("type") || "";
    const key = `${type}_${idx}`;
    if (type === "Core/Diagram.PolyLine") return {
        kind: "polyline", key,
        points: parsePointsFromData(getData(objectNode, "Points")),
        stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 }
    };
    if (type === "Core/Diagram.Polygon") return {
        kind: "polygon", key,
        points: parsePointsFromData(getData(objectNode, "Points")),
        stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 },
        fill: parseFill(objectNode)
    };
    if (type === "Core/Diagram.Circle") return {
        kind: "circle", key,
        center: aggregatedValue(getData(objectNode, "Center")?.firstElementChild) || { x: 0, y: 0 },
        radius: numberFromData(objectNode, "Radius", 1),
        stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 },
        fill: parseFill(objectNode)
    };
    if (type === "Core/Diagram.Ellipse") return {
        kind: "ellipse", key,
        center: aggregatedValue(getData(objectNode, "Center")?.firstElementChild) || { x: 0, y: 0 },
        rx: numberFromData(objectNode, "HorizontalSemiAxis", 1),
        ry: numberFromData(objectNode, "VerticalSemiAxis", 1),
        rotation: numberFromData(objectNode, "Rotation", 0),
        stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 },
        fill: parseFill(objectNode)
    };
    if (type === "Core/Diagram.Rectangle") return {
        kind: "rect", key,
        center: aggregatedValue(getData(objectNode, "Center")?.firstElementChild) || { x: 0, y: 0 },
        width: numberFromData(objectNode, "Width", 1),
        height: numberFromData(objectNode, "Height", 1),
        rotation: numberFromData(objectNode, "Rotation", 0),
        stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 },
        fill: parseFill(objectNode)
    };
    if (type === "Core/Diagram.Text" || type === "Core/Diagram.LiteralText") return {
        kind: "text", key,
        position: aggregatedValue(getData(objectNode, "Position")?.firstElementChild) || { x: 0, y: 0 },
        value: valueFromData(objectNode, "Value") || valueFromData(objectNode, "Text") || "",
        rotation: numberFromData(objectNode, "Rotation", 0),
        style: {
            color: aggregatedValue(getData(objectNode, "Color")?.firstElementChild) || { r: 0, g: 0, b: 0 },
            font: valueFromData(objectNode, "Font") || "Arial",
            size: numberFromData(objectNode, "Size", numberFromData(objectNode, "Height", 3.5)),
            horizontal: refName(valueFromData(objectNode, "Alignment")) || refName(valueFromData(objectNode, "HorizontalAlignment")) || "Center",
            vertical: refName(valueFromData(objectNode, "Alignment")) || refName(valueFromData(objectNode, "VerticalAlignment")) || "Center",
        },
        // Raw (unresolved) Template/Fragments, if this Text carries a
        // Core/Diagram.TextTemplate — used by collectGraphicalElements() to
        // compute profileText, the attribute-driven label value shown instead
        // of the literal `value` above when the "Profile labels" checkbox is
        // on and this label belongs to a DiscProfile-catalogued symbol.
        // null when the Text has no Template (plain literal label).
        templateFragments: parseTextTemplateFragments(objectNode),
    };
    if (type === "Core/Diagram.ConnectorLine") return {
        kind: "connectorLine", key,
        innerPoints: parsePointsFromData(getData(objectNode, "InnerPoints")),
        stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 },
        sourceRef: referenceTargets(objectNode, "Source")[0] || null,
        targetRef: referenceTargets(objectNode, "Target")[0] || null
    };
    if (type === "Core/Diagram.EllipseArc") return {
        kind: "ellipseArc", key,
        center: aggregatedValue(getData(objectNode, "Center")?.firstElementChild) || { x: 0, y: 0 },
        rx: numberFromData(objectNode, "HorizontalSemiAxis", 1),
        ry: numberFromData(objectNode, "VerticalSemiAxis", 1),
        startAngle: numberFromData(objectNode, "StartAngle", 0),
        endAngle: numberFromData(objectNode, "EndAngle", 360),
        rotation: numberFromData(objectNode, "Rotation", 0),
        stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 }
    };
    return null;
}

export function referenceTargets(node, property = null) {
    if (!node) return [];
    return directChildrenByTag(node, "References")
        .filter(r => !property || r.getAttribute("property") === property)
        .flatMap(r => (r.getAttribute("objects") || "").split(/\s+/).filter(Boolean).map(v => v.startsWith("#") ? v.slice(1) : v));
}

// Parse a SymbolVariant's Condition, e.g. (real DiscProfile.xml structure):
//   <Components property="Condition">
//     <Object type="Profile/PropertyValueCondition">
//       <Data property="Property"><String>DiscProfile.InformationModel.OperatedValveExtension.ValvePosition</String></Data>
//       <Data property="Value"><String>DiscProfile.InformationModel.ValvePosition.NormallyClose</String></Data>
//     </Object>
//   </Components>
// Returns { attributeName, literalValue } (bare local names, e.g.
// "ValvePosition" / "NormallyClose") or null for unconditional (default)
// variants, or if the condition object is malformed. `Value` is normally a
// plain dotted String naming the enumeration literal, but a DataReference is
// tolerated too in case a profile encodes it that way instead.
function parsePropertyValueCondition(conditionObj) {
    if (!conditionObj) return null;
    const propRaw = valueFromData(conditionObj, "Property");
    const valRaw  = valueFromData(conditionObj, "Value");
    if (typeof propRaw !== "string" || !propRaw.trim()) return null;
    const attributeName = propRaw.split(/[./]/).pop();
    let literalValue = null;
    if (typeof valRaw === "string" && valRaw.trim()) literalValue = valRaw.split(/[./]/).pop();
    else if (valRaw?.kind === "DataReference") literalValue = valRaw.value.split(/[./]/).pop();
    if (!attributeName || !literalValue) return null;
    return { attributeName, literalValue };
}

export function parseSymbolCatalogue(discDoc) {
    if (!discDoc) return new Map();
    const map = new Map();
    qsa(discDoc, 'Object[type="Profile/Symbol"]').forEach(obj => {
        const name = obj.getAttribute("name") || obj.getAttribute("id") || "";
        const symbolKey = `DiscProfile/${name}`;
        const variants = directComponentsObjects(obj, "Variants").map((variant, i) => {
            // Condition (if any) lives under Components[property="Condition"] as a
            // single Profile/PropertyValueCondition Object — see
            // parsePropertyValueCondition() above.
            const conditionObj = directComponentsObjects(variant, "Condition")[0] || null;
            return {
                key: `${symbolKey}_${i}`, name: variant.getAttribute("name") || `${name}_${i}`,
                minX: numberFromData(variant, "MinX", 0), minY: numberFromData(variant, "MinY", 0),
                maxX: numberFromData(variant, "MaxX", 0), maxY: numberFromData(variant, "MaxY", 0),
                primitives: directComponentsObjects(variant, "Primitives").map(parsePrimitive).filter(Boolean),
                variantNumber: intFromData(variant, "VariantNumber", i),
                condition: parsePropertyValueCondition(conditionObj),
                // Profile/LabelTemplate entries (Data property="Text", e.g.
                // "<ObjectDisplayName>" or "<SpecialItemNumber>") defined for
                // this symbol variant in the DiscProfile — used as a
                // "Profile labels" source (see resolveProfileLabelFallback()
                // and the labelOverlays second pass below) both (a) as a
                // fallback for a placed instance whose own Label Text
                // carries no AttributeRepresentation Template of its own,
                // and (b) to synthesize an overlay text entirely, for
                // symbols (e.g. a "special item number" balloon) whose
                // instance-drawn "label" is itself another symbol/leader
                // line rather than any Text element at all. Position/
                // Rotation/Alignment/Font/Size/Color are all in the symbol's
                // own local coordinate system, exactly like its Primitives
                // above - see SymbolGraphic's labelOverlays rendering in
                // App.jsx, which draws them inside the same transformed <g>
                // as the symbol's own primitives so the browser's SVG
                // transform composition handles local→world placement.
                labelTemplates: directComponentsObjects(variant, "LabelTemplates").map(lt => ({
                    text: valueFromData(lt, "Text") || "",
                    index: valueFromData(lt, "Index") || "",
                    position: aggregatedValue(getData(lt, "Position")?.firstElementChild) || { x: 0, y: 0 },
                    rotation: numberFromData(lt, "Rotation", 0),
                    alignment: refName(valueFromData(lt, "Alignment")) || "CenterCenter",
                    font: valueFromData(lt, "Font") || "Arial",
                    size: numberFromData(lt, "Size", 3.3),
                    color: aggregatedValue(getData(lt, "Color")?.firstElementChild) || { r: 0, g: 0, b: 0 },
                })),
            };
        });
        map.set(symbolKey, { key: symbolKey, name, variants });
    });
    return map;
}

function inferBoundsFromPrimitives(primitives) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visit = p => { if (!p) return; minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
    primitives.forEach(p => {
        if (p.kind === "polyline" || p.kind === "polygon") p.points.forEach(visit);
        else if (p.kind === "circle") { visit({ x: p.center.x - p.radius, y: p.center.y - p.radius }); visit({ x: p.center.x + p.radius, y: p.center.y + p.radius }); }
        else if (p.kind === "ellipse") { visit({ x: p.center.x - p.rx, y: p.center.y - p.ry }); visit({ x: p.center.x + p.rx, y: p.center.y + p.ry }); }
        else if (p.kind === "rect") { visit({ x: p.center.x - p.width / 2, y: p.center.y - p.height / 2 }); visit({ x: p.center.x + p.width / 2, y: p.center.y + p.height / 2 }); }
        else if (p.kind === "text") visit(p.position);
        else if (p.kind === "ellipseArc") {
            const { center: c, rx, ry, startAngle, endAngle, rotation } = p;
            const toRad = d => d * Math.PI / 180;
            const phiRad = toRad(rotation);
            let span = endAngle - startAngle;
            if (span <= 0) span += 360;
            const steps = Math.max(8, Math.ceil(span / 10));
            for (let i = 0; i <= steps; i++) {
                const a = toRad(startAngle + (span * i) / steps);
                const ca = Math.cos(a), sa = Math.sin(a);
                const cp = Math.cos(phiRad), sp = Math.sin(phiRad);
                visit({ x: c.x + rx * cp * ca - ry * sp * sa, y: c.y + rx * sp * ca + ry * cp * sa });
            }
        }
    });
    if (!Number.isFinite(minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    return { minX, minY, maxX, maxY };
}

export function parseInternalShapeCatalogue(mainDoc) {
    if (!mainDoc) return new Map();
    const map = new Map();
    qsa(mainDoc, 'Object[type="Core/Diagram.ShapeCatalogue"] > Components[property="Shapes"] > Object[type="Core/Diagram.Shape"]').forEach((obj, idx) => {
        const id = obj.getAttribute("id") || `internal_shape_${idx}`;
        const primitives = [
            ...directComponentsObjects(obj, "Elements").map(parsePrimitive),
            ...directComponentsObjects(obj, "Primitives").map(parsePrimitive),
        ].filter(Boolean);
        const bounds = inferBoundsFromPrimitives(primitives);
        const shape = {
            key: id, name: valueFromData(obj, "Name") || id,
            variants: [{ key: `${id}_v0`, name: valueFromData(obj, "Name") || id, ...bounds, primitives }]
        };
        map.set(id, shape); map.set(`#${id}`, shape);
    });
    return map;
}

export function parseNodePositionsById(mainDoc) {
    // Two maps over the same PipingNodePosition/InstrumentationNodePosition
    // objects: byElementId keyed by the position object's own id (used to
    // resolve a Polyline's Source/Target Refs, which point at the position
    // object itself - see ConnectorLineSvg/HeatTraceConnectorLine in
    // App.jsx), and byNodeId keyed by the conceptual PipingNode id it
    // positions (via its own <References property="Node">) - used to show
    // a Node's on-drawing position in the Sub-Components list in App.jsx.
    const byElementId = new Map();
    const byNodeId = new Map();
    qsa(mainDoc, [
        'Object[type="Plant/Diagram.PipingNodePosition"]',
        'Object[type="Plant/Diagram.InstrumentationNodePosition"]',
        'Object[type="Core/Diagram.NodePosition"]'
    ].join(",")).forEach((obj, idx) => {
        const id = obj.getAttribute("id") || `nodePos_${idx}`;
        const position = aggregatedValue(getData(obj, "Position")?.firstElementChild);
        if (!position) return;
        byElementId.set(id, position);
        // Most PipingNodePosition/InstrumentationNodePosition objects carry
        // an explicit Node reference; a few files omit it but still follow
        // the "<nodeId>_PNP" / "<nodeId>_INP" id convention, so fall back to
        // stripping that suffix rather than losing the position entirely.
        const nodeId = referenceTargets(obj, "Node")[0]
            || (/_(PNP|INP)$/.test(id) ? id.replace(/_(PNP|INP)$/, "") : null);
        if (nodeId && !byNodeId.has(nodeId)) byNodeId.set(nodeId, position);
    });
    return { byElementId, byNodeId };
}

export function parseTreeFromConceptual(rootObject) {
    if (!rootObject) throw new Error("ConceptualModel root is missing.");
    function walk(obj, path = []) {
        if (!obj || typeof obj.getAttribute !== "function") return null;
        const id = obj.getAttribute("id") || "";
        const type = obj.getAttribute("type") || "";
        const tagName = valueFromData(obj, "TagName") || valueFromData(obj, "DiscProfile/ItemTag") || "";
        const subTagName = valueFromData(obj, "SubTagName") || "";
        const loopNum = valueFromData(obj, "InstrumentationLoopFunctionNumber") || "";
        const displayName = valueFromData(obj, "DiscProfile/ObjectDisplayName") || "";
        const label = displayName || tagName || loopNum || id || type.split("/").pop();
        const data = directChildrenByTag(obj, "Data").map(d => ({ property: d.getAttribute("property") || "", value: dataValue(d) }));
        const persistentIdentifiers = directComponentsObjects(obj, "PersistentIdentifiers")
            .map(pidObj => ({ context: valueFromData(pidObj, "Context") || "", value: valueFromData(pidObj, "Value") || "" }))
            .filter(pid => pid.context || pid.value);
        const refs = directChildrenByTag(obj, "References").map(r => ({
            property: r.getAttribute("property") || "",
            objects: (r.getAttribute("objects") || "").split(/\s+/).filter(Boolean).map(v => v.startsWith("#") ? v.slice(1) : v)
        }));
        const children = directChildrenByTag(obj, "Components").flatMap((comp, ci) => {
            const prop = comp.getAttribute("property") || `comp_${ci}`;
            return directChildrenByTag(comp, "Object").map((child, i) => {
                const c = walk(child, [...path, `${prop}:${i}`]);
                return c ? { ...c, edgeLabel: prop } : null;
            }).filter(Boolean);
        });
        return { id: id || `${type}_${path.join("_")}`, objectId: id || null, type, label, tagName, subTagName, loopNum, data, persistentIdentifiers, refs, children };
    }
    return walk(rootObject);
}

export function flattenTree(node, arr = []) {
    if (!node) return arr;
    arr.push(node);
    node.children.forEach(c => flattenTree(c, arr));
    return arr;
}

export function findAncestors(node, targetId, trail = [], out = []) {
    if (node.objectId === targetId) out.push(...trail.map(t => t.id));
    node.children.forEach(child => findAncestors(child, targetId, [...trail, node], out));
    return out;
}

export function collectDescendantObjectIds(node, out = new Set()) {
    if (!node) return out;
    if (node.objectId) out.add(node.objectId);
    node.children.forEach(child => collectDescendantObjectIds(child, out));
    return out;
}

// Dash pattern (SVG stroke-dasharray, world units) used to draw a
// SignalConveyingFunction's drawn Core/Diagram.ConnectorLine when its
// DiscProfile custom attribute SignalConveyingFunctionTypeRepresentation
// (ClassExtension SignalConveyingFunctionExtension, rdl_uri ".../Signal-
// ConveyingFunctionTypeRepresentationAssignmentClass" - see e.g.
// ProcessProfile.xml) is the plain, unqualified "SignalConveying" value
// (i.e. no more specific Electrical/Hydraulic/Bus/etc sub-type). Mirrors
// AKSODEXPIViewer's SIGNAL_CONVEYING_DASH_ARRAY convention for the
// equivalent Proteus InformationFlow attribute - see collectGraphicalElements()
// below and App.jsx's SIGNAL_CONVEYING_MARKS for the sub-type glyphs.
const SIGNAL_CONVEYING_DASH_ARRAY = "3 2";

// Label group types: Core/Diagram.Label and all its subtypes in the class model
// (e.g. Plant/Diagram.SafetyValveOrFittingLabel, PipingNetworkSegmentLabel).
const LABEL_CLASS_SUFFIXES = (() => {
    const supers = new Map();
    for (const [cls, sup] of PLANT_HIERARCHY) { if (!supers.has(cls)) supers.set(cls, []); supers.get(cls).push(sup); }
    const isLabel = (cls, seen = new Set()) => {
        if (cls === "Label") return true;
        if (seen.has(cls)) return false;
        seen.add(cls);
        return (supers.get(cls) || []).some(sup => isLabel(sup, seen));
    };
    return new Set([...new Set([...supers.keys(), "Label"])].filter(c => isLabel(c)));
})();
export function isLabelType(type) {
    if (!type || !/^(Core|Plant|Process)\/Diagram\./.test(type)) return false;
    return LABEL_CLASS_SUFFIXES.has(type.split(/[./]/).pop());
}

// Class model used to decide whether an attribute is valid for an object:
// class-name suffix -> Set<attribute name> (Data and Reference properties),
// inherited along superTypes. Seeded from the base Plant model (metaModel.js)
// and extended with the loaded DiscProfile's ConcreteClass/AbstractClass
// declarations and ClassExtensions (keyed on their baseType, e.g.
// ObjectDisplayName added to Plant/Piping.PipingNetworkSystem). Cached per
// profile document.
const classAttributeCache = new WeakMap();
const NO_PROFILE_KEY = {};
export function buildClassAttributeMap(discDoc) {
    const cacheKey = discDoc || NO_PROFILE_KEY;
    if (classAttributeCache.has(cacheKey)) return classAttributeCache.get(cacheKey);
    const supers = new Map();
    const own = new Map();
    const addSuper = (cls, sup) => { if (!cls || !sup) return; if (!supers.has(cls)) supers.set(cls, new Set()); supers.get(cls).add(sup); };
    const addAttr = (cls, name) => { if (!cls || !name) return; if (!own.has(cls)) own.set(cls, new Set()); own.get(cls).add(name); };
    const suffix = v => (v || "").split(/[./]/).pop();
    for (const [cls, sup] of PLANT_HIERARCHY) addSuper(cls, sup);
    for (const [cls, dataCsv, , refCsv] of PLANT_PROPS) {
        for (const csv of [dataCsv, refCsv]) {
            for (const entry of (csv || "").split("|")) addAttr(cls, entry.split(":")[0]);
        }
    }
    if (discDoc?.documentElement) {
        const visit = node => {
            for (const child of Array.from(node.children || [])) {
                const tag = child.tagName;
                if (tag === "Package") { visit(child); continue; }
                let cls = null;
                if (tag === "ConcreteClass" || tag === "AbstractClass") {
                    cls = child.getAttribute("name");
                    (child.getAttribute("superTypes") || "").split(/\s+/).filter(Boolean).forEach(t => addSuper(cls, suffix(t)));
                } else if (tag === "ClassExtension") {
                    cls = suffix(child.getAttribute("baseType"));
                }
                if (!cls) continue;
                for (const prop of Array.from(child.children || [])) {
                    if (prop.tagName === "DataProperty" || prop.tagName === "ReferenceProperty") addAttr(cls, prop.getAttribute("name"));
                }
            }
        };
        visit(discDoc.documentElement);
    }
    const resolved = new Map();
    const resolve = (cls, stack = new Set()) => {
        if (resolved.has(cls)) return resolved.get(cls);
        const out = new Set(own.get(cls) || []);
        stack.add(cls);
        for (const sup of supers.get(cls) || []) if (!stack.has(sup)) resolve(sup, stack).forEach(a => out.add(a));
        stack.delete(cls);
        resolved.set(cls, out);
        return out;
    };
    const map = new Map();
    for (const cls of new Set([...supers.keys(), ...own.keys()])) map.set(cls, resolve(cls));
    classAttributeCache.set(cacheKey, map);
    return map;
}

export function collectGraphicalElements(mainDoc, symbolMap, discDoc = null) {
    const { byElementId: nodePosMap, byNodeId: nodePositionsByNodeId } = parseNodePositionsById(mainDoc);
    const drawn = [];
    const enumAbbreviations = buildEnumAbbreviationMap(discDoc);

    // Build objectId → Map<propertyName, rawDataValue> for condition evaluation,
    // and objectId → type (used by signalConveyingTypeFor() below to restrict
    // the decoration to exactly SignalConveyingFunction, excluding its
    // concrete subtypes MeasuringLineFunction/SignalLineFunction even though
    // they'd inherit the same DiscProfile ClassExtension attribute).
    // Only indexed objects (those with an id attribute) are relevant.
    const objectDataMap = new Map();
    const objectTypeMap = new Map();
    // objectId → [{id, type}, ...] for its nested id-bearing conceptual
    // objects (nearest-enclosing-id-ancestor walk, so e.g. a
    // ProcessInstrumentationFunction's Components/SignalConveyingFunctions
    // child lands here under the PIF's id) - used by resolveProfileLabelFallback()'s
    // "ClassName:<Attribute>" role-path syntax below, since a DISC-added
    // attribute like AlarmValue (or a base attribute like PortStatus) lives
    // on the nested SignalConveyingFunction, not on the PIF the label
    // template itself is attached to.
    //
    // Deliberately requires a real id attribute (Object[id], not every
    // Object) - a nested SignalConveyingFunction etc. with no id of its own
    // is source-data that's missing what the DiscProfile role-path
    // convention requires to be individually addressable, and is treated as
    // "no match" (its label stays suppressed) rather than papered over with
    // an internally-generated id it doesn't actually have in the file.
    const childrenByParentId = new Map();
    // Attribute validity per object class (see buildClassAttributeMap()).
    const classAttributes = buildClassAttributeMap(discDoc);
    // objectId -> its composition parent's id, and objectId -> its plant
    // structure references (ParentStructure / PlantSystem targets) - see
    // structureSources() below.
    const parentIdById = new Map();
    const structureRefsById = new Map();
    // off-page connector id -> ids of its composed ConnectorReference objects
    // (xxOffPageConnectorReferenceByNumber), which carry the connector label's
    // ReferencedDrawingNumber / ReferencedDrawingDescriptor / ReferencedDrawingMainTag
    const connectorRefsById = new Map();
    // equipment id -> ids of its composed Chamber objects (Components
    // property="Chambers", document order) - e.g. the HotSide / ColdSide
    // chambers of a heat exchanger, which carry the design / operating
    // pressures and temperatures an equipment box label (ND0309B) shows.
    const chambersById = new Map();
    qsa(mainDoc, "Object[id]").forEach(el => {
        const id = el.getAttribute("id");
        objectTypeMap.set(id, el.getAttribute("type") || "");
        const props = new Map();
        directChildrenByTag(el, "Data").forEach(d => {
            const prop = d.getAttribute("property");
            if (prop) props.set(prop, dataValue(d));
        });
        // Enumeration values held as a reference to a profile literal (see enumReferenceValues()).
        enumReferenceValues(el).forEach(([prop, v]) => { if (!props.has(prop)) props.set(prop, v); });
        if (props.size) objectDataMap.set(id, props);

        let p = el.parentNode;
        while (p && (typeof p.getAttribute !== "function" || !p.getAttribute("id"))) p = p.parentNode;
        const parentId = p && typeof p.getAttribute === "function" ? p.getAttribute("id") : null;
        if (parentId) {
            if (!childrenByParentId.has(parentId)) childrenByParentId.set(parentId, []);
            childrenByParentId.get(parentId).push({ id, type: el.getAttribute("type") || "" });
            parentIdById.set(id, parentId);
            const holder = el.parentNode;
            if (holder && typeof holder.getAttribute === "function" && holder.getAttribute("property") === "ConnectorReference") {
                if (!connectorRefsById.has(parentId)) connectorRefsById.set(parentId, []);
                connectorRefsById.get(parentId).push(id);
            }
            if (holder && typeof holder.getAttribute === "function" && holder.getAttribute("property") === "Chambers") {
                if (!chambersById.has(parentId)) chambersById.set(parentId, []);
                chambersById.get(parentId).push(id);
            }
        }
        const structureRefs = {
            parentStructure: referenceTargets(el, "ParentStructure"),
            plantSystem: referenceTargets(el, "PlantSystem"),
        };
        if (structureRefs.parentStructure.length || structureRefs.plantSystem.length) structureRefsById.set(id, structureRefs);

    });

    // Resolve a raw Data value (plain string, or a DataReference to an
    // enumeration literal) down to its bare name - used for the signal-
    // conveying lookup below, which needs the full representation name
    // (e.g. "ElectricalSignalConveying"), unlike instanceLiteralValue()'s
    // bare-literal-name resolution used for SymbolVariant conditions.
    function rawStringValue(raw) {
        if (raw === null || raw === undefined) return null;
        if (typeof raw === "string") return raw;
        if (raw?.kind === "DataReference") return raw.value.split(".").pop().split("/").pop();
        return null;
    }

    // ---------------------------------------------------------------------
    // "Profile labels" support: for a symbol placed from the loaded
    // DiscProfile.xml catalogue, App.jsx's "Profile labels" checkbox forces
    // the label's displayed text to come from a referenced Attribute value
    // rather than the instance's own literal <String> Text - either (a) the
    // AttributeRepresentation Template already carried by the instance's own
    // Label Text (see parseTextTemplateFragments() above), or (b), when the
    // instance Text has no such Template, the matching DiscProfile Profile/
    // Symbol variant's own LabelTemplate (see parseSymbolCatalogue() above).
    // Both resolve down to a single computed `profileText` string per label
    // Text primitive - see the second pass at the bottom of this function.
    // ---------------------------------------------------------------------

    // Look up objectId's Data property directly, tolerating the same
    // DiscProfile/, bare, and Plant-prefixed spellings used elsewhere in
    // this file. No traversal - just this one object.
    function ownProperty(objectId, attributeName) {
        if (!objectId || !attributeName) return undefined;
        const props = objectDataMap.get(objectId);
        if (!props) return undefined;
        const bare = attributeName.split("/").pop();
        return props.get(attributeName) ?? props.get(bare) ?? props.get(`DiscProfile/${bare}`);
    }

    // Is attributeName a valid attribute (Data or Reference property, own,
    // inherited or added by a DiscProfile ClassExtension) of objectId's class?
    // An object whose class isn't in the class model at all is not restricted.
    // Tool-specific attribute names (e.g. "SPPID: ItemTag") are never valid.
    function isAttributeValidFor(objectId, attributeName) {
        if (!objectId || !attributeName) return false;
        const cls = (objectTypeMap.get(objectId) || "").split(/[./]/).pop();
        const attrs = cls ? classAttributes.get(cls) : null;
        if (!attrs) return true;
        return attrs.has(attributeName.split("/").pop());
    }

    // A label shows an attribute ONLY from the object the label itself names
    // for it, and only when that attribute is valid for that object's class -
    // no search through nested children or references (that used to pick up
    // e.g. a segment's TargetItem nozzle tag "N05" for a line label's
    // <ObjectDisplayName> when the segment itself has none).
    function lookupProperty(objectId, attributeName) {
        if (!isAttributeValidFor(objectId, attributeName)) return undefined;
        return ownProperty(objectId, attributeName);
    }

    // A label shows attributes of the component it labels (representedId)
    // only - e.g. an ND0040 line label on a PipingNetworkSegment reads the
    // SEGMENT's ObjectDisplayName and shows nothing when the segment has none,
    // even if the label's AttributeRepresentation points at another object
    // (such as the segment's PipingNetworkSystem). References to a Core/Note
    // are the only exception (note flags are not component attributes).
    function isLabelReferenceAllowed(representedId, objectId) {
        if (!representedId || !objectTypeMap.has(representedId)) return true; // label of no component
        if (objectId === representedId) return true;
        if (structureSources(representedId).includes(objectId)) return true;
        if ((connectorRefsById.get(representedId) || []).includes(objectId)) return true;
        // the component's own Chambers (a heat exchanger label's hot/cold side values)
        if ((chambersById.get(representedId) || []).includes(objectId)) return true;
        if (isRoleChildOf(representedId, objectId)) return true;
        return objectTypeMap.get(objectId) === "Core/Note";
    }

    // An object nested in the component whose class the component's symbol
    // label templates name as a role path ("ClassName:<Attr>", e.g. the
    // SignalConveyingFunction behind "'HH=' & SignalConveyingFunction:
    // <AlarmValue>") - the same objects pickRoleChild() chooses from.
    const roleNamesCache = new Map();
    function roleNamesFor(representedId) {
        if (roleNamesCache.has(representedId)) return roleNamesCache.get(representedId);
        const names = new Set();
        (discSymbolsByRepresentedId.get(representedId) || []).forEach(sym => (sym.variants || []).forEach(v => (v.labelTemplates || []).forEach(lt => {
            const re = /([A-Za-z][A-Za-z0-9_]*):</g;
            let m;
            while ((m = re.exec(lt.text || "")) !== null) names.add(m[1]);
        })));
        roleNamesCache.set(representedId, names);
        return names;
    }
    function isRoleChildOf(representedId, objectId) {
        if (!objectId || parentIdById.get(objectId) !== representedId) return false;
        return roleNamesFor(representedId).has((objectTypeMap.get(objectId) || "").split(/[./]/).pop());
    }

    // The plant structure items a component's label may also read from - the
    // objects it reaches through its own PlantSystem reference and its
    // ParentStructure reference (followed up the ParentStructure chain, e.g.
    // PlantArea -> ProcessPlant). E.g. an instrument bubble's
    // <ProcessPlantIdentificationCode> comes from the ProcessPlant and
    // <PlantSystemIdentificationCode> from the PlantSystem. A component that
    // carries neither reference itself (e.g. a valve inside a
    // PipingNetworkSystem) uses its nearest composition owner that does.
    const structureSourcesCache = new Map();
    function structureSources(componentId) {
        if (structureSourcesCache.has(componentId)) return structureSourcesCache.get(componentId);
        let holder = componentId;
        while (holder && !structureRefsById.has(holder)) holder = parentIdById.get(holder);
        const out = [];
        if (holder) {
            const refs = structureRefsById.get(holder);
            const queue = [...refs.plantSystem, ...refs.parentStructure];
            while (queue.length) {
                const id = queue.shift();
                if (!id || out.includes(id) || !objectTypeMap.has(id)) continue;
                out.push(id);
                queue.push(...(structureRefsById.get(id)?.parentStructure || []));
            }
        }
        structureSourcesCache.set(componentId, out);
        return out;
    }

    // Hot / cold side of an equipment box (ND0309B heat exchanger: the 1st
    // occurrence of a repeated template is the hot side, the 2nd the cold
    // side) is picked by the Chamber's ChamberFunction, not document order:
    //   hot side  -> ChamberFunctionClassification.Cooling
    //   cold side -> ChamberFunctionClassification.Heating
    // Falls back to the Nth Chamber when none carries the expected function.
    const CHAMBER_SIDE_FUNCTIONS = ["Cooling", "Heating"];
    function chamberFunctionOf(chamberId) {
        const raw = ownProperty(chamberId, "ChamberFunction");
        const ref = typeof raw === "string" ? raw : (raw && raw.value) || "";
        return String(ref).split(".").pop();
    }
    function chamberForSide(componentId, n) {
        const chambers = chambersById.get(componentId) || [];
        const want = CHAMBER_SIDE_FUNCTIONS[n];
        const byFunction = want ? chambers.find(id => chamberFunctionOf(id) === want) : undefined;
        if (byFunction) return byFunction;
        // no Chamber with this side's function: take the Nth of the Chambers
        // not claimed by another side's function, so one Chamber never feeds
        // both the hot and the cold side rows
        const claimed = new Set(CHAMBER_SIDE_FUNCTIONS
            .map((f, i) => i === n ? undefined : chambers.find(id => chamberFunctionOf(id) === f))
            .filter(Boolean));
        const free = chambers.filter(id => !claimed.has(id));
        const sidesBefore = CHAMBER_SIDE_FUNCTIONS.slice(0, n)
            .filter((f, i) => !chambers.some(id => chamberFunctionOf(id) === CHAMBER_SIDE_FUNCTIONS[i])).length;
        return free[sidesBefore];
    }

    // Value of a label placeholder: the component's own attribute, else the
    // same attribute on one of its plant structure items (structureSources()),
    // each only when the attribute is valid for that object's class.
    // chamberIndex (0-based) picks one specific Chamber of the component for
    // attributes the component itself doesn't carry - see the third pass
    // below: a LabelTemplate repeated in the same symbol variant (ND0309B's
    // "<LowerLimitDesignPressure> & ..." line once for the hot side, once for
    // the cold side) reads its Nth occurrence from the Chamber chosen by
    // chamberForSide() (Cooling = hot side, Heating = cold side). null =
    // the first Chamber that has the attribute.
    function componentAttribute(componentId, attributeName, chamberIndex = null) {
        const own = lookupProperty(componentId, attributeName);
        if (own !== undefined) return own;
        // a value the component itself carries for a label template attribute
        // (only template placeholders reach here, never tool-specific names
        // like "SPPID: ItemTag") is shown even when the loaded profile's class
        // model does not list it for the component's class - e.g. an ND0040
        // line label's <ObjectDisplayName> on a PipingNetworkSegment (the
        // profile only extends PipingNetworkSystem with it). The value is
        // never taken from the segment's PipingNetworkSystem or any other
        // owner: the label's referenced item is the segment itself.
        const ownData = ownProperty(componentId, attributeName);
        if (ownData !== undefined) return ownData;
        for (const id of (connectorRefsById.get(componentId) || [])) {
            const v = lookupProperty(id, attributeName);
            if (v !== undefined) return v;
        }
        const chambers = chambersById.get(componentId) || [];
        if (chamberIndex !== null) {
            // a repeated template with no Chamber left for it stays blank
            // rather than repeating another chamber's values
            if (chambers.length) {
                const id = chamberForSide(componentId, chamberIndex);
                return id ? lookupProperty(id, attributeName) : undefined;
            }
        } else {
            for (const id of chambers) {
                const v = lookupProperty(id, attributeName);
                if (v !== undefined) return v;
            }
        }
        for (const id of structureSources(componentId)) {
            const v = lookupProperty(id, attributeName);
            if (v !== undefined) return v;
        }
        return undefined;
    }

    // Render a resolved Data value (string / number / boolean / DataReference /
    // PhysicalQuantity / SingleLanguageString) down to display text, honouring
    // an AttributeRepresentation fragment's Type (Value | Units | ValueAndUnits).
    // decimals (optional): numeric values (numbers and PhysicalQuantity
    // values) are shown with exactly this many decimals - the equipment box
    // value columns (ND0300B..ND0310B) use 1, e.g. 130 -> "130.0".
    function formatNumber(v, decimals) {
        const n = typeof v === "number" ? v : (typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
        if (decimals === null || decimals === undefined || !Number.isFinite(n)) return String(v);
        // round half away from zero on the decimal value (56.55 -> 56.6), not
        // on its binary approximation as toFixed() alone does (-> 56.5)
        const r = Math.sign(n) * Number(Math.round(Number(Math.abs(n) + "e" + decimals)) + "e-" + decimals);
        return r.toFixed(decimals);
    }
    // Full vacuum: a pressure label shows the literal "FV" (the P&ID / data
    // sheet convention) instead of the number - a gauge pressure of -1 atm
    // (-1.01325 barg, also accepting the usual rounded -1.0 / -1.013 barg,
    // i.e. within 1.5%) or an absolute pressure of 0.
    const FULL_VACUUM_GAUGE = { Bar: -1.01325, Millibar: -1013.25, Kilopascal: -101.325, Megapascal: -0.101325, Pascal: -101325, PoundForcePerInchSquared: -14.6959 };
    function isFullVacuum(value, unitRef) {
        const n = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(n) || !unitRef) return false;
        const [unitType, literal] = String(unitRef).split("/").pop().split(".").slice(-2);
        if (unitType === "PressureAbsoluteUnit") return n === 0;
        if (unitType !== "PressureGaugeUnit" || !(literal in FULL_VACUUM_GAUGE)) return false;
        const fv = FULL_VACUUM_GAUGE[literal];
        return Math.abs(n - fv) <= Math.abs(fv) * 0.015;
    }
    // Set point (SP = ) and alarm (H/HH/L/LL=) labels always show the value's
    // unit of measure (e.g. "SP = 6 barg"), whatever the template or the
    // instance AttributeRepresentation Type asks for.
    const UNIT_LABEL_ATTRIBUTES = new Set(["SetPoint", "AlarmValue"]);
    function labelRepType(attributeName, repType) {
        const bare = String(attributeName || "").split("/").pop().replace(/AssignmentClass$/, "");
        return UNIT_LABEL_ATTRIBUTES.has(bare) && repType !== "Units" ? "ValueAndUnits" : repType;
    }
    function fragmentValueToText(raw, repType, decimals = null) {
        if (raw === null || raw === undefined) return "";
        if (typeof raw === "string") return raw;
        if (typeof raw === "number") return formatNumber(raw, decimals);
        if (typeof raw === "boolean") return raw ? "true" : "false";
        if (raw.kind === "DataReference") return enumDisplayName(raw, enumAbbreviations);
        if (raw.kind === "PhysicalQuantity") {
            if (isFullVacuum(raw.value, raw.unitRef)) return repType === "Units" ? "" : "FV";
            const val = raw.value !== null && raw.value !== undefined && raw.value !== "" ? formatNumber(raw.value, decimals) : "";
            if (repType === "Units") return raw.unit || "";
            // a quantity with no value shows nothing - not its unit on its own
            // (a SetPoint with only a Unit must not give "SP = barg")
            if (repType === "ValueAndUnits") return val ? [val, raw.unit].filter(Boolean).join(" ") : "";
            return val;
        }
        if (typeof raw === "object" && typeof raw.value === "string") return raw.value; // SingleLanguageString
        if (typeof raw === "object" && raw.kind === "AggregatedValue") return "";
        return String(raw);
    }

    // Resolve a Text primitive's raw templateFragments (see
    // parseTextTemplateFragments()) into the final display string, or null
    // when there is no Template at all.
    function resolveTemplateFragments(fragments) {
        if (!fragments || !fragments.length) return null;
        return fragments.map(f => {
            if (f.kind === "literal") return f.text || "";
            if (f.kind === "attr") return fragmentValueToText(lookupProperty(f.objectId, f.attributeName), labelRepType(f.attributeName, f.repType));
            return "";
        }).join("");
    }

    // A SignalConveyingFunction's (base DEXPI, non-DiscProfile) PortStatus
    // attribute classifies which alarm/status level it conveys - see
    // Plant.xml's PortStatusClassification enumeration. DiscProfile label
    // templates don't carry this as structured data (Profile/LabelTemplate
    // has no Condition-like property), only as a literal "H=", "HH=", "L=",
    // or "LL=" prefix in the template's own Text - extractPortStatusHint()
    // below recovers the intended classification from that prefix so
    // pickRoleChild() can pick the SignalConveyingFunction that actually
    // carries the matching PortStatus, instead of guessing positionally.
    // Longest-prefix-first so "HHH=" isn't misread as "HH=" then "H=".
    const PORT_STATUS_HINTS = {
        HHH: "StatusHighHighHighPort", HH: "StatusHighHighPort", H: "StatusHighPort",
        LLL: "StatusLowLowLowPort", LL: "StatusLowLowPort", L: "StatusLowPort",
    };
    function extractPortStatusHint(text) {
        const m = /^\s*(HHH|HH|H|LLL|LL|L)\s*=/.exec(text || "");
        return m ? PORT_STATUS_HINTS[m[1]] : null;
    }

    // Picks the child of parentId whose type suffix matches roleName (e.g.
    // "SignalConveyingFunction") that should supply a "ClassName:<Attr>"
    // role-path reference's value.
    //
    // When portStatusHint is given (see extractPortStatusHint() above), ONLY
    // a child whose own PortStatus attribute matches that hint counts - e.g.
    // an "HH=" template's SignalConveyingFunction:<AlarmValue> requires a
    // child whose PortStatus is StatusHighHighPort specifically. No
    // positional fallback in this case: if the ProcessInstrumentationFunction
    // has no SignalConveyingFunction with that exact PortStatus, this
    // returns null (and resolveProfileLabelFallback() below then suppresses
    // the whole H/HH/L/LL label entirely) - guessing at some OTHER alarm's
    // signal by document position would show the wrong value, which is worse
    // than showing nothing.
    //
    // Without a hint (a role-path with no H/HH/L/LL-style prefix), falls
    // back to positional pairing: the Nth reference to this same roleName
    // among the symbol's LabelTemplates (tracked via the caller-shared
    // roleCounters) picks the Nth same-class child in document order - kept
    // for any other "ClassName:<Attr>" convention that doesn't carry a
    // disambiguating attribute like PortStatus.
    function pickRoleChild(parentId, roleName, roleCounters, portStatusHint) {
        if (!parentId) return null;
        const matches = (childrenByParentId.get(parentId) || []).filter(c => c.type && c.type.split(/[./]/).pop() === roleName);
        if (!matches.length) return null;
        if (portStatusHint) {
            const byStatus = matches.find(c => refName(ownProperty(c.id, "PortStatus")) === portStatusHint);
            return byStatus ? byStatus.id : null;
        }
        const idx = roleCounters[roleName] || 0;
        roleCounters[roleName] = idx + 1;
        return (matches[idx] || matches[matches.length - 1]).id;
    }

    // Turns a VB-style LabelTemplate formula into plain template text:
    // parts joined by "&" outside quotes are concatenated, a quoted part
    // keeps its inner text verbatim (spaces included), unquoted parts are
    // trimmed. Unbalanced edge quotes from older profiles ("H=' & ...")
    // are dropped. Text with no "&" and no quotes is returned unchanged.
    function unwrapLabelFormula(text) {
        // Only a quoted literal makes a formula: "<A> & <B> / <C>" (the
        // ND0300B..ND0309B equipment box design pressure/temperature lines)
        // has no quotes, so its "&" is plain text shown between the values.
        if (!/'/.test(text)) return text;
        if ((text.match(/'/g) || []).length % 2) return text.replace(/'\s*&\s*/g, "").replace(/^'|'$/g, "");
        const parts = [];
        let cur = "", inQuote = false;
        for (const ch of text) {
            if (ch === "'") { inQuote = !inQuote; cur += ch; }
            else if (ch === "&" && !inQuote) { parts.push(cur); cur = ""; }
            else cur += ch;
        }
        parts.push(cur);
        return parts.map(part => {
            const t = part.trim();
            const m = /^'([^']*)'$/.exec(t);
            if (m) return m[1];
            return t.replace(/^'|'$/g, "");
        }).join("");
    }

    // Fallback for a DiscProfile-symbol label whose own Text carries no
    // Template: substitute <PlaceholderName> tokens in the matching symbol
    // variant's Profile/LabelTemplate.Text against the Data properties of the
    // object the label names for each attribute. Handles two placeholder forms:
    //   <AttributeName>                 e.g. "<ObjectDisplayName>",
    //                                    "<ProcessPlantIdentificationCode>-<PlantSystemIdentificationCode>"
    //                                    - read from representedId (the component
    //                                    the label belongs to) or, failing that,
    //                                    the plant structure items it references
    //                                    (ParentStructure chain / PlantSystem, see
    //                                    structureSources()), only where the
    //                                    attribute is valid for that object's
    //                                    class (lookupProperty()); otherwise blank.
    //   ClassName:<AttributeName>       e.g. "H=' & SignalConveyingFunction:<AlarmValue>"
    //                                    - some DISC-added attributes (like
    //                                    AlarmValue, a ClassExtension on
    //                                    Plant/Instrumentation.SignalConveyingFunction)
    //                                    only make sense on a SPECIFIC nested
    //                                    child of a given class, not just
    //                                    "whichever nearby object happens to
    //                                    have it" - the "ClassName:" prefix
    //                                    picks that child explicitly via
    //                                    pickRoleChild() above (by PortStatus
    //                                    when available, else positionally).
    //
    // roleCounters is an object the caller shares across every LabelTemplate
    // belonging to the same symbol placement, so positional pairing (the
    // pickRoleChild() fallback) advances correctly across e.g. a symbol's
    // H/HH/L/LL templates instead of every one reusing the first match.
    function resolveProfileLabelFallback(rawLabelTemplateText, representedId, roleCounters = {}, chamberIndex = null, decimals = null) {
        if (!rawLabelTemplateText) return null;
        // Some DiscProfile.xml LabelTemplate.Text values embed a VB-style
        // string-concatenation formula fragment, e.g.
        // "H=' & SignalConveyingFunction:<AlarmValue>" - the "' & " in the
        // middle is formula syntax (a string literal's closing quote plus
        // the "&" concatenation operator), not text meant to be shown. Strip
        // it so the literal "H=" prefix runs directly into the resolved
        // value (e.g. "H=100"), not "H=' & 100".
        // Newer profiles (e.g. DISCDEXPI_2026Pack, symbols ND0006/ND0270/
        // ND0271) quote the literal on BOTH sides - "'SP = ' & <SetPoint>",
        // "'H=' & SignalConveyingFunction:<AlarmValue>" - so the opening
        // quote must go too, not just the "' & " joint; otherwise the label
        // renders as "'SP = 5". See unwrapLabelFormula() above.
        const labelTemplateText = unwrapLabelFormula(rawLabelTemplateText);
        if (!/[<>]/.test(labelTemplateText)) return labelTemplateText;
        const portStatusHint = extractPortStatusHint(labelTemplateText);
        // Only ONE failure mode suppresses the whole template (returns null
        // instead of rendering with the unresolved token silently blanked,
        // e.g. leaving a dangling "H=' & " from the surrounding literal
        // text): a "ClassName:<Attr>" role-path with NO matching related
        // object at all (e.g. an "H=" template whose PIF has no
        // SignalConveyingFunction with PortStatus StatusHighPort) -
        // pickRoleChild() returns null - since there's no right answer to
        // show for that placeholder.
        //
        // A bare "<Attr>" whose value isn't present ANYWHERE reachable from
        // representedId does NOT suppress the template - it just renders as
        // blank for that one placeholder. Several DiscProfile LabelTemplates
        // concatenate multiple independent fields into a single line (e.g.
        // "<ProcessPlantIdentificationCode>-<PlantSystemIdentificationCode>,
        // <TagType>,<Sequence><TagSuffix>"), and one field genuinely not
        // being modelled on this instance (e.g. a ClampOn with no
        // ParentStructure reference, so ProcessPlantIdentificationCode can't
        // be reached at all) shouldn't blank out the OTHER fields in that
        // same line that DID resolve (TagType, Sequence, ...). A template
        // that ends up fully empty falls out naturally anyway, since the
        // caller filters out any resulting empty-string overlay.
        //
        // Once a role-path target IS found, a missing/blank attribute ON IT
        // likewise does NOT suppress - e.g. the correctly-matched
        // StatusHighPort SignalConveyingFunction simply not having an
        // AlarmValue yet still shows its "H=" label (just with nothing
        // after the "="), since finding the right signal is what matters,
        // not whether it's been dimensioned. Same for a bare placeholder
        // that resolves to a property which legitimately exists but holds
        // an empty string (e.g. DiscProfile/TagSuffix="") - that's a
        // successful resolution.
        let unresolved = false;
        // Template literals (e.g. the "-" in "<ProcessPlantIdentificationCode>-
        // <PlantSystemIdentificationCode>", or "SP = ") are only shown next to
        // at least one resolved value - a line whose attributes are all blank
        // is suppressed rather than showing its separators/prefix on their own.
        let anyValue = false;
        const text = labelTemplateText.replace(/(?:([A-Za-z][A-Za-z0-9_]*):)?<([^<>]+)>/g, (_m, roleName, attrName) => {
            if (roleName) {
                const targetId = pickRoleChild(representedId, roleName, roleCounters, portStatusHint);
                if (targetId === null) { unresolved = true; return ""; }
                // Direct-only lookup on the specific role child pickRoleChild()
                // just matched (e.g. the SignalConveyingFunction whose own
                // PortStatus is StatusHighHighPort) - NOT lookupProperty()'s
                // wider neighbor search. Once a role-path has picked out one
                // specific sibling among several same-class children (e.g.
                // three SignalConveyingFunctions - one per H/HH/L/LL - all
                // hanging off the same parent), searching neighbors for a
                // missing attribute would find it on a DIFFERENT sibling
                // instead (e.g. HH's SignalConveyingFunction has no
                // AlarmValue of its own, but L's does, and they share the
                // same parent) - bleeding L's value into HH's label. A
                // missing attribute on the matched object should read as
                // blank, not "search elsewhere".
                // the connected object exists (e.g. the SignalConveyingFunction
                // with the matching PortStatus): show the template line - at
                // least its literal ("HH=") - plus the value with its units
                // once the object has one
                anyValue = true;
                return fragmentValueToText(lookupProperty(targetId, attrName), "ValueAndUnits");
            }
            // A bare placeholder renders blank when unresolved, rather than
            // suppressing the whole (possibly multi-field) template - see
            // the comment above.
            const valueText = fragmentValueToText(componentAttribute(representedId, attrName, chamberIndex), labelRepType(attrName, "Value"), decimals);
            if (valueText) anyValue = true;
            return valueText;
        });
        if (unresolved || !anyValue) return null;
        return text;
    }

    // Computes primitive.profileText (from its own Template, if any) right
    // where each text primitive is created - the DiscProfile-symbol-ownership
    // check and the Profile/LabelTemplate fallback for Templateless labels
    // both happen afterwards, in the second pass below, once the full drawn[]
    // array (including every Profile/SymbolUsage) is available.
    function attachProfileText(prim) {
        if (prim && prim.kind === "text") prim.profileText = resolveTemplateFragments(prim.templateFragments);
        return prim;
    }

    // Reads a SignalConveyingFunction conceptual object's DiscProfile
    // SignalConveyingFunctionTypeRepresentation custom attribute, if present.
    // Deliberately restricted to the exact type Plant/Instrumentation.
    // SignalConveyingFunction - its concrete subtypes MeasuringLineFunction
    // and SignalLineFunction are excluded even if they happen to carry the
    // same (inherited) attribute, since the line-style decoration only
    // applies to SignalConveyingFunction itself. Tries the same property-name
    // variants pickVariant() below tolerates for DiscProfile-authored
    // instance data (bare name, "DiscProfile/"-prefixed, or plant-namespace-
    // prefixed). Only ever returns a value for objects the DiscProfile
    // extension was actually applied and populated to - absent otherwise.
    function signalConveyingTypeFor(representedId) {
        if (!representedId) return null;
        if (objectTypeMap.get(representedId) !== "Plant/Instrumentation.SignalConveyingFunction") return null;
        const props = objectDataMap.get(representedId);
        if (!props) return null;
        const raw = props.get("SignalConveyingFunctionTypeRepresentation")
            ?? props.get("DiscProfile/SignalConveyingFunctionTypeRepresentation")
            ?? props.get("Plant/Instrumentation.SignalConveyingFunctionTypeRepresentation")
            ?? null;
        return rawStringValue(raw);
    }

    // Resolve a raw instance property value (plain String, or a DataReference
    // to an enumeration literal) down to its bare literal name, e.g. a
    // DataReference data="DiscProfile/InformationModel.ValvePosition.NormallyClose"
    // → "NormallyClose" — the same bare form parsePropertyValueCondition()
    // extracts from the profile's own Condition.Value string, so the two can
    // be compared directly without any abbreviation/short-code layer.
    function instanceLiteralValue(rawVal) {
        if (rawVal === null || rawVal === undefined) return null;
        if (typeof rawVal === "string") return rawVal.split(/[./]/).pop();
        if (rawVal?.kind === "DataReference") return rawVal.value.split(/[./]/).pop();
        return String(rawVal);
    }

    // Select the best matching SymbolVariant for the given conceptual object.
    // Evaluates each conditional variant's Profile/PropertyValueCondition
    // (attributeName/literalValue, from parsePropertyValueCondition() in
    // parseSymbolCatalogue() above) against the object's own properties -
    // e.g. a WedgeGateValve instance whose ValvePosition attribute resolves
    // to the literal "NormallyClose" picks the variant whose Condition names
    // Property "...OperatedValveExtension.ValvePosition" and Value
    // "...ValvePosition.NormallyClose" (DiscProfile.xml's ND0012 Variant 1).
    // Falls back to the unconditional variant (variantNumber 0 / no condition) if none match.
    function pickVariant(symbol, representedId) {
        if (!symbol?.variants?.length) return null;
        if (symbol.variants.length === 1) return symbol.variants[0];

        const props = representedId ? (objectDataMap.get(representedId) || new Map()) : new Map();

        // Try conditional variants first (those with a parsed condition)
        for (const variant of symbol.variants) {
            if (!variant.condition) continue;
            const { attributeName, literalValue: expectedValue } = variant.condition;
            // Try common property-name prefixes: DiscProfile/, bare name, or plant-prefixed
            const rawVal = props.get(`DiscProfile/${attributeName}`)
                ?? props.get(attributeName)
                ?? props.get(`Plant/Piping.${attributeName}`)
                ?? props.get(`Plant/Instrumentation.${attributeName}`)
                ?? null;
            if (rawVal === null) continue;
            if (instanceLiteralValue(rawVal) === expectedValue) return variant;
        }

        // No condition matched — return the default (unconditional) variant, or first as fallback
        return symbol.variants.find(v => !v.condition) ?? symbol.variants[0];
    }

    function resolveRepresentedId(node, fallback = null) { return referenceTargets(node, "Represents")[0] || fallback; }

    function resolveShapeReference(ref) {
        if (!ref) return null;
        return symbolMap.get(ref)
            || symbolMap.get(ref.startsWith("#") ? ref.slice(1) : `#${ref}`)
            || symbolMap.get(`DiscProfile/${ref.split("/").pop()}`)
            || null;
    }

    // elementRole: "symbol" | "label" | "connector" — used for selective highlight colouring in App.jsx
    function pushSymbolUsage(rawRef, el, representedId, key, elementRole = "symbol") {
        const symbol = resolveShapeReference(rawRef);
        const variant = pickVariant(symbol, representedId);
        if (!variant) return;
        drawn.push({
            kind: "symbolUsage", key, representedId, elementRole, symbol, variant,
            position: aggregatedValue(getData(el, "Position")?.firstElementChild) || { x: 0, y: 0 },
            rotation: numberFromData(el, "Rotation", 0),
            scaleX: numberFromData(el, "ScaleX", 1),
            scaleY: numberFromData(el, "ScaleY", 1),
            isMirrored: !!valueFromData(el, "IsMirrored")
        });
    }

    // A RepresentationGroup can be reached two ways: the top-level qsa()
    // below matches EVERY RepresentationGroup in the document regardless of
    // nesting depth, while traverseGroup() itself also recurses into each
    // group's own nested Groups children - which are frequently
    // RepresentationGroups too (e.g. a multi-part symbol's outer group
    // containing per-part sub-groups). Without deduplication, a group
    // nested N levels deep gets traversed once per ancestor level PLUS once
    // for its own direct qsa() match - e.g. 2 levels of RepresentationGroup
    // nesting above a symbol produces 3 separate traversals of its content
    // (the symbol's own qsa() match, plus once via recursion from each
    // ancestor's qsa() match), silently tripling every SymbolUsage, Label
    // SymbolUsage, and Text primitive inside it. Tracking already-traversed
    // nodes here - by DOM node identity, not id (RepresentationGroups don't
    // reliably carry one) - guarantees each one is only ever processed once,
    // regardless of how many redundant paths reach it.
    const visitedGroups = new WeakSet();
    function traverseGroup(groupNode, currentRepresents = null, keyPrefix = "g") {
        if (visitedGroups.has(groupNode)) return;
        visitedGroups.add(groupNode);
        // If this group node is itself a Core/Diagram.Label, everything inside it
        // is annotation text and should highlight orange (elementRole "label"),
        // not the primary red used for symbol outlines.
        const groupType = groupNode.getAttribute ? (groupNode.getAttribute("type") || "") : "";
        const isLabelGroup = isLabelType(groupType);

        const localRepresents = resolveRepresentedId(groupNode, currentRepresents);
        directComponentsObjects(groupNode, "Elements").forEach((el, i) => {
            const type = el.getAttribute("type") || "";
            if (type === "Profile/SymbolUsage") {
                pushSymbolUsage(referenceTargets(el, "Symbol")[0] || null, el, localRepresents, `${keyPrefix}_su_${i}`, isLabelGroup ? "label" : "symbol");
            } else if (type === "Core/Diagram.ShapeUsage") {
                pushSymbolUsage(referenceTargets(el, "Shape")[0] || null, el, localRepresents, `${keyPrefix}_shu_${i}`, isLabelGroup ? "label" : "symbol");
            } else if (isLabelType(type)) {
                // Label as a direct Element child (less common â€" most files put Labels in Groups)
                const labelRepresents = resolveRepresentedId(el, localRepresents);
                directComponentsObjects(el, "Elements").forEach((lel, li) => {
                    const lt = lel.getAttribute("type") || "";
                    if (lt === "Core/Diagram.Text" || lt === "Core/Diagram.LiteralText" || lt === "Core/Diagram.AttributeRepresentation") {
                        const prim = attachProfileText(parsePrimitive(lel, li));
                        if (prim) drawn.push({ kind: "primitive", primitive: prim, representedId: labelRepresents, elementRole: "label", key: `${keyPrefix}_lbltxt_${i}_${li}` });
                    } else if (lt === "Core/Diagram.ShapeUsage") {
                        pushSymbolUsage(referenceTargets(lel, "Shape")[0] || null, lel, labelRepresents, `${keyPrefix}_lblshape_${i}_${li}`, "label");
                    } else if (lt === "Profile/SymbolUsage") {
                        pushSymbolUsage(referenceTargets(lel, "Symbol")[0] || null, lel, labelRepresents, `${keyPrefix}_lblsym_${i}_${li}`, "label");
                    }
                });
            } else {
                const prim = attachProfileText(parsePrimitive(el, i));
                if (!prim) return;
                if (prim.kind === "connectorLine") {
                    // SignalConveyingFunction connector lines (only that exact
                    // type - not its concrete subtypes MeasuringLineFunction/
                    // SignalLineFunction, see signalConveyingTypeFor() above) are
                    // decorated per the DiscProfile SignalConveyingFunctionTypeRepresentation
                    // attribute - the raw value is carried through onto the drawn element
                    // for App.jsx's SIGNAL_CONVEYING_MARKS to interpret, and the plain
                    // "SignalConveying" value (no more specific sub-type) additionally
                    // forces a dashed line here (see SIGNAL_CONVEYING_DASH_ARRAY above).
                    const signalConveyingType = signalConveyingTypeFor(localRepresents);
                    if (signalConveyingType === "SignalConveying") {
                        prim.stroke = { ...prim.stroke, dashArray: SIGNAL_CONVEYING_DASH_ARRAY };
                    }
                    drawn.push({ kind: "connectorLine", primitive: prim, representedId: localRepresents, elementRole: "connector", key: `${keyPrefix}_cl_${i}`, signalConveyingType: signalConveyingType || undefined });
                } else {
                    drawn.push({ kind: "primitive", primitive: prim, representedId: localRepresents, elementRole: isLabelGroup ? "label" : "symbol", key: `${keyPrefix}_p_${i}` });
                }
            }
        });
        directComponentsObjects(groupNode, "Groups").forEach((child, i) => traverseGroup(child, localRepresents, `${keyPrefix}_${i}`));
    }

    qsa(mainDoc, 'Object[type="Core/Diagram.RepresentationGroup"]').forEach((g, i) => traverseGroup(g, null, `rg_${i}`));
    // Static / Label groups placed directly in the Diagram's Groups (no
    // RepresentationGroup around them) - e.g. the 'A' part of an equipment
    // box (ND0300A..ND0310A), which is a drawing element that belongs to the
    // drawing itself and has no Represents reference.
    qsa(mainDoc, 'Object[type="Core/Diagram.Diagram"]').forEach((d, di) => directComponentsObjects(d, "Groups").forEach((g, i) => {
        const t = g.getAttribute("type") || "";
        if (t === "Core/Diagram.Static" || isLabelType(t)) traverseGroup(g, null, `dg_${di}_${i}`);
    }));

    // Second pass — "Profile labels": now that every Profile/SymbolUsage in
    // the drawing has been collected, mark which label Text primitives
    // belong to a symbol placed from the loaded DiscProfile.xml (symbol.key
    // starts with "DiscProfile/"), and for those with no profileText yet
    // (i.e. their own Text carried no AttributeRepresentation Template),
    // fall back to the matching symbol variant's own Profile/LabelTemplate.
    // App.jsx's "Profile labels" checkbox is the sole gate on actually USING
    // isDiscProfileLabel/profileText at render time — both fields are always
    // computed and attached here regardless of the checkbox state.
    const discSymbolByRepresentedId = new Map();
    // ALL DiscProfile symbols placed for each represented object (e.g. a
    // valve body ND0193B plus its tag bubble ND0248B) - used by
    // resolveFilteredTemplateFragments() so an attribute is valid if ANY of
    // the object's placed symbols offers it as a LabelTemplate placeholder.
    const discSymbolsByRepresentedId = new Map();
    drawn.forEach(el => {
        if (el.kind === "symbolUsage" && el.representedId && el.symbol?.key?.startsWith("DiscProfile/")) {
            if (!discSymbolsByRepresentedId.has(el.representedId)) discSymbolsByRepresentedId.set(el.representedId, []);
            discSymbolsByRepresentedId.get(el.representedId).push(el.symbol);
            if (!discSymbolByRepresentedId.has(el.representedId)) {
                discSymbolByRepresentedId.set(el.representedId, { symbol: el.symbol, variant: el.variant });
            }
        }
    });

    // Cache of symbol.key -> Set<bare attribute name>, extracted from ALL of
    // a DiscProfile symbol's own variants' Profile/LabelTemplate.Text
    // placeholders (e.g. "<ObjectDisplayName>", "SignalConveyingFunction:
    // <AlarmValue>" -> "AlarmValue") - same placeholder convention as
    // resolveProfileLabelFallback() below. Mirrors validation.js's PRF-E06
    // check (parseProfileSymbols()'s labelTemplateAttrs), which flags an
    // instance TextTemplate AttributeName that the placed symbol's own
    // catalog doesn't offer at all as a validation issue -
    // resolveFilteredTemplateFragments() below additionally suppresses that
    // Fragment's contribution outright for "Profile labels" unchecked,
    // rather than showing an attribute value the loaded Profile doesn't
    // consider valid for this symbol (e.g. "ItemTag" referenced for an
    // object represented by symbol ND0192A, whose own LabelTemplates only
    // ever reference ObjectDisplayName/NominalDiameterRepresentation/
    // ValveDataSheet/TrimType/LockMechanism).
    const labelTemplateAttrsCache = new Map();
    function labelTemplateAttrsForSymbol(symbol) {
        if (!symbol) return null;
        if (labelTemplateAttrsCache.has(symbol.key)) return labelTemplateAttrsCache.get(symbol.key);
        const attrs = new Set();
        (symbol.variants || []).forEach(v => (v.labelTemplates || []).forEach(lt => {
            if (!lt.text) return;
            const re = /(?:[A-Za-z][A-Za-z0-9_]*:)?<([^<>]+)>/g;
            let m;
            while ((m = re.exec(lt.text)) !== null) attrs.add(m[1]);
        }));
        labelTemplateAttrsCache.set(symbol.key, attrs);
        return attrs;
    }

    // Resolves templateFragments the same way resolveTemplateFragments()
    // does, except an attr Fragment whose AttributeName isn't one its own
    // owning object's placed DiscProfile symbol actually offers (per
    // labelTemplateAttrsForSymbol() above) contributes "" instead of its
    // resolved value, even though that attribute might well resolve to a
    // real value elsewhere - it just isn't a valid label attribute for THIS
    // symbol per the loaded Profile. Only applied when the owning object's
    // symbol actually defines LabelTemplate placeholders at all - an
    // unmodelled symbol (no LabelTemplates in this profile) imposes no
    // restriction, same as PRF-E06's own scoping.
    // Literal pieces a DiscProfile symbol's LabelTemplates define (e.g. "P = "
    // in "'P = ' & <SetPressureHigh>", "-" in "<A>-<B>", "EL: " in "EL: <A>").
    const labelTemplateLiteralsCache = new Map();
    function labelTemplateLiteralsForSymbol(symbol) {
        if (!symbol) return null;
        if (labelTemplateLiteralsCache.has(symbol.key)) return labelTemplateLiteralsCache.get(symbol.key);
        const lits = new Set();
        (symbol.variants || []).forEach(v => (v.labelTemplates || []).forEach(lt => {
            if (!lt.text) return;
            String(lt.text).split(/\r?\n/).forEach(row => {
                unwrapLabelFormula(row).split(/(?:[A-Za-z][A-Za-z0-9_]*:)?<[^<>]+>/).forEach(piece => {
                    if (piece) { lits.add(piece); lits.add(piece.trim()); }
                });
            });
        }));
        labelTemplateLiteralsCache.set(symbol.key, lits);
        return lits;
    }

    // Separator a DiscProfile symbol's LabelTemplates put between two adjacent
    // placeholders: "<A>|<B>" -> literal, e.g. ND0309B's "<LowerLimitDesignPressure>
    // & <UpperLimitDesignPressure> / <NormalOperatingPressure>" gives
    // "LowerLimitDesignPressure|UpperLimitDesignPressure" -> " & ". Used by
    // resolveFilteredTemplateFragments() so an instance label that joins the
    // same two attributes with its own separator (e.g. ", ") shows the
    // profile's separator instead of dropping it and running the values together.
    const labelTemplateGapsCache = new Map();
    function labelTemplateGapsForSymbol(symbol) {
        if (!symbol) return null;
        if (labelTemplateGapsCache.has(symbol.key)) return labelTemplateGapsCache.get(symbol.key);
        const gaps = new Map();
        (symbol.variants || []).forEach(v => (v.labelTemplates || []).forEach(lt => {
            if (!lt.text) return;
            String(lt.text).split(/\r?\n/).forEach(row => {
                const re = /(?:[A-Za-z][A-Za-z0-9_]*:)?<([^<>]+)>/g;
                const text = unwrapLabelFormula(row);
                let m, prev = null, prevEnd = 0;
                while ((m = re.exec(text)) !== null) {
                    if (prev !== null) {
                        const key = `${prev}|${m[1]}`;
                        if (!gaps.has(key)) gaps.set(key, text.slice(prevEnd, m.index));
                    }
                    prev = m[1];
                    prevEnd = m.index + m[0].length;
                }
            });
        }));
        labelTemplateGapsCache.set(symbol.key, gaps);
        return gaps;
    }

    // With a profile loaded, a label's literal Fragment is shown only when it
    // matches a literal of the profile LabelTemplates defined for the label's
    // symbols (whitespace-only separators are kept). Without a profile, for an
    // element placed with no profile symbol that has LabelTemplates, or for
    // a Core/Note label (never profile-governed), every literal is shown.
    function resolveFilteredTemplateFragments(fragments, representedId = null, decimals = null) {
        if (!fragments || !fragments.length) return null;
        const noteLabel = (representedId && objectTypeMap.get(representedId) === "Core/Note")
            || fragments.some(f => f.kind === "attr" && f.objectId && objectTypeMap.get(f.objectId) === "Core/Note");
        let allowedLiterals = null;
        let gapLiterals = null;
        if (discDoc && !noteLabel) {
            const syms = ((representedId && discSymbolsByRepresentedId.get(representedId)) || [])
                .filter(sym => (sym.variants || []).some(v => (v.labelTemplates || []).length));
            // no profile symbol with LabelTemplates for this element: nothing to match against
            if (syms.length) {
                allowedLiterals = new Set(syms.flatMap(sym => [...(labelTemplateLiteralsForSymbol(sym) || [])]));
                gapLiterals = new Map();
                syms.forEach(sym => (labelTemplateGapsForSymbol(sym) || new Map()).forEach((lit, key) => { if (!gapLiterals.has(key)) gapLiterals.set(key, lit); }));
            }
        }
        const bareAttr = f => (f.attributeName || "").split("/").pop();
        // the profile separator for the gap holding literal fragment k, or
        // undefined when the profile doesn't put these two attributes side by
        // side. Only the first literal of a gap gets it; the rest are blank.
        const gapLiteralAt = k => {
            if (!gapLiterals) return undefined;
            let a = k - 1;
            while (a >= 0 && fragments[a].kind === "literal") a--;
            let b = k + 1;
            while (b < fragments.length && fragments[b].kind === "literal") b++;
            if (a < 0 || b >= fragments.length || fragments[a].kind !== "attr" || fragments[b].kind !== "attr") return undefined;
            const lit = gapLiterals.get(`${bareAttr(fragments[a])}|${bareAttr(fragments[b])}`);
            if (lit === undefined) return undefined;
            return k === a + 1 ? lit : "";
        };
        // As in resolveProfileLabelFallback(): the label's literals ("SP = ",
        // "EL: ", separators) are shown only next to at least one resolved
        // value - a label whose attributes are all blank shows nothing (no
        // "SP = " without a SetPoint). An H/HH/L/LL alarm literal is the one
        // exception: it stays once its SignalConveyingFunction (a role child of
        // the component) exists, even before that has an AlarmValue.
        const hasAttr = fragments.some(f => f.kind === "attr");
        let anyValue = false;
        const text = fragments.map((f, k) => {
            if (f.kind === "literal") {
                const t = f.text || "";
                const gap = gapLiteralAt(k);
                if (gap !== undefined) return gap;
                if (!allowedLiterals || !t.trim()) return t;
                return (allowedLiterals.has(t) || allowedLiterals.has(t.trim())) ? t : "";
            }
            if (f.kind === "attr") {
                // The symbols that own this label (placed for the label's own
                // represented object) decide which attributes are valid for it;
                // only when the label's object has none, fall back to the symbols
                // of the object the Fragment names.
                const symsForFrag = (representedId && discSymbolsByRepresentedId.get(representedId))
                    || (f.objectId ? discSymbolsByRepresentedId.get(f.objectId) : null);
                const allowed = symsForFrag
                    ? new Set(symsForFrag.flatMap(sym => [...(labelTemplateAttrsForSymbol(sym) || [])]))
                    : null;
                if (allowed && allowed.size) {
                    const bare = f.attributeName.split("/").pop();
                    if (!allowed.has(f.attributeName) && !allowed.has(bare)) return "";
                }
                // only the labelled component's own attributes (see isLabelReferenceAllowed())
                if (!isLabelReferenceAllowed(representedId, f.objectId)) return "";
                // a profile label attribute named on the labelled component
                // itself is resolved like the profile's own LabelTemplate
                // placeholder (componentAttribute()): the component's own
                // value even where the profile's class model doesn't list the
                // attribute for its class (a segment's ObjectDisplayName for
                // an ND0040 line label)
                const raw = (allowed && allowed.size && f.objectId === representedId)
                    ? componentAttribute(f.objectId, f.attributeName)
                    : lookupProperty(f.objectId, f.attributeName);
                const valueText = fragmentValueToText(raw, labelRepType(f.attributeName, f.repType), decimals);
                if (valueText || isRoleChildOf(representedId, f.objectId)) anyValue = true;
                return valueText;
            }
            return "";
        }).join("");
        return (hasAttr && !anyValue) ? "" : text;
    }

    drawn.forEach(el => {
        if (el.elementRole !== "label" || el.kind !== "primitive" || el.primitive?.kind !== "text") return;
        const discInfo = el.representedId ? discSymbolByRepresentedId.get(el.representedId) : null;
        // A Core/Note's own LocalNoteIdentifier/NoteText labels carry their
        // own AttributeRepresentation Template (see parseTextTemplateFragments())
        // purely as a base Core.xml feature - a Note is never placed as a
        // DiscProfile/Profile.SymbolUsage and never appears in any Profile's
        // symbol catalogue, so it has no "Profile labels" story at all. Two
        // shapes of "this Text is really about a Note" both need catching:
        //  (a) the Text's OWN Represents points straight at the Note (the
        //      note-block entry itself, e.g. the "1. <NoteText>" pair drawn
        //      in the drawing's note list) - representedId is the Note.
        //  (b) a "NOTE <n>" reference flag drawn right next to the equipment
        //      it annotates (e.g. beside a PressureVessel's own symbol) -
        //      this Text has no Represents of its own, so it inherits the
        //      *equipment's* representedId from its enclosing Group instead
        //      (see traverseGroup()), even though its AttributeRepresentation
        //      Fragment explicitly names the Note as the attribute's Object.
        //      Since it shares representedId with the equipment, and that
        //      equipment is very often placed as a DiscProfile catalog
        //      symbol, discInfo/isDiscProfileLabel below would otherwise be
        //      true for it too - the same "belongs to a catalogued symbol"
        //      rule meant for the equipment's own tag/attribute labels.
        // Without this guard, instanceHasAttr below would make
        // isProfileGoverned (case a) or isDiscProfileLabel (case b) true
        // whenever a DiscProfile.xml is loaded, and the Note reference would
        // go blank when "Profile labels" is checked (both flags are checked
        // in App.jsx's CHECKED-state rule) and, lacking real catalog backing,
        // sometimes when unchecked too - i.e. loading a Profile, or toggling
        // the checkbox, would make Notes and their equipment-side reference
        // flags disappear even though nothing about them is Profile-governed.
        // Treating either shape as never profile-governed keeps both showing
        // their literal text in every state.
        const referencesNoteObject = !!(el.primitive.templateFragments && el.primitive.templateFragments.some(
            f => f.kind === "attr" && f.objectId && objectTypeMap.get(f.objectId) === "Core/Note"
        ));
        const representsNote = referencesNoteObject || (el.representedId && objectTypeMap.get(el.representedId) === "Core/Note");
        el.primitive.isDiscProfileLabel = !!discInfo && !representsNote;
        // Whether there is ANY real attribute-driven backing for this label
        // at all - either this Text's own Core/Diagram.TextTemplate names at
        // least one attribute Fragment, or the placed symbol's catalog
        // defines at least one Profile/LabelTemplate with an "<Attr>"-style
        // placeholder in its Text. False when there's no Template at all on
        // either side, OR a Template exists but is purely literal text (no
        // attribute reference whatsoever) - i.e. this "label" isn't actually
        // data-driven by the loaded Profile. App.jsx uses this to hide such
        // a label's literal instance text once a DiscProfile.xml is loaded,
        // even with "Profile labels" unchecked - a purely-literal label
        // isn't something the loaded Profile has any say over, so it
        // shouldn't be shown as if it were a resolved/verified value.
        const instanceHasAttr = !!(el.primitive.templateFragments && el.primitive.templateFragments.some(f => f.kind === "attr"));
        // Only the ONE catalog LabelTemplate that would actually be used as
        // this Text's fallback (labelTemplates[0] - see the "Best effort"
        // fill below) counts as backing - NOT "does this symbol have ANY
        // attribute-referencing LabelTemplate anywhere," which would wrongly
        // treat every label on a DiscProfile symbol as backed just because
        // some OTHER, unrelated LabelTemplate on that same symbol happens to
        // reference an attribute.
        const fallbackTemplateText = discInfo?.variant?.labelTemplates?.[0]?.text;
        const catalogHasAttr = !!(fallbackTemplateText && /[<>]/.test(fallbackTemplateText));
        // A Core/Diagram.TextTemplate/AttributeRepresentation is a base
        // Core.xml feature, not itself DiscProfile-specific - a Text can
        // carry its own attribute-backed Template (instanceHasAttr) whether
        // or not the symbol drawing it happens to be sourced from the
        // loaded DiscProfile.xml catalogue (isDiscProfileLabel) - e.g. a
        // pipe segment's nominal-diameter Text referencing
        // NominalDiameterNumericalValueRepresentation directly on itself,
        // with no DiscProfile SymbolUsage involved at all. Once a
        // DiscProfile.xml IS loaded, such a Text is just as much under the
        // Profile's governance as a catalogued symbol's label - it should
        // resolve from its attribute value, not its literal <Data
        // property="Text">, exactly the same way. Gated on discDoc being
        // loaded at all, so behaviour is unchanged when no profile is
        // loaded (isDiscProfileLabel is already always false in that case).
        el.primitive.isProfileGoverned = !representsNote && !!discDoc && (el.primitive.isDiscProfileLabel || instanceHasAttr);
        el.primitive.hasProfileAttributeBacking = !representsNote && !!discDoc && (instanceHasAttr || catalogHasAttr);
        // Only fall back to the symbol's own Profile/LabelTemplate when this
        // Text primitive carries NO Template at all - resolveTemplateFragments()
        // returns null in that case, vs. an actual (possibly empty) STRING
        // when a Template IS present but one or more of its own placeholders
        // didn't resolve (e.g. an instance AttributeRepresentation naming an
        // attribute, like "SPPID: AlarmH", that plain doesn't exist anywhere
        // reachable from this object - a genuine data gap in the source
        // file, not a missing Template). Checking profileText for truthiness
        // instead of this null-vs-string distinction previously treated a
        // Template that legitimately resolved to "" the same as "no
        // Template", and silently replaced it with the DiscProfile symbol's
        // OWN unrelated LabelTemplate (meant for a different Text position
        // entirely) - showing the wrong content instead of leaving this
        // Text's already-correct (if occasionally blank) resolution alone.
        if (!discInfo || el.primitive.profileText !== null) return;
        // Best effort: a symbol variant may define several LabelTemplates
        // (e.g. a top + bottom tag label); with only one Text primitive on
        // this instance to attribute it to, the first template is used.
        const template = discInfo.variant?.labelTemplates?.[0]?.text;
        const fallback = resolveProfileLabelFallback(template, el.representedId);
        if (fallback !== null) el.primitive.profileText = fallback;
    });

    // Snapshot of profileText as resolved above, BEFORE the suspect-
    // duplicate-template blanking pass below can zero it out for the
    // CHECKED-state overlay-preference decision. "Profile labels" unchecked
    // has nowhere else to get an attribute-resolved value from (labelOverlays
    // never render when unchecked - see App.jsx SymbolGraphic's
    // `showProfileLabels &&` gate) so it always uses this raw, un-blanked
    // resolution rather than the (possibly-blanked) profileText field.
    // primitive.validRawProfileText is the same resolution, but with any
    // attr Fragment whose AttributeName isn't valid for the owning object's
    // placed symbol (per resolveFilteredTemplateFragments() above)
    // suppressed - "Profile labels" unchecked uses THIS one specifically, so
    // an invalid-per-profile attribute reference (e.g. "ItemTag" on an
    // ND0192A-represented object) never shows its resolved value there, even
    // though App.jsx's CHECKED-state display still uses the unfiltered
    // profileText.
    // Equipment box value columns (ND0300B..ND0310B) show numeric values with
    // 1 decimal - in the "Profile labels" overlay (third pass below) and in
    // the box's own label Texts: those placed in the same Core/Diagram.Label
    // as the equipment box SymbolUsage (same traversal scope, see
    // traverseGroup()'s keys).
    const EQUIPMENT_BOX_SYMBOL_KEY_RE = /^DiscProfile\/ND03(0\d|10)B$/;
    const labelScopeOf = key => {
        let m = /^(.*)_(?:lbltxt|lblsym|lblshape)_(\d+)_\d+$/.exec(key);
        if (m) return `${m[1]}#${m[2]}`;
        m = /^(.*)_(?:p|su|shu)_\d+$/.exec(key);
        return m ? m[1] : key;
    };
    const equipmentBoxScopes = new Set(drawn
        .filter(el => el.kind === "symbolUsage" && EQUIPMENT_BOX_SYMBOL_KEY_RE.test(el.symbol?.key || ""))
        .map(el => labelScopeOf(el.key)));
    const labelDecimals = el => (equipmentBoxScopes.has(labelScopeOf(el.key)) ? 1 : null);

    drawn.forEach(el => {
        if (el.elementRole !== "label" || el.kind !== "primitive" || el.primitive?.kind !== "text") return;
        el.primitive.rawProfileText = el.primitive.profileText;
        el.primitive.validRawProfileText = resolveFilteredTemplateFragments(el.primitive.templateFragments, el.representedId, labelDecimals(el));
        // A label of a component (its represented object exists in the model)
        // shows ONLY the values of the attributes it references on the related
        // object - never the literal <Data property="Text"> string stored in
        // the file. Attribute references are resolved strictly (lookupProperty():
        // only on the object named, only if the attribute is valid for its
        // class) and only for attributes the component's placed DiscProfile
        // symbols offer (resolveFilteredTemplateFragments()). A label Text with
        // no attribute reference at all shows nothing. Used by App.jsx's
        // renderPrimitive() in both "Profile labels" states.
        el.primitive.isComponentLabel = !!(el.representedId && objectTypeMap.has(el.representedId));
        const hasAttrRef = !!(el.primitive.templateFragments && el.primitive.templateFragments.some(f => f.kind === "attr"));
        // No attribute referenced: without a profile the label's stored text is
        // shown; with a profile loaded every label is defined by attributes, so
        // nothing is shown.
        el.primitive.componentText = hasAttrRef
            ? (el.primitive.validRawProfileText ?? "")
            : (discDoc ? "" : (el.primitive.value ?? ""));
    });

    // Any other drawn Text whose template references attributes (outside a
    // label group) is a label too: it shows only the component's attribute
    // values, the same way - never its stored <Data property="Text"> string.
    drawn.forEach(el => {
        if (el.elementRole === "label" || el.kind !== "primitive" || el.primitive?.kind !== "text") return;
        const fragments = el.primitive.templateFragments;
        if (!el.representedId || !objectTypeMap.has(el.representedId)) return;
        if (!fragments || !fragments.some(f => f.kind === "attr")) return;
        el.primitive.isComponentLabel = true;
        el.primitive.componentText = resolveFilteredTemplateFragments(fragments, el.representedId, labelDecimals(el)) ?? "";
    });

    // Profile selected: a label is shown only when it belongs to a profile
    // symbol or profile label symbol - its represented object must be placed
    // with a valid DiscProfile symbol reference that defines LabelTemplates.
    // The only labels allowed without a symbol are those linked to a Core/Note:
    // they must reference a valid attribute of the Note (e.g. NoteText,
    // LocalNoteIdentifier) and may carry literal text.
    if (discDoc) {
        const hasProfileSymbol = id => !!id && (discSymbolsByRepresentedId.get(id) || []).some(sym =>
            sym && (sym.variants || []).some(v => (v.labelTemplates || []).length));
        drawn.forEach(el => {
            if (el.kind !== "primitive" || el.primitive?.kind !== "text") return;
            const fragments = el.primitive.templateFragments || [];
            const isLabel = el.elementRole === "label" || fragments.some(f => f.kind === "attr");
            if (!isLabel) return;
            const noteFrags = fragments.filter(f => f.kind === "attr" && f.objectId && objectTypeMap.get(f.objectId) === "Core/Note");
            const representsNote = !!el.representedId && objectTypeMap.get(el.representedId) === "Core/Note";
            el.primitive.isComponentLabel = true;
            if (noteFrags.length || representsNote) {
                // Note label: literals plus the Note's own valid attributes only
                const validNote = noteFrags.some(f => isAttributeValidFor(f.objectId, f.attributeName));
                el.primitive.isDiscProfileLabel = false;
                el.primitive.componentText = validNote
                    ? fragments.map(f => f.kind === "literal" ? (f.text || "")
                        : (f.kind === "attr" && objectTypeMap.get(f.objectId) === "Core/Note")
                            ? fragmentValueToText(lookupProperty(f.objectId, f.attributeName), f.repType)
                            : "").join("")
                    : "";
                return;
            }
            if (!hasProfileSymbol(el.representedId) || !fragments.some(f => f.kind === "attr")) {
                el.primitive.componentText = "";
            }
        });
    }

    // Some source files export several visually-distinct label Text pieces
    // (e.g. a plant/system prefix, a tag-type code, and a sequence number,
    // each its own Core/Diagram.Text at its own position) but mistakenly
    // give TWO OR MORE of those DIFFERENTLY-POSITIONED pieces the EXACT SAME
    // Core/Diagram.TextTemplate (same attribute Fragments) - a copy/paste
    // export defect, not a real "this text repeats the same value" case.
    // Detected by grouping each representedId's label texts by their
    // templateFragments' structural signature and checking whether any one
    // signature shows up at more than one distinct (x, y) position - a
    // single Text legitimately appearing more than once (e.g. drawn on
    // multiple sheets/views) always repeats at the SAME position each time,
    // so that alone doesn't trigger this.
    const suspectDuplicateTemplateIds = new Set();
    {
        const bySignature = new Map(); // representedId -> Map<signature, Set<"x,y">>
        drawn.forEach(el => {
            if (el.elementRole !== "label" || el.kind !== "primitive" || el.primitive?.kind !== "text") return;
            if (!el.primitive.templateFragments || !el.representedId) return;
            const sig = JSON.stringify(el.primitive.templateFragments);
            const posKey = `${el.primitive.position?.x},${el.primitive.position?.y}`;
            if (!bySignature.has(el.representedId)) bySignature.set(el.representedId, new Map());
            const sigMap = bySignature.get(el.representedId);
            if (!sigMap.has(sig)) sigMap.set(sig, new Set());
            sigMap.get(sig).add(posKey);
        });
        for (const [representedId, sigMap] of bySignature) {
            for (const positions of sigMap.values()) {
                if (positions.size > 1) { suspectDuplicateTemplateIds.add(representedId); break; }
            }
        }
    }

    // Blank out copy/pasted-Template instance texts (see suspectDuplicateTemplateIds
    // above) so they don't render at all - only relevant now for the
    // non-catalogued "Profile labels" checked-state case (primitive.
    // isProfileGoverned via its own TextTemplate, no DiscProfile symbol
    // involved) and for App.jsx's unchecked-state hasProfileAttributeBacking
    // path (primitive.rawProfileText/validRawProfileText are captured BEFORE
    // this runs, so they're unaffected either way). A catalogued symbol's
    // own Text primitive never shows profileText at all any more when
    // checked - see the third pass below - so blanking has no effect there.
    drawn.forEach(el => {
        if (el.elementRole !== "label" || el.kind !== "primitive" || el.primitive?.kind !== "text") return;
        if (!el.primitive.templateFragments || !el.representedId) return;
        if (suspectDuplicateTemplateIds.has(el.representedId)) el.primitive.profileText = "";
    });

    // Third pass — "Profile labels" symbol overlays: for EVERY DiscProfile-
    // catalogued symbol placement, synthesize el.labelOverlays from the
    // symbol's own catalog Profile/LabelTemplate(s) - "Profile labels"
    // checked always shows the catalog's own LabelTemplate for a catalogued
    // symbol, never the instance's own Core/Diagram.TextTemplate (see
    // App.jsx's renderPrimitive(), which shows nothing for a catalogued
    // symbol's own Text primitive when checked, deferring entirely to this
    // overlay) - the instance TextTemplate is only ever used as a display
    // source for a Text that ISN'T tied to any catalogued symbol at all
    // (primitive.isProfileGoverned via its own attribute Fragment, e.g. a
    // pipe segment's nominal-diameter Text with no Profile/SymbolUsage
    // involved). Some DiscProfile symbols (e.g. a "special item number"
    // balloon, DiscProfile/ND0048) are never given their own Core/
    // Diagram.Text in the instance drawing at all - their "label" is itself
    // another placed symbol (the balloon outline) plus a leader PolyLine -
    // those are covered here too, the same way. App.jsx's SymbolGraphic
    // renders these (only when "Profile labels" is checked) inside the
    // symbol's own transformed <g>, using each LabelTemplate's local
    // Position/Rotation/Alignment/Font/Size/Color exactly as it does for the
    // symbol's own Primitives.
    drawn.forEach(el => {
        if (el.kind !== "symbolUsage" || !el.representedId) return;
        if (!el.symbol?.key?.startsWith("DiscProfile/")) return;
        const templates = el.variant?.labelTemplates;
        if (!templates || !templates.length) return;
        // Shared across every LabelTemplate for this one symbol placement so
        // repeated "ClassName:<Attr>" role-path references (e.g. H/HH/L/LL
        // all referencing SignalConveyingFunction) each pick the next
        // matching child rather than all resolving to the same one - see
        // pickRoleChild()/resolveProfileLabelFallback() above.
        const roleCounters = {};
        // Equipment boxes with several Chambers repeat the same template text
        // once per chamber (ND0309B: hot side, then cold side) - the 1st
        // occurrence reads attributes the equipment lacks from the Cooling
        // (hot side) Chamber, the 2nd from the Heating (cold side) Chamber -
        // see chamberForSide().
        // Equipment box value columns (ND0300B..ND0310B) show numeric values
        // rounded to 1 decimal.
        const decimals = EQUIPMENT_BOX_SYMBOL_KEY_RE.test(el.symbol.key) ? 1 : null;
        const textCounts = new Map();
        templates.forEach(lt => textCounts.set(lt.text, (textCounts.get(lt.text) || 0) + 1));
        const textSeen = new Map();
        const overlays = templates
            .map(lt => {
                const n = textSeen.get(lt.text) || 0;
                textSeen.set(lt.text, n + 1);
                const chamberIndex = textCounts.get(lt.text) > 1 ? n : null;
                return { text: resolveProfileLabelFallback(lt.text, el.representedId, roleCounters, chamberIndex, decimals), position: lt.position, rotation: lt.rotation, alignment: lt.alignment, font: lt.font, size: lt.size, color: lt.color };
            })
            .filter(o => o.text);
        if (overlays.length) el.labelOverlays = overlays;
    });

    // Only graphics that belong to a model object are shown: every drawn
    // element must sit in a group that represents an existing object (symbol,
    // label, connector line, note text alike). Bare graphics exported without a
    // component behind them - e.g. SPPID's 'DrawingLabels' polylines, frames,
    // interface markers, free text not turned into a Core/Note - are dropped,
    // as is anything whose Represents target does not exist in the file.
    // Exception: a symbol from the loaded DiscProfile catalogue placed with no
    // Represents of its own (e.g. the static caption/header half of an equipment
    // box, ND0309A, placed as a Core/Diagram.Static in the 'DrawingLabels' group)
    // is an intentional profile graphic and is kept, unlinked - one header box is
    // often shared by several value boxes (ND0309B ...) placed side by side, so it
    // is not tied to any one object and is not selectable. One whose Represents
    // names a missing object is still dropped.
    const isProfileSymbol = el => el.kind === "symbolUsage" && el.symbol?.key?.startsWith("DiscProfile/");
    const isLinkedEl = el => el.representedId && objectTypeMap.has(el.representedId);
    const linked = drawn.filter(el => isLinkedEl(el) || (isProfileSymbol(el) && !el.representedId));

    // With a profile loaded, bare polylines / polygons are drawn only when they are
    //  * a piping or signal line (the represented object is a pipe, piping
    //    network segment or signal conveying function) drawn without a symbol, or
    //  * part of a graphic that has a profile symbol (a Profile/SymbolUsage or
    //    ShapeUsage in the same group) AND an open line - a leader line.
    // A closed shape next to a symbol duplicates the symbol's own graphics
    // (e.g. SPPID exports the slope triangle as polylines beside the ND0224
    // symbol usage) and is dropped, as is every other free polyline (frames,
    // tables, package boundaries drawn without a symbol).
    const PIPING_OR_SIGNAL = /Plant\/Piping\.(Pipe|PipingNetworkSegment|PipingNetworkSystem|PipingConnection)$|Plant\/Instrumentation\.(SignalConveyingFunction|SignalLineFunction|MeasuringLineFunction)$/;
    const groupKeyOf = key => key.replace(/_(p|su|shu|lblsym|lbltxt|lblshape|cl)_\d+(_\d+)?$/, "");
    const groupsWithSymbol = new Set();
    linked.forEach(el => { if (el.kind === "symbolUsage") groupsWithSymbol.add(groupKeyOf(el.key)); });
    const endpointCounts = new Map();   // groupKey -> Map("x,y" -> count) over polyline end points
    const ptKey = pt => `${Math.round(pt.x * 100) / 100},${Math.round(pt.y * 100) / 100}`;
    linked.forEach(el => {
        if (el.kind !== "primitive" || el.primitive?.kind !== "polyline" || !el.primitive.points?.length) return;
        const g = groupKeyOf(el.key);
        if (!endpointCounts.has(g)) endpointCounts.set(g, new Map());
        const m = endpointCounts.get(g);
        const pts = el.primitive.points;
        for (const pt of [pts[0], pts[pts.length - 1]]) { const k = ptKey(pt); m.set(k, (m.get(k) || 0) + 1); }
    });
    const isAllowedLine = el => {
        if (el.kind !== "primitive" || !["polyline", "polygon"].includes(el.primitive?.kind)) return true;
        const g = groupKeyOf(el.key);
        if (!groupsWithSymbol.has(g)) return PIPING_OR_SIGNAL.test(objectTypeMap.get(el.representedId) || "");
        if (el.primitive.kind === "polygon") return false;
        const pts = el.primitive.points || [];
        if (pts.length < 2) return false;
        const m = endpointCounts.get(g) || new Map();
        const closed = (m.get(ptKey(pts[0])) || 0) >= 2 && (m.get(ptKey(pts[pts.length - 1])) || 0) >= 2;
        return !closed;
    };
    const elements = discDoc ? linked.filter(isAllowedLine) : linked;

    return { elements, nodePosMap, nodePositionsByNodeId, unlinkedCount: drawn.length - elements.length };
}

/**
 * Walk the conceptual model tree and build a map of object IDs that require
 * heat-tracing visual overlays. Only called when a DISC profile is loaded.
 *
 * Return value: Map<objectId, "piping" | "inline" | "pif" | "nozzle">
 *   "piping"  – Pipe connector-line element
 *   "inline"  – PipingComponent / valve / fitting in a segment's Items list
 *   "pif"     – ProcessInstrumentationFunction
 *   "nozzle"  – Nozzle
 *
 * Eligibility is data-driven: only element types whose DEXPI/DISC class
 * has HeatTracingType defined (directly or through class inheritance) are
 * included.  The base set is derived from Plant.xml + DiscProfile.xml;
 * it is extended at runtime from the loaded DISC profile's ConcreteClass
 * definitions and Profile/PropertyConstraint entries.
 */

// ---------------------------------------------------------------------------
// Type suffixes (last dot-segment of the DEXPI class name) that are known to
// have HeatTracingType in the base DEXPI 2.0 model (Plant.xml) or the
// standard DISC profile (DiscProfile.xml), derived from their class hierarchy.
// Custom / third-party profile classes that are subclasses of these types are
// resolved at runtime from the loaded discDoc.
// ---------------------------------------------------------------------------
const DEXPI_BUILTIN_HT_ELIGIBLE = new Set([
    // Plant.xml direct owners
    "PipingNetworkSystem", "PipingNetworkSegment", "PipingComponent", "OfflineMeasuringElement",
    // Plant.xml – Pipe (PipingConnection subclass, carries inherited HeatTracingType from its segment)
    "Pipe",
    // Plant.xml – concrete subclasses of PipingComponent / InlineMeasuringElement
    "AngleBallValve","AngleGlobeValve","AnglePlugValve","AngleValve","BallValve",
    "BlindFlange","BreatherValve","ButterflyValve","CheckValve","ClampedFlangeCoupling",
    "Compensator","ConicalStrainer","ElectromagneticFlowMeter","FlameArrestor","Flange",
    "FlangedConnection","FlowMeasuringElement","FlowNozzle","Funnel","GateValve",
    "GlobeCheckValve","GlobeValve","Hose","IlluminatedSightGlass","InLineMixer",
    "InlineMeasuringElement","LineBlind","MassFlowMeasuringElement","NeedleValve",
    "OperatedValve","Penetration","PipeCoupling","PipeFitting","PipeFlangeSpacer",
    "PipeFlangeSpade","PipeReducer","PipeTee","PlugValve","PositiveDisplacementFlowMeter",
    "RestrictionOrifice","RuptureDisc","SafetyValveOrFitting","Sensorwell","SightGlass",
    "Silencer","SpringLoadedAngleGlobeSafetyValve","SpringLoadedGlobeSafetyValve",
    "SteamTrap","StraightwayValve","Strainer","SwingCheckValve","TurbineFlowMeter",
    "VariableAreaFlowMeter","VentLine","VenturiTube","VolumeFlowMeasuringElement",
    // DiscProfile.xml – concrete subclasses of the above (standard DISC profile)
    "AcousticNoiseReducer","AirReleaseTrap","AveragingPitotTubeFlowMeter","AxialValve",
    "BirdScreen","BlockAndBleedValve","ChokeValve","ClampConnector","ClampOn",
    "CoriolisMassFlowMeter","DiaphragmSeal","DiaphragmValve","Diffuser","DiverterValve",
    "DoubleBlockAndBleedAndCheckValve","DoubleBlockAndBleedValve","DoubleIsolationBallValve1",
    "DoubleIsolationBallValve2","DrainBox","DrainerTrap","DuplexStrainer","ExpansionJoint",
    "FlexibleHoseFlanged","FloatValve","FlowControlAndCheckValve","FlowIndicator",
    "FlowMeter","FlowNozzleMeter","FlowStraighteningVane","FourWayValve","GullyDrain",
    "HoseConnector","LevelBridle","LevelMeasuringInstrumentNuclear","LevelSensor",
    "LevelWell","MinimumFlowAndCheckValve","MixedOrBarredTee","MixingOrBarredTee",
    "MonoflangeValve","OpenDrainSystem","OrificePlate","PilotOperatedReliefValve",
    "PinchValve","PipeCap","PipeUnion","Plug","QuickChangeOrificePlate","ReducingFlange",
    "RotaryValve","RotatingDrumStrainer","SelfActuatedPressureControlValve","SlideGateValve",
    "SpecialItemPipingComponent","SpectacleBlind","StrainerTTemporary","SwivelJoint",
    "TStrainer","Thermowell","ThreadedPipeCap","ThreeWayValve","Trap","UltrasonicFlowMeter",
    "VacuumReliefValve","VariableAreaFlowIndicator","VentBirdScreen","VentTip",
    "VentToSafe","VenturiTubeFlowMeter","VirtualPipingConnector","VortexFlowMeter",
    "WaterSealWithVent","WedgeGateValve","YStrainer",
]);

/**
 * Build an eligibility predicate for HeatTracingType from the loaded DISC
 * profile document (may be null when no profile is loaded).
 *
 * The predicate returns true for any DEXPI element type whose class has
 * HeatTracingType defined, either from the built-in set above or because:
 *   (a) the profile defines a ConcreteClass that is a subclass of an eligible
 *       type (handles custom / vendor profile extensions); or
 *   (b) the profile has a Profile/PropertyConstraint whose Property contains
 *       "HeatTracingType" pointing at a ConstrainedType not in the built-in set; or
 *   (c) the profile defines a ClassExtension (DISC's "add a property straight
 *       onto an existing base class" mechanism, distinct from ConcreteClass
 *       subclassing - see e.g. DiscProfile.xml's ProcessInstrumentationFunction-
 *       Extension, baseType="Plant/Instrumentation.ProcessInstrumentationFunction")
 *       whose own DataProperty children include "HeatTracingType" - the
 *       ClassExtension's baseType itself becomes eligible, since instances are
 *       still serialized under the base type name, not the extension's name.
 *
 * Non-eligible types break the instance-level inheritance chain: a
 * PipingNetworkSegment's HeatTracingType does NOT propagate to (e.g.) an
 * OffPageConnector that is also listed as a segment item, because
 * PipeOffPageConnector is NOT a subclass of PipingComponent.
 */
function buildHtEligibility(discDoc) {
    const eligible = new Set(DEXPI_BUILTIN_HT_ELIGIBLE);

    if (discDoc) {
        // (a) Extend with ConcreteClass subclasses of already-eligible types.
        // Iterate to fixpoint to handle multi-level inheritance chains.
        const classes = Array.from(discDoc.querySelectorAll("ConcreteClass"));
        let changed = true;
        while (changed) {
            changed = false;
            for (const cls of classes) {
                const name = cls.getAttribute("name");
                if (!name || eligible.has(name)) continue;
                const supers = (cls.getAttribute("superTypes") || "").split(/\s+/);
                const superSuffixes = supers.map(s => s.split(/[./]/).pop());
                if (superSuffixes.some(s => eligible.has(s))) {
                    eligible.add(name);
                    changed = true;
                }
            }
        }

        // (b) Honour explicit PropertyConstraint entries for HeatTracingType.
        discDoc.querySelectorAll('Object[type="Profile/PropertyConstraint"]').forEach(obj => {
            let prop = null, constrainedType = null;
            Array.from(obj.querySelectorAll(":scope > Data")).forEach(d => {
                const p = d.getAttribute("property");
                const s = d.querySelector("String")?.textContent?.trim();
                if (p === "Property")        prop = s;
                if (p === "ConstrainedType") constrainedType = s;
            });
            if (prop?.includes("HeatTracingType") && constrainedType) {
                const suffix = constrainedType.split(/[./]/).pop();
                if (suffix) eligible.add(suffix);
            }
        });

        // (c) Honour ClassExtension elements that add HeatTracingType
        // directly onto an existing base class (e.g. ProcessInstrumentation-
        // FunctionExtension on Plant/Instrumentation.ProcessInstrumentation-
        // Function) - instances still serialize under the base type name,
        // so it's the baseType that must become eligible, not the extension.
        discDoc.querySelectorAll("ClassExtension").forEach(ext => {
            const baseType = ext.getAttribute("baseType");
            if (!baseType) return;
            const hasHT = Array.from(ext.children).some(child =>
                child.tagName === "DataProperty" &&
                (child.getAttribute("name") === "HeatTracingType" || child.getAttribute("name") === "DiscProfile/HeatTracingType")
            );
            if (hasHT) {
                const suffix = baseType.split(/[./]/).pop();
                if (suffix) eligible.add(suffix);
            }
        });
    }

    return (type) => {
        if (!type) return false;
        const suffix = type.split(/[./]/).pop();
        return eligible.has(suffix);
    };
}

export function buildHeatTraceSet(tree, discDoc = null) {
    const result = new Map();
    const isEligibleType = buildHtEligibility(discDoc);

    // Driving attribute for the HeatTracing line rule: HeatTracingType.
    //   undefined → attribute absent on this node  (use parent's value)
    //   null      → explicitly NoHeatTracingSystem, or any value other than
    //               the four recognised heat-tracing types  (no heat trace)
    //   string    → one of the recognised active values (see HEAT_TRACING_ACTIVE_TYPES)
    function getHT(node) {
        if (!node || !Array.isArray(node.data)) return undefined;
        const entry = node.data.find(d =>
            d.property === "HeatTracingType" ||
            d.property === "DiscProfile/HeatTracingType"
        );
        if (!entry) return undefined;
        const v = entry.value;
        if (v === null || v === undefined) return undefined;
        let last;
        if (typeof v === "string") {
            last = v;
        } else if (v?.kind === "DataReference") {
            last = v.value.split(".").pop().split("/").pop();
        } else {
            return undefined;
        }
        return (!last || last === "NoHeatTracingSystem") ? null : last;
    }

    // The HeatTracing line rule only fires when the driving attribute
    // (HeatTracingType) resolves to one of these recognised values.
    const HEAT_TRACING_ACTIVE_TYPES = new Set([
        "ElectricalHeatTracingSystem",
        "HeatTracingSystem",
        "SteamHeatTracingSystem",
        "TubularHeatTracingSystem",
    ]);

    function isActive(ht) { return ht !== null && ht !== undefined && HEAT_TRACING_ACTIVE_TYPES.has(ht); }

    // Map the element's DEXPI class to the heat-trace overlay render mode.
    function overlayType(type) {
        if (!type) return "inline";
        if (type.includes("ProcessInstrumentationFunction") ||
            type.includes("ProcessSafetyFunction")) return "pif";
        const suffix = type.split(/[./]/).pop();
        if (suffix === "Nozzle") return "nozzle";
        if (suffix === "Pipe")   return "piping";
        return "inline";
    }

    // Walk the conceptual tree, propagating the inherited HeatTracingType value.
    //
    // Eligible types participate in HT inheritance and may appear in the result.
    // Non-eligible types (e.g. OffPageConnector, ProcessInstrumentationFunction,
    // structural containers) break the inheritance chain: their children start
    // with inheritedHT = undefined so they cannot inherit from an ancestor.
    function walk(node, inheritedHT) {
        if (!node) return;
        const type = node.type || "";

        if (!isEligibleType(type)) {
            // Not eligible — don't include, and reset chain for children
            node.children.forEach(child => walk(child, undefined));
            return;
        }

        const ownHT = getHT(node);
        const effectiveHT = ownHT !== undefined ? ownHT : inheritedHT;

        if (isActive(effectiveHT) && node.objectId) {
            result.set(node.objectId, overlayType(type));
        }

        node.children.forEach(child => walk(child, effectiveHT));
    }

    walk(tree, undefined);
    return result;
}

// A ref property "counts" toward connectivity (upstream/downstream/group)
// classification when it substring-matches "upstream"/"source"/"inlet"/
// "downstream"/"target"/"outlet"/"function"/"member"/"piping"/"instrument" -
// see buildConnectivityMap() below. Exported so App.jsx can exclude these
// same refs from selectedRepresentedIds (the "selected"/red-highlight set)
// when the Sub-components checkbox is on: connectivity refs exist purely to
// drive the separate upstream/downstream/group highlight colors, not to mark
// their target as "also selected". Without this exclusion, e.g. a
// PipingComponent's upstream ref would cause the object it points at to be
// drawn in the same red "selected" color as the actually-selected object,
// regardless of whether connectivity highlighting is even turned on -
// selected/red is meant to always win over connectivity color (see
// SymbolGraphic/PrimitiveGraphic's `selected ? ... : connHighlight`
// priority in App.jsx), so a ref that's only meant to feed connectivity
// color must never end up in the selected set to begin with.
export function isConnectivityRefProperty(property) {
    const prop = (property || "").toLowerCase();
    return prop.includes("upstream") || prop.includes("source") || prop.includes("inlet")
        || prop.includes("downstream") || prop.includes("target") || prop.includes("outlet")
        || prop.includes("function") || prop.includes("member") || prop.includes("piping") || prop.includes("instrument");
}

export function buildConnectivityMap(flatTree) {
    const map = new Map();
    const ensure = id => {
        if (!map.has(id)) map.set(id, { upstream: new Set(), downstream: new Set(), group: new Set() });
        return map.get(id);
    };
    flatTree.forEach(node => {
        if (!node.objectId) return;
        const n = ensure(node.objectId);
        node.refs.forEach(ref => {
            const prop = ref.property.toLowerCase();
            ref.objects.forEach(targetId => {
                ensure(targetId);
                const t = map.get(targetId);
                if (prop.includes("upstream") || prop.includes("source") || prop.includes("inlet")) {
                    n.upstream.add(targetId); t.downstream.add(node.objectId);
                } else if (prop.includes("downstream") || prop.includes("target") || prop.includes("outlet")) {
                    n.downstream.add(targetId); t.upstream.add(node.objectId);
                } else if (prop.includes("function") || prop.includes("member") || prop.includes("piping") || prop.includes("instrument")) {
                    n.group.add(targetId);
                }
            });
        });
    });
    return map;
}

export function parseDexpiPackage(mainXml, discProfileXml) {
    const parser = new DOMParser();
    const mainDoc = parser.parseFromString(mainXml, "application/xml");
    const discDoc = discProfileXml ? parser.parseFromString(discProfileXml, "application/xml") : null;
    if (mainDoc.querySelector("parsererror")) throw new Error("Main XML is not well-formed.");
    if (discDoc && discDoc.querySelector("parsererror")) throw new Error("DiscProfile XML is not well-formed.");
    const conceptualRoot = mainDoc.querySelector('Object[type="Core/EngineeringModel"] > Components[property="ConceptualModel"] > Object');
    if (!conceptualRoot) {
        // This parser only understands DEXPI 2.0's <Model>/<Object type="Core/EngineeringModel">
        // structure. A Proteus 4.1.1 / DEXPI 1.3 file (root element <PlantModel>, as produced by
        // e.g. AKSO/Comos exports) will always land here since it has no such element at all -
        // give a specific, actionable message instead of the generic one so this mismatch isn't
        // mistaken for a parsing bug or a missing/incompatible DiscProfile.xml.
        const rootTag = mainDoc.documentElement?.tagName || "";
        if (rootTag === "PlantModel") {
            throw new Error('This file is a Proteus 4.1.1 / DEXPI 1.3 XML (root element <PlantModel>), not a DEXPI 2.0 file. This viewer only supports DEXPI 2.0 files (root element <Model>). Proteus/DEXPI 1.3 files are not supported here.');
        }
        throw new Error("Could not find ConceptualModel in the DEXPI file.");
    }
    const tree = parseTreeFromConceptual(conceptualRoot);
    const flatTree = flattenTree(tree);
    const treeMap = new Map(flatTree.filter(n => n.objectId).map(n => [n.objectId, n]));
    const externalSymbolMap = parseSymbolCatalogue(discDoc);
    const internalShapeMap = parseInternalShapeCatalogue(mainDoc);
    const symbolMap = new Map([...internalShapeMap, ...externalSymbolMap]);
    const graphics = collectGraphicalElements(mainDoc, symbolMap, discDoc);
    const metaNode = mainDoc.querySelector('Components[property="MetaData"] > Object');
    const meta = metaNode ? {
        drawingName: valueFromData(metaNode, "DrawingName") || "",
        drawingNumber: valueFromData(metaNode, "DrawingNumber") || "",
        subtitle: aggregatedValue(getData(metaNode, "DrawingSubTitle")?.firstElementChild) || "",
        processPlantName: valueFromData(metaNode, "ProcessPlantName") || "",
        creatorName: valueFromData(metaNode, "CreatorName") || ""
    } : {};
    const connectivityMap = buildConnectivityMap(flatTree);
    // Build heat-trace set; for "inline" entries keep only objects that are
    // actually placed as a symbolUsage in the drawing. The Profile/SymbolUsage
    // reference in DEXPI goes FROM the graphical model TO the conceptual object
    // (via "Represents"), not the other way, so we check the rendered graphics.
    const heatTraceSet = (() => {
        const raw = buildHeatTraceSet(tree, discDoc);
        const symbolUsageIds = new Set(
            graphics.elements
                .filter(el => el.kind === "symbolUsage" && el.representedId)
                .map(el => el.representedId)
        );
        for (const [id, type] of [...raw]) {
            if (type === "inline" && !symbolUsageIds.has(id)) raw.delete(id);
        }
        return raw;
    })();
    const enumAbbreviations = buildEnumAbbreviationMap(discDoc);
    return { mainDoc, discDoc, tree, flatTree, treeMap, symbolMap, graphics, meta, connectivityMap, heatTraceSet, enumAbbreviations };
}

export function boundsFromElements(graphics) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visit = p => { if (!p) return; minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); };
    graphics.elements.forEach(el => {
        if (el.kind === "symbolUsage") {
            const v = el.variant;
            visit({ x: el.position.x + v.minX * el.scaleX, y: el.position.y + v.minY * el.scaleY });
            visit({ x: el.position.x + v.maxX * el.scaleX, y: el.position.y + v.maxY * el.scaleY });
        } else if (el.primitive?.kind === "polyline" || el.primitive?.kind === "polygon") {
            el.primitive.points.forEach(visit);
        } else if (el.primitive?.kind === "connectorLine") {
            el.primitive.innerPoints.forEach(visit);
        } else if (el.primitive?.kind === "circle") {
            visit({ x: el.primitive.center.x - el.primitive.radius, y: el.primitive.center.y - el.primitive.radius });
            visit({ x: el.primitive.center.x + el.primitive.radius, y: el.primitive.center.y + el.primitive.radius });
        } else if (el.primitive?.kind === "ellipse") {
            visit({ x: el.primitive.center.x - el.primitive.rx, y: el.primitive.center.y - el.primitive.ry });
            visit({ x: el.primitive.center.x + el.primitive.rx, y: el.primitive.center.y + el.primitive.ry });
        } else if (el.primitive?.kind === "rect") {
            visit({ x: el.primitive.center.x - el.primitive.width / 2, y: el.primitive.center.y - el.primitive.height / 2 });
            visit({ x: el.primitive.center.x + el.primitive.width / 2, y: el.primitive.center.y + el.primitive.height / 2 });
        } else if (el.primitive?.kind === "text") {
            // Notes/annotations (e.g. Core/Note labels) are frequently placed
            // in a note block away from any piping/equipment geometry, so a
            // Text primitive's own position must count toward the drawing's
            // fit-to-view bounds too - otherwise such labels can fall outside
            // both the initial auto-fit view AND the pan-clamp range in
            // App.jsx's clampViewBox() (which is itself derived from these
            // bounds), making them impossible to see even by scrolling.
            visit(el.primitive.position);
        }
    });
    if (minX === Infinity) return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    const margin = 50;
    return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
}

/**
 * Parse a DEXPI profile/model XML (e.g. DiscProfile.xml) and collect all valid
 * named-object reference IDs in the form "ModelName/PackagePath.ObjectName".
 * These are used in cross-file References/@objects attributes and must NOT be
 * flagged as broken references during VAL-005 checking.
 */
export function collectModelValidIds(modelXml) {
    if (!modelXml) return new Set();
    const parser = new DOMParser();
    const doc = parser.parseFromString(modelXml, "application/xml");
    if (doc.querySelector("parsererror")) return new Set();
    const validIds = new Set();
    const modelName = doc.documentElement.getAttribute("name") || "";

    function walk(node, packagePath) {
        Array.from(node.children).forEach(child => {
            const tag = child.tagName;
            const name = child.getAttribute("name") || "";
            if (tag === "Package" && name) {
                walk(child, packagePath ? `${packagePath}.${name}` : name);
            } else if (tag === "Object" && name) {
                validIds.add(packagePath ? `${modelName}/${packagePath}.${name}` : `${modelName}/${name}`);
            } else if (tag === "EnumerationValue" && name && packagePath) {
                validIds.add(`${modelName}/${packagePath}.${name}`);
            } else {
                walk(child, packagePath);
            }
        });
    }

    walk(doc.documentElement, "");
    return validIds;
}

export function clampViewBox(next, bounds) {
    const margin = 200;
    const w = Math.max(50, Math.min(next.w, (bounds.maxX - bounds.minX + margin * 2) * 4));
    const h = Math.max(50, Math.min(next.h, (bounds.maxY - bounds.minY + margin * 2) * 4));
    const x = Math.max(bounds.minX - margin, Math.min(next.x, bounds.maxX + margin - w));
    const y = Math.max(bounds.minY - margin, Math.min(next.y, bounds.maxY + margin - h));
    return { x, y, w, h };
}
