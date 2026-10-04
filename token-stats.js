#!/usr/bin/env node

/**
 * Token Usage Analyzer for CodeBuddy & Antigravity (反重力)
 * 深度解析并全景展示 AI 编程工具的全维度 Token 数据：
 *   1. inputTokens (输入总量 / Prompt Tokens)
 *   2. outputTokens (输出总量 / Completion Tokens)
 *   3. totalTokens (总消耗 Tokens)
 *   4. cachedInputTokens (上下文缓存命中 Tokens)
 *   5. cacheMissTokens (未命中冷输入 Tokens)
 *   6. cacheWriteTokens (缓存写入 Tokens)
 *   7. thinkingTokens (深度思考 / 思维链 Reasoning Tokens)
 *   8. lastOutputTokens / textTokens (最终正文呈现 Tokens)
 *   9. lastStepInputTokens (最终单步上下文)
 *  10. lastStepOutputTokens (最终单步输出)
 *  11. quotaInfo (反重力官方配额余量 %、重置时间与上下文上限)
 *  12. credit & elapsedMs & 生成速率 (Token/s)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');

let DatabaseSync;
try {
    const sqlite = require('node:sqlite');
    DatabaseSync = sqlite.DatabaseSync;
} catch (e) {
    // Node.js < 22.5 fallback
}

// 脚本构建标识：用于识别本地后台服务是否为「当前版本」的进程。
// 若端口上跑的是旧进程(或非本工具的进程)，页面上的「刷新 / 刷新积分」会静默失效，
// 因此这里用脚本自身的修改时间作为版本标记，供 /api/heartbeat 与 /api/version 上报。
const SCRIPT_BUILD_ID = (() => {
    try { return String(fs.statSync(__filename).mtimeMs); } catch (e) { return 'unknown'; }
})();

// ==========================================
// 1. 轻量纯 JS Protobuf 二进制解码器 (零外部依赖)
// ==========================================
// 统一日志出口（替换分散的静默 catch）
const log = require('./src/core/log');
// gen_metadata 解析入口（唯一），会话全量 / 最新一条 / 累计聚合共用
const { parseGenMetadataRow } = require('./src/core/antigravity-parse');
// CodeBuddy assistant 消息解析入口（唯一）
const { parseCodeBuddyAssistantMessage } = require('./src/core/codebuddy-parse');
// DSH (DeepSeek Harness) 会话日志解析入口（唯一）
const {
    DSH_SOURCE,
    resolveDshHome,
    listSessionLogFiles,
    readSessionRecords,
    zstdSupported,
    isPeakHour,
    resolvePriceTier,
    costOfBuckets,
    usdFromCost,
    getPricingConfig,
    extractSession,
    readProjcache
} = require('./src/core/dsh-parse');

// ==========================================
// 模型名称规范化与别名归一化 (防止 API ID 与 Display Name 分裂)
// ==========================================
// 模型别名 / 归一化 / 上下文上限已外置到 src/core/models.js 集中管理
const {
    normalizeModelName,
    getModelMaxTokens: resolveModelMaxTokens,
    loadModelLimitOverrides
} = require('./src/core/models');

function sanitizeCachedConversation(res) {
    if (!res || !res.turns) return { res, needsFix: false };
    let needsFix = false;
    for (const t of res.turns) {
        const norm = normalizeModelName(t.model);
        if (norm !== t.model) {
            t.model = norm;
            needsFix = true;
        }
    }
    if (res.selectedModelId) {
        const normSelected = normalizeModelName(res.selectedModelId);
        if (normSelected !== res.selectedModelId) {
            res.selectedModelId = normSelected;
            needsFix = true;
        }
    }
    if (needsFix) {
        const newModels = {};
        for (const t of res.turns) {
            if (!newModels[t.model]) {
                newModels[t.model] = {
                    turns: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedInputTokens: 0,
                    cacheMissTokens: 0,
                    cacheWriteTokens: 0,
                    thinkingTokens: 0,
                    lastOutputTokens: 0,
                    totalTokens: 0,
                    credit: 0,
                    elapsedMs: 0
                };
            }
            const m = newModels[t.model];
            m.turns += 1;
            m.inputTokens += (t.inputTokens || 0);
            m.outputTokens += (t.outputTokens || 0);
            m.cachedInputTokens += (t.cachedInputTokens || 0);
            m.cacheMissTokens += (t.cacheMissTokens || 0);
            m.cacheWriteTokens += (t.cacheWriteTokens || 0);
            m.thinkingTokens += (t.thinkingTokens || 0);
            m.lastOutputTokens += (t.lastOutputTokens || 0);
            m.totalTokens += (t.totalTokens || 0);
            m.credit += (t.credit || 0);
            m.elapsedMs += (t.elapsedMs || 0);
        }
        res.models = newModels;
    }
    return { res, needsFix };
}

// ==========================================
// 2. 反重力 (Antigravity) 数据采集与会话解析
// ==========================================
function getAntigravityConversationDirs() {
    const home = os.homedir();
    const candidateDirs = [
        path.join(home, '.gemini', 'antigravity-ide', 'conversations'),
        path.join(home, '.gemini', 'antigravity', 'conversations'),
        path.join(home, '.gemini', 'antigravity-cli', 'conversations')
    ];
    return candidateDirs.filter(d => fs.existsSync(d));
}

function getAntigravityQuotaInfo() {
    const home = os.homedir();
    // 优先查找反重力 IDE，其次是 Gemini CLI (antigravity)，最后是 antigravity-cli
    const quotaFileCandidates = [
        path.join(home, '.gemini', 'antigravity-ide', 'debug_fetchAvailableModels.json'),
        path.join(home, '.gemini', 'antigravity', 'debug_fetchAvailableModels.json'),
        path.join(home, '.gemini', 'antigravity-cli', 'debug_fetchAvailableModels.json')
    ];
    const quotaFile = quotaFileCandidates.find(f => fs.existsSync(f));
    if (!quotaFile) return null;

    try {
        const raw = JSON.parse(fs.readFileSync(quotaFile, 'utf8'));
        if (!raw || !raw.models) return null;

        let quota = {
            defaultModelKey: null,
            defaultDisplayName: null,
            remainingFraction: null,
            remainingPercent: null,
            resetTime: null,
            resetTimeLocal: null,
            maxTokens: 1048576,
            maxOutputTokens: 65536,
            models: {}
        };

        for (const [key, m] of Object.entries(raw.models)) {
            // 过滤补全小模型和内部调试通道，保持模型选择列表纯粹实用
            if (key.startsWith('tab_') || key.startsWith('chat_')) continue;

            const q = m.quotaInfo;
            const hasQuota = q && typeof q.remainingFraction === 'number';
            
            let resetLocal = null;
            if (q && q.resetTime) {
                try { resetLocal = new Date(q.resetTime).toLocaleString(); } catch (e) {}
            }

            quota.models[key] = {
                key: key,
                displayName: m.displayName || key,
                maxTokens: m.maxTokens || 1048576,
                maxOutputTokens: m.maxOutputTokens || 65536,
                remainingFraction: hasQuota ? q.remainingFraction : null,
                remainingPercent: hasQuota ? (q.remainingFraction * 100).toFixed(1) + '%' : null,
                resetTime: q ? q.resetTime : null,
                resetTimeLocal: resetLocal
            };
        }

        // 尝试附加周额度数据（来自 debug_retrieveUserQuotaSummary.json）
        try {
            const summaryCandidates = [
                path.join(home, '.gemini', 'antigravity-ide', 'debug_retrieveUserQuotaSummary.json'),
                path.join(home, '.gemini', 'antigravity', 'debug_retrieveUserQuotaSummary.json'),
                path.join(home, '.gemini', 'antigravity-cli', 'debug_retrieveUserQuotaSummary.json')
            ];
            const summaryFile = summaryCandidates.find(f => fs.existsSync(f));
            if (summaryFile) {
                const sRaw = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
                const groups = sRaw.groups || sRaw.response?.groups || (Array.isArray(sRaw) ? sRaw : null);
                if (groups && Array.isArray(groups)) {
                    for (const m of Object.values(quota.models)) {
                        const mNorm = (m.displayName || m.key || '').toLowerCase();
                        let grp = null;
                        if (mNorm.includes('claude') || mNorm.includes('gpt')) {
                            grp = groups.find(g => /claude|gpt/i.test(g.displayName));
                        } else if (mNorm.includes('gemini')) {
                            grp = groups.find(g => /gemini/i.test(g.displayName));
                        }
                        if (!grp) grp = groups[0];
                        if (grp && Array.isArray(grp.buckets)) {
                            const wBucket = grp.buckets.find(b => /week|周/i.test(b.displayName));
                            if (wBucket) {
                                const wFrac = wBucket.remainingFraction ?? wBucket.remaining?.remainingFraction ?? wBucket.remaining?.value;
                                if (typeof wFrac === 'number') {
                                    const wPct = Math.round(wFrac * 1000) / 10;
                                    m.weeklyFraction = wFrac;
                                    m.weeklyPercent = (wPct % 1 === 0 ? wPct.toFixed(0) : wPct.toFixed(1)) + '%';
                                    m.weeklyResetTime = wBucket.resetTime || null;
                                    m.weeklyDescription = wBucket.description || '';
                                    if (wBucket.resetTime) {
                                        try { m.weeklyResetLocal = new Date(wBucket.resetTime).toLocaleString(); } catch (e) {}
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {}

        // 确定默认展示的主力模型：
        // 优先次序：gemini-3.8-flash-high -> gemini-3.7-flash-high -> 包含 gemini-3.8 -> 包含 gemini 且有配额 -> 首个有配额的模型
        const modelKeys = Object.keys(quota.models);
        let selectedKey = modelKeys.find(k => k === 'gemini-3.8-flash-high');
        if (!selectedKey) selectedKey = modelKeys.find(k => k.includes('gemini-3.8-flash'));
        if (!selectedKey) selectedKey = modelKeys.find(k => k === 'gemini-3.7-flash-high');
        if (!selectedKey) selectedKey = modelKeys.find(k => k.includes('gemini-3.7-flash'));
        if (!selectedKey) selectedKey = modelKeys.find(k => k.includes('gemini') && quota.models[k].remainingFraction !== null);
        if (!selectedKey) selectedKey = modelKeys.find(k => quota.models[k].remainingFraction !== null);
        if (!selectedKey && modelKeys.length > 0) selectedKey = modelKeys[0];

        if (selectedKey && quota.models[selectedKey]) {
            const def = quota.models[selectedKey];
            quota.defaultModelKey = selectedKey;
            quota.defaultDisplayName = def.displayName;
            quota.remainingFraction = def.remainingFraction;
            quota.remainingPercent = def.remainingPercent;
            quota.resetTime = def.resetTime;
            quota.resetTimeLocal = def.resetTimeLocal;
            quota.maxTokens = def.maxTokens;
            quota.maxOutputTokens = def.maxOutputTokens;
            quota.weeklyFraction = def.weeklyFraction || null;
            quota.weeklyPercent = def.weeklyPercent || null;
            quota.weeklyResetTime = def.weeklyResetTime || null;
            quota.weeklyResetLocal = def.weeklyResetLocal || null;
        }

        return quota;
    } catch (e) {
        return null;
    }
}

/**
 * 根据模型名称匹配其最大上下文上限 (maxTokens)
 * 优先从 debug_fetchAvailableModels.json 读取，若无则根据主流大模型系列智能回退
 */
function getModelMaxTokens(modelName) {
    return resolveModelMaxTokens(modelName, getAntigravityQuotaInfo());
}

// ==========================================
// CodeBuddy 官方套餐与积分额度管理器 (反重力 IDE 插件优先 + 多源自适应)
// 官方账单 API：
//   1. POST https://www.codebuddy.cn/billing/meter/get-user-resource-summary
//   2. POST https://www.codebuddy.cn/billing/meter/get-user-resource-free-packages
//   3. POST https://www.codebuddy.cn/billing/meter/get-user-resource-paid-packages
//   4. POST https://copilot.tencent.com/v2/billing/meter/checkin-activity-status
// ==========================================
// 数据目录：CLI 模式默认为当前工作目录；VSCode 扩展模式会调用 setDataDir() 切到 globalStorage，
// 避免把缓存文件写进 VSCode 的启动目录。
let DATA_DIR = process.cwd();
let REPORT_OUTPUT_PATH = path.join(DATA_DIR, 'token-report.html');
let ANTIGRAVITY_CACHE_FILE = path.join(DATA_DIR, '.antigravity-token-cache.json');
let DSH_CACHE_FILE = path.join(DATA_DIR, '.dsh-token-cache.json');
let CODEBUDDY_CREDITS_CACHE_FILE = path.join(DATA_DIR, '.codebuddy-credits-cache.json');

function setDataDir(dir) {
    if (!dir) return;
    DATA_DIR = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    CODEBUDDY_CREDITS_CACHE_FILE = path.join(dir, '.codebuddy-credits-cache.json');
    POINTS_TASKS_CACHE_FILE = path.join(dir, '.codebuddy-points-tasks-cache.json');
    AUTO_CHECKIN_CACHE_FILE = path.join(dir, '.codebuddy-auto-checkin-cache.json');
    ANTIGRAVITY_CACHE_FILE = path.join(dir, '.antigravity-token-cache.json');
    DSH_CACHE_FILE = path.join(dir, '.dsh-token-cache.json');
    REPORT_OUTPUT_PATH = path.join(dir, 'token-report.html');
    // 可选：模型上下文上限用户覆盖表（<dataDir>/model-limits.json）
    loadModelLimitOverrides(path.join(dir, 'model-limits.json'));
}

