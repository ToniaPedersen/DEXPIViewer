// Export Element… (Folder tab) - per DEXPI 2.0 file, every class, every Data
// attribute and every placed symbol in use, with counts and whether each is
// valid against the DEXPI 2.0 Plant/Process meta model and the loaded
// DiscProfile.xml. Ported in spirit from AKSODEXPIViewer's
// collectElementUsage() (DEXPI 1.4 / Proteus); the validity rules here are
// the ones this viewer's own validation uses:
//   class     - ERR-E07 type check (known DEXPI 2.0 type, or a concrete class
//               declared in the profile; prefix must be imported)
//   attribute - ERR-E07 property check (bare name defined for the class in
//               the meta model incl. inheritance; a profile-prefixed name must
//               be declared by a ClassExtension/class on the object's class or
//               one of its supertypes)
//   symbol    - PRF-E04 (symbol defined in the profile; its MetaData/usage
//               matches the represented object's class or a sub/supertype)

import { detectMetaModel, getMetaModelLookup, buildProfileClassHierarchy, isDescendantOrSelf, parseProfileSymbols } from "./validation.js";
import { PLANT_HIERARCHY, PROCESS_HIERARCHY } from "./metaModel.js";
import { DEXPI_ALL_TYPES, DEXPI_STD_PREFIXES } from "./dexpiTypes.js";

const suffixOf = t => (t || "").split(/[./]/).pop();
const directData = (el, prop) => [...el.children].find(c => c.tagName === "Data" && c.getAttribute("property") === prop);
const dataString = (el, prop) => directData(el, prop)?.querySelector("String")?.textContent.trim() || "";

