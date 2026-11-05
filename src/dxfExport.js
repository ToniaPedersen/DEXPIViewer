// ---------- DXF export -------------------------------------------------------
//
// Converts the rendered drawing (the live <svg> DOM) into an AutoCAD R12 ASCII
// DXF, keeping real vector geometry:
//   line / polyline / polygon / rect      -> LINE or POLYLINE (closed when needed)
//   circle / ellipse                      -> CIRCLE, or a POLYLINE when squashed
//   path (M L H V C S Q T A Z)            -> POLYLINE pieces + ARC for circular arcs
//   text / tspan                          -> TEXT (height, rotation, alignment)
//   stroke colour                         -> nearest AutoCAD colour index (ACI)
//   stroke-dasharray                      -> a LTYPE per distinct dash pattern
//
// R12 is used on purpose: it needs no object handles, and every CAD program
// (AutoCAD, BricsCAD, LibreCAD, DraftSight, QCAD, ODA viewers) reads it.
//
// Only elements inside `root` are exported. Elements are skipped when they are
// not drawn (display:none, visibility:hidden, opacity 0, or both fill and
// stroke none/transparent - i.e. the invisible click/hit areas), or when they
// or an ancestor carry data-dxf-skip. The layer comes from the nearest
// ancestor's data-dxf-layer (default "0").
//
// Y is flipped (SVG is y-down, DXF is y-up). Units are the drawing's own units
// (DEXPI mm), $INSUNITS is set to millimetres.

const TEXT_HEIGHT_FACTOR = 0.7; // SVG font-size is the em box; DXF TEXT height is ~ cap height
const CURVE_SEGMENTS = 16;      // segments per Bezier curve
const ARC_STEP_DEG = 5;         // max angle per segment when an arc/ellipse is flattened
const EPS = 1e-9;

const SHAPE_TAGS = new Set(["line", "polyline", "polygon", "rect", "circle", "ellipse", "path", "text"]);

// ---------- small helpers ----------------------------------------------------

function fmt(v) {
    if (!Number.isFinite(v)) return "0";
    const s = v.toFixed(4);
    return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") || "0" : s;
}

// Text values: DXF R12 is single-byte; non-ASCII goes as \U+XXXX, which AutoCAD
// and the other readers decode.
function dxfString(s) {
    let out = "";
    for (const ch of String(s)) {
        const cp = ch.codePointAt(0);
        if (cp === 0x0a || cp === 0x0d) out += " ";
        else if (cp < 0x20) continue;
        else if (cp < 0x80) out += ch;
        else if (cp <= 0xffff) out += "\\U+" + cp.toString(16).toUpperCase().padStart(4, "0");
        else out += "?";
    }
    return out;
}

