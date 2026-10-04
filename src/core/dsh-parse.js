'use strict';

// ==========================================
// DSH (DeepSeek Harness) 会话日志解析
// ------------------------------------------
// 数据位置：$DSH_HOME/sessions/<project>/<sessionId>/session.vN.jsonl.zstd
//   日志为「追加写入的多帧 zstd」：每追加一批事件就是一个新的 zstd frame，
//   因此必须逐帧解码再拼接，单帧解码只会拿到第一段。
// 计价口径参照 dsh-cost-meter：
//   - 五桶 token：cacheMiss(input) / cacheRead / cacheWrite / output / reasoning
//   - DeepSeek 官方峰谷两档；cacheWrite 与 cacheRead 同价；reasoning 免费
//   - 同一会话内 (model + 五桶) 指纹在 10s 窗口内只入账一次（包装层转发去重）
// ==========================================

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const log = require('./log');

const DSH_SOURCE = 'DSH';

// ── zstd 多帧解码 ────────────────────────────────────────────────────────────
const ZSTD_MAGIC = [0x28, 0xB5, 0x2F, 0xFD];
const ZSTD_AVAILABLE = typeof zlib.zstdDecompressSync === 'function';

/** 按 zstd 帧结构遍历，产出每个完整帧的字节区间（不依赖压缩数据里搜魔数）。 */
function* zstdFrames(buf) {
    let pos = 0;
    while (pos + 4 <= buf.length) {
        if (buf[pos] !== ZSTD_MAGIC[0] || buf[pos + 1] !== ZSTD_MAGIC[1] ||
            buf[pos + 2] !== ZSTD_MAGIC[2] || buf[pos + 3] !== ZSTD_MAGIC[3]) break;
        let p = pos + 4;
        const d = buf[p++];
        const fcsFlag = d >> 6;
        const singleSegment = (d >> 5) & 1;
        const hasChecksum = (d >> 2) & 1;
        const dictFlag = d & 3;
        if (!singleSegment) p += 1;                 // Window_Descriptor
        p += [0, 1, 2, 4][dictFlag];                // Dictionary_ID
        p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : (1 << fcsFlag); // Frame_Content_Size
        for (;;) {
            if (p + 3 > buf.length) return;
            const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
            p += 3;
            const blockSize = header >>> 3;
            p += blockSize;
            if (p > buf.length) return;
            if (header & 1) break;                  // Last_Block
        }
        if (hasChecksum) p += 4;
        if (p > buf.length) return;
        yield buf.slice(pos, p);
        pos = p;
    }
}

/**
 * 解码「多帧追加写入」的 zstd 数据（Node 22.15+ / 23.8+ 提供 zlib.zstdDecompressSync）。
 * @returns {Buffer|null} 运行环境不支持 zstd 时返回 null
 */
function zstdDecompressAll(buf) {
    if (!ZSTD_AVAILABLE) return null;
    try {
        const parts = [];
        for (const frame of zstdFrames(buf)) parts.push(zlib.zstdDecompressSync(frame));
        return Buffer.concat(parts);
    } catch (e) {
        throw new Error('zstd 多帧解码失败: ' + ((e && e.message) || e));
    }
}

/** Node 是否具备 zstd 解码能力（决定能否读取压缩会话日志）。 */
function zstdSupported() {
    return ZSTD_AVAILABLE;
}

// ── DSH 目录与会话日志发现 ───────────────────────────────────────────────────
function resolveDshHome() {
    if (process.env.DSH_HOME && fs.existsSync(process.env.DSH_HOME)) return process.env.DSH_HOME;
    const home = os.homedir();
    const candidates = [
        path.join(home, '.dsh'),
        path.join(process.env.USERPROFILE || home, '.dsh')
    ];
    for (const d of candidates) {
        if (fs.existsSync(d)) return d;
    }
    return null;
}

