/**
 * turn-watcher.js — 实时监听 Antigravity 每条回答后的 Token 统计与耗时
 *
 * 工作原理：
 *  · Antigravity: 监视 conversations 目录与 .db 文件变动，基于 requestId 自动去重并轻量解析最新一条 gen_metadata 上报
 *
 * 注：CodeBuddy 会话的实时监听已移除（CodeBuddy 扩展自身即具备该能力，无需重复实现），
 *     本项目仅在大盘 / 报表中对其会话数据做汇总统计。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { fileURLToPath } = require('url');
const { decodeProtobuf } = require('./core/protobuf');

let DatabaseSync;
try {
    const sqlite = require('node:sqlite');
    DatabaseSync = sqlite.DatabaseSync;
} catch (e) {
    // Node.js < 22.5 fallback
}

// ─── 格式化辅助 ───────────────────────────────────────────────────────────────

function fmtNum(n) {
    if (!n || n === 0) return '0';
    if (n === 1048576) return '1M';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
}

function fmtMs(ms) {
    if (!ms || ms <= 0) return null;
    if (ms >= 60_000) return (ms / 60_000).toFixed(1) + ' min';
    if (ms >= 1_000) return (ms / 1_000).toFixed(1) + 's';
    return ms + 'ms';
}

function fmtSpeed(outTokens, ms) {
    if (!outTokens || !ms || ms <= 0) return null;
    const tps = outTokens / (ms / 1000);
    return (tps >= 100 ? tps.toFixed(0) : tps.toFixed(1)) + ' t/s';
}

function fmtSpeedShort(outTokens, ms) {
    if (!outTokens || !ms || ms <= 0) return null;
    const tps = outTokens / (ms / 1000);
    return (tps >= 100 ? tps.toFixed(0) : tps.toFixed(1)) + ' t/s';
}

/**
 * 为 turn 附加「当前对话累计数据」（cum: Token、耗时、平均速率等）。
 */
function attachCumulativeData(turn, sourceRef, core) {
    if (!turn || !core) return turn;
    if (turn.source === 'Antigravity' && typeof core.analyzeAntigravityConversationCumulative === 'function') {
        try {
            const cum = core.analyzeAntigravityConversationCumulative(sourceRef);
            if (cum) {
                turn.cumulative = cum;
                turn.avgSpeed = cum.avgSpeed;
                turn.convTurns = cum.turns;
                turn.convInputTokens = cum.inputTokens;
                turn.convOutputTokens = cum.outputTokens;
                turn.convCachedInputTokens = cum.cachedInputTokens;
                turn.convCacheMissTokens = cum.cacheMissTokens;
                turn.convThinkingTokens = cum.thinkingTokens;
                turn.convLastOutputTokens = cum.lastOutputTokens;
                turn.convTotalTokens = cum.totalTokens;
                turn.convElapsedMs = cum.elapsedMs;
            }
        } catch (e) {}
    }
    return turn;
}

/**
 * 构建状态栏短文本（仅显示总token量、上下文占比、token速度）
 * 例: 118.9k · 11.3% · 87.9 t/s
 */
function buildStatusText(turn) {
    if (!turn) return '0';
    const parts = [];

    // 1. 总 Token 量 (Total Tokens)：优先当前对话累计总 Token
    const cum = turn.cumulative;
    const total = (cum && cum.totalTokens > 0)
        ? cum.totalTokens
        : (turn.convTotalTokens || turn.totalTokens || ((turn.inputTokens || 0) + (turn.outputTokens || 0)));
    if (total > 0) {
        parts.push(fmtNum(total));
    }

    // 2. 上下文占比 (Context Usage Percent) = (本轮输入 + 本轮输出) / 上下文上限
    let ctxPct = turn.contextPercent;
    if (!ctxPct && turn.maxTokens) {
        const ctxUsed = (turn.inputTokens || 0) + (turn.outputTokens || 0);
        if (ctxUsed > 0) {
            ctxPct = ((ctxUsed / turn.maxTokens) * 100).toFixed(1) + '%';
        }
    }
    if (ctxPct) {
        parts.push(ctxPct);
    }

    // 3. Token 速度 (Token Speed)：优先展示「当前对话累计平均速率」，
    //    缺少累计数据时回退到本次回答的瞬时速率。
    const rateVal = (cum && cum.avgSpeed > 0) ? cum.avgSpeed : (turn.avgSpeed || turn.speed);
    const speedStr = rateVal
        ? (rateVal >= 100 ? rateVal.toFixed(0) : rateVal.toFixed(1)) + ' t/s'
        : fmtSpeedShort(turn.outputTokens, turn.elapsedMs);
    if (speedStr) {
        parts.push(speedStr);
    }

    return parts.length > 0 ? parts.join(' · ') : '0';
}