function layerName(s) {
    const n = String(s || "0").replace(/[<>/\\":;?*|=,`]/g, "_").trim();
    return n || "0";
}

function parseCssColor(str) {
    if (!str || str === "none" || str === "transparent") return null;
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/i.exec(str);
    if (m) {
        let a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        if (a <= 0) return null;
        return [+m[1], +m[2], +m[3]];
    }
    const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str.trim());
    if (h) {
        const x = h[1].length === 3 ? h[1].split("").map(c => c + c).join("") : h[1];
        return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
    }
    return null;
}

// Standard AutoCAD colour index palette (ACI 1-255), generated the same way
// AutoCAD defines it: 1-9 fixed, 10-249 hue wheel in 24 hues x 10 shades,
// 250-255 greys.
const ACI = (() => {
    const pal = [null,
        [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [0, 0, 0], [128, 128, 128], [192, 192, 192]];
    const vals = [1, 0.65, 0.5, 0.3, 0.15];
    for (let i = 10; i <= 249; i++) {
        const hue = Math.floor((i - 10) / 10) * 15;      // 0..345
        const shade = (i - 10) % 10;
        const v = vals[Math.floor(shade / 2)];
        const sat = shade % 2 === 0 ? 1 : 0.5;
        // HSV -> RGB
        const c = v * sat, hp = hue / 60, x = c * (1 - Math.abs((hp % 2) - 1)), mm = v - c;
        let r = 0, g = 0, b = 0;
        if (hp < 1) [r, g, b] = [c, x, 0]; else if (hp < 2) [r, g, b] = [x, c, 0]; else if (hp < 3) [r, g, b] = [0, c, x];
        else if (hp < 4) [r, g, b] = [0, x, c]; else if (hp < 5) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
        pal[i] = [Math.round((r + mm) * 255), Math.round((g + mm) * 255), Math.round((b + mm) * 255)];
    }
    [51, 91, 132, 173, 214, 255].forEach((g, k) => { pal[250 + k] = [g, g, g]; });
    return pal;
})();

const aciCache = new Map();
function nearestAci(rgb) {
    if (!rgb) return 7;
    const key = rgb.join(",");
    if (aciCache.has(key)) return aciCache.get(key);
    // Black (and near-black) -> 7, which CAD shows as black on white / white on black.
    if (rgb[0] < 40 && rgb[1] < 40 && rgb[2] < 40) { aciCache.set(key, 7); return 7; }
    let best = 7, bestD = Infinity;
    for (let i = 1; i <= 255; i++) {
        if (i === 7) continue;
        const p = ACI[i];
        const dr = p[0] - rgb[0], dg = p[1] - rgb[1], db = p[2] - rgb[2];
        const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bestD) { bestD = d; best = i; }
    }
    aciCache.set(key, best);
    return best;
}

// ---------- matrices ---------------------------------------------------------

// m = {a,b,c,d,e,f} maps local SVG coords to drawing (root) coords.
const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
const det = m => m.a * m.d - m.b * m.c;
const scaleOf = m => Math.sqrt(Math.abs(det(m)));
function isSimilarity(m) {
    const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d);
    const dot = m.a * m.c + m.b * m.d;
    return Math.abs(sx - sy) <= 1e-6 * Math.max(sx, sy, 1) && Math.abs(dot) <= 1e-6 * Math.max(sx * sy, 1);
}

// ---------- SVG path -> pieces ------------------------------------------------

// Tokenise a path "d" into [cmd, [numbers...]] pairs.
function tokenizePath(d) {
    const out = [];
    const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
    let m, cur = null;
    while ((m = re.exec(d))) {
        if (m[1]) { cur = [m[1], []]; out.push(cur); }
        else if (cur) cur[1].push(parseFloat(m[2]));
    }
    return out;
}

// SVG arc endpoint -> centre parameterisation (SVG spec F.6.5).
function arcCenter(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
    const phi = phiDeg * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let coef = den > EPS ? Math.sqrt(Math.max(0, num / den)) : 0;
    if (fa === fs) coef = -coef;
    const cxp = coef * (rx * y1p / ry), cyp = coef * (-ry * x1p / rx);
    const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => {
        const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        return a;
    };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!fs && dt > 0) dt -= 2 * Math.PI;
    else if (fs && dt < 0) dt += 2 * Math.PI;
    return { cx, cy, rx, ry, phi, t1, dt };
}

function arcPoint(a, t) {
    const cp = Math.cos(a.phi), sp = Math.sin(a.phi);
    const x = a.rx * Math.cos(t), y = a.ry * Math.sin(t);
    return [a.cx + cp * x - sp * y, a.cy + sp * x + cp * y];
}