function getCodeBuddyCreditsInfo() {
    // 1. 优先读取工作区缓存
    if (fs.existsSync(CODEBUDDY_CREDITS_CACHE_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(CODEBUDDY_CREDITS_CACHE_FILE, 'utf8'));
            if (raw && typeof raw.totalCredits === 'number') {
                return raw;
            }
        } catch (e) {}
    }

    // 2. 备选路径
    const candidatePaths = [
        path.join(os.homedir(), '.codebuddy-credits-cache.json'),
        path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'credits-cache.json'),
        path.join(os.homedir(), '.local', 'share', 'CodeBuddyExtension', 'credits-cache.json'),
        path.join(os.homedir(), '.config', 'CodeBuddyExtension', 'credits-cache.json')
    ];
    for (const cp of candidatePaths) {
        if (fs.existsSync(cp)) {
            try {
                const raw = JSON.parse(fs.readFileSync(cp, 'utf8'));
                if (raw && typeof raw.totalCredits === 'number') return raw;
            } catch (e) {}
        }
    }

    return null;
}

// ------------------------------------------
// 自定义 / 手动配置凭据支持 (针对 Linux / 远程 SSH / 容器无桌面环境)
// ------------------------------------------
let customSession = null;

function setCustomSession(session) {
    if (!session) {
        customSession = null;
        return;
    }
    const token = session.accessToken || session.token;
    if (!token) {
        customSession = null;
        return;
    }
    const uid = session.uid || extractUidFromJwt(token) || '0';
    customSession = {
        accessToken: token,
        uid: String(uid),
        source: 'manual-config'
    };
}

function getCustomSession() {
    return customSession;
}

function extractUidFromJwt(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length >= 2) {
        try {
            const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
            return payload.uid || payload.sub || payload.userId || payload.user_id || (payload.account && payload.account.uid) || null;
        } catch (_) {}
    }
    return null;
}

function getConfiguredOrManualSession() {
    if (customSession) return customSession;

    // 1. 环境变量优先
    if (process.env.CODEBUDDY_ACCESS_TOKEN) {
        const token = process.env.CODEBUDDY_ACCESS_TOKEN.trim();
        const uid = process.env.CODEBUDDY_UID ? process.env.CODEBUDDY_UID.trim() : (extractUidFromJwt(token) || '0');
        return {
            accessToken: token,
            uid: String(uid),
            source: 'env-var'
        };
    }

    // 2. 本地 Token 凭据文件候选
    const home = os.homedir();
    const candidateFiles = [
        path.join(home, '.codebuddy-token.json'),
        path.join(home, '.codebuddy-token'),
        path.join(home, '.config', 'CodeBuddyExtension', 'token.json'),
        path.join(home, '.local', 'share', 'CodeBuddyExtension', 'token.json')
    ];
    for (const f of candidateFiles) {
        if (!fs.existsSync(f)) continue;
        try {
            const content = fs.readFileSync(f, 'utf8').trim();
            if (!content) continue;
            if (content.startsWith('{')) {
                const parsed = JSON.parse(content);
                const token = parsed.accessToken || parsed.token || (parsed.auth && parsed.auth.accessToken);
                if (token && typeof token === 'string') {
                    const uid = parsed.uid || (parsed.account && parsed.account.uid) || extractUidFromJwt(token) || '0';
                    return {
                        accessToken: token,
                        uid: String(uid),
                        source: 'token-file'
                    };
                }
            } else if (content.length > 20) {
                const uid = extractUidFromJwt(content) || '0';
                return {
                    accessToken: content,
                    uid: String(uid),
                    source: 'token-file'
                };
            }
        } catch (_) {}
    }

    return null;
}

// ------------------------------------------
// 凭据解密：Windows DPAPI + Chromium v10 AES-GCM
// ------------------------------------------
function getAntigravityMasterKey() {
    if (process.platform !== 'win32') return null; // Windows DPAPI 仅限 Windows
    const candidateLocalStates = [
        path.join(process.env.APPDATA || '', 'Antigravity IDE', 'Local State'),
        path.join(process.env.APPDATA || '', 'Code', 'Local State'),
        path.join(process.env.APPDATA || '', 'Cursor', 'Local State')
    ];
    for (const lsp of candidateLocalStates) {
        if (!fs.existsSync(lsp)) continue;
        try {
            const localState = JSON.parse(fs.readFileSync(lsp, 'utf8'));
            const b64Key = localState.os_crypt && localState.os_crypt.encrypted_key;
            if (!b64Key) continue;
            const encryptedKeyWithHeader = Buffer.from(b64Key, 'base64');
            const dpapiCiphertext = encryptedKeyWithHeader.subarray(5); // 跳过 'DPAPI' (5 bytes)
            const b64Input = dpapiCiphertext.toString('base64');
            const psScript = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${b64Input}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
            const b64MasterKey = execSync(`powershell -NoProfile -Command "${psScript}"`, { encoding: 'utf8' }).trim();
            if (b64MasterKey) {
                return { masterKey: Buffer.from(b64MasterKey, 'base64'), appDataDir: path.dirname(lsp) };
            }
        } catch (e) {}
    }
    return null;
}

function decryptChromiumV10(buf, masterKey) {
    if (!buf || buf.length < 3 + 12 + 16) return null;
    const header = buf.subarray(0, 3).toString('utf8');
    if (header !== 'v10') return null;
    const nonce = buf.subarray(3, 15);
    const tag = buf.subarray(buf.length - 16);
    const ciphertext = buf.subarray(15, buf.length - 16);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (e) {
        return null;
    }
}

// ------------------------------------------
// 来源 1：反重力 IDE / VS Code 插件 SecretStorage 凭据 (首选)
// ------------------------------------------
function getAntigravityPluginSession() {
    if (!DatabaseSync) return null;

    // 1. Windows: 尝试 DPAPI 解密
    if (process.platform === 'win32') {
        const keyInfo = getAntigravityMasterKey();
        if (keyInfo) {
            const { masterKey, appDataDir } = keyInfo;
            const candidateDbs = [
                path.join(appDataDir, 'User', 'globalStorage', 'state.vscdb'),
                path.join(process.env.APPDATA || '', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
                path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'state.vscdb')
            ];

            for (const dbPath of candidateDbs) {
                if (!fs.existsSync(dbPath)) continue;
                try {
                    const db = new DatabaseSync(dbPath, { readOnly: true });
                    const key = 'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"Tencent-Cloud.coding-copilot.new.accessToken"}';
                    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
                    if (!row || !row.value) continue;

                    const parsed = JSON.parse(row.value);
                    const secretBuf = Buffer.from(parsed.data || parsed);
                    const decryptedText = decryptChromiumV10(secretBuf, masterKey);
                    if (!decryptedText) continue;

                    const tokenObj = JSON.parse(decryptedText);
                    const accessToken = tokenObj.auth?.accessToken || tokenObj.token;
                    const uid = tokenObj.account?.uid || tokenObj.uid;
                    if (accessToken && uid) {
                        return {
                            accessToken,
                            uid: String(uid),
                            refreshToken: tokenObj.auth?.refreshToken || tokenObj.refreshToken,
                            expiresAt: tokenObj.auth?.expiresAt || tokenObj.expiresAt,
                            nickname: tokenObj.account?.nickname || tokenObj.account?.name,
                            source: 'antigravity-plugin'
                        };
                    }
                } catch (e) {}
            }
        }
    }

    // 2. Linux / macOS 候选（如果以基础明文或未加密存储，例如 --password-store=basic）
    const home = os.homedir();
    const candidateDbs = [
        path.join(home, '.config', 'Code', 'User', 'globalStorage', 'state.vscdb'),
        path.join(home, '.config', 'Code - OSS', 'User', 'globalStorage', 'state.vscdb'),
        path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
        path.join(home, '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
        path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb')
    ];
    for (const dbPath of candidateDbs) {
        if (!fs.existsSync(dbPath)) continue;
        try {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            const key = 'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"Tencent-Cloud.coding-copilot.new.accessToken"}';
            const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
            if (!row || !row.value) continue;

            let text = '';
            try {
                const parsed = JSON.parse(row.value);
                if (typeof parsed === 'object') {
                    const buf = Buffer.from(parsed.data || parsed);
                    text = buf.toString('utf8');
                } else if (typeof parsed === 'string') {
                    text = parsed;
                }
            } catch (_) {
                text = String(row.value);
            }
            if (text) {
                try {
                    const tokenObj = JSON.parse(text);
                    const accessToken = tokenObj.auth?.accessToken || tokenObj.token;
                    const uid = tokenObj.account?.uid || tokenObj.uid || extractUidFromJwt(accessToken);
                    if (accessToken && uid) {
                        return {
                            accessToken,
                            uid: String(uid),
                            refreshToken: tokenObj.auth?.refreshToken || tokenObj.refreshToken,
                            expiresAt: tokenObj.auth?.expiresAt || tokenObj.expiresAt,
                            nickname: tokenObj.account?.nickname || tokenObj.account?.name,
                            source: 'antigravity-plugin'
                        };
                    }
                } catch (_) {}
            }
        } catch (e) {}
    }

    return null;
}

// ------------------------------------------
// 来源 2：WorkBuddy 独立桌面端 / CLI 本地凭据 (次选，全面适配 Linux / macOS / Windows)
// ------------------------------------------
function getWorkBuddyDesktopSession() {
    const home = os.homedir();
    const candidatePaths = [
        path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
        path.join(process.env.LOCALAPPDATA || '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info'),
        path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
        path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info'),
        path.join(home, '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
        path.join(home, '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info'),
        path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
        path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info')
    ];
    for (const p of candidatePaths) {
        if (!fs.existsSync(p)) continue;
        try {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (raw && raw.auth && raw.account) {
                const token = raw.auth.accessToken;
                if (typeof token === 'string' && token.length > 20) {
                    return {
                        accessToken: token,
                        uid: String(raw.account.uid),
                        source: 'workbuddy-desktop'
                    };
                }
            }
        } catch (e) {}
    }
    return null;
}

// ------------------------------------------
// 官方 API 积分与配额直连拉取器
// ------------------------------------------
async function fetchCodeBuddyCreditsViaApi(session) {
    const { accessToken, uid } = session;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'X-User-Id': uid,
        'X-Client-Platform': 'web'
    };

    // 1. 获取套餐概览与配额汇总
    const summaryRes = await fetch('https://www.codebuddy.cn/billing/meter/get-user-resource-summary', {
        method: 'POST',
        headers,
        body: '{}'
    });
    if (!summaryRes.ok) {
        throw new Error(`Summary API 状态码异常: HTTP ${summaryRes.status}`);
    }
    const summary = await summaryRes.json();
    if (summary.code !== 0) {
        throw new Error(`Summary API 业务异常: ${summary.msg || summary.code}`);
    }

    const pkgCodes = (summary.data?.Packages || []).map(p => p.PackageCode).filter(Boolean);

    // 2. 免费套餐详情 (需传递 PackageCodes)
    let free = { data: { Accounts: [] } };
    try {
        const freeRes = await fetch('https://www.codebuddy.cn/billing/meter/get-user-resource-free-packages', {
            method: 'POST',
            headers,
            body: JSON.stringify({ PackageCodes: pkgCodes, PageNumber: 1, PageSize: 200, Status: [0] })
        });
        if (freeRes.ok) free = await freeRes.json();
    } catch (e) {}

    // 3. 付费套餐详情 (需传递 PackageCodes)
    let paid = { data: { Accounts: [] } };
    try {
        const paidRes = await fetch('https://www.codebuddy.cn/billing/meter/get-user-resource-paid-packages', {
            method: 'POST',
            headers,
            body: JSON.stringify({ PackageCodes: pkgCodes, PageNumber: 1, PageSize: 200, Status: [0, 3], NeedRenewInfo: true })
        });
        if (paidRes.ok) paid = await paidRes.json();
    } catch (e) {}

    // 4. 每日签到与成长状态 (可选辅助增强)
    let checkin = null;
    try {
        const checkinRes = await fetch('https://copilot.tencent.com/v2/billing/meter/checkin-activity-status', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'X-User-Id': uid
            },
            body: '{}'
        });
        if (checkinRes.ok) checkin = await checkinRes.json();
    } catch (e) {}

    const parsed = parseCodeBuddyCreditsResponse({
        summary,
        free,
        paid,
        checkin,
        source: session.source || 'antigravity-plugin'
    });
    fs.writeFileSync(CODEBUDDY_CREDITS_CACHE_FILE, JSON.stringify(parsed, null, 2), 'utf8');
    return parsed;
}