/**
 * 规范化会话日志文件名：session.jsonl[.zstd] / session.v3.jsonl.zstd …
 * @returns {{version:number, compressed:boolean}|null}
 */
function sessionLogGeneration(name) {
    const m = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/.exec(name);
    if (!m) return null;
    const version = Number(m[1] ?? 0);
    return Number.isSafeInteger(version) ? { version, compressed: Boolean(m[2]) } : null;
}

/**
 * 列出全部会话日志（每个会话只取版本最高的一份，与 dsh-cost-meter 同口径）。
 * @returns {Array<{sessionId:string, projectDir:string, filePath:string, version:number}>}
 */
function listSessionLogFiles(root) {
    const out = [];
    if (!root || !fs.existsSync(root)) return out;
    let projects = [];
    try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
    for (const project of projects) {
        if (!project.isDirectory()) continue;
        const projectDir = path.join(root, project.name);
        let sessions = [];
        try { sessions = fs.readdirSync(projectDir, { withFileTypes: true }); } catch (e) { continue; }
        for (const session of sessions) {
            if (!session.isDirectory()) continue;
            const dir = path.join(projectDir, session.name);
            let files = [];
            try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
            const candidates = files
                .filter(f => f.isFile())
                .map(f => ({ name: f.name, ...sessionLogGeneration(f.name) }))
                .filter(c => c.version !== undefined)
                .sort((a, b) => b.version - a.version || Number(b.compressed) - Number(a.compressed));
            if (candidates.length === 0) continue;
            const best = candidates[0];
            out.push({
                sessionId: session.name.replace(/^session-/, ''),
                projectDir: project.name,
                dir,
                filePath: path.join(dir, best.name),
                version: best.version
            });
        }
    }
    return out;
}

/** 读取并解析一份会话日志的全部事件。 */
function readSessionRecords(filePath) {
    const raw = fs.readFileSync(filePath);
    let text;
    if (raw.length >= 4 && raw[0] === ZSTD_MAGIC[0] && raw[1] === ZSTD_MAGIC[1] &&
        raw[2] === ZSTD_MAGIC[2] && raw[3] === ZSTD_MAGIC[3]) {
        const decoded = zstdDecompressAll(raw);
        if (decoded === null) return null;      // 运行环境不支持 zstd
        text = decoded.toString('utf8');
    } else {
        text = raw.toString('utf8');
    }
    const records = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const obj = JSON.parse(line);
            if (obj && typeof obj === 'object') records.push(obj);
        } catch (e) { /* 跳过损坏行（追加写入中断时可能残留半行） */ }
    }
    return records;
}

// ── 用量桶 ──────────────────────────────────────────────────────────────────
/**
 * DSH usage → 五桶。日志里 inputTokens 是「未命中缓存的输入」，
 * cacheReadTokens / cacheWriteTokens 与之互斥，totalTokens 为三者 + 输出之和。
 */
function bucketsFromUsage(usage) {
    const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    return {
        input: num(usage && usage.inputTokens),
        output: num(usage && usage.outputTokens),
        cacheRead: num(usage && usage.cacheReadTokens),
        cacheWrite: num(usage && usage.cacheWriteTokens),
        reasoning: num(usage && usage.reasoningTokens)
    };
}

// ── 计价：DeepSeek 峰谷两档 + 第三方 flat 价 ─────────────────────────────────
// 金额单位：美元或人民币 / 1M tokens；峰价 = 谷价 × 2（2026-09 官方档）。
const DEEPSEEK_OFF_PEAK = {
    USD: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    CNY: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
};
const PEAK_MULTIPLIER = 2;

