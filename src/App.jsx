import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseProfileConstraints, runFullValidation, downloadCSV, resolveSeverity } from "./validation.js";
import {
    parseDexpiPackage, boundsFromElements, clampViewBox,
    findAncestors, collectDescendantObjectIds, flattenTree,
    parseColor,
} from "./dexpiParser.js";

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
    input: { width: "100%", padding: "6px 8px", border: "1px solid #c7ced6", borderRadius: 6, boxSizing: "border-box", fontSize: 13 },
    badge: (color) => ({ display: "inline-block", padding: "2px 7px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: color || "#eef2f6", color: color ? "white" : "#444" }),
    tabBar: { display: "flex", gap: 0, borderBottom: "1px solid #d0d7de", background: "#f6f8fa", flexShrink: 0 },
    tab: (active) => ({ padding: "8px 14px", cursor: "pointer", fontWeight: active ? 700 : 400, fontSize: 13, color: active ? "#0969da" : "#57606a", background: "none", border: "none", borderBottom: active ? "2px solid #0969da" : "2px solid transparent" }),
    collapseBtn: { width: 30, height: 30, border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "#57606a" },
    sevColor: { Error: "#cf222e", Warning: "#9a6700", Info: "#0969da" },
};

// ---------- SVG Rendering ----------------------------------------------------

function renderPrimitive(primitive, key) {
    const fill = v => v?.style === "Transparent" ? "none" : (v?.color || "none");
    if (primitive.kind === "polyline") return <polyline key={key} points={primitive.points.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} strokeDasharray={primitive.stroke.dashArray || undefined} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "polygon") return <polygon key={key} points={primitive.points.map(p => `${p.x},${p.y}`).join(" ")} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "circle") return <circle key={key} cx={primitive.center.x} cy={primitive.center.y} r={primitive.radius} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "ellipse") return <ellipse key={key} cx={primitive.center.x} cy={primitive.center.y} rx={primitive.rx} ry={primitive.ry} transform={`rotate(${primitive.rotation} ${primitive.center.x} ${primitive.center.y})`} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "rect") return <rect key={key} x={primitive.center.x - primitive.width / 2} y={primitive.center.y - primitive.height / 2} width={primitive.width} height={primitive.height} transform={`rotate(${primitive.rotation} ${primitive.center.x} ${primitive.center.y})`} fill={fill(primitive.fill)} stroke={primitive.stroke.color} strokeWidth={primitive.stroke.width} vectorEffect="non-scaling-stroke" />;
    if (primitive.kind === "text") {
        const anchor = primitive.style.horizontal.toLowerCase().includes("left") ? "start" : primitive.style.horizontal.toLowerCase().includes("right") ? "end" : "middle";
        const baseline = primitive.style.vertical.toLowerCase().includes("bottom") ? "baseline" : primitive.style.vertical.toLowerCase().includes("top") ? "hanging" : "middle";
        return <text key={key} x={primitive.position.x} y={primitive.position.y} fontFamily={primitive.style.font} fontSize={primitive.style.size} fill={parseColor(primitive.style.color)} textAnchor={anchor} dominantBaseline={baseline} transform={`rotate(${primitive.rotation} ${primitive.position.x} ${primitive.position.y})`}>{primitive.value}</text>;
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
    return null;
}

function ConnectorLineSvg({ el, nodePosMap, selected, connColor }) {
    const { primitive: prim } = el;
    const src = prim.sourceRef ? nodePosMap.get(prim.sourceRef) : null;
    const tgt = prim.targetRef ? nodePosMap.get(prim.targetRef) : null;
    const pts = [src, ...prim.innerPoints, tgt].filter(Boolean);
    if (pts.length < 2) return null;
    const color = connColor || (selected ? "#d1242f" : prim.stroke.color);
    const sw = selected ? Math.max(prim.stroke.width * 2, prim.stroke.width + 0.4) : prim.stroke.width;
    const mid = Math.floor(pts.length / 2);
    const p1 = pts[mid - 1] || pts[0]; const p2 = pts[mid];
    const dx = p2.x - p1.x; const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len; const uy = dy / len;
    const mx = (p1.x + p2.x) / 2; const my = (p1.y + p2.y) / 2;
    const ar = Math.max(prim.stroke.width * 3, 1.5);
    return (
        <g>
            <polyline points={pts.map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color} strokeWidth={sw} strokeDasharray={prim.stroke.dashArray || undefined} vectorEffect="non-scaling-stroke" />
            {(selected || connColor) && (
                <polygon
                    points={`${mx},${my} ${mx - ux * ar - uy * ar * 0.5},${my - uy * ar + ux * ar * 0.5} ${mx - ux * ar + uy * ar * 0.5},${my - uy * ar - ux * ar * 0.5}`}
                    fill={color} stroke="none" vectorEffect="non-scaling-stroke"
                />
            )}
        </g>
    );
}

