# Changelog

## 2.3.0

Changes from version 2.2.3 (commit `197d272`).

### Version

- The app is versioned as **2.3.0** (`package.json` / `package-lock.json` 2.3.0).
- The version shows next to the title in the left panel (v2.3) and in the User Guide.

### PRF-E05: profile connection points read the right way up

PRF-E05 checks that each PipingNodePosition sits on one of the connection points of the symbol placed for its component. It turned the symbol's connection points into drawing coordinates with the symbol's local Y negated, as if the symbol were drawn Y-up. The viewer draws symbols Y-down (`translate(position) rotate(rotation) scale(scaleX, scaleY)`, mirrored in X), and DEXPI 2.0 exports place them that way: DISC ND0227's connection point (0, 4) is written 4 below its SymbolUsage in the Aibel reference export. So every connection point above or below a symbol's origin was expected on the wrong side, and node positions that were right were reported.

| | 2.2.3 | 2.3.0 |
|---|---|---|
| Symbol-local to drawing, Y | `posY − lx·sin − ly·cos` | `posY + lx·sin + ly·cos` |
| Symbol-local to drawing, X | `posX + lx·cos − ly·sin` | unchanged |
| Auxiliary (actuator) connection points | same transform | same transform |

Example: `NodePosition 'SP__0000_1_08_96706_OBJ_5W2F7F_1_PNP' at (487, 61) does not align with any profile connection point of symbol 'XB_CONT_BLOCK_3strokes' placed at (487, 47.6). Expected: (487.00, 34.20)`. The connector's pipe joins the bottom of its box, local (0, 13.4): 2.2.3 expected it at the top (34.2), 2.3.0 at the bottom (61), where it is.

Results with the change:

| File (profile) | PRF-E05, 2.2.3 | PRF-E05, 2.3.0 |
|---|---|---|
| `0000-1-08-96706-rev4` (its `profile.xml`) | 5 | 0 |
| `UPP-AIL-P-XB-24050-01.enhanced` reference (DiscProfile) | 30 | 8 |

The 8 left on the Aibel reference are the flange taps of two orifice plates (ND0135): node positions the symbol has no connection point for, reported as before.

The transform probably dates from the Proteus era, where drawings and symbols were Y-up.

Implementation (`src/validation.js`, PRF-E05): `toWorld()` now gives `y: posY + lx * sin + ly * cos`; its comment says why.