/** 峰时段窗口（UTC 小时，半开区间）= 北京时间 9:00-12:00、14:00-18:00。 */
const DEFAULT_PEAK_WINDOWS = [{ start: 1, end: 4 }, { start: 6, end: 10 }];
/** 周末（北京时间周六/周日）全天谷价生效时刻。 */
const WEEKEND_OFFPEAK_EFFECTIVE_AT = Date.parse('2026-08-22T16:00:00Z');
/** 峰谷两档生效前（2026-08-16 16:00 UTC）的旧基础价。 */
const LEGACY_BASE_BOUNDARY = Date.parse('2026-08-16T16:00:00Z');
const LEGACY_BASE_PRICES = {
    USD: { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
    CNY: { cacheHit: 0.02, cacheMiss: 1, output: 2 }
};
/** 峰谷规则生效后剩余的中国公众假期（北京日历日），全天谷价。 */
const DEFAULT_PEAK_HOLIDAYS = [
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'
];

/** 北京时间日历日 key（YYYY-MM-DD）。 */
function beijingDayKey(atMs) {
    return new Date(atMs + 8 * 3600000).toISOString().slice(0, 10);
}

/** 是否处于「全天谷价」区间（周末 / 公众假期）。 */
function inOffPeakZone(atMs) {
    if (!Number.isFinite(atMs) || atMs < WEEKEND_OFFPEAK_EFFECTIVE_AT) return false;
    const day = Math.floor((atMs + 8 * 3600000) / 86400000);
    const weekday = (day + 4) % 7;              // 1970-01-01 是周四
    if (weekday === 6 || weekday === 0) return true;
    return DEFAULT_PEAK_HOLIDAYS.includes(beijingDayKey(atMs));
}

/** 某时刻是否处于峰时段。 */
function isPeakHour(atMs) {
    if (!Number.isFinite(atMs)) return false;
    if (inOffPeakZone(atMs)) return false;
    const hour = new Date(atMs).getUTCHours();
    return DEFAULT_PEAK_WINDOWS.some(w => hour >= w.start && hour < w.end);
}

/** 第三方 provider 的 flat 单价（USD / 1M tokens；两桶/三桶写法均支持）。 */
const PROVIDER_PRICE_TABLE = {
    'z-ai': {
        default: { input: 1.4, cachedInput: 0.26, output: 4.4 },
        models: {
            'glm-5.3': { input: 1.4, cachedInput: 0.26, output: 4.4 },
            'glm-5.3-flash': { input: 0.15, cachedInput: 0.03, output: 0.5 },
            'glm-5.2': { input: 1.4, cachedInput: 0.26, output: 4.4 },
            'glm-5.1': { input: 1.4, cachedInput: 0.26, output: 4.4 },
            'glm-5': { input: 1, cachedInput: 0.2, output: 3.2 }
        }
    },
    moonshot: {
        default: { input: 0.95, cachedInput: 0.16, output: 4 },
        models: {
            'kimi-k3': { input: 3, cachedInput: 0.3, output: 15 },
            'kimi-k2.7-code': { input: 0.95, cachedInput: 0.19, output: 4 },
            'kimi-k2.6': { input: 0.95, cachedInput: 0.16, output: 4 },
            'kimi-k2.5': { input: 0.6, cachedInput: 0.1, output: 3 }
        }
    },
    alibaba: {
        default: { input: 0.4, cachedInput: 0.05, output: 1.6 },
        models: {
            'qwen3.8-max': { input: 2, cachedInput: 0.25, output: 6 },
            'qwen3.7-max': { input: 2.5, cachedInput: 0.5, output: 7.5 },
            'qwen3.7-plus': { input: 0.4, cachedInput: 0.04, output: 1.6 },
            'qwen3.6-plus': { input: 0.5, cachedInput: 0.05, output: 3 },
            'qwen3.5-plus': { input: 0.2, cachedInput: 0.02, output: 1.2 },
            'qwen3-plus': { input: 0.4, output: 1.2 }
        }
    },
    minimax: {
        default: { input: 0.3, cachedInput: 0.06, output: 1.2 },
        models: {
            'minimax-m3': { input: 0.3, cachedInput: 0.06, output: 1.2 },
            'minimax-m2.7': { input: 0.3, cachedInput: 0.06, output: 1.2 },
            'minimax-m2.5': { input: 0.3, cachedInput: 0.06, output: 1.2 }
        }
    },
    xiaomi: {
        default: { input: 0.14, cachedInput: 0.0028, output: 0.28 },
        models: {
            'mimo-v2.6-pro': { input: 0.435, cachedInput: 0.0036, output: 0.87 },
            'mimo-v2.6-flash': { input: 0.14, cachedInput: 0.0028, output: 0.28 },
            'mimo-v2.5': { input: 0.14, cachedInput: 0.0028, output: 0.28 },
            'mimo-v2.5-pro': { input: 0.435, cachedInput: 0.003625, output: 0.87 }
        }
    },
    tencent: {
        default: { input: 0.14, cachedInput: 0.035, output: 0.58 },
        models: { 'hy3': { input: 0.14, cachedInput: 0.035, output: 0.58 } }
    },
    openai: { default: { input: 1.75, cachedInput: 0.175, output: 14 }, models: {} },
    anthropic: { default: { input: 3, cachedInput: 0.3, output: 15 }, models: {} },
    google: { default: { input: 0.75, cachedInput: 0.075, output: 3.75 }, models: {} }
};

/** 模型名 → 厂商（provider 缺失时按模型前缀兜底）。 */
const MODEL_VENDOR_PREFIXES = {
    openai: /^(?:gpt|o\d|codex)/i,
    anthropic: /^claude/i,
    google: /^gemini/i,
    deepseek: /^deepseek/i,
    moonshot: /^kimi/i,
    'z-ai': /^glm/i,
    xai: /^grok/i,
    alibaba: /^qwen/i,
    minimax: /^minimax/i,
    tencent: /^(?:hunyuan|hy\d)/i,
    xiaomi: /^mimo/i
};

/** modlens 视觉包装层：usage 会被上游再转发一次，需改挂到上游 provider 并去重。 */
function isWrapperProviderId(provider) {
    return typeof provider === 'string' && provider.length > 0 &&
        (provider.startsWith('modlens-') || provider === 'deepseek-modlens');
}
function wrapperUpstreamProvider(provider) {
    if (typeof provider !== 'string' || provider.length === 0) return null;
    if (provider === 'deepseek-modlens') return 'deepseek-official';
    if (provider.startsWith('modlens-')) {
        const upstream = provider.slice('modlens-'.length);
        return upstream.length > 0 ? upstream : null;
    }
    return null;
}

function normalizeProvider(raw) {
    const p = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return p.startsWith('llm-') ? p.slice(4) : p;
}

function canonModelId(id) {
    return String(id ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 解析一次调用的价格档位。
 * @returns {{entry:object|null, currency:'USD'|'CNY', peak:boolean, priced:boolean}}
 */
function resolvePriceTier(provider, model, atMs, currency) {
    const cur = currency === 'CNY' ? 'CNY' : 'USD';
    const prov = normalizeProvider(provider);
    const modelText = String(model || '');
    // provider 为 deepseek / 缺省，或模型名带 deepseek 前缀（经网关代理时 provider 可能是 wb2api 之类）
    const isDeepSeek = prov === '' || prov.includes('deepseek') ||
        (!prov || !PROVIDER_PRICE_TABLE[prov]) && MODEL_VENDOR_PREFIXES.deepseek.test(modelText);

    if (isDeepSeek) {
        // 峰谷时代之前一律按当时的基础价（历史正确性）
        if (Number.isFinite(atMs) && atMs < LEGACY_BASE_BOUNDARY) {
            return { entry: LEGACY_BASE_PRICES[cur], currency: cur, peak: false, priced: true };
        }
        const peak = isPeakHour(atMs);
        const base = DEEPSEEK_OFF_PEAK[cur];
        return {
            entry: peak
                ? { cacheHit: base.cacheHit * PEAK_MULTIPLIER, cacheMiss: base.cacheMiss * PEAK_MULTIPLIER, output: base.output * PEAK_MULTIPLIER }
                : base,
            currency: cur,
            peak,
            priced: true
        };
    }

    const table = PROVIDER_PRICE_TABLE[prov];
    if (table) {
        const hit = matchFlatEntry(table, model);
        if (hit) return { entry: hit, currency: 'USD', peak: false, priced: true };
    }
    // provider 未在价表登记：按模型前缀猜测厂商，命中不了则记为未定价
    for (const [vendor, re] of Object.entries(MODEL_VENDOR_PREFIXES)) {
        if (!re.test(String(model || ''))) continue;
        const hit = matchFlatEntry(PROVIDER_PRICE_TABLE[vendor] || { models: {} }, model);
        if (hit) return { entry: hit, currency: 'USD', peak: false, priced: true };
    }
    return { entry: null, currency: 'USD', peak: false, priced: false };
}

function matchFlatEntry(table, model) {
    const models = table.models || {};
    const key = String(model || '');
    if (Object.prototype.hasOwnProperty.call(models, key)) return models[key];
    const canon = canonModelId(key);
    for (const id of Object.keys(models)) {
        if (canonModelId(id) === canon) return models[id];
    }
    return table.default || null;
}

/**
 * 一次调用的成本（按价表币种计价）。cacheWrite 与 cacheRead 同价，reasoning 免费。
 * @returns {number} 按 currency 计价的金额
 */
function costOfBuckets(buckets, tier) {
    if (!tier || !tier.entry) return 0;
    const e = tier.entry;
    const cacheMiss = typeof e.cacheMiss === 'number' ? e.cacheMiss : (e.input || 0);
    const cacheHit = typeof e.cacheHit === 'number' ? e.cacheHit : (typeof e.cachedInput === 'number' ? e.cachedInput : cacheMiss);
    const output = typeof e.output === 'number' ? e.output : 0;
    const cost = (buckets.input * cacheMiss + buckets.cacheRead * cacheHit +
        buckets.cacheWrite * cacheHit + buckets.output * output) / 1e6;
    return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/** 把按价表币种计出的成本折算为美元（人民币价表 ÷ 汇率）。 */
function usdFromCost(cost, currency, exchangeRate) {
    const value = Math.max(0, Number(cost) || 0);
    if (currency !== 'CNY') return value;
    const rate = Number(exchangeRate);
    return value / (Number.isFinite(rate) && rate > 0 ? rate : 1);
}

/** 计价配置：币种与展示汇率（可用环境变量覆盖）。 */
function getPricingConfig() {
    const currency = String(process.env.DSH_COST_CURRENCY || 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY';
    const rate = Number(process.env.DSH_EXCHANGE_RATE);
    return { currency, exchangeRate: Number.isFinite(rate) && rate > 0 ? rate : 7.2 };
}

// ── 用量去重（包装层转发对：同指纹 10s 窗口内只入账一次） ────────────────────
const USAGE_DEDUP_WINDOW_MS = 10 * 1000;

function usageFingerprint(model, buckets) {
    return [String(model ?? ''), buckets.input, buckets.output, buckets.cacheRead, buckets.cacheWrite, buckets.reasoning].join('|');
}

function createUsageDeduper() {
    const books = new Map();
    return function admit(sessionId, model, buckets, atMs) {
        const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '';
        let book = books.get(key);
        if (!book) { book = new Map(); books.set(key, book); }
        for (const [fp, at] of book) {
            if (atMs - at > USAGE_DEDUP_WINDOW_MS) book.delete(fp);
        }
        const fp = usageFingerprint(model, buckets);
        if (book.has(fp)) return false;
        book.set(fp, atMs);
        return true;
    };
}

// ── 会话日志 → 调用明细 ─────────────────────────────────────────────────────
function firstText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        for (const item of value) {
            if (item && typeof item.text === 'string') return item.text;
            if (typeof item === 'string') return item;
        }
        return '';
    }
    if (value && typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (typeof value.content === 'string') return value.content;
    }
    return '';
}

/**
 * 从事件流中提取一次会话的元信息与逐次调用明细。
 * @returns {{header:object, calls:Array, title:string}|null}
 */
function extractSession(records) {
    if (!Array.isArray(records) || records.length === 0) return null;
    const header = records.find(r => r.type === 'session') || {};
    const sessionId = header.id || '';
    const dedup = createUsageDeduper();

    let lastConfig = { provider: '', model: '' };
    let title = '';
    let lastTurn = null;
    let lastStep = null;
    const calls = [];

    for (const r of records) {
        if (!r || typeof r.type !== 'string') continue;

        if (r.type === 'request/header') {
            const cfg = r.data && r.data.header && r.data.header.config;
            if (cfg) lastConfig = { provider: cfg.provider || '', model: cfg.model || '' };
            continue;
        }
        if (r.type === 'turn/start') {
            lastTurn = r.data && r.data.turn;
            continue;
        }
        if (r.type === 'user/message' && !title) {
            const text = firstText(r.data && (r.data.content ?? r.data.text ?? r.data.message));
            if (text) title = text.replace(/\s+/g, ' ').trim().slice(0, 80);
            continue;
        }

        const isAssistant = r.type === 'assistant/message';
        const isCompaction = r.type === 'compaction/summary' || r.type === 'compaction/llm-summary';
        if (!isAssistant && !isCompaction) continue;

        const usage = r.data && r.data.usage;
        if (!usage) continue;
        const buckets = bucketsFromUsage(usage);
        if (buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite === 0) continue;

        const src = (isAssistant && r.data.message && r.data.message.source) || {};
        let provider = src.provider || lastConfig.provider || '';
        if (isWrapperProviderId(provider)) provider = wrapperUpstreamProvider(provider) || provider;
        const model = src.model || lastConfig.model || '';
        const atMs = Number(r.time) || Number(header.createdAt) || Date.now();
        const turn = (r.data && r.data.turn !== undefined) ? r.data.turn : lastTurn;
        const step = (r.data && r.data.step !== undefined) ? r.data.step : lastStep;
        if (step !== null && step !== undefined) lastStep = step;

        if (!dedup(sessionId, model, buckets, atMs)) continue;

        calls.push({
            kind: isCompaction ? 'compaction' : 'assistant',
            provider: normalizeProvider(provider),
            model,
            atMs,
            turn,
            step,
            buckets
        });
    }

    return { header, calls, title };
}

// ── 投影缓存（zstd 不可用时的兜底：只有会话级总量） ──────────────────────────
function readProjcache(home, sessionId) {
    if (!home || !sessionId) return null;
    const file = path.join(home, 'storages', 'session_projcache', 'sessions', sessionId + '.json');
    if (!fs.existsSync(file)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const rows = raw && raw.record && raw.record.rows;
        if (!rows) return null;
        const totals = rows.tokenUsage && rows.tokenUsage.val && rows.tokenUsage.val.totals;
        const title = rows.title && rows.title.val;
        const identity = raw.record.identity || {};
        const stats = rows.sessionStats && rows.sessionStats.val;
        return { totals: totals || null, title: typeof title === 'string' ? title : '', identity, stats: stats || null };
    } catch (e) {
        return null;
    }
}

module.exports = {
    DSH_SOURCE,
    resolveDshHome,
    sessionLogGeneration,
    listSessionLogFiles,
    readSessionRecords,
    zstdDecompressAll,
    zstdSupported,
    bucketsFromUsage,
    isPeakHour,
    inOffPeakZone,
    beijingDayKey,
    resolvePriceTier,
    costOfBuckets,
    usdFromCost,
    getPricingConfig,
    createUsageDeduper,
    usageFingerprint,
    extractSession,
    readProjcache,
    PROVIDER_PRICE_TABLE,
    DEFAULT_PEAK_WINDOWS
};