// Returns pieces in LOCAL coordinates:
//   { type: "poly", pts: [[x,y],...], closed }
//   { type: "arc", arc: {cx,cy,rx,ry,phi,t1,dt}, start:[x,y], end:[x,y], sweep }
function pathToPieces(d) {
    const pieces = [];
    let poly = null, cx = 0, cy = 0, sx = 0, sy = 0, lastCtrl = null, lastCmd = "";
    const flush = (closed = false) => {
        if (poly && poly.length >= 2) pieces.push({ type: "poly", pts: poly, closed });
        poly = null;
    };
    const lineTo = (x, y) => { if (!poly) poly = [[cx, cy]]; poly.push([x, y]); cx = x; cy = y; };

    for (const [cmd, nums] of tokenizePath(d)) {
        const rel = cmd === cmd.toLowerCase();
        const C = cmd.toUpperCase();
        let i = 0;
        const n = () => nums[i++];
        if (C === "Z") {
            if (poly) {
                if (Math.hypot(cx - sx, cy - sy) > EPS) poly.push([sx, sy]);
                const p = poly; poly = null;
                if (p.length >= 2) pieces.push({ type: "poly", pts: p, closed: true });
            }
            cx = sx; cy = sy; lastCtrl = null; lastCmd = C;
            continue;
        }
        do {
            if (C === "M") {
                flush();
                let x = n(), y = n(); if (rel) { x += cx; y += cy; }
                cx = sx = x; cy = sy = y; poly = null;
                // implicit lineto pairs after a moveto
                while (i + 1 < nums.length) { let lx = n(), ly = n(); if (rel) { lx += cx; ly += cy; } lineTo(lx, ly); }
                lastCtrl = null;
            } else if (C === "L") {
                let x = n(), y = n(); if (rel) { x += cx; y += cy; } lineTo(x, y); lastCtrl = null;
            } else if (C === "H") {
                let x = n(); if (rel) x += cx; lineTo(x, cy); lastCtrl = null;
            } else if (C === "V") {
                let y = n(); if (rel) y += cy; lineTo(cx, y); lastCtrl = null;
            } else if (C === "C" || C === "S") {
                let x1, y1;
                if (C === "C") { x1 = n(); y1 = n(); if (rel) { x1 += cx; y1 += cy; } }
                else if (lastCtrl && (lastCmd === "C" || lastCmd === "S")) { x1 = 2 * cx - lastCtrl[0]; y1 = 2 * cy - lastCtrl[1]; }
                else { x1 = cx; y1 = cy; }
                let x2 = n(), y2 = n(), x = n(), y = n();
                if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
                const x0 = cx, y0 = cy;
                for (let k = 1; k <= CURVE_SEGMENTS; k++) {
                    const t = k / CURVE_SEGMENTS, u = 1 - t;
                    lineTo(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
                           u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y);
                }
                lastCtrl = [x2, y2];
            } else if (C === "Q" || C === "T") {
                let x1, y1;
                if (C === "Q") { x1 = n(); y1 = n(); if (rel) { x1 += cx; y1 += cy; } }
                else if (lastCtrl && (lastCmd === "Q" || lastCmd === "T")) { x1 = 2 * cx - lastCtrl[0]; y1 = 2 * cy - lastCtrl[1]; }
                else { x1 = cx; y1 = cy; }
                let x = n(), y = n(); if (rel) { x += cx; y += cy; }
                const x0 = cx, y0 = cy;
                for (let k = 1; k <= CURVE_SEGMENTS; k++) {
                    const t = k / CURVE_SEGMENTS, u = 1 - t;
                    lineTo(u * u * x0 + 2 * u * t * x1 + t * t * x, u * u * y0 + 2 * u * t * y1 + t * t * y);
                }
                lastCtrl = [x1, y1];
            } else if (C === "A") {
                const rx = n(), ry = n(), rot = n(), fa = n() ? 1 : 0, fs = n() ? 1 : 0;
                let x = n(), y = n(); if (rel) { x += cx; y += cy; }
                if (Math.hypot(x - cx, y - cy) < EPS) { /* zero-length arc: nothing to draw */ }
                else if (Math.abs(rx) < EPS || Math.abs(ry) < EPS) lineTo(x, y);
                else {
                    const arc = arcCenter(cx, cy, rx, ry, rot, fa, fs, x, y);
                    flush();
                    pieces.push({ type: "arc", arc, start: [cx, cy], end: [x, y], sweep: fs });
                    cx = x; cy = y;
                }
                lastCtrl = null;
            }
            lastCmd = C;
        } while (i < nums.length && C !== "M");
    }
    flush();
    return pieces;
}