function fmtMaxTokens(max) {
    if (!max || max <= 0) return null;
    if (max === 1048576 || max === 1_000_000) return '1000k';
    if (max === 2097152 || max === 2_000_000) return '2000k';
    if (max >= 1_000) return Math.round(max / 1000) + 'k';
    return String(max);
}

function formatRemainingTime(resetTimeStr) {
    if (!resetTimeStr) return '';
    try {
        const resetMs = new Date(resetTimeStr).getTime();
        if (isNaN(resetMs)) return '';
        const nowMs = Date.now();
        const diffMs = resetMs - nowMs;
        if (diffMs <= 0) return '0m';

        const totalHours = diffMs / (3600 * 1000);
        if (totalHours >= 24) {
            const days = Math.floor(totalHours / 24);
            const remHours = Math.round(totalHours % 24);
            return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
        } else if (totalHours >= 1) {
            return `${Math.round(totalHours)}h`;
        } else {
            const mins = Math.max(1, Math.round(diffMs / (60 * 1000)));
            return `${mins}m`;
        }
    } catch (e) {
        return '';
    }
}

function parseRefreshDescription(desc) {
    if (!desc || typeof desc !== 'string') return null;
    const dayMatch = desc.match(/(\d+)\s*day/i);
    const hourMatch = desc.match(/(\d+)\s*hour/i);
    const minMatch = desc.match(/(\d+)\s*min/i);
    
    const days = dayMatch ? parseInt(dayMatch[1], 10) : 0;
    const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0;
    const mins = minMatch ? parseInt(minMatch[1], 10) : 0;

    if (days > 0) {
        return hours > 0 ? `${days}d${hours}h` : `${days}d`;
    }
    if (hours > 0) {
        return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
    }
    if (mins > 0) {
        return `${mins}m`;
    }
    return null;
}

function formatSingleQuota(item) {
    if (!item) return null;
    const frac = item.remainingFraction ?? item.remaining?.remainingFraction ?? item.remaining?.value;
    if (typeof frac !== 'number') return null;
    const timeStr = formatRemainingTime(item.resetTime) || parseRefreshDescription(item.description);
    const pct = Math.round(frac * 1000) / 10;
    const pctStr = (pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)) + '%';
    return timeStr ? `${timeStr}：${pctStr}` : pctStr;
}

function getUserQuotaSummaryFile() {
    const home = os.homedir();
    const candidates = [
        path.join(home, '.gemini', 'antigravity-ide', 'debug_retrieveUserQuotaSummary.json'),
        path.join(home, '.gemini', 'antigravity', 'debug_retrieveUserQuotaSummary.json'),
        path.join(home, '.gemini', 'antigravity-cli', 'debug_retrieveUserQuotaSummary.json')
    ];
    return candidates.find(f => fs.existsSync(f)) || null;
}

let cachedUserQuotaSummary = null;
let lastQuotaSummaryFetchTime = 0;

function getUserQuotaSummary() {
    const now = Date.now();
    if (cachedUserQuotaSummary && (now - lastQuotaSummaryFetchTime < 15000)) {
        return cachedUserQuotaSummary;
    }
    const filePath = getUserQuotaSummaryFile();
    if (!filePath) return cachedUserQuotaSummary;
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const groups = raw.groups || raw.response?.groups || (Array.isArray(raw) ? raw : null);
        if (groups && Array.isArray(groups)) {
            cachedUserQuotaSummary = groups;
            lastQuotaSummaryFetchTime = now;
            return groups;
        }
    } catch (e) {}
    return cachedUserQuotaSummary;
}

function getQuotaTextFromGroups(groups, modelName) {
    if (!groups || !Array.isArray(groups) || groups.length === 0) return '';
    const norm = (modelName || '').toLowerCase();
    
    // 1. 匹配分组
    let targetGroup = null;
    if (norm.includes('claude') || norm.includes('gpt')) {
        targetGroup = groups.find(g => /claude|gpt/i.test(g.displayName));
    } else if (norm.includes('gemini')) {
        targetGroup = groups.find(g => /gemini/i.test(g.displayName));
    }
    if (!targetGroup) {
        targetGroup = groups.find(g => g.buckets && g.buckets.length > 0) || groups[0];
    }
    if (!targetGroup || !Array.isArray(targetGroup.buckets) || targetGroup.buckets.length === 0) {
        return '';
    }

    // 2. 区分短周期桶 (5 Hour / Hour) 和周配额桶 (Weekly / Week)
    const buckets = targetGroup.buckets;
    let shortBucket = buckets.find(b => /hour|小时|短/i.test(b.displayName));
    let weeklyBucket = buckets.find(b => /week|周/i.test(b.displayName));

    if (!shortBucket && !weeklyBucket) {
        if (buckets.length >= 2) {
            shortBucket = buckets[1];
            weeklyBucket = buckets[0];
        } else if (buckets.length === 1) {
            shortBucket = buckets[0];
        }
    }

    const items = [];
    const shortStr = formatSingleQuota(shortBucket);
    const weeklyStr = formatSingleQuota(weeklyBucket);

    if (shortStr) items.push(shortStr);
    if (weeklyStr && weeklyStr !== shortStr) items.push(weeklyStr);

    return items.join('，');
}

