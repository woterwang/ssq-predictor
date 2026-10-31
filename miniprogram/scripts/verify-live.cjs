/** 真实公众接口联调：SQLite只读连接 + 注入无调度API，禁止采集/生成/核验写入。
 * 在Node中执行实际构建页面与wx.request HTTP桥接；不等于微信模拟器或真机验收。
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { instantiatePage } = require('./verify.cjs');
const root = path.resolve(__dirname, '..');
const serverRoot = path.resolve(root, '../server');
const serverRequire = createRequire(path.join(serverRoot, 'package.json'));
const Database = serverRequire('better-sqlite3');
const { createApiApp } = require(path.join(serverRoot, 'dist/api/createApp.js'));
const databasePath = process.env.SSQ_VERIFY_DATABASE || path.join(serverRoot, 'data/ssq.db');
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
let server;
let checks = 0;
function check(condition, label) { assert(condition, label); checks++; }
function snapshot() {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  return JSON.stringify(tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}" ORDER BY rowid`).all()]));
}
async function main() {
  const before = snapshot();
  const calendarFile = process.env.SSQ_VERIFY_CALENDAR || path.join(serverRoot, 'config/sales-suspension-periods.json');
  const app = createApiApp({ database, adminApiKey: null, now: () => new Date(),
    loadSuspensionPeriods: () => {
      const config = JSON.parse(fs.readFileSync(calendarFile, 'utf8'));
      if (!Array.isArray(config.periods)) throw new Error('停售配置缺少periods数组');
      return config.periods;
    },
    synchronize: async () => { throw new Error('只读联调禁止同步'); },
  });
  server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }), stopPullDownRefresh() {}, showToast() {},
    navigateTo() {}, switchTab() {}, setClipboardData() {}, pageScrollTo() {},
    request(options) {
      const url = new URL(options.url);
      const allowedPost = options.method === 'POST' && ['/api/tickets/check', '/api/tickets/history-match'].includes(url.pathname) && url.search === '';
      check((options.method === 'GET' || allowedPost) && !options.header.Authorization && !url.pathname.startsWith('/api/admin'), '仅GET公众请求与无状态体检POST');
      requests.push(`${options.method} ${url.pathname}${url.search}`);
      // 仅验收桥接替换监听端口，不改小程序服务地址配置，也不影响正式/体验版本。
      fetch(`${origin}${url.pathname}${url.search}`, { method: options.method, headers: options.header,
        body: allowedPost ? JSON.stringify(options.data) : undefined, signal: AbortSignal.timeout(15000) }).then(async response => {
        options.success({ statusCode: response.status, header: Object.fromEntries(response.headers.entries()), data: await response.json() });
      }).catch(() => options.fail({ errMsg: 'HTTP bridge failed' }));
    },
  };
  const home = instantiatePage('home');
  await Promise.all([home.refreshNext(), home.refreshLatestDraw()]);
  check(home.data.next !== null && home.data.nextError === '', `真实下一期响应通过前端验证：${home.data.nextError}`);
  check(home.data.latestDraw !== null && home.data.drawError === '', '真实最新开奖通过前端验证');
  const history = instantiatePage('history');
  await history.refresh(); await history.loadMore();
  check(history.data.draws.length > 20 && history.data.error === '', '真实历史游标追加');
  const latest = history.data.draws[0];
  const pad = number => String(number).padStart(2, '0');
  history.onNumbersChange({ detail: { value: [...latest.redBalls, latest.blueBall].map(pad).join(' ') } });
  await history.matchNumbers();
  check(history.data.matchResult?.rows.some(row => row.issue === latest.issue && row.gradeText.startsWith('一等奖')) && history.data.matchError === '',
    `真实最新开奖号码历史比对命中一等奖：${history.data.matchError}`);
  const detail = instantiatePage('draw-detail');
  detail.requestedIssue = home.data.latestDraw.issue; detail.data.routeValid = true;
  await detail.refresh();
  check(detail.data.draw?.issue === home.data.latestDraw.issue && detail.data.prizeRows.length === 6 && detail.data.error === '', '真实单期详情/六奖级/结构');
  const archives = instantiatePage('recommendations');
  await archives.refresh();
  check(archives.data.items.length > 0 && archives.data.error === '', '真实固化档案');  check(archives.data.summary !== null && archives.data.summaryError === '', `真实成绩汇总通过前端验证：${archives.data.summaryError}`);  const verification = instantiatePage('verification');
  verification.requestedId = archives.data.items[0].id; verification.data.routeValid = true;
  await verification.refresh();
  check(verification.data.view !== null && verification.data.error === '', '真实推荐核验页面映射');
  if (verification.data.view.latest === null) {
    check(!verification.data.showOutcomes && !verification.data.replayAvailable && verification.data.frozenTickets.length > 0, '无核验原件仍显示、不判奖/收益');
  }
  const analysis = instantiatePage('analysis');
  await analysis.load(true);
  check(analysis.data.rows.length === 33 && analysis.data.error === '' && analysis.data.coverage.includes(home.data.latestDraw.issue), `真实近100期统计：${analysis.data.error}`);
  const trend = instantiatePage('charts/pages/trend');
  trend.features = [];
  await trend.load(false);
  check(trend.data.points.length === 100 && trend.data.points[99].issue === home.data.latestDraw.issue && trend.data.error === '', '真实走势复用同窗口报告');
  const backtests = instantiatePage('research/pages/backtests');
  backtests.runs = new Map();
  await backtests.refresh();
  check(backtests.data.items.length > 0 && backtests.data.error === '' && backtests.data.selected !== null, `真实已保存回测：${backtests.data.error}`);
  const ticketPage = instantiatePage('research/pages/ticket-check');
  for (const number of home.data.latestDraw.redBalls) ticketPage.toggleRed({ currentTarget: { dataset: { number } } });
  ticketPage.toggleBlue({ currentTarget: { dataset: { number: home.data.latestDraw.blueBall } } });
  await ticketPage.check();
  check(ticketPage.data.result !== null && ticketPage.data.error === '', `真实选号体检：${ticketPage.data.error}`);
  check(requests.filter(item => item.includes('/api/statistics')).length === 1, '分析与走势同窗口只请求一次');
  check(snapshot() === before, '所有SQLite表前后快照一致');
  console.log(`Real readonly page/API bridge passed: ${checks} checks, ${requests.length} HTTP requests (${requests.filter(item => item.startsWith('POST')).length} stateless POST).`);
  console.log(JSON.stringify({ latestDraw: home.data.latestDraw.issue, recommendationId: verification.data.view.recommendation.id,
    targetIssue: verification.data.view.recommendation.targetIssue, status: verification.data.statusLabel,
    analysis: analysis.data.coverage, trendRange: trend.data.rangeText, backtests: backtests.data.items.length,
    selectedBacktest: backtests.data.selected.title, ticketSum: ticketPage.data.result.rows[0].value, tableSnapshotUnchanged: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  database.close();
});