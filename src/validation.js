// DEXPI Verificator – Validation Engine
// Implements: VAL-001..005, PRF-001..007, ERR-001..004, RPT-001..004

// ─── Severity helpers ────────────────────────────────────────────────────────

export const DEFAULT_SEVERITIES = {
    "VAL-001": { level: "Error",   score: 3 },
    "VAL-004": { level: "Warning", score: 2 },
    "VAL-005": { level: "Error",   score: 3 },
    "PRF":     { level: "Warning", score: 2 }, // default for profile rules
};

export function resolveSeverity(ruleId, severityConfig) {
    if (severityConfig && severityConfig[ruleId]) return severityConfig[ruleId];
    if (ruleId.startsWith("PRF-")) {
        const base = severityConfig?.["PRF"] || DEFAULT_SEVERITIES["PRF"];
        return base;
    }
    return DEFAULT_SEVERITIES[ruleId] || { level: "Info", score: 1 };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function directChildren(node, tag) {
    if (!node?.children) return [];
    return Array.from(node.children).filter(c => c.tagName === tag);
}

function getDataText(obj, property) {
    const data = directChildren(obj, "Data").find(d => d.getAttribute("property") === property);
    if (!data) return null;
    const child = data.firstElementChild;
    return child ? child.textContent.trim() : null;
}

// ─── Base Validation ─────────────────────────────────────────────────────────

/**
 * VAL-001: XML parse error (already handled by parseDexpiPackage throwing)
 * VAL-004: Objects of key types with missing IDs
 * VAL-005: Referential integrity – all References/@objects must exist
 */
export function runBaseValidation(mainXml, flatTree, severityConfig) {
    const issues = [];

    // VAL-001: Try re-parse to confirm well-formedness
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(mainXml, "application/xml");
        const parseErr = doc.querySelector("parseerror");
        if (parseErr) {
            const sev = resolveSeverity("VAL-001", severityConfig);
            issues.push({
                objectId: "(document)",
                objectType: "(document)",
                ruleId: "VAL-001",
                severity: sev.level,
                score: sev.score,
                description: "XML is not well-formed: " + (parseErr.textContent || "parse error").slice(0, 200),
                location: "/",
                profileSource: "Base",
                suggestedCorrection: "Correct the XML syntax error before re-submitting."
            });
        }
    } catch (_) { /* ignore */ }

    // Build set of all IDs present in the tree
    const allIds = new Set();
    flatTree.forEach(n => { if (n.objectId) allIds.add(n.objectId); });

    flatTree.forEach(node => {
        const loc = node.objectId ? `//*[@id='${node.objectId}']` : `(type: ${node.type})`;

        // VAL-004: Objects without an ID that are clearly identifiable model elements
        // (skip diagram elements and anonymous grouping wrappers)
        const isModelElement = node.type && !node.type.startsWith("Core/Diagram") &&
            !node.type.includes("PersistentIdentifier") &&
            !node.type.includes("Label");
        if (isModelElement && !node.objectId) {
            const sev = resolveSeverity("VAL-004", severityConfig);
            issues.push({
                objectId: "(no id)",
                objectType: node.type,
                ruleId: "VAL-004",
                severity: sev.level,
                score: sev.score,
                description: `Object of type '${node.type}' has no id attribute. Persistent identification is required for model objects.`,
                location: loc,
                profileSource: "Base",
                suggestedCorrection: "Add a unique id attribute to this object."
            });
        }

        // VAL-005: Referential integrity
        node.refs.forEach(ref => {
            ref.objects.forEach(targetId => {
                if (!allIds.has(targetId)) {
                    const sev = resolveSeverity("VAL-005", severityConfig);
                    issues.push({
                        objectId: node.objectId || "(no id)",
                        objectType: node.type,
                        ruleId: "VAL-005",
                        severity: sev.level,
                        score: sev.score,
                        description: `Broken reference: '${ref.property}' references object '${targetId}' which is not present in this file.`,
                        location: `${loc}/References[@property='${ref.property}']`,
                        profileSource: "Base",
                        suggestedCorrection: `Ensure object with id '${targetId}' is included in the file, or remove/correct the reference.`
                    });
                }
            });
        });
    });

    return issues;
}

// ─── Profile Parsing ──────────────────────────────────────────────────────────

/**
 * Parse a profile XML file and extract PropertyConstraint objects.
 * Returns an array of constraint descriptors.
 */