let isFetchingQuotaOnline = false;
let lastOnlineFetchTime = 0;

function fetchUserQuotaSummaryOnline() {
    const now = Date.now();
    if (isFetchingQuotaOnline || (now - lastOnlineFetchTime < 60000)) return;
    
    let vscodeModule = null;
    try {
        vscodeModule = require('vscode');
    } catch (e) {
        return;
    }
    if (!vscodeModule) return;

    (async () => {
        isFetchingQuotaOnline = true;
        try {
            let token = null;
            try {
                const tokenInfo = await vscodeModule.antigravityUnifiedStateSync?.OAuthPreferences?.getOAuthTokenInfo?.();
                if (tokenInfo && tokenInfo.accessToken) {
                    token = tokenInfo.accessToken;
                }
            } catch (e) {}

            if (!token) {
                try {
                    const session = await vscodeModule.authentication.getSession('antigravity_auth', [], { createIfNone: false });
                    if (session && session.accessToken) {
                        token = session.accessToken;
                    }
                } catch (e) {}
            }

            if (!token) return;

            const req = http.request('http://127.0.0.1:50999/v1internal:retrieveUserQuotaSummary', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 3000
            }, (res) => {
                if (res.statusCode !== 200) return;
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        const groups = parsed.groups || parsed.response?.groups;
                        if (groups && Array.isArray(groups)) {
                            cachedUserQuotaSummary = groups;
                            lastQuotaSummaryFetchTime = Date.now();
                            lastOnlineFetchTime = Date.now();
                            const home = os.homedir();
                            const savePath = path.join(home, '.gemini', 'antigravity', 'debug_retrieveUserQuotaSummary.json');
                            fs.mkdirSync(path.dirname(savePath), { recursive: true });
                            fs.writeFileSync(savePath, JSON.stringify(parsed, null, 2), 'utf8');
                        }
                    } catch (e) {}
                });
            });
            req.on('error', () => {});
            req.on('timeout', () => req.destroy());
            req.write('{}');
            req.end();
        } catch (e) {} finally {
            isFetchingQuotaOnline = false;
        }
    })();
}