/** True for a DEXPI 2.0 (Core/Plant/Process 2.x model) document. */
export function isDexpi2Doc(doc) {
    const root = doc?.documentElement;
    if (!root || root.tagName !== "Model") return false;
    return [...root.children].some(c => c.tagName === "Import" && /\/models\/2\.\d+(\.\d+)?\//.test(c.getAttribute("source") || ""));
}

/** Profile facts needed for the usage export - build once per profile. */
export function buildProfileIndex(discXml) {
    const doc = new DOMParser().parseFromString(discXml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("DiscProfile.xml is not well-formed XML.");
    const modelName = doc.documentElement.getAttribute("name") || "DiscProfile";
    // "DiscProfile/InformationModel.AreaBreak" -> { kind, superTypes, rdl }
    const classes = new Map();
    // class suffix -> Map(propName -> rdl) for ClassExtensions and profile classes
    const propsBySuffix = new Map();
    const addProp = (suffix, name, rdl) => {
        if (!propsBySuffix.has(suffix)) propsBySuffix.set(suffix, new Map());
        propsBySuffix.get(suffix).set(name, rdl);
    };
    const propsOf = (cls, suffix) => cls.querySelectorAll("DataProperty, CompositionProperty, ReferenceProperty").forEach(dp => {
        const n = dp.getAttribute("name");
        if (n) addProp(suffix, n, dataString(dp, "MetaData/rdl_uri"));
    });
    doc.querySelectorAll("Package").forEach(pkg => {
        const pkgName = pkg.getAttribute("name") || "";
        [...pkg.children].forEach(cls => {
            if (cls.tagName === "ConcreteClass" || cls.tagName === "AbstractClass") {
                const name = cls.getAttribute("name") || "";
                if (!name) return;
                classes.set(`${modelName}/${pkgName}.${name}`, {
                    kind: cls.tagName === "AbstractClass" ? "Abstract" : "Concrete",
                    superTypes: (cls.getAttribute("superTypes") || "").trim(),
                    rdl: dataString(cls, "MetaData/rdl_uri"),
                });
                propsOf(cls, name);
            } else if (cls.tagName === "ClassExtension") {
                const base = cls.getAttribute("baseType") || "";
                if (base) propsOf(cls, suffixOf(base));
            }
        });
    });
    const { symbolUsage } = parseProfileSymbols(discXml);
    const symbolNames = new Set([...doc.querySelectorAll('Object[type="Profile/Symbol"]')].map(s => s.getAttribute("name")).filter(Boolean));
    return { xml: discXml, modelName, classes, propsBySuffix, symbolUsage, symbolNames };
}

/**
 * @param {string} mainXml - one DEXPI 2.0 file
 * @param {object} profile - from buildProfileIndex()
 * @returns {{ classes: object[], attributes: object[], symbols: object[] }}
 */
export function collectElementUsage(mainXml, profile) {
    const doc = new DOMParser().parseFromString(mainXml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("not well-formed XML");
    if (!isDexpi2Doc(doc)) throw new Error("not a DEXPI 2.0 file");

    const modelName = detectMetaModel(doc);
    const classPropMap = getMetaModelLookup(modelName)?.classPropMap || new Map();
    const hierarchy = buildProfileClassHierarchy([profile.xml], modelName === "Process" ? PROCESS_HIERARCHY : PLANT_HIERARCHY);
    const imported = new Set(["Core", "Plant", "Profile", "MetaData"]);
    doc.querySelectorAll("Import").forEach(i => { const p = i.getAttribute("prefix"); if (p) imported.add(p); });

    const supersOf = t => {
        const info = profile.classes.get(t);
        if (info) return info.superTypes;
        return [...(hierarchy.get(suffixOf(t)) || [])].join(" ");
    };
    // Nearest class (self first, then ancestors) the meta model has properties for.
    const metaEntryFor = suffix => {
        const seen = new Set(); const queue = [suffix];
        while (queue.length) {
            const cur = queue.shift();
            if (seen.has(cur)) continue; seen.add(cur);
            if (classPropMap.has(cur)) return classPropMap.get(cur);
            (hierarchy.get(cur) || []).forEach(s => queue.push(s));
        }
        return null;
    };
    const profilePropFor = (suffix, name) => {
        for (const [owner, props] of profile.propsBySuffix) {
            if (props.has(name) && isDescendantOrSelf(hierarchy, suffix, owner)) return { rdl: props.get(name) };
        }
        return null;
    };
    const anyProfileProp = name => [...profile.propsBySuffix.values()].some(m => m.has(name));

    const classValid = t => {
        const prefix = t.split("/")[0];
        if (!imported.has(prefix)) return false;
        if (prefix === profile.modelName) return profile.classes.get(t)?.kind === "Concrete";
        if (DEXPI_STD_PREFIXES.has(prefix)) return DEXPI_ALL_TYPES.has(t);
        return true; // another imported namespace - same as ERR-E07
    };

    const bump = (map, key, row) => { const hit = map.get(key); if (hit) hit.count++; else map.set(key, { ...row, count: 1 }); };
    const classes = new Map(), attributes = new Map(), symbols = new Map();
    const typeById = new Map();
    const isModelObject = t => !!t && !t.includes("/Diagram.") && !t.startsWith("Core/") && !t.startsWith("Profile/") && !t.startsWith("MetaData/");

    doc.querySelectorAll("Object[type]").forEach(obj => {
        const t = obj.getAttribute("type");
        const id = obj.getAttribute("id");
        if (id) typeById.set(id, t);
        if (!isModelObject(t)) return;
        const suffix = suffixOf(t);
        const superType = supersOf(t);
        const valid = classValid(t);
        const rdl = profile.classes.get(t)?.rdl || "";
        bump(classes, `${t}\0${valid}`, { className: t, superType, rdlUri: rdl, valid });

        [...obj.children].forEach(child => {
            if (child.tagName !== "Data") return;
            const prop = child.getAttribute("property") || "";
            if (!prop) return;
            let attrValid, attrRdl = "";
            if (prop.includes("/")) {
                const [prefix, name] = [prop.split("/")[0], prop.split("/").pop()];
                if (prefix === profile.modelName) {
                    const hit = profilePropFor(suffix, name);
                    attrValid = !!hit; attrRdl = hit?.rdl || "";
                } else attrValid = imported.has(prefix);
            } else if (prop.includes(".")) {
                attrValid = true; // meta-data convention - not checked by ERR-E07 either
            } else {
                const entry = metaEntryFor(suffix);
                attrValid = entry ? (entry.d.has(prop) || anyProfileProp(prop)) : valid;
            }
            bump(attributes, `${t}\0${prop}\0${attrValid}`, { className: t, superType, attribute: prop, rdlUri: attrRdl, valid: attrValid });
        });
    });

    // Placed symbols: every Profile/SymbolUsage, against the object its group represents.
    const representedType = su => {
        for (let el = su.parentElement; el; el = el.parentElement) {
            if (el.tagName !== "Object") continue;
            const ref = [...el.children].find(c => c.tagName === "References" && c.getAttribute("property") === "Represents");
            if (ref) return typeById.get((ref.getAttribute("objects") || "").split(/\s+/)[0].replace(/^#/, "")) || "";
        }
        return "";
    };
    doc.querySelectorAll('Object[type="Profile/SymbolUsage"]').forEach(su => {
        const ref = [...su.children].find(c => c.tagName === "References" && c.getAttribute("property") === "Symbol");
        const raw = ref?.getAttribute("objects") || "";
        if (!raw) return;
        const symName = raw.split("/").pop().replace(/^#/, "");
        const cls = representedType(su);
        const usages = (profile.symbolUsage.get(symName) || []).filter(u => /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z]/.test(u));
        const isLabel = usages.length > 0 && usages.every(u => u.startsWith("Core.Diagram."));
        let valid = profile.symbolNames.has(symName);
        if (valid && !isLabel && cls && usages.length) {
            const norm = cls.replace(/\//g, "."), s = suffixOf(cls);
            valid = usages.some(u => u === norm || suffixOf(u) === s
                || isDescendantOrSelf(hierarchy, s, suffixOf(u)) || isDescendantOrSelf(hierarchy, suffixOf(u), s));
        }
        bump(symbols, `${symName}\0${cls}\0${isLabel}\0${valid}`, {
            reference: symName, className: cls, superType: cls ? supersOf(cls) : "",
            kind: isLabel ? "Label" : "Symbol", valid,
        });
    });

    return { classes: [...classes.values()], attributes: [...attributes.values()], symbols: [...symbols.values()] };
}

/**
 * Export Element…: three xlsx sheets for every file in a folder.
 * @returns {Promise<{name:string, columns:object[], rows:any[][]}[]>}
 */
export async function collectFolderElements(files, discXml, opts = {}) {
    const { onProgress, isCancelled } = opts;
    const profile = buildProfileIndex(discXml);
    const classRows = [], attrRows = [], symbolRows = [];
    const yn = v => (v ? "Yes" : "No");
    for (let i = 0; i < files.length; i++) {
        if (isCancelled?.()) break;
        const file = files[i];
        const path = file.relPath || file.webkitRelativePath || file.name;
        onProgress?.({ done: i, total: files.length, name: path });
        try {
            const u = collectElementUsage(await file.text(), profile);
            u.classes.sort((a, b) => a.className.localeCompare(b.className))
                .forEach(c => classRows.push([path, c.className, c.superType, c.rdlUri, c.count, yn(c.valid)]));
            u.attributes.sort((a, b) => a.className.localeCompare(b.className) || a.attribute.localeCompare(b.attribute))
                .forEach(a => attrRows.push([path, a.className, a.superType, a.attribute, a.rdlUri, a.count, yn(a.valid)]));
            u.symbols.sort((a, b) => a.kind.localeCompare(b.kind) || a.reference.localeCompare(b.reference) || a.className.localeCompare(b.className))
                .forEach(y => symbolRows.push([path, y.reference, y.className, y.superType, y.kind, y.count, yn(y.valid)]));
        } catch (e) {
            classRows.push([path, `(skipped: ${e.message || e})`, "", "", 0, "No"]);
        }
        await new Promise(done => setTimeout(done, 0));
    }
    return [
        { name: "Classes", columns: [{ header: "File", width: 40 }, { header: "Class", width: 40 }, { header: "SuperType", width: 40 },
            { header: "Class RDL", width: 52 }, { header: "Count", width: 8 }, { header: "IsValid", width: 9 }], rows: classRows },
        { name: "Attributes", columns: [{ header: "File", width: 40 }, { header: "Class", width: 40 }, { header: "SuperType", width: 40 },
            { header: "Attribute", width: 40 }, { header: "Attribute RDL", width: 60 }, { header: "Count", width: 8 }, { header: "IsValid", width: 9 }], rows: attrRows },
        { name: "Symbols", columns: [{ header: "File", width: 40 }, { header: "Symbol", width: 14 }, { header: "Class", width: 40 }, { header: "SuperType", width: 40 },
            { header: "Reference Type", width: 14 }, { header: "Count", width: 8 }, { header: "IsValid", width: 9 }], rows: symbolRows },
    ];
}
