import React, { useEffect, useMemo, useRef, useState } from "react";

const styles = {
    app: { display: "grid", gridTemplateColumns: "320px 1fr 320px", height: "100vh", fontFamily: "Arial, sans-serif", color: "#111" },
    appLeftCollapsed: { display: "grid", gridTemplateColumns: "44px 1fr 320px", height: "100vh", fontFamily: "Arial, sans-serif", color: "#111" },
    appRightCollapsed: { display: "grid", gridTemplateColumns: "320px 1fr 44px", height: "100vh", fontFamily: "Arial, sans-serif", color: "#111" },
    appBothCollapsed: { display: "grid", gridTemplateColumns: "44px 1fr 44px", height: "100vh", fontFamily: "Arial, sans-serif", color: "#111" },
    panel: { borderRight: "1px solid #d0d7de", overflow: "auto", background: "#fff" },
    collapsedPanel: { borderRight: "1px solid #d0d7de", overflow: "hidden", background: "#fff", display: "flex", alignItems: "stretch", justifyContent: "center" },
    rightPanel: { borderLeft: "1px solid #d0d7de", overflow: "auto", background: "#fff" },
    collapsedRightPanel: { borderLeft: "1px solid #d0d7de", overflow: "hidden", background: "#fff", display: "flex", alignItems: "stretch", justifyContent: "center" },
    toolbar: { padding: 12, borderBottom: "1px solid #d0d7de", position: "sticky", top: 0, background: "#f6f8fa", zIndex: 2 },
    button: { padding: "8px 10px", border: "1px solid #c7ced6", background: "white", borderRadius: 6, cursor: "pointer" },
    input: { width: "100%", padding: 8, border: "1px solid #c7ced6", borderRadius: 6, boxSizing: "border-box" },
    section: { padding: 12, borderBottom: "1px solid #eef2f6" },
    center: { position: "relative", overflow: "hidden", background: "#f8fafc" },
    badge: { display: "inline-block", padding: "3px 8px", border: "1px solid #d0d7de", borderRadius: 999, fontSize: 12, background: "#fff" },
    collapseButton: { width: "100%", height: "100%", border: "none", background: "#f6f8fa", cursor: "pointer", fontSize: 18, color: "#57606a" },
    toolbarRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
};

function qsa(node, selector) {
    return Array.from(node.querySelectorAll(selector));
}

function directChildrenByTag(node, tag) {
    if (!node || !node.children) return [];
    return Array.from(node.children).filter((c) => c && c.tagName === tag);
}

function directComponentsObjects(node, property = null) {
    if (!node) return [];
    const comps = directChildrenByTag(node, "Components").filter((c) => !property || c.getAttribute("property") === property);
    return comps.flatMap((c) => directChildrenByTag(c, "Object"));
}

function dataValue(dataNode) {
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

function getData(node, property) {
    if (!node) return undefined;
    return directChildrenByTag(node, "Data").find((d) => d.getAttribute("property") === property);
}

function aggregatedValue(aggNode) {
    if (!aggNode || typeof aggNode.getAttribute !== "function") return null;
    const type = aggNode.getAttribute("type") || "";
    if (type === "Core/Diagram.Point") {
        return { x: numberFromData(aggNode, "X"), y: numberFromData(aggNode, "Y") };
    }
    if (type === "Core/Diagram.Color") {
        return { r: intFromData(aggNode, "R", 0), g: intFromData(aggNode, "G", 0), b: intFromData(aggNode, "B", 0) };
    }
    if (type === "Core/Diagram.Stroke") return parseStroke(aggNode);
    if (type === "Core/Diagram.TextStyle") {
        return {
            color: aggregatedValue(getData(aggNode, "Color")?.firstElementChild),
            font: valueFromData(aggNode, "Font") || "Arial",
            size: numberFromData(aggNode, "Height") || 3.5,
            horizontal: refName(valueFromData(aggNode, "HorizontalAlignment")) || "Center",
            vertical: refName(valueFromData(aggNode, "VerticalAlignment")) || "Center",
        };
    }
    if (type === "Core/DataTypes.MultiLanguageString") {
        const items = directChildrenByTag(aggNode, "Data").filter((d) => d.getAttribute("property") === "SingleLanguageStrings");
        const vals = items.map((d) => aggregatedValue(d.firstElementChild)).filter(Boolean);
        return vals.map((v) => v.value).join(" ");
    }
    if (type === "Core/DataTypes.SingleLanguageString") {
        return { language: valueFromData(aggNode, "Language") || "", value: valueFromData(aggNode, "Value") || "" };
    }
    return { type, raw: aggNode };
}

function valueFromData(node, property) {
    return dataValue(getData(node, property));
}

function numberFromData(node, property, fallback = 0) {
    const v = valueFromData(node, property);
    return typeof v === "number" ? v : fallback;
}

function intFromData(node, property, fallback = 0) {
    const v = valueFromData(node, property);
    return Number.isInteger(v) ? v : fallback;
}

function parseColor(value) {
    if (!value) return "#000000";
    const r = (value.r ?? 0).toString(16).padStart(2, "0");
    const g = (value.g ?? 0).toString(16).padStart(2, "0");
    const b = (value.b ?? 0).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
}

function refName(value) {
    if (!value) return "";
    if (typeof value === "string") return value.split(".").pop().split("/").pop();
    if (value.kind === "DataReference") return value.value.split(".").pop().split("/").pop();
    return "";
}

function parseStroke(node) {
    const color = aggregatedValue(getData(node, "Color")?.firstElementChild);
    const width = numberFromData(node, "Width", 0.25);
    const dashStyle = refName(valueFromData(node, "DashStyle")) || "Solid";
    const dashMap = {
        Solid: "",
        Dash: `${4 * width} ${2 * width}`,
        Dot: `${width} ${2 * width}`,
        DashDot: `${4 * width} ${2 * width} ${width} ${2 * width}`,
        DashDotDot: `${4 * width} ${2 * width} ${width} ${2 * width} ${width} ${2 * width}`,
    };
    return { color: parseColor(color), width, dashArray: dashMap[dashStyle] || "", dashOffset: numberFromData(node, "Offset", 0) };
}

function parseFill(node) {
    const style = refName(valueFromData(node, "FillStyle")) || "Transparent";
    const color = aggregatedValue(getData(node, "Color")?.firstElementChild);
    return { style, color: parseColor(color) };
}

function parsePointsFromData(dataNode) {
    return directChildrenByTag(dataNode, "AggregatedDataValue").map((p) => aggregatedValue(p)).filter(Boolean);
}

function parsePrimitive(objectNode, idx) {
    if (!objectNode || typeof objectNode.getAttribute !== "function") return null;
    const type = objectNode.getAttribute("type") || "";
    const key = `${type}_${idx}`;

    if (type === "Core/Diagram.PolyLine") {
        return { kind: "polyline", key, points: parsePointsFromData(getData(objectNode, "Points")), stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 } };
    }
    if (type === "Core/Diagram.Polygon") {
        return { kind: "polygon", key, points: parsePointsFromData(getData(objectNode, "Points")), stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 }, fill: parseFill(objectNode) };
    }
    if (type === "Core/Diagram.Circle") {
        return { kind: "circle", key, center: aggregatedValue(getData(objectNode, "Center")?.firstElementChild) || { x: 0, y: 0 }, radius: numberFromData(objectNode, "Radius", 1), stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 }, fill: parseFill(objectNode) };
    }
    if (type === "Core/Diagram.Ellipse") {
        return { kind: "ellipse", key, center: aggregatedValue(getData(objectNode, "Center")?.firstElementChild) || { x: 0, y: 0 }, rx: numberFromData(objectNode, "HorizontalSemiAxis", 1), ry: numberFromData(objectNode, "VerticalSemiAxis", 1), rotation: numberFromData(objectNode, "Rotation", 0), stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 }, fill: parseFill(objectNode) };
    }
    if (type === "Core/Diagram.Rectangle") {
        return { kind: "rect", key, center: aggregatedValue(getData(objectNode, "Center")?.firstElementChild) || { x: 0, y: 0 }, width: numberFromData(objectNode, "Width", 1), height: numberFromData(objectNode, "Height", 1), rotation: numberFromData(objectNode, "Rotation", 0), stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 }, fill: parseFill(objectNode) };
    }
    if (type === "Core/Diagram.Text") {
        return {
            kind: "text",
            key,
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
    }
    if (type === "Core/Diagram.ConnectorLine") {
        return { kind: "connectorLine", key, innerPoints: parsePointsFromData(getData(objectNode, "InnerPoints")), stroke: aggregatedValue(getData(objectNode, "Stroke")?.firstElementChild) || { color: "#000", width: 0.25 }, sourceRef: referenceTargets(objectNode, "Source")[0] || null, targetRef: referenceTargets(objectNode, "Target")[0] || null };
    }
    return null;
}