function SymbolGraphic({ el, selected, connHighlight, onSelect }) {
    const mirror = el.isMirrored ? -1 : 1;
    const transform = `translate(${el.position.x} ${el.position.y}) rotate(${el.rotation}) scale(${el.scaleX * mirror} ${el.scaleY})`;
    const hitPad = 2.5;
    const hitX = Math.min(el.variant.minX, el.variant.maxX) - hitPad;
    const hitY = Math.min(el.variant.minY, el.variant.maxY) - hitPad;
    const hitW = Math.abs(el.variant.maxX - el.variant.minX) + hitPad * 2;
    const hitH = Math.abs(el.variant.maxY - el.variant.minY) + hitPad * 2;
    const hlColor = selected ? "#d1242f" : connHighlight || null;
    return (
        <g onClick={e => { e.stopPropagation(); if (el.representedId) onSelect(el.representedId); }} style={{ cursor: el.representedId ? "pointer" : "default" }}>
            <g transform={transform}>
                <rect x={hitX} y={hitY} width={hitW} height={hitH} fill="transparent" stroke="none" pointerEvents="all" />
            </g>
            {hlColor && <g transform={transform} pointerEvents="none">{el.variant.primitives.map((p, i) => highlightPrimitive(p, `hl_${el.key}_${i}`, hlColor))}</g>}
            <g transform={transform} pointerEvents="none">
                {el.variant.primitives.map((p, i) => renderPrimitive(p, `${el.key}_${i}`))}
                {hlColor && <rect x={el.variant.minX - 0.8} y={el.variant.minY - 0.8} width={(el.variant.maxX - el.variant.minX) + 1.6} height={(el.variant.maxY - el.variant.minY) + 1.6} fill="none" stroke={hlColor} strokeWidth={0.6} vectorEffect="non-scaling-stroke" />}
            </g>
        </g>
    );
}

