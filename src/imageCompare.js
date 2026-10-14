// ---------------------------------------------------------------------------
// PNG <-> DEXPI image compare + auto-fit engine.
//
// Pure functions, no DOM, so the same code runs in the browser worker
// (imageCompare.worker.js) and in Node (tests / a future CLI).
//
// Coordinate systems
//   world  - DEXPI drawing units (mm), exactly as drawn by App.jsx's <svg>
//            (y already points down there, same as the PNG).
//   image  - PNG pixels.
//   grid   - the PNG reduced by an integer factor `f` (max-pooled, so thin
//            lines survive), which is what all the matching runs on.
//   A placement {x, y, width, height} (world units) is the rectangle the PNG
//   is stretched into - the same thing App.jsx calls bgPlacement.
// ---------------------------------------------------------------------------

// Kept in step with App.jsx's HT_* constants (heat-trace overlay geometry).
const HT_OFF = 1.5;
const HT_PIF_OFF = 1.0;
const HT_THRESH = 0.15;
// Kept in step with App.jsx's SIGNAL_CONVEYING_MARKS / SIGNAL_MARK_* constants.
const SIGNAL_MARK_TYPES = new Set([
    "ElectricalSignalConveying", "HydraulicSignalConveying", "BusSignalConveying",
    "PneumaticSignalConveying", "CapillarySignalConveying", "UndefinedSignalConveying",
    "ElectromagneticGuidedSignalConveying", "ElectromagneticUnguidedSignalConveying",
]);
const SIGNAL_MARK_HIDE_LINE_TYPES = new Set(["ElectromagneticUnguidedSignalConveying"]);
const SIGNAL_MARK_SPACING = 14;
const SIGNAL_MARK_HALF_H = 1.2;
const SIGNAL_MARK_W = 1.6;

const STEP = 0.25;      // stroke sampling step, world units
const FILL_STEP = 0.5;  // interior sampling step for solid fills

export const IMG_CODES = {
    "IMG-001": { title: "Missing in DEXPI", severity: "Error", color: "#cf222e" },
    "IMG-002": { title: "Not found in image", severity: "Error", color: "#0969da" },
    "IMG-003": { title: "Partial match", severity: "Warning", color: "#9a6700" },
    "IMG-004": { title: "Misplaced", severity: "Warning", color: "#bc4c00" },
    "IMG-005": { title: "Wrong orientation", severity: "Warning", color: "#8250df" },
    "IMG-006": { title: "Wrong symbol option", severity: "Error", color: "#bf3989" },
    "IMG-007": { title: "Line style mismatch", severity: "Warning", color: "#1a7f37" },
    "IMG-008": { title: "Signal marks not found in image", severity: "Warning", color: "#1a7f37" },
    "IMG-009": { title: "Heat tracing not found in image", severity: "Warning", color: "#e06000" },
    "IMG-010": { title: "Heat tracing in image, not in DEXPI", severity: "Warning", color: "#e06000" },
    "IMG-011": { title: "Image shows signal marks, DEXPI has none", severity: "Info", color: "#1a7f37" },
};

export const DEFAULT_COMPARE_OPTIONS = {
    tolMm: 0.6,          // how far image ink may be from DEXPI ink and still count as matching
    searchMm: 5,         // misplaced-search radius
    okScore: 0.8,        // fraction of an object's samples that must match
    partialScore: 0.3,   // below this an object is "not found"
    minRegionMm: 4,      // smallest unexplained image region reported
    textHeightMm: 2.5,   // image components this tall-ish are treated as text and ignored
    gapBridgeMm: 4,      // dash gaps up to this length still count as "line present"
    marginMm: 10,        // image ink further than this outside the DEXPI content is ignored
};

// ---------- geometry sampling ------------------------------------------------

function pushSeg(out, x1, y1, x2, y2, step, includeEnd) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i < n; i++) out.push(x1 + dx * i / n, y1 + dy * i / n);
    if (includeEnd) out.push(x2, y2);
}

function samplePolyline(out, pts, closed, step = STEP) {
    if (!pts || pts.length === 0) return;
    if (pts.length === 1) { out.push(pts[0].x, pts[0].y); return; }
    for (let i = 0; i < pts.length - 1; i++) pushSeg(out, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, step, false);
    if (closed) pushSeg(out, pts[pts.length - 1].x, pts[pts.length - 1].y, pts[0].x, pts[0].y, step, false);
    else out.push(pts[pts.length - 1].x, pts[pts.length - 1].y);
}

// Same parametrisation as App.jsx's ellipseArcToPath().
function ellipsePoint(cx, cy, rx, ry, rotDeg, deg) {
    const a = deg * Math.PI / 180, phi = (rotDeg || 0) * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a), cp = Math.cos(phi), sp = Math.sin(phi);
    return { x: cx + rx * cp * ca - ry * sp * sa, y: cy + rx * sp * ca + ry * cp * sa };
}

function sampleEllipse(out, cx, cy, rx, ry, rotDeg, startDeg = 0, spanDeg = 360, step = STEP) {
    const circ = 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2) * (spanDeg / 360);
    const n = Math.max(8, Math.ceil(circ / step));
    for (let i = 0; i <= n; i++) {
        const p = ellipsePoint(cx, cy, rx, ry, rotDeg, startDeg + spanDeg * i / n);
        out.push(p.x, p.y);
    }
}

function rectCorners(c, w, h, rotDeg) {
    const r = (rotDeg || 0) * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
        .map(([x, y]) => ({ x: c.x + x * cs - y * sn, y: c.y + x * sn + y * cs }));
}

function isSolidFill(f) { return !!f && f.style && f.style !== "Transparent" && !!f.color; }

function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
}

function fillPolygon(out, pts) {
    if (!pts || pts.length < 3) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
    for (let y = minY + FILL_STEP / 2; y < maxY; y += FILL_STEP)
        for (let x = minX + FILL_STEP / 2; x < maxX; x += FILL_STEP)
            if (pointInPolygon(x, y, pts)) out.push(x, y);
}

