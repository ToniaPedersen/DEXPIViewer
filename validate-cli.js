#!/usr/bin/env node
/**
 * DEXPIViewer – Command-line batch validator
 *
 * Validates one or more DEXPI 2.0 XML files and writes a CSV report for each.
 * Reuses exactly the same parser and validation engine as the browser UI.
 *
 * Usage:
 *   node validate-cli.js <path>              # single file or folder
 *   node validate-cli.js <path> --profile <profile.xml> [--profile <p2.xml>]
 *   node validate-cli.js <folder> --out <output-folder>
 *   node validate-cli.js <folder> --summary  # print summary table only, no CSV files
 *
 * npm shortcut (after npm install):
 *   npm run validate -- <path> [options]
 *
 * Examples:
 *   node validate-cli.js "DEXPI Example Files"
 *   node validate-cli.js plant.xml --profile "DEXPI Standard and Profile/DISC.xml"
 *   node validate-cli.js "DEXPI Example Files" --out reports --summary
 *
 * Exit code: 0 = no errors found; 1 = one or more files have validation errors.
 */

import { DOMParser } from "@xmldom/xmldom";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, basename, extname, dirname } from "path";
import { parseDexpiPackage, collectModelValidIds } from "./src/dexpiParser.js";
import { parseProfileConstraints, runFullValidation, exportCSV } from "./src/validation.js";

// ── Polyfill DOMParser globally so src/ modules can call `new DOMParser()` ───
globalThis.DOMParser = DOMParser;

// ── querySelector / querySelectorAll polyfill for @xmldom/xmldom ──────────────
//
// xmldom implements DOM Level 2 but not the CSS Selector API (Level 4).
// The DEXPI parser and validation engine use querySelectorAll with these patterns:
//
//   tag                          e.g. "Import"
//   tag[attr]                    e.g. "Object[type]"
//   tag[attr="value"]            e.g. 'Object[type="Core/EngineeringModel"]'
//   A > B > C                    direct-child combinator (chainable)
//   A, B, C                      comma-separated (OR) list
//
// We patch xmldom's internal Node prototype once at startup.

(function patchXmldomQSA() {
    // Parse one simple selector segment: tag, tag[attr], tag[attr="val"]
    function parseSegment(seg) {
        seg = seg.trim();
        const tagMatch = seg.match(/^([A-Za-z*][A-Za-z0-9_.-]*|\*)?/);
        const tag = (tagMatch && tagMatch[1]) || "*";
        const attrClauses = [];
        const attrRe = /\[([^\]="~|^$*\s]+)(?:="([^"]*)")?\]/g;
        let am;
        while ((am = attrRe.exec(seg)) !== null) {
            attrClauses.push({ attr: am[1], val: am[2] !== undefined ? am[2] : null });
        }
        return { tag, attrClauses };
    }

    function matchesSegment(el, seg) {
        if (!el || el.nodeType !== 1) return false;
        if (seg.tag !== "*" && el.tagName !== seg.tag) return false;
        for (const { attr, val } of seg.attrClauses) {
            const v = el.getAttribute(attr);
            if (v === null) return false;
            if (val !== null && v !== val) return false;
        }
        return true;
    }

    // Check el against a parsed chain of segments joined by ">" (direct-child).
    // idx is the index of the rightmost segment; we walk up parentNode for each step.
    function matchesChain(el, parsed, idx) {
        if (!matchesSegment(el, parsed[idx])) return false;
        if (idx === 0) return true;
        const parent = el.parentNode;
        if (!parent || parent.nodeType !== 1) return false;
        return matchesChain(parent, parsed, idx - 1);
    }

    function matchesSelector(el, selector) {
        const parts = selector.split(/\s*>\s*/);
        const parsed = parts.map(parseSegment);
        return matchesChain(el, parsed, parsed.length - 1);
    }

    function qsaImpl(root, selector) {
        const selectors = selector.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
        const results = [];
        const seen = new Set();

        function walk(node) {
            const children = node.childNodes;
            if (!children) return;
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child.nodeType === 1) {
                    if (selectors.some(sel => matchesSelector(child, sel))) {
                        if (!seen.has(child)) { seen.add(child); results.push(child); }
                    }
                    walk(child);
                }
            }
        }
        walk(root);
        return results;
    }

    // Find the Node prototype shared by all xmldom documents/elements and patch it
    const testDoc = new DOMParser().parseFromString("<r/>", "application/xml");
    const nodeProto = Object.getPrototypeOf(Object.getPrototypeOf(testDoc));
    if (!nodeProto.querySelectorAll) {
        nodeProto.querySelectorAll = function(sel) { return qsaImpl(this, sel); };
        nodeProto.querySelector    = function(sel) {
            const all = qsaImpl(this, sel);
            return all.length > 0 ? all[0] : null;
        };
        // closest(sel): walk up parentNode chain returning the first ancestor that matches sel
        nodeProto.closest = function(sel) {
            const selectors = sel.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
            const parts = selectors.map(s => s.split(/\s*>\s*/).map(parseSegment));
            let node = this;
            while (node && node.nodeType === 1) {
                if (parts.some(parsed => matchesChain(node, parsed, parsed.length - 1))) return node;
                node = node.parentNode;
            }
            return null;
        };
    }
}());