// ==========================================
// CodeBuddy 积分任务自动化引擎 (每日签到 + 成长中心全部奖励)
// 登录态直接复用反重力 IDE 插件 / WorkBuddy 桌面端凭据，无需安装 WorkBuddy 客户端。
// 接口契约与官方客户端一致，全程幂等安全：先查状态、未领才领、重复执行不会多领。
// ==========================================
let POINTS_TASKS_CACHE_FILE = path.join(DATA_DIR, '.codebuddy-points-tasks-cache.json');
// 每日自动签到：记录「当天是否已处理」，避免同一自然日内重复请求官方接口
let AUTO_CHECKIN_CACHE_FILE = path.join(DATA_DIR, '.codebuddy-auto-checkin-cache.json');
const COPILOT_ENDPOINT = 'https://copilot.tencent.com';
// 每轮最多用 1 张补登卡：卡是稀缺资源(上限 4 张)，谨慎消耗
const MAKEUP_MAX_PER_RUN = 1;

function getPointsTaskSession() {
    try {
        const manual = getConfiguredOrManualSession();
        if (manual) return manual;
    } catch (e) {}
    try {
        const s = getAntigravityPluginSession();
        if (s) return s;
    } catch (e) {}
    try {
        const s = getWorkBuddyDesktopSession();
        if (s) return s;
    } catch (e) {}
    return null;
}

function buildPointsHeaders(session) {
    return {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + session.accessToken,
        'Content-Type': 'application/json',
        'X-User-Id': session.uid,
        'User-Agent': 'WorkBuddy'
    };
}

// 活动接口(抽奖/兑换/补登/开 Buddy)要求的防重放 token：服务端只做幂等去重，缺了直接 400
function pointsClientToken() {
    return 'u-' + crypto.randomUUID();
}

// 在可能被 data/result 包裹的响应里向下找字段
function digResp(obj, key) {
    if (obj && typeof obj === 'object') {
        if (obj[key] !== undefined && obj[key] !== null) return obj[key];
        for (const wrap of ['data', 'result', 'resp', 'response']) {
            if (obj[wrap] && typeof obj[wrap] === 'object') {
                const r = digResp(obj[wrap], key);
                if (r !== null && r !== undefined) return r;
            }
        }
    }
    return null;
}

function asIntSafe(v, dft = 0) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : dft;
}

// 统一请求封装：返回 { code, body }；code = -1 表示网络不可达/超时。
// 写操作默认不重试(防重复提交)；读操作与幂等的签到接口允许重试 1 次。
async function pointsRequest(headers, urlPath, { method = 'GET', payload = null, retry = false, timeoutMs = 20000 } = {}) {
    const url = urlPath.startsWith('http') ? urlPath : (COPILOT_ENDPOINT + urlPath);
    const attempt = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const resp = await fetch(url, {
                method,
                headers,
                body: payload !== null ? JSON.stringify(payload) : undefined,
                signal: controller.signal
            });
            const text = await resp.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text.slice(0, 300) }; }
            return { code: resp.status, body };
        } catch (e) {
            return { code: -1, body: { error: e.name === 'AbortError' ? '请求超时' : (e.message || String(e)) } };
        } finally {
            clearTimeout(timer);
        }
    };
    let r = await attempt();
    if (retry && (r.code === -1 || r.code >= 500)) {
        await new Promise(res => setTimeout(res, 3000));
        r = await attempt();
    }
    return r;
}

// ------------------------------------------
// 每日签到：查状态 -> 未签才领 (接口幂等，重复领取只返回"已签")
// ------------------------------------------
function isAlreadyCheckedIn(cbody) {
    if (cbody === null || cbody === undefined) return true;
    if (typeof cbody === 'object') {
        if (cbody.code === 10001 || String(cbody.msg || '').includes('已签')) return true;
    }
    return false;
}

async function runDailyCheckin(headers) {
    const s = await pointsRequest(headers, '/v2/billing/meter/checkin-activity-status', { method: 'POST', payload: {}, retry: true });
    if (s.code === -1) return { result: 'NETWORK', report: '网络不可达，签到跳过(' + (s.body.error || '') + ')' };
    if (s.code === 401 || s.code === 403) return { result: 'AUTH_REJECTED', http: s.code, report: '服务端拒绝认证(HTTP ' + s.code + ')，请在 IDE 中重新登录 CodeBuddy 扩展' };
    if (!(s.code >= 200 && s.code < 300)) return { result: 'ERROR', http: s.code, report: '签到状态接口异常(HTTP ' + s.code + ')' };

    const status = s.body || {};
    if (digResp(status, 'active') === false) {
        return { result: 'INACTIVE', report: '签到活动未开启' };
    }
    const already = digResp(status, 'today_checked_in');
    if (already === true || already === 1) {
        return {
            result: 'ALREADY',
            report: '今日已签过(连签 ' + (digResp(status, 'streak_days') || 0) + ' 天)',
            streakDays: digResp(status, 'streak_days'),
            totalCredits: digResp(status, 'total_credits')
        };
    }

    const c = await pointsRequest(headers, '/v2/billing/meter/daily-checkin', { method: 'POST', payload: {}, retry: true });
    if (c.code === -1) return { result: 'NETWORK', report: '领取请求未能送达(' + (c.body.error || '') + ')' };
    if (c.code === 401 || c.code === 403) return { result: 'AUTH_REJECTED', http: c.code, report: '服务端拒绝认证(HTTP ' + c.code + ')，请在 IDE 中重新登录 CodeBuddy 扩展' };
    if (isAlreadyCheckedIn(c.body)) {
        return { result: 'ALREADY', report: '今日已签过(服务端判定已领取)' };
    }
    const credit = digResp(c.body, 'credit');
    if (credit !== null) {
        // 领取成功后复查一次状态，拿最新连签/累计
        const s2 = await pointsRequest(headers, '/v2/billing/meter/checkin-activity-status', { method: 'POST', payload: {}, retry: true });
        const fresh = (s2.code >= 200 && s2.code < 300 && s2.body) ? s2.body : status;
        return {
            result: 'CLAIMED',
            report: '成功领取 ' + credit + ' 积分(连签 ' + (digResp(fresh, 'streak_days') || '?') + ' 天)',
            credit: asIntSafe(credit),
            streakDays: digResp(fresh, 'streak_days'),
            totalCredits: digResp(fresh, 'total_credits')
        };
    }
    const msg = (c.body && (c.body.msg || ('code ' + c.body.code))) || ('HTTP ' + c.code);
    return { result: 'ERROR', http: c.code, report: '领取失败: ' + msg };
}

