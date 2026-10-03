'use strict';

/**
 * 统一日志出口。
 *
 * 扩展模式下由 extension.js 注入 OutputChannel；CLI 模式下未注入时默认静默，
 * 避免污染命令行输出（CLI 的重要信息仍走 console 直接打印）。
 * 所有模块统一通过本文件记录，替换分散在各处的静默 `catch (e) {}`。
 */

let sink = null;

/** 注入日志消费者，签名 (level, message) => void */
function setSink(fn) {
    sink = typeof fn === 'function' ? fn : null;
}

function emit(level, msg) {
    if (!sink) return;
    try { sink(level, msg); } catch (e) { /* 日志本身失败不得影响主流程 */ }
}

function info(msg) { emit('INFO', msg); }
function warn(msg) { emit('WARN', msg); }
function error(msg) { emit('ERROR', msg); }

/**
 * 便捷包装：吞掉异常但记录明细，替代 `catch (e) {}`。
 * 适合「可预期失败、不应中断主流程」的场景（可选文件读取、watcher 事件等）。
 */
function swallow(scope, fn) {
    try { return fn(); } catch (e) {
        warn(scope + ' 失败: ' + ((e && e.message) || e));
        return undefined;
    }
}

module.exports = { setSink, info, warn, error, swallow };
