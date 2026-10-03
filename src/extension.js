const vscode = require('vscode');
const path = require('path');
const dashboard = require('./dashboard');
const { TurnWatcher, buildStatusText, buildDetailText, getLatestAntigravityTurn, getActiveAntigravityDbPath } = require('./turn-watcher');

let core = null;
let channel = null;
let statusBar = null;       // 一体化状态栏项（右侧优先级 100）
let watcher = null;
let lastTurn = null;
let autoCheckinTimer = null;    // 每日自动签到的周期检查定时器
let autoCheckinDisposable = null; // 自动签到定时器的清理句柄

// 每日自动签到：扩展启动后延迟执行一次，之后每小时检查一次（覆盖跨天/长时间驻留场景）
const AUTO_CHECKIN_START_DELAY_MS = 5000;
const AUTO_CHECKIN_INTERVAL_MS = 60 * 60 * 1000;

function log(msg) {
    if (channel) channel.appendLine('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

function config(key, dft) {
    return vscode.workspace.getConfiguration('tokenStats').get(key, dft);
}

function getWorkspaceDirs() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];
    return folders.map(f => f.uri.fsPath);
}

function updateStatusBar() {
    if (!statusBar) return;

    if (!config('showStatusBar', true)) {
        statusBar.hide();
        return;
    }

    // 检测当前最新活跃对话是否与 lastTurn 所属对话一致（仅限当前窗口所属工作区）。
    // 若用户已开启新对话（新 .db 文件 mtime 最新，但尚无 AI 响应），则隐藏旧对话信息。
    const isAgTurn = lastTurn && lastTurn.source === 'Antigravity';
    let turnStale = false;
    if (isAgTurn && lastTurn.dbPath) {
        const activeDb = getActiveAntigravityDbPath(getWorkspaceDirs());
        if (activeDb && activeDb !== lastTurn.dbPath) {
            turnStale = true; // 当前最新 .db 不是 lastTurn 所属对话 → 新对话已开启
        }
    }
    const showTurn = config('showTurnStats', true) && isAgTurn && !turnStale;

    // 1. 状态栏精简展示文本（屏幕右下角按钮：只显示总token量、上下文占比、token速度）
    let text = '';
    if (showTurn) {
        text = buildStatusText(lastTurn);
    } else {
        text = '反重力 Token';
    }
    statusBar.text = text;

    // 2. 悬停 Tooltip：展示反重力单次回答明细
    if (showTurn) {
        statusBar.tooltip = buildDetailText(lastTurn);
    } else if (turnStale) {
        statusBar.tooltip = '反重力 Token 监控 (点击打开大盘)\n───────────────────────────────\n已开启新对话，等待 AI 首次响应…';
    } else {
        statusBar.tooltip = '反重力 Token 监控 (点击打开大盘)\n───────────────────────────────\n暂无会话回答记录（等待下一次 AI 响应…）';
    }
    statusBar.show();
}

async function showCredits() {
    let credits = null;
    try { credits = core.getCodeBuddyCreditsInfo(); } catch (e) { credits = null; }

    if (!credits || typeof credits.totalCredits !== 'number') {
        const pick = await vscode.window.showInformationMessage('暂无 CodeBuddy 积分缓存，是否立即同步？', '同步', '取消');
        if (pick !== '同步') return;
        const r = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在同步 CodeBuddy 积分…',
            cancellable: false
        }, async () => core.syncCreditsBestEffort(20000));
        credits = r.credits;
        if (!credits) {
            vscode.window.showErrorMessage('积分同步失败: ' + (r.error || '未知错误'));
            return;
        }
    }

    vscode.window.showInformationMessage(
        'CodeBuddy 剩余 ' + credits.remainCredits.toFixed(2) + ' / ' + credits.totalCredits.toFixed(2) +
        ' Credits（' + credits.remainPercent + '），已用 ' + credits.usedCredits.toFixed(2)
    );
}

async function openInBrowser() {
    try {
        const data = core.collectTokenData(config('dataSource', 'all'));
        const reportPath = core.generateHtmlReport(data);
        await vscode.env.openExternal(vscode.Uri.file(reportPath));
    } catch (e) {
        vscode.window.showErrorMessage('生成报表失败: ' + (e && e.message ? e.message : String(e)));
    }
}

