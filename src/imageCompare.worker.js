// Runs the PNG <-> DEXPI auto-fit and compare off the UI thread.
// Messages in:  { id, type: "autofit" | "compare", blob, cacheKey, geometry, initial?, placement?, options? }
// Messages out: { id, type: "progress", phase, done, total } | { id, type: "done", result } | { id, type: "error", message }
import { gridFactor, accumulateInk, runAutoFit, runCompare } from "./imageCompare.js";

let cache = null; // last decoded image: { key, ink, gw, gh, f, W, H }

async function inkGridFor(blob, key, post) {
    if (cache && key && cache.key === key) return cache;
    post({ type: "progress", phase: "Reading image", done: 0, total: 1 });
    const bmp = await createImageBitmap(blob);
    const W = bmp.width, H = bmp.height;
    const f = gridFactor(W, H);
    const gw = Math.ceil(W / f), gh = Math.ceil(H / f);
    const ink = new Uint8Array(gw * gh);
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const rows = Math.max(1, Math.floor((16 * 1024 * 1024) / (W * 4)));
    for (let y0 = 0; y0 < H; y0 += rows) {
        const r = Math.min(rows, H - y0);
        accumulateInk(ctx.getImageData(0, y0, W, r).data, W, r, y0, f, ink, gw);
        post({ type: "progress", phase: "Reading image", done: y0 + r, total: H });
    }
    cache = { key, ink, gw, gh, f, W, H };
    return cache;
}

self.onmessage = async (e) => {
    const { id, type, blob, cacheKey, geometry, initial, placement, options } = e.data || {};
    const post = (msg) => self.postMessage({ id, ...msg });
    try {
        const img = await inkGridFor(blob, cacheKey, post);
        const onProgress = (p) => post({ type: "progress", ...p });
        if (type === "autofit") {
            const res = runAutoFit({ ...img, geometry, initial, onProgress });
            post({ type: "done", result: { ...res, W: img.W, H: img.H } });
        } else if (type === "compare") {
            const res = runCompare({ ...img, placement, geometry, options, onProgress });
            const c = new OffscreenCanvas(res.diffW, res.diffH);
            c.getContext("2d").putImageData(new ImageData(res.diff, res.diffW, res.diffH), 0, 0);
            const diffBlob = await c.convertToBlob({ type: "image/png" });
            post({
                type: "done",
                result: { issues: res.issues, stats: res.stats, diffBlob, W: img.W, H: img.H, gridW: img.gw, gridH: img.gh, f: img.f },
            });
        } else {
            throw new Error(`Unknown job type "${type}".`);
        }
    } catch (err) {
        post({ type: "error", message: err?.message || String(err) });
    }
};
