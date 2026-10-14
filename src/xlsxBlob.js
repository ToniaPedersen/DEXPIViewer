// .xlsx writer for the browser - the same workbook the CLI writes, zipped
// with no compression (stored entries), so nothing outside the platform is
// needed. Excel reads stored entries exactly like deflated ones; the file is
// simply larger, which is fine for a findings list.

import { xlsxParts, crc32 } from "./xlsxParts.js";

const enc = new TextEncoder();

function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

/**
 * @param {{name:string, columns:{header:string,width?:number}[], rows:any[][]}[]} sheets
 * @returns {Blob} the .xlsx file, ready for a download link
 */
export function buildXlsxBlob(sheets) {
    const files = xlsxParts(sheets).map(p => ({ nameBytes: enc.encode(p.name), data: enc.encode(p.text) }));
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
        const crc = crc32(f.data);
        const local = [
            ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21),
            ...u32(crc), ...u32(f.data.length), ...u32(f.data.length),
            ...u16(f.nameBytes.length), ...u16(0),
        ];
        chunks.push(new Uint8Array(local), f.nameBytes, f.data);
        central.push(new Uint8Array([
            ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21),
            ...u32(crc), ...u32(f.data.length), ...u32(f.data.length),
            ...u16(f.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
        ]), f.nameBytes);
        offset += local.length + f.nameBytes.length + f.data.length;
    }

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array([
        ...u32(0x06054b50), ...u16(0), ...u16(0),
        ...u16(files.length), ...u16(files.length),
        ...u32(centralSize), ...u32(offset), ...u16(0),
    ]);

    return new Blob([...chunks, ...central, end], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
}
