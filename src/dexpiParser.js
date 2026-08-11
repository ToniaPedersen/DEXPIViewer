// DEXPI XML parser utilities â€" shared between App.jsx and validation engine

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
        const unitSymbol = unitRef.split(".").pop() || unitRef;
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

export function parseStroke(node) {
    const color = aggregatedValue(getData(node, "Color")?.firstElementChild);
    const width = numberFromData(node, "Width", 0.25);
    const dashStyle = refName(valueFromData(node, "DashStyle")) || "Solid";
    const dashMap = {
        Solid: "", Dash: `${4 * width} ${2 * width}`, Dot: `${width} ${2 * width}`,
        DashDot: `${4 * width} ${2 * width} ${width} ${2 * width}`,
        DashDotDot: `${4 * width} ${2 * width} ${width} ${2 * width} ${width} ${2 * width}`,
    };
    return { color: parseColor(color), width, dashArray: dashMap[dashStyle] || "", dashOffset: numberFromData(node, "Offset", 0) };
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
    const map = new Map();
    qsa(mainDoc, [
        'Object[type="Plant/Diagram.PipingNodePosition"]',
        'Object[type="Plant/Diagram.InstrumentationNodePosition"]',
        'Object[type="Core/Diagram.NodePosition"]'
    ].join(",")).forEach((obj, idx) => {
        const id = obj.getAttribute("id") || `nodePos_${idx}`;
        const position = aggregatedValue(getData(obj, "Position")?.firstElementChild);
        if (position) map.set(id, position);
    });
    return map;
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

export function collectGraphicalElements(mainDoc, symbolMap, discDoc = null) {
    const nodePosMap = parseNodePositionsById(mainDoc);
    const drawn = [];

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
    // objectId → [targetId, ...] for every References target the object
    // itself carries (any property, e.g. ParentStructure/PlantSystem/etc.) -
    // used by lookupProperty()'s nearby-object search below, since a
    // template placeholder like <ProcessPlantIdentificationCode> or
    // <PlantSystemIdentificationCode> lives on a REFERENCED ProcessPlant/
    // PlantSystem object, not on the object the template is attached to.
    const referencesByParentId = new Map();
    qsa(mainDoc, "Object[id]").forEach(el => {
        const id = el.getAttribute("id");
        objectTypeMap.set(id, el.getAttribute("type") || "");
        const props = new Map();
        directChildrenByTag(el, "Data").forEach(d => {
            const prop = d.getAttribute("property");
            if (prop) props.set(prop, dataValue(d));
        });
        if (props.size) objectDataMap.set(id, props);

        let p = el.parentNode;
        while (p && (typeof p.getAttribute !== "function" || !p.getAttribute("id"))) p = p.parentNode;
        const parentId = p && typeof p.getAttribute === "function" ? p.getAttribute("id") : null;
        if (parentId) {
            if (!childrenByParentId.has(parentId)) childrenByParentId.set(parentId, []);
            childrenByParentId.get(parentId).push({ id, type: el.getAttribute("type") || "" });
        }

        const refTargets = referenceTargets(el);
        if (refTargets.length) referencesByParentId.set(id, refTargets);
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

    // Look up objectId's Data property, and - when it's not there directly -
    // search up to two hops out through objectId's own nested children
    // (Components) and References targets (any property) for the nearest
    // object that DOES carry it. Several DiscProfile LabelTemplate.Text
    // placeholders name an attribute that lives on a related object rather
    // than the one the template itself is attached to - e.g.
    // <ProcessPlantIdentificationCode> lives on the ProcessPlant a
    // ProcessInstrumentationFunction reaches via its own ParentStructure
    // reference, and <PlantSystemIdentificationCode> on the PlantSystem it
    // reaches via its own PlantSystem reference - neither is a property of
    // the PIF itself. Breadth-first, so the CLOSEST object with a matching
    // property wins over a more distant one.
    function lookupProperty(objectId, attributeName) {
        const direct = ownProperty(objectId, attributeName);
        if (direct !== undefined) return direct;
        if (!objectId) return undefined;
        const seen = new Set([objectId]);
        let frontier = [objectId];
        for (let depth = 0; depth < 2 && frontier.length; depth++) {
            const next = [];
            for (const id of frontier) {
                const neighborIds = [
                    ...(childrenByParentId.get(id) || []).map(c => c.id),
                    ...(referencesByParentId.get(id) || []),
                ];
                for (const nid of neighborIds) {
                    if (!nid || seen.has(nid)) continue;
                    seen.add(nid);
                    const v = ownProperty(nid, attributeName);
                    if (v !== undefined) return v;
                    next.push(nid);
                }
            }
            frontier = next;
        }
        return undefined;
    }

    // Render a resolved Data value (string / number / boolean / DataReference /
    // PhysicalQuantity / SingleLanguageString) down to display text, honouring
    // an AttributeRepresentation fragment's Type (Value | Units | ValueAndUnits).
    function fragmentValueToText(raw, repType) {
        if (raw === null || raw === undefined) return "";
        if (typeof raw === "string") return raw;
        if (typeof raw === "number") return String(raw);
        if (typeof raw === "boolean") return raw ? "true" : "false";
        if (raw.kind === "DataReference") return refName(raw);
        if (raw.kind === "PhysicalQuantity") {
            const val = raw.value !== null && raw.value !== undefined ? String(raw.value) : "";
            if (repType === "Units") return raw.unit || "";
            if (repType === "ValueAndUnits") return [val, raw.unit].filter(Boolean).join(" ");
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
            if (f.kind === "attr") return fragmentValueToText(lookupProperty(f.objectId, f.attributeName), f.repType);
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

    // Fallback for a DiscProfile-symbol label whose own Text carries no
    // Template: substitute <PlaceholderName> tokens in the matching symbol
    // variant's Profile/LabelTemplate.Text against representedId's own (or,
    // failing that, a nearby related object's - see lookupProperty() above)
    // Data properties. Handles two placeholder forms:
    //   <AttributeName>                 e.g. "<ObjectDisplayName>",
    //                                    "<ProcessPlantIdentificationCode>-<PlantSystemIdentificationCode>"
    //                                    - looked up via lookupProperty(),
    //                                    which searches outward from
    //                                    representedId (its own data first,
    //                                    then nested children/references)
    //                                    for the nearest object that has it.
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
    function resolveProfileLabelFallback(rawLabelTemplateText, representedId, roleCounters = {}) {
        if (!rawLabelTemplateText) return null;
        // Some DiscProfile.xml LabelTemplate.Text values embed a VB-style
        // string-concatenation formula fragment, e.g.
        // "H=' & SignalConveyingFunction:<AlarmValue>" - the "' & " in the
        // middle is formula syntax (a string literal's closing quote plus
        // the "&" concatenation operator), not text meant to be shown. Strip
        // it so the literal "H=" prefix runs directly into the resolved
        // value (e.g. "H=100"), not "H=' & 100".
        const labelTemplateText = rawLabelTemplateText.replace(/'\s*&\s*/g, "");
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
                return fragmentValueToText(ownProperty(targetId, attrName), "Value");
            }
            // A bare placeholder renders blank when unresolved, rather than
            // suppressing the whole (possibly multi-field) template - see
            // the comment above.
            return fragmentValueToText(lookupProperty(representedId, attrName), "Value");
        });
        return unresolved ? null : text;
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
        const isLabelGroup = groupType === "Core/Diagram.Label";

        const localRepresents = resolveRepresentedId(groupNode, currentRepresents);
        directComponentsObjects(groupNode, "Elements").forEach((el, i) => {
            const type = el.getAttribute("type") || "";
            if (type === "Profile/SymbolUsage") {
                pushSymbolUsage(referenceTargets(el, "Symbol")[0] || null, el, localRepresents, `${keyPrefix}_su_${i}`, isLabelGroup ? "label" : "symbol");
            } else if (type === "Core/Diagram.ShapeUsage") {
                pushSymbolUsage(referenceTargets(el, "Shape")[0] || null, el, localRepresents, `${keyPrefix}_shu_${i}`, isLabelGroup ? "label" : "symbol");
            } else if (type === "Core/Diagram.Label") {
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
    drawn.forEach(el => {
        if (el.kind === "symbolUsage" && el.representedId && el.symbol?.key?.startsWith("DiscProfile/") && !discSymbolByRepresentedId.has(el.representedId)) {
            discSymbolByRepresentedId.set(el.representedId, { symbol: el.symbol, variant: el.variant });
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
    function resolveFilteredTemplateFragments(fragments) {
        if (!fragments || !fragments.length) return null;
        return fragments.map(f => {
            if (f.kind === "literal") return f.text || "";
            if (f.kind === "attr") {
                const discInfoForFrag = f.objectId ? discSymbolByRepresentedId.get(f.objectId) : null;
                const allowed = discInfoForFrag ? labelTemplateAttrsForSymbol(discInfoForFrag.symbol) : null;
                if (allowed && allowed.size) {
                    const bare = f.attributeName.split("/").pop();
                    if (!allowed.has(f.attributeName) && !allowed.has(bare)) return "";
                }
                return fragmentValueToText(lookupProperty(f.objectId, f.attributeName), f.repType);
            }
            return "";
        }).join("");
    }

    drawn.forEach(el => {
        if (el.elementRole !== "label" || el.kind !== "primitive" || el.primitive?.kind !== "text") return;
        const discInfo = el.representedId ? discSymbolByRepresentedId.get(el.representedId) : null;
        el.primitive.isDiscProfileLabel = !!discInfo;
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
        el.primitive.isProfileGoverned = !!discDoc && (el.primitive.isDiscProfileLabel || instanceHasAttr);
        el.primitive.hasProfileAttributeBacking = !!discDoc && (instanceHasAttr || catalogHasAttr);
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
    drawn.forEach(el => {
        if (el.elementRole !== "label" || el.kind !== "primitive" || el.primitive?.kind !== "text") return;
        el.primitive.rawProfileText = el.primitive.profileText;
        el.primitive.validRawProfileText = resolveFilteredTemplateFragments(el.primitive.templateFragments);
    });

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
        const overlays = templates
            .map(lt => ({ text: resolveProfileLabelFallback(lt.text, el.representedId, roleCounters), position: lt.position, rotation: lt.rotation, alignment: lt.alignment, font: lt.font, size: lt.size, color: lt.color }))
            .filter(o => o.text);
        if (overlays.length) el.labelOverlays = overlays;
    });

    return { elements: drawn, nodePosMap };
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
 *       "HeatTracingType" pointing at a ConstrainedType not in the built-in set.
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
    return { mainDoc, discDoc, tree, flatTree, treeMap, symbolMap, graphics, meta, connectivityMap, heatTraceSet };
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
