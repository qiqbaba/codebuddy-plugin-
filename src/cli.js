'use strict';

// ==========================================
// CLI 控制台入口 + 本地 HTTP 报表服务
// 由 token-stats.js 拆分而来：核心数据采集/渲染能力通过 core 复用。
// 仅当本模块被 require（CLI 模式）时才访问 core，此时 token-stats 已完成初始化。
// 注意：本文件不含任何数据解析逻辑，仅做「终端输出 + HTTP 服务」两件事。
// ==========================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const api = require('./core/api');
const log = require('./core/log');

const core = require('./../token-stats');
const {
    collectTokenData,
    collectTokenDataWithCredits,
    generateHtmlReport,
    buildRefreshPayload,
    syncCodeBuddyCredits,
    syncCreditsBestEffort,
    runAllPointsTasks,
    getCodeBuddyCreditsInfo,
    SCRIPT_BUILD_ID,
    REPORT_OUTPUT_PATH
} = core;

// 统一 API 上下文：让本地 HTTP 服务与 Webview 复用同一套 /api/* 实现
function serverApiContext(startedAt) {
    return {
        collectTokenData: (source) => collectTokenData(source),
        buildRefreshPayload: (opts) => buildRefreshPayload(opts),
        syncCreditsBestEffort: (ms) => syncCreditsBestEffort(ms),
        runAllPointsTasks: () => runAllPointsTasks(),
        getDataSource: () => 'all',
        buildId: SCRIPT_BUILD_ID,
        startedAt: startedAt,
        writeReportOnRefresh: true,
        log: (m) => console.log('[' + new Date().toLocaleTimeString() + '] ' + m)
    };
}
function startServer(port = 3333, openBrowser = false) {
    let exitTimer = null;
    let lastClientActivity = Date.now();
    let hasClientConnected = false;
    const serverStartedAt = new Date().toISOString();

    const server = http.createServer((req, res) => {
        // 跨域支持
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const reqUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
        const pathname = reqUrl.pathname;

        // 页面关闭信号：延时 3000ms 退出 (留出页面刷新/重连时间，避免刷新页面把后台服务带退出)
        if (pathname === '/api/exit') {
            if (exitTimer) clearTimeout(exitTimer);
            exitTimer = setTimeout(() => {
                console.log('\n[退出] 网页已关闭，后台服务自动退出并释放端口。');
                server.close(() => process.exit(0));
                setTimeout(() => process.exit(0), 300);
            }, 3000);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true }));
            return;
        }

        lastClientActivity = Date.now();
        if (exitTimer) {
            clearTimeout(exitTimer);
            exitTimer = null;
        }

        if (pathname === '/api/heartbeat') {
            hasClientConnected = true;
            lastClientActivity = Date.now();
        }

        // 静态报表页
        if (pathname === '/' || pathname === '/index.html' || pathname === '/token-report.html') {
            const reportPath = REPORT_OUTPUT_PATH;
            if (!fs.existsSync(reportPath)) {
                generateHtmlReport(collectTokenData('all'));
            }
            fs.readFile(reportPath, (err, fileData) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('读取报表失败: ' + err.message);
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                });
                res.end(fileData);
            });
            return;
        }

        // 其余 /api/* 统一交由 core/api.js（与 Webview 共用同一实现，杜绝双套路由漂移）
        if (pathname.startsWith('/api/')) {
            api.handleApiRequest(serverApiContext(serverStartedAt), pathname)
                .then(result => {
                    res.writeHead(result.status, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-cache, no-store, must-revalidate'
                    });
                    res.end(JSON.stringify(result.body));
                })
                .catch(err => {
                    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: (err && err.message) || String(err) }));
                });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    });

    const watchdog = setInterval(() => {
        const isServeMode = process.argv.includes('--serve') || process.argv.includes('--server');
        if (!isServeMode && hasClientConnected && Date.now() - lastClientActivity > 30000) {
            console.log('\n[退出] 网页已全部关闭超过 12 秒，后台服务自动退出并释放端口。');
            clearInterval(watchdog);
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 300);
        }
    }, 3000);

    server.on('error', (err) => {
        clearInterval(watchdog);
        if (err.code === 'EADDRINUSE') {
            console.warn('[提示] 端口 ' + port + ' 已被占用，尝试使用备用端口 ' + (port + 1) + '...');
            startServer(port + 1, openBrowser);
        } else {
            console.error('服务启动失败:', err);
        }
    });

    server.listen(port, '127.0.0.1', () => {
        const url = 'http://127.0.0.1:' + port + '/';
        console.log('\n[服务已启动] 本地 Token 报表服务: ' + url);
        console.log('[智能回收] 支持多标签页并发。当所有报表标签页关闭超过 12 秒后，服务将自动退出并释放端口。');
        if (openBrowser) {
            openUrl(url);
        }
    });
}