function flattenArc(arc) {
    const steps = Math.max(2, Math.ceil(Math.abs(arc.dt) * 180 / Math.PI / ARC_STEP_DEG));
    const pts = [];
    for (let k = 0; k <= steps; k++) pts.push(arcPoint(arc, arc.t1 + arc.dt * k / steps));
    return pts;
}

// ---------- DXF writer -------------------------------------------------------

class DxfWriter {
    constructor() {
        this.ents = [];
        this.layers = new Map();     // name -> aci
        this.ltypes = new Map();     // key -> { name, elems }
        this.minX = Infinity; this.minY = Infinity; this.maxX = -Infinity; this.maxY = -Infinity;
    }
    g(code, val) { this.ents.push(String(code), String(val)); }
    ext(x, y) {
        if (x < this.minX) this.minX = x; if (x > this.maxX) this.maxX = x;
        if (y < this.minY) this.minY = y; if (y > this.maxY) this.maxY = y;
    }
    useLayer(name) { if (!this.layers.has(name)) this.layers.set(name, 7); return name; }
    useLtype(dash) {
        if (!dash || !dash.length) return "CONTINUOUS";
        let elems = dash.slice();
        if (elems.length % 2) elems = elems.concat(elems);   // SVG repeats odd-length lists
        if (!elems.some(v => v > EPS)) return "CONTINUOUS";
        const key = elems.map(v => v.toFixed(3)).join(",");
        if (!this.ltypes.has(key)) this.ltypes.set(key, { name: `DASH${this.ltypes.size + 1}`, elems });
        return this.ltypes.get(key).name;
    }
    common(type, st) {
        this.g(0, type); this.g(8, st.layer);
        if (st.ltype !== "CONTINUOUS") this.g(6, st.ltype);
        this.g(62, st.color);
    }
    line(p1, p2, st) {
        this.common("LINE", st);
        this.g(10, fmt(p1[0])); this.g(20, fmt(p1[1])); this.g(30, 0);
        this.g(11, fmt(p2[0])); this.g(21, fmt(p2[1])); this.g(31, 0);
        this.ext(p1[0], p1[1]); this.ext(p2[0], p2[1]);
    }
    poly(pts, closed, st) {
        // drop consecutive duplicates
        const p = pts.filter((q, i) => i === 0 || Math.abs(q[0] - pts[i - 1][0]) > 1e-7 || Math.abs(q[1] - pts[i - 1][1]) > 1e-7);
        if (closed && p.length > 2 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-7) p.pop();
        if (p.length < 2) return;
        if (p.length === 2 && !closed) { this.line(p[0], p[1], st); return; }
        this.common("POLYLINE", st);
        this.g(66, 1); this.g(10, 0); this.g(20, 0); this.g(30, 0); this.g(70, closed ? 1 : 0);
        for (const q of p) {
            this.g(0, "VERTEX"); this.g(8, st.layer);
            this.g(10, fmt(q[0])); this.g(20, fmt(q[1])); this.g(30, 0);
            this.ext(q[0], q[1]);
        }
        this.g(0, "SEQEND"); this.g(8, st.layer);
    }
    circle(c, r, st) {
        this.common("CIRCLE", st);
        this.g(10, fmt(c[0])); this.g(20, fmt(c[1])); this.g(30, 0); this.g(40, fmt(r));
        this.ext(c[0] - r, c[1] - r); this.ext(c[0] + r, c[1] + r);
    }
    arc(c, r, a1, a2, st) {
        this.common("ARC", st);
        this.g(10, fmt(c[0])); this.g(20, fmt(c[1])); this.g(30, 0); this.g(40, fmt(r));
        this.g(50, fmt(a1)); this.g(51, fmt(a2));
        this.ext(c[0] - r, c[1] - r); this.ext(c[0] + r, c[1] + r);
    }
    text(p, height, rot, str, h, v, st) {
        if (!str.trim() || !(height > 0)) return;
        this.common("TEXT", st);
        this.g(10, fmt(p[0])); this.g(20, fmt(p[1])); this.g(30, 0);
        this.g(40, fmt(height)); this.g(1, dxfString(str));
        if (Math.abs(rot) > 1e-6) this.g(50, fmt(rot));
        this.g(7, "STANDARD");
        if (h) this.g(72, h);
        if (h || v) { this.g(11, fmt(p[0])); this.g(21, fmt(p[1])); this.g(31, 0); }
        if (v) this.g(73, v);
        this.ext(p[0], p[1]);
    }
    toString() {
        const o = [];
        const g = (c, v) => { o.push(String(c), String(v)); };
        if (!Number.isFinite(this.minX)) { this.minX = this.minY = 0; this.maxX = this.maxY = 1; }
        g(0, "SECTION"); g(2, "HEADER");
        g(9, "$ACADVER"); g(1, "AC1009");
        g(9, "$DWGCODEPAGE"); g(3, "ANSI_1252");
        g(9, "$INSUNITS"); g(70, 4);
        g(9, "$MEASUREMENT"); g(70, 1);
        g(9, "$EXTMIN"); g(10, fmt(this.minX)); g(20, fmt(this.minY)); g(30, 0);
        g(9, "$EXTMAX"); g(10, fmt(this.maxX)); g(20, fmt(this.maxY)); g(30, 0);
        g(9, "$LIMMIN"); g(10, fmt(this.minX)); g(20, fmt(this.minY));
        g(9, "$LIMMAX"); g(10, fmt(this.maxX)); g(20, fmt(this.maxY));
        g(9, "$LTSCALE"); g(40, 1);
        g(0, "ENDSEC");

        g(0, "SECTION"); g(2, "TABLES");
        // Line types
        g(0, "TABLE"); g(2, "LTYPE"); g(70, this.ltypes.size + 1);
        g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0); g(3, "Solid line"); g(72, 65); g(73, 0); g(40, 0);
        for (const { name, elems } of this.ltypes.values()) {
            const total = elems.reduce((s, v) => s + Math.abs(v), 0);
            g(0, "LTYPE"); g(2, name); g(70, 0); g(3, elems.map(v => v.toFixed(2)).join(" "));
            g(72, 65); g(73, elems.length); g(40, fmt(total));
            elems.forEach((v, i) => g(49, fmt(i % 2 === 0 ? Math.abs(v) : -Math.abs(v))));
        }
        g(0, "ENDTAB");
        // Layers
        if (!this.layers.has("0")) this.layers.set("0", 7);
        g(0, "TABLE"); g(2, "LAYER"); g(70, this.layers.size);
        for (const [name, color] of this.layers) { g(0, "LAYER"); g(2, name); g(70, 0); g(62, color); g(6, "CONTINUOUS"); }
        g(0, "ENDTAB");
        // Text style
        g(0, "TABLE"); g(2, "STYLE"); g(70, 1);
        g(0, "STYLE"); g(2, "STANDARD"); g(70, 0); g(40, 0); g(41, 1); g(50, 0); g(71, 0); g(42, 2.5); g(3, "txt"); g(4, "");
        g(0, "ENDTAB");
        g(0, "ENDSEC");