/** 显示最新反重力 turn 详情（点状态栏或命令调用） */
async function showLastTurn() {
    if (!lastTurn || lastTurn.source !== 'Antigravity') {
        // 状态栏不再预读历史，本命令属用户显式查询：按需回查本工作区最近一条历史回答
        // 注：仅用于弹窗展示，不回写 lastTurn，避免历史数据重新占用状态栏
        let history = null;
        try {
            history = getLatestAntigravityTurn(core, getWorkspaceDirs());
        } catch (e) {
            history = null;
        }
        if (history) {
            const action = await vscode.window.showInformationMessage(
                '本工作区最近一次反重力 AI 回答（历史记录，未计入本次状态栏）\n' + buildDetailText(history),
                '打开 Token 大盘'
            );
            if (action === '打开 Token 大盘') dashboard.open();
            return;
        }
        const action = await vscode.window.showInformationMessage(
            '暂无反重力 AI 回答 Token 统计，等待下一次 AI 响应…',
            '打开 Token 大盘'
        );
        if (action === '打开 Token 大盘') dashboard.open();
        return;
    }
    const detail = buildDetailText(lastTurn);
    const action = await vscode.window.showInformationMessage(
        '最新反重力 AI 回答 Token 统计\n' + detail,
        '打开 Token 大盘'
    );
    if (action === '打开 Token 大盘') dashboard.open();
}

/**
 * CodeBuddy 每日自动签到（幂等）。
 * 只执行「每日签到」环节，不触碰成长中心的补登卡等稀缺资源；
 * 当天已签到时核心层会直接跳过，不产生额外请求。
 * @param {boolean} [force] 手动触发：忽略当日去重，并把结果回显给用户
 */
async function runAutoCheckin(force = false) {
    if (!force && !config('autoDailyCheckin', true)) return;
    try {
        const r = await core.runAutoDailyCheckin({ force });
        if (!r) return;

        if (r.result === 'CLAIMED') {
            log('[自动签到] 成功: ' + r.report);
            // 签到会改变积分余量，顺手刷新一次缓存，让看板/积分查询立刻拿到新值
            try { await core.syncCreditsBestEffort(15000); } catch (e) {}
            if (force) vscode.window.showInformationMessage('CodeBuddy 签到成功：' + r.report);
        } else if (r.result === 'ALREADY') {
            log('[自动签到] ' + r.report + (r.skipped ? '（当日已处理，跳过）' : ''));
            if (force) vscode.window.showInformationMessage('CodeBuddy ' + r.report);
        } else {
            log('[自动签到] ' + r.result + ': ' + r.report);
            if (force) vscode.window.showWarningMessage('CodeBuddy 签到未完成：' + r.report);
        }
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        log('[自动签到] 异常: ' + msg);
        if (force) vscode.window.showErrorMessage('CodeBuddy 签到失败：' + msg);
    }
}

/** 按当前配置启停自动签到（可重复调用，内部先清理旧定时器） */
function setupAutoCheckin(context) {
    if (autoCheckinDisposable) {
        autoCheckinDisposable.dispose();
        autoCheckinDisposable = null;
    }
    if (autoCheckinTimer) { clearInterval(autoCheckinTimer); autoCheckinTimer = null; }

    if (!config('autoDailyCheckin', true)) {
        log('每日自动签到已关闭');
        return;
    }

    const startTimer = setTimeout(() => runAutoCheckin(), AUTO_CHECKIN_START_DELAY_MS);
    autoCheckinTimer = setInterval(() => runAutoCheckin(), AUTO_CHECKIN_INTERVAL_MS);
    autoCheckinDisposable = {
        dispose: () => {
            clearTimeout(startTimer);
            if (autoCheckinTimer) { clearInterval(autoCheckinTimer); autoCheckinTimer = null; }
        }
    };
    context.subscriptions.push(autoCheckinDisposable);
    log('每日自动签到已启用（启动后 ' + (AUTO_CHECKIN_START_DELAY_MS / 1000) + 's 首次执行，之后每小时检查一次）');
}

