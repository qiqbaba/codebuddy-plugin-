'use strict';

// ==========================================
// 轻量纯 JS Protobuf 二进制解码器 (零外部依赖)
// 支持 varint / length-delimited / 64-bit / 32-bit
// 返回 { 字段号: 值 | [子片段...] }
// ==========================================
function decodeProtobuf(buf) {
    let pos = 0;
    const fields = {};
    if (!buf || (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array))) return fields;

    while (pos < buf.length) {
        let tag = 0, shift = 0;
        while (pos < buf.length) {
            const b = buf[pos++];
            tag |= (b & 0x7F) << shift;
            if (!(b & 0x80)) break;
            shift += 7;
        }
        const wt = tag & 7;
        const fn = tag >> 3;
        if (fn === 0) break;

        if (wt === 0) { // Varint
            let val = 0n, vshift = 0n;
            while (pos < buf.length) {
                const b = BigInt(buf[pos++]);
                val |= (b & 0x7Fn) << vshift;
                if (!(b & 0x80n)) break;
                vshift += 7n;
            }
            fields[fn] = Number(val);
        } else if (wt === 2) { // Length-delimited
            let len = 0, lshift = 0;
            while (pos < buf.length) {
                const b = buf[pos++];
                len |= (b & 0x7F) << lshift;
                if (!(b & 0x80)) break;
                lshift += 7;
            }
            if (pos + len > buf.length) break;
            const chunk = buf.subarray(pos, pos + len);
            pos += len;
            if (!fields[fn]) fields[fn] = [];
            fields[fn].push(chunk);
        } else if (wt === 1) { // 64-bit
            pos += 8;
        } else if (wt === 5) { // 32-bit
            pos += 4;
        } else {
            break;
        }
    }
    return fields;
}

module.exports = { decodeProtobuf };
