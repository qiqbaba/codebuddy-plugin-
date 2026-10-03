'use strict';

const fs = require('fs');
const log = require('./log');

// ==========================================
// 模型名称规范化与别名归一化 (防止 API ID 与 Display Name 分裂)
// ==========================================
const MODEL_NAME_ALIASES = {
    'gemini-3.8-flash': 'Gemini 3.8 Flash (High)',
    'gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
    'gemini-3.7-flash': 'Gemini 3.7 Flash (High)',
    'gemini-3.7-flash-high': 'Gemini 3.7 Flash (High)',
    'claude-sonnet-4.6': 'Claude Sonnet 4.6 (Thinking)',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6 (Thinking)',
    'claude-3-7-sonnet': 'Claude Sonnet 3.7',
    'deepseek-v4-pro': 'Deepseek V4 Pro',
    'sensenova-v4-flash': '商汤 V4 Flash'
};

function normalizeModelName(raw) {
    if (!raw || typeof raw !== 'string') return 'Unknown Model';
    const trimmed = raw.trim();
    if (!trimmed) return 'Unknown Model';
    return MODEL_NAME_ALIASES[trimmed.toLowerCase()] || trimmed;
}

// ==========================================
// 模型上下文上限 (maxTokens) 集中管理
// 优先级：用户覆盖(model-limits.json) > 反重力配额文件 > 内置系列回退
// ==========================================
let modelLimitOverrides = {};

/** 设置用户自定义上限覆盖表（键为模型名/别名，值为上下文上限） */
function setModelLimitOverrides(map) {
    modelLimitOverrides = (map && typeof map === 'object') ? map : {};
}

/** 从 JSON 文件加载用户覆盖表，返回是否加载成功 */
function loadModelLimitOverrides(filePath) {
    if (!filePath) return false;
    if (!fs.existsSync(filePath)) return false;
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        setModelLimitOverrides(raw);
        return true;
    } catch (e) {
        log.warn('加载模型上限覆盖表失败 (' + filePath + '): ' + ((e && e.message) || e));
        return false;
    }
}

/**
 * 根据模型名称匹配其最大上下文上限 (maxTokens)
 * @param {string} modelName 归一化前的模型名
 * @param {object} [quotaInfo] 反重力配额信息（getAntigravityQuotaInfo 的返回值）
 */
function getModelMaxTokens(modelName, quotaInfo) {
    if (!modelName) return 0;
    const lower = modelName.toLowerCase();

    // 0. 用户自定义覆盖（精确或大小写不敏感匹配）
    if (modelLimitOverrides[modelName]) return modelLimitOverrides[modelName];
    for (const k of Object.keys(modelLimitOverrides)) {
        if (k.toLowerCase() === lower) return modelLimitOverrides[k];
    }

    // 1. 反重力配额文件（真实可用模型优先）
    try {
        if (quotaInfo && quotaInfo.models) {
            for (const [k, m] of Object.entries(quotaInfo.models)) {
                if (k.toLowerCase() === lower ||
                    (m.displayName && m.displayName.toLowerCase() === lower)) {
                    if (m.maxTokens) return m.maxTokens;
                }
            }
            const norm = lower.replace(/[^a-z0-9]/g, '');
            for (const [k, m] of Object.entries(quotaInfo.models)) {
                const kNorm = k.toLowerCase().replace(/[^a-z0-9]/g, '');
                const dNorm = (m.displayName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                if (norm.includes(kNorm) || kNorm.includes(norm) || (dNorm && (norm.includes(dNorm) || dNorm.includes(norm)))) {
                    if (m.maxTokens) return m.maxTokens;
                }
            }
        }
    } catch (e) {
        log.warn('读取模型配额上限失败: ' + ((e && e.message) || e));
    }

    // 2. 内置系列回退（顺序与历史行为保持一致）
    if (lower.includes('gemini') || lower.includes('flash') || lower.includes('pro')) return 1048576;
    if (lower.includes('claude')) return 250000;
    if (lower.includes('gpt-4') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 128000;
    if (lower.includes('deepseek')) return 65536;
    if (lower.includes('qwen') || lower.includes('glm') || lower.includes('kimi')) return 131072;
    return 0;
}

module.exports = {
    MODEL_NAME_ALIASES,
    normalizeModelName,
    setModelLimitOverrides,
    loadModelLimitOverrides,
    getModelMaxTokens
};
