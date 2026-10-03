'use strict';

// ==========================================
// 报表生成器（由 token-stats.js 拆分而来）
// 纯函数：仅依赖入参 data，不涉及任何数据采集/网络/文件写入逻辑，便于独立维护与测试。
// ==========================================
function buildReportHtml(data) {
    const { conversations, fetchedAt = new Date().toISOString(), antigravityQuota, codebuddyCredits, sourceStats, filterSource, pointsTasksLast } = data;

    const clientData = conversations.map(c => ({
        id: c.id,
        name: c.name,
        source: c.source || 'CodeBuddy',
        createdAt: c.createdAt,
        lastMessageAt: c.lastMessageAt,
        turns: c.turns
    }));

    // 安全序列化 JSON
    const jsonString = JSON.stringify(clientData)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e');

    const metaString = JSON.stringify({
        fetchedAt,
        antigravityQuota,
        codebuddyCredits,
        pointsTasksLast,
        sourceStats,
        filterSource
    })
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e');

    const htmlHead = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI 编程全维度 Token 统计与深度审计分析大盘</title>
    <style>
        :root {
            --bg-primary: #0b0d13;
            --bg-secondary: #131720;
            --bg-card: #181d28;
            --bg-card-hover: #1f2533;
            --border-color: #272e3d;
            --border-focus: #3b82f6;
            --text-main: #f1f5f9;
            --text-muted: #94a3b8;
            --text-sub: #64748b;
            --accent-cyan: #38bdf8;
            --accent-blue: #3b82f6;
            --accent-green: #10b981;
            --accent-amber: #f59e0b;
            --accent-red: #ef4444;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background-color: var(--bg-primary);
            color: var(--text-main);
            padding: 32px 24px;
            line-height: 1.5;
            -webkit-font-smoothing: antialiased;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        header {
            margin-bottom: 20px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 16px;
        }
        h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.5px; }
        .sub-header { color: var(--text-muted); font-size: 13px; margin-top: 4px; }
        .header-right {
            display: flex;
            align-items: center;
            gap: 14px;
            flex-wrap: wrap;
        }
        .fetch-time-wrap {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
        }
        .fetch-time-text {
            color: var(--text-main);
            font-weight: 500;
            font-variant-numeric: tabular-nums;
        }
        .btn-refresh {
            background-color: var(--bg-card);
            border: 1px solid var(--border-color);
            color: var(--text-main);
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            user-select: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            line-height: 1;
        }
        .btn-refresh:hover:not(:disabled) {
            background-color: var(--bg-card-hover);
            border-color: var(--border-focus);
            color: var(--accent-cyan);
        }
        .btn-refresh:active:not(:disabled) { transform: scale(0.98); }
        .btn-refresh:disabled { opacity: 0.6; cursor: not-allowed; }

        /* 反重力官方配额水位卡片 */
        .quota-banner {
            background: linear-gradient(180deg, #161c28 0%, #11151f 100%);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px 20px;
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 16px;
        }
        .quota-title {
            font-size: 14px;
            font-weight: 600;
            color: var(--text-main);
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
        }
        .quota-model-select {
            background-color: var(--bg-primary);
            color: var(--text-main);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 3px 8px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            outline: none;
            transition: border-color 0.2s;
        }
        .quota-model-select:hover, .quota-model-select:focus {
            border-color: var(--accent-cyan);
        }
        .quota-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
        .quota-details {
            display: flex;
            align-items: center;
            gap: 24px;
            flex-wrap: wrap;
        }
        .quota-metric {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .quota-metric-label { font-size: 11px; color: var(--text-sub); text-transform: uppercase; font-weight: 600; }
        .quota-metric-value { font-size: 14px; font-weight: 600; color: var(--text-main); }
        .quota-progress-wrap {
            width: 160px;
            height: 8px;
            background-color: #0b0d13;
            border-radius: 4px;
            overflow: hidden;
            border: 1px solid var(--border-color);
            margin-top: 4px;
        }
        .quota-progress-bar {
            height: 100%;
            background-color: var(--accent-cyan);
            border-radius: 3px;
            transition: width 0.3s ease;
        }

        /* CodeBuddy 官方积分卡片专用样式 (遵守极简无彩色图标规范) */
        .btn-sync-credits {
            background-color: var(--bg-primary);
            color: var(--text-main);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            padding: 2px 8px;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            outline: none;
            transition: all 0.2s ease;
            margin-left: 6px;
        }
        .btn-sync-credits:hover {
            border-color: var(--text-main);
            background-color: var(--bg-card);
        }
        .btn-sync-credits:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .credits-packages-toggle {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            margin-top: 8px;
            padding: 2px 8px;
            background: transparent;
            border: 1px dashed var(--border-color);
            border-radius: 4px;
            color: var(--text-muted);
            font-size: 11px;
            cursor: pointer;
            transition: color 0.2s, border-color 0.2s;
            width: 100%;
            justify-content: center;
        }
        .credits-packages-toggle:hover {
            color: var(--accent-cyan);
            border-color: var(--accent-cyan);
        }
        .credits-packages-toggle .toggle-arrow {
            display: inline-block;
            transition: transform 0.2s;
            font-style: normal;
        }
        .credits-packages-toggle.expanded .toggle-arrow {
            transform: rotate(180deg);
        }
        .credits-packages-detail {
            display: none;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px dashed var(--border-color);
            width: 100%;
            overflow-x: auto;
        }
        .credits-packages-detail.expanded {
            display: block;
        }
        .pkg-table {
            border-collapse: collapse;
            font-size: 12px;
            color: var(--text-muted);
            width: max-content;
            max-width: 100%;
        }
        .pkg-table thead tr {
            border-bottom: 1px solid var(--border-color);
        }
        .pkg-table th {
            padding: 6px 14px;
            font-weight: 600;
            font-size: 11px;
            color: var(--text-muted);
            text-align: left;
            white-space: nowrap;
        }
        /* 前两列（套餐名称、周期）居左对齐，紧贴内容，不产生多余留白 */
        .pkg-table th:nth-child(1),
        .pkg-table td:nth-child(1),
        .pkg-table th:nth-child(2),
        .pkg-table td:nth-child(2) {
            text-align: left;
        }
        /* 后四列数值型数据（总额度、已用、剩余、利用率）居右对齐 */
        .pkg-table th:nth-child(n+3),
        .pkg-table td:nth-child(n+3) {
            text-align: right;
        }
        .pkg-table td {
            padding: 6px 14px;
            border-bottom: 1px solid rgba(255,255,255,0.04);
            vertical-align: middle;
            white-space: nowrap;
        }
        .pkg-table tr:hover td {
            background-color: rgba(255,255,255,0.02);
        }
        .pkg-table tr.pkg-row-active td:first-child {
            color: var(--accent-cyan);
        }
        .pkg-table tr.pkg-row-active td:first-child::before {
            content: '';
            display: inline-block;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--accent-cyan);
            margin-right: 6px;
            vertical-align: middle;
        }
        .pkg-table td:first-child {
            color: var(--text-primary);
            font-weight: 500;
        }
        .pkg-bar-wrap {
            width: 70px;
            height: 4px;
            background: var(--border-color);
            border-radius: 2px;
            overflow: hidden;
            display: inline-block;
            vertical-align: middle;
            margin-left: 6px;
        }
        .pkg-bar-fill {
            height: 100%;
            border-radius: 2px;
            background: var(--accent-cyan);
            transition: width 0.3s;
        }
        /* 筛选控制栏 */
        .filter-panel {
            background-color: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px 20px;
            margin-bottom: 24px;
            display: flex;
            flex-direction: column;
            gap: 14px;
        }
        .filter-row {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 12px;
        }
        .filter-label {
            font-size: 13px;
            font-weight: 600;
            color: var(--text-muted);
            min-width: 72px;
        }
        .filter-divider {
            width: 1px;
            height: 20px;
            background-color: var(--border-color);
            margin: 0 4px;
        }
        .source-group, .preset-group {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .btn-filter {
            background-color: var(--bg-card);
            border: 1px solid var(--border-color);
            color: var(--text-muted);
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.15s ease;
        }
        .btn-filter:hover {
            color: var(--text-main);
            background-color: var(--bg-card-hover);
            border-color: #3e485e;
        }
        .btn-filter.active {
            background-color: #1e293b;
            color: var(--accent-cyan);
            border-color: var(--accent-cyan);
            font-weight: 600;
        }
        .custom-time-inputs {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
        }
        .datetime-input {
            background-color: var(--bg-primary);
            border: 1px solid var(--border-color);
            color: var(--text-main);
            color-scheme: dark;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 13px;
            outline: none;
            transition: border-color 0.15s ease;
        }
        .datetime-input:focus { border-color: var(--border-focus); }
        .datetime-input::-webkit-calendar-picker-indicator {
            cursor: pointer;
            filter: invert(0.85);
            opacity: 0.85;
            transition: all 0.2s ease;
            padding: 2px;
            border-radius: 3px;
        }
        .datetime-input::-webkit-calendar-picker-indicator:hover {
            filter: invert(1);
            opacity: 1;
            background-color: rgba(255, 255, 255, 0.1);
        }
        .btn-action {
            background-color: #2563eb;
            color: #ffffff;
            border: 1px solid #3b82f6;
            padding: 6px 16px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            transition: background-color 0.15s;
        }
        .btn-action:hover { background-color: #1d4ed8; }
        .btn-reset {
            background-color: transparent;
            color: var(--text-muted);
            border: 1px solid var(--border-color);
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.15s;
        }
        .btn-reset:hover { color: var(--text-main); border-color: #475569; }
        .filter-status-bar {
            font-size: 12px;
            color: var(--text-muted);
            padding-top: 6px;
            border-top: 1px solid rgba(255, 255, 255, 0.05);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 8px;
        }

        /* 表格合计行样式 */
        .total-row {
            background-color: rgba(56, 189, 248, 0.05);
            font-weight: 600;
        }
        .total-row td {
            border-top: 2px solid #334155;
            border-bottom: none;
            color: var(--text-main);
        }
        .total-row:hover td { background-color: rgba(56, 189, 248, 0.09); }

        /* 区块标题 */
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin: 28px 0 14px 0;
            flex-wrap: wrap;
            gap: 8px;
        }
        .section-title { font-size: 16px; font-weight: 600; letter-spacing: -0.2px; }
        .section-title-wrap {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
        }
        .conv-count-badge {
            display: inline-flex;
            align-items: center;
            font-size: 12px;
            font-weight: 500;
            padding: 2px 10px;
            border-radius: 9999px;
            background-color: rgba(56, 189, 248, 0.1);
            color: var(--accent-cyan);
            border: 1px solid rgba(56, 189, 248, 0.28);
            line-height: 1.4;
            letter-spacing: 0.2px;
            user-select: none;
            transition: all 0.2s ease;
        }
        .search-box {
            background-color: var(--bg-secondary);
            border: 1px solid var(--border-color);
            color: var(--text-main);
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            outline: none;
            width: 240px;
        }
        .search-box:focus { border-color: var(--border-focus); }

        /* 表格样式 */
        .table-wrap {
            background-color: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            overflow-x: auto;
            margin-bottom: 24px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
            font-size: 12px;
        }
        th, td {
            padding: 10px 14px;
            border-bottom: 1px solid var(--border-color);
            white-space: nowrap;
        }
        th {
            background-color: var(--bg-secondary);
            color: var(--text-muted);
            font-weight: 600;
            font-size: 12px;
            vertical-align: bottom;
            line-height: 1.3;
        }
        .th-sub {
            font-size: 10px;
            font-weight: 500;
            color: var(--text-sub);
            letter-spacing: 0.3px;
            margin-top: 3px;
            line-height: 1.1;
            text-transform: uppercase;
        }
        /* ===== 表格列宽自定义调节 ===== */
        th { position: relative; }
        th.col-resizable { padding-right: 18px; }
        .col-resize-handle {
            position: absolute;
            top: 0;
            right: 0;
            width: 10px;
            height: 100%;
            cursor: col-resize;
            z-index: 6;
            user-select: none;
            -webkit-user-select: none;
        }
        .col-resize-handle::after {
            content: '';
            position: absolute;
            top: 20%;
            right: 4px;
            width: 2px;
            height: 60%;
            border-radius: 2px;
            background-color: rgba(148, 163, 184, 0.35);
            transition: background-color 0.15s ease;
        }
        .col-resize-handle:hover::after,
        .col-resize-handle.active::after {
            background-color: var(--accent-cyan);
            box-shadow: 0 0 6px rgba(56, 189, 248, 0.7);
        }
        body.col-resizing { cursor: col-resize; user-select: none; }
        body.col-resizing * { cursor: col-resize !important; }
        table.colresized th, table.colresized td { overflow: hidden; text-overflow: ellipsis; }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background-color: rgba(255, 255, 255, 0.02); }
        .badge {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 11px;
            background: #1e293b;
            color: var(--text-muted);
            border: 1px solid var(--border-color);
            margin-right: 4px;
            font-weight: 500;
        }
        .badge-source {
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 4px;
            border: 1px solid #334155;
            background-color: #0f172a;
            color: var(--text-main);
        }
        .text-right { text-align: right; }
        .empty-state { padding: 32px; text-align: center; color: var(--text-muted); font-size: 13px; }
        .clickable-row { cursor: pointer; }
        .selected-row td { background-color: rgba(56, 189, 248, 0.08) !important; }

        /* 展开详情卡片 */
        .detail-panel {
            background-color: #0f172a;
            border: 1px solid #1e3a8a;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 24px;
            display: none;
        }
        .detail-title {
            font-size: 15px;
            font-weight: 600;
            color: var(--accent-cyan);
            margin-bottom: 4px;
        }
        .detail-meta { font-size: 12px; color: var(--text-muted); margin-bottom: 14px; }
        .turns-timeline {
            max-height: 320px;
            overflow-y: auto;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            background-color: #090d16;
            margin-top: 12px;
        }
        .turns-timeline th {
            position: sticky;
            top: 0;
            z-index: 10;
            background-color: var(--bg-secondary);
            box-shadow: 0 1px 0 var(--border-color);
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div>
                <h1>AI 编程全维度 Token 统计与深度审计分析大盘</h1>
                <div class="sub-header">全面聚合 Antigravity (反重力) & CodeBuddy：输入/输出、缓存命中/冷输入、思考推理、最终正文、步数与官方配额水位</div>
            </div>
            <div class="header-right">
                <div class="fetch-time-wrap">
                    <span class="sub-header">数据获取时间: </span>
                    <span class="fetch-time-text" id="fetchTime">-</span>
                </div>
                <button id="btnRefresh" class="btn-refresh" title="获取最新数据并刷新页面">刷新</button>
            </div>
        </header>

        <!-- 反重力官方模型配额信息展示 -->
        <div id="quotaSection" class="quota-banner" style="display:none;">
            <div>
                <div class="quota-title">
                    <span>反重力模型配额与限制</span>
                    <select id="quotaModelSelect" class="quota-model-select" title="切换模型查看对应配额与上下文上限"></select>
                    <span id="quotaPercentBadge" class="badge" style="color:var(--accent-cyan); border-color:var(--accent-cyan);">0.0%</span>
                </div>
                <div class="quota-sub" id="quotaSubText">官方配额实时水位与自动重置周期（仅适用于反重力官方渠道）</div>
                <div class="quota-progress-wrap">
                    <div id="quotaProgressBar" class="quota-progress-bar" style="width: 0%;"></div>
                </div>
            </div>
            <div class="quota-details">
                <div class="quota-metric">
                    <span class="quota-metric-label">配额余量</span>
                    <span class="quota-metric-value" id="quotaValueRemaining">-</span>
                </div>
                <div class="quota-metric">
                    <span class="quota-metric-label">配额重置时间</span>
                    <span class="quota-metric-value" id="quotaValueReset">-</span>
                </div>
                <div class="quota-metric">
                    <span class="quota-metric-label">单次请求上下文上限</span>
                    <span class="quota-metric-value" id="quotaValueMaxTokens">-</span>
                </div>
                <div class="quota-metric">
                    <span class="quota-metric-label">单次输出上限</span>
                    <span class="quota-metric-value" id="quotaValueMaxOutput">-</span>
                </div>
            </div>
        </div>

        <!-- CodeBuddy 官方积分与套餐用量展示 (逆向接口集成) -->
        <div id="codebuddyCreditsSection" class="quota-banner" style="display:none;">
            <div style="flex: 1 1 320px;">
                <div class="quota-title">
                    <span>CodeBuddy 账号积分与用量</span>
                    <span id="cbCreditsBadge" class="badge" style="color:var(--accent-cyan); border-color:var(--accent-cyan);">-</span>
                    <button id="btnSyncCredits" class="btn-sync-credits" title="优先读取反重力 IDE 插件登录态同步最新积分">刷新积分</button>
                    <button id="btnPointsTasks" class="btn-sync-credits" title="一键领取每日签到 + 成长中心全部奖励 (旅行/任务/补登/连登兑换/盲盒/Buddy)">领取奖励</button>
                </div>
                <div class="quota-sub" id="cbCreditsSubText">腾讯云代码助手官方套餐与加量包实时额度 (https://www.codebuddy.cn/profile/plans-usage)</div>
                <div class="quota-progress-wrap">
                    <div id="cbCreditsProgressBar" class="quota-progress-bar" style="width: 0%;"></div>
                </div>
            </div>
            <div class="quota-details">
                <div class="quota-metric">
                    <span class="quota-metric-label">剩余可用积分</span>
                    <span class="quota-metric-value" id="cbMetricRemain" style="color:var(--accent-cyan);">-</span>
                </div>
                <div class="quota-metric">
                    <span class="quota-metric-label">已消耗积分</span>
                    <span class="quota-metric-value" id="cbMetricUsed">-</span>
                </div>
                <div class="quota-metric">
                    <span class="quota-metric-label">全账户总额度</span>
                    <span class="quota-metric-value" id="cbMetricTotal">-</span>
                </div>
                <div class="quota-metric">
                    <span class="quota-metric-label">数据更新时间</span>
                    <span class="quota-metric-value" id="cbMetricUpdate" style="font-size:12px;">-</span>
                </div>
            </div>
            <button id="cbPackagesToggle" class="credits-packages-toggle" style="display:none;">
                <i class="toggle-arrow">&#x25BE;</i>
                <span id="cbPackagesToggleLabel">展开套餐详情</span>
            </button>
            <div id="cbPackagesDetail" class="credits-packages-detail"></div>
        </div>

        <!-- 综合筛选控制器：数据来源 + 时间范围 -->
        <div class="filter-panel">
            <div class="filter-row">
                <span class="filter-label">数据来源</span>
                <div class="source-group">
                    <button class="btn-filter btn-source active" data-source="all" id="btnSourceAll">全部来源</button>
                    <button class="btn-filter btn-source" data-source="Antigravity" id="btnSourceAg">反重力 (Antigravity)</button>
                    <button class="btn-filter btn-source" data-source="CodeBuddy" id="btnSourceCb">CodeBuddy</button>
                </div>
            </div>

            <div class="filter-row">
                <span class="filter-label">时间范围</span>
                <div class="preset-group">
                    <button class="btn-filter btn-preset active" data-range="all">全部时间</button>
                    <button class="btn-filter btn-preset" data-range="today">今天</button>
                    <button class="btn-filter btn-preset" data-range="yesterday">昨天</button>
                    <button class="btn-filter btn-preset" data-range="24h">近 24 小时</button>
                    <button class="btn-filter btn-preset" data-range="7d">近 7 天</button>
                    <button class="btn-filter btn-preset" data-range="30d">近 30 天</button>
                </div>
                <div class="filter-divider"></div>
                <div class="custom-time-inputs">
                    <input type="datetime-local" id="inputStart" class="datetime-input">
                    <span style="color: var(--text-muted); font-size: 13px;">至</span>
                    <input type="datetime-local" id="inputEnd" class="datetime-input">
                    <button id="btnApplyCustom" class="btn-action">应用筛选</button>
                    <button id="btnReset" class="btn-reset">重置</button>
                </div>
            </div>

            <div class="filter-status-bar">
                <span id="filterSummaryText">当前范围：全部记录</span>
                <span id="filterStatsText">共命中 0 轮回答</span>
            </div>
        </div>

        <!-- 对话展开详情面板（点击对话时展示） -->
        <div id="detailPanel" class="detail-panel">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 8px;">
                <div>
                    <div id="detailConvName" class="detail-title"></div>
                    <div id="detailConvMeta" class="detail-meta"></div>
                </div>
                <button id="btnCloseDetail" class="btn-reset" style="padding: 2px 10px; font-size: 11px;">关闭</button>
            </div>

            <!-- 本对话模型明细表 -->
            <div class="table-wrap" style="margin-bottom:12px; background: transparent; border: 1px solid rgba(255,255,255,0.08);">
                <table>
                    <thead>
                        <tr>
                            <th>模型名称<div class="th-sub">MODEL</div></th>
                            <th class="text-right">轮次<div class="th-sub">TURNS</div></th>
                            <th class="text-right">输入总量<div class="th-sub">INPUT</div></th>
                            <th class="text-right">输出总量<div class="th-sub">OUTPUT</div></th>
                            <th class="text-right">思考 Token<div class="th-sub">THINKING</div></th>
                            <th class="text-right">最终呈现<div class="th-sub">LAST OUT</div></th>
                            <th class="text-right">缓存命中<div class="th-sub">CACHE HIT</div></th>
                            <th class="text-right">冷输入<div class="th-sub">CACHE MISS</div></th>
                            <th class="text-right">写入缓存<div class="th-sub">CACHE WRITE</div></th>
                            <th class="text-right">缓存命中率<div class="th-sub">HIT RATE</div></th>
                            <th class="text-right">总消耗<div class="th-sub">TOTAL</div></th>
                            <th class="text-right">Credit<div class="th-sub">CREDIT</div></th>
                        </tr>
                    </thead>
                    <tbody id="detailTableBody"></tbody>
                </table>
            </div>

            <!-- 本对话逐轮交互流水 -->
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:6px; font-weight:600;">本对话每一轮交互审计流水:</div>
            <div class="turns-timeline">
                <table>
                    <thead>
                        <tr>
                            <th>交互时间<div class="th-sub">TIME</div></th>
                            <th>模型<div class="th-sub">MODEL</div></th>
                            <th class="text-right">内部步数<div class="th-sub">STEPS</div></th>
                            <th class="text-right">输入总量<div class="th-sub">INPUT</div></th>
                            <th class="text-right">输出总量<div class="th-sub">OUTPUT</div></th>
                            <th class="text-right">深度思考<div class="th-sub">THINKING</div></th>
                            <th class="text-right">最终呈现<div class="th-sub">LAST OUT</div></th>
                            <th class="text-right">缓存命中<div class="th-sub">CACHE HIT</div></th>
                            <th class="text-right">冷输入<div class="th-sub">CACHE MISS</div></th>
                            <th class="text-right">末步输入<div class="th-sub">LAST STEP IN</div></th>
                            <th class="text-right">耗时<div class="th-sub">ELAPSED</div></th>
                            <th class="text-right">生成速率<div class="th-sub">SPEED</div></th>
                            <th class="text-right">Credit<div class="th-sub">CREDIT</div></th>
                        </tr>
                    </thead>
                    <tbody id="turnsTimelineBody"></tbody>
                </table>
            </div>
        </div>

        <!-- 模型消耗大盘表 (全维度 14 个字段全覆盖) -->
        <div class="section-header">
            <div class="section-title">各模型全维度消耗大盘</div>
        </div>
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>模型名称<div class="th-sub">MODEL</div></th>
                        <th class="text-right">回答轮次<div class="th-sub">TURNS</div></th>
                        <th class="text-right">输入总量<div class="th-sub">INPUT</div></th>
                        <th class="text-right">输出总量<div class="th-sub">OUTPUT</div></th>
                        <th class="text-right">深度思考<div class="th-sub">THINKING</div></th>
                        <th class="text-right">最终呈现<div class="th-sub">LAST OUT</div></th>
                        <th class="text-right">缓存命中<div class="th-sub">CACHE HIT</div></th>
                        <th class="text-right">冷输入<div class="th-sub">CACHE MISS</div></th>
                        <th class="text-right">写入缓存<div class="th-sub">CACHE WRITE</div></th>
                        <th class="text-right">缓存命中率<div class="th-sub">HIT RATE</div></th>
                        <th class="text-right">总消耗<div class="th-sub">TOTAL</div></th>
                        <th class="text-right">消耗 Credit<div class="th-sub">CREDIT</div></th>
                        <th class="text-right">累计耗时<div class="th-sub">ELAPSED</div></th>
                        <th class="text-right">平均速率<div class="th-sub">AVG SPEED</div></th>
                    </tr>
                </thead>
                <tbody id="modelTableBody"></tbody>
            </table>
        </div>

        <!-- 对话明细列表 -->
        <div class="section-header">
            <div class="section-title-wrap">
                <div class="section-title">对话审计列表 (按最新活跃时间排序)</div>
                <span id="conversationCountBadge" class="conv-count-badge">0 个对话</span>
            </div>
            <input type="text" id="inputSearch" class="search-box" placeholder="搜索对话名称 / 会话ID / 模型...">
        </div>
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>来源<div class="th-sub">SOURCE</div></th>
                        <th>对话名称 / ID<div class="th-sub">NAME & ID</div></th>
                        <th>最后活跃时间<div class="th-sub">LAST ACTIVE</div></th>
                        <th>使用模型<div class="th-sub">MODELS</div></th>
                        <th class="text-right">区间轮次<div class="th-sub">TURNS</div></th>
                        <th class="text-right">输入总量<div class="th-sub">INPUT</div></th>
                        <th class="text-right">输出总量<div class="th-sub">OUTPUT</div></th>
                        <th class="text-right">思考 Token<div class="th-sub">THINKING</div></th>
                        <th class="text-right">缓存命中率<div class="th-sub">HIT RATE</div></th>
                        <th class="text-right">冷输入<div class="th-sub">CACHE MISS</div></th>
                        <th class="text-right">总消耗 Token<div class="th-sub">TOTAL</div></th>
                        <th class="text-right">消耗 Credit<div class="th-sub">CREDIT</div></th>
                    </tr>
                </thead>
                <tbody id="conversationTableBody"></tbody>
            </table>
        </div>
    </div>

    <script type="application/json" id="token-meta">${metaString}</script>
    <script type="application/json" id="token-data">`;

    const htmlTail = `</script>
    <script>
        const META_EL = document.getElementById('token-meta');
        let META_DATA = META_EL ? JSON.parse(META_EL.textContent) : {};
        let DATA_FETCHED_AT = META_DATA.fetchedAt || null;
        let RAW_CONVERSATIONS = JSON.parse(document.getElementById('token-data').textContent);
        let isReloading = false;

        const isHttp = window.location.protocol === 'http:' || window.location.protocol === 'https:';
        const serverBase = isHttp ? '' : 'http://127.0.0.1:3333';

        // 维持与后台的心跳
        function sendHeartbeat() {
            fetch(serverBase + '/api/heartbeat', { method: 'POST', mode: 'cors' }).catch(() => {});
        }
        setInterval(sendHeartbeat, 3000);
        sendHeartbeat();

        // 页面关闭时通知后台服务及时退出
        function notifyExit() {
            if (!isReloading) {
                if (navigator.sendBeacon) {
                    navigator.sendBeacon(serverBase + '/api/exit');
                } else {
                    fetch(serverBase + '/api/exit', { method: 'POST', keepalive: true, mode: 'cors' }).catch(() => {});
                }
            }
        }
        window.addEventListener('beforeunload', notifyExit);

        function escapeHtml(str) {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function formatNumber(num) {
            return (num || 0).toLocaleString();
        }

        function formatDuration(ms) {
            if (!ms || ms <= 0) return '0s';
            const s = Math.round(ms / 1000);
            if (s < 60) return s + 's';
            const m = Math.floor(s / 60);
            const remS = s % 60;
            if (m < 60) return m + 'm ' + remS + 's';
            const h = Math.floor(m / 60);
            const remM = m % 60;
            return h + 'h ' + remM + 'm';
        }

        function formatDateTime(isoStr) {
            if (!isoStr) return '-';
            const d = new Date(isoStr);
            if (isNaN(d.getTime())) return isoStr;
            const pad = n => String(n).padStart(2, '0');
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }

        function toDateTimeLocalString(date) {
            const pad = n => String(n).padStart(2, '0');
            return date.getFullYear() + '-' +
                pad(date.getMonth() + 1) + '-' +
                pad(date.getDate()) + 'T' +
                pad(date.getHours()) + ':' +
                pad(date.getMinutes());
        }

        function updateFetchTimeDisplay(isoStr) {
            const el = document.getElementById('fetchTime');
            if (el && isoStr) {
                el.textContent = formatDateTime(isoStr);
            }
        }

        // 渲染反重力模型配额与限制卡片
        let selectedQuotaModelKey = null;

        function updateQuotaVisibility() {
            const agSec = document.getElementById('quotaSection');
            const cbSec = document.getElementById('codebuddyCreditsSection');
            const quota = META_DATA.antigravityQuota;
            const credits = META_DATA.codebuddyCredits;
            const src = (currentSource || '').toLowerCase();

            if (agSec) {
                const hasAg = quota && (quota.remainingFraction !== null || (quota.models && Object.keys(quota.models).length > 0));
                agSec.style.display = (hasAg && src !== 'codebuddy') ? 'flex' : 'none';
            }

            if (cbSec) {
                const hasCb = credits && typeof credits.totalCredits === 'number';
                cbSec.style.display = (hasCb && src !== 'antigravity') ? 'flex' : 'none';
            }
        }

        function renderModelQuotaDetails(m) {
            if (!m) return;
            const frac = (typeof m.remainingFraction === 'number') ? m.remainingFraction : null;
            const pct = (frac !== null) ? (frac * 100).toFixed(1) + '%' : (m.remainingPercent || '全额就绪');
            
            const badgeEl = document.getElementById('quotaPercentBadge');
            const remEl = document.getElementById('quotaValueRemaining');
            const barEl = document.getElementById('quotaProgressBar');
            if (badgeEl) badgeEl.textContent = pct;
            if (remEl) remEl.textContent = pct;
            if (barEl) barEl.style.width = (frac !== null) ? pct : '100%';

            const resetEl = document.getElementById('quotaValueReset');
            if (resetEl) {
                if (m.resetTimeLocal) {
                    resetEl.textContent = m.resetTimeLocal;
                } else if (m.resetTime) {
                    resetEl.textContent = formatDateTime(m.resetTime);
                } else {
                    resetEl.textContent = (frac !== null && frac < 1) ? '自动重置中' : '全额就绪';
                }
            }

            const maxTokensEl = document.getElementById('quotaValueMaxTokens');
            if (maxTokensEl) {
                if (m.maxTokens) {
                    let maxTokensStr = formatNumber(m.maxTokens) + ' Tokens';
                    if (m.maxTokens >= 1048576) {
                        maxTokensStr = '1,048,576 Tokens (1M)';
                    } else if (m.maxTokens === 250000) {
                        maxTokensStr = '250,000 Tokens (250K)';
                    } else if (m.maxTokens === 131072) {
                        maxTokensStr = '131,072 Tokens (128K)';
                    }
                    maxTokensEl.textContent = maxTokensStr;
                } else {
                    maxTokensEl.textContent = '-';
                }
            }

            const maxOutputEl = document.getElementById('quotaValueMaxOutput');
            if (maxOutputEl) {
                if (m.maxOutputTokens) {
                    let maxOutStr = formatNumber(m.maxOutputTokens) + ' Tokens';
                    if (m.maxOutputTokens >= 65536) {
                        maxOutStr = '65,536 Tokens (64K)';
                    } else if (m.maxOutputTokens === 64000) {
                        maxOutStr = '64,000 Tokens (64K)';
                    } else if (m.maxOutputTokens === 32768) {
                        maxOutStr = '32,768 Tokens (32K)';
                    }
                    maxOutputEl.textContent = maxOutStr;
                } else {
                    maxOutputEl.textContent = '-';
                }
            }
        }

        function renderQuotaBanner(quota) {
            const sec = document.getElementById('quotaSection');
            if (!sec) return;
            if (!quota || (!quota.remainingFraction && (!quota.models || Object.keys(quota.models).length === 0))) {
                sec.style.display = 'none';
                return;
            }

            updateQuotaVisibility();

            const selectEl = document.getElementById('quotaModelSelect');
            const models = quota.models || {};
            const keys = Object.keys(models);

            if (selectEl && keys.length > 0) {
                // 如果选项为空或模型变化，重新填充 options
                if (selectEl.options.length !== keys.length) {
                    selectEl.innerHTML = '';
                    keys.forEach(k => {
                        const m = models[k];
                        const opt = document.createElement('option');
                        opt.value = k;
                        opt.textContent = m.displayName || k;
                        selectEl.appendChild(opt);
                    });
                }

                if (!selectedQuotaModelKey) {
                    selectedQuotaModelKey = quota.defaultModelKey || keys[0];
                }
                selectEl.value = selectedQuotaModelKey;

                selectEl.onchange = function() {
                    selectedQuotaModelKey = this.value;
                    renderModelQuotaDetails(models[this.value]);
                };
            }

            const currentModel = (models && selectedQuotaModelKey && models[selectedQuotaModelKey]) 
                ? models[selectedQuotaModelKey] 
                : {
                    remainingFraction: quota.remainingFraction,
                    remainingPercent: quota.remainingPercent,
                    resetTimeLocal: quota.resetTimeLocal,
                    resetTime: quota.resetTime,
                    maxTokens: quota.maxTokens,
                    maxOutputTokens: quota.maxOutputTokens
                };

            renderModelQuotaDetails(currentModel);
        }

        function renderCodeBuddyCredits(credits) {
            const sec = document.getElementById('codebuddyCreditsSection');
            if (!sec) return;
            if (!credits || typeof credits.totalCredits !== 'number') {
                sec.style.display = 'none';
                return;
            }

            updateQuotaVisibility();

            const badgeEl = document.getElementById('cbCreditsBadge');
            const remainEl = document.getElementById('cbMetricRemain');
            const usedEl = document.getElementById('cbMetricUsed');
            const totalEl = document.getElementById('cbMetricTotal');
            const updateEl = document.getElementById('cbMetricUpdate');
            const barEl = document.getElementById('cbCreditsProgressBar');
            const pkgsEl = document.getElementById('cbPackagesDetail');

            const usedPct = credits.usedPercent || '0.0%';
            const remPct = credits.remainPercent || '100.0%';

            if (badgeEl) badgeEl.textContent = '已用 ' + usedPct + ' (剩余 ' + Number(credits.remainCredits).toFixed(2) + ' 点)';
            if (remainEl) remainEl.textContent = Number(credits.remainCredits).toFixed(2) + ' Credits';
            if (usedEl) usedEl.textContent = Number(credits.usedCredits).toFixed(2) + ' Credits';
            if (totalEl) totalEl.textContent = Number(credits.totalCredits).toFixed(2) + ' Credits';

            if (barEl) {
                const frac = credits.totalCredits > 0 ? (credits.usedCredits / credits.totalCredits) : 0;
                barEl.style.width = (frac * 100).toFixed(1) + '%';
            }

            if (updateEl) {
                const dateStr = credits.updatedAt ? formatDateTime(credits.updatedAt) : '-';
                let tag = '[本地缓存]';
                if (credits.source === 'antigravity-plugin') tag = '[反重力插件实时]';
                else if (credits.source === 'workbuddy-desktop') tag = '[桌面端实时]';
                else if (credits.source === 'live' || credits.source === 'browser') tag = '[浏览器实时]';
                updateEl.textContent = dateStr + ' ' + tag;
            }

            const subTextEl = document.getElementById('cbCreditsSubText');
            if (subTextEl) {
                let subHtml = '腾讯云代码助手官方套餐与加量包实时额度 (https://www.codebuddy.cn/profile/plans-usage)';
                if (credits.checkin) {
                    const checkinTag = credits.checkin.todayCheckedIn ? '今日已签' : '今日未签';
                    subHtml += ' | 每日签到: <span style="color:var(--text-primary); font-weight:600;">' + checkinTag + '</span> (已连签 ' + (credits.checkin.streakDays || 0) + ' 天)';
                }
                const lastTasks = META_DATA.pointsTasksLast;
                if (lastTasks && lastTasks.report) {
                    const ranStr = lastTasks.ranAt ? new Date(lastTasks.ranAt).toLocaleString() : '';
                    const shortReport = lastTasks.report.length > 60 ? lastTasks.report.slice(0, 60) + '...' : lastTasks.report;
                    subHtml += ' | 上次领取(' + ranStr + '): <span style="color:var(--text-primary); font-weight:600;" title="' + escapeHtml(lastTasks.report) + '">' + escapeHtml(shortReport) + '</span>';
                }
                subTextEl.innerHTML = subHtml;
            }

            if (pkgsEl && Array.isArray(credits.packages)) {
                // 渲染为表格
                const table = document.createElement('table');
                table.className = 'pkg-table';
                table.innerHTML = '<thead><tr>' +
                    '<th>套餐名称</th>' +
                    '<th>周期</th>' +
                    '<th>总额度</th>' +
                    '<th>已用</th>' +
                    '<th>剩余</th>' +
                    '<th>利用率</th>' +
                    '</tr></thead>';
                const tbody = document.createElement('tbody');
                credits.packages.forEach(p => {
                    const total = Number(p.total) || 0;
                    const used = Number(p.used) || 0;
                    const remain = Number(p.remain) || 0;
                    const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
                    const cycleStr = (p.cycleStartTime && p.cycleEndTime)
                        ? p.cycleStartTime.slice(0, 10) + ' ~ ' + p.cycleEndTime.slice(0, 10)
                        : '-';
                    const barColor = pct >= 90 ? '#f87171' : pct >= 70 ? '#fb923c' : 'var(--accent-cyan)';
                    const tr = document.createElement('tr');
                    if (p.inUsage) tr.className = 'pkg-row-active';
                    tr.innerHTML =
                        '<td>' + escapeHtml(p.name) + (p.inUsage ? ' <span style="font-size:10px;color:var(--accent-cyan);">(生效中)</span>' : '') + '</td>' +
                        '<td>' + escapeHtml(cycleStr) + '</td>' +
                        '<td>' + total.toFixed(0) + '</td>' +
                        '<td>' + used.toFixed(1) + '</td>' +
                        '<td>' + remain.toFixed(1) + '</td>' +
                        '<td><span style="font-size:11px;">' + pct.toFixed(1) + '%</span>' +
                            '<span class="pkg-bar-wrap"><span class="pkg-bar-fill" style="width:' + pct.toFixed(1) + '%;background:' + barColor + ';"></span></span>' +
                        '</td>';
                    tbody.appendChild(tr);
                });
                table.appendChild(tbody);
                pkgsEl.innerHTML = '';
                pkgsEl.appendChild(table);
                // 绑定折叠/展开按钮
                const toggleBtn = document.getElementById('cbPackagesToggle');
                const toggleLabel = document.getElementById('cbPackagesToggleLabel');
                if (toggleBtn && credits.packages.length > 0) {
                    toggleBtn.style.display = '';
                    if (!toggleBtn._pkgBound) {
                        toggleBtn._pkgBound = true;
                        toggleBtn.addEventListener('click', function() {
                            const isExpanded = pkgsEl.classList.toggle('expanded');
                            toggleBtn.classList.toggle('expanded', isExpanded);
                            if (toggleLabel) toggleLabel.textContent = isExpanded ? '收起套餐详情' : '展开套餐详情 (' + credits.packages.length + ' 项)';
                        });
                    }
                    if (toggleLabel && !pkgsEl.classList.contains('expanded')) {
                        toggleLabel.textContent = '展开套餐详情 (' + credits.packages.length + ' 项)';
                    }
                }
            }

            // 绑定一键刷新按钮 (必须拼接 serverBase：直接双击本地 html 打开时相对路径会打到 file:// 上)
            const btnSync = document.getElementById('btnSyncCredits');
            if (btnSync && !btnSync._bound) {
                btnSync._bound = true;
                btnSync.addEventListener('click', async function() {
                    const origText = this.textContent;
                    this.disabled = true;
                    this.textContent = '同步中...';
                    try {
                        const resp = await fetch(serverBase + '/api/sync-credits', {
                            method: 'POST',
                            mode: 'cors',
                            headers: { 'Content-Type': 'application/json' }
                        });
                        const rawText = await resp.text();
                        let res = null;
                        try { res = JSON.parse(rawText); } catch (e) { res = null; }
                        if (!res) {
                            const err = new Error(resp.status === 404 ? '后台服务缺少 /api/sync-credits 接口' : ('HTTP ' + resp.status));
                            err.backendStale = (resp.status === 404);
                            throw err;
                        }
                        if (res.credits) {
                            META_DATA.codebuddyCredits = res.credits;
                            renderCodeBuddyCredits(res.credits);
                        }
                        if (!res.success) {
                            throw new Error(res.error || '同步响应失败');
                        }
                        this.textContent = res.live ? '同步完成(实时)' : '实时同步失败(显示缓存)';
                        setTimeout(() => { this.textContent = origText; this.disabled = false; }, 2500);
                    } catch (e) {
                        if (e && e.backendStale) {
                            this.textContent = '后台服务版本过旧';
                            alert('积分同步失败：本地后台服务缺少 /api/sync-credits 接口，说明该端口上运行的是旧版进程，页面上的刷新类按钮会整体失效。处理方法：结束旧的 token-stats 后台进程，重新执行 node token-stats.js --html (或 --serve)，然后重新加载本页面。');
                        } else {
                            this.textContent = '同步失败';
                            alert('积分同步失败: ' + (e && e.message ? e.message : '未知错误'));
                        }
                        setTimeout(() => { this.textContent = origText; this.disabled = false; }, 3000);
                    }
                });
            }

            // 绑定一键领取积分任务按钮 (每日签到 + 成长中心全部奖励)
            const btnTasks = document.getElementById('btnPointsTasks');
            if (btnTasks && !btnTasks._bound) {
                btnTasks._bound = true;
                btnTasks.addEventListener('click', async function() {
                    const origText = this.textContent;
                    this.disabled = true;
                    this.textContent = '领取中...';
                    try {
                        const resp = await fetch(serverBase + '/api/points-tasks', {
                            method: 'POST',
                            mode: 'cors',
                            headers: { 'Content-Type': 'application/json' }
                        });
                        const rawText = await resp.text();
                        let res = null;
                        try { res = JSON.parse(rawText); } catch (e) { res = null; }
                        if (!res) {
                            const err = new Error(resp.status === 404 ? '后台服务缺少 /api/points-tasks 接口' : ('HTTP ' + resp.status));
                            err.backendStale = (resp.status === 404);
                            throw err;
                        }
                        if (!res.success) {
                            throw new Error(res.error || res.report || '领取失败');
                        }
                        if (res.credits) {
                            META_DATA.codebuddyCredits = res.credits;
                            renderCodeBuddyCredits(res.credits);
                        }
                        if (res.ranAt) {
                            META_DATA.pointsTasksLast = { ranAt: res.ranAt, report: res.report };
                        }
                        const subEl = document.getElementById('cbCreditsSubText');
                        if (subEl && res.report) {
                            const shortReport = res.report.length > 60 ? res.report.slice(0, 60) + '...' : res.report;
                            subEl.innerHTML += ' | <span style="color:var(--text-primary); font-weight:600;" title="' + escapeHtml(res.report) + '">本次领取: ' + escapeHtml(shortReport) + '</span>';
                        }
                        this.textContent = '领取完成 +' + (res.creditsGained || 0);
                        setTimeout(() => { this.textContent = origText; this.disabled = false; }, 3000);
                    } catch (e) {
                        if (e && e.backendStale) {
                            this.textContent = '后台服务版本过旧';
                            alert('领取失败：本地后台服务缺少 /api/points-tasks 接口，说明该端口上运行的是旧版进程。处理方法：结束旧的 token-stats 后台进程，重新执行 node token-stats.js --html (或 --serve)，然后重新加载本页面。');
                        } else {
                            this.textContent = '领取失败';
                            alert('积分任务领取失败: ' + (e && e.message ? e.message : '未知错误'));
                        }
                        setTimeout(() => { this.textContent = origText; this.disabled = false; }, 3000);
                    }
                });
            }
        }

        // 模型名称规范化与别名归一化
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

        // 筛选状态
        let currentSource = 'all';
        let currentRange = 'all';
        let filterStart = null;
        let filterEnd = null;
        let searchQuery = '';
        let selectedConvId = null;

        // 计算当前数据源/会话中的真实起止时间极值
        function getDataTimeExtremes(sourceFilter = currentSource) {
            let minTs = Infinity;
            let maxTs = -Infinity;

            (RAW_CONVERSATIONS || []).forEach(conv => {
                if (sourceFilter !== 'all') {
                    if ((conv.source || '').toLowerCase() !== sourceFilter.toLowerCase()) {
                        return;
                    }
                }

                if (conv.turns && conv.turns.length > 0) {
                    conv.turns.forEach(t => {
                        if (t.time) {
                            const ts = new Date(t.time).getTime();
                            if (!isNaN(ts)) {
                                if (ts < minTs) minTs = ts;
                                if (ts > maxTs) maxTs = ts;
                            }
                        }
                    });
                }
                if (conv.createdAt) {
                    const ts = new Date(conv.createdAt).getTime();
                    if (!isNaN(ts)) {
                        if (ts < minTs) minTs = ts;
                        if (ts > maxTs) maxTs = ts;
                    }
                }
                if (conv.lastMessageAt) {
                    const ts = new Date(conv.lastMessageAt).getTime();
                    if (!isNaN(ts)) {
                        if (ts < minTs) minTs = ts;
                        if (ts > maxTs) maxTs = ts;
                    }
                }
            });

            if (minTs === Infinity || maxTs === -Infinity) {
                return null;
            }
            return { minTs, maxTs };
        }

        function init() {
            updateFetchTimeDisplay(DATA_FETCHED_AT);
            renderQuotaBanner(META_DATA.antigravityQuota);
            renderCodeBuddyCredits(META_DATA.codebuddyCredits);

            // 更新来源切换按钮上的数量统计
            if (META_DATA.sourceStats) {
                const ag = META_DATA.sourceStats.antigravity;
                const cb = META_DATA.sourceStats.codebuddy;
                const btnAll = document.getElementById('btnSourceAll');
                const btnAg = document.getElementById('btnSourceAg');
                const btnCb = document.getElementById('btnSourceCb');
                if (btnAll) btnAll.textContent = '全部来源 (' + (ag.convCount + cb.convCount) + ')';
                if (btnAg) btnAg.textContent = '反重力 (' + ag.convCount + ')';
                if (btnCb) btnCb.textContent = 'CodeBuddy (' + cb.convCount + ')';
            }

            // 来源切换按钮绑定
            document.querySelectorAll('.btn-source').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.btn-source').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    currentSource = btn.dataset.source;
                    updateQuotaVisibility();
                    // 在“全部时间”模式下，联动更新极值时间输入框
                    if (currentRange === 'all') {
                        const extremes = getDataTimeExtremes();
                        if (extremes) {
                            document.getElementById('inputStart').value = toDateTimeLocalString(new Date(extremes.minTs));
                            document.getElementById('inputEnd').value = toDateTimeLocalString(new Date(extremes.maxTs));
                        }
                    }
                    render();
                });
            });

            // 快捷时间范围按钮绑定
            document.querySelectorAll('.btn-preset').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    applyPreset(btn.dataset.range);
                });
            });

            // 自定义时间筛选
            document.getElementById('btnApplyCustom').addEventListener('click', () => {
                const sVal = document.getElementById('inputStart').value;
                const eVal = document.getElementById('inputEnd').value;
                if (!sVal && !eVal) {
                    applyPreset('all');
                    return;
                }
                filterStart = sVal ? new Date(sVal).getTime() : null;
                if (eVal) {
                    const eDate = new Date(eVal);
                    // 补充当分钟剩余毫秒，避免漏掉同一分钟内的调用
                    filterEnd = eDate.getTime() + (eVal.length <= 16 ? 59999 : 0);
                } else {
                    filterEnd = null;
                }
                currentRange = 'custom';
                document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
                render();
            });

            // 重置筛选
            document.getElementById('btnReset').addEventListener('click', () => {
                document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
                const allBtn = document.querySelector('.btn-preset[data-range="all"]');
                if (allBtn) allBtn.classList.add('active');
                applyPreset('all');
            });

            // 搜索输入
            document.getElementById('inputSearch').addEventListener('input', (e) => {
                searchQuery = (e.target.value || '').trim().toLowerCase();
                renderConversations();
            });

            // 刷新按钮 (向本地后台请求最新聚合数据)
            const refreshBtn = document.getElementById('btnRefresh');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', async () => {
                    refreshBtn.disabled = true;
                    refreshBtn.textContent = '刷新中...';
                    try {
                        const res = await fetch(serverBase + '/api/refresh', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            mode: 'cors'
                        });
                        const rawText = await res.text();
                        let resData = null;
                        try { resData = JSON.parse(rawText); } catch (e) { resData = null; }
                        if (!resData) {
                            const err = new Error(res.status === 404 ? '后台服务缺少 /api/refresh 接口' : ('HTTP ' + res.status));
                            err.backendStale = (res.status === 404);
                            throw err;
                        }
                        if (resData.success) {
                            DATA_FETCHED_AT = resData.fetchedAt;
                            updateFetchTimeDisplay(DATA_FETCHED_AT);
                            if (resData.antigravityQuota) {
                                META_DATA.antigravityQuota = resData.antigravityQuota;
                                renderQuotaBanner(resData.antigravityQuota);
                            }
                            if (resData.codebuddyCredits) {
                                META_DATA.codebuddyCredits = resData.codebuddyCredits;
                                renderCodeBuddyCredits(resData.codebuddyCredits);
                                if (resData.creditsLive === false) {
                                    console.warn('[积分] 实时同步未就绪，本次显示的是本地缓存: ' + (resData.creditsError || '未知原因'));
                                }
                            }
                            if (resData.sourceStats) {
                                META_DATA.sourceStats = resData.sourceStats;
                                const ag = resData.sourceStats.antigravity;
                                const cb = resData.sourceStats.codebuddy;
                                const bAll = document.getElementById('btnSourceAll');
                                const bAg = document.getElementById('btnSourceAg');
                                const bCb = document.getElementById('btnSourceCb');
                                if (bAll) bAll.textContent = '全部来源 (' + (ag.convCount + cb.convCount) + ')';
                                if (bAg) bAg.textContent = '反重力 (' + ag.convCount + ')';
                                if (bCb) bCb.textContent = 'CodeBuddy (' + cb.convCount + ')';
                            }
                            RAW_CONVERSATIONS = resData.conversations;
                            if (currentRange === 'all') {
                                const extremes = getDataTimeExtremes();
                                if (extremes) {
                                    document.getElementById('inputStart').value = toDateTimeLocalString(new Date(extremes.minTs));
                                    document.getElementById('inputEnd').value = toDateTimeLocalString(new Date(extremes.maxTs));
                                }
                            }
                            render();
                        } else {
                            alert('刷新失败: ' + (resData.error || '未知错误'));
                        }
                    } catch (err) {
                        // 不再静默 reload：静默刷新会让「数据没变」变得无法排查，这里明确提示失败原因
                        if (err && err.backendStale) {
                            alert('刷新失败：本地后台服务接口异常(HTTP 404)，该端口上很可能运行着旧版进程或服务已退出。请结束后台进程后重新执行 node token-stats.js --html (或 --serve)，再重新加载本页面。');
                        } else {
                            alert('刷新失败: ' + (err && err.message ? err.message : '未知错误') + ' (可尝试重新执行 node token-stats.js --html 启动后台服务)');
                        }
                    } finally {
                        refreshBtn.disabled = false;
                        refreshBtn.textContent = '刷新';
                    }
                });
            }

            // 关闭详情面板
            document.getElementById('btnCloseDetail').addEventListener('click', () => {
                selectedConvId = null;
                document.getElementById('detailPanel').style.display = 'none';
                document.querySelectorAll('.clickable-row').forEach(r => r.classList.remove('selected-row'));
            });

            // 初始激活“全部时间”并自动填入真实极值时间
            applyPreset('all');

            // 为所有表格装上列宽调节手柄（拖拽 / 双击自适应 / Shift+双击重置）
            initColumnResize();
        }

        function applyPreset(range) {
            currentRange = range;
            const now = new Date();
            if (range === 'all') {
                filterStart = null;
                filterEnd = null;
                const extremes = getDataTimeExtremes();
                if (extremes) {
                    document.getElementById('inputStart').value = toDateTimeLocalString(new Date(extremes.minTs));
                    document.getElementById('inputEnd').value = toDateTimeLocalString(new Date(extremes.maxTs));
                } else {
                    document.getElementById('inputStart').value = '';
                    document.getElementById('inputEnd').value = '';
                }
            } else if (range === 'today') {
                const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
                filterStart = todayStart.getTime();
                filterEnd = null;
                document.getElementById('inputStart').value = toDateTimeLocalString(todayStart);
                document.getElementById('inputEnd').value = toDateTimeLocalString(now);
            } else if (range === 'yesterday') {
                const yestStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
                const yestEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
                filterStart = yestStart.getTime();
                filterEnd = yestEnd.getTime();
                document.getElementById('inputStart').value = toDateTimeLocalString(yestStart);
                document.getElementById('inputEnd').value = toDateTimeLocalString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59));
            } else if (range === '24h') {
                filterStart = now.getTime() - 24 * 60 * 60 * 1000;
                filterEnd = null;
                document.getElementById('inputStart').value = toDateTimeLocalString(new Date(filterStart));
                document.getElementById('inputEnd').value = toDateTimeLocalString(now);
            } else if (range === '7d') {
                filterStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;
                filterEnd = null;
                document.getElementById('inputStart').value = toDateTimeLocalString(new Date(filterStart));
                document.getElementById('inputEnd').value = toDateTimeLocalString(now);
            } else if (range === '30d') {
                filterStart = now.getTime() - 30 * 24 * 60 * 60 * 1000;
                filterEnd = null;
                document.getElementById('inputStart').value = toDateTimeLocalString(new Date(filterStart));
                document.getElementById('inputEnd').value = toDateTimeLocalString(now);
            }
            render();
        }

        function render() {
            updateQuotaVisibility();
            let totalTurns = 0;
            let totalInput = 0;
            let totalOutput = 0;
            let totalCached = 0;
            let totalMiss = 0;
            let totalWrite = 0;
            let totalThinking = 0;
            let totalLastOut = 0;
            let totalCredit = 0;
            let totalElapsed = 0;

            let modelMap = {};
            let convAggregates = [];

            RAW_CONVERSATIONS.forEach(conv => {
                // 来源过滤
                if (currentSource !== 'all') {
                    if ((conv.source || '').toLowerCase() !== currentSource.toLowerCase()) {
                        return;
                    }
                }

                const matchedTurns = (conv.turns || []).filter(t => {
                    const ts = new Date(t.time).getTime();
                    if (isNaN(ts)) return false;
                    if (filterStart !== null && ts < filterStart) return false;
                    if (filterEnd !== null && ts > filterEnd) return false;
                    return true;
                });

                if (matchedTurns.length > 0) {
                    let cInput = 0;
                    let cOutput = 0;
                    let cCached = 0;
                    let cMiss = 0;
                    let cWrite = 0;
                    let cThinking = 0;
                    let cLastOut = 0;
                    let cCredit = 0;
                    let cElapsed = 0;
                    let cModels = {};
                    let lastTime = '';

                    matchedTurns.forEach(t => {
                        totalTurns++;
                        totalInput += (t.inputTokens || 0);
                        totalOutput += (t.outputTokens || 0);
                        totalCached += (t.cachedInputTokens || 0);
                        totalMiss += (t.cacheMissTokens || 0);
                        totalWrite += (t.cacheWriteTokens || 0);
                        totalThinking += (t.thinkingTokens || 0);
                        totalLastOut += (t.lastOutputTokens || 0);
                        totalCredit += (t.credit || 0);
                        totalElapsed += (t.elapsedMs || 0);

                        cInput += (t.inputTokens || 0);
                        cOutput += (t.outputTokens || 0);
                        cCached += (t.cachedInputTokens || 0);
                        cMiss += (t.cacheMissTokens || 0);
                        cWrite += (t.cacheWriteTokens || 0);
                        cThinking += (t.thinkingTokens || 0);
                        cLastOut += (t.lastOutputTokens || 0);
                        cCredit += (t.credit || 0);
                        cElapsed += (t.elapsedMs || 0);
                        lastTime = t.time;

                        const normModel = normalizeModelName(t.model);

                        // 全局模型聚合
                        if (!modelMap[normModel]) {
                            modelMap[normModel] = {
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
                        const gm = modelMap[normModel];
                        gm.turns += 1;
                        gm.inputTokens += (t.inputTokens || 0);
                        gm.outputTokens += (t.outputTokens || 0);
                        gm.cachedInputTokens += (t.cachedInputTokens || 0);
                        gm.cacheMissTokens += (t.cacheMissTokens || 0);
                        gm.cacheWriteTokens += (t.cacheWriteTokens || 0);
                        gm.thinkingTokens += (t.thinkingTokens || 0);
                        gm.lastOutputTokens += (t.lastOutputTokens || 0);
                        gm.totalTokens += (t.totalTokens || ((t.inputTokens || 0) + (t.outputTokens || 0)));
                        gm.credit += (t.credit || 0);
                        gm.elapsedMs += (t.elapsedMs || 0);

                        // 对话内模型聚合
                        if (!cModels[normModel]) {
                            cModels[normModel] = {
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
                        const cm = cModels[normModel];
                        cm.turns += 1;
                        cm.inputTokens += (t.inputTokens || 0);
                        cm.outputTokens += (t.outputTokens || 0);
                        cm.cachedInputTokens += (t.cachedInputTokens || 0);
                        cm.cacheMissTokens += (t.cacheMissTokens || 0);
                        cm.cacheWriteTokens += (t.cacheWriteTokens || 0);
                        cm.thinkingTokens += (t.thinkingTokens || 0);
                        cm.lastOutputTokens += (t.lastOutputTokens || 0);
                        cm.totalTokens += (t.totalTokens || ((t.inputTokens || 0) + (t.outputTokens || 0)));
                        cm.credit += (t.credit || 0);
                        cm.elapsedMs += (t.elapsedMs || 0);
                    });

                    convAggregates.push({
                        id: conv.id,
                        name: conv.name,
                        source: conv.source || 'CodeBuddy',
                        lastTime: lastTime || conv.lastMessageAt || conv.createdAt,
                        turnsCount: matchedTurns.length,
                        inputTokens: cInput,
                        outputTokens: cOutput,
                        totalTokens: cInput + cOutput,
                        cachedTokens: cCached,
                        cacheMissTokens: cMiss,
                        cacheWriteTokens: cWrite,
                        thinkingTokens: cThinking,
                        lastOutputTokens: cLastOut,
                        credit: cCredit,
                        elapsedMs: cElapsed,
                        models: cModels,
                        turns: matchedTurns
                    });
                }
            });

            // 筛选状态文字
            let rangeDesc = '全部时间';
            if (currentRange === 'all') {
                const extremes = getDataTimeExtremes();
                if (extremes) {
                    rangeDesc = '全部时间 (' + formatDateTime(new Date(extremes.minTs).toISOString()) + ' 至 ' + formatDateTime(new Date(extremes.maxTs).toISOString()) + ')';
                }
            } else if (filterStart !== null && filterEnd !== null) {
                rangeDesc = formatDateTime(new Date(filterStart).toISOString()) + ' 至 ' + formatDateTime(new Date(filterEnd).toISOString());
            } else if (filterStart !== null) {
                rangeDesc = formatDateTime(new Date(filterStart).toISOString()) + ' 至今';
            } else if (filterEnd !== null) {
                rangeDesc = '截止至 ' + formatDateTime(new Date(filterEnd).toISOString());
            }
            
            let srcDesc = currentSource === 'all' ? '全部来源' : (currentSource === 'Antigravity' ? '反重力' : 'CodeBuddy');
            document.getElementById('filterSummaryText').textContent = '来源：' + srcDesc + ' | 时间范围：' + rangeDesc;
            document.getElementById('filterStatsText').textContent = '共命中 ' + totalTurns + ' 轮模型调用，' + convAggregates.length + ' 个活跃会话';

            // 渲染模型表 (带合计行)
            renderModelTable(modelMap, {
                turns: totalTurns,
                inputTokens: totalInput,
                outputTokens: totalOutput,
                cachedInputTokens: totalCached,
                cacheMissTokens: totalMiss,
                cacheWriteTokens: totalWrite,
                thinkingTokens: totalThinking,
                lastOutputTokens: totalLastOut,
                totalTokens: totalInput + totalOutput,
                credit: totalCredit,
                elapsedMs: totalElapsed
            });

            // 渲染对话表
            window._currentFilteredConversations = convAggregates;
            renderConversations();

            // 若有选中对话，保持选中
            if (selectedConvId) {
                const found = convAggregates.find(c => c.id === selectedConvId);
                if (found) {
                    showConversationDetail(found, false);
                } else {
                    document.getElementById('detailPanel').style.display = 'none';
                }
            }
        }

        // 渲染模型大盘表 (全覆盖 14 项字段，并在末尾添加一行合计)
        function renderModelTable(modelMap, totals) {
            const tbody = document.getElementById('modelTableBody');
            const entries = Object.entries(modelMap);
            if (entries.length === 0) {
                tbody.innerHTML = '<tr><td colspan="14" class="empty-state">所选条件内无模型调用记录</td></tr>';
                return;
            }

            const rowsHtml = entries.map(([model, s]) => {
                const cacheRate = s.inputTokens > 0 ? ((s.cachedInputTokens / s.inputTokens) * 100).toFixed(1) + '%' : '0.0%';
                const speed = s.elapsedMs > 0 ? (s.outputTokens / (s.elapsedMs / 1000)).toFixed(1) + ' tok/s' : '-';
                return '<tr>' +
                    '<td><b>' + escapeHtml(model) + '</b></td>' +
                    '<td class="text-right">' + s.turns + ' 轮</td>' +
                    '<td class="text-right">' + formatNumber(s.inputTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(s.outputTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(s.thinkingTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(s.lastOutputTokens) + '</td>' +
                    '<td class="text-right" style="color: var(--accent-green);">' + formatNumber(s.cachedInputTokens) + '</td>' +
                    '<td class="text-right" style="color: var(--accent-amber);">' + formatNumber(s.cacheMissTokens) + '</td>' +
                    '<td class="text-right" style="color: var(--accent-cyan);">' + formatNumber(s.cacheWriteTokens || 0) + '</td>' +
                    '<td class="text-right">' + cacheRate + '</td>' +
                    '<td class="text-right"><b>' + formatNumber(s.totalTokens) + '</b></td>' +
                    '<td class="text-right">' + s.credit.toFixed(2) + '</td>' +
                    '<td class="text-right">' + formatDuration(s.elapsedMs) + '</td>' +
                    '<td class="text-right">' + speed + '</td>' +
                '</tr>';
            }).join('');

            // 末尾合计行
            const t = totals || {
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
            const totalCacheRate = t.inputTokens > 0 ? ((t.cachedInputTokens / t.inputTokens) * 100).toFixed(1) + '%' : '0.0%';
            const totalSpeed = t.elapsedMs > 0 ? (t.outputTokens / (t.elapsedMs / 1000)).toFixed(1) + ' tok/s' : '-';

            const totalRowHtml = '<tr class="total-row">' +
                '<td><b>合计</b></td>' +
                '<td class="text-right"><b>' + t.turns + ' 轮</b></td>' +
                '<td class="text-right"><b>' + formatNumber(t.inputTokens) + '</b></td>' +
                '<td class="text-right"><b>' + formatNumber(t.outputTokens) + '</b></td>' +
                '<td class="text-right"><b>' + formatNumber(t.thinkingTokens) + '</b></td>' +
                '<td class="text-right"><b>' + formatNumber(t.lastOutputTokens) + '</b></td>' +
                '<td class="text-right" style="color: var(--accent-green);"><b>' + formatNumber(t.cachedInputTokens) + '</b></td>' +
                '<td class="text-right" style="color: var(--accent-amber);"><b>' + formatNumber(t.cacheMissTokens) + '</b></td>' +
                '<td class="text-right" style="color: var(--accent-cyan);"><b>' + formatNumber(t.cacheWriteTokens || 0) + '</b></td>' +
                '<td class="text-right"><b>' + totalCacheRate + '</b></td>' +
                '<td class="text-right"><b style="color: var(--accent-cyan);">' + formatNumber(t.totalTokens) + '</b></td>' +
                '<td class="text-right"><b>' + t.credit.toFixed(2) + '</b></td>' +
                '<td class="text-right"><b>' + formatDuration(t.elapsedMs) + '</b></td>' +
                '<td class="text-right"><b>' + totalSpeed + '</b></td>' +
            '</tr>';

            tbody.innerHTML = rowsHtml + totalRowHtml;
        }

        // 渲染对话列表表
        function renderConversations() {
            const tbody = document.getElementById('conversationTableBody');
            const convs = window._currentFilteredConversations || [];

            let filtered = convs;
            if (searchQuery) {
                filtered = convs.filter(c => {
                    const nameMatch = (c.name || '').toLowerCase().includes(searchQuery);
                    const idMatch = (c.id || '').toLowerCase().includes(searchQuery);
                    const modelMatch = Object.keys(c.models || {}).some(m => m.toLowerCase().includes(searchQuery));
                    const sourceMatch = (c.source || '').toLowerCase().includes(searchQuery);
                    return nameMatch || idMatch || modelMatch || sourceMatch;
                });
            }

            const badgeEl = document.getElementById('conversationCountBadge');
            if (badgeEl) {
                if (searchQuery && filtered.length !== convs.length) {
                    badgeEl.textContent = filtered.length + ' / ' + convs.length + ' 个对话';
                    badgeEl.title = '搜索匹配 ' + filtered.length + ' 个，共 ' + convs.length + ' 个对话';
                } else {
                    badgeEl.textContent = convs.length + ' 个对话';
                    badgeEl.title = '当前筛选条件下共 ' + convs.length + ' 个对话';
                }
            }

            if (selectedConvId) {
                const isSelectedInFiltered = filtered.some(c => c.id === selectedConvId);
                const detailPanel = document.getElementById('detailPanel');
                if (!isSelectedInFiltered) {
                    detailPanel.style.display = 'none';
                } else {
                    detailPanel.style.display = 'block';
                }
            }

            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="12" class="empty-state">未找到匹配的对话记录</td></tr>';
                return;
            }

            tbody.innerHTML = filtered.map(c => {
                const isSelected = selectedConvId === c.id ? 'selected-row' : '';
                const modelBadges = Object.keys(c.models).map(m => '<span class="badge">' + escapeHtml(m) + '</span>').join('');
                const cacheRate = c.inputTokens > 0 ? ((c.cachedTokens / c.inputTokens) * 100).toFixed(1) + '%' : '0.0%';
                const sourceBadge = '<span class="badge-source">' + (c.source === 'Antigravity' ? '反重力' : 'CodeBuddy') + '</span>';

                return '<tr class="clickable-row ' + isSelected + '" data-id="' + escapeHtml(c.id) + '">' +
                    '<td>' + sourceBadge + '</td>' +
                    '<td><div style="font-weight: 500;">' + escapeHtml(c.name) + '</div><div style="font-size:11px; color:var(--text-sub);">' + escapeHtml(c.id) + '</div></td>' +
                    '<td style="white-space:nowrap; font-size:12px; color:var(--text-muted);">' + formatDateTime(c.lastTime) + '</td>' +
                    '<td>' + modelBadges + '</td>' +
                    '<td class="text-right">' + c.turnsCount + '</td>' +
                    '<td class="text-right">' + formatNumber(c.inputTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(c.outputTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(c.thinkingTokens) + '</td>' +
                    '<td class="text-right">' + cacheRate + '</td>' +
                    '<td class="text-right" style="color: var(--accent-amber);">' + formatNumber(c.cacheMissTokens) + '</td>' +
                    '<td class="text-right"><b>' + formatNumber(c.totalTokens) + '</b></td>' +
                    '<td class="text-right">' + c.credit.toFixed(2) + '</td>' +
                '</tr>';
            }).join('');

            document.querySelectorAll('.clickable-row').forEach(row => {
                row.addEventListener('click', () => {
                    const id = row.dataset.id;
                    if (selectedConvId === id) {
                        selectedConvId = null;
                        row.classList.remove('selected-row');
                        document.getElementById('detailPanel').style.display = 'none';
                        return;
                    }

                    selectedConvId = id;
                    document.querySelectorAll('.clickable-row').forEach(r => r.classList.remove('selected-row'));
                    row.classList.add('selected-row');

                    const target = convs.find(c => c.id === id);
                    if (target) showConversationDetail(target, true);
                });
            });
        }

        // 显示对话详情与逐轮流水
        function showConversationDetail(conv, shouldScroll = false) {
            const panel = document.getElementById('detailPanel');
            document.getElementById('detailConvName').textContent = '【' + (conv.source === 'Antigravity' ? '反重力' : 'CodeBuddy') + ' 对话审计明细】' + conv.name;
            document.getElementById('detailConvMeta').textContent = 'ID: ' + conv.id + ' | 区间轮次: ' + conv.turnsCount + ' 轮 | 总Token: ' + formatNumber(conv.totalTokens) + ' | 思考: ' + formatNumber(conv.thinkingTokens) + ' | Credit: ' + conv.credit.toFixed(2);

            // 模型汇总
            const tbody = document.getElementById('detailTableBody');
            const modelEntries = Object.entries(conv.models);
            let detailRowsHtml = modelEntries.map(([model, s]) => {
                const cacheRate = s.inputTokens > 0 ? ((s.cachedInputTokens / s.inputTokens) * 100).toFixed(1) + '%' : '0.0%';
                return '<tr>' +
                    '<td><b>' + escapeHtml(model) + '</b></td>' +
                    '<td class="text-right">' + s.turns + '</td>' +
                    '<td class="text-right">' + formatNumber(s.inputTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(s.outputTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(s.thinkingTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(s.lastOutputTokens) + '</td>' +
                    '<td class="text-right" style="color: var(--accent-green);">' + formatNumber(s.cachedInputTokens) + '</td>' +
                    '<td class="text-right" style="color: var(--accent-amber);">' + formatNumber(s.cacheMissTokens) + '</td>' +
                    '<td class="text-right" style="color: var(--accent-cyan);">' + formatNumber(s.cacheWriteTokens || 0) + '</td>' +
                    '<td class="text-right">' + cacheRate + '</td>' +
                    '<td class="text-right"><b>' + formatNumber(s.totalTokens) + '</b></td>' +
                    '<td class="text-right">' + s.credit.toFixed(2) + '</td>' +
                '</tr>';
            }).join('');

            if (modelEntries.length > 1) {
                const cCacheRate = conv.inputTokens > 0 ? ((conv.cachedTokens / conv.inputTokens) * 100).toFixed(1) + '%' : '0.0%';
                detailRowsHtml += '<tr class="total-row">' +
                    '<td><b>合计</b></td>' +
                    '<td class="text-right"><b>' + conv.turnsCount + '</b></td>' +
                    '<td class="text-right"><b>' + formatNumber(conv.inputTokens) + '</b></td>' +
                    '<td class="text-right"><b>' + formatNumber(conv.outputTokens) + '</b></td>' +
                    '<td class="text-right"><b>' + formatNumber(conv.thinkingTokens) + '</b></td>' +
                    '<td class="text-right"><b>' + formatNumber(conv.lastOutputTokens) + '</b></td>' +
                    '<td class="text-right" style="color: var(--accent-green);"><b>' + formatNumber(conv.cachedTokens) + '</b></td>' +
                    '<td class="text-right" style="color: var(--accent-amber);"><b>' + formatNumber(conv.cacheMissTokens) + '</b></td>' +
                    '<td class="text-right" style="color: var(--accent-cyan);"><b>' + formatNumber(conv.cacheWriteTokens || 0) + '</b></td>' +
                    '<td class="text-right"><b>' + cCacheRate + '</b></td>' +
                    '<td class="text-right"><b style="color: var(--accent-cyan);">' + formatNumber(conv.totalTokens) + '</b></td>' +
                    '<td class="text-right"><b>' + conv.credit.toFixed(2) + '</b></td>' +
                '</tr>';
            }
            tbody.innerHTML = detailRowsHtml;

            // 逐轮流水
            const tBodyTurns = document.getElementById('turnsTimelineBody');
            tBodyTurns.innerHTML = conv.turns.map((t, idx) => {
                const speed = t.elapsedMs > 0 ? (t.outputTokens / (t.elapsedMs / 1000)).toFixed(1) + ' tok/s' : '-';
                return '<tr>' +
                    '<td style="color:var(--text-muted);">' + formatDateTime(t.time) + ' (#' + (idx+1) + ')</td>' +
                    '<td>' + escapeHtml(normalizeModelName(t.model)) + '</td>' +
                    '<td class="text-right">' + (t.agentMessageCount || 1) + ' 步</td>' +
                    '<td class="text-right">' + formatNumber(t.inputTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(t.outputTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(t.thinkingTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(t.lastOutputTokens) + '</td>' +
                    '<td class="text-right" style="color: var(--accent-green);">' + formatNumber(t.cachedInputTokens) + '</td>' +
                    '<td class="text-right" style="color: var(--accent-amber);">' + formatNumber(t.cacheMissTokens) + '</td>' +
                    '<td class="text-right">' + formatNumber(t.lastStepInputTokens) + '</td>' +
                    '<td class="text-right">' + (t.elapsedMs > 0 ? (t.elapsedMs / 1000).toFixed(1) + 's' : '-') + '</td>' +
                    '<td class="text-right">' + speed + '</td>' +
                    '<td class="text-right">' + (t.credit ? t.credit.toFixed(2) : '0.00') + '</td>' +
                '</tr>';
            }).join('');

            panel.style.display = 'block';
            if (shouldScroll) {
                panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        // ==========================================
        // 表格列宽自定义调节
        // 拖拽表头右侧手柄调整列宽；双击手柄自适应内容；Shift+双击恢复默认列宽
        // 列宽会按表头签名记忆在 localStorage，下次打开自动还原
        // ==========================================
        var COL_W_STORE_KEY = 'tokenReportColWidths:v1';
        var COL_MIN_WIDTH = 48;
        var COL_MAX_WIDTH = 900;

        function loadColWidthStore() {
            try {
                return JSON.parse(window.localStorage.getItem(COL_W_STORE_KEY) || '{}') || {};
            } catch (e) {
                return {};
            }
        }

        function saveColWidthStore(store) {
            try {
                window.localStorage.setItem(COL_W_STORE_KEY, JSON.stringify(store));
            } catch (e) {}
        }

        function getTableKey(table, index) {
            var heads = table.querySelectorAll('thead th');
            var sig = [];
            for (var i = 0; i < heads.length; i++) {
                sig.push((heads[i].textContent || '').replace(/\s+/g, ''));
            }
            return 'tbl' + index + '::' + sig.join('|');
        }

        function ensureColgroup(table, count) {
            var cg = table.querySelector('colgroup');
            if (cg && cg.children.length === count) return cg;
            if (cg && cg.parentNode) cg.parentNode.removeChild(cg);
            cg = document.createElement('colgroup');
            for (var i = 0; i < count; i++) {
                cg.appendChild(document.createElement('col'));
            }
            table.insertBefore(cg, table.firstChild);
            return cg;
        }

        function currentColWidths(table) {
            var cg = table.querySelector('colgroup');
            var heads = table.querySelectorAll('thead th');
            var out = [];
            for (var i = 0; i < heads.length; i++) {
                var w = 0;
                if (cg && cg.children[i] && cg.children[i].style.width) {
                    w = parseFloat(cg.children[i].style.width) || 0;
                }
                if (!w) w = heads[i].getBoundingClientRect().width;
                out.push(Math.round(w));
            }
            return out;
        }

        function applyColWidths(table, widths) {
            var cg = table.querySelector('colgroup');
            if (!cg) return;
            var total = 0;
            for (var i = 0; i < cg.children.length; i++) {
                var w = Math.round(widths[i] || 0);
                if (w > 0) {
                    cg.children[i].style.width = w + 'px';
                    total += w;
                }
            }
            table.classList.add('colresized');
            table.style.tableLayout = 'fixed';
            table.style.minWidth = '0';
            table.style.width = total > 0 ? (total + 'px') : '';
        }

        function measureNaturalWidths(table) {
            var heads = table.querySelectorAll('thead th');
            var out = [];
            for (var i = 0; i < heads.length; i++) {
                var w = heads[i].getBoundingClientRect().width;
                out.push(Math.max(COL_MIN_WIDTH, Math.round(w)));
            }
            return out;
        }

        function measureContentWidth(cell) {
            var cs = window.getComputedStyle(cell);
            var probe = document.createElement('div');
            probe.style.position = 'absolute';
            probe.style.left = '-9999px';
            probe.style.top = '0';
            probe.style.visibility = 'hidden';
            probe.style.display = 'inline-block';
            probe.style.whiteSpace = 'nowrap';
            probe.style.boxSizing = 'border-box';
            probe.style.padding = cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft;
            probe.style.fontSize = cs.fontSize;
            probe.style.fontFamily = cs.fontFamily;
            probe.style.fontWeight = cs.fontWeight;
            probe.style.letterSpacing = cs.letterSpacing;
            probe.innerHTML = cell.innerHTML;
            document.body.appendChild(probe);
            var w = probe.getBoundingClientRect().width;
            document.body.removeChild(probe);
            return w;
        }

        function resetTableWidths(table, key, store) {
            var cg = table.querySelector('colgroup');
            if (cg) {
                for (var i = 0; i < cg.children.length; i++) {
                    cg.children[i].style.width = '';
                }
            }
            table.classList.remove('colresized');
            table.style.tableLayout = '';
            table.style.width = '';
            table.style.minWidth = '';
            delete store[key];
            saveColWidthStore(store);
        }

        function autoFitColumn(table, colIndex, key, store) {
            var heads = table.querySelectorAll('thead th');
            ensureColgroup(table, heads.length);
            if (!table.classList.contains('colresized')) {
                applyColWidths(table, measureNaturalWidths(table));
            }
            var widths = currentColWidths(table);
            var max = measureContentWidth(heads[colIndex]);
            var rows = table.querySelectorAll('tbody tr');
            var limit = Math.min(rows.length, 200);
            for (var i = 0; i < limit; i++) {
                var cell = rows[i].children[colIndex];
                if (!cell) continue;
                var w = measureContentWidth(cell);
                if (w > max) max = w;
            }
            widths[colIndex] = Math.min(COL_MAX_WIDTH, Math.max(COL_MIN_WIDTH, Math.round(max) + 4));
            applyColWidths(table, widths);
            store[key] = currentColWidths(table);
            saveColWidthStore(store);
        }

        function attachResizeHandle(table, th, colIndex, key, store) {
            if (th.querySelector('.col-resize-handle')) return;
            th.classList.add('col-resizable');
            var handle = document.createElement('div');
            handle.className = 'col-resize-handle';
            handle.title = '拖动调节列宽 | 双击自适应内容宽度 | Shift+双击恢复本表默认列宽';
            th.appendChild(handle);

            handle.addEventListener('mousedown', function (e) {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();

                var heads = table.querySelectorAll('thead th');
                ensureColgroup(table, heads.length);
                if (!table.classList.contains('colresized')) {
                    var natural = measureNaturalWidths(table);
                    var sum = 0;
                    for (var k = 0; k < natural.length; k++) sum += natural[k];
                    if (sum <= 0) return; // 表格不可见，无法测量基准宽度
                    applyColWidths(table, natural);
                }

                var widths = currentColWidths(table);
                var startX = e.clientX;
                var startW = widths[colIndex];
                var moved = false;
                handle.classList.add('active');
                document.body.classList.add('col-resizing');

                function onMove(ev) {
                    var delta = ev.clientX - startX;
                    if (Math.abs(delta) > 1) moved = true;
                    widths[colIndex] = Math.min(COL_MAX_WIDTH, Math.max(COL_MIN_WIDTH, Math.round(startW + delta)));
                    applyColWidths(table, widths);
                }

                function onUp() {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    document.body.classList.remove('col-resizing');
                    handle.classList.remove('active');
                    if (moved) {
                        store[key] = currentColWidths(table);
                        saveColWidthStore(store);
                    }
                }

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });

            handle.addEventListener('dblclick', function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) {
                    resetTableWidths(table, key, store);
                } else {
                    autoFitColumn(table, colIndex, key, store);
                }
            });
        }

        function initColumnResize() {
            var store = loadColWidthStore();
            var tables = document.querySelectorAll('table');
            for (var t = 0; t < tables.length; t++) {
                var table = tables[t];
                var heads = table.querySelectorAll('thead th');
                if (!heads.length) continue;
                var key = getTableKey(table, t);
                ensureColgroup(table, heads.length);
                var saved = store[key];
                if (saved && saved.length === heads.length) {
                    applyColWidths(table, saved);
                }
                for (var i = 0; i < heads.length; i++) {
                    attachResizeHandle(table, heads[i], i, key, store);
                }
            }
        }

        window.addEventListener('DOMContentLoaded', init);
    </script>
</body>
</html>`;

    return htmlHead + jsonString + htmlTail;
}

module.exports = { buildReportHtml };