function parseSymbolCatalogue(discDoc) {
    if (!discDoc) return new Map();
    const map = new Map();
    qsa(discDoc, 'Object[type="Profile/Symbol"]').forEach((obj) => {
        const name = obj.getAttribute("name") || obj.getAttribute("id") || "";
        const symbolKey = `DiscProfile/${name}`;
        const variants = directComponentsObjects(obj, "Variants").map((variant, i) => ({
            key: `${symbolKey}_${i}`,
            name: variant.getAttribute("name") || `${name}_${i}`,
            minX: numberFromData(variant, "MinX", 0),
            minY: numberFromData(variant, "MinY", 0),
            maxX: numberFromData(variant, "MaxX", 0),
            maxY: numberFromData(variant, "MaxY", 0),
            mirroringAllowed: !!valueFromData(variant, "MirroringAllowed"),
            resizeX: !!valueFromData(variant, "ResizingXAllowed"),
            resizeY: !!valueFromData(variant, "ResizingYAllowed"),
            rotationAllowed: !!valueFromData(variant, "RotationAllowed"),
            primitives: directComponentsObjects(variant, "Primitives").map(parsePrimitive).filter(Boolean),
            nodePositions: [],
            labelTemplates: [],
        }));
        map.set(symbolKey, { key: symbolKey, name, usage: "external-symbol", description: "", variants });
    });
    return map;
}

