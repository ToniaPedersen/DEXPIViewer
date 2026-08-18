import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseProfileConstraints, runFullValidation, downloadCSV, resolveSeverity } from "./validation.js";
import {
    parseDexpiPackage, boundsFromElements, clampViewBox,
    findAncestors, collectDescendantObjectIds, flattenTree,
    parseColor, collectModelValidIds, isConnectivityRefProperty,
} from "./dexpiParser.js";
import { jsPDF } from "jspdf";

// ---------- BG image default placement (embedded in the PNG itself) --------
// The saved default placement ({scale, offsetX, offsetY}) is written
// directly into the loaded PNG file's own metadata, as a standard tEXt
// ancillary chunk - not into localStorage. This means the default travels
// with the image file: opening it on a different machine, browser, or
// profile still applies the saved placement, and there's no separate
// per-browser store to keep in sync or lose. The tradeoff (see the UI below)
// is that a browser app can't rewrite a file already on disk in place, so
// "saving" the default produces new PNG bytes in memory that the user then
// downloads as a fresh file. Only PNG supports this (the chunk format below
// is PNG-specific); other image types can be used as a BG image as before,
// they just can't carry a saved default.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_PLACEMENT_KEYWORD = "dexpi:bgPlacement";

function isPngBytes(bytes) {
    if (!bytes || bytes.length < 8) return false;
    return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

function png_concat(...arrays) {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    arrays.forEach(a => { out.set(a, pos); pos += a.length; });
    return out;
}

// Standard PNG CRC-32 (ISO 3309 / ITU-T V.42), computed over a chunk's own
// type + data bytes, per the PNG spec - required on every chunk we write so
// PNG-conformant readers (including this app's own probe Image() load, and
// any other image viewer) don't reject the file as corrupt.
const PNG_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();
function png_crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = PNG_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function png_u32be(n) {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function png_readU32be(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

// Walks a PNG byte array's chunk structure, returning
// [{ type, dataStart, dataLength, chunkStart, chunkEnd }, ...] in file
// order (chunkStart/chunkEnd bound the WHOLE chunk - length+type+data+crc -
// so callers can splice bytes in/out at those boundaries directly). Stops
// at IEND, or early on any truncated/malformed chunk header rather than
// throwing - callers treat "no chunks found" the same as "not a PNG".
function png_readChunks(bytes) {
    const chunks = [];
    let offset = 8; // past the 8-byte signature
    while (offset + 8 <= bytes.length) {
        const length = png_readU32be(bytes, offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        const chunkEnd = dataEnd + 4; // + CRC
        if (chunkEnd > bytes.length) break;
        chunks.push({ type, dataStart, dataLength: length, chunkStart: offset, chunkEnd });
        offset = chunkEnd;
        if (type === "IEND") break;
    }
    return chunks;
}

// Decodes a tEXt chunk's "Keyword\0Text" payload (Latin-1, per the PNG
// spec's tEXt encoding - ASCII-safe for the plain-JSON payload written by
// png_buildTextChunk below).
function png_decodeTextChunk(bytes, chunk) {
    const data = bytes.subarray(chunk.dataStart, chunk.dataStart + chunk.dataLength);
    const nul = data.indexOf(0);
    if (nul < 0) return null;
    const keyword = String.fromCharCode(...data.subarray(0, nul));
    const text = String.fromCharCode(...data.subarray(nul + 1));
    return { keyword, text };
}

function png_buildTextChunk(keyword, text) {
    const kwBytes = Uint8Array.from(keyword, ch => ch.charCodeAt(0));
    const txtBytes = Uint8Array.from(text, ch => ch.charCodeAt(0));
    const typeBytes = Uint8Array.from("tEXt", ch => ch.charCodeAt(0));
    const data = png_concat(kwBytes, new Uint8Array([0]), txtBytes);
    const crc = png_crc32(png_concat(typeBytes, data));
    return png_concat(png_u32be(data.length), typeBytes, data, png_u32be(crc));
}

// Returns new PNG bytes with any existing placement tEXt chunk removed -
// used both standalone (Clear Default) and as the first step of writing a
// fresh one (write always strips-then-reinserts, so there's never more than
// one placement chunk in the file).
function png_stripPlacementChunk(bytes) {
    const chunks = png_readChunks(bytes);
    const keep = chunks.filter(c => {
        if (c.type !== "tEXt") return true;
        const kv = png_decodeTextChunk(bytes, c);
        return !(kv && kv.keyword === PNG_PLACEMENT_KEYWORD);
    });
    const parts = [bytes.subarray(0, 8)];
    keep.forEach(c => parts.push(bytes.subarray(c.chunkStart, c.chunkEnd)));
    return png_concat(...parts);
}

// Returns new PNG bytes with the given {scale, offsetX, offsetY} written in
// as a tEXt chunk immediately before IEND. Never mutates the input bytes.
// Throws if the input isn't a well-formed PNG (callers only call this after
// isPngBytes() has already gated on the file being a PNG).
function writePngEmbeddedPlacement(bytes, placement) {
    const stripped = png_stripPlacementChunk(bytes);
    const chunks = png_readChunks(stripped);
    if (!chunks.some(c => c.type === "IEND")) throw new Error("Not a valid PNG (no IEND chunk found).");
    const newChunk = png_buildTextChunk(PNG_PLACEMENT_KEYWORD, JSON.stringify({
        scale: placement.scale, offsetX: placement.offsetX, offsetY: placement.offsetY,
    }));
    const parts = [stripped.subarray(0, 8)];
    chunks.forEach(c => {
        if (c.type === "IEND") parts.push(newChunk);
        parts.push(stripped.subarray(c.chunkStart, c.chunkEnd));
    });
    return png_concat(...parts);
}

// Reads the saved BG placement (if any) embedded in a PNG's own tEXt
// metadata - returns {scale, offsetX, offsetY} or null (not a PNG, no such
// chunk, or a malformed payload). Every failure mode degrades to "no saved
// default" rather than throwing, so a corrupt/foreign tEXt chunk never
// breaks loading the image itself.
function readPngEmbeddedPlacement(bytes) {
    try {
        if (!isPngBytes(bytes)) return null;
        for (const chunk of png_readChunks(bytes)) {
            if (chunk.type !== "tEXt") continue;
            const kv = png_decodeTextChunk(bytes, chunk);
            if (!kv || kv.keyword !== PNG_PLACEMENT_KEYWORD) continue;
            const parsedPlacement = JSON.parse(kv.text);
            if (parsedPlacement && Number.isFinite(parsedPlacement.scale) && Number.isFinite(parsedPlacement.offsetX) && Number.isFinite(parsedPlacement.offsetY)) {
                return { scale: parsedPlacement.scale, offsetX: parsedPlacement.offsetX, offsetY: parsedPlacement.offsetY };
            }
            return null;
        }
        return null;
    } catch {
        return null;
    }
}

// ---------- Data value formatting --------------------------------------------

/**
 * Render a parsed data value into a human-readable string or JSX.
 * Handles PhysicalQuantity (UoM), DataReference (enums), strings, numbers, etc.
 */
function formatDataValue(value) {
    if (value === null || value === undefined) return { text: "—", uom: null };

    // Physical quantity: { kind:"PhysicalQuantity", value, unit, unitRef }
    if (value && typeof value === "object" && value.kind === "PhysicalQuantity") {
        const num = value.value !== null && value.value !== undefined ? String(value.value) : "—";
        return { text: num, uom: value.unit || null, unitRef: value.unitRef || null };
    }

    // DataReference (enumeration): { kind:"DataReference", value:"..." }
    if (value && typeof value === "object" && value.kind === "DataReference") {
        const short = value.value.split(".").pop().split("/").pop();
        return { text: short, uom: null, fullRef: value.value };
    }

    // Generic aggregated value fallback: { kind:"AggregatedValue", type, entries }
    if (value && typeof value === "object" && value.kind === "AggregatedValue") {
        const parts = Object.entries(value.entries || {})
            .map(([k, v]) => `${k}: ${formatDataValue(v).text}`).join(", ");
        return { text: parts || `(${value.type})`, uom: null };
    }

    // SingleLanguageString
    if (value && typeof value === "object" && typeof value.value === "string") {
        return { text: value.value, uom: null };
    }

    // Primitive
    return { text: String(value), uom: null };
}

// ---------- Styles -----------------------------------------------------------

const S = {
    app: (lc, rc) => ({ display: "grid", gridTemplateColumns: `${lc ? 44 : 340}px 1fr ${rc ? 44 : 340}px`, height: "100vh", fontFamily: "Arial, sans-serif", color: "#111", overflow: "hidden" }),
    panel: { borderRight: "1px solid #d0d7de", display: "flex", flexDirection: "column", background: "#fff", minWidth: 0, overflow: "hidden" },
    rPanel: { borderLeft: "1px solid #d0d7de", display: "flex", flexDirection: "column", background: "#fff", minWidth: 0, overflow: "hidden" },
    collapsed: { borderRight: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", alignItems: "center", justifyContent: "center" },
    rCollapsed: { borderLeft: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", alignItems: "center", justifyContent: "center" },
    toolbar: { padding: "10px 12px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", flexShrink: 0 },
    scroll: { flex: 1, overflow: "auto" },
    section: { padding: 12, borderBottom: "1px solid #eef2f6" },
    btn: { padding: "6px 10px", border: "1px solid #c7ced6", background: "white", borderRadius: 6, cursor: "pointer", fontSize: 13 },
    btnPrimary: { padding: "6px 10px", border: "1px solid #0969da", background: "#0969da", color: "white", borderRadius: 6, cursor: "pointer", fontSize: 13 },
    btnSmall: { padding: "3px 7px", border: "1px solid #c7ced6", background: "white", borderRadius: 4, cursor: "pointer", fontSize: 12 },
    btnDanger: { padding: "3px 7px", border: "1px solid #cf222e", background: "white", color: "#cf222e", borderRadius: 4, cursor: "pointer", fontSize: 12 },
    // Small green checkmark shown inline on a load button once its file has been loaded.
    loadedTick: { marginLeft: 6, color: "#1a7f37", fontWeight: 700 },
    input: { width: "100%", padding: "6px 8px", border: "1px solid #c7ced6", borderRadius: 6, boxSizing: "border-box", fontSize: 13 },
    numBox: { width: 52, padding: "2px 4px", border: "1px solid #c7ced6", borderRadius: 4, boxSizing: "border-box", fontSize: 12 },
    // Wide enough for an "nnn.nnnn" value (3 integer digits, 4 decimal places) without clipping.
    numBoxWide: { width: 88, padding: "2px 4px", border: "1px solid #c7ced6", borderRadius: 4, boxSizing: "border-box", fontSize: 12 },
    badge: (color) => ({ display: "inline-block", padding: "2px 7px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: color || "#eef2f6", color: color ? "white" : "#444" }),
    tabBar: { display: "flex", gap: 0, borderBottom: "1px solid #d0d7de", background: "#f6f8fa", flexShrink: 0 },
    tab: (active) => ({ padding: "8px 14px", cursor: "pointer", fontWeight: active ? 700 : 400, fontSize: 13, color: active ? "#0969da" : "#57606a", background: "none", border: "none", borderBottom: active ? "2px solid #0969da" : "2px solid transparent" }),
    collapseBtn: { width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "#57606a" },
    sevColor: { Error: "#cf222e", Warning: "#9a6700", Info: "#0969da" },
};

// ---------- EllipseArc SVG helper --------------------------------------------

/**
 * Convert a DEXPI EllipseArc to an SVG path string.
 * DEXPI angles are CCW in standard math (Y-up). In SVG (Y-down) this becomes
 * CW visually, so we use sweep-flag=1.
 */
function ellipseArcToPath(cx, cy, rx, ry, startDeg, endDeg, rotation) {
    const toRad = d => d * Math.PI / 180;
    const phiRad = toRad(rotation);
    const pt = (deg) => {
        const a = toRad(deg);
        const ca = Math.cos(a), sa = Math.sin(a);
        const cp = Math.cos(phiRad), sp = Math.sin(phiRad);
        return { x: cx + rx * cp * ca - ry * sp * sa, y: cy + rx * sp * ca + ry * cp * sa };
    };
    let span = endDeg - startDeg;
    if (span <= 0) span += 360;
    if (span >= 359.9) {
        const p1 = pt(startDeg), pmid = pt(startDeg + 180);
        return `M ${p1.x} ${p1.y} A ${rx} ${ry} ${rotation} 0 1 ${pmid.x} ${pmid.y} A ${rx} ${ry} ${rotation} 0 1 ${p1.x} ${p1.y}`;
    }
    const p1 = pt(startDeg), p2 = pt(endDeg);
    const largeArc = span > 180 ? 1 : 0;
    return `M ${p1.x} ${p1.y} A ${rx} ${ry} ${rotation} ${largeArc} 1 ${p2.x} ${p2.y}`;
}

// ---------- SVG Rendering ----------------------------------------------------

// Renders text that may contain embedded newlines (DiscProfile attribute
// values occasionally do - e.g. a PropertyBreak's BreakValue1/BreakValue2
// carry a literal "\n" between an area code and a line number) as one
// <tspan> per line, each positioned at the same x with an explicit absolute
// y - a single SVG <text> node otherwise collapses/ignores "\n" and renders
// everything on one line. Each line's y is computed so the overall
// multi-line block still honours the original single-line vertical
// alignment: "hanging" grows downward from the anchor point, "baseline"
// (bottom-aligned) grows upward so the LAST line's baseline lands on it,
// and "middle" centers the whole block on it. Falls back to a plain single
// <text> (no <tspan> wrapper) when there's only one line, to keep the
// common case's markup unchanged. Blank lines are collapsed to a
// non-breaking space so an empty BreakValue segment still reserves its row
// instead of visually merging with its neighbour.
// Ensures rendered text always reads left-to-right (horizontal) or
// bottom-to-top (vertical) - never upside-down, right-to-left, or
// top-to-bottom - regardless of a symbol's own placement rotation. Folds the
// TOTAL effective rotation (parentRotation - e.g. a symbol placement's own
// Rotation - PLUS localRotation - e.g. a LabelTemplate's or Text primitive's
// own Rotation) into the canonical readable set: 0 deg (horizontal) or -90
// deg / 270 deg (vertical, bottom-to-top). Any other angle - one that would
// render backwards or upside-down - is brought into that set by adding or
// subtracting 180 deg; since that changes which side of the anchor point
// the text visually falls on, the horizontal anchor and vertical baseline
// are swapped to the opposite side too, so flipped text still sits where it
// was authored to (e.g. "to the right of its anchor point"), just no longer
// illegible. Returns the LOCAL rotation to actually render (i.e. already
// compensated for parentRotation, so parentRotation + returned.rotation ==
// the canonical target) plus the (possibly swapped) anchor/baseline.
function readableTextOrientation(parentRotation, localRotation, anchor, baseline) {
    const raw = (((parentRotation || 0) + (localRotation || 0)) % 360 + 360) % 360; // [0, 360)
    let target;
    if (raw === 0) target = 0;
    else if (raw === 90) target = -90;
    else if (raw === 180) target = 0;
    else if (raw === 270) target = -90;
    else if (raw > 90 && raw < 270) target = raw - 180;
    else target = raw > 270 ? raw - 360 : raw;
    let delta = target - raw;
    delta = ((delta + 180) % 360 + 360) % 360 - 180; // normalize into (-180,180]
    const flipped = Math.abs(Math.abs(delta) - 180) < 0.01;
    const rotation = (localRotation || 0) + delta;
    if (!flipped) return { rotation, anchor, baseline };
    const flipAnchor = a => a === "start" ? "end" : a === "end" ? "start" : a;
    const flipBaseline = b => b === "hanging" ? "baseline" : b === "baseline" ? "hanging" : b;
    return { rotation, anchor: flipAnchor(anchor), baseline: flipBaseline(baseline) };
}

// Renders text that may contain embedded newlines (DiscProfile attribute
// values occasionally do - e.g. a PropertyBreak's BreakValue1/BreakValue2
// carry a literal "\n" between an area code and a line number) as one
// <tspan> per line, each positioned at the same x with an explicit absolute
// y - a single SVG <text> node otherwise collapses/ignores "\n" and renders
// everything on one line. Each line's y is computed so the overall
// multi-line block still honours the original single-line vertical
// alignment: "hanging" grows downward from the anchor point, "baseline"
// (bottom-aligned) grows upward so the LAST line's baseline lands on it,
// and "middle" centers the whole block on it. Falls back to a plain single
// <text> (no <tspan> wrapper) when there's only one line, to keep the
// common case's markup unchanged. Blank lines are collapsed to a
// non-breaking space so an empty BreakValue segment still reserves its row
// instead of visually merging with its neighbour.
//
// counterScale ({sx, sy}, optional): when given, the text is wrapped in a
// nested <g> that cancels out a parent symbol placement's own scale/mirror
// (translate to the label's local anchor point, undo the parent's scale -
// including any mirror sign baked into sx - then draw the text at the new
// local origin) so its glyphs render at their true absolute Size regardless
// of how large/small/non-uniformly the containing symbol instance was
// placed - see the "LabelTemplates and TextTemplate should not scale"
// requirement. rotation still composes normally since it isn't part of
// what's being cancelled.
function renderMultilineText({ key, x, y, rotation, fontFamily, fontSize, fill, anchor, baseline, counterScale }, text) {
    const lines = String(text ?? "").split(/\r\n|\r|\n/).map(l => l.trim());
    let transform, drawX = x, drawY = y;
    if (counterScale) {
        const rot = rotation ? ` rotate(${rotation})` : "";
        transform = `translate(${x} ${y}) scale(${1 / counterScale.sx} ${1 / counterScale.sy})${rot}`;
        drawX = 0; drawY = 0;
    } else {
        transform = rotation ? `rotate(${rotation} ${x} ${y})` : undefined;
    }
    if (lines.length <= 1) {
        return <text key={key} x={drawX} y={drawY} fontFamily={fontFamily} fontSize={fontSize} fill={fill} textAnchor={anchor} dominantBaseline={baseline} transform={transform}>{text}</text>;
    }
    const lineHeight = fontSize * 1.2;
    const n = lines.length;
    const yFor = i => {
        if (baseline === "hanging") return drawY + i * lineHeight;
        if (baseline === "middle") return drawY + (i - (n - 1) / 2) * lineHeight;
        return drawY - (n - 1 - i) * lineHeight;
    };
    return (
        <text key={key} fontFamily={fontFamily} fontSize={fontSize} fill={fill} textAnchor={anchor} dominantBaseline={baseline} transform={transform}>
            {lines.map((line, i) => <tspan key={i} x={drawX} y={yFor(i)}>{line || " "}</tspan>)}
        </text>
    );
}

function renderPrimitive(primitive, key, textColorOverride = null, strokeMult = 1, showProfileLabels = false, parentRotation = 0, symbolScale = null) {
    const fill = v => v?.style === "Transparent" ? "none" : (v?.color || "none");
    const sw = v => v * strokeMult;
    if (primitive.kind === "polyline") return <polyline key={key} points={primitive.points.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} strokeDasharray={primitive.stroke.dashArray || undefined} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "polygon") return <polygon key={key} points={primitive.points.map(p => `${p.x},${p.y}`).join(" ")} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "circle") return <circle key={key} cx={primitive.center.x} cy={primitive.center.y} r={primitive.radius} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "ellipse") return <ellipse key={key} cx={primitive.center.x} cy={primitive.center.y} rx={primitive.rx} ry={primitive.ry} transform={`rotate(${primitive.rotation} ${primitive.center.x} ${primitive.center.y})`} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "rect") return <rect key={key} x={primitive.center.x - primitive.width / 2} y={primitive.center.y - primitive.height / 2} width={primitive.width} height={primitive.height} transform={`rotate(${primitive.rotation} ${primitive.center.x} ${primitive.center.y})`} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "text") {
        const rawAnchor = primitive.style.horizontal.toLowerCase().includes("left") ? "start" : primitive.style.horizontal.toLowerCase().includes("right") ? "end" : "middle";
        const rawBaseline = primitive.style.vertical.toLowerCase().includes("bottom") ? "baseline" : primitive.style.vertical.toLowerCase().includes("top") ? "hanging" : "middle";
        // textColorOverride applies the selection highlight colour directly to text fill,
        // since text has no stroke geometry for highlightPrimitive to overlay.
        const textFill = textColorOverride || parseColor(primitive.style.color);
        // Profile labels, CHECKED: text shown must come ONLY from a placed
        // DiscProfile catalog symbol - never from any instance-authored
        // content. For a label belonging to a DiscProfile-catalogued symbol
        // (primitive.isDiscProfileLabel, computed in dexpiParser.js), this
        // Text primitive's own content is NEVER shown - the checkbox always
        // looks up the placed symbol's own catalog Profile/LabelTemplate
        // instead, never this Text's instance-authored Core/Diagram.
        // TextTemplate, even when that instance Template would itself
        // resolve to real content. dexpiParser.js's third pass in
        // collectGraphicalElements() always synthesizes el.labelOverlays for
        // every catalogued symbol placement; SymbolGraphic renders those
        // separately (at the catalog LabelTemplate's own local Position/
        // Rotation/Alignment, not this Text's position), which is why this
        // primitive itself contributes nothing when isDiscProfileLabel.
        // A Text that ISN'T tied to any catalogued symbol at all - even one
        // that still carries its own attribute-backed TextTemplate
        // (primitive.isProfileGoverned via instanceHasAttr, isDiscProfileLabel
        // false - e.g. a pipe segment's nominal-diameter Text referencing
        // NominalDiameterNumericalValueRepresentation directly, with no
        // Profile/SymbolUsage involved) - has no catalogued symbol to defer
        // to, so it's ignored entirely and shows nothing when checked, same
        // as isDiscProfileLabel. isProfileGoverned only matters for the
        // UNCHECKED case below.
        // When "Profile labels" is UNCHECKED, a Profile-governed label never
        // shows its raw <Data property="Text"> literal any more - that's the
        // instance's originally-authored/exported string, which the loaded
        // Profile supersedes. Instead:
        //  - no real Profile-driven backing at all (no TextTemplate on the
        //    instance AND no LabelTemplate on the symbol, or either exists
        //    but names no attribute whatsoever - primitive.
        //    hasProfileAttributeBacking, computed in dexpiParser.js) -> show
        //    nothing; a purely literal label isn't something the Profile has
        //    any say over.
        //  - otherwise -> show primitive.validRawProfileText, the attribute-
        //    resolved value from this Text's own TextTemplate (or the
        //    catalog LabelTemplate fallback), un-blanked by the suspect-
        //    duplicate-template pass that only affects the CHECKED-state
        //    overlay-preference decision (labelOverlays never render when
        //    unchecked, so there's no risk of double-rendering here) - AND
        //    with any Fragment whose AttributeName isn't actually valid for
        //    the owning object's placed DiscProfile symbol (e.g. "ItemTag"
        //    referenced for an object represented by symbol ND0192A, which
        //    only offers ObjectDisplayName/NominalDiameterRepresentation/
        //    ValveDataSheet/TrimType/LockMechanism - see PRF-E06 in
        //    validation.js) suppressed, rather than shown just because it
        //    happens to resolve to a real value elsewhere.
        // The literal instance value is only ever shown when no
        // DiscProfile.xml is loaded at all, or for a label with neither a
        // catalogued symbol nor its own TextTemplate (isProfileGoverned is
        // always false in both cases).
        const displayText = showProfileLabels
            ? ((primitive.isDiscProfileLabel || primitive.isProfileGoverned) ? "" : primitive.value)
            : (primitive.isProfileGoverned
                ? (primitive.hasProfileAttributeBacking ? (primitive.validRawProfileText ?? primitive.value) : "")
                : primitive.value);
        // "LabelTemplates and TextTemplate should not scale": a Text
        // primitive driven by a Core/Diagram.TextTemplate (templateFragments)
        // that lives inside a symbol's own catalog primitives (SymbolGraphic
        // passes symbolScale in that case) renders at its true absolute Size
        // regardless of that symbol instance's own placement scale - see
        // renderMultilineText's counterScale. Plain (non-templated) text
        // baked into a symbol keeps scaling with it as before.
        const useCounterScale = (symbolScale && primitive.templateFragments) ? symbolScale : null;
        const { rotation, anchor, baseline } = readableTextOrientation(parentRotation, primitive.rotation, rawAnchor, rawBaseline);
        return renderMultilineText({
            key, x: primitive.position.x, y: primitive.position.y, rotation,
            fontFamily: primitive.style.font, fontSize: primitive.style.size, fill: textFill, anchor, baseline,
            counterScale: useCounterScale,
        }, displayText);
    }
    if (primitive.kind === "ellipseArc") {
        const d = ellipseArcToPath(primitive.center.x, primitive.center.y, primitive.rx, primitive.ry, primitive.startAngle, primitive.endAngle, primitive.rotation);
        return <path key={key} d={d} fill="none" stroke={primitive.stroke.color} strokeWidth={sw(primitive.stroke.width)} strokeDasharray={primitive.stroke.dashArray || undefined} vectorEffect="non-scaling-stroke" />;
    }
    return null;
}

function highlightPrimitive(p, key, color) {
    const sw = Math.max((p.stroke?.width || 0.25) * 2.5, 0.9);
    if (p.kind === "polyline") return <polyline key={key} points={p.points.map(pt => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    if (p.kind === "polygon") return <polygon key={key} points={p.points.map(pt => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    if (p.kind === "circle") return <circle key={key} cx={p.center.x} cy={p.center.y} r={p.radius} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    if (p.kind === "ellipse") return <ellipse key={key} cx={p.center.x} cy={p.center.y} rx={p.rx} ry={p.ry} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    if (p.kind === "rect") return <rect key={key} x={p.center.x - p.width / 2} y={p.center.y - p.height / 2} width={p.width} height={p.height} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    if (p.kind === "ellipseArc") {
        const d = ellipseArcToPath(p.center.x, p.center.y, p.rx, p.ry, p.startAngle, p.endAngle, p.rotation);
        return <path key={key} d={d} fill="none" stroke={color} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity="0.85" />;
    }
    return null;
}

// ---------- Signal-conveying line decorations --------------------------------
// A SignalConveyingFunction's drawn Core/Diagram.ConnectorLine is decorated
// according to the DiscProfile custom attribute SignalConveyingFunctionType-
// Representation (ClassExtension SignalConveyingFunctionExtension, rdl_uri
// ".../SignalConveyingFunctionTypeRepresentationAssignmentClass") - see
// dexpiParser.js's collectGraphicalElements(), which carries the raw
// attribute value through as el.signalConveyingType (and, for the plain
// "SignalConveying" value, already forces the line's own dashArray there).
// Each entry here is the small glyph repeated along the line's length for a
// more specific representation value - ported from AKSODEXPIViewer's
// equivalent Proteus InformationFlow decoration (same glyph conventions and
// world-unit sizing): "ElectricalSignalConveying" (italic "E"),
// "HydraulicSignalConveying" (upright "L"), "BusSignalConveying" (small
// circle), "PneumaticSignalConveying" (a "^" chevron),
// "CapillarySignalConveying" (a small "x"), "UndefinedSignalConveying" (a
// small "/") and "ElectromagneticGuidedSignalConveying"/"Electromagnetic-
// UnguidedSignalConveying" (a small "∿" sine-wave squiggle).
const SIGNAL_CONVEYING_MARKS = {
    ElectricalSignalConveying: "E",
    HydraulicSignalConveying: "L",
    BusSignalConveying: "O",
    PneumaticSignalConveying: "^",
    CapillarySignalConveying: "x",
    UndefinedSignalConveying: "/",
    ElectromagneticGuidedSignalConveying: "∿",
    ElectromagneticUnguidedSignalConveying: "∿",
};
// Representation values whose own drawn connector line should be hidden
// entirely, leaving only the repeated mark - used for
// ElectromagneticUnguidedSignalConveying, which (unlike a guided wire) has
// no physical conductor to draw a continuous line for.
const SIGNAL_MARK_HIDE_LINE_TYPES = new Set(["ElectromagneticUnguidedSignalConveying"]);
const SIGNAL_MARK_SPACING = 14;  // world units between repeated glyphs
const SIGNAL_MARK_HEIGHT = 2.4;  // glyph cap-height, world units
const SIGNAL_MARK_WIDTH = 1.6;   // glyph width, world units (E only - L's arms are square, see below)
const SIGNAL_MARK_STROKE = 0.16; // glyph stroke width, world units - thin, close to the line's own weight
const SIGNAL_MARK_LEAN = 0.55;   // horizontal shear per unit of y (~29 deg) - a pronounced italic slant, E only
const SIGNAL_MARK_CIRCLE_RADIUS = 0.9; // "O" (Bus) circle radius, world units
const SIGNAL_MARK_CARET_WIDTH = 1.8;   // "^" (Pneumatic) chevron width, world units
const SIGNAL_MARK_X_WIDTH = 1.6;       // "x" (Capillary) cross width, world units
const SIGNAL_MARK_SLASH_WIDTH = 1.6;   // "/" (Undefined) stroke width, world units
const SIGNAL_MARK_WAVE_WIDTH = 2.4;    // "∿" (Electromagnetic Guided) one full wave cycle's width, world units

// Vector glyph paths for the marks above, drawn as monoline strokes rather
// than system-font text: font-based dominant-baseline centering doesn't
// reliably land on a letter's own visual middle (varies by browser/font),
// and font glyphs don't give exact control over stroke weight or slant
// angle. Each path is built in a local frame where y=0 is the line the
// glyph sits on - so placing a mark at (x, y) on the polyline with y=0 in
// this local frame puts the glyph precisely on the line (not just its
// bounding box), and x=0 is the glyph's leading edge along the line's own
// direction.
function buildSignalMarkPaths() {
    const h2 = SIGNAL_MARK_HEIGHT / 2;
    const w = SIGNAL_MARK_WIDTH;
    const lean = SIGNAL_MARK_LEAN;
    // Italic "E": lean is baked directly into each stroke's endpoints
    // (rather than an SVG skewX transform) so it reads correctly regardless
    // of the per-mark rotation applied afterwards. y=0 (the line) passes
    // through the glyph's middle bar.
    const lx = (x, y) => x - lean * y; // shifts top-of-glyph right, bottom left (standard italic lean)
    const tl = { x: lx(0, -h2), y: -h2 }, tr = { x: lx(w, -h2), y: -h2 };
    const bl = { x: lx(0, h2), y: h2 }, br = { x: lx(w, h2), y: h2 };
    const ml = { x: lx(0, 0), y: 0 }, mr = { x: lx(w * 0.75, 0), y: 0 };
    const ePath = `M${tl.x},${tl.y} L${tr.x},${tr.y} M${tl.x},${tl.y} L${bl.x},${bl.y} M${bl.x},${bl.y} L${br.x},${br.y} M${ml.x},${ml.y} L${mr.x},${mr.y}`;

    // Upright "L": vertical and horizontal arms are the same length
    // (SIGNAL_MARK_HEIGHT), and the line (y=0) passes through the middle of
    // the vertical arm, which runs from -h2 to +h2 with the horizontal arm
    // extending right from its foot.
    const lTop = { x: 0, y: -h2 }, lBottom = { x: 0, y: h2 }, lFoot = { x: SIGNAL_MARK_HEIGHT, y: h2 };
    const lPath = `M${lTop.x},${lTop.y} L${lBottom.x},${lBottom.y} L${lFoot.x},${lFoot.y}`;

    // "O" (Bus): a small circle whose center sits at y=0, so the line
    // passes straight through its middle. Drawn as two half-circle arcs
    // (the usual SVG trick for a full circle in one path, since a single
    // arc command can't span 360deg), positioned so it starts at its own
    // leading edge (x=0) the same way the other glyphs do.
    const r = SIGNAL_MARK_CIRCLE_RADIUS;
    const oPath = `M${r * 2},0 A${r},${r} 0 1 0 0,0 A${r},${r} 0 1 0 ${r * 2},0`;

    // "^" (Pneumatic): a chevron whose apex sits above the line and whose
    // two feet sit below it, symmetric about y=0 so the line runs through
    // the vertical middle of the shape (same convention as the "L" arm and
    // "O" circle above).
    const cw = SIGNAL_MARK_CARET_WIDTH;
    const caretLeft = { x: 0, y: h2 }, caretApex = { x: cw / 2, y: -h2 }, caretRight = { x: cw, y: h2 };
    const caretPath = `M${caretLeft.x},${caretLeft.y} L${caretApex.x},${caretApex.y} L${caretRight.x},${caretRight.y}`;

    // "x" (Capillary): two diagonal strokes corner-to-corner of a bounding
    // box centered on y=0. Diagonals of a rectangle always cross at its
    // center, so the line automatically runs straight through the cross
    // point without any extra alignment math.
    const xw = SIGNAL_MARK_X_WIDTH;
    const xPath = `M0,${-h2} L${xw},${h2} M0,${h2} L${xw},${-h2}`;

    // "/" (Undefined): a single diagonal stroke, bottom-left to top-right,
    // within a bounding box centered on y=0 - its midpoint therefore falls
    // exactly on the line, same "diagonal of a centered box" trick as "x".
    const sw_ = SIGNAL_MARK_SLASH_WIDTH;
    const slashPath = `M0,${h2} L${sw_},${-h2}`;

    // "∿" (Electromagnetic Guided): one full sine-like wave cycle, built
    // from two symmetric cubic-bezier humps. It starts and ends on y=0 and
    // also crosses y=0 at its midpoint, so - like the other marks - the
    // line runs straight through its vertical center throughout.
    const ww = SIGNAL_MARK_WAVE_WIDTH;
    const waveQ = ww / 4;
    const wavePath = `M0,0 C${waveQ},${-h2} ${waveQ},${-h2} ${waveQ * 2},0 `
        + `C${waveQ * 3},${h2} ${waveQ * 3},${h2} ${ww},0`;

    return { E: ePath, L: lPath, O: oPath, "^": caretPath, x: xPath, "/": slashPath, "∿": wavePath };
}
const SIGNAL_MARK_PATHS = buildSignalMarkPaths();

// Marches at a fixed spacing along a polyline's arc length and returns a
// {x, y, angleDeg} sample at each step. angleDeg follows the local segment's
// direction but is normalized to stay within (-90, 90] so the glyph is
// always drawn upright/readable regardless of which way the line's points
// happen to be ordered.
function markPointsAlongPolyline(points, spacing, startOffset = spacing / 2) {
    const marks = [];
    if (!points || points.length < 2) return marks;
    let nextMark = startOffset;
    let accum = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i], p2 = points[i + 1];
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) continue;
        let angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
        if (angleDeg > 90) angleDeg -= 180;
        else if (angleDeg <= -90) angleDeg += 180;
        while (nextMark <= accum + len) {
            const t = (nextMark - accum) / len;
            marks.push({ x: p1.x + dx * t, y: p1.y + dy * t, angleDeg });
            nextMark += spacing;
        }
        accum += len;
    }
    return marks;
}

// Renders a small italic vector glyph (e.g. "E" for ElectricalSignalConveying)
// repeated along a SignalConveyingFunction connector line's drawn length -
// see SIGNAL_CONVEYING_MARKS/SIGNAL_MARK_PATHS above.
function SignalConveyingMarks({ points, markKey, color }) {
    const d = SIGNAL_MARK_PATHS[markKey];
    if (!d) return null;
    const marks = markPointsAlongPolyline(points, SIGNAL_MARK_SPACING);
    if (marks.length === 0) return null;
    return (
        <g pointerEvents="none">
            {marks.map((m, i) => (
                <path key={i} d={d} fill="none" stroke={color} strokeWidth={SIGNAL_MARK_STROKE} strokeLinecap="round"
                    vectorEffect="non-scaling-stroke" transform={`translate(${m.x} ${m.y}) rotate(${m.angleDeg})`} />
            ))}
        </g>
    );
}

function ConnectorLineSvg({ el, nodePosMap, selected, connColor, boostPct }) {
    const { primitive: prim } = el;
    const src = prim.sourceRef ? nodePosMap.get(prim.sourceRef) : null;
    const tgt = prim.targetRef ? nodePosMap.get(prim.targetRef) : null;
    const pts = [src, ...prim.innerPoints, tgt].filter(Boolean);
    if (pts.length < 2) return null;
    const color = connColor || (selected ? "#d1242f" : prim.stroke.color);
    // Line Boost: percentage multiplier on connector/centerline stroke width
    // (100 = unchanged/no-op). The dash pattern is scaled proportionally so
    // dashes stay readable when the width is boosted.
    const baseWidth = prim.stroke.width;
    const sw = selected
        ? Math.max(baseWidth * 2, baseWidth + 0.4)
        : baseWidth * (boostPct / 100);
    const rawDash = prim.stroke.dashArray || "";
    const scaledDash = (!selected && rawDash && baseWidth > 0 && sw !== baseWidth)
        ? rawDash.split(/\s+/).map(v => (parseFloat(v) * (sw / baseWidth)).toFixed(3)).join(" ")
        : rawDash;
    const mid = Math.floor(pts.length / 2);
    const p1 = pts[mid - 1] || pts[0]; const p2 = pts[mid];
    const dx = p2.x - p1.x; const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len; const uy = dy / len;
    const mx = (p1.x + p2.x) / 2; const my = (p1.y + p2.y) / 2;
    const ar = Math.max(baseWidth * 3, 1.5);
    // Signal-conveying decoration: a repeated glyph along the line for a
    // known SignalConveyingFunctionTypeRepresentation sub-type (see above),
    // with the base line itself hidden for the sub-types in
    // SIGNAL_MARK_HIDE_LINE_TYPES (no physical conductor to draw).
    const markKey = SIGNAL_CONVEYING_MARKS[el.signalConveyingType];
    const hideLine = SIGNAL_MARK_HIDE_LINE_TYPES.has(el.signalConveyingType);
    return (
        <g>
            {/* Unselected: no vectorEffect so stroke scales naturally with the viewBox.
                Selected/connectivity: vectorEffect keeps highlight width constant while zooming. */}
            {!hideLine && (
                <polyline points={pts.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color} strokeWidth={sw} strokeDasharray={scaledDash || undefined} vectorEffect={(selected || connColor) ? "non-scaling-stroke" : "none"} />
            )}
            {(selected || connColor) && (
                <polygon
                    points={`${mx},${my} ${mx - ux * ar - uy * ar * 0.5},${my - uy * ar + ux * ar * 0.5} ${mx - ux * ar + uy * ar * 0.5},${my - uy * ar - ux * ar * 0.5}`}
                    fill={color} stroke="none" vectorEffect="non-scaling-stroke"
                />
            )}
            {markKey && <SignalConveyingMarks points={pts} markKey={markKey} color={color} />}
        </g>
    );
}

// Colour used when a graphical element is selected:
//   label elements  → orange  (they are annotation overlays, not primary symbols)
//   all other types → red
function selectionColor(elementRole) {
    return elementRole === "label" ? "#e06c00" : "#d1242f";
}

// ---------------------------------------------------------------------------
// Heat-trace overlay helpers
// ---------------------------------------------------------------------------
const HT_COLOR  = "#e06000";
const HT_DASH   = "6 2 6 2";  // dash-dash pattern
const HT_SW     = 0.6;         // stroke width (SVG units)
const HT_OFF    = 1.5;         // offset distance (~1 pt) from pipe / symbol edge
const HT_THRESH = 0.15;        // |sin| or |cos| threshold for axis-alignment (~8.6 deg)

/**
 * Heat trace dashed line for a connector-line pipe element.
 * Each segment between consecutive points (source → innerPoint[0] → … → target)
 * is evaluated independently:
 *   - Horizontal segment (within ~9 deg): line drawn 1 pt below
 *   - Vertical   segment (within ~9 deg): line drawn 1 pt to the right
 *   - Diagonal   segment:                 not drawn (skipped)
 * This correctly handles pipes that change direction at inner points.
 */
function HeatTraceConnectorLine({ el, nodePosMap }) {
    const prim = el.primitive;
    const src = prim.sourceRef ? nodePosMap.get(prim.sourceRef) : null;
    const tgt = prim.targetRef ? nodePosMap.get(prim.targetRef) : null;
    const raw = [src, ...prim.innerPoints, tgt].filter(Boolean);
    if (raw.length < 2) return null;

    const segs = [];
    for (let i = 0; i < raw.length - 1; i++) {
        const p1 = raw[i], p2 = raw[i + 1];
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) continue;
        if (Math.abs(dy / len) < HT_THRESH) {
            // horizontal segment → offset below
            segs.push({ x1: p1.x, y1: p1.y + HT_OFF, x2: p2.x, y2: p2.y + HT_OFF });
        } else if (Math.abs(dx / len) < HT_THRESH) {
            // vertical segment → offset to the right
            segs.push({ x1: p1.x + HT_OFF, y1: p1.y, x2: p2.x + HT_OFF, y2: p2.y });
        }
        // diagonal → skip
    }
    if (segs.length === 0) return null;
    return (
        <g pointerEvents="none">
            {segs.map((s, i) => (
                <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                    stroke={HT_COLOR} strokeWidth={HT_SW}
                    strokeDasharray={HT_DASH} vectorEffect="non-scaling-stroke" />
            ))}
        </g>
    );
}

/**
 * Compute the axis-aligned bounding box of a symbol in diagram (world) space
 * by transforming all four local corners through the full placement transform.
 */
function symbolDiagramBBox(el) {
    const mirror = el.isMirrored ? -1 : 1;
    const rad = (el.rotation || 0) * Math.PI / 180;
    const cosR = Math.cos(rad), sinR = Math.sin(rad);
    const { minX, maxX, minY, maxY } = el.variant;
    const corners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]].map(([lx, ly]) => {
        const sx = lx * el.scaleX * mirror;
        const sy = ly * el.scaleY;
        return { x: el.position.x + sx * cosR - sy * sinR,
                 y: el.position.y + sx * sinR + sy * cosR };
    });
    return {
        minX: Math.min(...corners.map(c => c.x)),
        maxX: Math.max(...corners.map(c => c.x)),
        minY: Math.min(...corners.map(c => c.y)),
        maxY: Math.max(...corners.map(c => c.y)),
    };
}

/**
 * Heat trace dashed line for an inline symbol (valve, fitting, nozzle).
 * Orientation is determined from el.rotation:
 *   ~0 / ~180 deg  (horizontal pipe) -> line 1 pt below  the symbol in diagram space
 *   ~90 / ~270 deg (vertical pipe)   -> line 1 pt right of the symbol in diagram space
 *   other (corner / diagonal)        -> line 1 pt below  (default)
 * The bounding box is computed in diagram space so the result is correct for all
 * rotations without relying on local-coordinate tricks.
 */
function HeatTraceSymbol({ el }) {
    const normRot = ((el.rotation || 0) % 360 + 360) % 360;
    const isVertical = (normRot > 75 && normRot < 105) || (normRot > 255 && normRot < 285);
    const bb = symbolDiagramBBox(el);
    if (isVertical) {
        const x = bb.maxX + HT_OFF;
        return <line x1={x} y1={bb.minY} x2={x} y2={bb.maxY}
            stroke={HT_COLOR} strokeWidth={HT_SW} strokeDasharray={HT_DASH}
            vectorEffect="non-scaling-stroke" pointerEvents="none" />;
    } else {
        const y = bb.maxY + HT_OFF;
        return <line x1={bb.minX} y1={y} x2={bb.maxX} y2={y}
            stroke={HT_COLOR} strokeWidth={HT_SW} strokeDasharray={HT_DASH}
            vectorEffect="non-scaling-stroke" pointerEvents="none" />;
    }
}

/**
 * Heat trace dashed rectangle drawn 1 pt outside a PIF symbol bounding box,
 * in local symbol coordinates so it rotates with the symbol.
 */
/**
 * Heat trace overlay for ProcessInstrumentationFunction.
 * Traces the actual outer boundary primitives of the symbol (circle, ellipse,
 * polygon) expanded 1 pt outward, so it follows the real symbol shape rather
 * than a bounding-box rectangle.  Internal detail polylines are skipped.
 * Falls back to a bounding-box rect when no boundary primitive is found.
 */
function HeatTracePIF({ el }) {
    const mirror = el.isMirrored ? -1 : 1;
    const transform = `translate(${el.position.x} ${el.position.y}) rotate(${el.rotation}) scale(${el.scaleX * mirror} ${el.scaleY})`;
    const pad = 1.5;

    const overlays = [];
    (el.variant.primitives || []).forEach((p, i) => {
        const key = `htpif_${i}`;
        if (p.kind === "circle") {
            overlays.push(
                <circle key={key} cx={p.center.x} cy={p.center.y} r={p.radius + pad}
                    fill="none" stroke={HT_COLOR} strokeWidth={HT_SW}
                    strokeDasharray={HT_DASH} vectorEffect="non-scaling-stroke" />
            );
        } else if (p.kind === "ellipse") {
            overlays.push(
                <ellipse key={key} cx={p.center.x} cy={p.center.y}
                    rx={p.rx + pad} ry={p.ry + pad}
                    transform={p.rotation ? `rotate(${p.rotation} ${p.center.x} ${p.center.y})` : undefined}
                    fill="none" stroke={HT_COLOR} strokeWidth={HT_SW}
                    strokeDasharray={HT_DASH} vectorEffect="non-scaling-stroke" />
            );
        } else if (p.kind === "polygon") {
            // Polygon: keep the same points but use a wide dashed stroke so the
            // overlay visually sits outside the filled shape.
            const outsetSW = (p.stroke?.width || 0.25) + pad * 2;
            overlays.push(
                <polygon key={key} points={p.points.map(pt => `${pt.x},${pt.y}`).join(" ")}
                    fill="none" stroke={HT_COLOR} strokeWidth={outsetSW}
                    strokeDasharray={HT_DASH} vectorEffect="non-scaling-stroke" />
            );
        }
        // polylines / text / rects are internal symbol details — not traced
    });

    if (overlays.length === 0) {
        // Fallback: simple rect 1 pt outside bounding box
        const x = Math.min(el.variant.minX, el.variant.maxX) - pad;
        const y = Math.min(el.variant.minY, el.variant.maxY) - pad;
        const w = Math.abs(el.variant.maxX - el.variant.minX) + pad * 2;
        const h = Math.abs(el.variant.maxY - el.variant.minY) + pad * 2;
        overlays.push(
            <rect key="htpif_fb" x={x} y={y} width={w} height={h}
                fill="none" stroke={HT_COLOR} strokeWidth={HT_SW}
                strokeDasharray={HT_DASH} vectorEffect="non-scaling-stroke" />
        );
    }

    return <g transform={transform} pointerEvents="none">{overlays}</g>;
}

// Renders one synthesized "Profile labels" symbol overlay (el.labelOverlays
// entry, computed in dexpiParser.js from the DiscProfile symbol's own
// Profile/LabelTemplate) as a <text>, in the SAME local symbol-coordinate
// system as the symbol's own primitives - it's meant to be rendered inside
// SymbolGraphic's already-transformed <g transform={transform}> below, so
// the browser's own SVG transform composition (translate/rotate/scale from
// the placement, applied automatically to this nested element) handles
// local→world placement without any manual matrix math here.
// el is the owning symbolUsage drawn element - its own placement Rotation/
// ScaleX/ScaleY/isMirrored are needed both to counter-scale this label back
// to its true absolute Size (see renderMultilineText's counterScale - a
// Profile/LabelTemplate overlay always gets this, unconditionally, unlike
// renderPrimitive's more narrowly-scoped templateFragments check) and to
// fold the label's total effective rotation (placement + the LabelTemplate's
// own local Rotation) into a readable orientation.
function renderLabelOverlay(ov, key, el) {
    const align = (ov.alignment || "").toLowerCase();
    const rawAnchor = align.includes("left") ? "start" : align.includes("right") ? "end" : "middle";
    const rawBaseline = align.includes("bottom") ? "baseline" : align.includes("top") ? "hanging" : "middle";
    const mirror = el.isMirrored ? -1 : 1;
    const { rotation, anchor, baseline } = readableTextOrientation(el.rotation, ov.rotation, rawAnchor, rawBaseline);
    return renderMultilineText({
        key, x: ov.position.x, y: ov.position.y, rotation,
        fontFamily: ov.font, fontSize: ov.size, fill: parseColor(ov.color), anchor, baseline,
        counterScale: { sx: el.scaleX * mirror, sy: el.scaleY },
    }, ov.text);
}

function SymbolGraphic({ el, selected, connHighlight, onSelect, boostPct, boostSymbolOutlines, showProfileLabels }) {
    const symbolStrokeMult = boostSymbolOutlines ? boostPct / 100 : 1;
    const mirror = el.isMirrored ? -1 : 1;
    const transform = `translate(${el.position.x} ${el.position.y}) rotate(${el.rotation}) scale(${el.scaleX * mirror} ${el.scaleY})`;
    const hitPad = 2.5;
    const hitX = Math.min(el.variant.minX, el.variant.maxX) - hitPad;
    const hitY = Math.min(el.variant.minY, el.variant.maxY) - hitPad;
    const hitW = Math.abs(el.variant.maxX - el.variant.minX) + hitPad * 2;
    const hitH = Math.abs(el.variant.maxY - el.variant.minY) + hitPad * 2;
    // When selected AND in connectivity, use the tint colour; role-aware colour when no connectivity tint
    const hlColor = selected ? (connHighlight || selectionColor(el.elementRole)) : connHighlight || null;
    // Tint background only when element is in the connectivity highlight
    const connTintFill = connHighlight === "#0969da" ? "#dbeafe"
                       : connHighlight === "#1a7f37" ? "#dcfce7"
                       : connHighlight === "#8250df" ? "#f3e8ff"
                       : null;
    return (
        <g onClick={e => { e.stopPropagation(); if (el.representedId) onSelect(el.representedId); }} style={{ cursor: el.representedId ? "pointer" : "default" }}>
            <g transform={transform}>
                <rect x={hitX} y={hitY} width={hitW} height={hitH} fill="transparent" stroke="none" pointerEvents="all" />
            </g>
            {connTintFill && <g transform={transform} pointerEvents="none">
                <rect x={el.variant.minX - 1} y={el.variant.minY - 1} width={(el.variant.maxX - el.variant.minX) + 2} height={(el.variant.maxY - el.variant.minY) + 2} fill={connTintFill} stroke={selected ? "#d1242f" : connHighlight} strokeWidth={selected ? 0.8 : 0.5} opacity={0.55} vectorEffect="non-scaling-stroke" />
            </g>}
            {hlColor && <g transform={transform} pointerEvents="none">{el.variant.primitives.map((p, i) => highlightPrimitive(p, `hl_${el.key}_${i}`, hlColor))}</g>}
            <g transform={transform} pointerEvents="none">
                {el.variant.primitives.map((p, i) => renderPrimitive(p, `${el.key}_${i}`, null, symbolStrokeMult, false, el.rotation, { sx: el.scaleX * mirror, sy: el.scaleY }))}
                {showProfileLabels && el.labelOverlays && el.labelOverlays.map((ov, i) => renderLabelOverlay(ov, `ovl_${el.key}_${i}`, el))}
                {hlColor && <rect x={el.variant.minX - 0.8} y={el.variant.minY - 0.8} width={(el.variant.maxX - el.variant.minX) + 1.6} height={(el.variant.maxY - el.variant.minY) + 1.6} fill="none" stroke={hlColor} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />}
            </g>
        </g>
    );
}

function PrimitiveGraphic({ el, selected, connHighlight, onSelect, nodePosMap, boostPct, boostSymbolOutlines, showProfileLabels }) {
    const hitPad = 2.0;
    const hlColor = selected ? (connHighlight || selectionColor(el.elementRole)) : connHighlight || null;
    const prim = el.primitive;
    return (
        <g onClick={e => { e.stopPropagation(); if (el.representedId) onSelect(el.representedId); }} style={{ cursor: el.representedId ? "pointer" : "default" }}>
            {prim?.kind === "circle" && <circle cx={prim.center.x} cy={prim.center.y} r={prim.radius + hitPad} fill="transparent" stroke="none" pointerEvents="all" />}
            {prim?.kind === "ellipse" && <ellipse cx={prim.center.x} cy={prim.center.y} rx={prim.rx + hitPad} ry={prim.ry + hitPad} fill="transparent" stroke="none" pointerEvents="all" />}
            {prim?.kind === "rect" && <rect x={prim.center.x - prim.width / 2 - hitPad} y={prim.center.y - prim.height / 2 - hitPad} width={prim.width + hitPad * 2} height={prim.height + hitPad * 2} fill="transparent" stroke="none" pointerEvents="all" />}
            {(prim?.kind === "polyline" || prim?.kind === "polygon") && <polyline points={prim.points.map(pt => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke="transparent" strokeWidth={Math.max((prim.stroke?.width || 0.25) + 4, 5)} vectorEffect="non-scaling-stroke" pointerEvents="stroke" />}
            {el.kind === "connectorLine" && (() => {
                const s = prim.sourceRef ? nodePosMap.get(prim.sourceRef) : null;
                const t = prim.targetRef ? nodePosMap.get(prim.targetRef) : null;
                const pts = [s, ...prim.innerPoints, t].filter(Boolean);
                if (pts.length < 2) return null;
                return <polyline points={pts.map(pt => `${pt.x},${pt.y}`).join(" ")} fill="none" stroke="transparent" strokeWidth={Math.max((prim.stroke?.width || 0.25) + 4, 5)} vectorEffect="non-scaling-stroke" pointerEvents="stroke" />;
            })()}
            {hlColor && el.kind !== "connectorLine" && prim?.kind !== "text" && highlightPrimitive(prim, `hl_${el.key}`, hlColor)}
            {el.kind === "connectorLine"
                ? <ConnectorLineSvg el={el} nodePosMap={nodePosMap} selected={selected} connColor={connHighlight} boostPct={boostPct} />
                : renderPrimitive(prim, el.key, prim?.kind === "text" ? hlColor : null, (boostSymbolOutlines && el.elementRole === "symbol") ? boostPct / 100 : 1, showProfileLabels)}
        </g>
    );
}

// ---------- Tree Node --------------------------------------------------------

function TreeNode({ node, selectedId, onSelect, expanded, setExpanded, level, issueMap }) {
    const isOpen = expanded.has(node.id);
    const hasChildren = node.children.length > 0;
    const isSelected = selectedId === node.objectId;
    const nodeIssues = node.objectId ? (issueMap.get(node.objectId) || []) : [];
    const hasError = nodeIssues.some(i => i.severity === "Error");
    const hasWarn = !hasError && nodeIssues.some(i => i.severity === "Warning");
    return (
        <div>
            <div
                id={node.objectId ? `tree-node-${node.objectId}` : undefined}
                onClick={() => { if (!node.objectId) return; onSelect(node.objectId); }}
                style={{ padding: "3px 8px", paddingLeft: 8 + level * 14, background: isSelected ? "#dbeafe" : "transparent", cursor: "pointer", borderRadius: 4, marginBottom: 1, display: "flex", alignItems: "center", gap: 5 }}
            >
                <span onClick={e => { e.stopPropagation(); if (!hasChildren) return; setExpanded(prev => { const n = new Set(prev); n.has(node.id) ? n.delete(node.id) : n.add(node.id); return n; }); }} style={{ width: 14, display: "inline-block", textAlign: "center", flexShrink: 0, color: "#888" }}>
                    {hasChildren ? (isOpen ? "▾" : "▸") : "·"}
                </span>
                {hasError && <span title="Has validation errors" style={{ color: "#cf222e", fontSize: 10, flexShrink: 0 }}>{"●"}</span>}
                {hasWarn && <span title="Has validation warnings" style={{ color: "#9a6700", fontSize: 10, flexShrink: 0 }}>{"●"}</span>}
                <span style={{ fontWeight: isSelected ? 700 : 400, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.label}</span>
                {(() => { const s = node.type.split(".").pop(); const tc = node.type.includes("FlowIn") ? "#0969da" : node.type.includes("FlowOut") ? "#1a7f37" : null; return <span style={{ fontSize: 10, color: tc || "#aaa", fontWeight: tc ? 600 : 400, flexShrink: 0, marginLeft: "auto" }}>{s}</span>; })()}
            </div>
            {isOpen && node.children.map(child => (
                <TreeNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} expanded={expanded} setExpanded={setExpanded} level={level + 1} issueMap={issueMap} />
            ))}
        </div>
    );
}

// ---------- Severity Editor --------------------------------------------------

function SeverityEditor({ issues, severityConfig, onUpdate }) {
    const ruleIds = useMemo(() => [...new Set(issues.map(i => i.ruleId))].sort(), [issues]);
    if (!ruleIds.length) return <div style={{ color: "#888", fontSize: 13 }}>Run validation first to see rules.</div>;
    const scoreFor = l => l === "Error" ? 3 : l === "Warning" ? 2 : l === "Info" ? 1 : 0;
    const dotColor = l => l === "Error" ? "#cf222e" : l === "Warning" ? "#9a6700" : l === "Info" ? "#0969da" : "#aaa";
    return (
        <div>
            {ruleIds.map(ruleId => {
                const effective = resolveSeverity(ruleId, severityConfig);
                const overridden = !!severityConfig[ruleId];
                return (
                    <div key={ruleId} style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 4, background: overridden ? "#f0f7ff" : "transparent" }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor(effective.level), flexShrink: 0, display: "inline-block" }} />
                        <span style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", fontFamily: "monospace" }} title={ruleId}>{ruleId}</span>
                        <select value={effective.level} onChange={e => { const l = e.target.value; onUpdate(ruleId, { level: l, score: scoreFor(l) }); }} style={{ fontSize: 12, padding: "2px 4px", border: "1px solid #c7ced6", borderRadius: 4 }}>
                            <option value="Error">Error</option>
                            <option value="Warning">Warning</option>
                            <option value="Info">Info</option>
                            <option value="Ignore">Ignore</option>
                        </select>
                        {overridden && <button title="Reset to default" style={{ fontSize: 10, padding: "1px 5px", border: "1px solid #c7ced6", borderRadius: 4, cursor: "pointer", background: "white", color: "#57606a" }} onClick={() => onUpdate(ruleId, null)}>↺</button>}
                    </div>
                );
            })}
        </div>
    );
}

