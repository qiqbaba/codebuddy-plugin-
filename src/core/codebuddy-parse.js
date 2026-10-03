'use strict';

/**
 * CodeBuddy assistant 消息中 statsSnapshot 的「唯一」解析入口。
 * token-stats.js 的会话全量分析与 turn-watcher 的实时上报都复用此函数，
 * 避免两处独立维护导致口径分裂。
 *
 * 注意：本函数不做「零用量行」过滤（历史上两条调用链行为不同），
 * 由调用方按各自需要决定是否跳过 inputTokens === 0 && outputTokens === 0 的记录。
 *
 * @param {object} msg 会话 messages/*.json 解析后的对象
 * @returns {object|null} 结构不完整时返回 null
 */
function parseCodeBuddyAssistantMessage(msg) {
    if (!msg || msg.role !== 'assistant' || !msg.extra) return null;

    let extra = msg.extra;
    if (typeof extra === 'string') {
        try { extra = JSON.parse(extra); } catch (e) { return null; }
    }
    if (!extra || !extra.statsSnapshot) return null;

    const snap = extra.statsSnapshot;
    const inputTokens = snap.inputTokens || 0;
    const outputTokens = snap.outputTokens || 0;
    const cachedInputTokens = snap.cachedInputTokens || 0;

    return {
        time: msg.createdAt || null,
        // 原始模型名，未归一化；调用方负责 normalizeModelName 与默认值
        model: extra.modelName || extra.modelId || null,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        cachedInputTokens: cachedInputTokens,
        cacheMissTokens: snap.cacheMissTokens !== undefined
            ? snap.cacheMissTokens
            : Math.max(0, inputTokens - cachedInputTokens),
        cacheWriteTokens: snap.cacheWriteTokens || 0,
        thinkingTokens: snap.thinkingTokens || 0,
        lastOutputTokens: snap.lastOutputTokens || 0,
        credit: snap.credit || 0,
        elapsedMs: snap.elapsedMs || 0,
        requestId: extra.requestId || null,
        lastStepInputTokens: extra.lastStepInputTokens || 0,
        lastStepOutputTokens: extra.lastStepOutputTokens || 0,
        lastStepCachedInputTokens: extra.lastStepCachedInputTokens || 0,
        agentMessageCount: extra.agentMessageCount || 1
    };
}

module.exports = { parseCodeBuddyAssistantMessage };
