const vscode = require('vscode');
const api = require('./core/api');

const VIEW_TYPE = 'tokenStats.dashboardView';

let core = null;
let hooks = {};
let panel = null;

// 在 Webview 与扩展之间搭桥：把报表页面里对 /api/* 的 fetch 转发给扩展宿主，
// 这样原 HTML 报表（原本依赖本地 HTTP 后台服务）无需任何改动即可在 VSCode 内运行。
const BRIDGE_SHIM = `
(function () {
    var api = null;
    try { api = acquireVsCodeApi(); } catch (e) { return; }

    var pending = {};
    var seq = 0;

    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg) return;
        if (msg.type === 'apiResponse') {
            var cb = pending[msg.id];
            if (cb) { delete pending[msg.id]; cb(msg); }
            return;
        }
        if (msg.type === 'command') {
            var map = { doRefresh: 'btnRefresh', doSyncCredits: 'btnSyncCredits', doPointsTasks: 'btnPointsTasks' };
            var btnId = map[msg.command];
            if (btnId) {
                var btn = document.getElementById(btnId);
                if (btn && !btn.disabled) { btn.click(); }
            }
        }
    });

    var originalFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : ((input && input.url) || '');
        if (url.indexOf('/api/') === -1) {
            return originalFetch ? originalFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
        }
        var apiPath = url.slice(url.indexOf('/api/'));
        var id = ++seq;
        return new Promise(function (resolve) {
            pending[id] = function (res) {
                var status = res.status || 200;
                var body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body === undefined ? {} : res.body);
                resolve({
                    ok: status >= 200 && status < 300,
                    status: status,
                    text: function () { return Promise.resolve(body); },
                    json: function () { return Promise.resolve(JSON.parse(body)); }
                });
            };
            api.postMessage({ type: 'apiRequest', id: id, path: apiPath, method: (init && init.method) || 'GET' });
        });
    };

    try {
        navigator.sendBeacon = function (url) { window.fetch(url, { method: 'POST' }); return true; };
    } catch (e) {}
})();
`;

function init(coreApi, options) {
    core = coreApi;
    hooks = options || {};
}

function isOpen() {
    return !!panel;
}