// ------------------------------------------
// 成长中心：领旅行礼物 -> 派 Buddy -> 领任务/任务奖 -> 补登 -> 连登兑换 -> 开盲盒 -> 能量开 Buddy
// 各子步骤独立容错，一段失败不影响其余领取；认证被拒时立即终止整轮。
// ------------------------------------------
async function runGrowthCenter(headers) {
    const base = '/v2/activity/growth';
    const parts = [];
    let creditsGained = 0;
    let failures = 0;
    let hardFailures = 0;
    let successes = 0;
    const isHard = (code) => code >= 500 || code === -1;
    const isAuth = (code) => code === 401 || code === 403;
    const authFail = (code) => ({ result: 'AUTH_REJECTED', http: code, ok: false, report: '服务端拒绝认证(HTTP ' + code + ')，请在 IDE 中重新登录 CodeBuddy 扩展' });

    // --- 1. Buddy 旅行: 领礼物 + 派出发 ---
    let streakBody = null;
    let streakStale = false;
    try {
        const s = await pointsRequest(headers, base + '/buddy/travel/status', { retry: true });
        if (s.code === -1) return { result: 'NETWORK', ok: false, report: '网络不可达，成长中心跳过(' + (s.body.error || '') + ')' };
        if (isAuth(s.code)) return authFail(s.code);
        const travel = (s.code >= 200 && s.code < 300) ? digResp(s.body, 'state') : null;
        const dailyLimit = (s.code >= 200 && s.code < 300) ? !!digResp(s.body, 'daily_limit_reached') : false;
        let claimedTravel = false;
        if (travel === 'arrived') {
            const recordId = digResp(s.body, 'record_id');
            const c = await pointsRequest(headers, base + '/buddy/travel/claim', { method: 'POST', payload: { record_id: recordId } });
            if (isAuth(c.code)) return authFail(c.code);
            const reward = digResp(c.body, 'reward_credit');
            if (c.code >= 200 && c.code < 300 && reward !== null) {
                creditsGained += asIntSafe(reward);
                parts.push('领旅行礼物 +' + asIntSafe(reward) + ' 积分');
                successes++;
                claimedTravel = true;
            } else {
                // 领取失败时不派 Buddy 出发，避免覆盖未领取的奖励
                parts.push('领旅行礼物失败: ' + (digResp(c.body, 'msg') || ('HTTP ' + c.code)));
                failures++; hardFailures += isHard(c.code) ? 1 : 0;
            }
        }
        const travelState = claimedTravel ? 'idle' : travel;
        if (travelState === 'idle' && dailyLimit) {
            parts.push('今日旅行名额已用完');
        } else if (travelState === 'idle') {
            const cfg = await pointsRequest(headers, base + '/buddy/travel/config', { retry: true });
            if (isAuth(cfg.code)) return authFail(cfg.code);
            const locs = (cfg.code >= 200 && cfg.code < 300) ? digResp(cfg.body, 'locations') : null;
            if (Array.isArray(locs) && locs.length && locs[0] && typeof locs[0] === 'object') {
                const d = await pointsRequest(headers, base + '/buddy/travel/depart', { method: 'POST', payload: { location_id: locs[0].id } });
                if (isAuth(d.code)) return authFail(d.code);
                if (d.code >= 200 && d.code < 300) {
                    const locName = (digResp(d.body, 'location') || {}).name || '?';
                    const dur = digResp(d.body, 'duration_hours') || (digResp(d.body, 'location') || {}).duration_hours || '?';
                    parts.push('派 Buddy 去' + locName + '(' + dur + ' 小时后回)');
                    successes++;
                } else {
                    parts.push('派 Buddy 失败: ' + (digResp(d.body, 'msg') || ('HTTP ' + d.code)));
                    failures++; hardFailures += isHard(d.code) ? 1 : 0;
                }
            }
        } else if (travel === 'traveling') {
            const locName = (digResp(s.body, 'location') || {}).name || '?';
            parts.push('Buddy 旅行中(' + locName + ')');
        }
    } catch (e) {
        parts.push('旅行模块异常(' + e.message + ')'); failures++; hardFailures++;
    }

    // --- 2. 任务: 领新任务 + 领任务奖 (放在抽奖前：任务送的抽奖机会/能量后面马上能用) ---
    try {
        const t = await pointsRequest(headers, base + '/tasks', { retry: true });
        if (isAuth(t.code)) return authFail(t.code);
        if (t.code >= 200 && t.code < 300) {
            const tasks = digResp(t.body, 'tasks') || [];
            const titles = {};
            for (const task of tasks) titles[task.task_code] = task.title || task.task_code;
            // accept_status: not_accepted | accepted | in_progress | completed | claimed
            const pending = tasks.filter(x => x.task_code && !x.locked && x.accept_status === 'not_accepted').map(x => x.task_code);
            for (let i = 0; i < pending.length; i += 20) {
                const batch = pending.slice(i, i + 20);
                const a = await pointsRequest(headers, base + '/tasks/accept', { method: 'POST', payload: { task_codes: batch } });
                if (isAuth(a.code)) return authFail(a.code);
                let results = digResp(a.body, 'results');
                if (!Array.isArray(results)) {
                    results = batch.map(code => ({ task_code: code, status: (a.code >= 200 && a.code < 300) ? 'ok' : 'error', message: digResp(a.body, 'msg') }));
                }
                for (const r of results) {
                    const title = titles[r.task_code] || r.task_code;
                    if (r.status === 'error') {
                        parts.push('领取任务「' + title + '」失败: ' + (r.message || ('HTTP ' + a.code)));
                        failures++; hardFailures += isHard(a.code) ? 1 : 0;
                    } else {
                        parts.push('领取任务「' + title + '」(进度开始计)');
                        successes++;
                    }
                }
            }
            for (const task of tasks) {
                if (task.locked || task.accept_status !== 'completed') continue;
                try {
                    const c = await pointsRequest(headers, base + '/tasks/' + encodeURIComponent(task.task_code) + '/claim', { method: 'POST', payload: {} });
                    if (isAuth(c.code)) return authFail(c.code);
                    if (c.code >= 200 && c.code < 300 && !digResp(c.body, 'already_claimed')) {
                        // 优先用服务端实发数值；列表里的 reward_credit 只是活动配置
                        const rc = digResp(c.body, 'credit') !== null ? asIntSafe(digResp(c.body, 'credit')) : asIntSafe(task.reward_credit);
                        const re = digResp(c.body, 'energy') !== null ? asIntSafe(digResp(c.body, 'energy')) : asIntSafe(task.reward_energy);
                        creditsGained += rc;
                        parts.push('领任务奖「' + (titles[task.task_code] || task.task_code) + '」+' + rc + ' 积分' + (re ? ' +' + re + ' 能量' : ''));
                        successes++;
                    } else if (c.code >= 200 && c.code < 300) {
                        parts.push('任务奖「' + (titles[task.task_code] || task.task_code) + '」已领过');
                    } else {
                        parts.push('领任务奖「' + (titles[task.task_code] || task.task_code) + '」失败: ' + (digResp(c.body, 'msg') || ('HTTP ' + c.code)));
                        failures++; hardFailures += isHard(c.code) ? 1 : 0;
                    }
                } catch (e) {
                    parts.push('领任务奖「' + (titles[task.task_code] || task.task_code) + '」异常(' + e.message + ')');
                    failures++; hardFailures++;
                }
            }
        } else {
            parts.push('查任务列表失败: HTTP ' + t.code);
            failures++; hardFailures += isHard(t.code) ? 1 : 0;
        }
    } catch (e) {
        parts.push('任务模块异常(' + e.message + ')'); failures++; hardFailures++;
    }

    // --- 3. 补登卡: 断登自动补(放在连登兑换前，先补才能拿到最新解锁状态；每轮限 1 张) ---
    try {
        const m = await pointsRequest(headers, base + '/streak', { retry: true });
        if (isAuth(m.code)) return authFail(m.code);
        if (m.code >= 200 && m.code < 300) {
            streakBody = m.body;
            const cardsObj = digResp(m.body, 'makeup_cards');
            let cards = (cardsObj && typeof cardsObj === 'object') ? asIntSafe(cardsObj.balance) : asIntSafe(cardsObj);
            const streakObj = digResp(m.body, 'streak') || {};
            const dates = (streakObj && streakObj.makeup_dates) || digResp(m.body, 'makeup_dates') || [];
            if (cards > 0 && Array.isArray(dates) && dates.length) {
                for (const d of dates.slice(0, Math.min(cards, MAKEUP_MAX_PER_RUN))) {
                    const u = await pointsRequest(headers, base + '/makeup-cards/use', { method: 'POST', payload: { target_date: d, client_token: pointsClientToken() } });
                    if (isAuth(u.code)) return authFail(u.code);
                    if (u.code >= 200 && u.code < 300) {
                        cards--;
                        streakStale = true;
                        const leftObj = digResp(u.body, 'makeup_cards');
                        const left = (leftObj && typeof leftObj === 'object') ? asIntSafe(leftObj.balance, cards) : asIntSafe(leftObj, cards);
                        parts.push('补登 ' + d + '(剩 ' + left + ' 张卡)');
                        successes++;
                    } else {
                        parts.push('补登 ' + d + ' 失败: ' + (digResp(u.body, 'msg') || ('HTTP ' + u.code)));
                        failures++; hardFailures += isHard(u.code) ? 1 : 0;
                    }
                }
                if (dates.length > MAKEUP_MAX_PER_RUN && cards > 0) {
                    parts.push('另有 ' + (dates.length - MAKEUP_MAX_PER_RUN) + ' 天可补、剩 ' + cards + ' 张卡，下轮继续');
                }
            }
        }
    } catch (e) {
        parts.push('补登模块异常(' + e.message + ')'); failures++; hardFailures++;
    }

    // --- 4. 连登奖励兑换 (入门 7 天 / 进阶 14 天 / 巅峰 28 天) ---
    const REDEEM_TIERS = [
        { tier: '7d', statusKey: 'starter_status', label: '入门', days: 7 },
        { tier: '14d', statusKey: 'advanced_status', label: '进阶', days: 14 },
        { tier: '28d', statusKey: 'legendary_status', label: '巅峰', days: 28 }
    ];
    try {
        const r = await pointsRequest(headers, base + '/redeem/summary', { retry: true });
        if (isAuth(r.code)) return authFail(r.code);
        if (r.code >= 200 && r.code < 300) {
            for (const t of REDEEM_TIERS) {
                const status = digResp(r.body, t.statusKey);
                if (!status || status === 'claimed' || status === 'locked') continue;
                // tier 传档位标识字符串("7d"/"14d"/"28d")，不是天数也不是档位名
                let c = await pointsRequest(headers, base + '/redeem', { method: 'POST', payload: { tier: t.tier, client_token: pointsClientToken() } });
                // 档位标识不被识别时退回天数再试一次：这类 400 发生在参数校验阶段，服务端未兑换任何东西
                const msgLower = String(digResp(c.body, 'msg') || '').toLowerCase();
                if (c.code === 400 && msgLower.includes('tier') && (msgLower.includes('unknown') || msgLower.includes('unsupported') || msgLower.includes('invalid'))) {
                    c = await pointsRequest(headers, base + '/redeem', { method: 'POST', payload: { tier: t.days, client_token: pointsClientToken() } });
                }
                // 403「连登天数不足」是未解锁常态，不算失败
                if (c.code === 403 && String(digResp(c.body, 'msg') || '').includes('不足')) {
                    parts.push('连登兑换「' + t.label + '」未解锁(连登天数不足)');
                    continue;
                }
                if (isAuth(c.code)) return authFail(c.code);
                if (c.code >= 200 && c.code < 300) {
                    const bits = [];
                    const cg = asIntSafe(digResp(c.body, 'credit_granted'));
                    const eg = asIntSafe(digResp(c.body, 'energy_granted'));
                    const kg = asIntSafe(digResp(c.body, 'cards_granted'));
                    const hg = asIntSafe(digResp(c.body, 'chances_granted'));
                    if (cg) bits.push('+' + cg + ' 积分');
                    if (eg) bits.push('+' + eg + ' 能量');
                    if (kg) bits.push('+' + kg + ' 补登卡');
                    if (hg) bits.push('+' + hg + ' 次抽奖');
                    creditsGained += cg;
                    parts.push('连登兑换「' + t.label + '」' + (bits.length ? '(' + bits.join(' ') + ')' : '(奖励已到账)'));
                    successes++;
                } else {
                    parts.push('连登兑换「' + t.label + '」失败: ' + (digResp(c.body, 'msg') || ('HTTP ' + c.code)));
                    failures++; hardFailures += isHard(c.code) ? 1 : 0;
                }
            }
        }
    } catch (e) {
        parts.push('连登兑换模块异常(' + e.message + ')'); failures++; hardFailures++;
    }

    // --- 5. 盲盒抽奖 (draw 必须带 client_token；每轮限开 1 次) ---
    try {
        const l = await pointsRequest(headers, base + '/lottery/chances', { retry: true });
        if (isAuth(l.code)) return authFail(l.code);
        const chances = (l.code >= 200 && l.code < 300) ? asIntSafe(digResp(l.body, 'balance')) : 0;
        if (chances > 0) {
            const d = await pointsRequest(headers, base + '/lottery/draw', { method: 'POST', payload: { client_token: pointsClientToken() } });
            if (isAuth(d.code)) return authFail(d.code);
            if (d.code >= 200 && d.code < 300) {
                let prize = digResp(d.body, 'prize_name') || digResp(d.body, 'prize') || '未知';
                if (typeof prize !== 'string') prize = String(prize);
                // 实物周边需用户自行填写收件信息，脚本只提醒、绝不代填
                if (digResp(d.body, 'need_address') || digResp(d.body, 'require_address')) {
                    prize += '(实物奖，需到成长中心填写收件信息)';
                }
                parts.push('开盲盒获得: ' + prize);
                successes++;
                if (chances > 1) parts.push('还剩 ' + (chances - 1) + ' 次抽奖机会，下轮继续');
            } else {
                const msg = String(digResp(d.body, 'msg') || '');
                const mLow = msg.toLowerCase();
                // 次数为 0 是常态(次数来自连登兑换)，不是故障
                const noChance = ((mLow.includes('insufficient') || mLow.includes('not enough')) && (mLow.includes('chance') || mLow.includes('balance'))) || mLow.includes('no chance');
                if (noChance) {
                    parts.push('开盲盒: ' + (msg || '无抽奖机会'));
                } else {
                    parts.push('开盲盒失败: ' + (msg || ('HTTP ' + d.code)));
                    failures++; hardFailures += isHard(d.code) ? 1 : 0;
                }
            }
        }
    } catch (e) {
        parts.push('盲盒模块异常(' + e.message + ')'); failures++; hardFailures++;
    }

    // --- 6. 能量开 Buddy 盲盒 (能量没有其它消耗出口，攒够 cost_per_open 就开) ---
    try {
        const q = await pointsRequest(headers, base + '/buddy/quota', { retry: true });
        if (isAuth(q.code)) return authFail(q.code);
        if (q.code >= 200 && q.code < 300) {
            const affordable = asIntSafe(digResp(q.body, 'affordable'));
            const maxOpen = asIntSafe(digResp(q.body, 'max_open_count'), 1) || 1;
            if (affordable > 0) {
                const count = Math.min(affordable, maxOpen);
                const o = await pointsRequest(headers, base + '/buddy/open', { method: 'POST', payload: { count, client_token: pointsClientToken() } });
                if (isAuth(o.code)) return authFail(o.code);
                if (o.code >= 200 && o.code < 300) {
                    let name = digResp(o.body, 'buddy') || digResp(o.body, 'name') || digResp(o.body, 'buddies');
                    if (typeof name !== 'string' || !name) name = '新 Buddy';
                    parts.push('开 Buddy 盲盒 ×' + count + '(' + name + ')');
                    successes++;
                } else {
                    parts.push('开 Buddy 盲盒失败: ' + (digResp(o.body, 'msg') || ('HTTP ' + o.code)));
                    failures++; hardFailures += isHard(o.code) ? 1 : 0;
                }
            }
        }
    } catch (e) {
        parts.push('Buddy 盲盒模块异常(' + e.message + ')'); failures++; hardFailures++;
    }

    // --- 7. 展示值: 能量 & 连签天数 (纯展示，失败不影响结果；补登过需重新取连签) ---
    let energy = null;
    let streakDays = null;
    try {
        const e2 = await pointsRequest(headers, base + '/energy', { retry: true });
        if (!isAuth(e2.code) && e2.code >= 200 && e2.code < 300) energy = digResp(e2.body, 'balance');
    } catch (e) {}
    try {
        if (streakBody && !streakStale) {
            const so = digResp(streakBody, 'streak') || {};
            streakDays = (so.days !== undefined && so.days !== null) ? so.days : null;
        } else {
            const s2 = await pointsRequest(headers, base + '/streak', { retry: true });
            if (!isAuth(s2.code) && s2.code >= 200 && s2.code < 300) {
                const so = digResp(s2.body, 'streak') || {};
                streakDays = (so.days !== undefined && so.days !== null) ? so.days : null;
            }
        }
    } catch (e) {}

    const tail = [];
    if (energy !== null) tail.push('能量 ' + energy);
    if (streakDays !== null) tail.push('连签 ' + streakDays + ' 天');
    if (creditsGained) tail.push('本次共 +' + creditsGained + ' 积分');
    let report = parts.length ? parts.join('；') : (failures ? '成长中心各步骤均失败' : '成长中心无可领取项');
    if (tail.length) report += '(' + tail.join('，') + ')';
    // idle = 既没领到东西也没出错，纯空跑(Buddy 还在路上 / 名额已用完 / 没有可领项)
    const idle = successes === 0 && failures === 0;
    return {
        result: 'GROWTH',
        report,
        creditsGained,
        energy,
        streakDays,
        idle,
        failures: failures || undefined,
        // 只有"确有硬失败(5xx/网络)且一件都没成"才算整体失败；业务 4xx 是每天常态
        ok: !(hardFailures > 0 && successes === 0)
    };
}

// ------------------------------------------
// 总编排: 签到 + 成长中心，结果落盘缓存供报表展示
// ------------------------------------------
function getPointsTasksLastRun() {
    try {
        if (fs.existsSync(POINTS_TASKS_CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(POINTS_TASKS_CACHE_FILE, 'utf8'));
        }
    } catch (e) {}
    return null;
}

async function runAllPointsTasks() {
    const session = getPointsTaskSession();
    if (!session) {
        throw new Error('未检测到 CodeBuddy 扩展或 WorkBuddy 客户端登录态，请先在 IDE 中登录 CodeBuddy 扩展');
    }
    const headers = buildPointsHeaders(session);
    const checkin = await runDailyCheckin(headers);
    let growth;
    if (checkin.result === 'NETWORK' || checkin.result === 'AUTH_REJECTED') {
        // 网络不可达/认证被拒时，不再用同一凭据继续请求成长中心
        growth = { result: checkin.result, ok: false, report: '因签到环节' + (checkin.result === 'NETWORK' ? '网络不可达' : '认证被拒') + '，成长中心跳过' };
    } else {
        growth = await runGrowthCenter(headers);
    }
    const checkinOk = checkin.result !== 'ERROR' && checkin.result !== 'NETWORK' && checkin.result !== 'AUTH_REJECTED';
    const success = checkinOk && growth.ok !== false;
    const out = {
        success,
        ranAt: new Date().toISOString(),
        account: session.nickname || session.uid,
        source: session.source,
        checkin,
        growth,
        creditsGained: (checkin.credit || 0) + (growth.creditsGained || 0),
        report: checkin.report + '；' + growth.report
    };
    try { fs.writeFileSync(POINTS_TASKS_CACHE_FILE, JSON.stringify(out, null, 2), 'utf8'); } catch (e) {}
    return out;
}

// ==========================================
// CodeBuddy 每日自动签到（轻量、幂等、当日去重）
// 仅执行「每日签到」环节，不触碰成长中心的补登卡等稀缺资源。
// 服务端会判定今天是否已领，重复调用不会多领。
// ==========================================