function inferBoundsFromPrimitives(primitives) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visit = (p) => {
        if (!p) return;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    };
    primitives.forEach((p) => {
        if (p.kind === "polyline" || p.kind === "polygon") p.points.forEach(visit);
        else if (p.kind === "circle") { visit({ x: p.center.x - p.radius, y: p.center.y - p.radius }); visit({ x: p.center.x + p.radius, y: p.center.y + p.radius }); }
        else if (p.kind === "ellipse") { visit({ x: p.center.x - p.rx, y: p.center.y - p.ry }); visit({ x: p.center.x + p.rx, y: p.center.y + p.ry }); }
        else if (p.kind === "rect") { visit({ x: p.center.x - p.width / 2, y: p.center.y - p.height / 2 }); visit({ x: p.center.x + p.width / 2, y: p.center.y + p.height / 2 }); }
        else if (p.kind === "text") visit(p.position);
    });
    if (!Number.isFinite(minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    return { minX, minY, maxX, maxY };
}

function parseInternalShapeCatalogue(mainDoc) {
    if (!mainDoc) return new Map();
    const map = new Map();
    qsa(mainDoc, 'Object[type="Core/Diagram.ShapeCatalogue"] > Components[property="Shapes"] > Object[type="Core/Diagram.Shape"]').forEach((obj, idx) => {
        const id = obj.getAttribute("id") || `internal_shape_${idx}`;
        const primitives = directComponentsObjects(obj, "Elements").map(parsePrimitive).filter(Boolean).concat(directComponentsObjects(obj, "Primitives").map(parsePrimitive).filter(Boolean));
        const bounds = inferBoundsFromPrimitives(primitives);
        const shape = {
            key: id,
            name: valueFromData(obj, "Name") || id,
            usage: "internal-shape",
            description: valueFromData(obj, "SymbolRegistrationNumber") || "",
            variants: [{ key: `${id}_variant_0`, name: valueFromData(obj, "Name") || id, minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY, mirroringAllowed: true, resizeX: true, resizeY: true, rotationAllowed: true, primitives, nodePositions: [], labelTemplates: [] }],
        };
        map.set(id, shape);
        map.set(`#${id}`, shape);
    });
    return map;
}

function parseTreeFromConceptual(rootObject) {
    if (!rootObject) throw new Error("Conceptual model root object is missing.");
    function walk(obj, path = []) {
        if (!obj || typeof obj.getAttribute !== "function") return null;
        const id = obj.getAttribute("id") || "";
        const type = obj.getAttribute("type") || "";
        const label = valueFromData(obj, "DiscProfile/ObjectDisplayName") || valueFromData(obj, "DiscProfile/ItemTag") || valueFromData(obj, "InstrumentationLoopFunctionNumber") || id || type.split("/").pop();
        const data = directChildrenByTag(obj, "Data").map((d) => ({ property: d.getAttribute("property") || "", value: dataValue(d) }));
        const persistentIdentifiers = directComponentsObjects(obj, "PersistentIdentifiers").map((pidObj) => ({ context: valueFromData(pidObj, "Context") || "", value: valueFromData(pidObj, "Value") || "" })).filter((pid) => pid.context || pid.value);
        const refs = directChildrenByTag(obj, "References").map((r) => ({ property: r.getAttribute("property") || "", objects: (r.getAttribute("objects") || "").split(/\s+/).filter(Boolean).map((v) => (v.startsWith("#") ? v.slice(1) : v)) }));
        const children = directChildrenByTag(obj, "Components").flatMap((comp, compIdx) => {
            const prop = comp.getAttribute("property") || `comp_${compIdx}`;
            return directChildrenByTag(comp, "Object").map((child, i) => ({ prop, child: walk(child, [...path, `${prop}:${i}`]) }));
        }).filter(({ child }) => !!child).map(({ prop, child }) => ({ ...child, edgeLabel: prop }));
        return { id: id || `${type}_${path.join("_")}`, objectId: id || null, type, label, data, persistentIdentifiers, refs, children };
    }
    return walk(rootObject);
}

function flattenTree(node, arr = []) {
    if (!node) return arr;
    arr.push(node);
    node.children.forEach((c) => flattenTree(c, arr));
    return arr;
}

function referenceTargets(node, property = null) {
    if (!node) return [];
    return directChildrenByTag(node, "References").filter((r) => !property || r.getAttribute("property") === property).flatMap((r) => (r.getAttribute("objects") || "").split(/\s+/).filter(Boolean).map((v) => (v.startsWith("#") ? v.slice(1) : v)));
}

function parseNodePositionsById(mainDoc) {
    const map = new Map();
    qsa(mainDoc, 'Object[type="Plant/Diagram.PipingNodePosition"], Object[type="Plant/Diagram.InstrumentationNodePosition"], Object[type="Core/Diagram.NodePosition"]').forEach((obj, idx) => {
        const id = obj.getAttribute("id") || `nodePos_${idx}`;
        const position = aggregatedValue(getData(obj, "Position")?.firstElementChild);
        if (position) map.set(id, position);
    });
    return map;
}

function collectGraphicalElements(mainDoc, symbolMap) {
    const nodePosMap = parseNodePositionsById(mainDoc);
    const drawn = [];
    function resolveRepresentedId(node, fallback = null) {
        return referenceTargets(node, "Represents")[0] || fallback;
    }
    function resolveShapeReference(ref) {
        if (!ref) return null;
        return symbolMap.get(ref) || symbolMap.get(ref.startsWith("#") ? ref.slice(1) : `#${ref}`) || symbolMap.get(`DiscProfile/${ref.split("/").pop()}`) || null;
    }
    function pushSymbolUsage(rawRef, el, representedId, key) {
        const symbol = resolveShapeReference(rawRef);
        const variant = symbol?.variants?.[0];
        if (!variant) return;
        drawn.push({ kind: "symbolUsage", key, representedId, symbolKey: rawRef, symbol, variant, position: aggregatedValue(getData(el, "Position")?.firstElementChild) || { x: 0, y: 0 }, rotation: numberFromData(el, "Rotation", 0), scaleX: numberFromData(el, "ScaleX", 1), scaleY: numberFromData(el, "ScaleY", 1), isMirrored: !!valueFromData(el, "IsMirrored") });
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
                directComponentsObjects(el, "Elements").forEach((labelEl, labelIdx) => {
                    const labelType = labelEl.getAttribute("type") || "";
                    if (labelType === "Core/Diagram.Text") {
                        const prim = parsePrimitive(labelEl, labelIdx);
                        if (prim) drawn.push({ kind: "primitive", primitive: prim, representedId: labelRepresents, key: `${keyPrefix}_lbltxt_${i}_${labelIdx}` });
                    } else if (labelType === "Core/Diagram.ShapeUsage") {
                        pushSymbolUsage(referenceTargets(labelEl, "Shape")[0] || null, labelEl, labelRepresents, `${keyPrefix}_lblshape_${i}_${labelIdx}`);
                    } else if (labelType === "Profile/SymbolUsage") {
                        pushSymbolUsage(referenceTargets(labelEl, "Symbol")[0] || null, labelEl, labelRepresents, `${keyPrefix}_lblsym_${i}_${labelIdx}`);
                    }
                });
            } else {
                const prim = parsePrimitive(el, i);
                if (!prim) return;
                if (prim.kind === "connectorLine") drawn.push({ kind: "connectorLine", primitive: prim, representedId: localRepresents, key: `${keyPrefix}_cl_${i}` });
                else drawn.push({ kind: "primitive", primitive: prim, representedId: localRepresents, key: `${keyPrefix}_p_${i}` });
            }
        });
        directComponentsObjects(groupNode, "Groups").forEach((child, i) => traverseGroup(child, localRepresents, `${keyPrefix}_${i}`));
    }
    qsa(mainDoc, 'Object[type="Core/Diagram.RepresentationGroup"]').forEach((g, i) => traverseGroup(g, null, `rg_${i}`));
    return { elements: drawn, nodePosMap };
}

