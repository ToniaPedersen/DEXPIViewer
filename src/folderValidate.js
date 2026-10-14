// Folder tab helpers - pick a folder of DEXPI XML files, validate each one
// with the same engine the single-file view uses (parseDexpiPackage +
// runFullValidation), and write per-file output (PNG) back next to each
// .xml. Ported from AKSODEXPIViewer's folderValidate.js; the folder picking
// and writing helpers are the same, the validation step uses this viewer's
// DEXPI 2.0 engine.

import { parseDexpiPackage, collectModelValidIds } from "./dexpiParser.js";
import { runFullValidation, resolveSeverity, exportCSV } from "./validation.js";

const isXml = (name) => /\.xml$/i.test(name);
const isPng = (name) => /\.png$/i.test(name);

/** Files a folder pick should actually validate. */
export function pickXmlFiles(fileList) {
    return [...(fileList || [])].filter(f => isXml(f.name));
}

/** .png files of a folder pick, keyed by lower-cased relative path. */
export function pickPngFiles(fileList) {
    return new Map([...(fileList || [])].filter(f => isPng(f.name)).map(f => [(f.webkitRelativePath || f.name).toLowerCase(), f]));
}

/** True when the browser offers showDirectoryPicker(). */
export function supportsDirectoryPicker() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

async function collectXmlFiles(dirHandle, prefix, out, pngs) {
    for await (const entry of dirHandle.values()) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.kind === "directory") {
            await collectXmlFiles(entry, rel, out, pngs);
        } else if (isXml(entry.name)) {
            const file = await entry.getFile();
            try { file.relPath = rel; } catch { /* File is not extensible in this engine */ }
            out.push(file);
        } else if (pngs && isPng(entry.name)) {
            pngs.set(rel.toLowerCase(), entry);
        }
    }
}

async function pickWithMode(mode, id) {
    let dirHandle;
    try {
        dirHandle = await window.showDirectoryPicker({ mode, id });
    } catch (e) {
        if (e?.name === "AbortError") return null;
        throw e;
    }
    const files = [];
    const pngs = new Map();
    await collectXmlFiles(dirHandle, "", files, pngs);
    files.sort((a, b) => (a.relPath || a.name).localeCompare(b.relPath || b.name));
    return { name: dirHandle.name, files, pngs, dirHandle };
}

/** Directory picker (read): every .xml in the folder and its subfolders, plus .png handles (pngs, by lower-cased path). null if cancelled. */
export const pickDirectory = () => pickWithMode("read", "dexpi-folder-validate");

/** Directory picker (read/write), for saving output next to each .xml. null if cancelled. */
export const pickDirectoryForWrite = () => pickWithMode("readwrite", "dexpi-folder-png");

export const relPathOf = (file) => file.relPath || file.webkitRelativePath || file.name;

/** "sub/drawing.xml" -> "sub/drawing.png" */
export function pngPathFor(relPath) {
    return relPath.replace(/\.[^./]+$/, "") + ".png";
}

/** Writes blob to relPath (subfolders must already exist) under dirHandle. */
export async function writeFileAt(dirHandle, relPath, blob) {
    const parts = relPath.split("/");
    const fileName = parts.pop();
    let dir = dirHandle;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const fh = await dir.getFileHandle(fileName, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
}

/**
 * Validates every file with the single-file engine.
 *
 * @param {File[]} files
 * @param {string} discXml - DiscProfile.xml source, or "" for none
 * @param {{ profiles?: object[], severityConfig?: object,
 *           onProgress?: (p:{done:number,total:number,name:string}) => void,
 *           isCancelled?: () => boolean }} [opts]
 * @returns {Promise<Array<{ name:string, path:string, issues:object[], error:string }>>}
 */
export async function validateFiles(files, discXml, opts = {}) {
    const { profiles = [], severityConfig = {}, onProgress, isCancelled } = opts;
    const externalValidIds = collectModelValidIds(discXml || "");
    profiles.forEach(p => collectModelValidIds(p.xml).forEach(id => externalValidIds.add(id)));
    const results = [];

    for (let i = 0; i < files.length; i++) {
        if (isCancelled?.()) break;
        const file = files[i];
        const path = relPathOf(file);
        onProgress?.({ done: i, total: files.length, name: path });
        const r = { name: file.name, path, issues: [], error: "" };
        try {
            const text = await file.text();
            const parsed = parseDexpiPackage(text, discXml || "");
            const all = runFullValidation({
                mainXml: text, flatTree: parsed.flatTree,
                profiles, severityConfig, externalValidIds: new Set(externalValidIds),
                discXml: discXml || null,
            });
            r.issues = all.filter(x => resolveSeverity(x.ruleId, severityConfig).level !== "Ignore");
        } catch (e) {
            r.error = e.message || String(e);
        }
        results.push(r);
        // Let the progress line paint between files.
        await new Promise(done => setTimeout(done, 0));
    }

    onProgress?.({ done: files.length, total: files.length, name: "" });
    return results;
}

/** One CSV for the whole folder run: the single-file CSV layout with a leading File column. */
export function folderResultsCsv(results) {
    const escape = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [];
    let header = null;
    results.forEach(r => {
        if (r.error) {
            lines.push([r.path, "", "", "(file)", "", "Error", "", `Could not be validated: ${r.error}`].map(escape).join(","));
            return;
        }
        if (!r.issues.length) return;
        const [h, ...rows] = exportCSV(r.issues).split("\r\n");
        header = header || h;
        rows.forEach(row => lines.push(`${escape(r.path)},${row}`));
    });
    header = header || exportCSV([]).split("\r\n")[0];
    return [`"File",${header}`, ...lines].join("\r\n");
}
