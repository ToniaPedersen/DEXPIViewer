import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseProfileConstraints, runFullValidation, downloadCSV, resolveSeverity } from "./validation.js";
import {
    parseDexpiPackage, boundsFromElements, clampViewBox,
    findAncestors, collectDescendantObjectIds, flattenTree,
    parseColor, collectModelValidIds, isConnectivityRefProperty,
} from "./dexpiParser.js";
import { jsPDF } from "jspdf";
import { version as APP_VERSION } from "../package.json";
import { buildXlsxBlob } from "./xlsxBlob.js";
import { collectFolderElements } from "./elementUsage.js";
import { buildCompareGeometry, placementToBgParams, IMG_CODES, DEFAULT_COMPARE_OPTIONS } from "./imageCompare.js";
import { pickXmlFiles, pickPngFiles, supportsDirectoryPicker, pickDirectory, pickDirectoryForWrite, relPathOf, pngPathFor, writeFileAt, validateFiles, folderResultsCsv } from "./folderValidate.js";

// DiscProfile.xml loaded automatically at startup (public repo). A profile
// picked by hand replaces it; "x" unloads it as before.
const DEFAULT_PROFILE_URL = "https://raw.githubusercontent.com/ToniaPedersen/DISCDEXPI_2026Pack/main/Profile/xml/DiscProfile.xml";
const DEFAULT_PROFILE_NAME = "DiscProfile.xml (DISCDEXPI_2026Pack)";

// ---------- Hide elements with issues (persisted in localStorage) ----------
// Mode: "All" | "AllErrors" | "None" | "Custom". The preset name is stored,
// not the expanded code list, so All / All Errors pick up new codes
// automatically. "codes" is only used by Custom.
const HIDE_ISSUES_KEY = "dexpiViewer.hideIssues";
// Image compare (PNG vs DEXPI) UI: the Compare button / Compare layer
// checkbox in BG Controls and the Compare tabs. Auto-fit and Save placement
// stay available either way. Set to true to bring the compare back.
const SHOW_IMAGE_COMPARE = true;
// Default code set for the Custom mode (fill in, e.g. ["VAX-003", "ERR-E02"]).
const DEFAULT_CUSTOM_HIDE_CODES = [];
const HIDE_ISSUES_DEFAULT = { enabled: false, mode: "AllErrors", codes: DEFAULT_CUSTOM_HIDE_CODES };