        g(0, "SECTION"); g(2, "ENTITIES");
        const head = o.join("\r\n");
        const tail = ["0", "ENDSEC", "0", "EOF"].join("\r\n");
        return head + "\r\n" + this.ents.join("\r\n") + "\r\n" + tail + "\r\n";
    }
}

// ---------- DOM walk ---------------------------------------------------------

function ancestorAttr(el, root, attr) {
    for (let n = el; n && n !== root.parentNode; n = n.parentNode) {
        if (n.getAttribute && n.hasAttribute(attr)) return n.getAttribute(attr);
    }
    return null;
}

function isDrawn(el, root) {
    for (let n = el; n && n !== root; n = n.parentNode) {
        if (!n.getAttribute) break;
        if (n.hasAttribute("data-dxf-skip")) return false;
        const cs = getComputedStyle(n);
        if (cs.display === "none" || parseFloat(cs.opacity) === 0) return false;
    }
    return getComputedStyle(el).visibility !== "hidden";
}

function dashOf(cs, scale) {
    const s = cs.strokeDasharray;
    if (!s || s === "none") return null;
    const v = s.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
    if (!v.length || v.every(x => x <= 0)) return null;
    return v.map(x => x * scale);
}

/**
 * Build a DXF string from every visible shape under `root` (an <svg> or <g>
 * element that is in the document). Returns { dxf, count }.
 */