// ── Argument parsing ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
DEXPIViewer CLI Validator
Usage:
  node validate-cli.js <file-or-folder> [options]

Options:
  --profile <file>   Load a DISC profile XML (repeatable)
  --out <folder>     Write CSV reports to this folder (default: same folder as input)
  --summary          Print a summary table to stdout; suppress individual CSV files
  --help             Show this help

Exit code: 0 = no errors; 1 = validation errors found in one or more files.
`);
    process.exit(0);
}

const inputPath    = args[0];
const profilePaths = [];
let outFolder      = null;
let summaryOnly    = false;

for (let i = 1; i < args.length; i++) {
    if      (args[i] === "--profile" && args[i + 1]) { profilePaths.push(args[++i]); }
    else if (args[i] === "--out"     && args[i + 1]) { outFolder = args[++i]; }
    else if (args[i] === "--summary")                { summaryOnly = true; }
}

// ── Collect XML files ─────────────────────────────────────────────────────────
function collectXmlFiles(p) {
    const stat = statSync(p);
    if (stat.isDirectory()) {
        return readdirSync(p)
            .filter(f => extname(f).toLowerCase() === ".xml")
            .map(f => join(p, f));
    }
    if (extname(p).toLowerCase() === ".xml") return [p];
    console.error(`Error: '${p}' is not an XML file or directory.`);
    process.exit(1);
}

const xmlFiles = collectXmlFiles(inputPath);
if (xmlFiles.length === 0) { console.log("No XML files found."); process.exit(0); }

// ── Load profiles ─────────────────────────────────────────────────────────────
const profiles = profilePaths.map(pp => {
    const xml         = readFileSync(pp, "utf8");
    const name        = basename(pp, extname(pp));
    const constraints = parseProfileConstraints(xml, name);
    return { name, xml, constraints };
});
if (profiles.length > 0) {
    console.log(`Loaded ${profiles.length} profile(s): ${profiles.map(p => p.name).join(", ")}`);
}

// ── Build external valid IDs from all loaded profiles ─────────────────────────
// The web UI does this via collectModelValidIds() so that references to objects
// defined in profile files (e.g. TypeCode enum values like
// "DiscProfile/InformationModel.ControlledActuatorTypeCodes.Motor") are not
// flagged as broken references by ERR-E09.  The CLI must do the same.
const externalValidIds = new Set();
for (const p of profiles) {
    collectModelValidIds(p.xml).forEach(id => externalValidIds.add(id));
}

// ── Validate each file ────────────────────────────────────────────────────────
let anyErrors = false;
const summaryRows = [];

for (const xmlFile of xmlFiles) {
    const stem = basename(xmlFile, extname(xmlFile));
    process.stdout.write(`Validating ${basename(xmlFile)} ... `);

    try {
        const xml    = readFileSync(xmlFile, "utf8");
        const result = parseDexpiPackage(xml, null);
        const issues = runFullValidation({
            mainXml: xml, flatTree: result.flatTree, profiles, severityConfig: {},
            externalValidIds,
        });

        const errors   = issues.filter(i => i.severity === "Error").length;
        const warnings = issues.filter(i => i.severity === "Warning").length;
        const infos    = issues.filter(i => i.severity === "Info").length;

        if (errors > 0) anyErrors = true;
        const icon = errors > 0 ? "x" : warnings > 0 ? "!" : "v";
        console.log(`[${icon}]  ${errors} errors  ${warnings} warnings  ${infos} info`);
        summaryRows.push({ file: basename(xmlFile), errors, warnings, infos });

        if (!summaryOnly) {
            const targetFolder = outFolder
                ? (mkdirSync(outFolder, { recursive: true }), outFolder)
                : dirname(xmlFile);
            const csvPath = join(targetFolder, `${stem}.csv`);
            writeFileSync(csvPath, exportCSV(issues), "utf8");
            console.log(`  -> ${csvPath}`);
        }
    } catch (err) {
        console.log(`[!]  ERROR - ${err.message}`);
        summaryRows.push({ file: basename(xmlFile), errors: 1, warnings: 0, infos: 0 });
        anyErrors = true;
    }
}

// ── Summary table ─────────────────────────────────────────────────────────────
if (xmlFiles.length > 1 || summaryOnly) {
    const W    = 45;
    const line = "-".repeat(W + 26);
    console.log("\n" + line);
    console.log(`${"File".padEnd(W)} ${"Errors".padStart(7)} ${"Warnings".padStart(9)} ${"Info".padStart(5)}`);
    console.log(line);
    for (const r of summaryRows) {
        const name = r.file.length > W - 1 ? r.file.slice(0, W - 4) + "..." : r.file;
        console.log(`${name.padEnd(W)} ${String(r.errors).padStart(7)} ${String(r.warnings).padStart(9)} ${String(r.infos).padStart(5)}`);
    }
    console.log(line);
    const totE = summaryRows.reduce((s, r) => s + r.errors,   0);
    const totW = summaryRows.reduce((s, r) => s + r.warnings, 0);
    const totI = summaryRows.reduce((s, r) => s + r.infos,    0);
    console.log(`${"TOTAL".padEnd(W)} ${String(totE).padStart(7)} ${String(totW).padStart(9)} ${String(totI).padStart(5)}`);
}

process.exit(anyErrors ? 1 : 0);