function openUrl(url) {
    const startCmd = process.platform === 'darwin' ? 'open' :
                     process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(startCmd + ' "' + url + '"', (err) => {
        if (err) console.error('打开浏览器失败:', err.message);
    });
}

function ensureServerAndOpen(port = 3333, openBrowser = false) {
    let settled = false;
    const testReq = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: '/api/heartbeat',
        method: 'GET',
        timeout: 1500
    }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
            if (settled) return;
            settled = true;
            let info = null;
            try { info = JSON.parse(body); } catch (e) {}

            // 版本一致：直接复用已有服务
            if (info && info.buildId && info.buildId === SCRIPT_BUILD_ID) {
                if (openBrowser) {
                    openUrl('http://127.0.0.1:' + port + '/');
                } else {
                    console.log('[提示] 发现后台报表服务已在运行中: http://127.0.0.1:' + port + '/');
                }
                return;
            }

            // 端口上存在的是旧版本(或其它程序)的服务：它可能缺少 /api/sync-credits 等新接口，
            // 导致页面上的「刷新 / 刷新积分」点了也没反应。此时自动改用后续端口启动最新版服务。
            console.warn('[提示] 端口 ' + port + ' 上的后台服务不是当前版本 (buildId: ' + ((info && info.buildId) || '未知') + ')，继续使用会导致一键刷新/积分同步失效。');
            console.warn('[提示] 已在端口 ' + (port + 1) + ' 启动最新版后台服务，请使用新端口页面，或先结束旧进程后重试。');
            startServer(port + 1, openBrowser);
        });
    });

    testReq.on('error', () => {
        if (settled) return;
        settled = true;
        startServer(port, openBrowser);
    });

    testReq.on('timeout', () => {
        testReq.destroy();
        if (settled) return;
        settled = true;
        startServer(port, openBrowser);
    });

    testReq.end();
}