function fillEllipse(out, cx, cy, rx, ry, rotDeg) {
    const phi = (rotDeg || 0) * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    const R = Math.max(rx, ry);
    for (let y = -R; y <= R; y += FILL_STEP)
        for (let x = -R; x <= R; x += FILL_STEP) {
            // local (unrotated) coordinates
            const lx = x * cp + y * sp, ly = -x * sp + y * cp;
            if ((lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 0.8) out.push(cx + x, cy + y);
        }
}

// Samples one Core/Diagram primitive (as parsed by dexpiParser.js) in its own
// coordinate system. Text primitives are collected separately (text is never
// matched - fonts differ between tools - but its extent is masked out).
function samplePrimitive(p, stroke, fill, texts) {
    if (!p) return;
    switch (p.kind) {
        case "polyline": samplePolyline(stroke, p.points, false); break;
        case "polygon":
            samplePolyline(stroke, p.points, true);
            if (isSolidFill(p.fill)) fillPolygon(fill, p.points);
            break;
        case "circle":
            sampleEllipse(stroke, p.center.x, p.center.y, p.radius, p.radius, 0);
            if (isSolidFill(p.fill)) fillEllipse(fill, p.center.x, p.center.y, p.radius, p.radius, 0);
            break;
        case "ellipse":
            sampleEllipse(stroke, p.center.x, p.center.y, p.rx, p.ry, p.rotation);
            if (isSolidFill(p.fill)) fillEllipse(fill, p.center.x, p.center.y, p.rx, p.ry, p.rotation);
            break;
        case "rect": {
            const c = rectCorners(p.center, p.width, p.height, p.rotation);
            samplePolyline(stroke, c, true);
            if (isSolidFill(p.fill)) fillPolygon(fill, c);
            break;
        }
        case "ellipseArc": {
            let span = p.endAngle - p.startAngle;
            if (span <= 0) span += 360;
            sampleEllipse(stroke, p.center.x, p.center.y, p.rx, p.ry, p.rotation, p.startAngle, span);
            break;
        }
        case "text": if (texts) texts.push(p); break;
        default: break;
    }
}

// Placement transform of a symbolUsage - same as SymbolGraphic's SVG
// transform: translate(pos) rotate(rot) scale(sx * mirror, sy).
function symbolXf(el, extraRot = 0, toggleMirror = false) {
    const mirror = (!!el.isMirrored !== !!toggleMirror) ? -1 : 1;
    const r = ((el.rotation || 0) + extraRot) * Math.PI / 180;
    return { px: el.position.x, py: el.position.y, c: Math.cos(r), s: Math.sin(r), sx: (el.scaleX || 1) * mirror, sy: el.scaleY || 1, rotDeg: (el.rotation || 0) + extraRot };
}

function applyXf(xf, local) {
    const out = new Float32Array(local.length);
    for (let i = 0; i < local.length; i += 2) {
        const sx = local[i] * xf.sx, sy = local[i + 1] * xf.sy;
        out[i] = xf.px + sx * xf.c - sy * xf.s;
        out[i + 1] = xf.py + sx * xf.s + sy * xf.c;
    }
    return out;
}

function bboxOf(arr) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < arr.length; i += 2) {
        const x = arr[i], y = arr[i + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

function unionBox(a, b) {
    if (!a) return b; if (!b) return a;
    return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

// Axis-aligned box around a text, honouring its alignment. The rotation
// sense is ambiguous between tools, so both senses are unioned (for 0/180 deg
// they coincide; for 90 deg this widens along the text, not across it).
function textBox(x, y, value, size, rotDeg, style) {
    const lines = String(value || "").split(/\r?\n/);
    const len = lines.reduce((m, l) => Math.max(m, l.trim().length), 0);
    if (!len) return null;
    const sz = size || 2.5;
    const W = len * sz * 0.62, H = lines.length * sz * 1.15;
    const hz = String(style?.horizontal || "").toLowerCase(), vt = String(style?.vertical || "").toLowerCase();
    const lx0 = hz.includes("left") ? 0 : hz.includes("right") ? -W : -W / 2;
    const ly0 = vt.includes("top") ? 0 : vt.includes("bottom") ? -H : -H / 2;
    const pad = 0.3;
    const corners = [[lx0 - pad, ly0 - pad], [lx0 + W + pad, ly0 - pad], [lx0 + W + pad, ly0 + H + pad], [lx0 - pad, ly0 + H + pad]];
    let box = null;
    for (const sign of [1, -1]) {
        const r = sign * (rotDeg || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
        const pts = [];
        corners.forEach(([u, v]) => pts.push(x + u * c - v * s, y + u * s + v * c));
        box = unionBox(box, bboxOf(pts));
    }
    return box;
}

function markPositions(pts, spacing, startOffset) {
    const marks = [];
    let next = startOffset, acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i], p2 = pts[i + 1];
        const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy);
        if (len < 0.001) continue;
        let a = Math.atan2(dy, dx) * 180 / Math.PI;
        if (a > 90) a -= 180; else if (a <= -90) a += 180;
        while (next <= acc + len) {
            const t = (next - acc) / len;
            marks.push({ x: p1.x + dx * t, y: p1.y + dy * t, angleDeg: a });
            next += spacing;
        }
        acc += len;
    }
    return marks;
}

// Rough stroke samples for one signal mark glyph (for the DEXPI ink mask only).
function markGlyphSamples(out, m) {
    const r = m.angleDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const put = (u, v) => out.push(m.x + u * c - v * s, m.y + u * s + v * c);
    for (let v = -SIGNAL_MARK_HALF_H; v <= SIGNAL_MARK_HALF_H; v += STEP) { put(0, v); put(SIGNAL_MARK_W, v); }
    for (let u = 0; u <= SIGNAL_MARK_W; u += STEP) { put(u, -SIGNAL_MARK_HALF_H); put(u, SIGNAL_MARK_HALF_H); }
}

// Returns samples of the viewer's pipe heat-trace line plus, per sample, the
// unit normal pointing away from the pipe (nrm: [nx, ny, ...]).
function heatTraceLineSegments(pts) {
    const out = [], nrm = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i], p2 = pts[i + 1];
        const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy);
        if (len < 0.001) continue;
        const before = out.length;
        let nx = 0, ny = 0;
        if (Math.abs(dy / len) < HT_THRESH) { pushSeg(out, p1.x, p1.y + HT_OFF, p2.x, p2.y + HT_OFF, STEP, true); ny = 1; }
        else if (Math.abs(dx / len) < HT_THRESH) { pushSeg(out, p1.x + HT_OFF, p1.y, p2.x + HT_OFF, p2.y, STEP, true); nx = 1; }
        for (let k = before; k < out.length; k += 2) nrm.push(nx, ny);
    }
    return { pts: out, nrm };
}

function symbolWorldBox(el, variant) {
    const xf = symbolXf(el);
    const c = [variant.minX, variant.minY, variant.maxX, variant.minY, variant.maxX, variant.maxY, variant.minX, variant.maxY];
    return bboxOf(applyXf(xf, c));
}

function heatTraceSymbolSamples(el) {
    const n = ((el.rotation || 0) % 360 + 360) % 360;
    const vertical = (n > 75 && n < 105) || (n > 255 && n < 285);
    const bb = symbolWorldBox(el, el.variant);
    const out = [];
    if (!bb) return out;
    if (vertical) pushSeg(out, bb.maxX + HT_OFF, bb.minY, bb.maxX + HT_OFF, bb.maxY, STEP, true);
    else pushSeg(out, bb.minX, bb.maxY + HT_OFF, bb.maxX, bb.maxY + HT_OFF, STEP, true);
    return out;
}

function heatTracePifSamples(el) {
    const local = [];
    (el.variant.primitives || []).forEach(p => {
        if (p.kind === "circle") sampleEllipse(local, p.center.x, p.center.y, p.radius + HT_PIF_OFF, p.radius + HT_PIF_OFF, 0);
        else if (p.kind === "ellipse") sampleEllipse(local, p.center.x, p.center.y, p.rx + HT_PIF_OFF, p.ry + HT_PIF_OFF, p.rotation);
    });
    if (local.length === 0) {
        const v = el.variant;
        const c = [{ x: v.minX - HT_PIF_OFF, y: v.minY - HT_PIF_OFF }, { x: v.maxX + HT_PIF_OFF, y: v.minY - HT_PIF_OFF },
            { x: v.maxX + HT_PIF_OFF, y: v.maxY + HT_PIF_OFF }, { x: v.minX - HT_PIF_OFF, y: v.maxY + HT_PIF_OFF }];
        samplePolyline(local, c, true);
    }
    return Array.from(applyXf(symbolXf(el), local));
}

const ALT_ORIENTATIONS = [
    { rot: 90, mirror: false, label: "rotated +90°" },
    { rot: 180, mirror: false, label: "rotated 180°" },
    { rot: 270, mirror: false, label: "rotated +270°" },
    { rot: 0, mirror: true, label: "mirrored" },
    { rot: 90, mirror: true, label: "mirrored, rotated +90°" },
    { rot: 180, mirror: true, label: "mirrored, rotated 180°" },
    { rot: 270, mirror: true, label: "mirrored, rotated +270°" },
];

function conditionText(c) {
    if (!c) return "default";
    const attr = String(c.attributeName || "").split(".").pop();
    const val = String(c.literalValue || "").split(".").pop();
    return attr ? `${attr} = ${val}` : val;
}

/**
 * Extracts everything the matcher needs from a parsed DEXPI package
 * (dexpiParser.js parseDexpiPackage() result) as plain, transferable data.
 */