function activate(context) {
    channel = vscode.window.createOutputChannel('AI Token 用量大盘');
    context.subscriptions.push(channel);

    // 把核心模块的统一日志接入输出通道（替换分散的静默 catch）
    try {
        require('./core/log').setSink((level, msg) => log('[' + level + '] ' + msg));
    } catch (e) { /* 日志接入失败不影响主流程 */ }

    try {
        core = require(path.join(context.extensionPath, 'token-stats.js'));
    } catch (err) {
        vscode.window.showErrorMessage('加载 token-stats.js 失败: ' + err.message);
        return;
    }

    // 缓存与报表产物写入扩展自己的存储目录，避免污染 VSCode 启动目录
    core.setDataDir(path.join(context.globalStorageUri.fsPath, 'data'));
    log('数据目录: ' + core.getDataDir());
    log('宿主 Node: ' + process.versions.node + ' | node:sqlite: ' + (core.isSqliteAvailable() ? '可用' : '不可用'));
    if (!core.isSqliteAvailable()) {
        log('提示: 当前 VSCode 内置 Node 缺少 node:sqlite (需 >= 22.5)，反重力(Antigravity) 会话明细将为空，CodeBuddy 数据不受影响。');
    }
    function syncCustomSessionFromConfig() {
        const token = config('codebuddyAccessToken', '');
        const uid = config('codebuddyUid', '');
        if (core && core.setCustomSession) {
            if (token && typeof token === 'string' && token.trim()) {
                core.setCustomSession({
                    accessToken: token.trim(),
                    uid: uid && typeof uid === 'string' && uid.trim() ? uid.trim() : null
                });
                log('已加载用户配置的 CodeBuddy 凭据 (Token/UID)');
            } else {
                core.setCustomSession(null);
            }
        }
    }
    syncCustomSessionFromConfig();

    dashboard.init(core, {
        log,
        onCredits: () => {},
        getDataSource: () => config('dataSource', 'all'),
        autoSyncCredits: () => config('autoSyncCreditsOnOpen', false)
    });

    // ── 状态栏：一体化 Token 大盘与实时消耗（右侧优先级 100） ───────────────
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'tokenStats.openDashboard';
    context.subscriptions.push(statusBar);

    // 启动时不预读历史会话：状态栏先显示中性占位，等待本窗口产生新的 AI 回答后再展示数值。
    // （历史数据仍可通过「查看最新回答 Token 统计」命令按需查询，或直接在 Token 大盘中查看）
    lastTurn = null;
    updateStatusBar();

    // ── TurnWatcher 启动 ─────────────────────────────────────────────────
    watcher = new TurnWatcher({
        log,
        pollIntervalMs: config('turnPollIntervalMs', 3000),
        getWorkspaceDirs, // 注入工作区路径获取函数，实现多窗口精确隔离
        // 检测到新对话（.db 首次出现）时立即刷新状态栏，隐藏旧对话信息
        onNewConversation: (_dbPath) => {
            log('检测到当前工作区新对话，刷新状态栏: ' + _dbPath);
            updateStatusBar();
        },
        onTurn: (turn) => {
            if (turn && turn.source === 'Antigravity') {
                lastTurn = turn;
                updateStatusBar();
                log('[TurnWatcher] 状态栏已更新: ' + buildStatusText(turn));
            }
        }
    });
    watcher.setCore(core);
    watcher.start();
    const wsLabel = getWorkspaceDirs().map(d => path.basename(d)).join(', ') || '无工作区';
    log('TurnWatcher 已启动 (反重力专属模式 | 绑定工作区: ' + wsLabel + ')');

    // ── CodeBuddy 每日自动签到 ─────────────────────────────────────────────
    setupAutoCheckin(context);

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            // 工作区变动后旧数据不再属于当前上下文，同样不预读新工作区的历史，重置为占位态
            log('工作区文件夹变动，重置状态栏（等待本工作区新回答）');
            lastTurn = null;
            updateStatusBar();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tokenStats.openDashboard', () => dashboard.open()),
        vscode.commands.registerCommand('tokenStats.refresh', () => dashboard.refresh()),
        vscode.commands.registerCommand('tokenStats.syncCredits', () => dashboard.runSyncCredits()),
        vscode.commands.registerCommand('tokenStats.pointsTasks', () => dashboard.runPointsTasks()),
        vscode.commands.registerCommand('tokenStats.dailyCheckin', () => runAutoCheckin(true)),
        vscode.commands.registerCommand('tokenStats.showCredits', showCredits),
        vscode.commands.registerCommand('tokenStats.openInBrowser', openInBrowser),
        vscode.commands.registerCommand('tokenStats.showLastTurn', showLastTurn)
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('tokenStats.showStatusBar') || e.affectsConfiguration('tokenStats.showTurnStats')) {
                updateStatusBar();
            }
            if (e.affectsConfiguration('tokenStats.autoDailyCheckin')) {
                setupAutoCheckin(context);
            }
            if (e.affectsConfiguration('tokenStats.codebuddyAccessToken') || e.affectsConfiguration('tokenStats.codebuddyUid')) {
                syncCustomSessionFromConfig();
            }
        })
    );
}

function deactivate() {
    if (autoCheckinDisposable) { autoCheckinDisposable.dispose(); autoCheckinDisposable = null; }
    if (autoCheckinTimer) { clearInterval(autoCheckinTimer); autoCheckinTimer = null; }
    if (watcher) { watcher.stop(); watcher = null; }
    if (channel) channel.dispose();
}

module.exports = { activate, deactivate };