function parseDexpiPackage(mainXml, discProfileXml) {
    const parser = new DOMParser();
    const mainDoc = parser.parseFromString(mainXml, "application/xml");
    const discDoc = discProfileXml ? parser.parseFromString(discProfileXml, "application/xml") : null;
    if (mainDoc.querySelector("parsererror")) throw new Error("Main XML is not valid.");
    if (discDoc && discDoc.querySelector("parsererror")) throw new Error("DiscProfile XML is not valid.");
    const conceptualRoot = mainDoc.querySelector('Object[type="Core/EngineeringModel"] > Components[property="ConceptualModel"] > Object');
    if (!conceptualRoot) throw new Error("Could not find ConceptualModel in the main DEXPI file.");
    const tree = parseTreeFromConceptual(conceptualRoot);
    const flatTree = flattenTree(tree);
    const treeMap = new Map(flatTree.filter((n) => n.objectId).map((n) => [n.objectId, n]));
    const externalSymbolMap = parseSymbolCatalogue(discDoc);
    const internalShapeMap = parseInternalShapeCatalogue(mainDoc);
    const symbolMap = new Map([...internalShapeMap, ...externalSymbolMap]);
    const graphics = collectGraphicalElements(mainDoc, symbolMap);
    const metaNode = mainDoc.querySelector('Components[property="MetaData"] > Object');
    const meta = metaNode ? { drawingName: valueFromData(metaNode, "DrawingName") || "", drawingNumber: valueFromData(metaNode, "DrawingNumber") || "", subtitle: aggregatedValue(getData(metaNode, "DrawingSubTitle")?.firstElementChild) || "", processPlantName: valueFromData(metaNode, "ProcessPlantName") || "", creatorName: valueFromData(metaNode, "CreatorName") || "" } : {};
    return { mainDoc, discDoc, tree, flatTree, treeMap, symbolMap, graphics, meta };
}

function boundsFromElements(graphics) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visit = (p) => {
        if (!p) return;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    };
    graphics.elements.forEach((el) => {
        if (el.kind === "symbolUsage") {
            const v = el.variant;
            visit({ x: el.position.x + v.minX * el.scaleX, y: el.position.y + v.minY * el.scaleY });
            visit({ x: el.position.x + v.maxX * el.scaleX, y: el.position.y + v.maxY * el.scaleY });
        } else if (el.primitive.kind === "polyline" || el.primitive.kind === "polygon") {
            el.primitive.points.forEach(visit);
        } else if (el.primitive.kind === "connectorLine") {
            el.primitive.innerPoints.forEach(visit);
        } else if (el.primitive.kind === "circle") {
            visit({ x: el.primitive.center.x - el.primitive.radius, y: el.primitive.center.y - el.primitive.radius });
            visit({ x: el.primitive.center.x + el.primitive.radius, y: el.primitive.center.y + el.primitive.radius });
        } else if (el.primitive.kind === "ellipse") {
            visit({ x: el.primitive.center.x - el.primitive.rx, y: el.primitive.center.y - el.primitive.ry });
            visit({ x: el.primitive.center.x + el.primitive.rx, y: el.primitive.center.y + el.primitive.ry });
        } else if (el.primitive.kind === "rect") {
            visit({ x: el.primitive.center.x - el.primitive.width / 2, y: el.primitive.center.y - el.primitive.height / 2 });
            visit({ x: el.primitive.center.x + el.primitive.width / 2, y: el.primitive.center.y + el.primitive.height / 2 });
        } else if (el.primitive.kind === "text") {
            visit(el.primitive.position);
        }
    });
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
    return { minX: minX - 30, minY: minY - 30, maxX: maxX + 30, maxY: maxY + 30 };
}

function clampViewBox(nextView, fullBounds) {
    const totalW = Math.max(1, fullBounds.maxX - fullBounds.minX);
    const totalH = Math.max(1, fullBounds.maxY - fullBounds.minY);
    const w = Math.min(Math.max(nextView.w, 20), totalW);
    const h = Math.min(Math.max(nextView.h, 20), totalH);
    const maxX = fullBounds.maxX - w;
    const maxY = fullBounds.maxY - h;
    return {
        x: Math.min(Math.max(nextView.x, fullBounds.minX), Math.max(fullBounds.minX, maxX)),
        y: Math.min(Math.max(nextView.y, fullBounds.minY), Math.max(fullBounds.minY, maxY)),
        w,
        h,
    };
}

function renderPrimitive(primitive, key, selected) {
    const opacity = selected ? 1 : 0.98;
    if (primitive.kind === "polyline") return <polyline key={key} points={primitive.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} strokeDasharray={primitive.stroke.dashArray || undefined} strokeDashoffset={primitive.stroke.dashOffset || undefined} vectorEffect="non-scaling-stroke" opacity={opacity} />;
    if (primitive.kind === "polygon") return <polygon key={key} points={primitive.points.map((p) => `${p.x},${p.y}`).join(" ")} fill={primitive.fill?.style === "Transparent" ? "none" : (primitive.fill?.color || "none")} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} strokeDasharray={primitive.stroke.dashArray || undefined} vectorEffect="non-scaling-stroke" opacity={opacity} />;
    if (primitive.kind === "circle") return <circle key={key} cx={primitive.center.x} cy={primitive.center.y} r={primitive.radius} fill={primitive.fill?.style === "Transparent" ? "none" : (primitive.fill?.color || "none")} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" opacity={opacity} />;
    if (primitive.kind === "ellipse") return <ellipse key={key} cx={primitive.center.x} cy={primitive.center.y} rx={primitive.rx} ry={primitive.ry} transform={`rotate(${primitive.rotation} ${primitive.center.x} ${primitive.center.y})`} fill={primitive.fill?.style === "Transparent" ? "none" : (primitive.fill?.color || "none")} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" opacity={opacity} />;
    if (primitive.kind === "rect") return <rect key={key} x={primitive.center.x - primitive.width / 2} y={primitive.center.y - primitive.height / 2} width={primitive.width} height={primitive.height} transform={`rotate(${primitive.rotation} ${primitive.center.x} ${primitive.center.y})`} fill={primitive.fill?.style === "Transparent" ? "none" : (primitive.fill?.color || "none")} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" opacity={opacity} />;
    if (primitive.kind === "text") {
        const anchor = primitive.style.horizontal.toLowerCase().includes("left") ? "start" : primitive.style.horizontal.toLowerCase().includes("right") ? "end" : "middle";
        const baseline = primitive.style.vertical.toLowerCase().includes("bottom") ? "baseline" : primitive.style.vertical.toLowerCase().includes("top") ? "hanging" : "middle";
        return <text key={key} x={primitive.position.x} y={primitive.position.y} fontFamily={primitive.style.font} fontSize={primitive.style.size} fill={parseColor(primitive.style.color)} textAnchor={anchor} dominantBaseline={baseline} transform={`rotate(${primitive.rotation} ${primitive.position.x} ${primitive.position.y})`}>{primitive.value}</text>;
    }
    return null;
}