export function buildCompareGeometry(parsed) {
    const elements = parsed?.graphics?.elements || [];
    const nodePosMap = parsed?.graphics?.nodePosMap || new Map();
    const htSet = parsed?.heatTraceSet || new Map();
    const treeMap = parsed?.treeMap || new Map();
    const localCache = new Map();
    const items = [];
    const textBoxes = [];

    const localOf = (variant) => {
        if (localCache.has(variant)) return localCache.get(variant);
        const stroke = [], fill = [], texts = [];
        (variant.primitives || []).forEach(p => samplePrimitive(p, stroke, fill, texts));
        const v = { stroke: Float32Array.from(stroke), fill: Float32Array.from(fill), texts };
        localCache.set(variant, v);
        return v;
    };
    const nodeInfo = (id) => {
        const n = id ? treeMap.get(id) : null;
        if (!n) return { label: id || "", type: "" };
        const dv = (prop) => {
            const d = (n.data || []).find(x => x.property === prop);
            const v = d?.value;
            return typeof v === "string" ? v : "";
        };
        const shortType = String(n.type || "").split(/[./]/).pop();
        const tag = n.tagName || dv("ItemTag") || dv("ObjectDisplayName") || dv("TagName") || dv("SegmentNumber") || dv("PipingComponentName") || dv("Name");
        return { label: tag ? `${tag} (${shortType})` : `${shortType} ${String(id).slice(-6)}`, type: n.type || "" };
    };

    elements.forEach(el => {
        const info = nodeInfo(el.representedId);
        if (el.kind === "symbolUsage") {
            if (!el.variant) return;
            const loc = localOf(el.variant);
            const xf = symbolXf(el);
            const pts = applyXf(xf, loc.stroke);
            const fill = applyXf(xf, loc.fill);
            loc.texts.forEach(t => {
                const w = applyXf(xf, [t.position.x, t.position.y]);
                const b = textBox(w[0], w[1], t.value, t.style?.size, xf.rotDeg + (t.rotation || 0), t.style);
                if (b) textBoxes.push(b);
            });
            if (pts.length < 4) return;
            const item = {
                key: el.key, representedId: el.representedId || null, kind: "symbol", role: el.elementRole,
                label: info.label, type: info.type, symbolName: el.symbol?.name || "", variantName: el.variant.name || "",
                pts, fill, bbox: bboxOf(pts), center: { x: el.position.x, y: el.position.y },
                alternates: [], variants: [], ht: null,
            };
            if (el.elementRole !== "label") {
                item.alternates = ALT_ORIENTATIONS.map(o => {
                    const axf = symbolXf(el, o.rot, o.mirror);
                    return { label: o.label, pts: applyXf(axf, loc.stroke), fill: applyXf(axf, loc.fill) };
                });
                const vs = el.symbol?.variants || [];
                if (vs.length > 1 && vs.some(v => v.condition)) {
                    item.variants = vs.map(v => {
                        const l = localOf(v);
                        return {
                            name: v.name, condition: conditionText(v.condition), isCurrent: v === el.variant,
                            pts: applyXf(xf, l.stroke), fill: applyXf(xf, l.fill),
                        };
                    });
                }
                const htType = el.representedId ? htSet.get(el.representedId) : null;
                if (htType === "inline" || htType === "nozzle") item.ht = { expected: true, pts: Float32Array.from(heatTraceSymbolSamples(el)) };
                else if (htType === "pif") item.ht = { expected: true, pts: Float32Array.from(heatTracePifSamples(el)) };
                else if (el.representedId) item.ht = { expected: false, pts: Float32Array.from(heatTraceSymbolSamples(el)) };
            }
            items.push(item);
        } else if (el.kind === "connectorLine") {
            const prim = el.primitive;
            const src = prim.sourceRef ? nodePosMap.get(prim.sourceRef) : null;
            const tgt = prim.targetRef ? nodePosMap.get(prim.targetRef) : null;
            const linePts = [src, ...(prim.innerPoints || []), tgt].filter(Boolean);
            if (linePts.length < 2) return;
            const path = [];
            samplePolyline(path, linePts, false);
            let lengthMm = 0;
            for (let i = 0; i < linePts.length - 1; i++) lengthMm += Math.hypot(linePts[i + 1].x - linePts[i].x, linePts[i + 1].y - linePts[i].y);
            const signalType = el.signalConveyingType || null;
            const hideLine = SIGNAL_MARK_HIDE_LINE_TYPES.has(signalType);
            const marks = SIGNAL_MARK_TYPES.has(signalType) ? markPositions(linePts, SIGNAL_MARK_SPACING, SIGNAL_MARK_SPACING / 2) : [];
            const markInk = [];
            marks.forEach(m => markGlyphSamples(markInk, m));
            const rawStyle = prim.stroke?.dashStyle || "Solid";
            const dashStyle = (rawStyle === "Solid" && prim.stroke?.dashArray) ? "Dash" : rawStyle;
            const pathArr = Float32Array.from(path);
            const item = {
                key: el.key, representedId: el.representedId || null, kind: "line", role: el.elementRole,
                label: info.label, type: info.type,
                pts: hideLine ? Float32Array.from(markInk) : pathArr, path: hideLine ? null : pathArr, fill: new Float32Array(0),
                bbox: bboxOf(pathArr), lengthMm, dashStyle, expectedDashed: dashStyle !== "Solid",
                signalType, marks, markInk: Float32Array.from(markInk), linePts, ht: null,
            };
            const htType = el.representedId ? htSet.get(el.representedId) : null;
            if (htType === "piping" || (!signalType && /pip/i.test(info.type) && lengthMm >= 10)) {
                const h = heatTraceLineSegments(linePts);
                item.ht = { expected: htType === "piping", pts: Float32Array.from(h.pts), nrm: Int8Array.from(h.nrm) };
            }
            if (item.ht && item.ht.pts.length === 0) item.ht = null;
            items.push(item);
        } else if (el.kind === "primitive") {
            const p = el.primitive;
            if (!p) return;
            if (p.kind === "text") {
                const b = textBox(p.position.x, p.position.y, p.value, p.style?.size, p.rotation, p.style);
                if (b) textBoxes.push(b);
                return;
            }
            const stroke = [], fill = [];
            samplePrimitive(p, stroke, fill, null);
            if (stroke.length < 4) return;
            const pts = Float32Array.from(stroke);
            items.push({
                key: el.key, representedId: el.representedId || null, kind: "graphic", role: el.elementRole,
                label: info.label, type: info.type, pts, fill: Float32Array.from(fill), bbox: bboxOf(pts), ht: null,
            });
        }
    });

    let contentBox = null;
    items.forEach(it => { contentBox = unionBox(contentBox, it.bbox); });
    return { items, textBoxes, contentBox };
}

/** The same "contain, centered" fit App.jsx uses for a BG image at scale 1 / offset 0. */
export function computeBgPlacement(fullBounds, natW, natH, { scale = 1, offsetX = 0, offsetY = 0 } = {}) {
    const boundsW = Math.max(1, fullBounds.maxX - fullBounds.minX);
    const boundsH = Math.max(1, fullBounds.maxY - fullBounds.minY);
    let baseW = boundsW, baseH = boundsH, baseX = fullBounds.minX, baseY = fullBounds.minY;
    if (natW && natH) {
        const imgAspect = natW / natH;
        if (imgAspect > boundsW / boundsH) { baseW = boundsW; baseH = boundsW / imgAspect; }
        else { baseH = boundsH; baseW = boundsH * imgAspect; }
        baseX = fullBounds.minX + (boundsW - baseW) / 2;
        baseY = fullBounds.minY + (boundsH - baseH) / 2;
    }
    return { base: { x: baseX, y: baseY, width: baseW, height: baseH }, x: baseX + offsetX, y: baseY + offsetY, width: baseW * scale, height: baseH * scale };
}

