'use strict';

// ==========================================
// 统一 API 路由处理器
// 供两处复用，杜绝「双套路由」实现漂移：
//   1) VSCode Webview 消息桥（src/dashboard.js）
//   2) 独立本地 HTTP 报表服务（src/cli.js）
//
// 约定：handleApiRequest(ctx, apiPath) -> Promise<{ status, body }>
//   body 为可 JSON 序列化的对象（由调用方决定序列化方式）。
//
// ctx 需要提供：
//   collectTokenData(source)          -> 聚合数据
//   buildRefreshPayload(opts)         -> 刷新响应体
//   syncCreditsBestEffort(ms)         -> { live, credits, error }
//   runAllPointsTasks()               -> 积分任务结果
//   getDataSource()                   -> 'all' | 'codebuddy' | 'antigravity' | 'dsh'
//   可选：onCredits(credits)、log(msg)、buildId、startedAt、writeReportOnRefresh
// ==========================================

function toConversations(list) {
    return (list || []).map(c => ({
        id: c.id,
        name: c.name,
        source: c.source,
        createdAt: c.createdAt,
        lastMessageAt: c.lastMessageAt,
        turns: c.turns
    }));
}

async function handleApiRequest(ctx, apiPath) {
    switch (apiPath) {
        case '/api/heartbeat':
            return { status: 200, body: { success: true, status: 'ok', buildId: ctx.buildId } };

        case '/api/exit':
            // 仅 Webview 场景的占位成功；CLI 服务端会在调用本处理器前拦截并执行自动退出。
            return { status: 200, body: { success: true } };

        case '/api/version':
            return {
                status: 200,
                body: {
                    success: true,
                    buildId: ctx.buildId,
                    pid: process.pid,
                    startedAt: ctx.startedAt
                }
            };

        case '/api/refresh': {
            const payload = await ctx.buildRefreshPayload({ writeReport: !!ctx.writeReportOnRefresh });
            if (payload.codebuddyCredits && ctx.onCredits) ctx.onCredits(payload.codebuddyCredits);
            if (ctx.log) ctx.log('数据刷新完成：' + payload.fetchedAt);
            return { status: 200, body: payload };
        }

        case '/api/data': {
            const d = ctx.collectTokenData(ctx.getDataSource());
            return {
                status: 200,
                body: {
                    success: true,
                    fetchedAt: d.fetchedAt,
                    antigravityQuota: d.antigravityQuota,
                    codebuddyCredits: d.codebuddyCredits,
                    sourceStats: d.sourceStats,
                    dshPricing: d.dshPricing,
                    conversations: toConversations(d.conversations)
                }
            };
        }

        case '/api/sync-credits': {
            const r = await ctx.syncCreditsBestEffort(15000);
            if (!r.credits) {
                return { status: 200, body: { success: false, live: false, error: r.error || '未获取到任何积分数据' } };
            }
            if (ctx.onCredits) ctx.onCredits(r.credits);
            return {
                status: 200,
                body: {
                    success: true,
                    live: r.live,
                    error: r.error,
                    source: r.credits.source || null,
                    credits: r.credits
                }
            };
        }

        case '/api/points-tasks': {
            const result = await ctx.runAllPointsTasks();
            let credits = null;
            try {
                const cr = await ctx.syncCreditsBestEffort(15000);
                credits = cr.credits;
                if (credits && ctx.onCredits) ctx.onCredits(credits);
            } catch (e) {
                if (ctx.log) ctx.log('积分任务后同步积分失败: ' + ((e && e.message) || e));
            }
            const growth = (result && result.growth) || {};
            return {
                status: 200,
                body: {
                    success: result.success,
                    ranAt: result.ranAt,
                    creditsGained: result.creditsGained,
                    checkin: result.checkin,
                    growth: { result: growth.result, report: growth.report },
                    report: result.report,
                    credits
                }
            };
        }

        default:
            return { status: 404, body: { success: false, error: 'Not Found: ' + apiPath } };
    }
}

module.exports = { handleApiRequest };
