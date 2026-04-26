// DEXPI XML parser utilities – shared between App.jsx and validation engine

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
    if (type === "Core/Diagram.Text") return {
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
    };
    if (type === "Core/Diagram.ConnectorLine") return {
        kind: "connectorLine", key,
        innerPoints: parsePointsFromData(getData(objectNode, "InnerPoints")),
        stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 },
        sourceRef: referenceTargets(objectNode, "Source")[0] || null,
        targetRef: referenceTargets(objectNode, "Target")[0] || null
    };
    return null;
}

export function referenceTargets(node, property = null) {
    if (!node) return [];
    return directChildrenByTag(node, "References")
        .filter(r => !property || r.getAttribute("property") === property)
        .flatMap(r => (r.getAttribute("objects") || "").split(/\s+/).filter(Boolean).map(v => v.startsWith("#") ? v.slice(1) : v));
}

export function parseSymbolCatalogue(discDoc) {
    if (!discDoc) return new Map();
    const map = new Map();
    qsa(discDoc, 'Object[type="Profile/Symbol"]').forEach(obj => {
        const name = obj.getAttribute("name") || obj.getAttribute("id") || "";
        const symbolKey = `DiscProfile/${name}`;
        const variants = directComponentsObjects(obj, "Variants").map((variant, i) => ({
            key: `${symbolKey}_${i}`, name: variant.getAttribute("name") || `${name}_${i}`,
            minX: numberFromData(variant, "MinX", 0), minY: numberFromData(variant, "MinY", 0),
            maxX: numberFromData(variant, "MaxX", 0), maxY: numberFromData(variant, "MaxY", 0),
            primitives: directComponentsObjects(variant, "Primitives").map(parsePrimitive).filter(Boolean),
        }));
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

export function collectGraphicalElements(mainDoc, symbolMap) {
    const nodePosMap = parseNodePositionsById(mainDoc);
    const drawn = [];

    function resolveRepresentedId(node, fallback = null) { return referenceTargets(node, "Represents")[0] || fallback; }

    function resolveShapeReference(ref) {
        if (!ref) return null;
        return symbolMap.get(ref)
            || symbolMap.get(ref.startsWith("#") ? ref.slice(1) : `#${ref}`)
            || symbolMap.get(`DiscProfile/${ref.split("/").pop()}`)
            || null;
    }

    function pushSymbolUsage(rawRef, el, representedId, key) {
        const symbol = resolveShapeReference(rawRef);
        const variant = symbol?.variants?.[0];
        if (!variant) return;
        drawn.push({
            kind: "symbolUsage", key, representedId, symbol, variant,
            position: aggregatedValue(getData(el, "Position")?.firstElementChild) || { x: 0, y: 0 },
            rotation: numberFromData(el, "Rotation", 0),
            scaleX: numberFromData(el, "ScaleX", 1),
            scaleY: numberFromData(el, "ScaleY", 1),
            isMirrored: !!valueFromData(el, "IsMirrored")
        });
    }

    function traverseGroup(groupNode, currentRepresents = null, keyPrefix = "g") {
        const localRepresents = resolveRepresentedId(groupNode, currentRepresents);
        directComponentsObjects(groupNode, "Elements").forEach((el, i) => {
            const type = el.getAttribute("type") || "";
            if (type === "Profile/SymbolUsage") {
                pushSymbolUsage(referenceTargets(el, "Symbol")[0] || null, el, localRepresents, `${keyPrefix}_su_${i}`);
            } else if (type === "Core/Diagram.ShapeUsage") {
                pushSymbolUsage(referenceTargets(el, "Shape")[0] || null, el, localRepresents, `${keyPrefix}_shu_${i}`);
            } else if (type === "Core/Diagram.Label") {
                const labelRepresents = resolveRepresentedId(el, localRepresents);
                directComponentsObjects(el, "Elements").forEach((lel, li) => {
                    const lt = lel.getAttribute("type") || "";
                    if (lt === "Core/Diagram.Text") {
                        const prim = parsePrimitive(lel, li);
                        if (prim) drawn.push({ kind: "primitive", primitive: prim, representedId: labelRepresents, key: `${keyPrefix}_lbltxt_${i}_${li}` });
                    } else if (lt === "Core/Diagram.ShapeUsage") {
                        pushSymbolUsage(referenceTargets(lel, "Shape")[0] || null, lel, labelRepresents, `${keyPrefix}_lblshape_${i}_${li}`);
                    } else if (lt === "Profile/SymbolUsage") {
                        pushSymbolUsage(referenceTargets(lel, "Symbol")[0] || null, lel, labelRepresents, `${keyPrefix}_lblsym_${i}_${li}`);
                    }
                });
            } else {
                const prim = parsePrimitive(el, i);
                if (!prim) return;
                if (prim.kind === "connectorLine") {
                    drawn.push({ kind: "connectorLine", primitive: prim, representedId: localRepresents, key: `${keyPrefix}_cl_${i}` });
                } else {
                    drawn.push({ kind: "primitive", primitive: prim, representedId: localRepresents, key: `${keyPrefix}_p_${i}` });
                }
            }
        });
        directComponentsObjects(groupNode, "Groups").forEach((child, i) => traverseGroup(child, localRepresents, `${keyPrefix}_${i}`));
    }

    qsa(mainDoc, 'Object[type="Core/Diagram.RepresentationGroup"]').forEach((g, i) => traverseGroup(g, null, `rg_${i}`));
    return { elements: drawn, nodePosMap };
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
    if (mainDoc.querySelector("parseerror")) throw new Error("Main XML is not well-formed.");
    if (discDoc && discDoc.querySelector("parseerror")) throw new Error("DiscProfile XML is not well-formed.");
    const conceptualRoot = mainDoc.querySelector('Object[type="Core/EngineeringModel"] > Components[property="ConceptualModel"] > Object');
    if (!conceptualRoot) throw new Error("Could not find ConceptualModel in the DEXPI file.");
    const tree = parseTreeFromConceptual(conceptualRoot);
    const flatTree = flattenTree(tree);
    const treeMap = new Map(flatTree.filter(n => n.objectId).map(n => [n.objectId, n]));
    const externalSymbolMap = parseSymbolCatalogue(discDoc);
    const internalShapeMap = parseInternalShapeCatalogue(mainDoc);
    const symbolMap = new Map([...internalShapeMap, ...externalSymbolMap]);
    const graphics = collectGraphicalElements(mainDoc, symbolMap);
    const metaNode = mainDoc.querySelector('Components[property="MetaData"] > Object');
    const meta = metaNode ? {
        drawingName: valueFromData(metaNode, "DrawingName") || "",
        drawingNumber: valueFromData(metaNode, "DrawingNumber") || "",
        subtitle: aggregatedValue(getData(metaNode, "DrawingSubTitle")?.firstElementChild) || "",
        processPlantName: valueFromData(metaNode, "ProcessPlantName") || "",
        creatorName: valueFromData(metaNode, "CreatorName") || ""
    } : {};
    const connectivityMap = buildConnectivityMap(flatTree);
    return { mainDoc, discDoc, tree, flatTree, treeMap, symbolMap, graphics, meta, connectivityMap };
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

export function clampViewBox(next, bounds) {
    const margin = 200;
    const w = Math.max(50, Math.min(next.w, (bounds.maxX - bounds.minX + margin * 2) * 4));
    const h = Math.max(50, Math.min(next.h, (bounds.maxY - bounds.minY + margin * 2) * 4));
    const x = Math.max(bounds.minX - margin, Math.min(next.x, bounds.maxX + margin - w));
    const y = Math.max(bounds.minY - margin, Math.min(next.y, bounds.maxY + margin - h));
    return { x, y, w, h };
}