/** Inverse of computeBgPlacement: placement rectangle -> {scale, offsetX, offsetY}. */
export function placementToBgParams(fullBounds, natW, natH, placement) {
    const { base } = computeBgPlacement(fullBounds, natW, natH);
    return { scale: placement.width / base.width, offsetX: placement.x - base.x, offsetY: placement.y - base.y };
}

// ---------- raster helpers ---------------------------------------------------

/** Grid reduction factor so the matching grid stays around <= 3600 px. */
export function gridFactor(W, H, maxDim = 3600) {
    return Math.max(1, Math.ceil(Math.max(W, H) / maxDim));
}

/**
 * Marks ink cells of a gw x gh grid from a strip of RGBA image rows.
 * Anything clearly darker than paper, or clearly coloured, is ink.
 */
export function accumulateInk(rgba, W, rows, y0, f, grid, gw) {
    for (let y = 0; y < rows; y++) {
        const rowBase = (((y0 + y) / f) | 0) * gw;
        let i = y * W * 4;
        for (let x = 0; x < W; x++, i += 4) {
            if (rgba[i + 3] < 128) continue;
            const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
            const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
            const lum = (299 * r + 587 * g + 114 * b) / 1000;
            if (lum < 160 || (mx - mn > 90 && lum < 235)) grid[rowBase + ((x / f) | 0)] = 1;
        }
    }
}

export function maxPool(grid, w, h, k) {
    const nw = Math.ceil(w / k), nh = Math.ceil(h / k);
    const out = new Uint8Array(nw * nh);
    for (let y = 0; y < h; y++) {
        const ob = ((y / k) | 0) * nw, ib = y * w;
        for (let x = 0; x < w; x++) if (grid[ib + x]) out[ob + ((x / k) | 0)] = 1;
    }
    return { grid: out, w: nw, h: nh };
}

/** 3-4 chamfer distance transform. Result is in 1/3 grid px. */
export function distanceTransform(ink, w, h) {
    const CAP = 60000;
    const d = new Uint16Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = ink[i] ? 0 : CAP;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            let v = d[i];
            if (v === 0) continue;
            if (x > 0 && d[i - 1] + 3 < v) v = d[i - 1] + 3;
            if (y > 0) {
                const j = i - w;
                if (d[j] + 3 < v) v = d[j] + 3;
                if (x > 0 && d[j - 1] + 4 < v) v = d[j - 1] + 4;
                if (x < w - 1 && d[j + 1] + 4 < v) v = d[j + 1] + 4;
            }
            d[i] = v;
        }
    }
    for (let y = h - 1; y >= 0; y--) {
        for (let x = w - 1; x >= 0; x--) {
            const i = y * w + x;
            let v = d[i];
            if (v === 0) continue;
            if (x < w - 1 && d[i + 1] + 3 < v) v = d[i + 1] + 3;
            if (y < h - 1) {
                const j = i + w;
                if (d[j] + 3 < v) v = d[j] + 3;
                if (x < w - 1 && d[j + 1] + 4 < v) v = d[j + 1] + 4;
                if (x > 0 && d[j - 1] + 4 < v) v = d[j - 1] + 4;
            }
            d[i] = v;
        }
    }
    return d;
}

function thresholdDT(dt, maxPx) {
    const lim = Math.round(maxPx * 3);
    const out = new Uint8Array(dt.length);
    for (let i = 0; i < dt.length; i++) out[i] = dt[i] <= lim ? 1 : 0;
    return out;
}

// ---------- auto-fit ---------------------------------------------------------

function subsample(arr, maxPts) {
    const n = arr.length / 2;
    if (n <= maxPts) return arr;
    const stride = n / maxPts;
    const out = new Float32Array(maxPts * 2);
    for (let i = 0; i < maxPts; i++) { const j = Math.floor(i * stride) * 2; out[i * 2] = arr[j]; out[i * 2 + 1] = arr[j + 1]; }
    return out;
}

// Soft chamfer score: 1 on ink, falling linearly to 0 at T px away.
function softScore(xs, ys, n, k, tx, ty, dt, w, h, T3) {
    let s = 0;
    for (let i = 0; i < n; i++) {
        const gx = Math.round(xs[i] * k + tx), gy = Math.round(ys[i] * k + ty);
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        const d = dt[gy * w + gx];
        if (d < T3) s += 1 - d / T3;
    }
    return s / n;
}

/**
 * Finds the similarity transform (uniform scale + translation) that best lays
 * the DEXPI drawing onto the PNG ink. Returns the placement rectangle (world
 * units) plus a 0..1 match score.
 *
 *   ink, gw, gh : fine ink grid of the image (factor f)
 *   W, H        : image size in px
 *   geometry    : buildCompareGeometry() result
 *   initial     : optional current placement, used as an extra seed
 */