// ==========================================
// 7. CLI 控制台主入口
// ==========================================
async function main() {
    const args = process.argv.slice(2);

    // 核心模块过程日志的出口：--json 必须保持 stdout 纯净，该模式下一律写 stderr
    const jsonMode = args.includes('--json');
    log.setSink((level, msg) => {
        const line = '[' + level + '] ' + msg;
        if (jsonMode) console.error(line);
        else console.log(line);
    });

    // 一键领取全部积分任务：每日签到 + 成长中心 (旅行礼物/派 Buddy/任务/补登/连登兑换/盲盒/Buddy 盲盒)
    // 登录态取自本机反重力 IDE 插件或 WorkBuddy 桌面端凭据，幂等安全，重复执行不会多领
    if (args.includes('--signin') || args.includes('--points-tasks') || args.includes('--growth')) {
        console.log('正在执行 CodeBuddy 积分任务 (每日签到 + 成长中心全部奖励)...');
        try {
            const r = await runAllPointsTasks();
            console.log('>>> 积分任务执行完成 <<<');
            console.log('   账号        : ' + (r.account || '-'));
            console.log('   每日签到    : ' + r.checkin.report);
            console.log('   成长中心    : ' + r.growth.report);
            console.log('   本次共领取  : +' + (r.creditsGained || 0) + ' 积分');
            if (!r.success) process.exitCode = 1;
        } catch (err) {
            console.error('积分任务执行失败: ' + err.message);
            process.exitCode = 1;
        }
        if (!args.includes('--html') && !args.includes('--serve')) return;
    }

    // 显式触发同步 CodeBuddy 积分
    if (args.includes('--sync-credits') || args.includes('--refresh-credits')) {
        console.log('正在同步 CodeBuddy 最新积分用量 (优先读取反重力 IDE 插件登录态)...');
        try {
            const res = await syncCodeBuddyCredits({ timeoutMs: 15000 });
            console.log('>>> CodeBuddy 积分同步成功！<<<');
            let sourceLabel = '本地缓存';
            if (res.source === 'antigravity-plugin') sourceLabel = '反重力 IDE 插件 (直连 API)';
            else if (res.source === 'workbuddy-desktop') sourceLabel = 'WorkBuddy 桌面客户端';
            else if (res.source === 'live' || res.source === 'browser') sourceLabel = '浏览器扩展同步';
            console.log('   数据来源    : ' + sourceLabel);
            console.log('   全账户总额度: ' + res.totalCredits.toFixed(2) + ' Credits');
            console.log('   剩余可用积分: ' + res.remainCredits.toFixed(2) + ' Credits (' + res.remainPercent + ')');
            console.log('   已消耗积分  : ' + res.usedCredits.toFixed(2) + ' Credits (' + res.usedPercent + ')');
            if (res.checkin) {
                console.log('   每日签到    : ' + (res.checkin.todayCheckedIn ? '今日已签' : '今日未签') + ' (连签 ' + (res.checkin.streakDays || 0) + ' 天)');
            }
        } catch (err) {
            console.warn('自动同步未就绪 (' + err.message + ')，当前继续使用本地积分缓存。');
        }
        if (!args.includes('--html') && !args.includes('--serve')) return;
    }

    // 专门查看 CodeBuddy 积分看板
    if (args.includes('--credits') || args.includes('-c')) {
        // 无缓存即联网：本地一份缓存（含所有回退路径）都没有时，主动获取一次
        let credits = getCodeBuddyCreditsInfo();
        if (!credits) {
            console.log('未发现本地 CodeBuddy 积分缓存，正在联网获取...');
            const r = await syncCreditsBestEffort(15000);
            credits = r.credits;
            if (!credits) console.warn('积分联网获取失败: ' + (r.error || '未知原因') + '\n');
        }
        console.log('===================================================================================================');
        console.log('                 CodeBuddy 官方账号积分与用量看板 (腾讯云代码助手)                ');
        console.log('===================================================================================================');
        if (!credits || typeof credits.totalCredits !== 'number') {
            console.log('暂无 CodeBuddy 积分缓存数据。如需同步最新积分，请执行: node token-stats.js --sync-credits\n');
        } else {
            const updateStr = credits.updatedAt ? new Date(credits.updatedAt).toLocaleString() : '-';
            let sourceLabel = '本地缓存';
            if (credits.source === 'antigravity-plugin') sourceLabel = '反重力 IDE 插件 (直连 API)';
            else if (credits.source === 'workbuddy-desktop') sourceLabel = 'WorkBuddy 桌面客户端';
            else if (credits.source === 'live' || credits.source === 'browser') sourceLabel = '浏览器扩展同步';
            console.log('   全账户总额度: ' + credits.totalCredits.toFixed(2) + ' Credits');
            console.log('   剩余可用积分: ' + credits.remainCredits.toFixed(2) + ' Credits (' + credits.remainPercent + ')');
            console.log('   已消耗积分  : ' + credits.usedCredits.toFixed(2) + ' Credits (' + credits.usedPercent + ')');
            console.log('   数据更新时间: ' + updateStr + ' [' + sourceLabel + ']');
            if (credits.checkin) {
                console.log('   每日签到状态: ' + (credits.checkin.todayCheckedIn ? '今日已签' : '今日未签') + ' (连签 ' + (credits.checkin.streakDays || 0) + ' 天)');
            }
            if (credits.packages && credits.packages.length > 0) {
                console.log('\n【各套餐与加量包明细】');
                for (const pkg of credits.packages) {
                    const statusTag = pkg.inUsage ? ' [当前生效中]' : '';
                    const timeTag = (pkg.cycleStartTime && pkg.cycleEndTime) ? (' | 周期: ' + pkg.cycleStartTime.slice(0, 10) + ' ~ ' + pkg.cycleEndTime.slice(0, 10)) : '';
                    console.log('   - ' + pkg.name + statusTag + ':');
                    console.log('     额度: ' + pkg.total.toFixed(2) + ' Credits | 剩余: ' + pkg.remain.toFixed(2) + ' | 已用: ' + pkg.used.toFixed(2) + timeTag);
                }
            }
            console.log('===================================================================================================\n');
        }
        return;
    }

    let sourceFilter = 'all';
    const srcArgIdx = args.findIndex(a => a === '--source' || a === '-s');
    if (srcArgIdx !== -1 && args[srcArgIdx + 1]) {
        sourceFilter = args[srcArgIdx + 1].toLowerCase();
    }

    if (args.includes('--json')) {
        let d;
        try {
            d = await collectTokenDataWithCredits(sourceFilter, {
                timeoutMs: 15000,
                log: (m) => console.error('[积分] ' + m)
            });
        } catch (err) {
            console.error(err.message);
            process.exit(1);
        }
        console.log(JSON.stringify({
            antigravityQuota: d.antigravityQuota,
            codebuddyCredits: d.codebuddyCredits,
            sourceStats: d.sourceStats,
            globalModels: d.globalModels,
            globalTotal: d.globalTotal,
            conversations: d.conversations
        }, null, 2));
        return;
    }

    if (args.includes('--serve') || args.includes('--server')) {
        const portArgIndex = args.findIndex(a => a === '--port' || a === '-p');
        const port = portArgIndex !== -1 && args[portArgIndex + 1] ? parseInt(args[portArgIndex + 1], 10) : 3333;
        ensureServerAndOpen(port, false);
        return;
    }

    let data;
    try {
        data = await collectTokenDataWithCredits(sourceFilter, {
            timeoutMs: 15000,
            log: (m) => console.log('[积分] ' + m)
        });
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }

    // 生成全维度 HTML 报表
    generateHtmlReport(data);

    if (args.includes('--html')) {
        const portArgIndex = args.findIndex(a => a === '--port' || a === '-p');
        const port = portArgIndex !== -1 && args[portArgIndex + 1] ? parseInt(args[portArgIndex + 1], 10) : 3333;
        ensureServerAndOpen(port, true);
        return;
    }

    const { globalModels, globalTotal, conversations, antigravityQuota, codebuddyCredits, sourceStats } = data;

    console.log('===================================================================================================');
    console.log('                 AI 编程全维度 Token 统计与累计分析大盘 (CodeBuddy & Antigravity)                   ');
    console.log('===================================================================================================');

    if (codebuddyCredits && codebuddyCredits.totalCredits > 0) {
        const updateStr = codebuddyCredits.updatedAt ? new Date(codebuddyCredits.updatedAt).toLocaleString() : '-';
        const sourceLabel = codebuddyCredits.source === 'live' ? '实时同步' : '本地缓存';
        console.log('\n【CodeBuddy 官方账号积分与用量 - 腾讯云代码助手】');
        console.log('   全账户总额度: ' + codebuddyCredits.totalCredits.toFixed(2) + ' Credits | 剩余积分: ' + codebuddyCredits.remainCredits.toFixed(2) + ' Credits (' + codebuddyCredits.remainPercent + ') | 已用积分: ' + codebuddyCredits.usedCredits.toFixed(2) + ' Credits (' + codebuddyCredits.usedPercent + ')');
        console.log('   数据更新时间: ' + updateStr + ' [' + sourceLabel + ']');
        if (codebuddyCredits.packages && codebuddyCredits.packages.length > 0) {
            console.log('   各套餐与加量包明细:');
            for (const pkg of codebuddyCredits.packages) {
                const statusTag = pkg.inUsage ? ' [当前生效中]' : '';
                const timeTag = (pkg.cycleStartTime && pkg.cycleEndTime) ? (' | 周期: ' + pkg.cycleStartTime.slice(0, 10) + ' ~ ' + pkg.cycleEndTime.slice(0, 10)) : '';
                console.log('   - ' + pkg.name + statusTag + ':');
                console.log('     额度: ' + pkg.total.toFixed(2) + ' Credits | 剩余: ' + pkg.remain.toFixed(2) + ' | 已用: ' + pkg.used.toFixed(2) + timeTag);
            }
        }
    }

    if (antigravityQuota && (antigravityQuota.remainingPercent || antigravityQuota.defaultModelKey)) {
        const defName = antigravityQuota.defaultDisplayName || antigravityQuota.defaultModelKey || 'Gemini 3.8 Flash (High)';
        console.log('\n【反重力 (Antigravity) 官方模型配额 - ' + defName + '】');
        console.log('   配额余量水位: ' + (antigravityQuota.remainingPercent || '全额就绪') + ' (重置时间: ' + (antigravityQuota.resetTimeLocal || antigravityQuota.resetTime || '-') + ')');
        console.log('   请求容量限制: 上下文上限 ' + (antigravityQuota.maxTokens >= 1048576 ? '1,048,576 Tokens (1M)' : antigravityQuota.maxTokens.toLocaleString() + ' Tokens') + ' | 输出上限 ' + (antigravityQuota.maxOutputTokens >= 65536 ? '65,536 Tokens (64K)' : antigravityQuota.maxOutputTokens.toLocaleString() + ' Tokens'));
    }

    if (sourceStats) {
        console.log('\n【数据源概况】');
        console.log('   反重力 (Antigravity): ' + sourceStats.antigravity.convCount + ' 个会话 | ' + sourceStats.antigravity.turnsCount.toLocaleString() + ' 轮回答 | ' + sourceStats.antigravity.totalTokens.toLocaleString() + ' Tokens');
        console.log('   CodeBuddy           : ' + sourceStats.codebuddy.convCount + ' 个会话 | ' + sourceStats.codebuddy.turnsCount.toLocaleString() + ' 轮回答 | ' + sourceStats.codebuddy.totalTokens.toLocaleString() + ' Tokens');
    }

    if (conversations.length > 0) {
        const current = conversations[0];
        const lastActiveTime = current.lastMessageAt || (current.turns.length ? current.turns[current.turns.length - 1].time : current.createdAt);
        console.log('\n【当前 / 最近活跃对话】');
        console.log('   数据来源: ' + current.source);
        console.log('   对话名称: ' + current.name);
        console.log('   对话 ID  : ' + current.id);
        console.log('   最后交互: ' + (lastActiveTime ? new Date(lastActiveTime).toLocaleString() : '-'));
        console.log('   总轮次数: ' + current.total.turns + ' 轮回答');
        console.log('   总 Token : ' + current.total.totalTokens.toLocaleString() + ' (输入: ' + current.total.inputTokens.toLocaleString() + ' | 输出: ' + current.total.outputTokens.toLocaleString() + ')');
        console.log('   思考Token: ' + current.total.thinkingTokens.toLocaleString() + ' | 呈递输出: ' + current.total.lastOutputTokens.toLocaleString());
        console.log('   缓存命中: ' + current.total.cachedInputTokens.toLocaleString() + ' (' + (((current.total.cachedInputTokens / Math.max(1, current.total.inputTokens)) * 100).toFixed(1)) + '%) | 冷输入: ' + current.total.cacheMissTokens.toLocaleString());
        if (current.source === 'CodeBuddy') {
            console.log('   算力点数: ' + current.total.credit.toFixed(2) + ' Credits | 累计耗时: ' + Math.round(current.total.elapsedMs / 1000) + ' 秒');
        }
    }

    console.log('\n【全局各模型累计消耗大盘】');
    const tableData = Object.entries(globalModels).map(([model, s]) => ({
        '模型名称': model,
        '累计回答': s.turns + ' 轮',
        '总输入 Token': s.inputTokens.toLocaleString(),
        '总输出 Token': s.outputTokens.toLocaleString(),
        '思考 Token': s.thinkingTokens.toLocaleString(),
        '呈现 Token': s.lastOutputTokens.toLocaleString(),
        '缓存命中': s.cachedInputTokens.toLocaleString(),
        '冷输入(Miss)': s.cacheMissTokens.toLocaleString(),
        '缓存命中率': ((s.cachedInputTokens / Math.max(1, s.inputTokens)) * 100).toFixed(1) + '%',
        '总消耗 Token': s.totalTokens.toLocaleString(),
        'Credit': s.credit.toFixed(2)
    }));
    tableData.push({
        '模型名称': '【合计】',
        '累计回答': globalTotal.turns + ' 轮',
        '总输入 Token': globalTotal.inputTokens.toLocaleString(),
        '总输出 Token': globalTotal.outputTokens.toLocaleString(),
        '思考 Token': globalTotal.thinkingTokens.toLocaleString(),
        '呈现 Token': globalTotal.lastOutputTokens.toLocaleString(),
        '缓存命中': globalTotal.cachedInputTokens.toLocaleString(),
        '冷输入(Miss)': globalTotal.cacheMissTokens.toLocaleString(),
        '缓存命中率': ((globalTotal.cachedInputTokens / Math.max(1, globalTotal.inputTokens)) * 100).toFixed(1) + '%',
        '总消耗 Token': globalTotal.totalTokens.toLocaleString(),
        'Credit': globalTotal.credit.toFixed(2)
    });
    console.table(tableData);

    const reportPath = REPORT_OUTPUT_PATH;
    console.log('\n已生成全维度 Token 深度报表: ' + reportPath);
    console.log('提示:');
    console.log('   - 仅查看 CodeBuddy 积分用量: node token-stats.js --credits');
    console.log('   - 同步最新 CodeBuddy 积分 (优先插件直连): node token-stats.js --sync-credits');
    console.log('   - 一键领取每日签到+成长中心全部奖励: node token-stats.js --signin');
    console.log('   - 启动本地服务并在浏览器打开: node token-stats.js --html');
    console.log('   - 仅查看特定来源: node token-stats.js --source antigravity (或 codebuddy / all)');
    console.log('   - 启动本地后台服务: node token-stats.js --serve (支持页面上一键点击刷新最新数据)\n');
}

module.exports = { main, startServer, openUrl, ensureServerAndOpen };