export function svgToDxf(root) {
    const w = new DxfWriter();
    const rootInv = root.getCTM().inverse();
    let count = 0;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode(n) {
            if (n.hasAttribute && n.hasAttribute("data-dxf-skip")) return NodeFilter.FILTER_REJECT;
            const tag = n.localName;
            if (tag === "defs" || tag === "clipPath" || tag === "mask" || tag === "pattern" || tag === "marker" || tag === "symbol" || tag === "image" || tag === "foreignObject") return NodeFilter.FILTER_REJECT;
            if (tag === "text") return NodeFilter.FILTER_ACCEPT;     // tspans handled by the text itself
            if (tag === "tspan") return NodeFilter.FILTER_REJECT;
            return SHAPE_TAGS.has(tag) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
    });

    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        if (!isDrawn(el, root)) continue;
        const cs = getComputedStyle(el);
        const tag = el.localName;
        const strokeRgb = parseCssColor(cs.stroke);
        const fillRgb = parseCssColor(cs.fill);
        const strokeOn = strokeRgb && parseFloat(cs.strokeOpacity) > 0 && parseFloat(cs.strokeWidth) > 0;
        const fillOn = fillRgb && parseFloat(cs.fillOpacity) > 0;
        if (tag === "text" ? !fillOn && !strokeOn : !strokeOn && !fillOn) continue;   // hit areas etc.

        const ctm = el.getCTM();
        if (!ctm) continue;
        const m = rootInv.multiply(ctm);
        // local -> DXF (y flipped)
        const P = (x, y) => { const q = apply(m, x, y); return [q[0], -q[1]]; };
        const sc = scaleOf(m);
        const layer = w.useLayer(layerName(ancestorAttr(el, root, "data-dxf-layer") || "0"));
        const st = {
            layer,
            color: nearestAci(tag === "text" ? (fillOn ? fillRgb : strokeRgb) : (strokeOn ? strokeRgb : fillRgb)),
            ltype: tag === "text" ? "CONTINUOUS" : w.useLtype(dashOf(cs, sc)),
        };
        count++;

        if (tag === "line") {
            w.line(P(el.x1.baseVal.value, el.y1.baseVal.value), P(el.x2.baseVal.value, el.y2.baseVal.value), st);
        } else if (tag === "polyline" || tag === "polygon") {
            const pts = [];
            const list = el.points;
            for (let i = 0; i < list.numberOfItems; i++) { const p = list.getItem(i); pts.push(P(p.x, p.y)); }
            w.poly(pts, tag === "polygon", st);
        } else if (tag === "rect") {
            const x = el.x.baseVal.value, y = el.y.baseVal.value, wd = el.width.baseVal.value, ht = el.height.baseVal.value;
            if (wd <= 0 || ht <= 0) { count--; continue; }
            w.poly([P(x, y), P(x + wd, y), P(x + wd, y + ht), P(x, y + ht)], true, st);
        } else if (tag === "circle" || tag === "ellipse") {
            const cx = el.cx.baseVal.value, cy = el.cy.baseVal.value;
            const rx = tag === "circle" ? el.r.baseVal.value : el.rx.baseVal.value;
            const ry = tag === "circle" ? rx : el.ry.baseVal.value;
            if (rx <= 0 || ry <= 0) { count--; continue; }
            if (Math.abs(rx - ry) < 1e-9 && isSimilarity(m)) {
                w.circle(P(cx, cy), rx * sc, st);
            } else {
                const arc = { cx, cy, rx, ry, phi: 0, t1: 0, dt: 2 * Math.PI };
                w.poly(flattenArc(arc).map(q => P(q[0], q[1])), true, st);
            }
        } else if (tag === "path") {
            const d = el.getAttribute("d");
            if (!d) { count--; continue; }
            const sim = isSimilarity(m);
            const flipped = det(m) < 0;
            for (const pc of pathToPieces(d)) {
                if (pc.type === "poly") { w.poly(pc.pts.map(q => P(q[0], q[1])), pc.closed, st); continue; }
                const a = pc.arc;
                if (sim && Math.abs(a.rx - a.ry) < 1e-6 * Math.max(a.rx, 1)) {
                    // Circular arc -> DXF ARC (CCW from 50 to 51). Local sweep=1 is
                    // "increasing angle" in SVG y-down space, i.e. clockwise as seen,
                    // so it is clockwise in DXF too; a mirroring transform reverses it.
                    const c = P(a.cx, a.cy);
                    const s = P(pc.start[0], pc.start[1]), e = P(pc.end[0], pc.end[1]);
                    const ang = q => Math.atan2(q[1] - c[1], q[0] - c[0]) * 180 / Math.PI;
                    const ccw = (pc.sweep === 1) === flipped;
                    const r = a.rx * sc;
                    if (Math.abs(Math.abs(a.dt) - 2 * Math.PI) < 1e-6) w.circle(c, r, st);
                    else if (ccw) w.arc(c, r, ang(s), ang(e), st);
                    else w.arc(c, r, ang(e), ang(s), st);
                } else {
                    w.poly(flattenArc(a).map(q => P(q[0], q[1])), false, st);
                }
            }
        } else if (tag === "text") {
            writeText(el, cs, m, P, w, st);
        }
    }
    return { dxf: w.toString(), count };
}