export function runAutoFit({ ink, gw, gh, f, W, H, geometry, initial = null, onProgress = null }) {
    const all = [];
    geometry.items.forEach(it => { if (it.role !== "label") all.push(it.pts); });
    let total = 0; all.forEach(a => { total += a.length; });
    const merged = new Float32Array(total);
    let o = 0; all.forEach(a => { merged.set(a, o); o += a.length; });
    const box = bboxOf(merged);
    if (!box) throw new Error("The DEXPI drawing has no graphics to fit.");
    const bw = box.maxX - box.minX, bh = box.maxY - box.minY;

    // Pyramid: fine grid -> medium (~900px) -> coarse (~220px).
    const levels = [];
    let cur = { grid: ink, w: gw, h: gh, scale: 1 };
    levels.push(cur);
    for (const target of [900, 220]) {
        const kf = Math.max(1, Math.round(Math.max(gw, gh) / target));
        if (kf <= 1) { levels.push({ ...levels[levels.length - 1] }); continue; }
        const p = maxPool(ink, gw, gh, kf);
        levels.push({ grid: p.grid, w: p.w, h: p.h, scale: kf });
    }
    levels.forEach(l => { l.dt = distanceTransform(l.grid, l.w, l.h); });
    const [fine, mid, coarse] = levels;

    const prep = (maxPts) => {
        const s = subsample(merged, maxPts);
        const n = s.length / 2, xs = new Float32Array(n), ys = new Float32Array(n);
        for (let i = 0; i < n; i++) { xs[i] = s[i * 2] - box.minX; ys[i] = s[i * 2 + 1] - box.minY; }
        return { xs, ys, n };
    };

    // Model: grid = k * (world - box.min) + t, at the level's own resolution.
    const imgW = W / f, imgH = H / f;      // fine-grid size of the full image
    const kMaxFine = Math.min(imgW / bw, imgH / bh) * 1.08;
    const P1 = prep(1500);
    let best = { score: -1, k: 0, tx: 0, ty: 0 };
    const tryAt = (lvl, P, k, tx, ty, T3) => {
        const s = softScore(P.xs, P.ys, P.n, k, tx, ty, lvl.dt, lvl.w, lvl.h, T3);
        return s;
    };

    // 1) coarse: scan scales and every translation keeping the drawing on the sheet.
    const nScales = 56;
    const cands = [];
    for (let si = 0; si < nScales; si++) {
        const kFine = kMaxFine * Math.pow(0.45, si / (nScales - 1)); // 1.08x .. 0.49x of max
        const k = kFine / coarse.scale;
        const dw = bw * k, dh = bh * k;
        const slackX = Math.max(2, coarse.w * 0.04), slackY = Math.max(2, coarse.h * 0.04);
        let local = { score: -1 };
        for (let ty = -slackY; ty <= coarse.h - dh + slackY; ty += 1) {
            for (let tx = -slackX; tx <= coarse.w - dw + slackX; tx += 1) {
                const s = tryAt(coarse, P1, k, tx, ty, 6);
                if (s > local.score) local = { score: s, kFine, tx: tx * coarse.scale, ty: ty * coarse.scale };
            }
        }
        cands.push(local);
        if (onProgress) onProgress({ phase: "Auto-fit: scanning scales", done: si + 1, total: nScales });
    }
    if (initial) {
        // seed from the current placement as well
        const kFine = (imgW / initial.width);
        cands.push({ score: 0, kFine, tx: (box.minX - initial.x) * kFine, ty: (box.minY - initial.y) * kFine, seed: true });
    }
    cands.sort((a, b) => b.score - a.score);
    const seeds = cands.filter(c => c.seed).concat(cands.filter(c => !c.seed).slice(0, 6));

    // 2) medium + 3) fine refinement around the best seeds.
    const refine = (lvl, P, c, kSpan, kSteps, tSpan, T3) => {
        let b = { score: -1 };
        for (let ki = -kSteps; ki <= kSteps; ki++) {
            const kFine = c.kFine * (1 + kSpan * ki / Math.max(1, kSteps));
            const k = kFine / lvl.scale;
            // translation of the box origin, kept consistent when k changes (scale about the box centre)
            const cx = c.tx + c.kFine * bw / 2 - kFine * bw / 2, cy = c.ty + c.kFine * bh / 2 - kFine * bh / 2;
            for (let dy = -tSpan; dy <= tSpan; dy++) {
                for (let dx = -tSpan; dx <= tSpan; dx++) {
                    const tx = cx / lvl.scale + dx, ty = cy / lvl.scale + dy;
                    const s = tryAt(lvl, P, k, tx, ty, T3);
                    if (s > b.score) b = { score: s, kFine, tx: tx * lvl.scale, ty: ty * lvl.scale };
                }
            }
        }
        return b;
    };
    const P2 = prep(2500), P3 = prep(4000);
    seeds.forEach((sd, i) => {
        let c = refine(mid, P2, sd, 0.03, 8, Math.ceil(coarse.scale / mid.scale) + 2, 9);
        c = refine(mid, P2, c, 0.006, 6, 2, 6);
        if (c.score > best.score) best = c;
        if (onProgress) onProgress({ phase: "Auto-fit: refining", done: i + 1, total: seeds.length });
    });
    let c = refine(fine, P3, best, 0.004, 8, Math.ceil(mid.scale / fine.scale) + 2, 9);
    c = refine(fine, P3, c, 0.0008, 5, 1, 6);
    best = c;

    // Exact score at fine level with hard tolerance, for reporting.
    const near = thresholdDT(fine.dt, 2);
    let hit = 0;
    for (let i = 0; i < P3.n; i++) {
        const gx = Math.round(P3.xs[i] * best.kFine + best.tx), gy = Math.round(P3.ys[i] * best.kFine + best.ty);
        if (gx >= 0 && gy >= 0 && gx < fine.w && gy < fine.h && near[gy * fine.w + gx]) hit++;
    }
    // grid = kFine * (X - box.minX) + tx  ->  image px = f * grid
    // placement: X = x0 + px * width / W  =>  width = W / (f * kFine), x0 = box.minX - tx / kFine
    const width = W / (f * best.kFine), height = H / (f * best.kFine);
    return {
        placement: { x: box.minX - best.tx / best.kFine, y: box.minY - best.ty / best.kFine, width, height },
        score: hit / P3.n,
    };
}

// ---------- compare ----------------------------------------------------------

/**
 * Runs the full compare. Returns { issues, stats, diff } where diff is an
 * RGBA Uint8ClampedArray (gw x gh) of the difference image.
 */