/** 本地自然日字符串 (YYYY-MM-DD)，用于「当天是否已处理」的判定 */
function getLocalDateStr(d = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 读取上次自动签到记录（无则返回 null） */
function getAutoCheckinRecord() {
    try {
        if (fs.existsSync(AUTO_CHECKIN_CACHE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(AUTO_CHECKIN_CACHE_FILE, 'utf8'));
            if (raw && typeof raw === 'object') return raw;
        }
    } catch (e) {}
    return null;
}

/**
 * 执行每日自动签到。
 * 幂等：当天已成功领取或被服务端判定为已签到时直接跳过，不产生额外请求。
 * 失败（网络/认证/异常）不会写入「已完成」标记，后续调用可自然重试。
 * @param {object} [opts]
 * @param {boolean} [opts.force] 忽略当日去重，强制请求一次（手动触发场景）
 * @returns {Promise<{result:string, report:string, credit?:number, streakDays?:number, skipped?:boolean}>}
 */
async function runAutoDailyCheckin({ force = false } = {}) {
    const today = getLocalDateStr();
    const prev = getAutoCheckinRecord();
    const settled = prev && ['CLAIMED', 'ALREADY'].includes(prev.result);
    if (!force && settled && prev.date === today) {
        return { result: 'ALREADY', skipped: true, report: '今日已签到' + (prev.report ? '(' + prev.report + ')' : '') };
    }

    const session = getPointsTaskSession();
    if (!session) {
        return { result: 'SKIPPED', report: '未检测到 CodeBuddy 登录态，跳过自动签到' };
    }

    let out;
    try {
        out = await runDailyCheckin(buildPointsHeaders(session));
    } catch (e) {
        out = { result: 'ERROR', report: e && e.message ? e.message : String(e) };
    }

    try {
        fs.writeFileSync(AUTO_CHECKIN_CACHE_FILE, JSON.stringify({
            date: today,
            ranAt: new Date().toISOString(),
            account: session.nickname || session.uid,
            source: session.source,
            result: out.result,
            report: out.report,
            credit: out.credit || 0,
            streakDays: out.streakDays !== undefined ? out.streakDays : null
        }, null, 2), 'utf8');
    } catch (e) {}

    return out;
}

function parseCodeBuddyCreditsResponse({ summary, free, paid, checkin = null, source = 'live' }) {
    let totalCredits = 0;
    let remainCredits = 0;
    let usedCredits = 0;
    const packages = [];

    const summaryPkgs = (summary && summary.data && summary.data.Packages) || [];
    for (const p of summaryPkgs) {
        const tot = parseFloat(p.CycleTotalCapacity || 0);
        const rem = parseFloat(p.CycleRemainCapacity || 0);
        const usd = parseFloat(p.CycleUsedCapacity || 0);
        totalCredits += tot;
        remainCredits += rem;
        usedCredits += usd;
    }

    const freeAccounts = (free && free.data && free.data.Accounts) || [];
    for (const acc of freeAccounts) {
        packages.push({
            name: acc.PackageName || '免费包',
            packageCode: acc.PackageCode,
            total: parseFloat(acc.CycleCapacitySizePrecise || acc.CycleCapacitySize || 0),
            remain: parseFloat(acc.CycleCapacityRemainPrecise || acc.CycleCapacityRemain || 0),
            used: parseFloat(acc.CycleCapacityUsedPrecise || acc.CycleCapacityUsed || 0),
            unit: acc.CapacityUnit || 'credits',
            inUsage: !!acc.InUsage,
            cycleStartTime: acc.CycleStartTime || '',
            cycleEndTime: acc.CycleEndTime || ''
        });
    }

    const paidAccounts = (paid && paid.data && paid.data.Accounts) || [];
    for (const acc of paidAccounts) {
        packages.push({
            name: acc.PackageName || '付费包',
            packageCode: acc.PackageCode,
            total: parseFloat(acc.CycleCapacitySizePrecise || acc.CycleCapacitySize || 0),
            remain: parseFloat(acc.CycleCapacityRemainPrecise || acc.CycleCapacityRemain || 0),
            used: parseFloat(acc.CycleCapacityUsedPrecise || acc.CycleCapacityUsed || 0),
            unit: acc.CapacityUnit || 'credits',
            inUsage: !!acc.InUsage,
            cycleStartTime: acc.CycleStartTime || '',
            cycleEndTime: acc.CycleEndTime || ''
        });
    }

    remainCredits = Math.round(remainCredits * 100) / 100;
    usedCredits = Math.round(usedCredits * 100) / 100;
    totalCredits = Math.round(totalCredits * 100) / 100;

    const usedFrac = totalCredits > 0 ? (usedCredits / totalCredits) : 0;
    const remainFrac = totalCredits > 0 ? (remainCredits / totalCredits) : 0;

    return {
        totalCredits,
        remainCredits,
        usedCredits,
        usedPercent: (usedFrac * 100).toFixed(1) + '%',
        remainPercent: (remainFrac * 100).toFixed(1) + '%',
        updatedAt: new Date().toISOString(),
        source: source,
        isPaidUser: summary?.data?.IsPaidUser || false,
        checkin: checkin?.data ? {
            todayCheckedIn: checkin.data.today_checked_in,
            streakDays: checkin.data.streak_days,
            dailyCredit: checkin.data.daily_credit,
            todayCredit: checkin.data.today_credit
        } : null,
        packages
    };
}

function findPlaywrightCorePath() {
    const home = os.homedir();
    const candidatePaths = [
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe', 'node-v24.19.0-win-x64', 'node_modules', '@playwright', 'mcp', 'node_modules', 'playwright-core'),
        path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'playwright-core'),
        path.join(home, '.npm-global', 'lib', 'node_modules', 'playwright-core'),
        '/usr/local/lib/node_modules/playwright-core',
        '/usr/lib/node_modules/playwright-core',
        'playwright-core'
    ];
    for (const p of candidatePaths) {
        try {
            if (p === 'playwright-core') {
                require.resolve('playwright-core');
                return 'playwright-core';
            }
            if (fs.existsSync(path.join(p, 'lib', 'coreBundle.js'))) {
                return p;
            }
        } catch (e) {}
    }
    return null;
}

function getPlaywrightExtensionToken() {
    const home = os.homedir();
    const candidateDirs = [
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default', 'Local Storage', 'leveldb'),
        path.join(home, '.config', 'google-chrome', 'Default', 'Local Storage', 'leveldb'),
        path.join(home, '.config', 'chromium', 'Default', 'Local Storage', 'leveldb'),
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Local Storage', 'leveldb')
    ];
    for (const dir of candidateDirs) {
        if (fs.existsSync(dir)) {
            try {
                for (const f of fs.readdirSync(dir)) {
                    if (f.endsWith('.ldb') || f.endsWith('.log')) {
                        try {
                            const buf = fs.readFileSync(path.join(dir, f));
                            const key = 'auth-token';
                            let idx = 0;
                            while ((idx = buf.indexOf(key, idx)) !== -1) {
                                const slice = buf.slice(idx, idx + 100).toString('utf8');
                                const match = slice.match(/([a-zA-Z0-9_-]{40,50})/);
                                if (match) return match[1];
                                idx += key.length;
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {}
        }
    }
    return 'p-jJnabURmKBtZJA1qr9smKaNfJzfMbEZR1zHQ5EGxI';
}

// ------------------------------------------
// 来源 3：原有 Chrome 浏览器 CDP 扩展通道 (兜底备选)
// ------------------------------------------
async function syncCodeBuddyCreditsFromBrowser({ timeoutMs = 15000 } = {}) {
    const pwPath = findPlaywrightCorePath();
    if (!pwPath) {
        throw new Error('未检测到 playwright-core 运行环境，无法进行自动浏览器同步');
    }
    const coreBundle = require(path.join(pwPath, 'lib', 'coreBundle'));
    const playwright = require(pwPath);
    const { CDPRelayServer } = coreBundle.tools;

    const relay = new CDPRelayServer('chrome', undefined, undefined);
    relay._wsHost = await relay._wsServer.listen(0, '127.0.0.1', '');

    const token = getPlaywrightExtensionToken();
    const extId = 'mmlmfjhmonkocbjadbfplnigmagldckm';
    const client = JSON.stringify({ name: 'codebuddy-stats' });
    const connectUrl = `chrome-extension://${extId}/connect.html?mcpRelayUrl=${encodeURIComponent(relay.extensionEndpoint())}&protocolVersion=2&token=${encodeURIComponent(token)}&client=${encodeURIComponent(client)}`;

    try {
        if (process.platform === 'win32') {
            exec(`powershell -ExecutionPolicy Bypass -Command "Start-Process 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -ArgumentList @('${connectUrl}')"`);
        } else if (process.platform === 'darwin') {
            exec(`open -a "Google Chrome" "${connectUrl}"`);
        } else {
            const browserCmd = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'xdg-open'].find(c => {
                try {
                    execSync(`which ${c}`, { stdio: 'ignore' });
                    return true;
                } catch (_) { return false; }
            }) || 'xdg-open';
            exec(`${browserCmd} "${connectUrl}"`);
        }
    } catch (e) {}

    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('等待 Chrome 扩展连接超时')), timeoutMs));
    await Promise.race([relay._extensionConnectionPromise, timeout]);
    await relay._handler.ready();

    const browser = await playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: 0, noDefaults: true });
    try {
        const context = browser.contexts()[0] || await browser.newContext();
        let page = context.pages().find(p => p.url().includes('codebuddy.cn'));
        if (!page) {
            page = await context.newPage();
            await page.goto('https://www.codebuddy.cn/profile/plans-usage', { waitUntil: 'networkidle', timeout: 25000 });
        }

        const raw = await page.evaluate(async () => {
            const summaryRes = await fetch('https://www.codebuddy.cn/billing/meter/get-user-resource-summary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Client-Platform': 'web' },
                body: '{}'
            });
            const summary = await summaryRes.json();

            const freeRes = await fetch('https://www.codebuddy.cn/billing/meter/get-user-resource-free-packages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Client-Platform': 'web' },
                body: JSON.stringify({ PageNumber: 1, PageSize: 200, Status: [0] })
            });
            const free = await freeRes.json();

            const paidRes = await fetch('https://www.codebuddy.cn/billing/meter/get-user-resource-paid-packages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Client-Platform': 'web' },
                body: JSON.stringify({ PageNumber: 1, PageSize: 200, Status: [0, 3], NeedRenewInfo: true })
            });
            const paid = await paidRes.json();

            return { summary, free, paid };
        });

        const parsed = parseCodeBuddyCreditsResponse({ ...raw, source: 'browser' });
        fs.writeFileSync(CODEBUDDY_CREDITS_CACHE_FILE, JSON.stringify(parsed, null, 2), 'utf8');
        return parsed;
    } finally {
        try { await browser.close(); } catch (e) {}
        try { relay.stop(); } catch (e) {}
    }
}

// ------------------------------------------
// 统一积分同步引擎：优先插件直连 -> 次选桌面端 -> 兜底浏览器
// ------------------------------------------
async function syncCodeBuddyCredits({ timeoutMs = 15000 } = {}) {
    // 过程日志统一走 log 出口：CLI 由 cli.js 注入到 stdout/stderr，扩展注入到 OutputChannel，
    // 避免直接 console.* 污染 `--json` 等机器可读输出。

    // 0. 手动配置 / 环境变量 / Token 文件（跨平台通用）
    try {
        const manualSession = getConfiguredOrManualSession();
        if (manualSession) {
            log.info('成功识别自定义/环境变量 CodeBuddy 凭据，直连官方 API 同步...');
            return await fetchCodeBuddyCreditsViaApi(manualSession);
        }
    } catch (manualErr) {
        log.warn('自定义 CodeBuddy 凭据读取失败: ' + manualErr.message + '，尝试下一候选源...');
    }

    // 1. 首选：反重力 IDE / VS Code 插件登录凭据（静默解密，秒级直连官方 API，永不掉线）
    try {
        const pluginSession = getAntigravityPluginSession();
        if (pluginSession) {
            log.info('成功识别 IDE 插件登录态 (' + (pluginSession.nickname || pluginSession.uid) + ')，直连官方 API 同步...');
            return await fetchCodeBuddyCreditsViaApi(pluginSession);
        }
    } catch (pluginErr) {
        log.warn('IDE 插件凭据读取失败: ' + pluginErr.message + '，尝试下一候选源...');
    }

    // 2. 次选：WorkBuddy 独立桌面客户端 / CLI 凭据
    try {
        const desktopSession = getWorkBuddyDesktopSession();
        if (desktopSession) {
            log.info('成功识别 WorkBuddy 桌面客户端凭据，直连官方 API 同步...');
            return await fetchCodeBuddyCreditsViaApi(desktopSession);
        }
    } catch (desktopErr) {
        log.warn('WorkBuddy 桌面端凭据读取失败: ' + desktopErr.message + '，尝试下一候选源...');
    }

    // 3. 兜底备选：Chrome 浏览器扩展 CDP 模式
    log.info('未检测到本地客户端登录凭据，尝试通过 Chrome 浏览器扩展同步...');
    return await syncCodeBuddyCreditsFromBrowser({ timeoutMs });
}