function getModelQuotaText(modelName) {
    if (!modelName) return '';
    try {
        // 尝试触发在线刷新
        fetchUserQuotaSummaryOnline();

        // 1. 优先从 UserQuotaSummary（支持周额度和5小时额度）读取
        const groups = getUserQuotaSummary();
        if (groups && groups.length > 0) {
            const groupText = getQuotaTextFromGroups(groups, modelName);
            if (groupText) return groupText;
        }

        // 2. 兜底：从 debug_fetchAvailableModels.json 读取
        const home = os.homedir();
        const quotaFileCandidates = [
            path.join(home, '.gemini', 'antigravity-ide', 'debug_fetchAvailableModels.json'),
            path.join(home, '.gemini', 'antigravity', 'debug_fetchAvailableModels.json'),
            path.join(home, '.gemini', 'antigravity-cli', 'debug_fetchAvailableModels.json')
        ];
        const quotaFile = quotaFileCandidates.find(f => fs.existsSync(f));
        if (!quotaFile) return '';

        const raw = JSON.parse(fs.readFileSync(quotaFile, 'utf8'));
        if (!raw || !raw.models) return '';

        let matched = null;
        let matchedKey = null;
        const normTarget = modelName.toLowerCase().replace(/[^a-z0-9]/g, '');

        // 1. 精确匹配 displayName 或 key
        for (const [key, m] of Object.entries(raw.models)) {
            if (m.displayName && m.displayName.toLowerCase() === modelName.toLowerCase()) {
                matched = m;
                matchedKey = key;
                break;
            }
            if (key.toLowerCase() === modelName.toLowerCase()) {
                matched = m;
                matchedKey = key;
                break;
            }
        }

        // 2. 归一化模糊匹配
        if (!matched) {
            for (const [key, m] of Object.entries(raw.models)) {
                const kNorm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
                const dNorm = (m.displayName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                if ((dNorm && (normTarget.includes(dNorm) || dNorm.includes(normTarget))) ||
                    (normTarget.includes(kNorm) || kNorm.includes(normTarget))) {
                    matched = m;
                    matchedKey = key;
                    break;
                }
            }
        }

        // 3. 兜底：如果模型名为 Gemini，尝试找主力模型
        if (!matched && normTarget.includes('gemini')) {
            matched = raw.models['gemini-3.8-flash-high'] || raw.models['gemini-3.7-flash-high'];
            matchedKey = 'gemini-3.8-flash-high';
        }

        if (!matched) return '';

        const items = [];
        const seenReset = new Set();

        const addQuotaItem = (item) => {
            if (!item || typeof item.remainingFraction !== 'number') return;
            const sig = `${item.resetTime || ''}_${item.remainingFraction.toFixed(4)}`;
            if (seenReset.has(sig)) return;
            seenReset.add(sig);
            const str = formatSingleQuota(item);
            if (str) items.push(str);
        };

        // A. 基础配额 quotaInfo（可能是对象或数组）
        if (matched.quotaInfo) {
            if (Array.isArray(matched.quotaInfo)) {
                matched.quotaInfo.forEach(addQuotaItem);
            } else {
                addQuotaItem(matched.quotaInfo);
                if (matched.quotaInfo.weekly) addQuotaItem(matched.quotaInfo.weekly);
                if (matched.quotaInfo.weeklyQuota) addQuotaItem(matched.quotaInfo.weeklyQuota);
                if (matched.quotaInfo.longTerm) addQuotaItem(matched.quotaInfo.longTerm);
                if (matched.quotaInfo.longTermQuota) addQuotaItem(matched.quotaInfo.longTermQuota);
                if (Array.isArray(matched.quotaInfo.subQuotas)) matched.quotaInfo.subQuotas.forEach(addQuotaItem);
                if (Array.isArray(matched.quotaInfo.quotas)) matched.quotaInfo.quotas.forEach(addQuotaItem);
            }
        }

        // B. 模型对象自身的周额度属性
        if (matched.weeklyQuota) addQuotaItem(matched.weeklyQuota);
        if (matched.weeklyQuotaInfo) addQuotaItem(matched.weeklyQuotaInfo);
        if (matched.longTermQuota) addQuotaItem(matched.longTermQuota);

        // C. 检查关联阶梯 / 周配额模型（Tiered Models）
        if (matchedKey) {
            const tieredKey = matchedKey.replace(/-(high|low|medium)$/, '-tiered');
            if (tieredKey !== matchedKey && raw.models[tieredKey] && raw.models[tieredKey].quotaInfo) {
                addQuotaItem(raw.models[tieredKey].quotaInfo);
            }
        }

        if (items.length === 0) return '';
        return items.join('，');
    } catch (e) {
        return '';
    }
}

/**
 * 构建完整的 tooltip / 消息弹窗多行详情文本（当前对话累计数据）
 */
function buildDetailText(turn) {
    if (!turn) return '';
    const lines = [];
    const model = turn.model || 'Unknown';
    lines.push(model);

    // 配额行（含周额度，例如：3h：68.8%，1d11h：30%）
    const quotaText = turn.quotaText || getModelQuotaText(model);
    if (quotaText) {
        lines.push(quotaText);
    }

    // 上下文：13.7% · 144.1k/1000k
    // 注：上下文占用 = 最新轮次的输入 + 输出，即该轮回答结束后窗口的实际占用
    const ctxUsed = (turn.inputTokens || 0) + (turn.outputTokens || 0);
    if (ctxUsed > 0) {
        let ctxPct = turn.contextPercent;
        if (!ctxPct && turn.maxTokens) {
            ctxPct = ((ctxUsed / turn.maxTokens) * 100).toFixed(1) + '%';
        }
        const maxStr = fmtMaxTokens(turn.maxTokens);
        const ratioStr = maxStr
            ? `${fmtNum(ctxUsed)}/${maxStr}`
            : fmtNum(ctxUsed);
        const pctPrefix = ctxPct ? `${ctxPct} · ` : '';
        lines.push(`上下文：${pctPrefix}${ratioStr}`);
    }

    // 速率 与 耗时 同行显示：
    // 例: 速率：109 t/s     耗时：8.2 min
    const cum = turn.cumulative;
    const rateVal = (cum && cum.avgSpeed > 0) ? cum.avgSpeed : (turn.avgSpeed || turn.speed);
    const speedStr = rateVal
        ? (rateVal >= 100 ? rateVal.toFixed(0) : rateVal.toFixed(1)) + ' t/s'
        : fmtSpeedShort(turn.outputTokens, turn.elapsedMs);

    const elapsedMs = (cum && cum.elapsedMs > 0) ? cum.elapsedMs : turn.elapsedMs;
    const durStr = fmtMs(elapsedMs);

    if (speedStr && durStr) {
        lines.push(`速率：${speedStr}     耗时：${durStr}`);
    } else if (speedStr) {
        lines.push(`速率：${speedStr}`);
    } else if (durStr) {
        lines.push(`耗时：${durStr}`);
    }

    // 合计 Token 与各分项（优先使用当前对话累计数据 cum）
    const totalTokens = (cum && typeof cum.totalTokens === 'number')
        ? cum.totalTokens
        : (turn.convTotalTokens || turn.totalTokens || ((turn.inputTokens || 0) + (turn.outputTokens || 0)));
    const inputTokens = (cum && typeof cum.inputTokens === 'number')
        ? cum.inputTokens
        : (turn.convInputTokens !== undefined ? turn.convInputTokens : turn.inputTokens);
    const cachedInputTokens = (cum && typeof cum.cachedInputTokens === 'number')
        ? cum.cachedInputTokens
        : (turn.convCachedInputTokens !== undefined ? turn.convCachedInputTokens : turn.cachedInputTokens);
    const cacheMissTokens = (cum && typeof cum.cacheMissTokens === 'number')
        ? cum.cacheMissTokens
        : (turn.convCacheMissTokens !== undefined ? turn.convCacheMissTokens : turn.cacheMissTokens);
    const outputTokens = (cum && typeof cum.outputTokens === 'number')
        ? cum.outputTokens
        : (turn.convOutputTokens !== undefined ? turn.convOutputTokens : turn.outputTokens);
    const thinkingTokens = (cum && typeof cum.thinkingTokens === 'number')
        ? cum.thinkingTokens
        : (turn.convThinkingTokens !== undefined ? turn.convThinkingTokens : turn.thinkingTokens);
    const lastOutputTokens = (cum && typeof cum.lastOutputTokens === 'number')
        ? cum.lastOutputTokens
        : (turn.convLastOutputTokens !== undefined ? turn.convLastOutputTokens : turn.lastOutputTokens);
    const credit = (cum && typeof cum.credit === 'number')
        ? cum.credit
        : turn.credit;

    // 合计 Token:  56.0k
    lines.push(`合计 Token:  ${fmtNum(totalTokens)}`);

    //     输入：54.3k
    //       ↳ 缓存命中：44.8k (82.5%)
    //       ↳ 冷输入：9.5k
    if (inputTokens) {
        lines.push(`    输入：${fmtNum(inputTokens)}`);
        if (cachedInputTokens) {
            const hitRate = ((cachedInputTokens / inputTokens) * 100).toFixed(1) + '%';
            lines.push(`      ↳ 缓存命中：${fmtNum(cachedInputTokens)} (${hitRate})`);
        }
        if (cacheMissTokens) {
            lines.push(`      ↳ 冷输入：${fmtNum(cacheMissTokens)}`);
        }
    }

    //     输出：1.6k
    //      ↳ 思考：1.5k
    //      ↳ 正文呈现：196
    if (outputTokens) {
        lines.push(`    输出：${fmtNum(outputTokens)}`);
        if (thinkingTokens) {
            lines.push(`     ↳ 思考：${fmtNum(thinkingTokens)}`);
        }
        if (lastOutputTokens && thinkingTokens) {
            lines.push(`     ↳ 正文呈现：${fmtNum(lastOutputTokens)}`);
        } else if (lastOutputTokens && lastOutputTokens !== outputTokens) {
            lines.push(`     ↳ 正文呈现：${fmtNum(lastOutputTokens)}`);
        }
    }

    if (credit) {
        lines.push(`    积分消耗：${typeof credit.toFixed === 'function' ? credit.toFixed(4) : credit} Credits`);
    }

    return lines.join('\n');
}

// ─── Antigravity 辅助 ────────────────────────────────────────────────────────

function getAntigravityConvDirs() {
    const home = os.homedir();
    return [
        path.join(home, '.gemini', 'antigravity-ide', 'conversations'),
        path.join(home, '.gemini', 'antigravity', 'conversations'),
        path.join(home, '.gemini', 'antigravity-cli', 'conversations')
    ].filter(d => fs.existsSync(d));
}

// ─── 工作区隔离辅助 ──────────────────────────────────────────────────────────

const agDbWorkspaceCache = new Map();

function uriToFsPath(uriStr) {
    if (!uriStr || typeof uriStr !== 'string') return null;
    try {
        return path.normalize(fileURLToPath(uriStr));
    } catch (e) {
        try {
            let p = decodeURIComponent(uriStr);
            if (p.startsWith('file://')) {
                p = p.slice(7);
                // Windows 下 /D:/path 去掉开头的 /；Linux 下 /home/user 保留开头的 /
                if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
                    p = p.slice(1);
                } else if (process.platform !== 'win32' && !p.startsWith('/')) {
                    p = '/' + p;
                }
            }
            if (process.platform === 'win32') {
                p = p.replace(/\//g, '\\');
            }
            return path.normalize(p);
        } catch (_) {
            return null;
        }
    }
}

function normalizePath(p) {
    if (!p) return '';
    let norm = path.normalize(p);
    if (process.platform === 'win32') {
        norm = norm.toLowerCase();
    }
    return norm;
}

/**
 * 从 Antigravity 对话 DB 中提取其所属工作区的本地绝对路径。
 * 解析 trajectory_metadata_blob 表的 Protobuf 数据。
 * @param {string} dbPath
 * @returns {string|null} 规范化的工作区绝对路径（例如 "d:\\programme\\codebuddy-plugin+"），或 null（无工作区）
 */
function getAntigravityConversationWorkspace(dbPath) {
    if (!dbPath) return null;
    if (agDbWorkspaceCache.has(dbPath)) {
        return agDbWorkspaceCache.get(dbPath);
    }
    if (!fs.existsSync(dbPath)) return null;

    let wsPath = null;
    if (DatabaseSync) {
        let db = null;
        try {
            db = new DatabaseSync(dbPath, { readOnly: true });
            const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
            if (row && row.data) {
                const decoded = decodeProtobuf(Buffer.from(row.data));
                let uri = null;
                // 优先字段1子字段1（最标准的工作区 URI 存储位）
                if (decoded[1] && decoded[1][0]) {
                    const sub = decodeProtobuf(decoded[1][0]);
                    if (sub[1] && sub[1][0]) {
                        uri = Buffer.from(sub[1][0]).toString('utf8');
                    }
                }
                // 兜底字段7
                if (!uri && decoded[7] && decoded[7][0]) {
                    uri = Buffer.from(decoded[7][0]).toString('utf8');
                }
                if (uri) {
                    wsPath = uriToFsPath(uri);
                }
            }
        } catch (e) {
            // 忽略读取错误
        } finally {
            if (db) {
                try { db.close(); } catch (_) {}
            }
        }
    }

    if (wsPath) {
        agDbWorkspaceCache.set(dbPath, wsPath);
    }
    return wsPath;
}

/**
 * 判断指定 Antigravity DB 是否属于目标工作区列表
 * @param {string} dbPath DB 路径
 * @param {string[]|null|undefined} targetWorkspaceDirs 目标工作区路径列表。null/undefined 表示不过滤（匹配所有）；[] 表示匹配无工作区对话
 * @returns {boolean}
 */
function isDbInWorkspace(dbPath, targetWorkspaceDirs) {
    if (targetWorkspaceDirs === null || targetWorkspaceDirs === undefined) {
        return true;
    }
    if (targetWorkspaceDirs.length === 0) {
        // 空窗口（无工作区文件夹）：仅匹配同样无工作区关联的会话
        const convWs = getAntigravityConversationWorkspace(dbPath);
        return !convWs;
    }

    const convWs = getAntigravityConversationWorkspace(dbPath);
    if (!convWs) return false;

    const normConvWs = normalizePath(convWs);
    for (const wsDir of targetWorkspaceDirs) {
        const normWs = normalizePath(wsDir);
        if (normConvWs === normWs) return true;
        const rel = path.relative(normWs, normConvWs);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
        const relRev = path.relative(normConvWs, normWs);
        if (!relRev.startsWith('..') && !path.isAbsolute(relRev)) return true;
    }
    return false;
}

function getAntigravityDbFiles(targetWorkspaceDirs = null) {
    const dirs = getAntigravityConvDirs();
    const files = [];
    for (const d of dirs) {
        try {
            for (const f of fs.readdirSync(d)) {
                if (f.endsWith('.db')) {
                    const full = path.join(d, f);
                    if (targetWorkspaceDirs === null || isDbInWorkspace(full, targetWorkspaceDirs)) {
                        files.push(full);
                    }
                }
            }
        } catch (e) {}
    }
    return files;
}

// ─── 主监听器类 ───────────────────────────────────────────────────────────────

class TurnWatcher {
    /**
     * @param {object} opts
     * @param {function(turn: object): void}   opts.onTurn              新 turn 回调
     * @param {function(string): void}         [opts.onNewConversation] 检测到新对话（.db 首次出现）时的回调
     * @param {function(string): void}         [opts.log]               日志函数
     * @param {number}                         [opts.pollIntervalMs]    Antigravity 轮询间隔，默认 3000ms
     * @param {boolean}                        [opts.watchAntigravity]  是否监听 Antigravity，默认 true
     * @param {string[]|function(): string[]}  [opts.getWorkspaceDirs]  当前窗口工作区绝对路径列表或获取函数
     */
    constructor(opts = {}) {
        this._onTurn = opts.onTurn || (() => {});
        this._onNewConversation = opts.onNewConversation || (() => {});
        this._log = opts.log || (() => {});
        this._pollIntervalMs = opts.pollIntervalMs || 3000;
        this._watchAntigravity = opts.watchAntigravity !== false;
        this._getWorkspaceDirs = typeof opts.getWorkspaceDirs === 'function'
            ? opts.getWorkspaceDirs
            : (() => opts.workspaceDirs || null);

        // Antigravity 相关
        this._agMtimes = new Map();
        this._agLastRequestId = new Map();
        this._agWatchers = new Map();
        this._agDebounceTimers = new Map();
        this._agNotifiedNewConvs = new Set();
        this._agTimer = null;

        // token-stats.js core 引用
        this._core = null;
    }

    _isDbRelevant(dbPath) {
        const wsDirs = this._getWorkspaceDirs();
        if (wsDirs === null) return true;
        return isDbInWorkspace(dbPath, wsDirs);
    }

    /** 注入 token-stats.js 导出对象，用于 Antigravity DB 解析 */
    setCore(core) {
        this._core = core;
    }

    start() {
        if (this._watchAntigravity) this._startAntigravity();
        this._log('[TurnWatcher] 监听服务已全部启动');
    }

    stop() {
        // 清理 Antigravity 监听与定时器
        for (const w of this._agWatchers.values()) {
            try { w.close(); } catch (e) {}
        }
        this._agWatchers.clear();
        for (const t of this._agDebounceTimers.values()) clearTimeout(t);
        this._agDebounceTimers.clear();
        this._agNotifiedNewConvs.clear();

        if (this._agTimer) {
            clearInterval(this._agTimer);
            this._agTimer = null;
        }

        this._log('[TurnWatcher] 监听服务已停止');
    }

    // ── Antigravity 实现 ───────────────────────────────────────────────────────

    _startAntigravity() {
        const convDirs = getAntigravityConvDirs();
        this._log('[TurnWatcher] Antigravity 会话目录: ' + convDirs.length + ' 个');

        // 对会话目录添加 fs.watch，捕获即时写入事件（零延迟响应）
        for (const dir of convDirs) {
            try {
                const w = fs.watch(dir, { persistent: false }, (event, filename) => {
                    if (!filename) return;
                    if (filename.endsWith('.db') || filename.endsWith('.db-wal')) {
                        const dbName = filename.replace(/-wal$/, '').replace(/-shm$/, '');
                        const fullDb = path.join(dir, dbName);

                        if (this._agDebounceTimers.has(fullDb)) {
                            clearTimeout(this._agDebounceTimers.get(fullDb));
                        }
                        const timer = setTimeout(() => {
                            this._agDebounceTimers.delete(fullDb);
                            if (!fs.existsSync(fullDb)) return;

                            // 关键：严格过滤工作区，非本窗口工作区的 DB 变动直接忽略
                            if (!this._isDbRelevant(fullDb)) return;

                            // 检测到本工作区全新 .db 文件（首次出现）→ 立即通知新对话
                            if (!this._agMtimes.has(fullDb)) {
                                try {
                                    this._agMtimes.set(fullDb, fs.statSync(fullDb).mtimeMs);
                                } catch (e) {}
                                if (!this._agNotifiedNewConvs.has(fullDb)) {
                                    this._agNotifiedNewConvs.add(fullDb);
                                    this._log('[TurnWatcher] Antigravity 当前工作区检测到新对话: ' + path.basename(fullDb));
                                    this._onNewConversation(fullDb);
                                }
                            }
                            this._handleAntigravityDb(fullDb);
                        }, 150);
                        this._agDebounceTimers.set(fullDb, timer);
                    }
                });
                w.on('error', () => {});
                this._agWatchers.set(dir, w);
                this._log('[TurnWatcher] Antigravity 目录实时监听已开启: ' + dir);
            } catch (e) {}
        }

        // 扫描当前工作区所有 DB 文件的初始 mtime
        const wsDirs = this._getWorkspaceDirs();
        const dbFiles = getAntigravityDbFiles(wsDirs);
        const sortedDbs = [];
        for (const f of dbFiles) {
            try {
                const stat = fs.statSync(f);
                this._agMtimes.set(f, stat.mtimeMs);
                sortedDbs.push({ path: f, mtime: stat.mtimeMs });
            } catch (e) {}
        }

        // 仅对最近修改的最多 5 个活跃会话预先记录 requestId，避免启动时产生历史误报且兼顾性能（<20ms）
        sortedDbs.sort((a, b) => b.mtime - a.mtime);
        const topDbs = sortedDbs.slice(0, 5);
        if (this._core) {
            for (const item of topDbs) {
                try {
                    const latest = this._core.analyzeAntigravityConversationLatestTurn(item.path);
                    if (latest && latest.requestId) {
                        this._agLastRequestId.set(item.path, latest.requestId);
                    }
                } catch (e) {}
            }
        }

        // 保留轮询定时器作为兜底机制（防 watch 事件偶发丢失）
        this._agTimer = setInterval(() => this._pollAntigravity(), this._pollIntervalMs);
    }

    _pollAntigravity() {
        const wsDirs = this._getWorkspaceDirs();
        const dbFiles = getAntigravityDbFiles(wsDirs);
        for (const dbPath of dbFiles) {
            try {
                const stat = fs.statSync(dbPath);
                const prev = this._agMtimes.get(dbPath);

                if (prev === undefined) {
                    // 全新出现的 DB：通知新对话，再尝试解析（首次往往还没数据）
                    this._agMtimes.set(dbPath, stat.mtimeMs);
                    this._log('[TurnWatcher] Antigravity 轮询发现新对话: ' + path.basename(dbPath));
                    this._onNewConversation(dbPath);
                    this._handleAntigravityDb(dbPath);
                    continue;
                }

                if (stat.mtimeMs > prev) {
                    this._agMtimes.set(dbPath, stat.mtimeMs);
                    this._handleAntigravityDb(dbPath);
                }
            } catch (e) {}
        }
    }

    _handleAntigravityDb(dbPath) {
        if (!this._core) return;
        if (!fs.existsSync(dbPath)) return;
        if (!this._isDbRelevant(dbPath)) return;
        try {
            const turn = this._core.analyzeAntigravityConversationLatestTurn(dbPath);
            if (!turn || !turn.requestId) return;

            const lastReq = this._agLastRequestId.get(dbPath);
            if (lastReq === turn.requestId) {
                // 该 turn 已经上报过，严格去重
                return;
            }

            this._agLastRequestId.set(dbPath, turn.requestId);
            attachCumulativeData(turn, dbPath, this._core);
            // 附加所属对话 DB 路径，供 extension.js 判断是否为当前活跃对话
            turn.dbPath = dbPath;
            this._log('[TurnWatcher] Antigravity 新 turn: ' + turn.model
                + ' in=' + turn.inputTokens + ' out=' + turn.outputTokens);
            this._onTurn(turn);
        } catch (e) {
            this._log('[TurnWatcher] Antigravity DB 解析失败: ' + e.message);
        }
    }
}

/**
 * 启动时快速获取当前工作区最近一条反重力 AI 回答记录（若存在）
 * @param {object} core token-stats.js 导出模块
 * @param {string[]|null} [targetWorkspaceDirs] 目标工作区路径列表，传 null 不做过滤
 * @returns {object|null}
 */
function getLatestAntigravityTurn(core, targetWorkspaceDirs = null) {
    if (!core || typeof core.analyzeAntigravityConversationLatestTurn !== 'function') return null;
    const dbFiles = getAntigravityDbFiles();
    if (!dbFiles || dbFiles.length === 0) return null;
    const sorted = [];
    for (const f of dbFiles) {
        try {
            const stat = fs.statSync(f);
            sorted.push({ path: f, mtime: stat.mtimeMs });
        } catch (e) {}
    }
    sorted.sort((a, b) => b.mtime - a.mtime);
    for (const item of sorted) {
        if (targetWorkspaceDirs !== null && !isDbInWorkspace(item.path, targetWorkspaceDirs)) {
            continue;
        }
        try {
            const turn = core.analyzeAntigravityConversationLatestTurn(item.path);
            if (turn) {
                attachCumulativeData(turn, item.path, core);
                // 附加所属对话 DB 路径
                turn.dbPath = item.path;
                return turn;
            }
        } catch (e) {}
    }
    return null;
}

/**
 * 获取当前工作区最新活跃的 Antigravity 对话 DB 路径（按 mtime 排序取第一位）。
 * 用于检测用户是否已切换到新对话（新对话的 .db 文件 mtime 最新，但尚无 turn 记录）。
 * @param {string[]|null} [targetWorkspaceDirs] 目标工作区路径列表，传 null 不做过滤
 * @returns {string|null}
 */
function getActiveAntigravityDbPath(targetWorkspaceDirs = null) {
    const dbFiles = getAntigravityDbFiles();
    if (!dbFiles || dbFiles.length === 0) return null;
    const sorted = [];
    for (const f of dbFiles) {
        try {
            const stat = fs.statSync(f);
            sorted.push({ path: f, mtime: stat.mtimeMs });
        } catch (e) {}
    }
    sorted.sort((a, b) => b.mtime - a.mtime);
    for (const item of sorted) {
        if (targetWorkspaceDirs !== null && !isDbInWorkspace(item.path, targetWorkspaceDirs)) {
            continue;
        }
        return item.path;
    }
    return null;
}

module.exports = {
    TurnWatcher,
    buildStatusText,
    buildDetailText,
    getLatestAntigravityTurn,
    getActiveAntigravityDbPath,
    getAntigravityConversationWorkspace,
    isDbInWorkspace,
    uriToFsPath,
    fmtNum,
    fmtMs,
    fmtSpeed,
    fmtSpeedShort,
    parseRefreshDescription,
    formatRemainingTime,
    getModelQuotaText,
    getQuotaTextFromGroups,
    getUserQuotaSummary
};