function PrimitiveGraphic({ el, selected, connHighlight, onSelect, nodePosMap }) {
    const hitPad = 2.0;
    const hlColor = selected ? "#d1242f" : connHighlight || null;
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
            {hlColor && el.kind !== "connectorLine" && highlightPrimitive(prim, `hl_${el.key}`, hlColor)}
            {el.kind === "connectorLine" ? <ConnectorLineSvg el={el} nodePosMap={nodePosMap} selected={selected} connColor={connHighlight} /> : renderPrimitive(prim, el.key)}
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
                <span style={{ fontSize: 10, color: "#aaa", flexShrink: 0, marginLeft: "auto" }}>{node.type.split(".").pop()}</span>
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
    const [loadMode, setLoadMode] = useState("with-profile");
    const [discXmlText, setDiscXmlText] = useState("");
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
    const [severityConfig, setSeverityConfig] = useState({});
    const [showConnectivity, setShowConnectivity] = useState(false);
    const [spaceDown, setSpaceDown] = useState(false);

    const mainInputRef = useRef(null);
    const discInputRef = useRef(null);
    const profileInputRef = useRef(null);
    const bgInputRef = useRef(null);
    const svgViewportRef = useRef(null);

    const issueMap = useMemo(() => {
        const m = new Map();
        validationIssues.forEach(issue => {
            const id = issue.objectId;
            if (!id || id.startsWith("(")) return;
            if (!m.has(id)) m.set(id, []);
            m.get(id).push(issue);
        });
        return m;
    }, [validationIssues]);

    const connectivityHighlight = useMemo(() => {
        if (!showConnectivity || !selectedId || !parsed?.connectivityMap) return { upstream: new Set(), downstream: new Set(), group: new Set() };
        return parsed.connectivityMap.get(selectedId) || { upstream: new Set(), downstream: new Set(), group: new Set() };
    }, [showConnectivity, selectedId, parsed]);

    function rebuild(nextMain, nextDisc, mode) {
        if (!nextMain) return;
        if ((mode || loadMode) === "with-profile" && !nextDisc) return;
        try {
            const p = parseDexpiPackage(nextMain, (mode || loadMode) === "with-profile" ? nextDisc : "");
            const b = boundsFromElements(p.graphics);
            setFullBounds(b);
            setParsed(p);
            setSelectedId(p.tree.objectId);
            setExpanded(new Set([p.tree.id, ...p.tree.children.slice(0, 5).map(c => c.id)]));
            setViewBox({ x: b.minX, y: b.minY, w: Math.max(100, b.maxX - b.minX), h: Math.max(100, b.maxY - b.minY) });
            setParseError("");
            setValidationIssues([]); setValidationDone(false);
        } catch (e) { setParseError(e.message || String(e)); }
    }

    async function handleMainFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const txt = await file.text(); setMainXmlText(txt);
        rebuild(txt, discXmlText, loadMode);
    }
    async function handleDiscFile(e) {
        const file = e.target.files?.[0]; if (!file) return;
        const txt = await file.text(); setDiscXmlText(txt);
        rebuild(mainXmlText, txt, "with-profile");
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
        const reader = new FileReader();
        reader.onload = ev => setBgImage({ src: ev.target.result, opacity: 0.4, scale: 1, offsetX: 0, offsetY: 0, visible: true });
        reader.readAsDataURL(file);
        e.target.value = "";
    }

    function runValidation() {
        if (!parsed) return;
        const allIssues = runFullValidation({ mainXml: mainXmlText, flatTree: parsed.flatTree, profiles, severityConfig });
        // Drop rules the user has set to Ignore
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
    const selectedRepresentedIds = useMemo(() => selectedNode ? collectDescendantObjectIds(selectedNode) : new Set(), [selectedNode]);

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

    const bgStyle = bgImage ? { transform: `translate(${bgImage.offsetX}px, ${bgImage.offsetY}px) scale(${bgImage.scale})`, transformOrigin: "top left", opacity: bgImage.opacity, position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", display: bgImage.visible ? "block" : "none" } : {};

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
                            <button style={S.collapseBtn} onClick={() => setLeftCollapsed(true)}>{"<"}</button>
                        </div>
                        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                            <button style={{ ...S.btn, background: loadMode === "with-profile" ? "#eaf2ff" : "white" }} onClick={() => setLoadMode("with-profile")}>With profile</button>
                            <button style={{ ...S.btn, background: loadMode === "internal" ? "#eaf2ff" : "white" }} onClick={() => { setLoadMode("internal"); setDiscXmlText(""); if (mainXmlText) rebuild(mainXmlText, "", "internal"); }}>Internal</button>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button style={S.btn} onClick={() => mainInputRef.current?.click()}>Load DEXPI XML</button>
                            {loadMode === "with-profile" && <button style={S.btn} onClick={() => discInputRef.current?.click()}>DiscProfile.xml</button>}
                            <button style={S.btn} onClick={() => profileInputRef.current?.click()} title="Load a validation profile">+ Profile</button>
                        </div>
                        <input ref={mainInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleMainFile} />
                        <input ref={discInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleDiscFile} />
                        <input ref={profileInputRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleProfileFile} />
                        {parsed && <button style={{ ...S.btnPrimary, marginTop: 8, width: "100%" }} onClick={runValidation}>Run Validation</button>}
                        {validationDone && (
                            <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <span style={{ ...S.badge("#cf222e"), cursor: "pointer" }} onClick={() => { setValidationFilter("Error"); setLeftTab("validation"); }}>{issueCounts.Error} Errors</span>
                                <span style={{ ...S.badge("#9a6700"), cursor: "pointer" }} onClick={() => { setValidationFilter("Warning"); setLeftTab("validation"); }}>{issueCounts.Warning} Warn</span>
                                <span style={{ ...S.badge("#0969da"), cursor: "pointer" }} onClick={() => { setValidationFilter("Info"); setLeftTab("validation"); }}>{issueCounts.Info} Info</span>
                                <button style={S.btnSmall} onClick={() => downloadCSV(validationIssues)}>CSV</button>
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
                                        <button style={{ ...S.btnSmall, marginLeft: "auto" }} onClick={() => downloadCSV(validationIssues)}>CSV</button>
                                    </div>
                                    {filteredIssues.map((issue, i) => (
                                        <div key={i} style={{ padding: "8px 10px", borderBottom: "1px solid #eef2f6", cursor: parsed?.treeMap?.has(issue.objectId) ? "pointer" : "default" }} onClick={() => { if (parsed?.treeMap?.has(issue.objectId)) handleSelect(issue.objectId); }}>
                                            <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 3 }}>
                                                <span style={{ ...S.badge(S.sevColor[issue.severity]) }}>{issue.severity}</span>
                                                <span style={{ fontSize: 11, fontFamily: "monospace", color: "#555" }}>{issue.ruleId}</span>
                                                <span style={{ fontSize: 10, color: "#888", marginLeft: "auto" }}>{issue.profileSource}</span>
                                            </div>
                                            <div style={{ fontSize: 12, color: "#333", marginBottom: 2 }}>{issue.description}</div>
                                            {issue.objectId && !issue.objectId.startsWith("(") && <div style={{ fontSize: 11, color: "#57606a", fontFamily: "monospace" }}>{issue.objectId}</div>}
                                            {issue.suggestedCorrection && <div style={{ fontSize: 11, color: "#0969da", marginTop: 2 }}>Suggestion: {issue.suggestedCorrection}</div>}
                                        </div>
                                    ))}
                                    {filteredIssues.length === 0 && <div style={{ padding: 16, color: "#888", fontSize: 13 }}>No {validationFilter !== "All" ? validationFilter.toLowerCase() + " " : ""}issues found.</div>}
                                </>
                            )}
                        </div>
                    )}

                    {leftTab === "config" && (
                        <div style={S.scroll}>
                            <div style={S.section}>
                                <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>Profiles (later = higher precedence)</div>
                                {profiles.length === 0 && <div style={{ color: "#888", fontSize: 12 }}>No profiles loaded.</div>}
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
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parsed?.meta?.drawingNumber || "No drawing loaded"}</div>
                        <div style={{ fontSize: 12, color: "#57606a" }}>{parsed?.meta?.drawingName || ""}{parsed?.meta?.subtitle ? ` - ${parsed.meta.subtitle}` : ""}</div>
                    </div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                        <button style={S.btn} onClick={() => { if (!parsed) return; const b = boundsFromElements(parsed.graphics); setFullBounds(b); setViewBox({ x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY }); }} title="Fit drawing to window">Fit</button>
                        <button style={{ ...S.btn, background: showConnectivity ? "#eaf2ff" : "white" }} onClick={() => setShowConnectivity(p => !p)} title="Connectivity mode: highlights the upstream (blue), downstream (green), and group (purple) connections of the selected object. Directional arrows appear on connector lines.">Connectivity</button>
                        <button style={S.btn} onClick={() => bgInputRef.current?.click()} title="Overlay an image or PDF behind the drawing">BG Image</button>
                        {bgImage && <button style={{ ...S.btn, background: showBgControls ? "#eaf2ff" : "white" }} onClick={() => setShowBgControls(p => !p)}>BG Controls</button>}
                        <input ref={bgInputRef} type="file" accept="image/*,.pdf" style={{ display: "none" }} onChange={handleBgFile} />
                        <span style={{ fontSize: 11, color: "#888", marginLeft: 4 }}>Scroll to zoom · Space+drag to pan</span>
                    </div>
                </div>

                {bgImage && showBgControls && (
                    <div style={{ padding: "6px 12px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <input type="checkbox" checked={bgImage.visible} onChange={e => setBgImage(b => ({ ...b, visible: e.target.checked }))} /> Visible
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            Opacity
                            <input type="range" min={0} max={1} step={0.05} value={bgImage.opacity} onChange={e => setBgImage(b => ({ ...b, opacity: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" min={0} max={100} step={5} value={Math.round(bgImage.opacity * 100)} onChange={e => setBgImage(b => ({ ...b, opacity: Math.min(1, Math.max(0, parseInt(e.target.value) || 0) / 100) }))} style={{ width: 48, padding: "1px 4px", border: "1px solid #c7ced6", borderRadius: 4, fontSize: 12 }} />%
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            Scale
                            <input type="range" min={0.1} max={3} step={0.05} value={bgImage.scale} onChange={e => setBgImage(b => ({ ...b, scale: parseFloat(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" min={0.1} max={3} step={0.05} value={bgImage.scale.toFixed(2)} onChange={e => setBgImage(b => ({ ...b, scale: Math.min(3, Math.max(0.1, parseFloat(e.target.value) || 1)) }))} style={{ width: 52, padding: "1px 4px", border: "1px solid #c7ced6", borderRadius: 4, fontSize: 12 }} />x
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            X
                            <input type="range" min={-500} max={500} step={1} value={bgImage.offsetX} onChange={e => setBgImage(b => ({ ...b, offsetX: parseInt(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" min={-500} max={500} step={1} value={bgImage.offsetX} onChange={e => setBgImage(b => ({ ...b, offsetX: Math.min(500, Math.max(-500, parseInt(e.target.value) || 0)) }))} style={{ width: 52, padding: "1px 4px", border: "1px solid #c7ced6", borderRadius: 4, fontSize: 12 }} />px
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            Y
                            <input type="range" min={-500} max={500} step={1} value={bgImage.offsetY} onChange={e => setBgImage(b => ({ ...b, offsetY: parseInt(e.target.value) }))} style={{ width: 70 }} />
                            <input type="number" min={-500} max={500} step={1} value={bgImage.offsetY} onChange={e => setBgImage(b => ({ ...b, offsetY: Math.min(500, Math.max(-500, parseInt(e.target.value) || 0)) }))} style={{ width: 52, padding: "1px 4px", border: "1px solid #c7ced6", borderRadius: 4, fontSize: 12 }} />px
                        </label>
                        <button style={S.btnDanger} onClick={() => { setBgImage(null); setShowBgControls(false); }}>Remove</button>
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
                    {bgImage && <img src={bgImage.src} alt="background overlay" style={bgStyle} draggable={false} />}
                    <svg viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`} width="100%" height="100%" style={{ display: "block" }} onAuxClick={e => e.preventDefault()}>
                        {parsed?.graphics.elements.map(el => {
                            const isSelected = !!el.representedId && selectedRepresentedIds.has(el.representedId);
                            const ch = connectivityHighlight;
                            const connColor = el.representedId ? (ch.upstream.has(el.representedId) ? "#0969da" : ch.downstream.has(el.representedId) ? "#1a7f37" : ch.group.has(el.representedId) ? "#8250df" : null) : null;
                            if (el.kind === "symbolUsage") return <SymbolGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} />;
                            return <PrimitiveGraphic key={el.key} el={el} selected={isSelected} connHighlight={connColor} onSelect={handleSelect} nodePosMap={parsed.graphics.nodePosMap} />;
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
                        {[["details", "Object"], ["connectivity", "Connections"], ["issues", "Issues"]].map(([t, label]) => (
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
                            </>
                        )}
                        {rightTab === "connectivity" && (
                            <div style={S.section}>
                                {!selectedNode ? <div style={{ color: "#888", fontSize: 12 }}>Select an object.</div> : (() => {
                                    const conn = parsed?.connectivityMap?.get(selectedId) || { upstream: new Set(), downstream: new Set(), group: new Set() };
                                    const makeList = (ids, color, label) => (
                                        <div style={{ marginBottom: 12 }}>
                                            <div style={{ fontWeight: 600, fontSize: 12, color, marginBottom: 4 }}>{label} ({ids.size})</div>
                                            {ids.size === 0 ? <div style={{ fontSize: 12, color: "#888" }}>None</div> : [...ids].map(id => {
                                                const n = parsed?.treeMap?.get(id);
                                                return <div key={id} style={{ fontSize: 12, padding: "2px 5px", cursor: "pointer", borderRadius: 3, marginBottom: 2, background: "#f6f8fa" }} onClick={() => handleSelect(id)}>{n?.label || id} <span style={{ fontSize: 10, color: "#888" }}>({id})</span></div>;
                                            })}
                                        </div>
                                    );
                                    return (
                                        <div>
                                            {makeList(conn.upstream, "#0969da", "Upstream")}
                                            {makeList(conn.downstream, "#1a7f37", "Downstream")}
                                            {makeList(conn.group, "#8250df", "Group")}
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