function analyzeAntigravityConversation(dbPath) {
    if (!DatabaseSync) return null;
    const convId = path.basename(dbPath, '.db');
    let meta = {
        id: convId,
        name: convId,
        createdAt: '',
        lastMessageAt: '',
        selectedModelId: '',
        workspace: '',
        source: 'Antigravity'
    };

    const home = os.homedir();
    // 优先从本地转录 transcript.jsonl 中提取会话首轮用户提问作为标题
    const transcriptPath = path.join(home, '.gemini', 'antigravity-ide', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(transcriptPath)) {
        try {
            const fd = fs.openSync(transcriptPath, 'r');
            const buf = Buffer.alloc(4096);
            const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
            fs.closeSync(fd);
            const content = buf.toString('utf8', 0, bytesRead);
            for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const obj = JSON.parse(line);
                    if (obj.type === 'USER_INPUT' && obj.content) {
                        const m = obj.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                        meta.name = (m ? m[1] : obj.content).trim().slice(0, 60).replace(/\r?\n/g, ' ');
                        break;
                    }
                } catch (e) {}
            }
        } catch (e) {}
    }

    let db;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
        return null;
    }

    try {
        // 若转录文件未命中，从 SQLite steps 表中解析首轮提问
        if (meta.name === convId) {
            try {
                const s0 = db.prepare('SELECT step_payload FROM steps WHERE idx = 0').get();
                if (s0 && s0.step_payload) {
                    const str = Buffer.from(s0.step_payload).toString('utf8');
                    const matches = str.match(/[\u4e00-\u9fa5\w\s，。！？、]{4,60}/g);
                    if (matches) {
                        const candidate = matches.find(s => /[\u4e00-\u9fa5]/.test(s) || /^[^\d\-]{6,}$/.test(s));
                        if (candidate) meta.name = candidate.trim().slice(0, 60);
                    }
                }
            } catch (e) {}
        }

        // 提取 workspace 路径
        try {
            const blob = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get();
            if (blob && blob.data) {
                const str = Buffer.from(blob.data).toString('utf8');
                const m = str.match(/file:\/\/\/[^\x00-\x1f\s\"\'\<\>]+/);
                if (m) meta.workspace = m[0].replace('file:///', '');
            }
        } catch (e) {}

        const rows = db.prepare('SELECT idx, data FROM gen_metadata WHERE size > 0 ORDER BY idx ASC').all();
        if (!rows || rows.length === 0) {
            db.close();
            return null;
        }

        let modelStats = {};
        let turns = [];
        let total = {
            turns: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheMissTokens: 0,
            cacheWriteTokens: 0,
            thinkingTokens: 0,
            lastOutputTokens: 0,
            totalTokens: 0,
            credit: 0,
            elapsedMs: 0
        };

        for (const r of rows) {
            // 统一解析入口：字段口径见 src/core/antigravity-parse.js
            const row = parseGenMetadataRow(r.data);
            if (!row) continue;

            const missTok = row.cacheMissTokens;
            const cacheIn = row.cachedInputTokens;
            const inTok = row.inputTokens;
            const outTok = row.outputTokens;
            const thinkTok = row.thinkingTokens;
            const lastOut = row.lastOutputTokens;
            if (inTok === 0 && outTok === 0) continue;

            const time = row.time || new Date().toISOString();
            const modelName = normalizeModelName(row.model);
            const elapsedMs = row.elapsedMs;
            const ttftMs = row.ttftMs;

            if (!modelStats[modelName]) {
                modelStats[modelName] = {
                    turns: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedInputTokens: 0,
                    cacheMissTokens: 0,
                    cacheWriteTokens: 0,
                    thinkingTokens: 0,
                    lastOutputTokens: 0,
                    totalTokens: 0,
                    credit: 0,
                    elapsedMs: 0
                };
            }

            const m = modelStats[modelName];
            m.turns += 1;
            m.inputTokens += inTok;
            m.outputTokens += outTok;
            m.cachedInputTokens += cacheIn;
            m.cacheMissTokens += missTok;
            m.thinkingTokens += thinkTok;
            m.lastOutputTokens += lastOut;
            m.totalTokens += (inTok + outTok);
            m.elapsedMs += elapsedMs;

            total.turns += 1;
            total.inputTokens += inTok;
            total.outputTokens += outTok;
            total.cachedInputTokens += cacheIn;
            total.cacheMissTokens += missTok;
            total.thinkingTokens += thinkTok;
            total.lastOutputTokens += lastOut;
            total.totalTokens += (inTok + outTok);
            total.elapsedMs += elapsedMs;

            turns.push({
                time,
                step: r.idx,
                model: modelName,
                inputTokens: inTok,
                outputTokens: outTok,
                cachedInputTokens: cacheIn,
                cacheMissTokens: missTok,
                cacheWriteTokens: 0,
                thinkingTokens: thinkTok,
                lastOutputTokens: lastOut,
                lastStepInputTokens: inTok,
                lastStepOutputTokens: outTok,
                lastStepCachedInputTokens: cacheIn,
                agentMessageCount: 1,
                totalTokens: inTok + outTok,
                credit: 0,
                elapsedMs: elapsedMs,
                ttftMs: ttftMs,
                requestId: convId + '-step-' + r.idx
            });
        }

        db.close();
        if (total.turns === 0) return null;

        turns.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        meta.createdAt = turns[0].time;
        meta.lastMessageAt = turns[turns.length - 1].time;
        meta.selectedModelId = turns[turns.length - 1].model;

        return {
            ...meta,
            dir: dbPath,
            source: 'Antigravity',
            models: modelStats,
            total,
            turns
        };
    } catch (e) {
        try { db.close(); } catch (_) {}
        return null;
    }
}

// 反重力增量缓存的数据口径版本：解析逻辑发生变化时必须递增，否则旧缓存中的错误数值会一直沿用。
// v2：修正 gen_metadata 输入口径 —— Prompt 总量 = 冷输入(m4[2]) + 缓存命中(m4[5])
// v3：新增端到端耗时 (elapsedMs) 与首字延迟 (ttftMs) 解析，支持生成速率计算
const ANTIGRAVITY_CACHE_VERSION = 3;

// 增量缓存扫描反重力所有会话（毫秒级极速载入）
function collectAntigravityTokenData() {
    const convDirs = getAntigravityConversationDirs();
    if (convDirs.length === 0) return [];

    const cacheFilePath = ANTIGRAVITY_CACHE_FILE;
    let cache = {};
    if (fs.existsSync(cacheFilePath)) {
        try { cache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8')); } catch (e) {
            log.warn('反重力增量缓存读取失败，将全量重扫: ' + ((e && e.message) || e));
        }
    }

    let allDbFiles = [];
    for (const d of convDirs) {
        try {
            const files = fs.readdirSync(d).filter(f => f.endsWith('.db'));
            for (const f of files) {
                allDbFiles.push(path.join(d, f));
            }
        } catch (e) {}
    }

    const conversations = [];
    let cacheUpdated = false;

    for (const dbPath of allDbFiles) {
        try {
            const stat = fs.statSync(dbPath);
            if (stat.size < 4096) continue;
            const convId = path.basename(dbPath, '.db');

            if (cache[convId] && cache[convId].v === ANTIGRAVITY_CACHE_VERSION && cache[convId].mtimeMs === stat.mtimeMs && cache[convId].size === stat.size) {
                if (cache[convId].data) {
                    const { res, needsFix } = sanitizeCachedConversation(cache[convId].data);
                    cache[convId].data = res;
                    if (needsFix) cacheUpdated = true;
                    conversations.push(res);
                }
                continue;
            }

            const res = analyzeAntigravityConversation(dbPath);
            cache[convId] = {
                v: ANTIGRAVITY_CACHE_VERSION,
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                data: res
            };
            cacheUpdated = true;
            if (res) {
                conversations.push(res);
            }
        } catch (e) {}
    }

    if (cacheUpdated) {
        try {
            fs.writeFileSync(cacheFilePath, JSON.stringify(cache));
        } catch (e) {
            log.warn('反重力增量缓存写入失败: ' + ((e && e.message) || e));
        }
    }

    return conversations;
}

// ==========================================
// 3. CodeBuddy 数据采集与会话解析 (完整保留)
// ==========================================
function getCodeBuddyDataDir() {
    if (process.env.CODEBUDDY_DATA_DIR && fs.existsSync(process.env.CODEBUDDY_DATA_DIR)) {
        return process.env.CODEBUDDY_DATA_DIR;
    }
    const home = os.homedir();
    const candidateDirs = [
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CodeBuddyExtension', 'Data'),
        path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data'),
        path.join(home, '.config', 'CodeBuddyExtension', 'Data'),
        path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data')
    ];
    for (const d of candidateDirs) {
        if (fs.existsSync(d)) {
            return d;
        }
    }
    return null;
}

function findConversationDirs(dir) {
    let convDirs = [];
    if (!fs.existsSync(dir)) return convDirs;
    
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return convDirs;
    }
    const names = entries.map(e => e.name);
    
    if (names.includes('index.json') && names.includes('messages')) {
        convDirs.push(dir);
        return convDirs;
    }
    
    for (const entry of entries) {
        if (entry.isDirectory()) {
            convDirs = convDirs.concat(findConversationDirs(path.join(dir, entry.name)));
        }
    }
    return convDirs;
}

function getConversationMeta(convDir) {
    const convId = path.basename(convDir);
    let meta = {
        id: convId,
        name: convId,
        createdAt: '',
        lastMessageAt: '',
        selectedModelId: '',
        workspace: '',
        source: 'CodeBuddy'
    };

    try {
        const parentIndexFile = path.join(path.dirname(convDir), 'index.json');
        if (fs.existsSync(parentIndexFile)) {
            const parentData = JSON.parse(fs.readFileSync(parentIndexFile, 'utf8'));
            if (Array.isArray(parentData.conversations)) {
                const found = parentData.conversations.find(c => c.id === convId);
                if (found) {
                    meta.name = found.name || convId;
                    meta.createdAt = found.createdAt || '';
                    meta.lastMessageAt = found.lastMessageAt || '';
                    meta.selectedModelId = found.selectedModelId || '';
                }
            }
        }
    } catch (e) {}

    return meta;
}

function analyzeConversation(convDir) {
    const meta = getConversationMeta(convDir);
    const msgDir = path.join(convDir, 'messages');
    if (!fs.existsSync(msgDir)) return null;

    let files = [];
    try {
        files = fs.readdirSync(msgDir);
    } catch (e) {
        return null;
    }
    let modelStats = {};
    let turns = [];

    let total = {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheMissTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        lastOutputTokens: 0,
        totalTokens: 0,
        credit: 0,
        elapsedMs: 0
    };

    for (const f of files) {
        try {
            const raw = fs.readFileSync(path.join(msgDir, f), 'utf8');
            const msg = JSON.parse(raw);
            // 统一解析入口：字段口径见 src/core/codebuddy-parse.js
            const parsed = parseCodeBuddyAssistantMessage(msg);
            if (parsed) {
                const modelName = normalizeModelName(parsed.model || meta.selectedModelId || 'Default Model');

                if (!modelStats[modelName]) {
                    modelStats[modelName] = {
                        turns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
                        cacheMissTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0,
                        lastOutputTokens: 0, totalTokens: 0, credit: 0, elapsedMs: 0
                    };
                }

                const m = modelStats[modelName];
                const inTok = parsed.inputTokens;
                const outTok = parsed.outputTokens;
                const cacheIn = parsed.cachedInputTokens;
                const cacheMiss = parsed.cacheMissTokens;
                const cacheWrite = parsed.cacheWriteTokens;
                const thinkTok = parsed.thinkingTokens;
                const lastOut = parsed.lastOutputTokens;
                const cred = parsed.credit;
                const elap = parsed.elapsedMs;

                m.turns += 1;
                m.inputTokens += inTok;
                m.outputTokens += outTok;
                m.cachedInputTokens += cacheIn;
                m.cacheMissTokens += cacheMiss;
                m.cacheWriteTokens += cacheWrite;
                m.thinkingTokens += thinkTok;
                m.lastOutputTokens += lastOut;
                m.totalTokens += (inTok + outTok);
                m.credit += cred;
                m.elapsedMs += elap;

                total.turns += 1;
                total.inputTokens += inTok;
                total.outputTokens += outTok;
                total.cachedInputTokens += cacheIn;
                total.cacheMissTokens += cacheMiss;
                total.cacheWriteTokens += cacheWrite;
                total.thinkingTokens += thinkTok;
                total.lastOutputTokens += lastOut;
                total.totalTokens += (inTok + outTok);
                total.credit += cred;
                total.elapsedMs += elap;

                turns.push({
                    time: parsed.time || msg.createdAt,
                    model: modelName,
                    inputTokens: inTok,
                    outputTokens: outTok,
                    cachedInputTokens: cacheIn,
                    cacheMissTokens: cacheMiss,
                    cacheWriteTokens: cacheWrite,
                    thinkingTokens: thinkTok,
                    lastOutputTokens: lastOut,
                    lastStepInputTokens: parsed.lastStepInputTokens,
                    lastStepOutputTokens: parsed.lastStepOutputTokens,
                    lastStepCachedInputTokens: parsed.lastStepCachedInputTokens,
                    agentMessageCount: parsed.agentMessageCount,
                    totalTokens: inTok + outTok,
                    credit: cred,
                    elapsedMs: elap,
                    requestId: parsed.requestId || ''
                });
            }
        } catch (e) {}
    }

    if (total.turns === 0) return null;

    turns.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    if (!meta.createdAt && turns.length > 0) {
        meta.createdAt = turns[0].time;
    }
    if (!meta.lastMessageAt && turns.length > 0) {
        meta.lastMessageAt = turns[turns.length - 1].time;
    }

    return {
        ...meta,
        dir: convDir,
        source: 'CodeBuddy',
        models: modelStats,
        total,
        turns
    };
}