function firstLen(list) {
    try { return list && list.baseVal && list.baseVal.numberOfItems ? list.baseVal.getItem(0).value : null; } catch { return null; }
}

function writeText(el, cs, m, P, w, st) {
    const fontSize = parseFloat(cs.fontSize) || 0;
    // Direction of the text baseline and of "up" in DXF space.
    const ux = m.a, uy = -m.b;                    // local +x -> DXF
    const rot = Math.atan2(uy, ux) * 180 / Math.PI;
    const upScale = Math.hypot(m.c, m.d);         // local y scale
    const height = fontSize * upScale * TEXT_HEIGHT_FACTOR;

    const anchor = cs.textAnchor;
    const hAlign = anchor === "middle" ? 1 : anchor === "end" ? 2 : 0;
    const base = (el.getAttribute("dominant-baseline") || cs.dominantBaseline || "").toLowerCase();
    const vAlign = base === "hanging" || base === "text-before-edge" ? 3
        : base === "middle" || base === "central" ? 2
        : base === "text-after-edge" || base === "ideographic" ? 1 : 0;

    const tx = firstLen(el.x) ?? 0, ty = firstLen(el.y) ?? 0;
    const spans = Array.from(el.children).filter(c => c.localName === "tspan");
    if (!spans.length) {
        w.text(P(tx, ty), height, rot, el.textContent || "", hAlign, vAlign, st);
        return;
    }
    let lastY = ty;
    for (const sp of spans) {
        const x = firstLen(sp.x) ?? tx;
        const y = firstLen(sp.y) ?? lastY;
        lastY = y;
        w.text(P(x, y), height, rot, sp.textContent || "", hAlign, vAlign, st);
    }
}

// Exposed for tests.
export const _internal = { pathToPieces, tokenizePath, nearestAci, DxfWriter, parseCssColor };
