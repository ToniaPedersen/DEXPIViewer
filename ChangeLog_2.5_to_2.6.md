# Changelog

## 2.6.0

Changes from version 2.5.0 (commit `37e4029` "Version 2.5"), including commits `afcd8c6` "Undid error for signal line styles and increased default line width." and `a9318fb` "Update App.jsx".

### Version

- The app is versioned as **2.6.0** (`package.json` / `package-lock.json` 2.6.0, User Guide). The version shows next to the title in the left panel (v2.6).
- `README.md` links only this changelog. The earlier changelogs stay in the repository.

### Topology tab: conceptual or graphical model

Two buttons at the top of the Topology tab, **Conceptual model** and **Graphical model**, choose which tree is shown.

- **Conceptual model** (default) is the tree as before: the engineering objects of the `ConceptualModel` part of the file.
- **Graphical model** is a new tree of the `Diagram` part of the file (`Core/EngineeringModel` > `Components[@property='Diagram']` > `Core/Diagram.Diagram`): every group, Profile/SymbolUsage, ShapeUsage, Text, ConnectorLine, PolyLine and node position, nested as in the file. If a file has more than one Diagram, they are shown under a common root.

Graphical objects rarely carry an id, so their nodes are named from what they draw: a RepresentationGroup or Label by the tag of the object it `Represents` (e.g. `D-20PA001`), a SymbolUsage/ShapeUsage by its symbol or shape (e.g. `PP003A`), a Text by its string, a node position by its node; anything else by its id or type (`Static`, `Border`). The type is shown on the right, and the tooltip gives the type, own id and represented object.

Search, **Expand all** / **Collapse all** and the object count work on the shown tree; each tree keeps its own expanded nodes. In the graphical tree the search also matches a graphical object's own id and its `Represents` target, and validation dots are shown on the nodes that directly represent an object with issues.

On DiscTest01_UnknownDataProps_PipingNetworkSystem.xml the conceptual tree has 570 objects and the graphical tree 987.

### Graphical tree linked to the drawing

Every drawn element now remembers the Diagram object it was built from, so the graphical tree and the drawing select each other:

- **Tree → drawing:** clicking a graphical node highlights exactly the elements built from that node and its sub-nodes, not every element of the represented object. A SymbolUsage such as `ND0002` highlights only that symbol; a RepresentationGroup highlights its whole content. The right panel shows the object the node (or its nearest enclosing group) represents. Nodes that represent nothing (Border, loose Static groups) are grey but can be clicked to highlight their graphics.
- **Drawing → tree:** clicking an element selects its object and its graphical node, expands the graphical tree down to it and scrolls it into view. In the graphical view, drawing elements without a `Represents` reference can be clicked as well.
- Any other selection (validation list, right panel, conceptual tree) clears the graphical node selection; highlighting then goes by object as before. In the conceptual view highlighting is unchanged.

On DiscTest01 with DiscProfile.xml loaded, all 139 drawn elements are linked to their graphical node.

- `src/dexpiParser.js`: new `parseTreeFromDiagram()` and `findDiagramAncestors()`; `collectGraphicalElements()` records each element's source Diagram object, and `parseDexpiPackage()` turns it into `element.diagramNodeId` (the source object reference is removed afterwards). `parseDexpiPackage()` also returns `diagramTree`, `diagramFlatCount`, `diagramNodeMap` and `diagramParent`.
- `src/App.jsx`: `topologyView` and `selectedGraphNodeId` state; `TreeNode` handles graphical nodes (`data-gnode-id`, `data-sel-id`); `selectGraphNode()`, `handleGraphTreeSelect()`, `handleDrawingSelect()`, `graphHighlightNodeIds`; `SymbolGraphic` / `PrimitiveGraphic` pass the clicked element to `onSelect`; Expand all / Collapse all act on the shown tree only; the tree scrolls to the selected node with `querySelector` instead of `getElementById`.

### Signal line styles and line width (commit `afcd8c6`)

- Lines never draw thinner than 1 screen pixel (`MIN_STROKE_PX`); thicker authored or boosted widths are kept.
- Signal-conveying marks follow the DISC decoration convention: glyphs ~2.5 mm tall, centred on the line, repeated every 6.5 mm starting 2.5 mm in (Bus circles r 1.25 mm every 10 mm starting 5 mm in), and a line too short for that gets one mark at its midpoint. Marks use the line's own colour and stroke width.
- The plain `SignalConveying` dash is 3 mm / 3 mm (was 3 / 2); DashStyle patterns are scaled by stroke width, floored at 0.1 mm. MeasuringLineFunction is always solid without marks.
- `src/App.jsx`, `src/dexpiParser.js`, `src/imageCompare.js` (image compare uses the same mark positions).

### Text inside placed symbols (commit `a9318fb`)

Text that is part of a placed symbol's own catalogue definition (e.g. ND0227's literal "TS") follows the same readability rule as the profile label overlays: always readable left-to-right / bottom-to-top under the placement's rotation and mirroring, never drawn with mirrored glyphs. Templated text keeps its absolute size; plain literal text still scales with the symbol. `src/App.jsx`: `renderPrimitive()`.

### User Guide

`public/UserGuide.md`: version line; 1 *Introduction* (topology tree); 4.1 *Topology Tab* (Conceptual model / Graphical model buttons, new *Graphical model* subsection); 5.2 *Selecting Objects*. `public/UserGuide.html`: title version.

### Files changed

`package.json`, `package-lock.json`, `README.md`, `ChangeLog_2.5_to_2.6.md` (new), `public/UserGuide.md`, `public/UserGuide.html`, `src/App.jsx`, `src/dexpiParser.js`, `src/imageCompare.js`.