function collectCodeBuddyTokenData() {
    const dataDir = getCodeBuddyDataDir();
    if (!dataDir) return [];

    const convDirs = findConversationDirs(dataDir);
    const conversations = [];
    const processedConvIds = new Set();

    for (const cDir of convDirs) {
        const convId = path.basename(cDir);
        if (processedConvIds.has(convId)) continue;
        const res = analyzeConversation(cDir);
        if (res) {
            processedConvIds.add(convId);
            conversations.push(res);
        }
    }
    return conversations;
}

// ==========================================
// 3.1 DSH (DeepSeek Harness) 数据采集与会话解析
// ==========================================
// 增量缓存的数据口径版本：解析/计价逻辑变化时必须递增，否则旧缓存中的错误数值会一直沿用。
const DSH_CACHE_VERSION = 2;

const EMPTY_MODEL_STAT = () => ({
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheMissTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    lastOutputTokens: 0,
    totalTokens: 0,
    credit: 0,
    elapsedMs: 0,
    costUsd: 0
});

/** 会话目录名（--D-programme-xxx--）→ 可读路径，仅在日志缺少 cwd 时兜底。 */
function decodeDshProjectDir(projectDir) {
    return String(projectDir || '').replace(/^-+/, '').replace(/-+$/, '');
}

/**
 * 解析单个 DSH 会话：逐次调用明细 → 与 CodeBuddy / Antigravity 同构的会话对象。
 * 计价沿用 dsh-cost-meter 口径（DeepSeek 峰谷两档、缓存写入按命中价、推理免费）。
 */
function analyzeDshSession(home, entry) {
    const pricing = getPricingConfig();
    const proj = readProjcache(home, entry.sessionId) || {};

    const header = {};
    let calls = [];
    let title = '';

    const records = readSessionRecords(entry.filePath);
    if (records) {
        const parsed = extractSession(records);
        if (parsed) {
            Object.assign(header, parsed.header || {});
            calls = parsed.calls || [];
            title = parsed.title || '';
        }
    } else {
        // 运行环境不支持 zstd：退回投影缓存，只提供会话级总量（无法拆分模型与时段）
        const t = proj.totals;
        if (!t) return null;
        calls = [{
            kind: 'assistant',
            provider: '',
            model: '',
            atMs: Number(proj.identity && proj.identity.createdAt) || Date.now(),
            turn: null,
            step: null,
            buckets: {
                input: Number(t.uncachedInputTokens) || 0,
                output: Number(t.outputTokens) || 0,
                cacheRead: Number(t.cacheReadTokens) || 0,
                cacheWrite: Number(t.cacheWriteTokens) || 0,
                reasoning: 0
            }
        }];
    }

    if (calls.length === 0) return null;

    calls.sort((a, b) => a.atMs - b.atMs);

    const modelStats = {};
    const turns = [];
    const total = EMPTY_MODEL_STAT();
    const providers = new Set();
    let peakCostUsd = 0;
    let offPeakCostUsd = 0;
    let selectedModelId = '';

    for (const call of calls) {
        const b = call.buckets;
        // Prompt 总量 = 未命中输入 + 缓存读 + 缓存写（三者在 DSH 中互斥）
        const inputTokens = b.input + b.cacheRead + b.cacheWrite;
        const outputTokens = b.output;
        if (inputTokens === 0 && outputTokens === 0) continue;

        const modelName = normalizeModelName(call.model);
        const tier = resolvePriceTier(call.provider, call.model, call.atMs, pricing.currency);
        const costUsd = usdFromCost(costOfBuckets(b, tier), tier.currency, pricing.exchangeRate);
        if (tier.peak) peakCostUsd += costUsd; else offPeakCostUsd += costUsd;
        if (call.provider) providers.add(call.provider);
        selectedModelId = modelName;

        if (!modelStats[modelName]) modelStats[modelName] = EMPTY_MODEL_STAT();
        const m = modelStats[modelName];
        m.turns += 1;
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
        m.cachedInputTokens += b.cacheRead;
        m.cacheMissTokens += b.input;
        m.cacheWriteTokens += b.cacheWrite;
        m.thinkingTokens += b.reasoning;
        m.lastOutputTokens += outputTokens;
        m.totalTokens += (inputTokens + outputTokens);
        m.costUsd += costUsd;

        total.turns += 1;
        total.inputTokens += inputTokens;
        total.outputTokens += outputTokens;
        total.cachedInputTokens += b.cacheRead;
        total.cacheMissTokens += b.input;
        total.cacheWriteTokens += b.cacheWrite;
        total.thinkingTokens += b.reasoning;
        total.lastOutputTokens += outputTokens;
        total.totalTokens += (inputTokens + outputTokens);
        total.costUsd += costUsd;

        turns.push({
            time: new Date(call.atMs).toISOString(),
            step: call.step == null ? turns.length : call.step,
            model: modelName,
            inputTokens,
            outputTokens,
            cachedInputTokens: b.cacheRead,
            cacheMissTokens: b.input,
            cacheWriteTokens: b.cacheWrite,
            thinkingTokens: b.reasoning,
            lastOutputTokens: outputTokens,
            lastStepInputTokens: inputTokens,
            lastStepOutputTokens: outputTokens,
            lastStepCachedInputTokens: b.cacheRead,
            agentMessageCount: 1,
            totalTokens: inputTokens + outputTokens,
            credit: 0,
            costUsd,
            provider: call.provider,
            peak: !!tier.peak,
            priced: !!tier.priced,
            elapsedMs: 0,
            ttftMs: 0,
            requestId: entry.sessionId + '-call-' + turns.length
        });
    }

    if (total.turns === 0) return null;

    const stats = proj.stats || {};
    const workspace = header.cwd || (proj.identity && proj.identity.cwd) || decodeDshProjectDir(entry.projectDir);
    const name = proj.title || title || (workspace ? path.basename(workspace) : entry.sessionId);
    const createdAtMs = Number(header.createdAt) || Number(proj.identity && proj.identity.createdAt) || 0;

    return {
        id: entry.sessionId,
        name: String(name).replace(/\s+/g, ' ').trim().slice(0, 120) || entry.sessionId,
        createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : turns[0].time,
        lastMessageAt: turns[turns.length - 1].time,
        selectedModelId,
        workspace,
        source: DSH_SOURCE,
        dir: entry.dir,
        models: modelStats,
        total,
        turns,
        dsh: {
            origin: header.origin || '',
            parentSession: header.parentSession || '',
            delegationDepth: Number(header.delegationDepth) || 0,
            agentPreset: header.agentPreset || '',
            providers: [...providers],
            peakCostUsd,
            offPeakCostUsd,
            llmMs: Number(stats.llmMs) || 0,
            turnCount: Number(stats.turns) || 0
        }
    };
}

/** 增量缓存扫描 DSH 全部会话 */
function collectDshTokenData() {
    const home = resolveDshHome();
    if (!home) return [];
    if (!zstdSupported()) {
        log.warn('当前运行时不支持 zstd 解码（需 Node 22.15+ / 23.8+），DSH 将回退到投影缓存总量');
    }

    const entries = listSessionLogFiles(path.join(home, 'sessions'));
    if (entries.length === 0) return [];

    let cache = {};
    if (fs.existsSync(DSH_CACHE_FILE)) {
        try { cache = JSON.parse(fs.readFileSync(DSH_CACHE_FILE, 'utf8')); } catch (e) {
            log.warn('DSH 增量缓存读取失败，将全量重扫: ' + ((e && e.message) || e));
        }
    }

    const conversations = [];
    let cacheUpdated = false;

    for (const entry of entries) {
        try {
            const stat = fs.statSync(entry.filePath);
            const hit = cache[entry.sessionId];
            if (hit && hit.v === DSH_CACHE_VERSION && hit.mtimeMs === stat.mtimeMs &&
                hit.size === stat.size && hit.data) {
                const { res, needsFix } = sanitizeCachedConversation(hit.data);
                hit.data = res;
                if (needsFix) cacheUpdated = true;
                conversations.push(res);
                continue;
            }
            const res = analyzeDshSession(home, entry);
            cache[entry.sessionId] = {
                v: DSH_CACHE_VERSION,
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                data: res
            };
            cacheUpdated = true;
            if (res) conversations.push(res);
        } catch (e) {}
    }

    if (cacheUpdated) {
        try {
            fs.writeFileSync(DSH_CACHE_FILE, JSON.stringify(cache));
        } catch (e) {
            log.warn('DSH 增量缓存写入失败: ' + ((e && e.message) || e));
        }
    }

    return conversations;
}

// ==========================================
// 4. 多源统一聚合管理器 (CodeBuddy & Antigravity & DSH)
// ==========================================
function collectTokenData(filterSource = 'all') {
    let codebuddyConvs = [];
    let antigravityConvs = [];
    let dshConvs = [];

    if (filterSource === 'all' || filterSource === 'codebuddy') {
        try { codebuddyConvs = collectCodeBuddyTokenData(); } catch (e) {}
    }

    if (filterSource === 'all' || filterSource === 'antigravity') {
        try { antigravityConvs = collectAntigravityTokenData(); } catch (e) {}
    }

    if (filterSource === 'all' || filterSource === 'dsh') {
        try { dshConvs = collectDshTokenData(); } catch (e) {}
    }

    const allConvs = [...dshConvs, ...antigravityConvs, ...codebuddyConvs];
    if (allConvs.length === 0) {
        throw new Error('未检索到任何有效 Token 数据（请确认 CodeBuddy / Antigravity / DSH 目录下存在会话数据）');
    }

    let globalModels = {};
    let globalTotal = {
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheMissTokens: 0,
        cacheWriteTokens: 0,
        thinkingTokens: 0,
        lastOutputTokens: 0,
        totalTokens: 0,
        credit: 0,
        elapsedMs: 0,
        costUsd: 0
    };

    for (const res of allConvs) {
        for (const [rawModel, s] of Object.entries(res.models)) {
            const model = normalizeModelName(rawModel);
            if (!globalModels[model]) {
                globalModels[model] = {
                    turns: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedInputTokens: 0,
                    cacheMissTokens: 0,
                    cacheWriteTokens: 0,
                    thinkingTokens: 0,
                    lastOutputTokens: 0,
                    totalTokens: 0,
                    credit: 0,
                    elapsedMs: 0,
                    costUsd: 0
                };
            }
            const gm = globalModels[model];
            gm.turns += s.turns;
            gm.inputTokens += s.inputTokens;
            gm.outputTokens += s.outputTokens;
            gm.cachedInputTokens += s.cachedInputTokens;
            gm.cacheMissTokens += s.cacheMissTokens;
            gm.cacheWriteTokens += (s.cacheWriteTokens || 0);
            gm.thinkingTokens += s.thinkingTokens;
            gm.lastOutputTokens += s.lastOutputTokens;
            gm.totalTokens += s.totalTokens;
            gm.credit += s.credit;
            gm.elapsedMs += s.elapsedMs;
            gm.costUsd += (s.costUsd || 0);

            globalTotal.turns += s.turns;
            globalTotal.inputTokens += s.inputTokens;
            globalTotal.outputTokens += s.outputTokens;
            globalTotal.cachedInputTokens += s.cachedInputTokens;
            globalTotal.cacheMissTokens += s.cacheMissTokens;
            globalTotal.cacheWriteTokens += (s.cacheWriteTokens || 0);
            globalTotal.thinkingTokens += s.thinkingTokens;
            globalTotal.lastOutputTokens += s.lastOutputTokens;
            globalTotal.totalTokens += s.totalTokens;
            globalTotal.credit += s.credit;
            globalTotal.elapsedMs += s.elapsedMs;
            globalTotal.costUsd += (s.costUsd || 0);
        }
    }

    allConvs.sort((a, b) => {
        const timeB = new Date(b.lastMessageAt || (b.turns.length ? b.turns[b.turns.length - 1].time : b.createdAt) || 0).getTime();
        const timeA = new Date(a.lastMessageAt || (a.turns.length ? a.turns[a.turns.length - 1].time : a.createdAt) || 0).getTime();
        return timeB - timeA;
    });

    const antigravityQuota = getAntigravityQuotaInfo();
    const codebuddyCredits = getCodeBuddyCreditsInfo();
    const pointsTasksLast = getPointsTasksLastRun();

    const dshPeakCostUsd = dshConvs.reduce((acc, c) => acc + ((c.dsh && c.dsh.peakCostUsd) || 0), 0);
    const dshOffPeakCostUsd = dshConvs.reduce((acc, c) => acc + ((c.dsh && c.dsh.offPeakCostUsd) || 0), 0);
    const dshPricing = getPricingConfig();

    return {
        fetchedAt: new Date().toISOString(),
        filterSource,
        antigravityQuota,
        codebuddyCredits,
        pointsTasksLast,
        dshPricing,
        sourceStats: {
            antigravity: {
                convCount: antigravityConvs.length,
                turnsCount: antigravityConvs.reduce((acc, c) => acc + c.total.turns, 0),
                totalTokens: antigravityConvs.reduce((acc, c) => acc + c.total.totalTokens, 0)
            },
            codebuddy: {
                convCount: codebuddyConvs.length,
                turnsCount: codebuddyConvs.reduce((acc, c) => acc + c.total.turns, 0),
                totalTokens: codebuddyConvs.reduce((acc, c) => acc + c.total.totalTokens, 0)
            },
            dsh: {
                convCount: dshConvs.length,
                turnsCount: dshConvs.reduce((acc, c) => acc + c.total.turns, 0),
                totalTokens: dshConvs.reduce((acc, c) => acc + c.total.totalTokens, 0),
                inputTokens: dshConvs.reduce((acc, c) => acc + (c.total.inputTokens || 0), 0),
                outputTokens: dshConvs.reduce((acc, c) => acc + (c.total.outputTokens || 0), 0),
                cachedInputTokens: dshConvs.reduce((acc, c) => acc + (c.total.cachedInputTokens || 0), 0),
                cacheMissTokens: dshConvs.reduce((acc, c) => acc + (c.total.cacheMissTokens || 0), 0),
                cacheWriteTokens: dshConvs.reduce((acc, c) => acc + (c.total.cacheWriteTokens || 0), 0),
                thinkingTokens: dshConvs.reduce((acc, c) => acc + (c.total.thinkingTokens || 0), 0),
                costUsd: dshConvs.reduce((acc, c) => acc + (c.total.costUsd || 0), 0),
                peakCostUsd: dshPeakCostUsd,
                offPeakCostUsd: dshOffPeakCostUsd
            }
        },
        globalModels,
        globalTotal,
        conversations: allConvs
    };
}

