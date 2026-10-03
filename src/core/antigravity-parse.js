'use strict';

const { decodeProtobuf } = require('./protobuf');

/**
 * 解析 Google Protobuf Duration (字段1=秒, 字段2=纳秒) 为毫秒。
 * @param {Buffer|Uint8Array} fieldBytes 已取出的 Duration 子消息片段
 */
function parseDurationMs(fieldBytes) {
    if (!fieldBytes) return 0;
    const d = decodeProtobuf(fieldBytes);
    const sec = d[1] || 0;
    const nanos = d[2] || 0;
    return sec * 1000 + Math.round(nanos / 1_000_000);
}

/**
 * 「唯一」的 gen_metadata 行的解析入口。
 * 全项目（会话全量分析 / 最新一条 / 累计聚合）都必须经由此函数，杜绝口径漂移。
 *
 * gen_metadata.usage 真实字段口径（已用反重力本地库逐条校验）：
 *   m4[2] = 本次请求中「未命中缓存」的冷输入 (cache miss)
 *   m4[5] = 本次请求中「命中上下文缓存」的输入 (cached input)
 *   两者之和才是本步真实的 Prompt 总量 (= m4[2] + m4[5])
 *   m4[3] = 输出 token（含思考）
 *   m4[9] = 思考 token
 *   m4[10] = 正文呈现 token
 *
 * @param {Buffer} rowData gen_metadata.data 原始二进制
 * @returns {object|null} 解析结果；结构不完整时返回 null
 */
function parseGenMetadataRow(rowData) {
    if (!rowData) return null;
    const top = decodeProtobuf(rowData);
    if (!top[1] || !top[1][0]) return null;
    const m1 = decodeProtobuf(top[1][0]);
    const m4 = m1[4] && m1[4][0] ? decodeProtobuf(m1[4][0]) : null;
    if (!m4) return null;

    const cacheMissTokens = m4[2] || 0;
    const cachedInputTokens = m4[5] || 0;

    // 时间戳（ISO 字符串；解析不出则为空串，由调用方决定默认值）
    let time = '';
    if (m1[9] && m1[9][0]) {
        const m9 = decodeProtobuf(m1[9][0]);
        if (m9[4] && m9[4][0]) {
            const timeMsg = decodeProtobuf(m9[4][0]);
            if (timeMsg[1]) {
                try { time = new Date(timeMsg[1] * 1000).toISOString(); } catch (e) { time = ''; }
            }
        }
    }

    // 模型名（原始未归一化；交由调用方 normalizeModelName）
    let model = 'Gemini';
    if (m1[21] && m1[21][0]) {
        model = Buffer.from(m1[21][0]).toString('utf8');
    } else if (m1[19] && m1[19][0]) {
        model = Buffer.from(m1[19][0]).toString('utf8');
    }

    return {
        time: time,
        model: model,
        inputTokens: cacheMissTokens + cachedInputTokens,
        outputTokens: m4[3] || 0,
        cachedInputTokens: cachedInputTokens,
        cacheMissTokens: cacheMissTokens,
        thinkingTokens: m4[9] || 0,
        lastOutputTokens: m4[10] || 0,
        elapsedMs: m1[11] && m1[11][0] ? parseDurationMs(m1[11][0]) : 0,
        ttftMs: m1[12] && m1[12][0] ? parseDurationMs(m1[12][0]) : 0
    };
}

module.exports = { parseDurationMs, parseGenMetadataRow };