export function parseProfileConstraints(profileXml, profileName) {
    if (!profileXml) return [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(profileXml, "application/xml");
    if (doc.querySelector("parseerror")) return [];

    const constraints = [];
    doc.querySelectorAll('Object[type="Profile/PropertyConstraint"]').forEach(obj => {
        const constrainedType = getDataText(obj, "ConstrainedType");
        const lowerStr = getDataText(obj, "Lower");
        const upperStr = getDataText(obj, "Upper");
        const property  = getDataText(obj, "Property");
        const typeHint  = getDataText(obj, "Type");
        if (!constrainedType || !property) return;
        const lower = lowerStr !== null ? parseInt(lowerStr, 10) : 0;
        const upper = upperStr !== null ? parseInt(upperStr, 10) : Infinity;
        constraints.push({ constrainedType, lower, upper, property, typeHint, profileName });
    });

    return constraints;
}

// ─── Profile Precedence Merge (PRF-005, PRF-006, PRF-007) ───────────────────

/**
 * Merge constraints from multiple profiles in load order (last = highest precedence).
 * Returns { mergedConstraints, overrideLog }
 */
export function mergeProfileConstraints(profileSets) {
    // profileSets = [{name, constraints}, ...] in ascending precedence order
    const map = new Map(); // key → constraint
    const overrideLog = [];

    profileSets.forEach(({ name, constraints }) => {
        constraints.forEach(c => {
            const key = `${c.constrainedType}::${c.property}`;
            if (map.has(key)) {
                const prev = map.get(key);
                overrideLog.push({
                    key,
                    property: c.property,
                    constrainedType: c.constrainedType,
                    overriddenProfile: prev.profileName,
                    overridingProfile: name,
                });
            }
            map.set(key, { ...c, profileName: name });
        });
    });

    return { mergedConstraints: Array.from(map.values()), overrideLog };
}

// ─── Profile Validation ───────────────────────────────────────────────────────

/**
 * Run profile-based validation (PRF-001, PRF-002).
 * Uses merged constraints from mergeProfileConstraints().
 */
export function runProfileValidation(flatTree, mergedConstraints, overrideLog, severityConfig) {
    const issues = [];

    // Report overridden rules as Info entries (PRF-007)
    overrideLog.forEach(entry => {
        issues.push({
            objectId: "(rule override)",
            objectType: "",
            ruleId: "PRF-007",
            severity: "Info",
            score: 1,
            description: `Rule for '${entry.property}' on type '${entry.constrainedType}' from profile '${entry.overriddenProfile}' was overridden by profile '${entry.overridingProfile}'.`,
            location: "(profile metadata)",
            profileSource: entry.overridingProfile,
            suggestedCorrection: "Review profile load order if this override is unintended."
        });
    });

    mergedConstraints.forEach(c => {
        const { constrainedType, lower, property, profileName } = c;

        // Match objects by exact type or by type suffix
        const matching = flatTree.filter(node => {
            if (!node.type) return false;
            if (node.type === constrainedType) return true;
            // Allow matching by suffix, e.g. "PipingNetworkSystem" matches "Plant/Piping.PipingNetworkSystem"
            const typeSuffix = node.type.split(".").pop();
            const constraintSuffix = constrainedType.split(".").pop();
            return typeSuffix === constraintSuffix && typeSuffix !== constrainedType;
        });

        if (lower >= 1) {
            matching.forEach(node => {
                // Check if data property is present
                const shortProp = property.split(".").pop() || property;
                const hasProperty = node.data.some(d => {
                    const dp = d.property || "";
                    return dp === property || dp.endsWith("." + shortProp);
                });

                if (!hasProperty) {
                    const ruleId = `PRF-${profileName}-${shortProp}`;
                    const sev = resolveSeverity(ruleId, severityConfig) ||
                                resolveSeverity("PRF", severityConfig);
                    const loc = node.objectId
                        ? `//*[@id='${node.objectId}']`
                        : `(type: ${node.type})`;
                    issues.push({
                        objectId: node.objectId || "(no id)",
                        objectType: node.type,
                        ruleId,
                        severity: sev.level,
                        score: sev.score,
                        description: `Missing required property '${shortProp}' on object of type '${node.type}' (required by profile '${profileName}').`,
                        location: loc,
                        profileSource: profileName,
                        suggestedCorrection: `Add Data property '${property}' to this object.`
                    });
                }
            });
        }
    });

    return issues;
}

// ─── Full Validation Run ──────────────────────────────────────────────────────

export function runFullValidation({ mainXml, flatTree, profiles, severityConfig }) {
    // profiles = [{name, xml, constraints}]
    const allIssues = [];

    // Base validation
    const baseIssues = runBaseValidation(mainXml, flatTree, severityConfig);
    allIssues.push(...baseIssues);

    // Profile validation
    if (profiles.length > 0) {
        const profileSets = profiles.map(p => ({ name: p.name, constraints: p.constraints }));
        const { mergedConstraints, overrideLog } = mergeProfileConstraints(profileSets);
        const profileIssues = runProfileValidation(flatTree, mergedConstraints, overrideLog, severityConfig);
        allIssues.push(...profileIssues);
    }

    return allIssues;
}

// ─── CSV Export (RPT-002, RPT-003) ────────────────────────────────────────────

export function exportCSV(issues) {
    const headers = [
        "Object ID", "Object Type", "Rule ID", "Severity", "Severity Score",
        "Rule Description", "Location (XPath)", "Profile Source", "Suggested Correction"
    ];
    const escape = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = issues.map(i => [
        i.objectId, i.objectType, i.ruleId, i.severity, i.score,
        i.description, i.location, i.profileSource, i.suggestedCorrection
    ].map(escape).join(","));
    return [headers.join(","), ...rows].join("\r\n");
}

export function downloadCSV(issues, filename = "validation-report.csv") {
    const csv = exportCSV(issues);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