// ==========================================
// 4.1 「无缓存即联网」的积分汇总入口（VSCode 看板与 CLI 共用同一实现）
// ==========================================
/**
 * 收集 Token 数据，并保证 CodeBuddy 积分可用：
 *   1) 优先读取本地积分缓存（含所有回退路径）；
 *   2) 若一份缓存都没有（或 forceSync 为 true），主动联网同步一次后再返回。
 * 注：syncCreditsBestEffort 自身不会抛异常（失败时回退缓存并返回 error 字段）。
 * @param {string} [sourceFilter='all'] 数据来源过滤：all / codebuddy / antigravity
 * @param {object} [opts]
 * @param {number}   [opts.timeoutMs=15000]  联网获取的超时预算
 * @param {boolean}  [opts.forceSync=false]  已有缓存也强制联网刷新
 * @param {function} [opts.onCredits]        同步成功后的回调（收到最新积分对象）
 * @param {function} [opts.log]              过程日志回调
 * @returns {Promise<object>} 与 collectTokenData 同结构的数据对象
 */
async function collectTokenDataWithCredits(sourceFilter = 'all', opts = {}) {
    const { timeoutMs = 15000, forceSync = false, onCredits = null, log = null } = opts;

    let credits = null;
    try { credits = getCodeBuddyCreditsInfo(); } catch (e) { credits = null; }

    if (forceSync || !credits) {
        const reason = forceSync ? '本地有积分缓存，按配置强制联网刷新' : '本地无任何积分缓存，联网获取积分';
        if (log) log(reason);
        const r = await syncCreditsBestEffort(timeoutMs);
        if (r && r.credits) {
            credits = r.credits;
            if (onCredits) onCredits(credits);
        } else if (log) {
            log('积分联网获取失败: ' + ((r && r.error) || '未知原因'));
        }
    }

    const data = collectTokenData(sourceFilter);
    if (credits) data.codebuddyCredits = credits;
    return data;
}

// ==========================================
// 5. 生成专业全维度 HTML 报表 (无花哨图标，极简黑白高质感)
// ==========================================
// 只负责渲染出完整的 HTML 字符串（不落盘），供 CLI 与 VSCode 扩展 Webview 共用。
// 报表 HTML 生成器（已外置到 src/report/builder.js，本文件不再承载前端资源）
const { buildReportHtml } = require('./src/report/builder');

function generateHtmlReport(data) {
    const htmlContent = buildReportHtml(data);
    try { fs.mkdirSync(path.dirname(REPORT_OUTPUT_PATH), { recursive: true }); } catch (e) {}
    fs.writeFileSync(REPORT_OUTPUT_PATH, htmlContent, 'utf8');
    return REPORT_OUTPUT_PATH;
}

// ==========================================
// 6. 本地后台服务与 HTTP 端点 (支持自动退出与一键增量刷新)
// ==========================================
// 积分同步（尽力而为）：实时同步成功返回实时数据；失败则回退本地缓存，
// 并返回 live=false + 错误原因，供前端区分「实时同步完成」与「仅显示旧缓存」。
async function syncCreditsBestEffort(timeoutMs = 15000) {
    try {
        const credits = await syncCodeBuddyCredits({ timeoutMs });
        return { live: true, credits, error: null };
    } catch (e) {
        return { live: false, credits: getCodeBuddyCreditsInfo(), error: e.message || String(e) };
    }
}

// 组装「一键刷新」响应体：重新收集 CodeBuddy & Antigravity 数据，并尽力同步一次官方积分。
// 供本地 HTTP 服务 (/api/refresh) 与 VSCode 扩展 Webview 共用。
async function buildRefreshPayload({ writeReport = false } = {}) {
    const creditsResult = await syncCreditsBestEffort(8000);
    const refreshed = collectTokenData('all');
    if (creditsResult.credits) refreshed.codebuddyCredits = creditsResult.credits;
    if (writeReport) {
        try { generateHtmlReport(refreshed); } catch (e) {}
    }
    return {
        success: true,
        fetchedAt: refreshed.fetchedAt,
        antigravityQuota: refreshed.antigravityQuota,
        codebuddyCredits: refreshed.codebuddyCredits,
        creditsLive: creditsResult.live,
        creditsError: creditsResult.error,
        sourceStats: refreshed.sourceStats,
        dshPricing: refreshed.dshPricing,
        buildId: SCRIPT_BUILD_ID,
        conversations: refreshed.conversations.map(c => ({
            id: c.id,
            name: c.name,
            source: c.source,
            createdAt: c.createdAt,
            lastMessageAt: c.lastMessageAt,
            turns: c.turns
        }))
    };
}

// 6/7. CLI 控制台入口与本地 HTTP 报表服务已外置到 src/cli.js
// （原 startServer / openUrl / ensureServerAndOpen / main 均迁移至该模块）
// CLI 启动钩子见本文件末尾（必须位于 module.exports 之后，避免循环 require 拿到空导出）。

// ==========================================
// TurnWatcher 专用：只解析 Antigravity DB 最后一条 gen_metadata，
// 轻量高效，不产生完整会话分析的开销。
// 返回 null 表示无有效数据。
// ==========================================
function analyzeAntigravityConversationLatestTurn(dbPath) {
    if (!DatabaseSync) return null;
    let db;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
        return null;
    }
    try {
        // 只取最后一条有效记录（idx 最大且 size > 0）
        const row = db.prepare(
            'SELECT idx, data FROM gen_metadata WHERE size > 0 ORDER BY idx DESC LIMIT 1'
        ).get();
        if (!row || !row.data) { db.close(); return null; }

        // 统一解析入口：字段口径见 src/core/antigravity-parse.js
        const parsed = parseGenMetadataRow(row.data);
        if (!parsed) { db.close(); return null; }

        const missTok = parsed.cacheMissTokens;
        const cacheIn = parsed.cachedInputTokens;
        const inTok = parsed.inputTokens;
        const outTok = parsed.outputTokens;
        const thinkTok = parsed.thinkingTokens;
        const lastOut = parsed.lastOutputTokens;
        if (inTok === 0 && outTok === 0) { db.close(); return null; }

        const modelName = normalizeModelName(parsed.model);
        const elapsedMs = parsed.elapsedMs;
        const ttftMs = parsed.ttftMs;

        const maxTokens = getModelMaxTokens(modelName);
        // 上下文占用 = 本轮输入 + 本轮输出（回答结束后的窗口占用快照）
        const ctxUsed = inTok + outTok;
        let contextPercent = null;
        if (maxTokens > 0 && ctxUsed > 0) {
            contextPercent = ((ctxUsed / maxTokens) * 100).toFixed(1) + '%';
        }

        let speed = 0;
        if (outTok > 0 && elapsedMs > 0) {
            speed = Number((outTok / (elapsedMs / 1000)).toFixed(1));
        }

        const convId = path.basename(dbPath, '.db');
        db.close();
        return {
            source: 'Antigravity',
            model: modelName,
            inputTokens: inTok,
            outputTokens: outTok,
            cachedInputTokens: cacheIn,
            cacheMissTokens: missTok,
            cacheWriteTokens: 0,
            thinkingTokens: thinkTok,
            lastOutputTokens: lastOut,
            totalTokens: inTok + outTok,
            credit: 0,
            elapsedMs: elapsedMs,
            ttftMs: ttftMs,
            maxTokens: maxTokens,
            contextPercent: contextPercent,
            speed: speed,
            requestId: convId + '-step-' + row.idx
        };
    } catch (e) {
        try { db.close(); } catch (_) {}
        return null;
    }
}

// ==========================================
// TurnWatcher 专用：聚合某会话（DB）内全部 turn 的输出与耗时，
// 用于计算「当前对话累计平均速率」= Σ输出 / Σ耗时。
// 与 latestTurn 分离，仅做一次线性扫描，不触发额外的元数据查询。
// ==========================================
function analyzeAntigravityConversationCumulative(dbPath) {
    if (!DatabaseSync) return null;
    let db;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
    } catch (e) {
        return null;
    }
    try {
        const rows = db.prepare(
            'SELECT idx, data FROM gen_metadata WHERE size > 0 ORDER BY idx ASC'
        ).all();
        let sumIn = 0;
        let sumOut = 0;
        let sumCachedIn = 0;
        let sumMissIn = 0;
        let sumThinking = 0;
        let sumLastOut = 0;
        let sumElapsed = 0;
        let turns = 0;
        for (const r of rows) {
            const parsed = parseGenMetadataRow(r.data);
            if (!parsed) continue;
            sumIn += (parsed.inputTokens || 0);
            sumOut += (parsed.outputTokens || 0);
            sumCachedIn += (parsed.cachedInputTokens || 0);
            sumMissIn += (parsed.cacheMissTokens || 0);
            sumThinking += (parsed.thinkingTokens || 0);
            sumLastOut += (parsed.lastOutputTokens || 0);
            sumElapsed += (parsed.elapsedMs || 0);
            turns += 1;
        }
        db.close();

        const avgSpeed = sumElapsed > 0
            ? Number((sumOut / (sumElapsed / 1000)).toFixed(1))
            : 0;
        return {
            turns: turns,
            inputTokens: sumIn,
            outputTokens: sumOut,
            cachedInputTokens: sumCachedIn,
            cacheMissTokens: sumMissIn,
            thinkingTokens: sumThinking,
            lastOutputTokens: sumLastOut,
            totalTokens: sumIn + sumOut,
            elapsedMs: sumElapsed,
            avgSpeed: avgSpeed
        };
    } catch (e) {
        try { db.close(); } catch (_) {}
        return null;
    }
}

function isSqliteAvailable() {
    return !!DatabaseSync;
}

module.exports = {
    // 数据目录（扩展模式下指向 VSCode globalStorage）
    setDataDir,
    getDataDir: () => DATA_DIR,
    getReportOutputPath: () => REPORT_OUTPUT_PATH,
    isSqliteAvailable,
    // 跨平台凭据管理
    setCustomSession,
    getCustomSession,
    extractUidFromJwt,
    getConfiguredOrManualSession,
    getCodeBuddyDataDir,
    getWorkBuddyDesktopSession,
    // 核心能力
    collectTokenData,
    collectTokenDataWithCredits,
    buildReportHtml,
    generateHtmlReport,
    buildRefreshPayload,
    syncCodeBuddyCredits,
    syncCreditsBestEffort,
    runAllPointsTasks,
    runAutoDailyCheckin,
    getAutoCheckinRecord,
    getCodeBuddyCreditsInfo,
    getPointsTasksLastRun,
    getAntigravityQuotaInfo,
    getModelMaxTokens,
    // CLI 服务所需
    SCRIPT_BUILD_ID,
    REPORT_OUTPUT_PATH,
    // TurnWatcher 专用：轻量解析最新一条 Antigravity turn
    analyzeAntigravityConversationLatestTurn,
    // TurnWatcher 专用：聚合当前对话累计平均速率
    analyzeAntigravityConversationCumulative
};

// 仅在作为 CLI 直接执行时启动命令行主流程；被 VSCode 扩展 require 时只暴露 API，不产生副作用。
// 必须置于 module.exports 之后：src/cli.js 会反向 require 本模块，需确保届时导出已就绪。
if (require.main === module) {
    require('./src/cli').main().catch(err => {
        console.error('运行异常:', err);
        process.exit(1);
    });
}