export function runCompare({ ink, gw, gh, f, W, H, placement, geometry, options = {}, onProgress = null }) {
    const opt = { ...DEFAULT_COMPARE_OPTIONS, ...options };
    const t0 = Date.now();
    const kx = W / placement.width / f, ky = H / placement.height / f;
    const pxPerMm = (kx + ky) / 2;
    const mm = px => px / pxPerMm;
    const toGx = X => (X - placement.x) * kx;
    const toGy = Y => (Y - placement.y) * ky;
    const fromGx = g => g / kx + placement.x;
    const fromGy = g => g / ky + placement.y;
    const N = gw * gh;
    const tolPx = Math.max(1, opt.tolMm * pxPerMm);
    const progress = (phase, done, total) => { if (onProgress) onProgress({ phase, done, total }); };

    const toGrid = (arr) => {
        const n = arr.length / 2, g = new Int32Array(arr.length);
        for (let i = 0; i < n; i++) { g[i * 2] = Math.round(toGx(arr[i * 2])); g[i * 2 + 1] = Math.round(toGy(arr[i * 2 + 1])); }
        return g;
    };

    progress("Preparing image", 0, 1);
    const dtPng = distanceTransform(ink, gw, gh);
    const nearPng = thresholdDT(dtPng, tolPx);

    // DEXPI ink mask (what the viewer draws: graphics + expected HT + signal marks)
    const dexInk = new Uint8Array(N);
    const stamp = (g) => {
        for (let i = 0; i < g.length; i += 2) {
            const x = g[i], y = g[i + 1];
            if (x >= 0 && y >= 0 && x < gw && y < gh) dexInk[y * gw + x] = 1;
        }
    };
    const items = geometry.items.map(it => {
        const g = toGrid(it.pts);
        const gf = it.fill?.length ? toGrid(it.fill) : new Int32Array(0);
        stamp(g); stamp(gf);
        if (it.kind === "line" && it.markInk?.length) stamp(toGrid(it.markInk));
        return { it, g, gf };
    });
    // DEXPI graphics without the HT overlays -> "trace-like" image ink mask
    const dtBase = distanceTransform(dexInk, gw, gh);
    geometry.items.forEach(it => { if (it.ht?.expected) stamp(toGrid(it.ht.pts)); });
    const dtDex = distanceTransform(dexInk, gw, gh);
    const nearDex = thresholdDT(dtDex, tolPx * 1.5);

    // text mask (grid) - image ink inside a DEXPI text extent is not reported
    const textMask = new Uint8Array(N);
    geometry.textBoxes.forEach(b => {
        const x0 = Math.max(0, Math.floor(toGx(b.minX))), x1 = Math.min(gw - 1, Math.ceil(toGx(b.maxX)));
        const y0 = Math.max(0, Math.floor(toGy(b.minY))), y1 = Math.min(gh - 1, Math.ceil(toGy(b.maxY)));
        for (let y = y0; y <= y1; y++) textMask.fill(1, y * gw + x0, y * gw + x1 + 1);
    });

    // trace-like ink: image ink at least 0.75 mm away from any DEXPI graphic
    // (so a slightly offset or thick pipe line never counts), outside text,
    // then widened by the match tolerance
    const traceInk = new Uint8Array(N);
    const minTrace3 = Math.round(0.75 * pxPerMm * 3);
    for (let j = 0; j < N; j++) traceInk[j] = (ink[j] && dtBase[j] >= minTrace3 && !textMask[j]) ? 1 : 0;
    const traceMask = thresholdDT(distanceTransform(traceInk, gw, gh), tolPx);

    const scoreG = (g, dx, dy, mask = nearPng) => {
        const n = g.length / 2;
        if (!n) return 0;
        let hit = 0;
        for (let i = 0; i < g.length; i += 2) {
            const x = g[i] + dx, y = g[i + 1] + dy;
            if (x >= 0 && y >= 0 && x < gw && y < gh && mask[y * gw + x]) hit++;
        }
        return hit / n;
    };
    const subG = (g, maxPts) => {
        const n = g.length / 2;
        if (n <= maxPts) return g;
        const out = new Int32Array(maxPts * 2), stride = n / maxPts;
        for (let i = 0; i < maxPts; i++) { const j = Math.floor(i * stride) * 2; out[i * 2] = g[j]; out[i * 2 + 1] = g[j + 1]; }
        return out;
    };
    const combined = (g, gf) => {
        if (!gf.length) return g;
        const out = new Int32Array(g.length + gf.length); out.set(g); out.set(gf, g.length); return out;
    };
    const R = Math.max(2, Math.round(opt.searchMm * pxPerMm));
    const searchOffset = (g, step = 2) => {
        const s = subG(g, 400);
        let best = { score: -1, dx: 0, dy: 0 };
        for (let dy = -R; dy <= R; dy += step)
            for (let dx = -R; dx <= R; dx += step) {
                const v = scoreG(s, dx, dy);
                if (v > best.score || (v === best.score && dx * dx + dy * dy < best.dx * best.dx + best.dy * best.dy)) best = { score: v, dx, dy };
            }
        if (step > 1) {
            const c = best;
            for (let dy = c.dy - step; dy <= c.dy + step; dy++)
                for (let dx = c.dx - step; dx <= c.dx + step; dx++) {
                    const v = scoreG(s, dx, dy);
                    if (v > best.score) best = { score: v, dx, dy };
                }
        }
        best.score = scoreG(g, best.dx, best.dy);
        return best;
    };
    // symmetric match for comparing symbol options: precision x recall (F1)
    const optionScore = (g, gf, dx, dy, box) => {
        const all = combined(g, gf);
        const P = scoreG(all, dx, dy);
        // recall: image ink inside the symbol box that the option explains
        const local = new Uint8Array((box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1));
        const lw = box.x1 - box.x0 + 1, r = Math.max(1, Math.round(tolPx));
        for (let i = 0; i < all.length; i += 2) {
            const x = all[i] + dx - box.x0, y = all[i + 1] + dy - box.y0;
            for (let yy = y - r; yy <= y + r; yy++) for (let xx = x - r; xx <= x + r; xx++)
                if (xx >= 0 && yy >= 0 && xx < lw && yy <= box.y1 - box.y0) local[yy * lw + xx] = 1;
        }
        let inkN = 0, inkHit = 0;
        for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
            if (x < 0 || y < 0 || x >= gw || y >= gh || !ink[y * gw + x]) continue;
            inkN++; if (local[(y - box.y0) * lw + (x - box.x0)]) inkHit++;
        }
        const Rc = inkN ? inkHit / inkN : 0;
        return P + Rc > 0 ? 2 * P * Rc / (P + Rc) : 0;
    };

    // ordered-path analysis for lines: raw coverage, gap-bridged coverage, gaps
    const lineAnalysis = (g, dx, dy, lengthMm) => {
        const n = g.length / 2;
        const m = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const x = g[i * 2] + dx, y = g[i * 2 + 1] + dy;
            m[i] = (x >= 0 && y >= 0 && x < gw && y < gh && nearPng[y * gw + x]) ? 1 : 0;
        }
        const stepMm = n > 1 ? lengthMm / (n - 1) : STEP;
        const bridge = Math.max(1, Math.round(opt.gapBridgeMm / stepMm));
        const minGap = Math.max(1, Math.round(0.5 / stepMm));
        let raw = 0, bridged = 0, gaps = 0, gapLen = 0;
        let i = 0;
        while (i < n) {
            if (m[i]) { raw++; bridged++; i++; continue; }
            let j = i; while (j < n && !m[j]) j++;
            const len = j - i, interior = i > 0 && j < n;
            if (interior && len <= bridge) { bridged += len; if (len >= minGap) { gaps++; gapLen += len; } }
            i = j;
        }
        return { raw: raw / n, bridged: bridged / n, gaps, gapFrac: gapLen / n };
    };

    // dash detection: probe raw image ink only across the line (never along
    // it), so the distance tolerance cannot bridge the gaps of a dashed line
    const styleAnalysis = (linePts, dx, dy, lengthMm) => {
        const r = Math.max(1, Math.round(tolPx));
        const stepMm = 1 / pxPerMm;
        const m = [];
        for (let s = 0; s < linePts.length - 1; s++) {
            const p1 = linePts[s], p2 = linePts[s + 1];
            const L = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            if (L < 0.001) continue;
            const ux = (p2.x - p1.x) / L, uy = (p2.y - p1.y) / L;
            for (let u = 0; u <= L; u += stepMm) {
                const cx = toGx(p1.x + ux * u) + dx, cy = toGy(p1.y + uy * u) + dy;
                let hit = 0;
                for (let v = -r; v <= r && !hit; v++) {
                    const gx = Math.round(cx - uy * v), gy = Math.round(cy + ux * v);
                    if (gx >= 0 && gy >= 0 && gx < gw && gy < gh && ink[gy * gw + gx]) hit = 1;
                }
                m.push(hit);
            }
        }
        const n = m.length;
        const minGap = Math.max(1, Math.round(0.4 / stepMm));
        const maxGap = Math.round(opt.gapBridgeMm / stepMm);
        let gaps = 0, gapLen = 0, i = 0;
        while (i < n) {
            if (m[i]) { i++; continue; }
            let j = i; while (j < n && !m[j]) j++;
            const len = j - i;
            if (i > 0 && j < n && len >= minGap && len <= maxGap) { gaps++; gapLen += len; }
            i = j;
        }
        return { gaps, gapFrac: n ? gapLen / n : 0, per100: gaps / Math.max(1e-6, lengthMm / 100) };
    };

    const issues = [];
    const elementBoxMm = (it) => it.bbox;
    const add = (code, it, extra) => {
        const info = IMG_CODES[code];
        const bbox = extra.bbox || elementBoxMm(it);
        issues.push({
            key: `${code}|${it ? it.key : `${Math.round((bbox.minX + bbox.maxX) / 2)},${Math.round((bbox.minY + bbox.maxY) / 2)}`}`,
            code, title: info.title, severity: info.severity,
            elementKey: it?.key || null, representedId: it?.representedId || null,
            label: it?.label || "", objectType: it?.type || "", kind: it?.kind || "region",
            bbox, ...extra,
        });
    };

    const mmBox = (gx0, gy0, gx1, gy1) => ({ minX: fromGx(gx0), minY: fromGy(gy0), maxX: fromGx(gx1 + 1), maxY: fromGy(gy1 + 1) });
    let checked = 0, skipped = 0;
    const elemOffset = new Map();

    items.forEach(({ it, g, gf }, idx) => {
        if (idx % 50 === 0) progress("Checking objects", idx, items.length);
        // skip objects falling mostly outside the image
        let inside = 0;
        for (let i = 0; i < g.length; i += 2) if (g[i] >= 0 && g[i + 1] >= 0 && g[i] < gw && g[i + 1] < gh) inside++;
        if (inside < 0.5 * g.length / 2) { skipped++; return; }
        checked++;
        const what = it.kind === "line" ? "Line" : it.kind === "symbol" ? "Symbol" : "Graphic";

        if (it.kind === "line" && it.path) {
            const gp = it.pts === it.path ? g : toGrid(it.path);
            let la = lineAnalysis(gp, 0, 0, it.lengthMm);
            let dx = 0, dy = 0;
            if (la.bridged < opt.okScore) {
                const b = searchOffset(gp);
                const lb = lineAnalysis(gp, b.dx, b.dy, it.lengthMm);
                if (lb.bridged >= opt.okScore && Math.hypot(b.dx, b.dy) > tolPx) {
                    dx = b.dx; dy = b.dy; la = lb;
                    add("IMG-004", it, { score: lb.bridged, dxMm: mm(dx), dyMm: mm(dy), message: `${what} matches the image ${mm(Math.hypot(dx, dy)).toFixed(1)} mm away (dx ${mm(dx).toFixed(1)}, dy ${mm(dy).toFixed(1)} mm).` });
                } else if (la.bridged >= opt.partialScore) {
                    add("IMG-003", it, { score: la.bridged, message: `${what} only ${(la.bridged * 100).toFixed(0)}% matched in the image.` });
                } else {
                    add("IMG-002", it, { score: la.bridged, message: `${what} not found in the image (${(la.bridged * 100).toFixed(0)}% matched).` });
                }
            }
            elemOffset.set(it.key, { dx, dy });
            // line style - only once the line is actually located
            if (la.bridged >= opt.okScore && it.lengthMm >= 15) {
                const st = styleAnalysis(it.linePts, dx, dy, it.lengthMm);
                const measuredDashed = st.gapFrac >= 0.1 && st.per100 >= 4;
                if (measuredDashed !== it.expectedDashed) {
                    add("IMG-007", it, {
                        score: la.raw, dxMm: mm(dx), dyMm: mm(dy),
                        message: `DEXPI line style is ${it.dashStyle}${it.signalType ? ` (${it.signalType})` : ""}; the image line looks ${measuredDashed ? "dashed" : "solid"} (${(st.gapFrac * 100).toFixed(0)}% gaps, ${st.per100.toFixed(0)} gaps/100 mm).`,
                    });
                }
            }
            // signal type marks: off-line ink clusters along the line
            if (la.bridged >= opt.okScore && it.lengthMm >= 20 && (it.marks.length || it.signalType)) {
                const pts = it.linePts;
                let clusters = 0, run = 0;
                const stepW = 0.5;
                const flush = () => { if (run * stepW >= 0.5 && run * stepW <= 3.5) clusters++; run = 0; };
                for (let s = 0; s < pts.length - 1; s++) {
                    const p1 = pts[s], p2 = pts[s + 1];
                    const L = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                    if (L < 0.001) continue;
                    const ux = (p2.x - p1.x) / L, uy = (p2.y - p1.y) / L;
                    for (let u = 0; u <= L; u += stepW) {
                        let hit = false;
                        for (const v of [-1.0, -0.75, 0.75, 1.0]) {
                            const X = p1.x + ux * u - uy * v, Y = p1.y + uy * u + ux * v;
                            const gx = Math.round(toGx(X)) + dx, gy = Math.round(toGy(Y)) + dy;
                            if (gx >= 0 && gy >= 0 && gx < gw && gy < gh && ink[gy * gw + gx] && !textMask[gy * gw + gx]) { hit = true; break; }
                        }
                        if (hit) run++; else flush();
                    }
                    flush();
                }
                const per100 = clusters / (it.lengthMm / 100);
                if (it.marks.length && per100 < 2) {
                    add("IMG-008", it, { score: per100, message: `DEXPI type ${it.signalType} draws a mark every ${SIGNAL_MARK_SPACING} mm; the image line shows ${per100.toFixed(1)} mark-like features per 100 mm.` });
                } else if (!it.marks.length && it.lengthMm >= 40 && per100 >= 5) {
                    add("IMG-011", it, { score: per100, message: `The image line shows ${per100.toFixed(1)} mark-like features per 100 mm, but DEXPI type ${it.signalType || "SignalConveying"} has no marks.` });
                }
            }
        } else {
            const all = combined(g, gf);
            let s0 = scoreG(all, 0, 0);
            let dx = 0, dy = 0, located = s0 >= opt.okScore;
            if (!located) {
                const b = searchOffset(all);
                if (b.score >= opt.okScore && Math.hypot(b.dx, b.dy) > tolPx) {
                    dx = b.dx; dy = b.dy; located = true;
                    add("IMG-004", it, { score: b.score, dxMm: mm(dx), dyMm: mm(dy), message: `${what} matches the image ${mm(Math.hypot(dx, dy)).toFixed(1)} mm away (dx ${mm(dx).toFixed(1)}, dy ${mm(dy).toFixed(1)} mm).` });
                }
            }
            if (!located && it.alternates?.length) {
                let bestAlt = null;
                it.alternates.forEach(a => {
                    const ga = combined(toGrid(a.pts), a.fill.length ? toGrid(a.fill) : new Int32Array(0));
                    const b = searchOffset(ga, 3);
                    if (b.score >= opt.okScore && (!bestAlt || b.score > bestAlt.score)) bestAlt = { ...b, label: a.label };
                });
                if (bestAlt) {
                    located = true; dx = bestAlt.dx; dy = bestAlt.dy;
                    add("IMG-005", it, { score: bestAlt.score, dxMm: mm(dx), dyMm: mm(dy), message: `Symbol ${it.symbolName} matches the image when ${bestAlt.label}${Math.hypot(dx, dy) > tolPx ? ` and moved ${mm(Math.hypot(dx, dy)).toFixed(1)} mm` : ""}.` });
                }
            }
            // symbol options (variants selected by a PropertyValueCondition)
            let optionReported = false;
            if (it.variants?.length > 1) {
                const box = (() => {
                    const b = it.bbox, pad = tolPx * 2;
                    return { x0: Math.floor(toGx(b.minX) + dx - pad), y0: Math.floor(toGy(b.minY) + dy - pad), x1: Math.ceil(toGx(b.maxX) + dx + pad), y1: Math.ceil(toGy(b.maxY) + dy + pad) };
                })();
                let cur = null, best = null;
                it.variants.forEach(v => {
                    const sc = optionScore(toGrid(v.pts), v.fill.length ? toGrid(v.fill) : new Int32Array(0), dx, dy, box);
                    if (v.isCurrent) cur = { ...v, sc };
                    if (!best || sc > best.sc) best = { ...v, sc };
                });
                if (cur && best && !best.isCurrent && best.sc - cur.sc >= 0.08 && best.sc >= 0.5) {
                    optionReported = true; located = true;
                    add("IMG-006", it, { score: best.sc, message: `Image matches option "${best.condition}" (${best.name}, ${(best.sc * 100).toFixed(0)}%), DEXPI selects "${cur.condition}" (${cur.name}, ${(cur.sc * 100).toFixed(0)}%).` });
                }
            }
            if (!located && !optionReported) {
                const sc = Math.max(s0, scoreG(all, dx, dy));
                if (sc >= opt.partialScore) add("IMG-003", it, { score: sc, message: `${what}${it.symbolName ? ` ${it.symbolName}` : ""} only ${(sc * 100).toFixed(0)}% matched in the image.` });
                else add("IMG-002", it, { score: sc, message: `${what}${it.symbolName ? ` ${it.symbolName}` : ""} not found in the image (${(sc * 100).toFixed(0)}% matched).` });
            }
            elemOffset.set(it.key, { dx, dy });
        }

        // heat tracing - drawing conventions differ between tools (dashed or
        // dotted, 1-1.5 mm off the pipe), so look for trace-like ink: image ink
        // that the DEXPI graphics (without their own HT overlay) do not explain.
        if (it.ht && it.ht.pts.length) {
            const off = elemOffset.get(it.key) || { dx: 0, dy: 0 };
            if (it.kind === "line") {
                const gh_ = toGrid(it.ht.pts), nrm = it.ht.nrm;
                // slide the trace across the pipe only: 1.0 .. 2.5 mm off the pipe axis
                let s = 0, bt = 0;
                const t0 = Math.round(-0.5 * pxPerMm), t1 = Math.round(1.0 * pxPerMm);
                for (let t = t0; t <= t1; t++) {
                    let hit = 0;
                    for (let i = 0; i < gh_.length; i += 2) {
                        const x = Math.round(gh_[i] + off.dx + nrm[i] * t), y = Math.round(gh_[i + 1] + off.dy + nrm[i + 1] * t);
                        if (x >= 0 && y >= 0 && x < gw && y < gh && traceMask[y * gw + x]) hit++;
                    }
                    const v = hit / (gh_.length / 2);
                    if (v > s) { s = v; bt = t; }
                }
                const bdx = 0, bdy = 0;
                if (it.ht.expected && s < 0.35) add("IMG-009", it, { score: s, message: `Heat tracing is set in DEXPI, but no trace line was found along it in the image (${(s * 100).toFixed(0)}% matched).` });
                else if (!it.ht.expected && s >= 0.6) {
                    // a trace is a thin line: ink a further 1.4 mm out means text, not a trace
                    const far = 1.4 * pxPerMm;
                    let n = 0, hit = 0;
                    for (let i = 0; i < gh_.length; i += 2) {
                        const x = Math.round(gh_[i] + off.dx + bdx + nrm[i] * (far + bt)), y = Math.round(gh_[i + 1] + off.dy + bdy + nrm[i + 1] * (far + bt));
                        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
                        n++; if (nearPng[y * gw + x]) hit++;
                    }
                    if (n && hit / n < 0.25) add("IMG-010", it, { score: s, message: `The image shows a trace line along this pipe (${(s * 100).toFixed(0)}% of its length), but heat tracing is not set in DEXPI.` });
                }
            } else if (it.ht.expected && it.bbox && Math.max(it.bbox.maxX - it.bbox.minX, it.bbox.maxY - it.bbox.minY) >= 2.5) {
                const b = it.bbox, inner = 1 * pxPerMm, outer = 2.5 * pxPerMm;
                const x0 = Math.floor(toGx(b.minX) + off.dx - outer), x1 = Math.ceil(toGx(b.maxX) + off.dx + outer);
                const y0 = Math.floor(toGy(b.minY) + off.dy - outer), y1 = Math.ceil(toGy(b.maxY) + off.dy + outer);
                const ix0 = toGx(b.minX) + off.dx + inner, ix1 = toGx(b.maxX) + off.dx - inner;
                const iy0 = toGy(b.minY) + off.dy + inner, iy1 = toGy(b.maxY) + off.dy - inner;
                let cnt = 0;
                for (let y = Math.max(0, y0); y <= Math.min(gh - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(gw - 1, x1); x++) {
                    if (x > ix0 && x < ix1 && y > iy0 && y < iy1) continue;
                    const j = y * gw + x;
                    if (ink[j] && traceMask[j]) cnt++;
                }
                if (cnt < 1.5 * pxPerMm) add("IMG-009", it, { score: cnt / pxPerMm, message: `Heat tracing is set in DEXPI, but no trace marks were found around this symbol in the image.` });
            }
        }
    });

    // unexplained image ink -> regions
    progress("Finding unexplained image ink", 0, 1);
    const cb = geometry.contentBox;
    const m = opt.marginMm;
    const ax0 = cb ? Math.max(0, Math.floor(toGx(cb.minX - m))) : 0, ax1 = cb ? Math.min(gw - 1, Math.ceil(toGx(cb.maxX + m))) : gw - 1;
    const ay0 = cb ? Math.max(0, Math.floor(toGy(cb.minY - m))) : 0, ay1 = cb ? Math.min(gh - 1, Math.ceil(toGy(cb.maxY + m))) : gh - 1;
    const cand = new Uint8Array(N);
    for (let y = ay0; y <= ay1; y++) for (let x = ax0; x <= ax1; x++) {
        const j = y * gw + x;
        if (ink[j] && !nearDex[j] && !textMask[j]) cand[j] = 1;
    }
    const label = new Int32Array(N);
    const stack = new Int32Array(N);
    const minRegionPx = opt.minRegionMm * pxPerMm;
    const thLo = opt.textHeightMm * 0.6 * pxPerMm, thHi = opt.textHeightMm * 1.5 * pxPerMm;
    const keep = new Uint8Array(N);
    let nComp = 0, nText = 0, nSmall = 0;
    const regions = [];
    for (let s = 0; s < N; s++) {
        if (!cand[s] || label[s]) continue;
        nComp++;
        let sp = 0; stack[sp++] = s; label[s] = nComp;
        let x0 = gw, y0 = gh, x1 = -1, y1 = -1, cnt = 0;
        const members = [];
        while (sp) {
            const j = stack[--sp];
            const x = j % gw, y = (j / gw) | 0;
            cnt++; members.push(j);
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            for (let yy = y - 1; yy <= y + 1; yy++) {
                if (yy < 0 || yy >= gh) continue;
                for (let xx = x - 1; xx <= x + 1; xx++) {
                    if (xx < 0 || xx >= gw) continue;
                    const k = yy * gw + xx;
                    if (cand[k] && !label[k]) { label[k] = nComp; stack[sp++] = k; }
                }
            }
        }
        const w = x1 - x0 + 1, h = y1 - y0 + 1, maxD = Math.max(w, h), minD = Math.min(w, h);
        if (maxD < minRegionPx) { nSmall++; continue; }
        if (minD >= thLo && minD <= thHi && maxD >= 1.5 * minD && cnt / (w * h) > 0.12) { nText++; continue; }
        members.forEach(j => { keep[j] = 1; });
        regions.push({ x0, y0, x1, y1, cnt });
    }
    regions.sort((a, b) => b.cnt - a.cnt);
    const nearestItem = (b) => {
        const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
        let best = null, bd = Infinity;
        geometry.items.forEach(it => {
            if (!it.bbox || !it.label) return;
            const ddx = Math.max(it.bbox.minX - cx, 0, cx - it.bbox.maxX), ddy = Math.max(it.bbox.minY - cy, 0, cy - it.bbox.maxY);
            const d = Math.hypot(ddx, ddy);
            if (d < bd) { bd = d; best = it; }
        });
        return bd <= 10 ? best : null;
    };
    regions.slice(0, 1500).forEach(r => {
        const bbox = mmBox(r.x0, r.y0, r.x1, r.y1);
        const near = nearestItem(bbox);
        const w = bbox.maxX - bbox.minX, h = bbox.maxY - bbox.minY;
        issues.push({
            key: `IMG-001|${Math.round(bbox.minX)},${Math.round(bbox.minY)},${Math.round(w)},${Math.round(h)}`,
            code: "IMG-001", title: IMG_CODES["IMG-001"].title, severity: IMG_CODES["IMG-001"].severity,
            elementKey: null, representedId: near?.representedId || null, label: near ? `near ${near.label}` : "", objectType: near?.type || "", kind: "region",
            bbox, score: 0,
            message: `Image ink ${w.toFixed(1)} x ${h.toFixed(1)} mm that no DEXPI object explains${near ? ` (near ${near.label})` : ""}.`,
        });
    });

    // difference image
    progress("Drawing difference image", 0, 1);
    const diff = new Uint8ClampedArray(N * 4);
    for (let j = 0; j < N; j++) {
        const o = j * 4;
        if (ink[j]) {
            if (keep[j]) { diff[o] = 220; diff[o + 1] = 0; diff[o + 2] = 0; diff[o + 3] = 255; }
            else if (nearDex[j]) { diff[o] = 150; diff[o + 1] = 150; diff[o + 2] = 150; diff[o + 3] = 255; }
            else { diff[o] = 245; diff[o + 1] = 160; diff[o + 2] = 160; diff[o + 3] = 255; }
        } else if (dexInk[j] && !nearPng[j]) { diff[o] = 0; diff[o + 1] = 90; diff[o + 2] = 255; diff[o + 3] = 255; }
    }

    const counts = {};
    issues.forEach(i => { counts[i.code] = (counts[i.code] || 0) + 1; });
    return {
        issues,
        diff, diffW: gw, diffH: gh,
        stats: { pxPerMm, gridFactor: f, checked, skipped, components: nComp, ignoredText: nText, ignoredSmall: nSmall, counts, ms: Date.now() - t0, options: opt },
    };
}