function renderConnectorLine(el, nodePosMap, key, selected) {
    const { primitive } = el;
    const source = primitive.sourceRef ? nodePosMap.get(primitive.sourceRef) : null;
    const target = primitive.targetRef ? nodePosMap.get(primitive.targetRef) : null;
    const points = [source, ...primitive.innerPoints, target].filter(Boolean);
    if (points.length < 2) return null;
    return <polyline key={key} points={points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={selected ? "#d1242f" : primitive.stroke.color} strokeWidth={selected ? Math.max(primitive.stroke.width * 2, primitive.stroke.width + 0.4) : primitive.stroke.width} strokeDasharray={primitive.stroke.dashArray || undefined} vectorEffect="non-scaling-stroke" />;
}

function highlightPrimitive(p, key) {
    if (p.kind === "polyline") return <polyline key={key} points={p.points.map((pt) => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke="#d1242f" strokeWidth={Math.max((p.stroke?.width || 0.25) * 2.5, 0.9)} vectorEffect="non-scaling-stroke" opacity="0.9" />;
    if (p.kind === "polygon") return <polygon key={key} points={p.points.map((pt) => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke="#d1242f" strokeWidth={Math.max((p.stroke?.width || 0.25) * 2.5, 0.9)} vectorEffect="non-scaling-stroke" opacity="0.9" />;
    if (p.kind === "circle") return <circle key={key} cx={p.center.x} cy={p.center.y} r={p.radius} fill="none" stroke="#d1242f" strokeWidth={Math.max((p.stroke?.width || 0.25) * 2.5, 0.9)} vectorEffect="non-scaling-stroke" opacity="0.9" />;
    if (p.kind === "ellipse") return <ellipse key={key} cx={p.center.x} cy={p.center.y} rx={p.rx} ry={p.ry} transform={`rotate(${p.rotation} ${p.center.x} ${p.center.y})`} fill="none" stroke="#d1242f" strokeWidth={Math.max((p.stroke?.width || 0.25) * 2.5, 0.9)} vectorEffect="non-scaling-stroke" opacity="0.9" />;
    if (p.kind === "rect") return <rect key={key} x={p.center.x - p.width / 2} y={p.center.y - p.height / 2} width={p.width} height={p.height} transform={`rotate(${p.rotation} ${p.center.x} ${p.center.y})`} fill="none" stroke="#d1242f" strokeWidth={Math.max((p.stroke?.width || 0.25) * 2.5, 0.9)} vectorEffect="non-scaling-stroke" opacity="0.9" />;
    if (p.kind === "text") return <text key={key} x={p.position.x} y={p.position.y} fontFamily={p.style.font} fontSize={p.style.size} fill="#d1242f" textAnchor="middle" dominantBaseline="middle" transform={`rotate(${p.rotation} ${p.position.x} ${p.position.y})`}>{p.value}</text>;
    return null;
}

function SymbolGraphic({ el, selected, onSelect }) {
    const mirror = el.isMirrored ? -1 : 1;
    const transform = `translate(${el.position.x} ${el.position.y}) rotate(${el.rotation}) scale(${el.scaleX * mirror} ${el.scaleY})`;
    const hitPad = 2.5;
    const hitX = Math.min(el.variant.minX, el.variant.maxX) - hitPad;
    const hitY = Math.min(el.variant.minY, el.variant.maxY) - hitPad;
    const hitW = Math.abs(el.variant.maxX - el.variant.minX) + hitPad * 2;
    const hitH = Math.abs(el.variant.maxY - el.variant.minY) + hitPad * 2;
    return (
        <g onClick={(e) => { e.stopPropagation(); onSelect(el.representedId); }} style={{ cursor: el.representedId ? "pointer" : "default" }}>
            <g transform={transform}>
                <rect x={hitX} y={hitY} width={hitW} height={hitH} fill="transparent" stroke="none" pointerEvents="all" style={{ cursor: el.representedId ? "pointer" : "default" }} />
            </g>
            {selected && <g transform={transform} pointerEvents="none">{el.variant.primitives.map((p, i) => highlightPrimitive(p, `hl_${el.key}_${i}`))}</g>}
            <g transform={transform} pointerEvents="none">
                {el.variant.primitives.map((p, i) => renderPrimitive(p, `${el.key}_${i}`, selected))}
                {selected && <rect x={el.variant.minX - 0.8} y={el.variant.minY - 0.8} width={(el.variant.maxX - el.variant.minX) + 1.6} height={(el.variant.maxY - el.variant.minY) + 1.6} fill="none" stroke="#d1242f" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />}
            </g>
        </g>
    );
}

function PrimitiveGraphic({ el, selected, onSelect, nodePosMap }) {
    const hitPad = 2.0;
    const content = el.kind === "connectorLine" ? renderConnectorLine(el, nodePosMap, el.key, selected) : renderPrimitive(el.primitive, el.key, false);
    return (
        <g onClick={(e) => { e.stopPropagation(); if (el.representedId) onSelect(el.representedId); }} style={{ cursor: el.representedId ? "pointer" : "default" }}>
            {el.kind !== "connectorLine" && el.primitive?.kind === "circle" && <circle cx={el.primitive.center.x} cy={el.primitive.center.y} r={el.primitive.radius + hitPad} fill="transparent" stroke="none" pointerEvents="all" style={{ cursor: el.representedId ? "pointer" : "default" }} />}
            {el.kind !== "connectorLine" && el.primitive?.kind === "ellipse" && <ellipse cx={el.primitive.center.x} cy={el.primitive.center.y} rx={el.primitive.rx + hitPad} ry={el.primitive.ry + hitPad} transform={`rotate(${el.primitive.rotation} ${el.primitive.center.x} ${el.primitive.center.y})`} fill="transparent" stroke="none" pointerEvents="all" style={{ cursor: el.representedId ? "pointer" : "default" }} />}
            {el.kind !== "connectorLine" && el.primitive?.kind === "rect" && <rect x={el.primitive.center.x - el.primitive.width / 2 - hitPad} y={el.primitive.center.y - el.primitive.height / 2 - hitPad} width={el.primitive.width + hitPad * 2} height={el.primitive.height + hitPad * 2} transform={`rotate(${el.primitive.rotation} ${el.primitive.center.x} ${el.primitive.center.y})`} fill="transparent" stroke="none" pointerEvents="all" style={{ cursor: el.representedId ? "pointer" : "default" }} />}
            {el.kind !== "connectorLine" && (el.primitive?.kind === "polyline" || el.primitive?.kind === "polygon") && <polyline points={el.primitive.points.map((pt) => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke="transparent" strokeWidth={Math.max((el.primitive.stroke?.width || 0.25) + 4, 5)} vectorEffect="non-scaling-stroke" pointerEvents="stroke" style={{ cursor: el.representedId ? "pointer" : "default" }} />}
            {el.kind === "connectorLine" && (() => {
                const src = el.primitive.sourceRef ? nodePosMap.get(el.primitive.sourceRef) : null;
                const tgt = el.primitive.targetRef ? nodePosMap.get(el.primitive.targetRef) : null;
                const pts = [src, ...el.primitive.innerPoints, tgt].filter(Boolean);
                if (pts.length < 2) return null;
                return <polyline points={pts.map((pt) => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke="transparent" strokeWidth={Math.max((el.primitive.stroke?.width || 0.25) + 4, 5)} vectorEffect="non-scaling-stroke" pointerEvents="stroke" style={{ cursor: el.representedId ? "pointer" : "default" }} />;
            })()}
            {selected && el.kind !== "connectorLine" && highlightPrimitive(el.primitive, `sel_${el.key}`)}
            {content}
            {selected && el.primitive?.kind === "text" && <circle cx={el.primitive.position.x} cy={el.primitive.position.y} r={2} fill="none" stroke="#d1242f" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />}
        </g>
    );
}

function TreeNode({ node, selectedId, onSelect, expanded, setExpanded, level = 0 }) {
    const isOpen = expanded.has(node.id);
    const hasChildren = node.children.length > 0;
    const selected = selectedId === node.objectId;
    return (
        <div>
            <div id={node.objectId ? `tree-node-${node.objectId}` : undefined} onClick={() => { if (!node.objectId) return; onSelect(node.objectId); }} style={{ padding: "4px 8px", paddingLeft: 8 + level * 16, background: selected ? "#dbeafe" : "transparent", cursor: "pointer", borderRadius: 6, marginBottom: 2, display: "flex", alignItems: "center", gap: 6 }}>
                <span onClick={(e) => { e.stopPropagation(); if (!hasChildren) return; const next = new Set(expanded); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); setExpanded(next); }} style={{ width: 16, display: "inline-block", textAlign: "center" }}>{hasChildren ? (isOpen ? "▾" : "▸") : "·"}</span>
                <span style={{ fontWeight: selected ? 700 : 400 }}>{node.label}</span>
            </div>
            {isOpen && node.children.map((child) => <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} expanded={expanded} setExpanded={setExpanded} level={level + 1} />)}
        </div>
    );
}

function findAncestors(node, targetId, trail = [], out = []) {
    if (node.objectId === targetId) out.push(...trail.map((t) => t.id));
    node.children.forEach((child) => findAncestors(child, targetId, [...trail, node], out));
    return out;
}

function collectDescendantObjectIds(node, out = new Set()) {
    if (!node) return out;
    if (node.objectId) out.add(node.objectId);
    node.children.forEach((child) => collectDescendantObjectIds(child, out));
    return out;
}

function sampleDiscProfileHint(mode) {
    if (mode === "internal") return "Load one DEXPI XML file that already contains a Core/Diagram.ShapeCatalogue with embedded primitives. In that mode, ShapeUsage references such as #CheckValve_444437D160 are resolved internally from the uploaded file.";
    return "Load a main DEXPI XML file and, if needed, a separate DiscProfile.xml file. External symbol references are resolved from DiscProfile; embedded Core/Diagram.ShapeCatalogue shapes are also supported automatically.";
}

export default function App() {
    const [leftCollapsed, setLeftCollapsed] = useState(false);
    const [rightCollapsed, setRightCollapsed] = useState(false);
    const [mainXmlText, setMainXmlText] = useState("");
    const [discXmlText, setDiscXmlText] = useState("");
    const [loadMode, setLoadMode] = useState("with-profile");
    const [parsed, setParsed] = useState(null);
    const [selectedId, setSelectedId] = useState(null);
    const [search, setSearch] = useState("");
    const [error, setError] = useState("");
    const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1000, h: 1000 });
    const [fullBounds, setFullBounds] = useState({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    const [expanded, setExpanded] = useState(new Set());
    const [isPanning, setIsPanning] = useState(false);
    const [panStart, setPanStart] = useState(null);
    const mainInputRef = useRef(null);
    const discInputRef = useRef(null);
    const svgViewportRef = useRef(null);

    function rebuild(nextMain, nextDisc, mode = loadMode) {
        if (!nextMain) return;
        if (mode === "with-profile" && !nextDisc) return;
        try {
            const nextParsed = parseDexpiPackage(nextMain, mode === "with-profile" ? nextDisc : "");
            const b = boundsFromElements(nextParsed.graphics);
            setFullBounds(b);
            setParsed(nextParsed);
            setSelectedId(nextParsed.tree.objectId);
            setExpanded(new Set([nextParsed.tree.id, ...nextParsed.tree.children.slice(0, 5).map((c) => c.id)]));
            setViewBox({ x: b.minX, y: b.minY, w: Math.max(100, b.maxX - b.minX), h: Math.max(100, b.maxY - b.minY) });
            setError("");
        } catch (e) {
            setError(e.message || String(e));
        }
    }

    async function handleMainFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        const txt = await file.text();
        setMainXmlText(txt);
        rebuild(txt, discXmlText, loadMode);
    }

    async function handleDiscFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        const txt = await file.text();
        setDiscXmlText(txt);
        rebuild(mainXmlText, txt, "with-profile");
    }

    const filteredTree = useMemo(() => {
        if (!parsed) return null;
        const q = search.trim().toLowerCase();
        if (!q) return parsed.tree;
        const filter = (node) => {
            const match = [node.label, node.objectId, node.type].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
            const children = node.children.map(filter).filter(Boolean);
            return match || children.length ? { ...node, children } : null;
        };
        return filter(parsed.tree);
    }, [parsed, search]);

    const selectedNode = useMemo(() => parsed?.treeMap?.get(selectedId) || null, [parsed, selectedId]);
    const selectedRepresentedIds = useMemo(() => selectedNode ? collectDescendantObjectIds(selectedNode) : new Set(), [selectedNode]);

    const appStyle = leftCollapsed && rightCollapsed ? styles.appBothCollapsed : leftCollapsed ? styles.appLeftCollapsed : rightCollapsed ? styles.appRightCollapsed : styles.app;

    useEffect(() => {
        if (!selectedId) return;
        const handle = window.requestAnimationFrame(() => {
            const el = document.getElementById(`tree-node-${selectedId}`);
            if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
        return () => window.cancelAnimationFrame(handle);
    }, [selectedId, expanded, leftCollapsed, rightCollapsed]);

    return (
        <div style={appStyle}>
            {leftCollapsed ? (
                <div style={styles.collapsedPanel}><button style={styles.collapseButton} title="Expand hierarchy panel" onClick={() => setLeftCollapsed(false)}>⟩</button></div>
            ) : (
                <div style={styles.panel}>
                    <div style={styles.toolbar}>
                        <div style={styles.toolbarRow}>
                            <div><div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>DEXPI → SVG Viewer</div></div>
                            <button style={styles.button} title="Collapse hierarchy panel" onClick={() => setLeftCollapsed(true)}>⟨</button>
                        </div>
                        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                            <div style={{ display: "flex", gap: 8 }}>
                                <button style={{ ...styles.button, background: loadMode === "with-profile" ? "#eaf2ff" : "white" }} onClick={() => setLoadMode("with-profile")}>Load with profile</button>
                                <button style={{ ...styles.button, background: loadMode === "internal" ? "#eaf2ff" : "white" }} onClick={() => { setLoadMode("internal"); setDiscXmlText(""); if (mainXmlText) rebuild(mainXmlText, "", "internal"); }}>Load without profile</button>
                            </div>
                            <button style={styles.button} onClick={() => mainInputRef.current?.click()}>Load main DEXPI XML</button>
                            <input ref={mainInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleMainFile} />
                            {loadMode === "with-profile" && <><button style={styles.button} onClick={() => discInputRef.current?.click()}>Load DiscProfile.xml</button><input ref={discInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleDiscFile} /></>}
                            <input style={styles.input} placeholder="Search hierarchy" value={search} onChange={(e) => setSearch(e.target.value)} />
                        </div>
                    </div>
                    <div style={styles.section}><div style={{ fontWeight: 700, marginBottom: 6 }}>Files needed</div><pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>{sampleDiscProfileHint(loadMode)}</pre></div>
                    {parsed && <div style={styles.section}><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><span style={styles.badge}>{parsed.flatTree.length} model objects</span><span style={styles.badge}>{parsed.graphics.elements.length} graphic elements</span><span style={styles.badge}>{parsed.symbolMap.size} symbols</span></div></div>}
                    <div style={{ padding: 12 }}>
                        {filteredTree ? <TreeNode node={filteredTree} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setSearch(""); const ancestors = parsed ? findAncestors(parsed.tree, id) : []; setExpanded((prev) => new Set([...prev, ...ancestors])); }} expanded={expanded} setExpanded={setExpanded} /> : <div style={{ color: "#57606a" }}>{error || "Load the XML files to begin."}</div>}
                    </div>
                </div>
            )}

            <div style={styles.center}>
                <div style={styles.toolbar}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                        <div>
                            <div style={{ fontWeight: 700 }}>{parsed?.meta?.drawingNumber || "No drawing loaded"}</div>
                            <div style={{ fontSize: 12, color: "#57606a" }}>{parsed?.meta?.drawingName || ""} {parsed?.meta?.subtitle ? `— ${parsed.meta.subtitle}` : ""}</div>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button style={styles.button} onClick={() => parsed && (() => { const b = boundsFromElements(parsed.graphics); setFullBounds(b); setViewBox({ x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY }); })()}>Fit</button>
                            <button style={styles.button} onClick={() => setViewBox((v) => clampViewBox({ x: v.x + v.w * 0.1, y: v.y + v.h * 0.1, w: v.w * 0.8, h: v.h * 0.8 }, fullBounds))}>Zoom in</button>
                            <button style={styles.button} onClick={() => setViewBox((v) => {
                                const totalW = Math.max(100, fullBounds.maxX - fullBounds.minX);
                                const totalH = Math.max(100, fullBounds.maxY - fullBounds.minY);
                                const nextW = Math.max(v.w * 1.25, totalW);
                                const nextH = Math.max(v.h * 1.25, totalH);
                                return {
                                    x: fullBounds.minX,
                                    y: fullBounds.minY,
                                    w: nextW,
                                    h: nextH,
                                };
                            })}>Zoom out</button>
                            <button style={styles.button} onClick={() => setViewBox((v) => ({ ...v, x: v.x - Math.max(20, v.w * 0.12) }))}>←</button>
                            <button style={styles.button} onClick={() => setViewBox((v) => ({ ...v, x: v.x + Math.max(20, v.w * 0.12) }))}>→</button>
                            <button style={styles.button} onClick={() => setViewBox((v) => ({ ...v, y: v.y - Math.max(20, v.h * 0.12) }))}>↑</button>
                            <button style={styles.button} onClick={() => setViewBox((v) => ({ ...v, y: v.y + Math.max(20, v.h * 0.12) }))}>↓</button>
                        </div>
                    </div>
                </div>
                {error && <div style={{ color: "#b42318", padding: 12 }}>{error}</div>}
                <div
                    ref={svgViewportRef}
                    style={{ width: "100%", height: "calc(100% - 68px)", background: "white", cursor: isPanning ? "grabbing" : "default" }}
                    onMouseDown={(e) => {
                        if (e.button !== 1) return;
                        e.preventDefault();
                        setIsPanning(true);
                        setPanStart({ x: e.clientX, y: e.clientY, view: viewBox });
                    }}
                    onMouseMove={(e) => {
                        if (!isPanning || !panStart || !svgViewportRef.current) return;
                        const rect = svgViewportRef.current.getBoundingClientRect();
                        const dxPx = e.clientX - panStart.x;
                        const dyPx = e.clientY - panStart.y;
                        const dx = (dxPx / rect.width) * panStart.view.w;
                        const dy = (dyPx / rect.height) * panStart.view.h;
                        setViewBox(clampViewBox({ ...panStart.view, x: panStart.view.x - dx, y: panStart.view.y - dy }, fullBounds));
                    }}
                    onMouseUp={() => { setIsPanning(false); setPanStart(null); }}
                    onMouseLeave={() => { setIsPanning(false); setPanStart(null); }}
                    onWheel={(e) => {
                        e.preventDefault();
                    }}
                >
                    <svg viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`} width="100%" height="100%" style={{ background: "white", display: "block" }} onAuxClick={(e) => e.preventDefault()}>
                        {parsed?.graphics.elements.map((el) => {
                            const isSelected = !!el.representedId && selectedRepresentedIds.has(el.representedId);
                            if (el.kind === "symbolUsage") {
                                return <SymbolGraphic key={el.key} el={el} selected={isSelected} onSelect={(id) => { if (!id) return; setSelectedId(id); setSearch(""); const ancestors = parsed ? findAncestors(parsed.tree, id) : []; setExpanded((prev) => new Set([...prev, ...ancestors])); }} />;
                            }
                            return <PrimitiveGraphic key={el.key} el={el} selected={isSelected} onSelect={(id) => { if (!id) return; setSelectedId(id); setSearch(""); const ancestors = parsed ? findAncestors(parsed.tree, id) : []; setExpanded((prev) => new Set([...prev, ...ancestors])); }} nodePosMap={parsed.graphics.nodePosMap} />;
                        })}
                    </svg>
                </div>
            </div>

            {rightCollapsed ? (
                <div style={styles.collapsedRightPanel}><button style={styles.collapseButton} title="Expand details panel" onClick={() => setRightCollapsed(false)}>⟨</button></div>
            ) : (
                <div style={styles.rightPanel}>
                    <div style={styles.toolbar}>
                        <div style={styles.toolbarRow}>
                            <div><div style={{ fontWeight: 700 }}>Selection details</div><div style={{ fontSize: 12, color: "#57606a" }}>Click hierarchy or graphic to sync selection.</div></div>
                            <button style={styles.button} title="Collapse details panel" onClick={() => setRightCollapsed(true)}>⟩</button>
                        </div>
                    </div>
                    <div style={styles.section}>
                        <div><strong>Selected object:</strong> {selectedNode?.label || "—"}</div>
                        <div style={{ fontSize: 12, color: "#57606a", marginTop: 4 }}>{selectedNode?.type || ""}</div>
                        <div style={{ marginTop: 8, fontSize: 12 }}>{selectedNode?.objectId || ""}</div>
                        <div style={{ marginTop: 10 }}>
                            <div style={{ fontWeight: 700, marginBottom: 6 }}>Persistent identifier(s)</div>
                            {selectedNode?.persistentIdentifiers?.length ? selectedNode.persistentIdentifiers.map((pid, i) => <div key={`${pid.context}_${pid.value}_${i}`} style={{ fontSize: 13, marginBottom: 8 }}><div style={{ color: "#57606a", fontSize: 12 }}>{pid.context || "No context"}</div><div style={{ wordBreak: "break-all" }}>{pid.value || ""}</div></div>) : <div style={{ color: "#57606a", fontSize: 13 }}>No persistent identifiers found.</div>}
                        </div>
                    </div>
                    <div style={styles.section}>
                        <div style={{ fontWeight: 700, marginBottom: 8 }}>Data</div>
                        {selectedNode?.data?.length ? selectedNode.data.map((d) => <div key={d.property} style={{ marginBottom: 8 }}><div style={{ fontSize: 12, color: "#57606a" }}>{d.property}</div><div style={{ fontSize: 13 }}>{typeof d.value === "object" ? JSON.stringify(d.value) : String(d.value)}</div></div>) : <div style={{ color: "#57606a" }}>No direct data.</div>}
                    </div>
                    <div style={styles.section}>
                        <div style={{ fontWeight: 700, marginBottom: 8 }}>References</div>
                        {selectedNode?.refs?.length ? selectedNode.refs.map((r, i) => <div key={`${r.property}_${i}`} style={{ marginBottom: 8 }}><div style={{ fontSize: 12, color: "#57606a" }}>{r.property}</div><div style={{ fontSize: 13 }}>{r.objects.join(", ")}</div></div>) : <div style={{ color: "#57606a" }}>No direct references.</div>}
                    </div>
                </div>
            )}
        </div>
    );
}