function loadHideIssues() {
    try {
        const v = JSON.parse(localStorage.getItem(HIDE_ISSUES_KEY));
        if (v && typeof v === "object") {
            return {
                enabled: !!v.enabled,
                mode: ["All", "AllErrors", "None", "Custom"].includes(v.mode) ? v.mode : HIDE_ISSUES_DEFAULT.mode,
                codes: Array.isArray(v.codes) ? v.codes.filter(c => typeof c === "string") : DEFAULT_CUSTOM_HIDE_CODES,
            };
        }
    } catch { /* storage unavailable or corrupt - fall back to defaults */ }
    return { ...HIDE_ISSUES_DEFAULT };
}

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
// used as the first step of writing a
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
function formatDataValue(value, enumAbbreviations = null) {
    if (value === null || value === undefined) return { text: "—", uom: null };

    // Physical quantity: { kind:"PhysicalQuantity", value, unit, unitRef }
    if (value && typeof value === "object" && value.kind === "PhysicalQuantity") {
        const num = value.value !== null && value.value !== undefined ? String(value.value) : "—";
        return { text: num, uom: value.unit || null, unitRef: value.unitRef || null };
    }

    // DataReference (enumeration): { kind:"DataReference", value:"..." }
    if (value && typeof value === "object" && value.kind === "DataReference") {
        const short = value.value.split(".").pop().split("/").pop();
        // Profile enumeration literal with an Abbreviation (e.g. ProcessShutdown -> PSD): show the abbreviation, literal name alongside.
        const abbr = enumAbbreviations?.get(value.value);
        if (abbr) return { text: abbr, uom: null, fullRef: value.value, literal: short };
        return { text: short, uom: null, fullRef: value.value };
    }

    // Generic aggregated value fallback: { kind:"AggregatedValue", type, entries }
    if (value && typeof value === "object" && value.kind === "AggregatedValue") {
        const parts = Object.entries(value.entries || {})
            .map(([k, v]) => `${k}: ${formatDataValue(v, enumAbbreviations).text}`).join(", ");
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
        // A component's label (primitive.isComponentLabel, see dexpiParser.js)
        // never shows the file's literal Text string - only the values of the
        // attributes it references on the related object (primitive.
        // componentText). With "Profile labels" checked, a catalogued
        // DiscProfile symbol's label still defers to the symbol's own
        // LabelTemplate overlay instead. Labels that belong to no component
        // keep the behaviour below.
        const displayText = primitive.isComponentLabel
            ? ((showProfileLabels && primitive.isDiscProfileLabel) ? "" : (primitive.componentText ?? ""))
            : showProfileLabels
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
const HT_PIF_OFF = 1.0;        // offset distance (1mm) outside a PIF symbol's own outline
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
 * Heat trace dashed rectangle drawn 1mm outside a PIF symbol bounding box,
 * in local symbol coordinates so it rotates with the symbol.
 */
/**
 * Heat trace overlay for ProcessInstrumentationFunction.
 * Traces the actual outer boundary primitives of the symbol (circle, ellipse,
 * polygon) expanded 1mm outward, so it follows the real symbol shape rather
 * than a bounding-box rectangle.  Internal detail polylines are skipped.
 * Falls back to a bounding-box rect when no boundary primitive is found.
 */
function HeatTracePIF({ el }) {
    const mirror = el.isMirrored ? -1 : 1;
    const transform = `translate(${el.position.x} ${el.position.y}) rotate(${el.rotation}) scale(${el.scaleX * mirror} ${el.scaleY})`;
    const pad = HT_PIF_OFF; // 1mm outside the symbol's outline

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
        // Fallback: simple rect 1mm outside bounding box
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
// Where a profile LabelTemplate is drawn on a placed symbol.
//
// The template defines the label for the symbol at rotation 0, not mirrored.
// On the drawing the text is always kept readable (left to right at 0/180,
// bottom to top at 90/270), so a symbol turned over by its rotation cannot
// simply carry its label with it. DISC DEXPI rule 'B' (requirements document
// ANNEX B: Profile Label Text under Rotation and Mirroring), for EVERY symbol:
//   * the template's y offset (above / below) follows the symbol's full
//     rotation - a label above the symbol at 0 is below its origin at 180,
//     still on the symbol body;
//   * the template's x offset (left / right) follows the readable text
//     direction: it is mirrored with the symbol, and flipped whenever the text
//     had to be turned over (90/180) to stay readable - a label left of the
//     symbol at 0 is still left of it at 180 and below it at 90.
// Left/Right and Top/Bottom are then chosen so the text extends from its
// anchor in the same direction, relative to the symbol, as the template
// intends (it grows away from the symbol, never across it): Left/Right swap
// for a mirrored symbol, Top/Bottom swap when the text is turned over.
function readableAngle(a) {
    a = ((a % 360) + 360) % 360;
    if (a >= 90 && a < 270) return a - 180;   // [-90, 90)
    return a >= 270 ? a - 360 : a;
}
function labelOverlayPlacement(ov, el) {
    const deg = Math.PI / 180;
    const R = el.rotation || 0;
    const Reff = readableAngle(R);
    const turnedOver = Math.abs((((Reff - R) % 360) + 360) % 360 - 180) < 0.01;
    // rule 'B': x offset follows the readable text direction, y offset follows the symbol
    const rx = turnedOver ? -1 : 1;
    const ry = 1;
    const sx = Math.sign((el.scaleX || 1) * (el.isMirrored ? -1 : 1)) || 1;
    const sy = Math.sign(el.scaleY || 1) || 1;
    const rot = (x, y, a) => [x * Math.cos(a * deg) - y * Math.sin(a * deg), x * Math.sin(a * deg) + y * Math.cos(a * deg)];
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
    // world direction of a direction given in the template's frame
    const L = ([x, y]) => rot(x * sx * rx, y * sy * ry, R);
    const t = ov.rotation || 0;
    const readable = readableTextOrientation(Reff, t, "start", "hanging");
    const worldAngle = Reff + readable.rotation;
    const D = rot(1, 0, worldAngle), Dn = rot(0, 1, worldAngle);   // text reading / text down directions
    const ex = L(rot(1, 0, t)), ey = L(rot(0, 1, t));              // template text x / down directions
    const align = ov.alignment || "CenterCenter";
    let anchor = "middle", baseline = "middle";
    if (align.startsWith("Left")) anchor = dot(ex, D) > 0 ? "start" : "end";
    else if (align.startsWith("Right")) anchor = dot(ex, D) > 0 ? "end" : "start";
    if (align.endsWith("Top")) baseline = dot(ey, Dn) > 0 ? "hanging" : "baseline";
    else if (align.endsWith("Bottom")) baseline = dot(ey, Dn) > 0 ? "baseline" : "hanging";
    return { x: rx * ov.position.x, y: ry * ov.position.y, rotation: worldAngle - R, anchor, baseline };
}

function renderLabelOverlay(ov, key, el) {
    const { x, y, rotation, anchor, baseline } = labelOverlayPlacement(ov, el);
    const mirror = el.isMirrored ? -1 : 1;
    return renderMultilineText({
        key, x, y, rotation,
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
    // Folder tab (ported from AKSODEXPIViewer): validation results for every
    // .xml in a picked folder, plus the Save PNG run. Null until a run ends.
    const [folderResults, setFolderResults] = useState(null);
    const [folderProgress, setFolderProgress] = useState(null); // { done, total, name }
    const [folderFilter, setFolderFilter] = useState("All");
    const [folderName, setFolderName] = useState("");
    const [collapsedFolderFiles, setCollapsedFolderFiles] = useState(new Set());
    const [pngProgress, setPngProgress] = useState(null);
    const [elemProgress, setElemProgress] = useState(null);
    const [pngResult, setPngResult] = useState(null);
    // True while Save PNG renders each file through the drawing view - hides the BG image so it isn't baked in.
    const [batchPng, setBatchPng] = useState(false);
    // Startup fetch of DEFAULT_PROFILE_URL: "loading" | "loaded" | "error".
    const [defaultProfileState, setDefaultProfileState] = useState("loading");
    const [profiles, setProfiles] = useState([]);
    const [validationIssues, setValidationIssues] = useState([]);
    const [validationDone, setValidationDone] = useState(false);
    const [validationFilter, setValidationFilter] = useState("All");
    const [collapsedCodeGroups, setCollapsedCodeGroups] = useState(new Set());
    const [severityConfig] = useState({});
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
    // Hide elements with issues: checkbox + code-set mode, persisted per browser.
    const [hideIssues, setHideIssues] = useState(loadHideIssues);
    const [showHideCodes, setShowHideCodes] = useState(false);
    useEffect(() => {
        try { localStorage.setItem(HIDE_ISSUES_KEY, JSON.stringify(hideIssues)); } catch { /* ignore */ }
    }, [hideIssues]);
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
    // Image compare (PNG BG image vs. DEXPI drawing) - see runImageCompare().
    // cmp: last result { issues, stats, diffUrl, diffBlob, diffPlacement, placement, ranAt } or null.
    const [cmp, setCmp] = useState(null);
    // Running auto-fit / compare job: { kind: "fit" | "compare", phase, done, total } or null.
    const [cmpBusy, setCmpBusy] = useState(null);
    const [cmpView, setCmpView] = useState("markers"); // "off" | "markers" | "diff"
    const [cmpFilter, setCmpFilter] = useState("All");
    const [cmpShowReviewed, setCmpShowReviewed] = useState(false);
    const [cmpSelKey, setCmpSelKey] = useState(null);
    // Accept / Ignore / False positive decisions per issue key, saved per drawing file.
    const [cmpDecisions, setCmpDecisions] = useState({});
    const [cmpOpts, setCmpOpts] = useState({
        tolMm: DEFAULT_COMPARE_OPTIONS.tolMm, searchMm: DEFAULT_COMPARE_OPTIONS.searchMm,
        okScore: DEFAULT_COMPARE_OPTIONS.okScore, minRegionMm: DEFAULT_COMPARE_OPTIONS.minRegionMm,
    });
    const [fitStatus, setFitStatus] = useState(null); // { score } after an auto-fit
    const compareWorkerRef = useRef(null);
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

    // All rule codes present in the current validation run, with severity.
    const issueCodeList = useMemo(() => {
        const m = new Map();
        validationIssues.forEach(i => { if (i.ruleId && !m.has(i.ruleId)) m.set(i.ruleId, i.severity); });
        return [...m.entries()].map(([code, severity]) => ({ code, severity })).sort((a, b) => a.code.localeCompare(b.code));
    }, [validationIssues]);

    // Codes selected for hiding, resolved from the stored mode.
    const hiddenIssueCodes = useMemo(() => {
        switch (hideIssues.mode) {
            case "All": return new Set(issueCodeList.map(c => c.code));
            case "AllErrors": return new Set(issueCodeList.filter(c => c.severity === "Error").map(c => c.code));
            case "None": return new Set();
            default: return new Set(hideIssues.codes);
        }
    }, [hideIssues, issueCodeList]);

    // Object ids whose drawing elements are hidden. Issues on non-drawn
    // sub-objects hide their nearest drawn ancestor (visualContextId).
    const hiddenIssueIds = useMemo(() => {
        const ids = new Set();
        if (!hideIssues.enabled || hiddenIssueCodes.size === 0) return ids;
        validationIssues.forEach(issue => {
            if (!hiddenIssueCodes.has(issue.ruleId)) return;
            const id = issue.objectId;
            if (id && !id.startsWith("(")) {
                id.split(",").map(x => x.trim()).filter(x => x && !x.startsWith("(") && !x.endsWith("…")).forEach(x => ids.add(x));
            }
            if (issue.visualContextId) ids.add(issue.visualContextId);
        });
        return ids;
    }, [hideIssues.enabled, hiddenIssueCodes, validationIssues]);

    const toggleHideCode = (code) => setHideIssues(h => {
        const cur = new Set(h.mode === "Custom" ? h.codes : hiddenIssueCodes);
        if (cur.has(code)) cur.delete(code); else cur.add(code);
        return { ...h, mode: "Custom", codes: [...cur].sort() };
    });

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

    const baseNameOf = (name) => name.replace(/\.[^.]+$/, "").toLowerCase();

    // The DEXPI XML may be picked together with its .png: the one with the same
    // base name (or the only .png picked) becomes the BG image.
    async function handleMainFile(e, handleByFile = null) {
        const picked = [...(e.target.files || [])];
        e.target.value = "";
        const file = picked.find(f => /\.xml$/i.test(f.name)); if (!file) return;
        const pngs = picked.filter(f => /\.png$/i.test(f.name));
        const png = pngs.find(f => baseNameOf(f.name) === baseNameOf(file.name)) || (pngs.length === 1 ? pngs[0] : null);
        const txt = await file.text(); setMainXmlText(txt);
        // Strip extension for CSV filename
        setMainFileName(file.name.replace(/\.[^.]+$/, ""));
        setMainFileFullName(file.name);
        rebuild(txt, discXmlText);
        if (png) await loadBgFile(png, handleByFile?.get(png) || null);
        else removeBg();
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

    // ---------- Default DiscProfile.xml ----------
    // Latest values for async code (fetch / folder runs) that outlives the render it started in.
    const mainXmlRef = useRef(""); mainXmlRef.current = mainXmlText;
    const discXmlRef = useRef(""); discXmlRef.current = discXmlText;

    // Fetches the shared DiscProfile.xml. Runs once at startup and again from
    // the "Retry" button; a profile already loaded by hand is left alone.
    const loadDefaultProfile = useCallback(async () => {
        setDefaultProfileState("loading");
        try {
            const res = await fetch(DEFAULT_PROFILE_URL, { cache: "no-cache" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const txt = await res.text();
            if (discXmlRef.current) { setDefaultProfileState("loaded"); return; }
            setDiscXmlText(txt); setDiscFileFullName(DEFAULT_PROFILE_NAME);
            setDefaultProfileState("loaded");
            if (mainXmlRef.current) rebuild(mainXmlRef.current, txt);
        } catch (e) {
            console.warn("Default DiscProfile.xml could not be loaded:", e);
            setDefaultProfileState("error");
        }
    }, []);

    useEffect(() => { loadDefaultProfile(); }, [loadDefaultProfile]);

    // ---------- Folder tab (ported from AKSODEXPIViewer) ----------
    const folderInputRef = useRef(null);
    const folderPngInputRef = useRef(null);
    // Picked files kept by path, so a file can be reopened from its row without re-picking the folder.
    const folderFilesRef = useRef(new Map());
    const folderCancelRef = useRef(false);
    const pngCancelRef = useRef(false);
    const elemCancelRef = useRef(false);
    const folderElemInputRef = useRef(null);
    // .png files of the validated folder (lower-cased relative path -> File or FileSystemFileHandle), for the Open button's BG image.
    const folderPngsRef = useRef(new Map());

    const folderIssues = useMemo(() => {
        if (!folderResults) return [];
        const out = [];
        folderResults.forEach(r => r.issues.forEach((issue, i) => out.push({ ...issue, key: `${r.path}#${i}`, path: r.path })));
        return out;
    }, [folderResults]);

    const folderCounts = useMemo(() => {
        const c = { Error: 0, Warning: 0, Info: 0 };
        folderIssues.forEach(i => { c[i.severity] = (c[i.severity] || 0) + 1; });
        return c;
    }, [folderIssues]);

    // path -> issues, filtered by the Folder tab's type chips.
    const folderByFile = useMemo(() => {
        const map = new Map();
        folderIssues.forEach(i => {
            if (folderFilter !== "All" && i.severity !== folderFilter) return;
            if (!map.has(i.path)) map.set(i.path, []);
            map.get(i.path).push(i);
        });
        return map;
    }, [folderIssues, folderFilter]);

    const folderNameOf = (files) => {
        const first = files[0]?.webkitRelativePath || "";
        return first.includes("/") ? first.split("/")[0] : "";
    };

    // Directory picker where the browser has one, otherwise the folder input.
    async function handleFolderButton() {
        if (!supportsDirectoryPicker()) { folderInputRef.current?.click(); return; }
        let picked = null;
        try {
            picked = await pickDirectory();
        } catch (err) {
            console.error("Folder pick failed:", err);
            folderInputRef.current?.click();
            return;
        }
        if (!picked) return;
        runFolderValidation(picked.files, picked.name, picked.pngs);
    }
    function handleFolderPick(e) {
        const picked = pickXmlFiles(e.target.files);
        if (folderInputRef.current) folderInputRef.current.value = "";
        runFolderValidation(picked, folderNameOf(picked), pickPngFiles(e.target.files));
    }

    // Save PNG…: writes <name>.png next to each .xml when the browser can write to the folder, otherwise downloads each PNG.
    async function handleSavePngButton() {
        if (!supportsDirectoryPicker()) { folderPngInputRef.current?.click(); return; }
        let picked = null;
        try {
            picked = await pickDirectoryForWrite();
        } catch (err) {
            console.error("Folder pick failed:", err);
            folderPngInputRef.current?.click();
            return;
        }
        if (!picked) return;
        runFolderPng(picked.files, picked.name, picked.dirHandle);
    }
    function handleFolderPngPick(e) {
        const picked = pickXmlFiles(e.target.files);
        if (folderPngInputRef.current) folderPngInputRef.current.value = "";
        runFolderPng(picked, folderNameOf(picked), null);
    }

    const nextPaint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Renders each file through the drawing view, then restores the file that was open before.
    async function runFolderPng(files, name, dirHandle) {
        setLeftTab("folder");
        setPngResult(null);
        if (!files.length) { setPngResult({ folder: name, total: 0, saved: 0, failed: [], downloaded: !dirHandle }); return; }
        const prevText = mainXmlRef.current;
        const disc = discXmlRef.current;
        pngCancelRef.current = false;
        setBatchPng(true);
        const failed = [];
        let saved = 0;
        try {
            for (let i = 0; i < files.length; i++) {
                if (pngCancelRef.current) break;
                const file = files[i];
                const rel = relPathOf(file);
                setPngProgress({ done: i, total: files.length, name: rel });
                try {
                    const p = parseDexpiPackage(await file.text(), disc);
                    const b = boundsFromElements(p.graphics);
                    const vb = { x: b.minX, y: b.minY, w: Math.max(100, b.maxX - b.minX), h: Math.max(100, b.maxY - b.minY) };
                    setFullBounds(b);
                    setParsed(p);
                    setSelectedId(null);
                    setSentToBackIds(new Set());
                    setViewBox(vb);
                    const want = `${vb.x} ${vb.y} ${vb.w} ${vb.h}`;
                    for (let f = 0; f < 60; f++) {
                        await nextPaint();
                        if (svgElRef.current?.getAttribute("viewBox") === want) break;
                    }
                    const canvas = await renderViewboxToCanvas(vb);
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
                    if (!blob) throw new Error("PNG encoding failed.");
                    if (dirHandle) await writeFileAt(dirHandle, pngPathFor(rel), blob);
                    else downloadBlob(blob, pngPathFor(file.name));
                    saved++;
                } catch (err) {
                    failed.push({ path: rel, error: err.message || String(err) });
                }
            }
        } finally {
            setBatchPng(false);
            setPngProgress(null);
            if (prevText) rebuild(prevText, disc);
            else setParsed(null);
        }
        setPngResult({ folder: name, total: files.length, saved, failed, downloaded: !dirHandle, cancelled: pngCancelRef.current });
    }

    // Validates every .xml found, against the currently loaded profile.
    async function runFolderValidation(files, name, pngs) {
        setLeftTab("folder");
        setFolderName(name || "");
        folderPngsRef.current = pngs || new Map();
        if (!files.length) { setFolderResults([]); setFolderProgress(null); return; }
        const disc = discXmlRef.current;
        if (!disc) {
            const go = window.confirm(
                `No DiscProfile.xml is loaded.\n\n` +
                `${files.length} file${files.length === 1 ? "" : "s"} will be validated without a profile, so the profile-dependent checks will report nothing.\n\n` +
                `Validate anyway?`
            );
            if (!go) { setFolderProgress(null); return; }
        }
        folderFilesRef.current = new Map(files.map(f => [relPathOf(f), f]));
        folderCancelRef.current = false;
        setFolderResults(null);
        setFolderProgress({ done: 0, total: files.length, name: relPathOf(files[0]) });
        const results = await validateFiles(files, disc, {
            profiles, severityConfig,
            onProgress: setFolderProgress,
            isCancelled: () => folderCancelRef.current,
        });
        setFolderResults(results);
        setFolderProgress(null);
        setCollapsedFolderFiles(new Set(results.map(r => r.path)));
    }

    // Loads one of the folder's files into the viewer itself.
    async function openFolderFile(path) {
        const file = folderFilesRef.current.get(path);
        if (!file) return;
        const txt = await file.text();
        setMainXmlText(txt);
        setMainFileName(file.name.replace(/\.[^.]+$/, ""));
        setMainFileFullName(file.name);
        rebuild(txt, discXmlRef.current);
        // Carry this file's results from the folder run over to the Validation
        // tab (same issue objects as Run Validation produces), so they don't
        // have to be re-run after opening the drawing.
        const folderResult = folderResults?.find(r => r.path === path);
        if (folderResult && !folderResult.error) {
            setValidationIssues(folderResult.issues);
            setValidationDone(true);
            setLeftTab(folderResult.issues.length ? "validation" : "topology");
        } else {
            setLeftTab("topology");
        }
        // Same base name .png in the validated folder becomes the BG image; otherwise the previous one is dropped.
        const png = folderPngsRef.current.get(pngPathFor(path).toLowerCase());
        if (png) await loadBgFile(png.getFile ? await png.getFile() : png, png.getFile ? png : null);
        else removeBg();
    }

    // Export Element…: classes, attributes and symbols used per DEXPI 2.0 file, as an .xlsx download.
    async function handleExportElementButton() {
        if (!supportsDirectoryPicker()) { folderElemInputRef.current?.click(); return; }
        let picked = null;
        try {
            picked = await pickDirectory();
        } catch (err) {
            console.error("Folder pick failed:", err);
            folderElemInputRef.current?.click();
            return;
        }
        if (!picked) return;
        runExportElements(picked.files, picked.name);
    }
    function handleFolderElemPick(e) {
        const picked = pickXmlFiles(e.target.files);
        if (folderElemInputRef.current) folderElemInputRef.current.value = "";
        runExportElements(picked, folderNameOf(picked));
    }
    async function runExportElements(files, name) {
        setLeftTab("folder");
        const disc = discXmlRef.current;
        if (!disc) { alert("Load a DiscProfile.xml first - Export Element checks every class, attribute and symbol against it."); return; }
        if (!files.length) { alert("No .xml files found in that folder."); return; }
        elemCancelRef.current = false;
        setElemProgress({ done: 0, total: files.length, name: "" });
        try {
            const sheets = await collectFolderElements(files, disc, {
                onProgress: setElemProgress,
                isCancelled: () => elemCancelRef.current,
            });
            const base = (name || "folder").replace(/[\\/:*?"<>|]+/g, "_");
            downloadBlob(buildXlsxBlob(sheets), `${base}-elements.xlsx`);
        } catch (err) {
            alert("Export Element failed: " + (err.message || String(err)));
        } finally {
            setElemProgress(null);
        }
    }

    function downloadFolderCsv() {
        const csv = folderResultsCsv(folderResults || []);
        const base = (folderName || "folder").replace(/[\\/:*?"<>|]+/g, "_");
        downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8;" }), `${base}-validation.csv`);
    }
    async function handleProfileFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const xml = await file.text();
        const name = file.name.replace(".xml", "");
        const constraints = parseProfileConstraints(xml, name);
        setProfiles(prev => [...prev, { name, xml, constraints }]);
        e.target.value = "";
    }
    function removeBg() {
        if (bgObjectUrlRef.current) { URL.revokeObjectURL(bgObjectUrlRef.current); bgObjectUrlRef.current = null; }
        setBgImage(null); setShowBgControls(false);
    }

    // BG Image button: an image on its own, or a DEXPI XML picked together with its .png - then both are loaded.
    // Where the browser has a file picker API the PNG's file handle is kept, so
    // "Save placement" can write straight back into that same file.
    async function handleBgButton() {
        if (typeof window.showOpenFilePicker !== "function") { bgInputRef.current?.click(); return; }
        let handles;
        try {
            handles = await window.showOpenFilePicker({
                multiple: true,
                types: [{
                    description: "DEXPI XML and/or background image",
                    accept: {
                        "image/png": [".png"], "image/jpeg": [".jpg", ".jpeg"], "image/gif": [".gif"],
                        "image/bmp": [".bmp"], "image/webp": [".webp"], "image/svg+xml": [".svg"], "text/xml": [".xml"],
                    },
                }],
            });
        } catch (err) {
            if (err?.name !== "AbortError") bgInputRef.current?.click();
            return;
        }
        const files = await Promise.all(handles.map(h => h.getFile()));
        const handleByFile = new Map(files.map((file, i) => [file, handles[i]]));
        await routeBgFiles(files, handleByFile);
    }
    async function handleBgFile(e) {
        const picked = [...(e.target.files || [])];
        e.target.value = "";
        await routeBgFiles(picked, null);
    }
    async function routeBgFiles(picked, handleByFile) {
        const xml = picked.find(f => /\.xml$/i.test(f.name));
        if (xml) { await handleMainFile({ target: { files: picked, set value(_v) { /* already cleared */ } } }, handleByFile); return; }
        const file = picked.find(f => f.type.startsWith("image/") || /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(f.name));
        if (file) await loadBgFile(file, handleByFile?.get(file) || null);
    }

    // fileHandle (optional): a FileSystemFileHandle for the same file, used by
    // saveBgPlacementPng() to write the placement back into it in place.
    async function loadBgFile(file, fileHandle = null) {
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
                // sourceBytes/isPng/fileName/embeddedPlacement/fileHandle support
                // the Save placement / Clear default controls below - see
                // saveBgPlacementPng().
                sourceBytes: bytes, isPng, fileName: file.name, embeddedPlacement: embedded,
                fileHandle: fileHandle && typeof fileHandle.createWritable === "function" ? fileHandle : null,
            };
            setFitStatus(null);
            // Open the BG Controls bar whenever an image has been loaded.
            probe.onload = () => { setBgImage({ ...base, naturalWidth: probe.naturalWidth, naturalHeight: probe.naturalHeight }); setShowBgControls(true); };
            probe.onerror = () => { setBgImage({ ...base, naturalWidth: 0, naturalHeight: 0 }); setShowBgControls(true); };
            probe.src = src;
        } catch (err) {
            alert("Could not read the selected image: " + (err.message || String(err)));
        }
    }

    // Writes PNG bytes back under the loaded image's own file name: straight
    // into the opened file when its handle is known (Chrome/Edge ask once for
    // write permission), otherwise via a Save dialog pre-filled with the same
    // name, or - in browsers without either API - as a download of that name.
    // Returns the handle written to (so later saves go straight in), or null.
    async function writeBgPngSameName(bytes) {
        const name = bgImage?.fileName || "background.png";
        const blob = new Blob([bytes], { type: "image/png" });
        const writeTo = async (handle) => { const w = await handle.createWritable(); await w.write(blob); await w.close(); return handle; };
        if (bgImage?.fileHandle) return writeTo(bgImage.fileHandle);
        if (typeof window.showSaveFilePicker === "function") {
            const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "PNG image", accept: { "image/png": [".png"] } }] });
            return writeTo(handle);
        }
        downloadBlob(blob, name);
        return null;
    }

    // Embeds the current Scale/X/Y into the PNG's own metadata and saves it
    // under the same file name, so the next load of it starts at this placement.
    async function saveBgPlacementPng() {
        if (!bgImage?.isPng || !bgImage.sourceBytes) return;
        try {
            const placement = { scale: bgImage.scale, offsetX: bgImage.offsetX, offsetY: bgImage.offsetY };
            const updated = writePngEmbeddedPlacement(bgImage.sourceBytes, placement);
            const handle = await writeBgPngSameName(updated);
            setBgImage(b => b && ({ ...b, sourceBytes: updated, embeddedPlacement: placement, fileHandle: handle || b.fileHandle }));
        } catch (err) {
            if (err?.name === "AbortError") return;
            alert("Could not save the placement into the PNG: " + (err.message || String(err)));
        }
    }

    // ---------- Image compare / auto-fit (PNG BG image vs DEXPI drawing) -----
    // The heavy lifting runs in a module worker (imageCompare.worker.js), which
    // keeps the last decoded image cached, so an auto-fit followed by a
    // compare only decodes the PNG once.
    function runCompareWorker(type, payload, onProgress) {
        return new Promise((resolve, reject) => {
            if (!compareWorkerRef.current) {
                compareWorkerRef.current = new Worker(new URL("./imageCompare.worker.js", import.meta.url), { type: "module" });
            }
            const w = compareWorkerRef.current;
            const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const cleanup = () => { w.removeEventListener("message", onMsg); w.removeEventListener("error", onErr); };
            const onMsg = (e) => {
                const m = e.data;
                if (!m || m.id !== id) return;
                if (m.type === "progress") { onProgress?.(m); return; }
                cleanup();
                if (m.type === "done") resolve(m.result); else reject(new Error(m.message || "Image compare failed."));
            };
            const onErr = (e) => { cleanup(); compareWorkerRef.current = null; reject(new Error(e.message || "The image compare worker could not start.")); };
            w.addEventListener("message", onMsg);
            w.addEventListener("error", onErr);
            w.postMessage({ id, type, blob: new Blob([bgImage.sourceBytes]), cacheKey: bgImage.src, ...payload });
        });
    }

    // Auto-fit: finds the Scale/X/Y that lays the PNG over the DEXPI drawing
    // (uniform scale + offset), then applies it - Save placement stores it.
    async function autoFitBg() {
        if (!bgImage?.sourceBytes || !compareGeometry || !bgPlacement || !bgImage.naturalWidth || cmpBusy) return;
        setCmpBusy({ kind: "fit", phase: "Starting", done: 0, total: 1 });
        try {
            const res = await runCompareWorker("autofit", { geometry: compareGeometry, initial: bgPlacement }, m => setCmpBusy({ kind: "fit", ...m }));
            const p = placementToBgParams(fullBounds, bgImage.naturalWidth, bgImage.naturalHeight, res.placement);
            setBgImage(b => b && ({ ...b, scale: p.scale, offsetX: p.offsetX, offsetY: p.offsetY }));
            setFitStatus({ score: res.score });
        } catch (err) {
            alert("Auto-fit failed: " + (err.message || String(err)));
        } finally {
            setCmpBusy(null);
        }
    }

    const cmpDecisionsKey = (fileName) => `dexpiViewer.imgCompare.${fileName || "drawing"}`;
    function loadCmpDecisions(fileName) {
        try { return JSON.parse(localStorage.getItem(cmpDecisionsKey(fileName)) || "{}") || {}; } catch { return {}; }
    }
    function setCmpDecision(issueKey, patch) {
        setCmpDecisions(prev => {
            const cur = prev[issueKey] || {};
            const nextEntry = { ...cur, ...patch };
            const next = { ...prev };
            if (!nextEntry.status && !nextEntry.comment) delete next[issueKey]; else next[issueKey] = nextEntry;
            try { localStorage.setItem(cmpDecisionsKey(mainFileFullName), JSON.stringify(next)); } catch { /* storage unavailable */ }
            return next;
        });
    }

    async function runImageCompare() {
        if (!bgImage?.sourceBytes || !compareGeometry || !bgPlacement || cmpBusy) return;
        setCmpBusy({ kind: "compare", phase: "Starting", done: 0, total: 1 });
        const placement = { x: bgPlacement.x, y: bgPlacement.y, width: bgPlacement.width, height: bgPlacement.height };
        try {
            const res = await runCompareWorker("compare", { geometry: compareGeometry, placement, options: cmpOpts }, m => setCmpBusy({ kind: "compare", ...m }));
            const diffUrl = URL.createObjectURL(res.diffBlob);
            // the difference image is the PNG grid (ceil(W/f) x ceil(H/f)), so it can be a few px wider than the PNG
            const diffPlacement = {
                x: placement.x, y: placement.y,
                width: placement.width * (res.gridW * res.f) / res.W,
                height: placement.height * (res.gridH * res.f) / res.H,
            };
            setCmp(prev => {
                if (prev?.diffUrl) URL.revokeObjectURL(prev.diffUrl);
                return { issues: res.issues, stats: res.stats, diffUrl, diffBlob: res.diffBlob, diffPlacement, placement, ranAt: new Date().toISOString() };
            });
            setCmpDecisions(loadCmpDecisions(mainFileFullName));
            setCmpSelKey(null);
            setLeftTab("compare");
            setLeftCollapsed(false);
        } catch (err) {
            alert("Image compare failed: " + (err.message || String(err)));
        } finally {
            setCmpBusy(null);
        }
    }

    // One image compare issue row - used by the Compare list (left panel) and
    // the selected object's Compare tab (right panel).
    function renderCmpIssueRow(issue, { showLabel = true } = {}) {
        const dec = cmpDecisions[issue.key] || {};
        const sel = issue.key === cmpSelKey;
        const color = IMG_CODES[issue.code]?.color;
        return (
            <div key={issue.key} onClick={() => selectCmpIssue(issue)}
                style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6", cursor: "pointer", background: sel ? "#f6f8fa" : "white", borderLeft: `3px solid ${color || "#ccc"}`, opacity: dec.status ? 0.6 : 1 }}>
                <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 3 }}>
                    <span style={{ ...S.badge(S.sevColor[issue.severity]) }}>{issue.severity}</span>
                    <span style={{ fontSize: 11, fontFamily: "monospace", color: "#555" }}>{issue.code}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color }}>{issue.title}</span>
                </div>
                {showLabel && issue.label && <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2, wordBreak: "break-word" }}>{issue.label}</div>}
                <div style={{ fontSize: 12, color: "#333" }}>{issue.message}</div>
                <div style={{ display: "flex", gap: 4, marginTop: 5 }} onClick={e => e.stopPropagation()}>
                    {[["accepted", "Accept"], ["ignored", "Ignore"], ["false-positive", "False positive"]].map(([st, l]) => (
                        <button key={st} style={{ ...S.btnSmall, fontSize: 11, background: dec.status === st ? "#eaf2ff" : "white", borderColor: dec.status === st ? "#0969da" : "#c7ced6" }}
                            onClick={() => setCmpDecision(issue.key, { status: dec.status === st ? undefined : st })}>{l}</button>
                    ))}
                </div>
                {(sel || dec.comment) && (
                    <input style={{ ...S.input, marginTop: 5, fontSize: 12, padding: "3px 6px" }} placeholder="Comment" value={dec.comment || ""}
                        onClick={e => e.stopPropagation()} onChange={e => setCmpDecision(issue.key, { comment: e.target.value || undefined })} />
                )}
            </div>
        );
    }

    function zoomToBox(b) {
        if (!b) return;
        const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
        const aspect = viewBox.w / viewBox.h || 1;
        let w = Math.max(60, (b.maxX - b.minX) * 4);
        let h = w / aspect;
        if (h < (b.maxY - b.minY) * 4) { h = Math.max(60, (b.maxY - b.minY) * 4); w = h * aspect; }
        setViewBox(clampViewBox({ x: cx - w / 2, y: cy - h / 2, w, h }, fullBounds));
    }

    function selectCmpIssue(issue) {
        setCmpSelKey(issue.key);
        zoomToBox(issue.bbox);
        if (issue.representedId && parsed?.treeMap?.has(issue.representedId)) handleSelect(issue.representedId);
    }

    function exportCmp(kind) {
        if (!cmp) return;
        const base = `${exportFileBaseName()}-image-compare`;
        const rows = cmp.issues.map(i => ({
            code: i.code, title: i.title, severity: i.severity, object: i.label, objectType: i.objectType, objectId: i.representedId || "",
            x: +((i.bbox.minX + i.bbox.maxX) / 2).toFixed(2), y: +((i.bbox.minY + i.bbox.maxY) / 2).toFixed(2),
            dxMm: i.dxMm != null ? +i.dxMm.toFixed(2) : "", dyMm: i.dyMm != null ? +i.dyMm.toFixed(2) : "",
            score: i.score != null ? +Number(i.score).toFixed(3) : "", message: i.message,
            status: cmpDecisions[i.key]?.status || "open", comment: cmpDecisions[i.key]?.comment || "", key: i.key,
        }));
        if (kind === "json") {
            const doc = { drawing: mainFileFullName, image: bgImage?.fileName || "", ranAt: cmp.ranAt, placement: cmp.placement, stats: cmp.stats, issues: rows };
            downloadBlob(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }), `${base}.json`);
        } else if (kind === "csv") {
            const cols = Object.keys(rows[0] || { code: "" });
            const esc = v => { const t = String(v ?? ""); return /[",\n\r;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
            const csv = [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\r\n");
            downloadBlob(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
        } else if (kind === "png" && cmp.diffBlob) {
            downloadBlob(cmp.diffBlob, `${base}-difference.png`);
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

    async function renderViewboxToCanvas(vb = viewBox) {
        const svgEl = svgElRef.current;
        if (!svgEl) throw new Error("Drawing is not ready yet.");
        const clone = svgEl.cloneNode(true);
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        const aspect = vb.w / vb.h;
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

    function expandAll() { if (!parsed) return; const ids = new Set(); flattenTree(parsed.tree).forEach(n => ids.add(n.id)); setExpanded(ids); }
    function collapseAll() { if (!parsed) return; setExpanded(new Set([parsed.tree.id])); }

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
    // Sampled DEXPI graphics for the image compare / auto-fit (imageCompare.js).
    const compareGeometry = useMemo(() => (parsed ? buildCompareGeometry(parsed) : null), [parsed]);
    // A new drawing or a new BG image makes the last compare result meaningless.
    useEffect(() => {
        setCmp(prev => { if (prev?.diffUrl) URL.revokeObjectURL(prev.diffUrl); return null; });
        setCmpSelKey(null);
    }, [parsed, bgImage?.src]);
    useEffect(() => () => { compareWorkerRef.current?.terminate(); compareWorkerRef.current = null; }, []);
    const cmpVisibleIssues = useMemo(() => {
        if (!cmp) return [];
        return cmp.issues.filter(i => (cmpFilter === "All" || i.code === cmpFilter) && (cmpShowReviewed || !cmpDecisions[i.key]?.status));
    }, [cmp, cmpFilter, cmpShowReviewed, cmpDecisions]);
    const cmpOpenCount = useMemo(() => (cmp ? cmp.issues.filter(i => !cmpDecisions[i.key]?.status).length : 0), [cmp, cmpDecisions]);
    // Image compare issues of the selected object (and its sub-components when
    // that highlight option is on) - shown on the right panel's Compare tab.
    const selectedCmpIssues = useMemo(() => {
        if (!cmp || !selectedId) return [];
        const ids = selectedRepresentedIds?.size ? selectedRepresentedIds : new Set([selectedId]);
        return cmp.issues.filter(i => i.representedId && (ids.has(i.representedId) || i.representedId === selectedId));
    }, [cmp, selectedId, selectedRepresentedIds]);
    const cmpPlacementChanged = !!(cmp && bgPlacement && (Math.abs(cmp.placement.x - bgPlacement.x) > 1e-6 || Math.abs(cmp.placement.y - bgPlacement.y) > 1e-6 || Math.abs(cmp.placement.width - bgPlacement.width) > 1e-6));
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
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 6 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                <div style={{ fontWeight: 700, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>DEXPI Verificator <span style={{ fontWeight: 400, fontSize: 12, color: "#57606a" }} title={`Version ${APP_VERSION}`}>v{APP_VERSION.split(".").slice(0, 2).join(".")}</span></div>
                                {/* Opens public/UserGuide.html in a new tab; the app keeps its state. Same open-book icon as AKSODEXPIViewer. */}
                                <a
                                    href={`${import.meta.env.BASE_URL}UserGuide.html`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="Open the User Guide"
                                    aria-label="Open the User Guide"
                                    style={{
                                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                                        width: 22, height: 22, flexShrink: 0, borderRadius: 5,
                                        border: "1px solid #d0d7de", background: "white",
                                        color: "#57606a", textDecoration: "none",
                                    }}
                                >
                                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M8 4.2C7.3 3.1 6.1 2.6 4 2.6H1.8v9.6H4c1.8 0 3.2.4 4 1.2" />
                                        <path d="M8 4.2c.7-1.1 1.9-1.6 4-1.6h2.2v9.6H12c-1.8 0-3.2.4-4 1.2" />
                                        <path d="M8 4.2v9.2" />
                                    </svg>
                                </a>
                            </div>
                            <button style={S.collapseBtn} onClick={() => setLeftCollapsed(true)}>{"<"}</button>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button style={S.btn} onClick={() => mainInputRef.current?.click()}>
                                Load DEXPI XML{mainXmlText && <span style={S.loadedTick} title="File loaded">✓</span>}
                            </button>
                            <button style={S.btn} onClick={() => discInputRef.current?.click()}>
                                DiscProfile.xml{discXmlText && <span style={S.loadedTick} title="File loaded">✓</span>}
                            </button>
                        </div>
                        <input ref={mainInputRef} type="file" accept=".xml,.png" multiple style={{ display: "none" }} onChange={handleMainFile} />
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
                        {!discXmlText && defaultProfileState === "loading" && (
                            <div style={{ marginTop: 6, fontSize: 12, color: "#57606a" }}>Loading default DiscProfile.xml…</div>
                        )}
                        {!discXmlText && defaultProfileState === "error" && (
                            <div style={{ marginTop: 6, fontSize: 11, color: "#9a6700", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <span>Default DiscProfile.xml unavailable — load one by hand, or</span>
                                <button style={S.btnSmall} onClick={loadDefaultProfile}>Retry</button>
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

                    <div style={{ ...S.tabBar, overflowX: "auto" }}>
                        {[["topology", "Topology"], ["validation", `Validation${validationDone ? ` (${validationIssues.length})` : ""}`],
                            ...(SHOW_IMAGE_COMPARE && (bgImage || cmp) ? [["compare", `Compare${cmp ? ` (${cmpOpenCount})` : ""}`]] : []),
                            ["folder", `Folder${folderProgress ? "…" : folderIssues.length ? ` (${folderIssues.length})` : ""}`]].map(([t, label]) => (
                            <button key={t} style={{ ...S.tab(leftTab === t), whiteSpace: "nowrap", padding: "8px 10px" }} onClick={() => setLeftTab(t)}>{label}</button>
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

                    {SHOW_IMAGE_COMPARE && leftTab === "compare" && (
                        <div style={S.scroll}>
                                <div style={S.section}>
                                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                                        <button style={S.btnPrimary} disabled={!!cmpBusy || !parsed || !bgImage} onClick={runImageCompare} title="Compare the DEXPI drawing with the BG image at the current placement">
                                            {cmpBusy?.kind === "compare" ? "Comparing…" : cmp ? "Re-run compare" : "Run compare"}
                                        </button>
                                        <button style={S.btn} disabled={!!cmpBusy || !parsed || !bgImage?.naturalWidth} onClick={autoFitBg} title="Fit the BG image to the drawing first (then Save placement in BG Controls to keep it)">
                                            {cmpBusy?.kind === "fit" ? "Fitting…" : "Auto-fit"}
                                        </button>
                                    </div>
                                    {!bgImage && <div style={{ marginTop: 8, fontSize: 12, color: "#888" }}>Load a BG image (PNG of the same drawing) to compare.</div>}
                                    {cmpBusy && <div style={{ marginTop: 8, fontSize: 12, color: "#57606a" }}>{cmpBusy.phase}{cmpBusy.total > 1 ? ` – ${Math.round(100 * cmpBusy.done / cmpBusy.total)}%` : ""}</div>}
                                    {cmpPlacementChanged && <div style={{ marginTop: 8, fontSize: 12, color: "#9a6700" }}>The BG placement changed since this run – re-run to update.</div>}
                                    <details style={{ marginTop: 8, fontSize: 12 }}>
                                        <summary style={{ cursor: "pointer", color: "#57606a" }}>Settings</summary>
                                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 8px", alignItems: "center", marginTop: 6 }}>
                                            <span title="How far image ink may be from DEXPI ink and still count as matching">Match tolerance (mm)</span>
                                            <input type="number" min={0.1} max={5} step={0.1} value={cmpOpts.tolMm} onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setCmpOpts(o => ({ ...o, tolMm: v })); }} style={S.numBox} />
                                            <span title="Objects that don't match in place are searched for within this radius (Misplaced)">Misplaced search radius (mm)</span>
                                            <input type="number" min={0} max={30} step={0.5} value={cmpOpts.searchMm} onChange={e => { const v = parseFloat(e.target.value); if (v >= 0) setCmpOpts(o => ({ ...o, searchMm: v })); }} style={S.numBox} />
                                            <span title="Share of an object's outline that must lie on image ink">Required match (%)</span>
                                            <input type="number" min={30} max={100} step={5} value={Math.round(cmpOpts.okScore * 100)} onChange={e => { const v = parseFloat(e.target.value); if (v >= 30 && v <= 100) setCmpOpts(o => ({ ...o, okScore: v / 100 })); }} style={S.numBox} />
                                            <span title="Smallest unexplained image region reported as Missing in DEXPI">Smallest missing region (mm)</span>
                                            <input type="number" min={1} max={50} step={1} value={cmpOpts.minRegionMm} onChange={e => { const v = parseFloat(e.target.value); if (v > 0) setCmpOpts(o => ({ ...o, minRegionMm: v })); }} style={S.numBox} />
                                        </div>
                                    </details>
                                </div>
                                {cmp && (
                                    <>
                                        <div style={S.section}>
                                            <div style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12, marginBottom: 8 }}>
                                                <span style={{ color: "#57606a", marginRight: 2 }}>View</span>
                                                {[["off", "Off"], ["markers", "Markers"], ["diff", "Difference"]].map(([v, l]) => (
                                                    <button key={v} style={{ ...S.btnSmall, background: cmpView === v ? "#eaf2ff" : "white", borderColor: cmpView === v ? "#0969da" : "#c7ced6" }} onClick={() => setCmpView(v)}>{l}</button>
                                                ))}
                                            </div>
                                            {cmpView === "diff" && (
                                                <div style={{ fontSize: 11, color: "#57606a", marginBottom: 8, lineHeight: 1.5 }}>
                                                    <span style={{ color: "#969696" }}>■</span> matched &nbsp;
                                                    <span style={{ color: "#dc0000" }}>■</span> image only (missing in DEXPI) &nbsp;
                                                    <span style={{ color: "#f5a0a0" }}>■</span> image only, ignored (text / small) &nbsp;
                                                    <span style={{ color: "#005aff" }}>■</span> DEXPI only
                                                </div>
                                            )}
                                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                                {[["All", cmp.issues.length], ...Object.keys(IMG_CODES).filter(c => cmp.stats.counts[c]).map(c => [c, cmp.stats.counts[c]])].map(([c, n]) => (
                                                    <button key={c} onClick={() => setCmpFilter(c)} title={c === "All" ? "All issues" : IMG_CODES[c].title}
                                                        style={{ ...S.btnSmall, fontSize: 11, background: cmpFilter === c ? "#eaf2ff" : "white", borderColor: cmpFilter === c ? "#0969da" : (IMG_CODES[c]?.color || "#c7ced6"), color: IMG_CODES[c]?.color || "#111" }}>
                                                        {c === "All" ? "All" : `${c} ${IMG_CODES[c].title}`} ({n})
                                                    </button>
                                                ))}
                                            </div>
                                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, fontSize: 12 }}>
                                                <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                                                    <input type="checkbox" checked={cmpShowReviewed} onChange={e => setCmpShowReviewed(e.target.checked)} /> Show reviewed
                                                </label>
                                                <span style={{ display: "flex", gap: 4 }}>
                                                    <button style={S.btnSmall} onClick={() => exportCmp("csv")} title="Download the issues with their review status as CSV">CSV</button>
                                                    <button style={S.btnSmall} onClick={() => exportCmp("json")} title="Download the issues, settings and placement as JSON">JSON</button>
                                                    <button style={S.btnSmall} onClick={() => exportCmp("png")} title="Download the difference image">Diff PNG</button>
                                                </span>
                                            </div>
                                            <div style={{ fontSize: 11, color: "#888", marginTop: 6 }}>
                                                {cmp.stats.checked} objects checked · {cmpOpenCount} open · {Math.round(cmp.stats.ms)} ms · {cmp.stats.pxPerMm.toFixed(1)} px/mm
                                            </div>
                                        </div>
                                        {cmpVisibleIssues.length === 0 && <div style={{ padding: 12, color: "#888", fontSize: 12 }}>{cmp.issues.length ? "No open issues for this filter." : "No differences found."}</div>}
                                        {cmpVisibleIssues.slice(0, 500).map(issue => renderCmpIssueRow(issue))}
                                        {cmpVisibleIssues.length > 500 && <div style={{ padding: 10, fontSize: 11, color: "#888" }}>Showing the first 500 of {cmpVisibleIssues.length} – use the filters above.</div>}
                                    </>
                                )}
                            </div>
                        )}

                    {leftTab === "folder" && (
                        <div style={S.scroll}>
                            <input ref={folderInputRef} type="file" webkitdirectory="" directory="" multiple style={{ display: "none" }} onChange={handleFolderPick} />
                            <input ref={folderPngInputRef} type="file" webkitdirectory="" directory="" multiple style={{ display: "none" }} onChange={handleFolderPngPick} />
                            <input ref={folderElemInputRef} type="file" webkitdirectory="" directory="" multiple style={{ display: "none" }} onChange={handleFolderElemPick} />
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "8px 12px", borderBottom: "1px solid #eef2f6" }}>
                                <button style={S.btn} disabled={!!folderProgress || !!pngProgress || !!elemProgress} onClick={handleFolderButton} title="Validate every .xml in a folder, and its subfolders, against the loaded profile. The browser asks permission to read the folder; the files stay on this machine and nothing is uploaded.">
                                    Validate…
                                </button>
                                <button style={S.btn} disabled={!!folderProgress || !!pngProgress || !!elemProgress} onClick={handleSavePngButton} title="Render every .xml in a folder, and its subfolders, and save each as a .png next to it. The browser asks permission to write to the folder.">
                                    Save PNG…
                                </button>
                                <button style={S.btn} disabled={!!folderProgress || !!pngProgress || !!elemProgress || !discXmlText} onClick={handleExportElementButton} title={discXmlText ? "Export every class, Data attribute and placed symbol used in a folder's DEXPI 2.0 .xml files, with counts and validity against the DEXPI 2.0 meta model and the loaded DiscProfile.xml, as an Excel file." : "Load a DiscProfile.xml first"}>
                                    Export Element…
                                </button>
                            </div>
                            {elemProgress && (
                                <div style={{ padding: 16, fontSize: 13, color: "#57606a" }}>
                                    <div>Reading {Math.min(elemProgress.done + 1, elemProgress.total)} of {elemProgress.total}…</div>
                                    <div style={{ marginTop: 4, fontSize: 11, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{elemProgress.name}</div>
                                    <button style={{ ...S.btnSmall, marginTop: 8 }} onClick={() => { elemCancelRef.current = true; }}>Stop</button>
                                </div>
                            )}
                            {pngProgress && (
                                <div style={{ padding: 16, fontSize: 13, color: "#57606a" }}>
                                    <div>Saving PNG {Math.min(pngProgress.done + 1, pngProgress.total)} of {pngProgress.total}…</div>
                                    <div style={{ marginTop: 4, fontSize: 11, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pngProgress.name}</div>
                                    <button style={{ ...S.btnSmall, marginTop: 8 }} onClick={() => { pngCancelRef.current = true; }}>Stop</button>
                                </div>
                            )}
                            {!pngProgress && pngResult && (
                                <div style={{ margin: "8px 12px", padding: "8px 10px", fontSize: 12, background: pngResult.failed.length ? "#fff8c5" : "#dafbe1", border: "1px solid #eef2f6", borderRadius: 6 }}>
                                    <div style={{ display: "flex", alignItems: "center" }}>
                                        <span>
                                            {pngResult.total === 0
                                                ? "No .xml files found in that folder."
                                                : `${pngResult.saved} of ${pngResult.total} PNG${pngResult.total === 1 ? "" : "s"} ${pngResult.downloaded ? "downloaded" : `saved to ${pngResult.folder || "the folder"}`}${pngResult.cancelled ? " (stopped)" : ""}.`}
                                        </span>
                                        <button style={{ ...S.btnSmall, marginLeft: "auto" }} onClick={() => setPngResult(null)}>×</button>
                                    </div>
                                    {pngResult.failed.map(f => (
                                        <div key={f.path} style={{ marginTop: 4, fontFamily: "monospace", fontSize: 11 }} title={f.error}>{f.path}: {f.error}</div>
                                    ))}
                                </div>
                            )}
                            {folderProgress && (
                                <div style={{ padding: 16, fontSize: 13, color: "#57606a" }}>
                                    <div>Validating {Math.min(folderProgress.done + 1, folderProgress.total)} of {folderProgress.total}…</div>
                                    {folderProgress.name && (
                                        <div style={{ marginTop: 4, fontSize: 11, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{folderProgress.name}</div>
                                    )}
                                    <button style={{ ...S.btnSmall, marginTop: 8 }} onClick={() => { folderCancelRef.current = true; }}>Stop</button>
                                </div>
                            )}
                            {!folderProgress && !pngProgress && !elemProgress && !folderResults && (
                                <div style={{ padding: 16, color: "#888", fontSize: 13, lineHeight: 1.5 }}>
                                    Each button works on every .xml file in a folder and its subfolders. <b>Open</b> on a validated file also loads the .png with the same name from that folder as the BG image.
                                    <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                                        <li><b>Validate…</b> checks each file with the same validation as Run Validation.</li>
                                        <li><b>Save PNG…</b> saves each drawing as a .png next to its file, using the drawing toolbar's Profile labels, Line Boost and symbol outline settings.</li>
                                        <li><b>Export Element…</b> downloads an Excel file listing the classes, Data attributes and symbols used in each DEXPI 2.0 file, with counts and whether each is valid against the meta model and the loaded DiscProfile.xml. Needs a DiscProfile.xml loaded; non-2.0 files are listed as skipped.</li>
                                    </ul>
                                    <div style={{ marginTop: 8, padding: "8px 10px", background: "#f6f8fa", border: "1px solid #eef2f6", borderRadius: 6 }}>
                                        <b>Nothing is uploaded.</b> The files are read and processed inside this browser, on this machine, and are never sent to a server.
                                        The browser asks permission first; its wording ("view and copy", or "upload") is the browser asking whether this page may <i>read</i> those files into itself.
                                        <b> Save PNG…</b> also asks to <i>edit</i> files in the folder, so it can write the PNGs there. Browsers that can't write to a folder download them instead.
                                    </div>
                                    <div style={{ marginTop: 8 }}>
                                        {discXmlText
                                            ? <>Profile in use: <b>{discFileFullName}</b>.</>
                                            : "No DiscProfile.xml is loaded, so profile-dependent checks will not be evaluated."}
                                    </div>
                                </div>
                            )}
                            {!folderProgress && folderResults?.length === 0 && (
                                <div style={{ padding: 16, color: "#888", fontSize: 13 }}>No .xml files found in that folder.</div>
                            )}
                            {!folderProgress && folderResults?.length > 0 && (
                                <>
                                    <div style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                        {folderIssues.length === 0
                                            ? <span style={S.badge("#1a7f37")}>No issues found</span>
                                            : <span style={S.badge("#cf222e")}>{folderIssues.length} issue{folderIssues.length === 1 ? "" : "s"}</span>}
                                        <span style={{ fontSize: 11, color: "#888" }} title="Validated in this browser - no file was uploaded">
                                            {folderName ? `${folderName} · ` : ""}
                                            {folderResults.length} file{folderResults.length === 1 ? "" : "s"}
                                            {discXmlText ? ` · ${discFileFullName}` : " · no profile"}
                                            {" · checked in this browser, nothing uploaded"}
                                        </span>
                                    </div>
                                    <div style={{ padding: "6px 10px", borderBottom: "1px solid #eef2f6", display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                                        {["All", "Error", "Warning", "Info"].map(f => {
                                            const count = f === "All" ? folderIssues.length : (folderCounts[f] || 0);
                                            const active = folderFilter === f;
                                            return (
                                                <button
                                                    key={f}
                                                    style={{ ...S.btnSmall, background: active ? "#0969da" : "white", color: active ? "white" : "#111", borderColor: active ? "#0969da" : "#c7ced6" }}
                                                    onClick={() => setFolderFilter(f)}
                                                >{f} ({count})</button>
                                            );
                                        })}
                                        <button style={{ ...S.btnSmall, marginLeft: "auto" }} onClick={downloadFolderCsv}>CSV</button>
                                    </div>
                                    <div style={{ padding: "4px 10px", borderBottom: "1px solid #eef2f6", display: "flex", gap: 6 }}>
                                        <button style={S.btnSmall} onClick={() => setCollapsedFolderFiles(new Set())}>Expand all</button>
                                        <button style={S.btnSmall} onClick={() => setCollapsedFolderFiles(new Set(folderResults.map(r => r.path)))}>Collapse all</button>
                                    </div>
                                    {folderResults.map(r => {
                                        const items = folderByFile.get(r.path) || [];
                                        if (!items.length && folderFilter !== "All" && !r.error) return null;
                                        const isFolded = collapsedFolderFiles.has(r.path);
                                        return (
                                            <div key={r.path}>
                                                <div
                                                    onClick={() => setCollapsedFolderFiles(prev => { const n = new Set(prev); n.has(r.path) ? n.delete(r.path) : n.add(r.path); return n; })}
                                                    style={{ padding: "6px 10px", background: "#f6f8fa", borderBottom: "1px solid #eef2f6", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                                                >
                                                    <span style={{ width: 12, textAlign: "center", flexShrink: 0, color: "#888", fontSize: 12 }}>{isFolded ? "▸" : "▾"}</span>
                                                    <span style={{ fontWeight: 600, fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.path}>{r.path}</span>
                                                    {r.error
                                                        ? <span style={S.badge("#cf222e")}>failed</span>
                                                        : items.length === 0
                                                            ? <span style={S.badge("#1a7f37")}>clean</span>
                                                            : <span style={{ fontSize: 11, color: "#57606a" }}>{items.length}</span>}
                                                    <button
                                                        style={{ ...S.btnSmall, flexShrink: 0 }}
                                                        onClick={ev => { ev.stopPropagation(); openFolderFile(r.path); }}
                                                        title="Load this file into the viewer"
                                                    >Open</button>
                                                </div>
                                                {!isFolded && r.error && (
                                                    <div style={{ padding: "8px 10px", fontSize: 12, color: "#cf222e", borderBottom: "1px solid #eef2f6" }}>{r.error}</div>
                                                )}
                                                {!isFolded && items.map(issue => (
                                                    <div key={issue.key} style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6" }}>
                                                        <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 2 }}>
                                                            <span style={S.badge(S.sevColor[issue.severity])}>{issue.severity}</span>
                                                            <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#24292f" }}>{issue.ruleId}</span>
                                                            {issue.lineNumber != null && <span style={{ fontSize: 11, fontFamily: "monospace", color: "#555" }}>line {issue.lineNumber}</span>}
                                                        </div>
                                                        <div style={{ fontSize: 12, color: "#333" }}>{issue.description}</div>
                                                        {issue.objectId && <div style={{ fontSize: 11, color: "#57606a", fontFamily: "monospace", marginTop: 2 }}>{issue.objectId}</div>}
                                                        {issue.suggestedCorrection && <div style={{ fontSize: 11, color: "#0969da", marginTop: 2 }}>Suggestion: {issue.suggestedCorrection}</div>}
                                                    </div>
                                                ))}
                                            </div>
                                        );
                                    })}
                                </>
                            )}
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
                            Include outlines
                        </label>
                        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#57606a" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} title="Hide drawing elements that have validation issues with the selected codes. The issue list is not affected.">
                                <input type="checkbox" checked={hideIssues.enabled} onChange={e => setHideIssues(h => ({ ...h, enabled: e.target.checked }))} />
                                Hide elements with issues
                            </label>
                            <select value={hideIssues.mode} onChange={e => setHideIssues(h => ({ ...h, mode: e.target.value }))} style={{ fontSize: 12 }} title="Which verification codes hide elements">
                                <option value="All">All</option>
                                <option value="AllErrors">All Errors</option>
                                <option value="None">None</option>
                                <option value="Custom">Custom</option>
                            </select>
                            <button style={S.btn} onClick={() => setShowHideCodes(v => !v)} title="Pick individual codes (switches to Custom)">Codes…</button>
                            {hideIssues.enabled && hiddenIssueIds.size > 0 && <span title="Objects hidden from the drawing">({hiddenIssueIds.size} hidden)</span>}
                            {showHideCodes && (
                                <div style={{ position: "absolute", top: "100%", left: 0, zIndex: 20, marginTop: 4, background: "white", border: "1px solid #d0d7de", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,0.12)", padding: 8, maxHeight: 320, overflowY: "auto", minWidth: 200 }}>
                                    {issueCodeList.length === 0 && <div style={{ color: "#8c959f" }}>No codes yet - run verification first.</div>}
                                    {issueCodeList.map(({ code, severity }) => (
                                        <label key={code} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", cursor: "pointer" }}>
                                            <input type="checkbox" checked={hiddenIssueCodes.has(code)} onChange={() => toggleHideCode(code)} />
                                            <span style={{ fontFamily: "monospace" }}>{code}</span>
                                            <span style={{ color: severity === "Error" ? "#cf222e" : severity === "Warning" ? "#9a6700" : "#57606a" }}>{severity}</span>
                                        </label>
                                    ))}
                                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                                        <button style={S.btn} onClick={() => setHideIssues(h => ({ ...h, mode: "Custom", codes: DEFAULT_CUSTOM_HIDE_CODES }))} title="Reset Custom to the default code set">Default</button>
                                        <button style={S.btn} onClick={() => setShowHideCodes(false)}>Close</button>
                                    </div>
                                </div>
                            )}
                        </div>
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
                        <button style={S.btn} onClick={handleBgButton} title="Overlay an image behind the drawing. Pick a DEXPI XML together with its .png to load both.">BG Image</button>
                        {bgImage && <button style={{ ...S.btn, background: showBgControls ? "#eaf2ff" : "white" }} onClick={() => setShowBgControls(p => !p)}>BG Controls</button>}
                        <input ref={bgInputRef} type="file" accept="image/*,.xml" multiple style={{ display: "none" }} onChange={handleBgFile} />
                        <span style={{ fontSize: 11, color: "#888", marginLeft: 4 }}>Scroll to zoom · Space+drag to pan</span>
                    </div>
                </div>

                {bgImage && showBgControls && (
                    <div style={{ padding: "6px 12px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
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
                        <button
                            style={{ ...S.btnSmall, borderColor: "#1a7f37", color: "#1a7f37" }}
                            disabled={!!cmpBusy || !parsed || !bgImage.naturalWidth}
                            onClick={autoFitBg}
                            title="Match the image to the DEXPI drawing: finds the Scale / X / Y that lays the drawn lines and symbols over the image's ink. Then use Save placement to keep it in the PNG."
                        >
                            {cmpBusy?.kind === "fit" ? "Fitting…" : "⤢ Auto-fit to drawing"}
                        </button>
                        {fitStatus && !cmpBusy && <span style={{ color: fitStatus.score >= 0.9 ? "#1a7f37" : fitStatus.score >= 0.7 ? "#9a6700" : "#cf222e" }} title="Share of the DEXPI drawing's line samples that land on image ink after the fit">{Math.round(fitStatus.score * 100)}% match</span>}
                        {/* Embed this PNG's current placement into its own metadata and save
                            it under the same file name, so a future load of it starts
                            pre-aligned - see saveBgPlacementPng() above.
                            Only PNG files support an embedded default (the chunk format is
                            PNG-specific); other image types leave this disabled. */}
                        <button
                            style={{ ...S.btnSmall, borderColor: "#0969da", color: "#0969da" }}
                            disabled={!bgImage.isPng}
                            onClick={saveBgPlacementPng}
                            title={bgImage.isPng
                                ? `Embed the current Scale / X / Y into ${bgImage.fileName || "the PNG"} and save it under the same name, so the next time this image is loaded it starts at this placement`
                                : "Only PNG images support an embedded placement default - this file isn't a PNG"}
                        >
                            💾 Save placement
                        </button>
                        {SHOW_IMAGE_COMPARE && (
                            <>
                                <button
                                    style={{ ...S.btnSmall, borderColor: "#8250df", color: "#8250df" }}
                                    disabled={!!cmpBusy || !parsed}
                                    onClick={runImageCompare}
                                    title="Compare the DEXPI drawing with this image at the current placement and list the mismatches in the Compare tab"
                                >
                                    {cmpBusy?.kind === "compare" ? "Comparing…" : "⇄ Compare"}
                                </button>
                                {cmp && (
                                    <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} title="Show or hide the image compare markers / difference image on the drawing">
                                        <input type="checkbox" checked={cmpView !== "off"} onChange={e => setCmpView(e.target.checked ? "markers" : "off")} />
                                        Compare layer
                                    </label>
                                )}
                            </>
                        )}
                        {cmpBusy && <span style={{ color: "#57606a" }}>{cmpBusy.phase}{cmpBusy.total > 1 ? ` ${Math.round(100 * cmpBusy.done / cmpBusy.total)}%` : ""}</span>}
                        <button style={{ ...S.btnSmall, color: "#cf222e" }} onClick={removeBg}>Remove</button>
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
                        {bgImage && bgPlacement && !batchPng && !(cmp && cmpView === "diff") && (
                            <g style={{ display: bgImage.visible ? "inline" : "none", opacity: bgImage.opacity > 0 ? Math.max(0, 1 - bgImage.opacity) : 1, pointerEvents: "none" }}>
                                <image href={bgImage.src} x={bgPlacement.x} y={bgPlacement.y} width={bgPlacement.width} height={bgPlacement.height} preserveAspectRatio="none" />
                                <rect x={bgPlacement.x} y={bgPlacement.y} width={bgPlacement.width} height={bgPlacement.height} fill={BG_TINT_COLOR} style={{ mixBlendMode: "color" }} />
                            </g>
                        )}
                        {cmp && cmpView === "diff" && !batchPng && (
                            <image href={cmp.diffUrl} x={cmp.diffPlacement.x} y={cmp.diffPlacement.y} width={cmp.diffPlacement.width} height={cmp.diffPlacement.height} preserveAspectRatio="none" style={{ pointerEvents: "none" }} />
                        )}
                        <g style={{ opacity: cmp && cmpView === "diff" && !batchPng ? 0.12 : bgImage && bgImage.opacity < 0 ? Math.max(0, 1 + bgImage.opacity) : 1 }}>
                            {orderedGraphicsElements.map(el => {
                                if (el.representedId && hiddenIssueIds.has(el.representedId)) return null;
                                const isSelected = !!el.representedId && selectedRepresentedIds.has(el.representedId);
                                const ch = connectivityHighlight;
                                const connColor = el.representedId ? (ch.upstream.has(el.representedId) ? "#0969da" : ch.downstream.has(el.representedId) ? "#1a7f37" : ch.group.has(el.representedId) ? "#8250df" : null) : null;
                                if (el.kind === "symbolUsage") return <SymbolGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} boostPct={lineBoostPct} boostSymbolOutlines={boostSymbolOutlines} showProfileLabels={showProfileLabels} />;
                                return <PrimitiveGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} nodePosMap={parsed.graphics.nodePosMap} boostPct={lineBoostPct} boostSymbolOutlines={boostSymbolOutlines} showProfileLabels={showProfileLabels} />;
                            })}
                            {/* Heat-trace overlays – part of the DEXPI drawing layer (fades with it), only when a DISC profile is loaded */}
                            {parsed?.heatTraceSet?.size > 0 && parsed.graphics.elements.map(el => {
                                // Never draw heat-trace overlays on label or annotation elements
                                if (el.elementRole === "label") return null;
                                if (el.representedId && hiddenIssueIds.has(el.representedId)) return null;
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
                        </g>
                        {/* Image compare markers - one box per open issue, arrow to where a misplaced object matches */}
                        {cmp && cmpView !== "off" && !batchPng && (
                            <g>
                                {cmpVisibleIssues.slice(0, 3000).map(issue => {
                                    const b = issue.bbox, pad = 1.2;
                                    const color = IMG_CODES[issue.code]?.color || "#cf222e";
                                    const sel = issue.key === cmpSelKey;
                                    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
                                    return (
                                        <g key={issue.key} style={{ cursor: "pointer" }} onClick={e => { e.stopPropagation(); selectCmpIssue(issue); setRightTab("compare"); setRightCollapsed(false); }}>
                                            <rect x={b.minX - pad} y={b.minY - pad} width={b.maxX - b.minX + pad * 2} height={b.maxY - b.minY + pad * 2}
                                                fill={sel ? color : "transparent"} fillOpacity={sel ? 0.12 : 0} stroke={color} strokeWidth={sel ? 2.5 : 1.2}
                                                strokeDasharray={issue.severity === "Info" ? "4 3" : undefined} vectorEffect="non-scaling-stroke" pointerEvents="all" />
                                            {issue.dxMm != null && (Math.abs(issue.dxMm) > 0.3 || Math.abs(issue.dyMm) > 0.3) && (
                                                <>
                                                    <line x1={cx} y1={cy} x2={cx + issue.dxMm} y2={cy + issue.dyMm} stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                                                    <circle cx={cx + issue.dxMm} cy={cy + issue.dyMm} r={0.6} fill={color} />
                                                </>
                                            )}
                                        </g>
                                    );
                                })}
                            </g>
                        )}
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
                    <div style={{ ...S.tabBar, overflowX: "auto" }}>
                        {[["details", "Object"], ["connectivity", "Connections"], ["issues", `Issues${selectedId && issueMap.has(selectedId) ? ` (${issueMap.get(selectedId).length})` : ""}`],
                            ...(SHOW_IMAGE_COMPARE && cmp ? [["compare", `Compare${selectedCmpIssues.length ? ` (${selectedCmpIssues.filter(i => !cmpDecisions[i.key]?.status).length})` : ""}`]] : [])].map(([t, label]) => (
                            <button key={t} style={{ ...S.tab(rightTab === t), whiteSpace: "nowrap", padding: "8px 10px" }} onClick={() => setRightTab(t)}>{label}</button>
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
                                        const fmt = formatDataValue(d.value, parsed?.enumAbbreviations);
                                        const shortProp = d.property.split(".").pop() || d.property;
                                        return (
                                            <div key={`${d.property}_${i}`} style={{ marginBottom: 6, padding: "4px 6px", background: "#f9fafb", borderRadius: 4 }}>
                                                <div style={{ fontSize: 11, color: "#888", marginBottom: 1 }} title={d.property}>{shortProp}</div>
                                                <div style={{ fontSize: 13, display: "flex", alignItems: "baseline", gap: 5 }}>
                                                    <span style={{ fontWeight: 500 }} title={fmt.fullRef || undefined}>{fmt.text}</span>
                                                    {fmt.literal && <span style={{ fontSize: 11, color: "#888" }} title={fmt.fullRef}>({fmt.literal})</span>}
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
                                                {r.objects.map((oid, j) => {
                                                    // Reference to a profile enumeration literal (e.g. DiscProfile/TypeCode ->
                                                    // ...ControlledActuatorTypeCodes.Motor): show its Abbreviation ("M") like a Data enum value.
                                                    const abbr = !parsed?.treeMap?.has(oid) ? parsed?.enumAbbreviations?.get(oid) : null;
                                                    if (abbr) return (
                                                        <span key={j} style={{ marginRight: 5, display: "inline-flex", alignItems: "baseline", gap: 5 }} title={oid}>
                                                            <span style={{ fontSize: 13, fontWeight: 500 }}>{abbr}</span>
                                                            <span style={{ fontSize: 11, color: "#888" }}>({oid.split(".").pop()})</span>
                                                        </span>
                                                    );
                                                    return <span key={j} style={{ cursor: parsed?.treeMap?.has(oid) ? "pointer" : "default", color: parsed?.treeMap?.has(oid) ? "#0969da" : "#cf222e", marginRight: 5 }} onClick={() => parsed?.treeMap?.has(oid) && handleSelect(oid)}>{oid}</span>;
                                                })}
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
                                            // "Node" components (e.g. Plant/Piping.PipingNode) carry no
                                            // position of their own in the conceptual model - their
                                            // on-drawing position lives on the Diagram's
                                            // PipingNodePosition/InstrumentationNodePosition object that
                                            // represents them, indexed by conceptual Node id in
                                            // nodePositionsByNodeId (see parseNodePositionsById in
                                            // dexpiParser.js).
                                            const nodePos = /Node$/.test(typeSuffix) && child.objectId
                                                ? parsed?.graphics?.nodePositionsByNodeId?.get(child.objectId)
                                                : null;
                                            return (
                                                <div key={i}
                                                    onClick={() => child.objectId && handleSelect(child.objectId)}
                                                    style={{ padding: "4px 6px", marginBottom: 3, background: "#f9fafb", borderRadius: 4, cursor: child.objectId ? "pointer" : "default", border: "1px solid #eef2f6" }}
                                                >
                                                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
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
                                                    {nodePos && (
                                                        <div style={{ fontSize: 10, color: "#888", display: "flex", flexWrap: "wrap", gap: "2px 10px", marginTop: 2 }}>
                                                            <span>Position X: {nodePos.x}</span>
                                                            <span>Position Y: {nodePos.y}</span>
                                                        </div>
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
                                                <div style={{ fontSize: 11, color: "#57606a", display: "flex", flexWrap: "wrap", gap: "2px 12px", marginTop: 2 }}>
                                                    <span>Position X: {su.position?.x}</span>
                                                    <span>Position Y: {su.position?.y}</span>
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
                                                <div style={{ fontSize: 11, color: "#57606a", display: "flex", flexWrap: "wrap", gap: "2px 12px", marginTop: 2 }}>
                                                    <span>Position X: {su.position?.x}</span>
                                                    <span>Position Y: {su.position?.y}</span>
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
                        {SHOW_IMAGE_COMPARE && rightTab === "compare" && (
                            <div>
                                {!cmp ? <div style={{ padding: 12, color: "#888", fontSize: 12 }}>Run the image compare first (Compare tab on the left).</div>
                                    : !selectedNode ? <div style={{ padding: 12, color: "#888", fontSize: 12 }}>Select an object.</div>
                                    : selectedCmpIssues.length === 0 ? <div style={{ padding: 12, color: "#888", fontSize: 12 }}>No image compare issues for this object.</div>
                                    : selectedCmpIssues.map(issue => renderCmpIssueRow(issue, { showLabel: false }))}
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