// ---------- App --------------------------------------------------------------

export default function App() {
    const [leftCollapsed, setLeftCollapsed] = useState(false);
    const [rightCollapsed, setRightCollapsed] = useState(false);
    const [leftTab, setLeftTab] = useState("topology");
    const [rightTab, setRightTab] = useState("details");
    const [mainXmlText, setMainXmlText] = useState("");
    const [mainFileName, setMainFileName] = useState("validation-report");
    const [mainFileFullName, setMainFileFullName] = useState("");
    const [discXmlText, setDiscXmlText] = useState("");
    const [discFileFullName, setDiscFileFullName] = useState("");
    const [parsed, setParsed] = useState(null);
    const [parseError, setParseError] = useState("");
    const [selectedId, setSelectedId] = useState(null);
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState(new Set());
    const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1000, h: 1000 });
    const [fullBounds, setFullBounds] = useState({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    const [isPanning, setIsPanning] = useState(false);
    const [panStart, setPanStart] = useState(null);
    const [bgImage, setBgImage] = useState(null);
    const [showBgControls, setShowBgControls] = useState(false);
    const [profiles, setProfiles] = useState([]);
    const [validationIssues, setValidationIssues] = useState([]);
    const [validationDone, setValidationDone] = useState(false);
    const [validationFilter, setValidationFilter] = useState("All");
    const [collapsedCodeGroups, setCollapsedCodeGroups] = useState(new Set());
    const [severityConfig, setSeverityConfig] = useState({});
    // Connectivity checkbox: checking it SHOWS the upstream/downstream/group
    // highlight for the selected object; unchecked (the default) hides it.
    // See connectivityHighlight below and the legend near the drawing canvas,
    // both of which gate on this flag alone.
    const [showConnectivity, setShowConnectivity] = useState(false);
    // Whether selecting an object also highlights (red) all of its
    // sub-components in the drawing, or just the object itself - see
    // selectedRepresentedIds below. Default false: selecting a large
    // container (e.g. a PipingNetworkSystem or PipingNetworkSegment) no
    // longer paints its entire subtree red by default.
    const [selectHighlightSubComponents, setSelectHighlightSubComponents] = useState(false);
    // Line Boost: percentage multiplier on connector/centerline stroke width.
    // 100 = unchanged (no-op), so nothing is boosted until the user raises it.
    const [lineBoostPct, setLineBoostPct] = useState(100);
    const [boostSymbolOutlines, setBoostSymbolOutlines] = useState(false);
    // Profile labels: only meaningful (and only shown, see the toolbar below)
    // once a DiscProfile.xml is loaded. When checked, labels belonging to a
    // symbol placed from that DiscProfile catalogue show their
    // attribute-resolved value (primitive.profileText, computed in
    // dexpiParser.js's collectGraphicalElements()) instead of the instance's
    // own literal Text string - see renderPrimitive()'s text branch.
    const [showProfileLabels, setShowProfileLabels] = useState(false);
    const [spaceDown, setSpaceDown] = useState(false);
    const [exporting, setExporting] = useState(false);
    // Draw-order overrides: representedIds whose graphic(s) the user has sent
    // to the back of the paint order. Elements paint in array order (later =
    // on top), so a symbol that visually/interactively covers overlapping or
    // nested items - blocking clicks on whatever is underneath - can be
    // pushed behind everything else via "Send to Back" in the Object panel.
    const [sentToBackIds, setSentToBackIds] = useState(new Set());
    const toggleSendToBack = (id) => {
        if (!id) return;
        setSentToBackIds(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const mainInputRef = useRef(null);
    const discInputRef = useRef(null);
    const profileInputRef = useRef(null);
    const bgInputRef = useRef(null);
    // Object URL for the currently loaded BG image (see handleBgFile below) -
    // revoked whenever it's replaced or the component unmounts, since object
    // URLs otherwise leak for the life of the page.
    const bgObjectUrlRef = useRef(null);
    const issueCardRefs = useRef(new Map()); // index → DOM element for validation list scroll
    const svgViewportRef = useRef(null);
    const svgElRef = useRef(null);

    const issueMap = useMemo(() => {
        const m = new Map();
        validationIssues.forEach(issue => {
            const id = issue.objectId;
            if (!id || id.startsWith("(")) return;
            // Split compound IDs (e.g. ERR-E11 "GateValve1, BallValve1, …")
            const ids = id.split(",").map(s => s.trim()).filter(s => s && !s.startsWith("(") && !s.endsWith("…"));
            ids.forEach(singleId => {
                if (!m.has(singleId)) m.set(singleId, []);
                if (!m.get(singleId).includes(issue)) m.get(singleId).push(issue);
            });
        });
        return m;
    }, [validationIssues]);

    // Helper: find the best navigable objectId from an issue
    const getNavigableId = (issue) => {
        if (!parsed?.treeMap) return null;
        const id = issue?.objectId;
        if (id && !id.startsWith("(")) {
            if (parsed.treeMap.has(id)) return id;
            const first = id.split(",")[0].trim();
            if (first && !first.startsWith("(") && parsed.treeMap.has(first)) return first;
        }
        // Fall back to visual context (nearest represented ancestor)
        if (issue?.visualContextId && parsed.treeMap.has(issue.visualContextId)) return issue.visualContextId;
        return null;
    };

    const connectivityHighlight = useMemo(() => {
        if (!showConnectivity || !selectedId || !parsed?.connectivityMap) return { upstream: new Set(), downstream: new Set(), group: new Set() };
        return parsed.connectivityMap.get(selectedId) || { upstream: new Set(), downstream: new Set(), group: new Set() };
    }, [showConnectivity, selectedId, parsed]);

    // Drawing paint order, adjusted for any "Send to Back" overrides: every
    // graphic element whose representedId is in sentToBackIds is moved ahead
    // of everything else (stable within each group), so it paints first and
    // therefore sits visually and interactively *behind* the rest of the
    // drawing - exposing whatever it was overlapping for clicking/selection.
    const orderedGraphicsElements = useMemo(() => {
        const elements = parsed?.graphics?.elements;
        if (!elements) return [];
        if (sentToBackIds.size === 0) return elements;
        const back = [];
        const rest = [];
        for (const el of elements) {
            (el.representedId && sentToBackIds.has(el.representedId) ? back : rest).push(el);
        }
        return back.concat(rest);
    }, [parsed, sentToBackIds]);

    // Whether a DiscProfile.xml is loaded decides the parsing behavior -
    // there's no separate mode to pick: no profile loaded means "internal",
    // a profile loaded means "with profile", full stop.
    function rebuild(nextMain, nextDisc) {
        if (!nextMain) return;
        try {
            const p = parseDexpiPackage(nextMain, nextDisc || "");
            const b = boundsFromElements(p.graphics);
            setFullBounds(b);
            setParsed(p);
            setSelectedId(p.tree.objectId);
            setExpanded(new Set([p.tree.id, ...p.tree.children.slice(0, 5).map(c => c.id)]));
            setViewBox({ x: b.minX, y: b.minY, w: Math.max(100, b.maxX - b.minX), h: Math.max(100, b.maxY - b.minY) });
            setParseError("");
            setValidationIssues([]); setValidationDone(false);
            setSentToBackIds(new Set());
        } catch (e) { setParseError(e.message || String(e)); }
    }

    async function handleMainFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const txt = await file.text(); setMainXmlText(txt);
        // Strip extension for CSV filename
        setMainFileName(file.name.replace(/\.[^.]+$/, ""));
        setMainFileFullName(file.name);
        rebuild(txt, discXmlText);
    }
    async function handleDiscFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const txt = await file.text(); setDiscXmlText(txt);
        setDiscFileFullName(file.name);
        rebuild(mainXmlText, txt);
    }
    function clearDiscProfile() {
        setDiscXmlText(""); setDiscFileFullName(""); setShowProfileLabels(false);
        if (mainXmlText) rebuild(mainXmlText, "");
    }
    async function handleProfileFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const xml = await file.text();
        const name = file.name.replace(".xml", "");
        const constraints = parseProfileConstraints(xml, name);
        setProfiles(prev => [...prev, { name, xml, constraints }]);
        e.target.value = "";
    }
    async function handleBgFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const isPng = isPngBytes(bytes);
            // Look for a placement embedded in this PNG's own metadata (see
            // readPngEmbeddedPlacement above) and use it in place of the
            // auto-fit values (scale 1, offset 0,0) when present. Non-PNG
            // images, or a PNG with no such chunk, fall back to auto-fit.
            const embedded = isPng ? readPngEmbeddedPlacement(bytes) : null;
            const placement = embedded || { scale: 1, offsetX: 0, offsetY: 0 };

            if (bgObjectUrlRef.current) URL.revokeObjectURL(bgObjectUrlRef.current);
            const src = URL.createObjectURL(new Blob([bytes], { type: file.type || (isPng ? "image/png" : "") }));
            bgObjectUrlRef.current = src;

            // Load the raw pixel dimensions so the overlay can be fit into the
            // drawing's coordinate space (fullBounds) preserving aspect ratio,
            // instead of guessing a scale in unrelated CSS-pixel units.
            const probe = new Image();
            const base = {
                src, opacity: 0, scale: placement.scale, offsetX: placement.offsetX, offsetY: placement.offsetY, visible: true,
                // sourceBytes/isPng/fileName/embeddedPlacement support the
                // Download-with-placement/Clear-default controls below - see
                // downloadBgPlacementPng()/clearBgDefault().
                sourceBytes: bytes, isPng, fileName: file.name, embeddedPlacement: embedded,
            };
            probe.onload = () => setBgImage({ ...base, naturalWidth: probe.naturalWidth, naturalHeight: probe.naturalHeight });
            probe.onerror = () => setBgImage({ ...base, naturalWidth: 0, naturalHeight: 0 });
            probe.src = src;
        } catch (err) {
            alert("Could not read the selected image: " + (err.message || String(err)));
        }
        e.target.value = "";
    }

    // Embeds the current Scale/X/Y directly into a copy of the loaded PNG's
    // bytes and immediately downloads it. The originally-selected file on
    // disk is never modified, since a browser app has no way to do that -
    // this always hands the user a new file instead.
    function downloadBgPlacementPng() {
        if (!bgImage?.isPng || !bgImage.sourceBytes) return;
        try {
            const placement = { scale: bgImage.scale, offsetX: bgImage.offsetX, offsetY: bgImage.offsetY };
            const updated = writePngEmbeddedPlacement(bgImage.sourceBytes, placement);
            const blob = new Blob([updated], { type: "image/png" });
            const base = (bgImage.fileName || "background").replace(/\.png$/i, "");
            downloadBlob(blob, `${base}-placement.png`);
            setBgImage(b => b && ({ ...b, sourceBytes: updated, embeddedPlacement: placement }));
        } catch (err) {
            alert("Could not save the placement into the PNG: " + (err.message || String(err)));
        }
    }

    // Removes the embedded placement from the in-memory PNG bytes and
    // immediately downloads the result. Never touches the currently
    // displayed placement (scale/offsetX/offsetY) - only affects what a
    // future load of the downloaded file would apply.
    function clearBgDefault() {
        if (!bgImage?.isPng || !bgImage.sourceBytes) return;
        try {
            const updated = png_stripPlacementChunk(bgImage.sourceBytes);
            const blob = new Blob([updated], { type: "image/png" });
            const base = (bgImage.fileName || "background").replace(/\.png$/i, "");
            downloadBlob(blob, `${base}-placement.png`);
            setBgImage(b => b && ({ ...b, sourceBytes: updated, embeddedPlacement: null }));
        } catch (err) {
            alert("Could not clear the embedded placement: " + (err.message || String(err)));
        }
    }

    // Export: rasterizes exactly what's currently on screen inside the SVG
    // viewport - the DEXPI drawing plus the BG image overlay, since the overlay
    // lives inside the same <svg viewBox=...> tree rather than as a separate
    // HTML element. Cloning that one <svg> node is therefore enough to capture
    // both layers together.
    //
    // viewBox.w/h are in the drawing's own native coordinate units, which have
    // no fixed relationship to CSS pixels and can be arbitrarily large or small
    // depending on the source file - multiplying them directly by a "pixel
    // scale" could ask the browser for a many-thousand-megapixel canvas and
    // crash the tab. Instead we target a fixed output resolution (long edge in
    // px) regardless of the viewBox's native magnitude.
    const EXPORT_LONG_EDGE_PX = 3000;

    async function renderViewboxToCanvas() {
        const svgEl = svgElRef.current;
        if (!svgEl) throw new Error("Drawing is not ready yet.");
        const clone = svgEl.cloneNode(true);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        const aspect = viewBox.w / viewBox.h;
        const pxW = Math.max(1, Math.round(aspect >= 1 ? EXPORT_LONG_EDGE_PX : EXPORT_LONG_EDGE_PX * aspect));
        const pxH = Math.max(1, Math.round(aspect >= 1 ? EXPORT_LONG_EDGE_PX / aspect : EXPORT_LONG_EDGE_PX));
        clone.setAttribute("width", String(pxW));
        clone.setAttribute("height", String(pxH));

        const svgStr = new XMLSerializer().serializeToString(clone);
        const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
        try {
            const img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error("Could not rasterize the drawing for export."));
                im.src = url;
            });
            const canvas = document.createElement("canvas");
            canvas.width = pxW;
            canvas.height = pxH;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff"; // the viewport's own background - SVG itself is transparent
            ctx.fillRect(0, 0, pxW, pxH);
            ctx.drawImage(img, 0, 0, pxW, pxH);
            return canvas;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    function exportFileBaseName() {
        return (parsed?.meta?.drawingNumber || "dexpi-drawing").replace(/[\\/:*?"<>|]+/g, "_");
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    }

    async function exportAsPng() {
        setExporting(true);
        try {
            const canvas = await renderViewboxToCanvas();
            const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
            downloadBlob(blob, `${exportFileBaseName()}.png`);
        } catch (e) {
            alert(e.message || String(e));
        } finally {
            setExporting(false);
        }
    }

    async function exportAsPdf() {
        setExporting(true);
        try {
            const canvas = await renderViewboxToCanvas();
            const jpegData = canvas.toDataURL("image/jpeg", 0.95);
            // Page is sized to match the exported canvas's aspect ratio (long
            // edge fixed at 420mm/A3) - DEXPI drawing coordinates aren't
            // reliably real-world units here, so this is a print-friendly fit
            // rather than a dimensionally-accurate scale.
            const aspect = canvas.width / canvas.height;
            const longEdgeMm = 420;
            const wMm = aspect >= 1 ? longEdgeMm : longEdgeMm * aspect;
            const hMm = aspect >= 1 ? longEdgeMm / aspect : longEdgeMm;
            const pdf = new jsPDF({ orientation: aspect >= 1 ? "landscape" : "portrait", unit: "mm", format: [wMm, hMm] });
            pdf.addImage(jpegData, "JPEG", 0, 0, wMm, hMm);
            pdf.save(`${exportFileBaseName()}.pdf`);
        } catch (e) {
            alert(e.message || String(e));
        } finally {
            setExporting(false);
        }
    }

    function runValidation() {
        if (!parsed) return;
        // Collect valid cross-file reference IDs from DiscProfile and any loaded profiles
        const externalValidIds = collectModelValidIds(discXmlText);
        profiles.forEach(p => {
            collectModelValidIds(p.xml).forEach(id => externalValidIds.add(id));
        });
        const allIssues = runFullValidation({
            mainXml: mainXmlText, flatTree: parsed.flatTree,
            profiles, severityConfig, externalValidIds,
            discXml: discXmlText || null,
        });
        const issues = allIssues.filter(i => resolveSeverity(i.ruleId, severityConfig).level !== "Ignore");
        setValidationIssues(issues);
        setValidationDone(true);
        setLeftTab("validation");
    }

    const filteredTree = useMemo(() => {
        if (!parsed) return null;
        const q = search.trim().toLowerCase();
        if (!q) return parsed.tree;
        const filter = node => {
            const terms = [node.label, node.objectId, node.type, node.tagName, node.subTagName, node.loopNum, ...node.persistentIdentifiers.map(p => p.value)].filter(Boolean);
            const match = terms.some(v => String(v).toLowerCase().includes(q));
            const children = node.children.map(filter).filter(Boolean);
            return match || children.length ? { ...node, children } : null;
        };
        return filter(parsed.tree);
    }, [parsed, search]);

    const selectedNode = useMemo(() => parsed?.treeMap?.get(selectedId) || null, [parsed, selectedId]);
    const selectedRepresentedIds = useMemo(() => {
        if (!selectedNode) return new Set();
        // Sub-components checkbox (see its state declaration above) is the sole
        // gate for any red highlighting beyond the selected object itself -
        // unchecked (the default) means ONLY selectedNode's own id is
        // highlighted. Checked restores every tree descendant PLUS every
        // non-connectivity Association/ref target (e.g. a TransmissionSystem's
        // Driver reference to a Motor with no direct graphical element of its
        // own) - connectivity refs (upstream/downstream/group) are excluded
        // since they exist purely to drive the separate connectivity highlight
        // colors, not to mark their target as "also selected".
        if (!selectHighlightSubComponents) {
            return new Set(selectedNode.objectId ? [selectedNode.objectId] : []);
        }
        const ids = collectDescendantObjectIds(selectedNode);
        selectedNode.refs
            .filter(ref => !isConnectivityRefProperty(ref.property))
            .forEach(ref => ref.objects.forEach(id => { if (id) ids.add(id); }));
        return ids;
    }, [selectedNode, selectHighlightSubComponents]);

    // Every graphical Profile/SymbolUsage or Core/Diagram.ShapeUsage placement
    // whose Represents reference resolves to the selected object - an object
    // can have more than one (e.g. a base symbol + a separate cap/decoration
    // symbol, both representing the same id) - used by the Object tab below
    // to show each placement's Symbol reference, ScaleX, IsMirrored, and
    // Rotation alongside the object's own Data/References. Split by
    // elementRole (see pushSymbolUsage() in dexpiParser.js): "symbol" for the
    // object's own body/outline placements, "label" for a SymbolUsage that
    // sits inside a Core/Diagram.Label group instead (e.g. a "special item
    // number" balloon) - shown as a distinct "Label SymbolUsage" section.
    const selectedSymbolUsages = useMemo(() => {
        if (!selectedId || !parsed?.graphics?.elements) return [];
        return parsed.graphics.elements.filter(el => el.kind === "symbolUsage" && el.representedId === selectedId && el.elementRole !== "label");
    }, [selectedId, parsed]);
    const selectedLabelSymbolUsages = useMemo(() => {
        if (!selectedId || !parsed?.graphics?.elements) return [];
        return parsed.graphics.elements.filter(el => el.kind === "symbolUsage" && el.representedId === selectedId && el.elementRole === "label");
    }, [selectedId, parsed]);

    const handleSelect = useCallback((id) => {
        if (!id) return;
        setSelectedId(id);
        setSearch("");
        if (parsed) {
            const ancestors = findAncestors(parsed.tree, id);
            setExpanded(prev => new Set([...prev, ...ancestors]));
        }
    }, [parsed]);

    useEffect(() => {
        if (!selectedId) return;
        const h = requestAnimationFrame(() => { document.getElementById(`tree-node-${selectedId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
        return () => cancelAnimationFrame(h);
    }, [selectedId]);

    // Attach wheel listener directly with passive:false so preventDefault() works.
    // Plain scroll over the drawing zooms; the listener is scoped to the SVG container
    // so scrolling the topology tree or other panels is unaffected.
    useEffect(() => {
        const el = svgViewportRef.current;
        if (!el) return;
        const onWheel = e => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            const factor = e.deltaY > 0 ? 1.12 : 0.88;
            const mx = ((e.clientX - rect.left) / rect.width) * viewBox.w + viewBox.x;
            const my = ((e.clientY - rect.top) / rect.height) * viewBox.h + viewBox.y;
            setViewBox(v => clampViewBox({ x: mx - (mx - v.x) * factor, y: my - (my - v.y) * factor, w: v.w * factor, h: v.h * factor }, fullBounds));
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [fullBounds]);

    useEffect(() => {
        const onKeyDown = e => { if (e.code === "Space" && e.target === document.body) { e.preventDefault(); setSpaceDown(true); } };
        const onKeyUp   = e => { if (e.code === "Space") { setSpaceDown(false); setIsPanning(false); setPanStart(null); } };
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
    }, []);

    // Revokes the current BG image object URL (see handleBgFile) when the
    // component unmounts, so it isn't leaked for the life of the page. Each
    // handleBgFile call already revoke the previous one on replacement, this
    // only covers the final one still outstanding on unmount.
    useEffect(() => {
        return () => { if (bgObjectUrlRef.current) URL.revokeObjectURL(bgObjectUrlRef.current); };
    }, []);

    function updateSeverity(ruleId, config) {
        setSeverityConfig(prev => {
            const next = { ...prev };
            if (config === null) delete next[ruleId];
            else next[ruleId] = config;
            return next;
        });
    }
    function exportSeverityConfig() {
        // Export full effective config for every rule seen in the current run,
        // so the user gets a complete file they can edit and re-import.
        const full = {};
        [...new Set(validationIssues.map(i => i.ruleId))].sort().forEach(id => {
            full[id] = severityConfig[id] || resolveSeverity(id, severityConfig);
        });
        const b = new Blob([JSON.stringify(full, null, 2)], { type: "application/json" });
        const u = URL.createObjectURL(b); const a = document.createElement("a");
        a.href = u; a.download = "severity-config.json"; a.click(); URL.revokeObjectURL(u);
    }
    async function importSeverityConfig(e) { const f = e.target.files?.[0]; if (!f) return; try { setSeverityConfig(JSON.parse(await f.text())); } catch (_) { alert("Invalid config file."); } e.target.value = ""; }
    function expandAll() { if (!parsed) return; const ids = new Set(); flattenTree(parsed.tree).forEach(n => ids.add(n.id)); setExpanded(ids); }
    function collapseAll() { if (!parsed) return; setExpanded(new Set([parsed.tree.id])); }
    const moveProfile = (i, dir) => setProfiles(prev => { const a = [...prev]; const j = i + dir; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });

    const issueCounts = useMemo(() => { const c = { Error: 0, Warning: 0, Info: 0 }; validationIssues.forEach(i => { c[i.severity] = (c[i.severity] || 0) + 1; }); return c; }, [validationIssues]);
    const filteredIssues = useMemo(() => validationFilter === "All" ? validationIssues : validationIssues.filter(i => i.severity === validationFilter), [validationIssues, validationFilter]);
    const codeGroups = useMemo(() => {
        const groups = new Map();
        filteredIssues.forEach((issue, idx) => {
            const code = issue.ruleId || "(no code)";
            if (!groups.has(code)) groups.set(code, { code, items: [], severity: issue.severity });
            const g = groups.get(code);
            g.items.push({ issue, idx });
            const order = { Error: 0, Warning: 1, Info: 2 };
            if (order[issue.severity] < order[g.severity]) g.severity = issue.severity;
        });
        return Array.from(groups.values()).sort((a, b) => b.items.length - a.items.length || a.code.localeCompare(b.code));
    }, [filteredIssues]);
    function toggleCodeGroup(code) {
        setCollapsedCodeGroups(prev => { const next = new Set(prev); next.has(code) ? next.delete(code) : next.add(code); return next; });
    }
    function expandAllCodeGroups() { setCollapsedCodeGroups(new Set()); }
    function collapseAllCodeGroups() { setCollapsedCodeGroups(new Set(codeGroups.map(g => g.code))); }

    // The overlay is placed in the *drawing's* coordinate space (fullBounds),
    // not raw CSS/screen pixels: rendering it as an <image> inside the same
    // <svg viewBox=...> ties it to the identical transform as the drawing, so
    // it pans/zooms in lockstep instead of drifting out of alignment as soon
    // as the view is panned or zoomed (which a plain HTML sibling would do).
    const boundsW = Math.max(1, fullBounds.maxX - fullBounds.minX);
    const boundsH = Math.max(1, fullBounds.maxY - fullBounds.minY);
    const bgPlacement = useMemo(() => {
        if (!bgImage) return null;
        let baseW = boundsW, baseH = boundsH, baseX = fullBounds.minX, baseY = fullBounds.minY;
        if (bgImage.naturalWidth && bgImage.naturalHeight) {
            // "Contain"-fit the image into fullBounds, centered, so scale=1/offset=0
            // starts out already aligned to the drawing extents instead of an
            // arbitrary default.
            const imgAspect = bgImage.naturalWidth / bgImage.naturalHeight;
            const boundsAspect = boundsW / boundsH;
            if (imgAspect > boundsAspect) { baseW = boundsW; baseH = boundsW / imgAspect; }
            else { baseH = boundsH; baseW = boundsH * imgAspect; }
            baseX = fullBounds.minX + (boundsW - baseW) / 2;
            baseY = fullBounds.minY + (boundsH - baseH) / 2;
        }
        return {
            x: baseX + bgImage.offsetX,
            y: baseY + bgImage.offsetY,
            width: baseW * bgImage.scale,
            height: baseH * bgImage.scale,
        };
    }, [bgImage, fullBounds, boundsW, boundsH]);
    // Tints the overlay a mid-dark blue while preserving the image's original
    // luminance/detail (mix-blend-mode "color" replaces hue+saturation only).
    const BG_TINT_COLOR = "#1e3a5f";

    return (
        <div style={S.app(leftCollapsed, rightCollapsed)}>

            {/* LEFT PANEL */}
            {leftCollapsed ? (
                <div style={S.collapsed}><button style={S.collapseBtn} onClick={() => setLeftCollapsed(false)} title="Expand">{">"}</button></div>
            ) : (
                <div style={S.panel}>
                    <div style={S.toolbar}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                            <div style={{ fontWeight: 700, fontSize: 15 }}>DEXPI Verificator</div>
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                <button style={{ ...S.collapseBtn, fontSize: 14, fontWeight: 700, color: "#0969da", padding: "2px 7px", border: "1px solid #c7ced6", borderRadius: 4 }} title="Open User Guide" onClick={() => window.open("./UserGuide.html", "_blank", "noopener")}>?</button>
                                <button style={S.collapseBtn} onClick={() => setLeftCollapsed(true)}>{"<"}</button>
                            </div>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button style={S.btn} onClick={() => mainInputRef.current?.click()}>
                                Load DEXPI XML{mainXmlText && <span style={S.loadedTick} title="File loaded">✓</span>}
                            </button>
                            <button style={S.btn} onClick={() => discInputRef.current?.click()}>
                                DiscProfile.xml{discXmlText && <span style={S.loadedTick} title="File loaded">✓</span>}
                            </button>
                        </div>
                        <input ref={mainInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleMainFile} />
                        <input ref={discInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleDiscFile} />
                        <input ref={profileInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleProfileFile} />
                        {mainFileFullName && (
                            <div style={{ marginTop: 6, fontSize: 12, color: "#57606a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={mainFileFullName}>
                                Test file: <span style={{ fontWeight: 600, color: "#24292f" }}>{mainFileFullName}</span>
                            </div>
                        )}
                        {discFileFullName && (
                            <div style={{ marginTop: 2, fontSize: 12, color: "#57606a", display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={discFileFullName}>
                                    Profile: <span style={{ fontWeight: 600, color: "#24292f" }}>{discFileFullName}</span>
                                </span>
                                <button style={{ ...S.btnDanger, padding: "1px 6px", flexShrink: 0 }} title="Remove profile (revert to internal)" onClick={clearDiscProfile}>x</button>
                            </div>
                        )}
                        {parsed && <button style={{ ...S.btnPrimary, marginTop: 8, width: "100%" }} onClick={runValidation}>Run Validation</button>}
                        {validationDone && (
                            <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ ...S.badge("#cf222e"), cursor: "pointer" }} onClick={() => { setValidationFilter("Error"); setLeftTab("validation"); }}>{issueCounts.Error} Errors</span>
                                <span style={{ ...S.badge("#9a6700"), cursor: "pointer" }} onClick={() => { setValidationFilter("Warning"); setLeftTab("validation"); }}>{issueCounts.Warning} Warn</span>
                                <span style={{ ...S.badge("#0969da"), cursor: "pointer" }} onClick={() => { setValidationFilter("Info"); setLeftTab("validation"); }}>{issueCounts.Info} Info</span>
                                <button style={S.btnSmall} onClick={() => downloadCSV(validationIssues, `${mainFileName}.csv`)}>CSV</button>
                            </div>
                        )}
                    </div>

                    <div style={S.tabBar}>
                        {[["topology", "Topology"], ["validation", `Validation${validationDone ? ` (${validationIssues.length})` : ""}`], ["config", "Config"]].map(([t, label]) => (
                            <button key={t} style={S.tab(leftTab === t)} onClick={() => setLeftTab(t)}>{label}</button>
                        ))}
                    </div>

                    {leftTab === "topology" && (
                        <div style={S.scroll}>
                            <div style={{ padding: "6px 10px", borderBottom: "1px solid #eef2f6" }}>
                                <input style={S.input} placeholder="Search tag, type, ID, persistent ID..." value={search} onChange={e => setSearch(e.target.value)} />
                            </div>
                            <div style={{ padding: "4px 8px", borderBottom: "1px solid #eef2f6", display: "flex", gap: 6 }}>
                                <button style={S.btnSmall} onClick={expandAll}>Expand all</button>
                                <button style={S.btnSmall} onClick={collapseAll}>Collapse all</button>
                                {parsed && <span style={{ fontSize: 12, color: "#888", marginLeft: "auto" }}>{parsed.flatTree.length} objects</span>}
                            </div>
                            <div style={{ padding: 6 }}>
                                {parseError && <div style={{ color: "#cf222e", padding: 8, fontSize: 13 }}>{parseError}</div>}
                                {filteredTree ? (
                                    <TreeNode node={filteredTree} selectedId={selectedId} onSelect={handleSelect} expanded={expanded} setExpanded={setExpanded} level={0} issueMap={issueMap} />
                                ) : (
                                    <div style={{ color: "#888", fontSize: 13, padding: 8 }}>Load a DEXPI XML file to view the topology.</div>
                                )}
                            </div>
                        </div>
                    )}

                    {leftTab === "validation" && (
                        <div style={S.scroll}>
                            {!validationDone ? (
                                <div style={{ padding: 16, color: "#888", fontSize: 13 }}>
                                    {parsed ? 'Click "Run Validation" above.' : "Load a DEXPI XML file first."}
                                    {profiles.length > 0 && <div style={{ marginTop: 8 }}>{profiles.length} profile(s) loaded.</div>}
                                </div>
                            ) : (
                                <>
                                    <div style={{ padding: "6px 10px", borderBottom: "1px solid #eef2f6", display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                                        {["All", "Error", "Warning", "Info"].map(f => (
                                            <button key={f} style={{ ...S.btnSmall, background: validationFilter === f ? "#0969da" : "white", color: validationFilter === f ? "white" : "#111", borderColor: validationFilter === f ? "#0969da" : "#c7ced6" }} onClick={() => setValidationFilter(f)}>
                                                {f}{f !== "All" ? ` (${issueCounts[f]})` : ` (${validationIssues.length})`}
                                            </button>
                                        ))}
                                        <button style={S.btnSmall} onClick={expandAllCodeGroups}>Expand all</button>
                                        <button style={S.btnSmall} onClick={collapseAllCodeGroups}>Collapse all</button>
                                        <button style={{ ...S.btnSmall, marginLeft: "auto" }} onClick={() => downloadCSV(validationIssues, `${mainFileName}.csv`)}>CSV</button>
                                    </div>
                                    {(() => {
                                        const renderIssueCard = (issue, i) => {
                                            const navId = getNavigableId(issue);
                                            const isNavable = !!navId;
                                            const isActive = navId && navId === selectedId;
                                            const scrollToParent = (parent) => {
                                                const parentIdx = filteredIssues.findIndex(iss => iss.ruleId === parent.ruleId && iss.objectId === parent.objectId);
                                                if (parentIdx >= 0) {
                                                    const el = issueCardRefs.current.get(parentIdx);
                                                    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
                                                }
                                                if (parent.objectId && !parent.objectId.startsWith("(")) {
                                                    const pid = parsed?.treeMap?.has(parent.objectId) ? parent.objectId : null;
                                                    if (pid) { handleSelect(pid); setRightTab("issues"); }
                                                }
                                            };
                                            return (
                                                <div key={i}
                                                    ref={el => { if (el) issueCardRefs.current.set(i, el); else issueCardRefs.current.delete(i); }}
                                                    onClick={() => { if (navId) { handleSelect(navId); setRightTab("issues"); } }}
                                                    style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6", cursor: isNavable ? "pointer" : "default", borderLeft: isActive ? "3px solid #0969da" : "3px solid transparent", background: isActive ? "#f0f7ff" : "transparent", transition: "background 0.1s" }}
                                                >
                                                    <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 3 }}>
                                                        <span style={{ ...S.badge(S.sevColor[issue.severity]) }}>{issue.severity}</span>
                                                        <span style={{ fontSize: 11, fontFamily: "monospace", color: "#555" }}>{issue.ruleId}</span>
                                                        {issue.lineNumber != null && (
                                                            <span title={`Line ${issue.lineNumber} in the source XML`} style={{ fontSize: 10, fontFamily: "monospace", color: "#57606a", background: "#f6f8fa", border: "1px solid #eef2f6", borderRadius: 3, padding: "0 4px" }}>
                                                                L{issue.lineNumber}
                                                            </span>
                                                        )}
                                                        {isNavable && <span title="Click to highlight element" style={{ fontSize: 10, color: "#0969da", marginLeft: 2 }}>⊕</span>}
                                                        <span style={{ fontSize: 10, color: "#888", marginLeft: "auto" }}>{issue.profileSource}</span>
                                                    </div>
                                                    <div style={{ fontSize: 12, color: "#333", marginBottom: 2 }}>{issue.description}</div>
                                                    {issue.objectId && !issue.objectId.startsWith("(") && (
                                                        <div style={{ fontSize: 11, color: isNavable ? "#0969da" : "#57606a", fontFamily: "monospace" }}>
                                                            {isNavable && !issue.visualContextId ? "↳ " : ""}{issue.objectId}
                                                            {!isNavable && <span style={{ color: "#cf222e", marginLeft: 4 }} title="No graphical representation found">⚠ no symbol</span>}
                                                        </div>
                                                    )}
                                                    {issue.visualContextId && (
                                                        <div
                                                            onClick={e => { e.stopPropagation(); handleSelect(issue.visualContextId); setRightTab("issues"); }}
                                                            style={{ fontSize: 11, color: "#0969da", fontFamily: "monospace", marginTop: 2, cursor: "pointer" }}
                                                            title="Click to highlight nearest graphical ancestor in the drawing"
                                                        >
                                                            ↳ nearest symbol: {issue.visualContextId}
                                                        </div>
                                                    )}
                                                    {issue.causedBy && issue.causedBy.length > 0 && (
                                                        <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px dashed #d0d7de" }}>
                                                            {issue.causedBy.map((parent, pi) => (
                                                                <div key={pi}
                                                                    onClick={e => { e.stopPropagation(); scrollToParent(parent); }}
                                                                    style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", color: "#8250df", fontSize: 11 }}
                                                                    title={parent.description}
                                                                >
                                                                    <span>↑ root cause:</span>
                                                                    <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{parent.ruleId}</span>
                                                                    {parent.objectId && !parent.objectId.startsWith("(") && (
                                                                        <span style={{ fontFamily: "monospace", color: "#57606a" }}>on {parent.objectId}</span>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                    {issue.suggestedCorrection && <div style={{ fontSize: 11, color: "#0969da", marginTop: 2 }}>Suggestion: {issue.suggestedCorrection}</div>}
                                                </div>
                                            );
                                        };

                                        return codeGroups.map(group => {
                                            const isCollapsed = collapsedCodeGroups.has(group.code);
                                            return (
                                                <div key={group.code}>
                                                    <div
                                                        onClick={() => toggleCodeGroup(group.code)}
                                                        style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", background: "#f6f8fa", borderBottom: "1px solid #eef2f6", cursor: "pointer", position: "sticky", top: 0, zIndex: 1 }}
                                                    >
                                                        <span style={{ fontSize: 10, color: "#57606a", width: 10, display: "inline-block" }}>{isCollapsed ? "▶" : "▼"}</span>
                                                        <span style={{ ...S.badge(S.sevColor[group.severity]) }}>{group.severity}</span>
                                                        <span style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 600, color: "#333" }}>{group.code}</span>
                                                        <span style={{ fontSize: 11, color: "#888", marginLeft: "auto" }}>{group.items.length}</span>
                                                    </div>
                                                    {!isCollapsed && group.items.map(({ issue, idx }) => renderIssueCard(issue, idx))}
                                                </div>
                                            );
                                        });
                                    })()}
                                    {filteredIssues.length === 0 && <div style={{ padding: 16, color: "#888", fontSize: 13 }}>No {validationFilter !== "All" ? validationFilter.toLowerCase() + " " : ""}issues found.</div>}
                                </>
                            )}
                        </div>
                    )}

                    {leftTab === "config" && (
                        <div style={S.scroll}>
                            <div style={S.section}>
                                {profiles.map((p, i) => (
                                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5, padding: "4px 8px", background: "#f6f8fa", borderRadius: 4 }}>
                                        <span style={{ fontSize: 12, flex: 1 }}>{p.name}</span>
                                        <span style={{ fontSize: 11, color: "#888" }}>{p.constraints.length} rules</span>
                                        <button style={S.btnSmall} onClick={() => moveProfile(i, -1)} disabled={i === 0}>up</button>
                                        <button style={S.btnSmall} onClick={() => moveProfile(i, 1)} disabled={i === profiles.length - 1}>dn</button>
                                        <button style={S.btnDanger} onClick={() => setProfiles(prev => prev.filter((_, j) => j !== i))}>x</button>
                                    </div>
                                ))}
                            </div>
                            <div style={S.section}>
                                <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>Severity Configuration</div>
                                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                                    <button style={S.btnSmall} onClick={exportSeverityConfig}>Export JSON</button>
                                    <label style={{ ...S.btnSmall, cursor: "pointer" }}>Import JSON<input type="file" accept=".json" style={{ display: "none" }} onChange={importSeverityConfig} /></label>
                                </div>
                                <SeverityEditor issues={validationIssues} severityConfig={severityConfig} onUpdate={updateSeverity} />
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* CENTER PANEL */}
            <div style={{ position: "relative", overflow: "hidden", background: "#f8fafc", display: "flex", flexDirection: "column" }}>
                <div style={{ ...S.toolbar, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                        <button style={S.btn} onClick={() => { if (!parsed) return; const b = boundsFromElements(parsed.graphics); setFullBounds(b); setViewBox({ x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY }); }} title="Fit drawing to window">Fit</button>
                        {sentToBackIds.size > 0 && (
                            <button style={{ ...S.btn, background: "#eaf2ff", borderColor: "#0969da", color: "#0969da" }} onClick={() => setSentToBackIds(new Set())} title={`Restore normal draw order for ${sentToBackIds.size} object(s) sent to back`}>
                                Reset Z-Order ({sentToBackIds.size})
                            </button>
                        )}
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a" }} title="Connector/centerline stroke width as a percentage of its original width. 100% = unchanged; raise it to bulk up thin lines to match a BG reference image's line weight.">
                            Line Boost
                            <input type="number" min={1} step={1} value={lineBoostPct} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v) && v > 0) setLineBoostPct(v); }} style={S.numBox} title="Line width, as a percentage of its original width" />
                            %
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="When checked, symbol outline strokes are boosted by the same Line Boost percentage as connector/centerlines. When unchecked, only connector/centerlines are affected.">
                            <input type="checkbox" checked={boostSymbolOutlines} onChange={e => setBoostSymbolOutlines(e.target.checked)} />
                            Include symbol outlines
                        </label>
                        <button style={S.btn} disabled={!parsed || exporting} onClick={exportAsPng} title="Save the current view (drawing + BG image, if any) as a PNG">{exporting ? "..." : "Save PNG"}</button>
                        <button style={S.btn} disabled={!parsed || exporting} onClick={exportAsPdf} title="Save the current view (drawing + BG image, if any) as a PDF">{exporting ? "..." : "Save PDF"}</button>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="Connectivity mode: highlights the upstream (blue), downstream (green), and group (purple) connections of the selected object. Hidden by default - check this box to show the highlight.">
                            <input type="checkbox" checked={showConnectivity} onChange={e => setShowConnectivity(e.target.checked)} />
                            Connectivity
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="When checked, selecting an object also highlights (red) all of its sub-components in the drawing. When unchecked, only the selected object itself is highlighted.">
                            <input type="checkbox" checked={selectHighlightSubComponents} onChange={e => setSelectHighlightSubComponents(e.target.checked)} />
                            Sub-components
                        </label>
                        {discXmlText && (
                            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a", cursor: "pointer" }} title="When checked, labels on symbols placed from the loaded DiscProfile.xml show only the value of their referenced Attribute - from the instance's own AttributeRepresentation Template if it has one, otherwise the DiscProfile symbol's own LabelTemplate - instead of the instance's literal Text string.">
                                <input type="checkbox" checked={showProfileLabels} onChange={e => setShowProfileLabels(e.target.checked)} />
                                Profile labels
                            </label>
                        )}
                        <button style={S.btn} onClick={() => bgInputRef.current?.click()} title="Overlay an image behind the drawing">BG Image</button>
                        {bgImage && <button style={{ ...S.btn, background: showBgControls ? "#eaf2ff" : "white" }} onClick={() => setShowBgControls(p => !p)}>BG Controls</button>}
                        <input ref={bgInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleBgFile} />
                        <span style={{ fontSize: 11, color: "#888", marginLeft: 4 }}>Scroll to zoom · Space+drag to pan</span>
                    </div>
                </div>

                {bgImage && showBgControls && (
                    <div style={{ padding: "6px 12px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <input type="checkbox" checked={bgImage.visible} onChange={e => setBgImage(b => ({ ...b, visible: e.target.checked }))} /> Visible
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }} title="Centered: BG image and DEXPI drawing both fully visible. Drag right to fade out the BG image; drag left to fade out the DEXPI drawing.">
                            Blend
                            <input type="range" min={-1} max={1} step={0.05} value={bgImage.opacity} onChange={e => setBgImage(b => ({ ...b, opacity: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            Scale
                            <input type="range" min={0.1} max={3} step={0.05} value={bgImage.scale} onChange={e => setBgImage(b => ({ ...b, scale: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" min={0.01} max={20} step={0.01} value={bgImage.scale} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v) && v > 0) setBgImage(b => ({ ...b, scale: v })); }} style={S.numBox} title="Scale factor" />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            X
                            <input type="range" min={-boundsW} max={boundsW} step={Math.max(0.01, boundsW / 500)} value={bgImage.offsetX} onChange={e => setBgImage(b => ({ ...b, offsetX: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" step={Math.max(0.01, boundsW / 500)} value={bgImage.offsetX} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setBgImage(b => ({ ...b, offsetX: v })); }} style={S.numBoxWide} title="X offset, in drawing units, from the auto-fit position" />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            Y
                            <input type="range" min={-boundsH} max={boundsH} step={Math.max(0.01, boundsH / 500)} value={bgImage.offsetY} onChange={e => setBgImage(b => ({ ...b, offsetY: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" step={Math.max(0.01, boundsH / 500)} value={bgImage.offsetY} onChange={e => { const v = parseFloat(e.target.value); if (!Number.isNaN(v)) setBgImage(b => ({ ...b, offsetY: v })); }} style={S.numBoxWide} title="Y offset, in drawing units, from the auto-fit position" />
                        </label>
                        <button style={S.btnSmall} onClick={() => setBgImage(b => ({ ...b, scale: 1, offsetX: 0, offsetY: 0 }))} title="Reset to the auto-fit (centered, aspect-correct) placement">Reset fit</button>
                        {/* Embed this PNG's current placement into a downloaded copy so a
                            future load of it starts pre-aligned - see
                            downloadBgPlacementPng()/clearBgDefault() above. Only PNG files
                            support an embedded default (the chunk format is PNG-specific);
                            other image types leave this disabled. */}
                        <button
                            style={{ ...S.btnSmall, borderColor: "#0969da", color: "#0969da" }}
                            disabled={!bgImage.isPng}
                            onClick={downloadBgPlacementPng}
                            title={bgImage.isPng
                                ? "Embed the current Scale / X / Y into a copy of this PNG and download it, so the next time this image is loaded it starts at this placement instead of the auto-fit - the original file you selected is left untouched"
                                : "Only PNG images support an embedded placement default - this file isn't a PNG"}
                        >
                            ⬇ Download PNG with placement
                        </button>
                        {bgImage.isPng && bgImage.embeddedPlacement && (
                            <button style={S.btnSmall} onClick={clearBgDefault} title="Download a copy of this PNG with the saved placement default removed">
                                Clear Default
                            </button>
                        )}
                        <button style={{ ...S.btnSmall, color: "#cf222e" }} onClick={() => { if (bgObjectUrlRef.current) { URL.revokeObjectURL(bgObjectUrlRef.current); bgObjectUrlRef.current = null; } setBgImage(null); setShowBgControls(false); }}>Remove</button>
                    </div>
                )}

                {parseError && <div style={{ color: "#cf222e", padding: "8px 12px", fontSize: 13 }}>{parseError}</div>}

                <div ref={svgViewportRef} style={{ flex: 1, position: "relative", background: "white", cursor: isPanning ? "grabbing" : spaceDown ? "grab" : "default", overflow: "hidden" }}
                    onMouseDown={e => { if (e.button !== 0 || !spaceDown) return; e.preventDefault(); setIsPanning(true); setPanStart({ x: e.clientX, y: e.clientY, view: viewBox }); }}
                    onMouseMove={e => {
                        if (!isPanning || !panStart || !svgViewportRef.current) return;
                        const rect = svgViewportRef.current.getBoundingClientRect();
                        const dx = ((e.clientX - panStart.x) / rect.width) * panStart.view.w;
                        const dy = ((e.clientY - panStart.y) / rect.height) * panStart.view.h;
                        setViewBox(clampViewBox({ ...panStart.view, x: panStart.view.x - dx, y: panStart.view.y - dy }, fullBounds));
                    }}
                    onMouseUp={() => { setIsPanning(false); setPanStart(null); }}
                    onMouseLeave={() => { setIsPanning(false); setPanStart(null); }}
                >
                    <svg ref={svgElRef} viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`} width="100%" height="100%" style={{ display: "block" }} onAuxClick={e => e.preventDefault()}>
                        {bgImage && bgPlacement && (
                            <g style={{ display: bgImage.visible ? "inline" : "none", opacity: bgImage.opacity > 0 ? Math.max(0, 1 - bgImage.opacity) : 1, pointerEvents: "none" }}>
                                <image href={bgImage.src} x={bgPlacement.x} y={bgPlacement.y} width={bgPlacement.width} height={bgPlacement.height} preserveAspectRatio="none" />
                                <rect x={bgPlacement.x} y={bgPlacement.y} width={bgPlacement.width} height={bgPlacement.height} fill={BG_TINT_COLOR} style={{ mixBlendMode: "color" }} />
                            </g>
                        )}
                        <g style={{ opacity: bgImage && bgImage.opacity < 0 ? Math.max(0, 1 + bgImage.opacity) : 1 }}>
                            {orderedGraphicsElements.map(el => {
                                const isSelected = !!el.representedId && selectedRepresentedIds.has(el.representedId);
                                const ch = connectivityHighlight;
                                const connColor = el.representedId ? (ch.upstream.has(el.representedId) ? "#0969da" : ch.downstream.has(el.representedId) ? "#1a7f37" : ch.group.has(el.representedId) ? "#8250df" : null) : null;
                                if (el.kind === "symbolUsage") return <SymbolGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} boostPct={lineBoostPct} boostSymbolOutlines={boostSymbolOutlines} showProfileLabels={showProfileLabels} />;
                                return <PrimitiveGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} nodePosMap={parsed.graphics.nodePosMap} boostPct={lineBoostPct} boostSymbolOutlines={boostSymbolOutlines} showProfileLabels={showProfileLabels} />;
                            })}
                        </g>
                        {/* Heat-trace overlays – rendered on top, only when a DISC profile is loaded */}
                        {parsed?.heatTraceSet?.size > 0 && parsed.graphics.elements.map(el => {
                            // Never draw heat-trace overlays on label or annotation elements
                            if (el.elementRole === "label") return null;
                            const htType = el.representedId ? parsed.heatTraceSet.get(el.representedId) : null;
                            if (!htType) return null;
                            if (htType === "piping" && el.kind === "connectorLine")
                                return <HeatTraceConnectorLine key={`ht_${el.key}`} el={el} nodePosMap={parsed.graphics.nodePosMap} />;
                            if ((htType === "inline" || htType === "nozzle") && el.kind === "symbolUsage")
                                return <HeatTraceSymbol key={`ht_${el.key}`} el={el} />;
                            if (htType === "pif" && el.kind === "symbolUsage")
                                return <HeatTracePIF key={`ht_${el.key}`} el={el} />;
                            return null;
                        })}
                    </svg>
                    {showConnectivity && selectedId && (
                        <div style={{ position: "absolute", bottom: 10, left: 10, background: "rgba(255,255,255,0.9)", padding: "5px 10px", borderRadius: 6, border: "1px solid #d0d7de", fontSize: 11, display: "flex", gap: 8 }}>
                            <span style={{ color: "#d1242f" }}>o Selected</span>
                            <span style={{ color: "#0969da" }}>o Upstream</span>
                            <span style={{ color: "#1a7f37" }}>o Downstream</span>
                            <span style={{ color: "#8250df" }}>o Group</span>
                        </div>
                    )}
                </div>
            </div>

            {/* RIGHT PANEL */}
            {rightCollapsed ? (
                <div style={S.rCollapsed}><button style={S.collapseBtn} onClick={() => setRightCollapsed(false)}>{"<"}</button></div>
            ) : (
                <div style={S.rPanel}>
                    <div style={S.toolbar}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ fontWeight: 700 }}>Details</div>
                            <button style={S.collapseBtn} onClick={() => setRightCollapsed(true)}>{">"}</button>
                        </div>
                    </div>
                    <div style={S.tabBar}>
                        {[["details", "Object"], ["connectivity", "Connections"], ["issues", `Issues${selectedId && issueMap.has(selectedId) ? ` (${issueMap.get(selectedId).length})` : ""}`]].map(([t, label]) => (
                            <button key={t} style={S.tab(rightTab === t)} onClick={() => setRightTab(t)}>{label}</button>
                        ))}
                    </div>
                    <div style={S.scroll}>
                        {rightTab === "details" && (
                            <>
                                <div style={S.section}>
                                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{selectedNode?.label || "No selection"}</div>
                                    <div style={{ fontSize: 12, color: "#57606a" }}>{selectedNode?.type || ""}</div>
                                    {selectedNode?.objectId && <div style={{ marginTop: 6, fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>{selectedNode.objectId}</div>}
                                    {(selectedSymbolUsages.length > 0 || selectedLabelSymbolUsages.length > 0) && (
                                        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                                            <button
                                                style={{ ...S.btnSmall, background: sentToBackIds.has(selectedId) ? "#eaf2ff" : "white", borderColor: sentToBackIds.has(selectedId) ? "#0969da" : "#c7ced6", color: sentToBackIds.has(selectedId) ? "#0969da" : "#111" }}
                                                title="Move this object's symbol behind everything else in the drawing, so overlapping or nested items underneath it become clickable/selectable"
                                                onClick={() => toggleSendToBack(selectedId)}
                                            >
                                                {sentToBackIds.has(selectedId) ? "↺ Restore order" : "⇩ Send to Back"}
                                            </button>
                                            {sentToBackIds.has(selectedId) && <span style={{ fontSize: 11, color: "#0969da" }}>Sent to back</span>}
                                        </div>
                                    )}
                                    {selectedNode?.persistentIdentifiers?.length > 0 && (
                                        <div style={{ marginTop: 10 }}>
                                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>Persistent Identifiers</div>
                                            {selectedNode.persistentIdentifiers.map((pid, i) => (
                                                <div key={i} style={{ fontSize: 12, marginBottom: 5 }}>
                                                    <div style={{ color: "#888", fontSize: 11 }}>{pid.context || "No context"}</div>
                                                    <div style={{ wordBreak: "break-all" }}>{pid.value}</div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div style={S.section}>
                                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Data</div>
                                    {selectedNode?.data?.length ? selectedNode.data.map((d, i) => {
                                        const fmt = formatDataValue(d.value);
                                        const shortProp = d.property.split(".").pop() || d.property;
                                        return (
                                            <div key={`${d.property}_${i}`} style={{ marginBottom: 6, padding: "4px 6px", background: "#f9fafb", borderRadius: 4 }}>
                                                <div style={{ fontSize: 11, color: "#888", marginBottom: 1 }} title={d.property}>{shortProp}</div>
                                                <div style={{ fontSize: 13, display: "flex", alignItems: "baseline", gap: 5 }}>
                                                    <span style={{ fontWeight: 500 }}>{fmt.text}</span>
                                                    {fmt.uom && (
                                                        <span style={{ fontSize: 11, color: "#0969da", fontWeight: 600, padding: "0 4px", background: "#ddf4ff", borderRadius: 3 }} title={fmt.unitRef || fmt.uom}>
                                                            {fmt.uom}
                                                        </span>
                                                    )}
                                                    {fmt.fullRef && !fmt.uom && (
                                                        <span style={{ fontSize: 11, color: "#888" }} title={fmt.fullRef}>{fmt.text !== fmt.fullRef ? "" : ""}</span>
                                                    )}
                                                </div>
                                                {d.property !== shortProp && (
                                                    <div style={{ fontSize: 10, color: "#aaa", marginTop: 1 }}>{d.property}</div>
                                                )}
                                            </div>
                                        );
                                    }) : <div style={{ color: "#888", fontSize: 12 }}>No data.</div>}
                                </div>
                                <div style={S.section}>
                                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>References</div>
                                    {selectedNode?.refs?.length ? selectedNode.refs.map((r, i) => (
                                        <div key={i} style={{ marginBottom: 5 }}>
                                            <div style={{ fontSize: 11, color: "#888" }}>{r.property}</div>
                                            <div style={{ fontSize: 12 }}>
                                                {r.objects.map((oid, j) => (
                                                    <span key={j} style={{ cursor: parsed?.treeMap?.has(oid) ? "pointer" : "default", color: parsed?.treeMap?.has(oid) ? "#0969da" : "#cf222e", marginRight: 5 }} onClick={() => parsed?.treeMap?.has(oid) && handleSelect(oid)}>{oid}</span>
                                                ))}
                                            </div>
                                        </div>
                                    )) : <div style={{ color: "#888", fontSize: 12 }}>No references.</div>}
                                </div>
                                {(() => {
                                    if (!selectedNode?.objectId || !parsed?.flatTree) return null;
                                    const referencedBy = [];
                                    parsed.flatTree.forEach(node => {
                                        if (node.objectId === selectedNode.objectId) return;
                                        node.refs.forEach(r => {
                                            if (r.objects.includes(selectedNode.objectId)) {
                                                referencedBy.push({ node, property: r.property });
                                            }
                                        });
                                    });
                                    return (
                                        <div style={S.section}>
                                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Referenced By</div>
                                            {referencedBy.length ? referencedBy.map((entry, i) => (
                                                <div key={i} style={{ marginBottom: 5 }}>
                                                    <div style={{ fontSize: 11, color: "#888" }}>{entry.property}</div>
                                                    <div style={{ fontSize: 12, display: "flex", alignItems: "baseline", gap: 5 }}>
                                                        <span
                                                            style={{ cursor: "pointer", color: "#0969da" }}
                                                            onClick={() => handleSelect(entry.node.objectId)}
                                                        >
                                                            {entry.node.label || entry.node.objectId}
                                                        </span>
                                                        <span style={{ fontSize: 10, color: "#aaa" }}>
                                                            {entry.node.type.split(".").pop()}
                                                        </span>
                                                    </div>
                                                </div>
                                            )) : <div style={{ color: "#888", fontSize: 12 }}>Not referenced by any object.</div>}
                                        </div>
                                    );
                                })()}
                                {(() => {
                                    if (!selectedNode?.objectId || !parsed?.flatTree) return null;
                                    const parent = parsed.flatTree.find(n =>
                                        n.objectId && n.objectId !== selectedNode.objectId &&
                                        n.children.some(c => c.objectId === selectedNode.objectId)
                                    ) || null;
                                    if (!parent) return null;
                                    const typeSuffix = parent.type.split(".").pop();
                                    const parentIssues = parent.objectId ? (issueMap.get(parent.objectId) || []) : [];
                                    const hasErr  = parentIssues.some(x => x.severity === "Error");
                                    const hasWarn = !hasErr && parentIssues.some(x => x.severity === "Warning");
                                    return (
                                        <div style={S.section}>
                                            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Parent Component</div>
                                            <div
                                                onClick={() => handleSelect(parent.objectId)}
                                                style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 6px", background: "#f9fafb", borderRadius: 4, cursor: "pointer", border: "1px solid #eef2f6" }}
                                            >
                                                {hasErr  && <span title="Has errors"   style={{ color: "#cf222e", fontSize: 10, flexShrink: 0 }}>●</span>}
                                                {hasWarn && <span title="Has warnings" style={{ color: "#9a6700", fontSize: 10, flexShrink: 0 }}>●</span>}
                                                <span style={{ fontSize: 12, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                    {parent.label || parent.objectId || typeSuffix}
                                                </span>
                                                <span style={{ fontSize: 10, color: "#aaa", flexShrink: 0 }}>{typeSuffix}</span>
                                            </div>
                                        </div>
                                    );
                                })()}
                                {selectedNode?.children?.length > 0 && (
                                    <div style={S.section}>
                                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
                                            Sub-Components ({selectedNode.children.length})
                                        </div>
                                        {selectedNode.children.map((child, i) => {
                                            const childIssues = child.objectId ? (issueMap.get(child.objectId) || []) : [];
                                            const hasErr = childIssues.some(x => x.severity === "Error");
                                            const hasWarn = !hasErr && childIssues.some(x => x.severity === "Warning");
                                            const typeSuffix = child.type.split(".").pop();
                                            return (
                                                <div key={i}
                                                    onClick={() => child.objectId && handleSelect(child.objectId)}
                                                    style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 6px", marginBottom: 3, background: "#f9fafb", borderRadius: 4, cursor: child.objectId ? "pointer" : "default", border: "1px solid #eef2f6" }}
                                                >
                                                    {hasErr && <span title="Has errors" style={{ color: "#cf222e", fontSize: 10, flexShrink: 0 }}>●</span>}
                                                    {hasWarn && <span title="Has warnings" style={{ color: "#9a6700", fontSize: 10, flexShrink: 0 }}>●</span>}
                                                    <span style={{ fontSize: 12, fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                        {child.label || child.objectId || typeSuffix}
                                                    </span>
                                                    <span style={{ fontSize: 10, color: "#aaa", flexShrink: 0 }}>{typeSuffix}</span>
                                                    {child.children.length > 0 && (
                                                        <span style={{ fontSize: 10, color: "#888", flexShrink: 0 }}>+{child.children.length}</span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                                {selectedSymbolUsages.length > 0 && (
                                    <div style={S.section}>
                                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Symbol Usage</div>
                                        {selectedSymbolUsages.map((su, i) => (
                                            <div key={i} style={{ marginBottom: 6, padding: "4px 6px", background: "#f9fafb", borderRadius: 4 }}>
                                                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>{su.symbol?.key?.split("/").pop() || su.symbol?.key || "(unknown symbol)"}</div>
                                                <div style={{ fontSize: 11, color: "#57606a", display: "flex", flexWrap: "wrap", gap: "2px 12px" }}>
                                                    <span>Scale X: {su.scaleX}</span>
                                                    <span>Scale Y: {su.scaleY}</span>
                                                    <span>Is Mirrored: {su.isMirrored ? "true" : "false"}</span>
                                                    <span>Rotation: {su.rotation}°</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {selectedLabelSymbolUsages.length > 0 && (
                                    <div style={S.section}>
                                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Label SymbolUsage</div>
                                        {selectedLabelSymbolUsages.map((su, i) => (
                                            <div key={i} style={{ marginBottom: 6, padding: "4px 6px", background: "#f9fafb", borderRadius: 4 }}>
                                                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 3 }}>{su.symbol?.key?.split("/").pop() || su.symbol?.key || "(unknown symbol)"}</div>
                                                <div style={{ fontSize: 11, color: "#57606a", display: "flex", flexWrap: "wrap", gap: "2px 12px" }}>
                                                    <span>Scale X: {su.scaleX}</span>
                                                    <span>Scale Y: {su.scaleY}</span>
                                                    <span>Is Mirrored: {su.isMirrored ? "true" : "false"}</span>
                                                    <span>Rotation: {su.rotation}°</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                        {rightTab === "connectivity" && (
                            <div style={S.section}>
                                {!selectedNode ? <div style={{ color: "#888", fontSize: 12 }}>Select an object.</div> : (() => {
                                    const conn = parsed?.connectivityMap?.get(selectedId) || { upstream: new Set(), downstream: new Set(), group: new Set() };
                                    const makeList = (ids, color, label, bgTint) => (
                                        <div style={{ marginBottom: 12 }}>
                                            <div style={{ fontWeight: 600, fontSize: 12, color, marginBottom: 4 }}>{label} ({ids.size})</div>
                                            {ids.size === 0 ? <div style={{ fontSize: 12, color: "#888" }}>None</div> : [...ids].map(id => {
                                                const n = parsed?.treeMap?.get(id);
                                                const nType = n?.type || "";
                                                const isFlowIn  = nType.includes("FlowIn");
                                                const isFlowOut = nType.includes("FlowOut");
                                                const typeColor = isFlowIn ? "#0969da" : isFlowOut ? "#1a7f37" : null;
                                                const typeBg    = isFlowIn ? "#dbeafe" : isFlowOut ? "#dcfce7" : bgTint;
                                                const suffix = nType.split(".").pop();
                                                return (
                                                    <div key={id}
                                                        style={{ fontSize: 12, padding: "3px 6px", cursor: "pointer", borderRadius: 3, marginBottom: 2, background: typeBg, border: `1px solid ${typeColor || "#e1e4e8"}`, display: "flex", alignItems: "center", gap: 5 }}
                                                        onClick={() => handleSelect(id)}
                                                    >
                                                        {typeColor && <span style={{ width: 8, height: 8, borderRadius: "50%", background: typeColor, flexShrink: 0 }} />}
                                                        <span style={{ flex: 1 }}>{n?.label || id}</span>
                                                        {typeColor && <span style={{ fontSize: 10, color: typeColor, fontWeight: 600 }}>{suffix}</span>}
                                                        <span style={{ fontSize: 10, color: "#888" }}>({id})</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    );
                                    return (
                                        <div>
                                            {makeList(conn.upstream,   "#0969da", "Upstream",   "#f0f7ff")}
                                            {makeList(conn.downstream, "#1a7f37", "Downstream", "#f0fff4")}
                                            {makeList(conn.group,      "#8250df", "Group",      "#fbf0ff")}
                                        </div>
                                    );
                                })()}
                            </div>
                        )}
                        {rightTab === "issues" && (
                            <div style={S.scroll}>
                                {!selectedNode ? <div style={{ padding: 12, color: "#888", fontSize: 12 }}>Select an object.</div> : (() => {
                                    const nodeIssues = selectedId ? (issueMap.get(selectedId) || []) : [];
                                    if (!validationDone) return <div style={{ padding: 12, color: "#888", fontSize: 12 }}>Run validation first.</div>;
                                    if (nodeIssues.length === 0) return <div style={{ padding: 12, color: "#888", fontSize: 12 }}>No issues for this object.</div>;
                                    return nodeIssues.map((issue, i) => (
                                        <div key={i} style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6" }}>
                                            <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 3 }}>
                                                <span style={{ ...S.badge(S.sevColor[issue.severity]) }}>{issue.severity}</span>
                                                <span style={{ fontSize: 11, fontFamily: "monospace", color: "#555" }}>{issue.ruleId}</span>
                                            </div>
                                            <div style={{ fontSize: 12, color: "#333", marginBottom: 2 }}>{issue.description}</div>
                                            {issue.suggestedCorrection && <div style={{ fontSize: 11, color: "#0969da", marginTop: 2 }}>Suggestion: {issue.suggestedCorrection}</div>}
                                        </div>
                                    ));
                                })()}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