function tick() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function loadingHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <style>
        body { background: #0b0d13; color: #94a3b8; font-family: -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
               display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .box { text-align: center; font-size: 13px; line-height: 1.8; }
        .title { color: #f1f5f9; font-size: 15px; font-weight: 600; margin-bottom: 6px; }
    </style>
</head>
<body>
    <div class="box">
        <div class="title">AI Token 用量大盘</div>
        <div>正在收集 CodeBuddy / Antigravity 的 Token 数据…</div>
    </div>
</body>
</html>`;
}

function errorHtml(message) {
    const safe = String(message).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <style>
        body { background: #0b0d13; color: #94a3b8; font-family: -apple-system, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
               display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .box { max-width: 560px; text-align: left; font-size: 13px; line-height: 1.9; }
        .title { color: #ef4444; font-size: 15px; font-weight: 600; margin-bottom: 10px; }
    </style>
</head>
<body>
    <div class="box">
        <div class="title">数据收集失败</div>
        <div>${safe}</div>
        <div style="margin-top:12px;">可通过命令面板再次执行 “TokenStats: 刷新 Token 数据” 重试。</div>
    </div>
</body>
</html>`;
}

function injectBridge(html) {
    const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:;`;
    const block = `\n    <meta http-equiv="Content-Security-Policy" content="${csp}">\n    <script>${BRIDGE_SHIM}</script>`;
    const idx = html.indexOf('<head>');
    if (idx === -1) {
        return html.replace('<html', '<html data-bridge="headless"');
    }
    return html.slice(0, idx + 6) + block + html.slice(idx + 6);
}

function dataSource() {
    return (hooks.getDataSource && hooks.getDataSource()) || 'all';
}

function log(msg) {
    if (hooks.log) hooks.log(msg);
}

async function collect() {
    // 「无缓存即联网」由 core 统一实现，与 CLI 共用同一条规则：
    // 本地缓存优先；一份缓存都没有（或开启「打开看板自动同步」）时主动联网获取一次
    const forceSync = !!(hooks.autoSyncCredits && hooks.autoSyncCredits());
    return core.collectTokenDataWithCredits(dataSource(), {
        timeoutMs: forceSync ? 10000 : 15000,
        forceSync,
        onCredits: (credits) => { if (hooks.onCredits) hooks.onCredits(credits); },
        log
    });
}

async function render() {
    if (!panel) return;
    await tick();

    let data = null;
    let error = null;
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'AI Token 用量大盘：正在收集数据…',
        cancellable: false
    }, async () => {
        await tick();
        try {
            data = await collect();
        } catch (e) {
            error = e && e.message ? e.message : String(e);
        }
    });

    if (!panel) return;

    if (error || !data) {
        panel.webview.html = errorHtml(error || '未获取到数据');
        vscode.window.showErrorMessage('收集 Token 数据失败: ' + (error || '未知错误'));
        return;
    }

    panel.webview.html = injectBridge(core.buildReportHtml(data));
    if (data.codebuddyCredits && hooks.onCredits) hooks.onCredits(data.codebuddyCredits);
    log('看板已渲染：' + (data.conversations ? data.conversations.length : 0) + ' 个会话');
}

async function open() {
    if (panel) {
        panel.reveal(panel.viewColumn || vscode.ViewColumn.One);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        'AI Token 用量大盘',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            enableCommandUris: false
        }
    );
    panel.webview.html = loadingHtml();
    panel.onDidDispose(() => { panel = null; });
    panel.webview.onDidReceiveMessage(msg => onMessage(msg));

    await render();
}

async function refresh() {
    if (!panel) {
        await open();
        return;
    }
    panel.reveal(panel.viewColumn || vscode.ViewColumn.One);
    // 走页面自身的刷新按钮，保留筛选/搜索等交互状态
    panel.webview.postMessage({ type: 'command', command: 'doRefresh' });
}

async function runSyncCredits() {
    if (panel) {
        panel.reveal(panel.viewColumn || vscode.ViewColumn.One);
        panel.webview.postMessage({ type: 'command', command: 'doSyncCredits' });
        return;
    }
    const r = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在同步 CodeBuddy 积分…',
        cancellable: false
    }, async () => {
        await tick();
        return core.syncCreditsBestEffort(20000);
    });
    if (r.credits && hooks.onCredits) hooks.onCredits(r.credits);
    if (!r.credits) {
        vscode.window.showErrorMessage('积分同步失败: ' + (r.error || '未知错误'));
        return;
    }
    vscode.window.showInformationMessage(
        'CodeBuddy 积分' + (r.live ? '实时同步成功' : '同步失败，当前为本地缓存') +
        '：剩余 ' + r.credits.remainCredits.toFixed(2) + ' / ' + r.credits.totalCredits.toFixed(2) + ' Credits'
    );
}

async function runPointsTasks() {
    if (panel) {
        panel.reveal(panel.viewColumn || vscode.ViewColumn.One);
        panel.webview.postMessage({ type: 'command', command: 'doPointsTasks' });
        return;
    }
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在领取积分任务 (签到 + 成长中心)…',
        cancellable: false
    }, async () => {
        await tick();
        return core.runAllPointsTasks();
    });
    let credits = null;
    try {
        const cr = await core.syncCreditsBestEffort(15000);
        credits = cr.credits;
        if (credits && hooks.onCredits) hooks.onCredits(credits);
    } catch (e) {}

    if (result && result.success) {
        vscode.window.showInformationMessage('积分任务领取完成，本次 +' + (result.creditsGained || 0) + ' 积分：' + (result.report || ''));
    } else {
        vscode.window.showErrorMessage('积分任务领取失败: ' + ((result && (result.report || result.error)) || '未知错误'));
    }
}

function apiContext() {
    return {
        collectTokenData: (source) => core.collectTokenData(source),
        buildRefreshPayload: (opts) => core.buildRefreshPayload(opts),
        syncCreditsBestEffort: (ms) => core.syncCreditsBestEffort(ms),
        runAllPointsTasks: () => core.runAllPointsTasks(),
        getDataSource: dataSource,
        buildId: 'vscode-extension',
        writeReportOnRefresh: false, // Webview 模式无需落盘报表
        onCredits: (credits) => { if (hooks.onCredits) hooks.onCredits(credits); },
        log
    };
}

function onMessage(msg) {
    if (!msg || msg.type !== 'apiRequest') return;
    Promise.resolve()
        .then(() => api.handleApiRequest(apiContext(), msg.path))
        .then(res => {
            if (panel) {
                panel.webview.postMessage({
                    type: 'apiResponse', id: msg.id,
                    status: res.status,
                    body: JSON.stringify(res.body)
                });
            }
        })
        .catch(err => {
            if (panel) {
                panel.webview.postMessage({
                    type: 'apiResponse',
                    id: msg.id,
                    status: 500,
                    body: JSON.stringify({ success: false, error: (err && err.message) || String(err) })
                });
            }
        });
}

module.exports = {
    init,
    open,
    refresh,
    runSyncCredits,
    runPointsTasks,
    isOpen
};
