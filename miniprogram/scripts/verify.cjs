/** 独立验收：路由/依赖检查 + 官方离线编译（若已安装）+ 页面逻辑桩验证。
 * 桩数据仅存在于此Node脚本，从不被复制到小程序dist或冒充线上数据。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
let checks = 0;
function check(condition, label) { assert(condition, label); checks += 1; }
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function componentBase(file, name) {
  if (name.startsWith('/')) return path.join(output, name);
  if (name.startsWith('.')) return path.resolve(path.dirname(file), name);
  return path.join(output, 'miniprogram_npm', name);
}
function instantiatePage(name) {
  let definition;
  global.Page = value => { definition = value; };
  const file = name.includes('/') ? path.join(output, name, 'index.js') : path.join(output, 'pages', name, 'index.js');
  delete require.cache[require.resolve(file)];
  require(file);
  const instance = { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update); } };
  return instance;
}
/** 组件桩：只模拟properties/setData/生命周期，不替代开发者工具渲染。 */
function instantiateComponent(route, properties, selectorResult) {
  let definition;
  global.Component = value => { definition = value; };
  const file = path.join(output, route, 'index.js');
  delete require.cache[require.resolve(file)];
  require(file);
  const data = { ...structuredClone(definition.data) };
  for (const [key, spec] of Object.entries(definition.properties)) data[key] = spec.value;
  const instance = { ...definition.methods, data, setData(update) { Object.assign(this.data, update); },
    createSelectorQuery: () => ({ select: () => ({ fields: () => ({ exec: callback => callback([selectorResult]) }) }) }) };
  Object.assign(instance.data, properties);
  return { instance, definition };
}
function freshApi() {
  const file = path.join(output, 'services/api.js');
  delete require.cache[require.resolve(file)];
  return require(file);
}
function rejected(promise, code) { return assert.rejects(promise, error => error.code === code); }

async function main() {
  const app = json(path.join(output, 'app.json'));
  const routes = [...app.pages, ...app.subPackages.flatMap(pack => pack.pages.map(page => `${pack.root}/${page}`))];
  check(routes.length === 11 && new Set(routes).size === 11, '7个主包路由+3个研究分包+1个图表分包');
  check(app.subPackages.map(pack => pack.root).join() === 'research,charts', '研究与图表分包');
  check(!fs.readdirSync(output).includes('lib') && fs.existsSync(path.join(output, 'charts/lib/echarts.js')), 'ECharts仅在charts分包');
  check(fs.existsSync(path.join(output, 'charts/lib/ECHARTS-LICENSE')) && fs.existsSync(path.join(output, 'charts/lib/ECHARTS-NOTICE')), 'ECharts许可证随包');
  check(!/\bnew Function\b|\beval\(/.test(fs.readFileSync(path.join(output, 'charts/lib/echarts.js'), 'utf8')), 'ECharts包无动态代码执行');
  const mainFiles = files(output).map(file => path.relative(output, file).replace(/\\/g, '/')).filter(file => !/^(research|charts)\//.test(file));
  check(mainFiles.every(file => !/echarts/i.test(file)) && !mainFiles.some(file => file.startsWith('research/') || file.startsWith('charts/')), '主包不含图表库');
  for (const route of routes) for (const extension of ['js', 'json', 'wxml', 'wxss']) {
    check(fs.existsSync(path.join(output, `${route}.${extension}`)), `路由文件${route}.${extension}`);
  }
  check(app.tabBar.list.length === 4 && app.tabBar.list.every(tab => app.pages.includes(tab.pagePath)), '4个原生Tab路由');
  check(!app.style, 'TDesign不启用原生style:v2');
  check(json(path.join(root, 'project.config.json')).miniprogramRoot === 'dist/', '子目录工程运行dist');
  check(json(path.join(root, '../project.config.json')).miniprogramRoot === 'miniprogram/dist/', '根目录工程运行dist');
  for (const file of files(output)) {
    if (file.endsWith('.js')) new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
    if (file.endsWith('.json')) {
      for (const name of Object.values(json(file).usingComponents || {})) {
        const base = componentBase(file, name);
        for (const extension of ['js', 'json', 'wxml', 'wxss']) check(fs.existsSync(`${base}.${extension}`), `组件依赖${name}.${extension}`);
      }
    }
    if (file.endsWith('.wxml')) check(!fs.readFileSync(file, 'utf8').includes('&amp;&amp;'), '原生WXML表达式不用HTML实体');
  }
  const sources = files(path.join(root, 'src')).filter(file => file.endsWith('.ts')).map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const vendorStyles = files(path.join(output, 'miniprogram_npm')).filter(file => file.endsWith('.wxss')).map(file => fs.readFileSync(file, 'utf8')).join('\n');
  check(!/url\(\s*["']?https?:/i.test(vendorStyles), '运行样式无远程字体/图片');
  check(!/\/api\/admin\//.test(sources), '小程序没有管理路由');
  check(!/\b(setInterval|setTimeout|getClipboardData|setStorage|setStorageSync|login)\s*\(/.test(sources), '不后台轮询/读取剪贴板/持久化/登录');
  const compilerDir = process.env.WECHAT_COMPILER_DIR || 'C:/Program Files (x86)/Tencent/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
  for (const [name, pattern] of [['wcc.exe', /\.(wxml|wxs)$/], ['wcsc.exe', /\.wxss$/]]) {
    const executable = path.join(compilerDir, name);
    if (!fs.existsSync(executable)) { console.log(`${name}未找到，跳过官方离线编译；不能据此声称模板已验收。`); continue; }
    const inputs = files(output).filter(file => pattern.test(file)).map(file => path.relative(output, file).replace(/\\/g, '/'));
    const result = spawnSync(executable, inputs, { cwd: output, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    check(result.status === 0, `${name}编译失败：${result.stderr}`);
    console.log(`${name}: ${inputs.length} files compiled.`);
  }

  const ticket = { redBalls: [1, 6, 13, 20, 27, 31], blueBall: 5 };
  const draw = { ...ticket, issue: '2026124', drawDate: '2026-10-29', salesAmountYuan: null, prizePoolAmountYuan: null, prizeGrades: [], isPrizeDetailComplete: false };
  const recommendation = { id: 1, targetIssue: '2026125', targetDrawDate: '2026-11-01', generationDeadline: '2026-11-01T12:00:00.000Z', sourceLatestIssue: draw.issue,
    strategyName: 'M0_uniform_random', strategyVersion: 'verification-fixture', strategyParams: {}, seed: 1, tickets: [ticket], contentHash: 'a'.repeat(64), generatedAt: '2026-10-31T10:00:00.000Z' };
  const next = { status: 'available', reason: null, nextDraw: { issue: recommendation.targetIssue, drawDate: recommendation.targetDrawDate, drawTimeBeijing: '21:15' },
    generationDeadline: recommendation.generationDeadline, sourceLatestIssue: draw.issue, recommendation };
  let transport = options => options.success({ statusCode: 200, header: {}, data: { data: options.url.endsWith('/next') ? next : draw } });
  let requestCount = 0;
  global.wx = { getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }), request: options => { requestCount++; transport(options); },
    getSystemInfoSync: () => ({ pixelRatio: 2 }), getWindowInfo: () => ({ pixelRatio: 2 }), pageScrollTo() {},
    stopPullDownRefresh() {}, showToast() {}, navigateTo() {}, switchTab() {}, setClipboardData() {} };
  let client = freshApi();
  const presentation = require(path.join(output, 'utils/presentation.js'));
  check(presentation.formatBeijingTime('2026-10-31T10:00:00.000Z').includes('18:00:00'), '固定北京时间');
  check(presentation.formatAmount(null) === '待公布' && presentation.formatAmount(0).startsWith('0'), '空值与0分开');
  check(presentation.describeStructure(ticket).sum === '98' && presentation.describeStructure(ticket).oddEven === '4 : 2', '结构纯计算');
  await client.api.getNext(); checks++;
  transport = options => options.success({ statusCode: 200, header: {}, data: { data: { ...draw, redBalls: [1, 1, 2, 3, 4, 5] } } });
  await rejected(client.api.getLatestDraw(), 'INVALID_RESPONSE'); checks++;
  global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'release' } });
  const beforeConfig = requestCount;
  await rejected(client.api.getLatestDraw(), 'ENVIRONMENT');
  check(requestCount === beforeConfig, '正式域名未配置时不请求');
  global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'develop' } });
  transport = options => options.success({ statusCode: 429, header: { 'Retry-After': '60' }, data: {} });
  await rejected(client.api.getLatestDraw(), 'RATE_LIMITED');
  const beforeRetry = requestCount;
  await rejected(client.api.getLatestDraw(), 'RATE_LIMITED');
  check(requestCount === beforeRetry, 'Retry-After期间不发重试');
  client = freshApi();
  transport = options => options.success({ statusCode: 200, header: {}, data: { data: next } });
  const home = instantiatePage('home');
  await home.refreshNext();
  check(home.data.frozenTickets.length === 1 && home.data.nextError === '', '首页真实客户端映射');
  const previousTime = home.data.nextUpdatedAt;
  transport = options => options.fail({ errMsg: 'verification offline' });
  await home.refreshNext();
  check(home.data.frozenTickets.length === 1 && !!home.data.nextError && home.data.nextUpdatedAt === previousTime, '刷新失败保留原件/旧时间');
  let respond;
  transport = options => { respond = options.success; };
  const loadingHome = instantiatePage('home');
  const pending = loadingHome.refreshNext();
  loadingHome.onUnload();
  respond({ statusCode: 200, header: {}, data: { data: next } });
  await pending;
  check(loadingHome.data.next === null, '已卸载页面不回写');

  transport = options => options.success({ statusCode: 200, header: {}, data: { data: Array.from({ length: 20 }, (_, index) => ({ ...draw, issue: `2026${String(124 - index).padStart(3, '0')}` })), pagination: { nextBeforeIssue: '2026105', limit: 20 } } });
  const history = instantiatePage('history');
  await history.refresh();
  check(history.data.draws.length === 20 && history.data.hasMore && history.data.beforeIssue === '2026105', '排除式游标第一页');
  transport = options => options.fail({ errMsg: 'verification offline' });
  await history.loadMore();
  check(history.data.draws.length === 20 && history.data.beforeIssue === '2026105', '追加失败保留游标');
  transport = options => options.success({ statusCode: 200, header: {}, data: { data: [{ ...draw, issue: '2026104' }], pagination: { nextBeforeIssue: '2026104', limit: 20 } } });
  await history.loadMore();
  check(history.data.draws.length === 21 && !history.data.hasMore, '追加重试成功且终止');

  const pendingView = { recommendation, latest: null, versions: [] };
  transport = options => options.url.includes('/verification')
    ? options.success({ statusCode: 200, header: {}, data: { data: pendingView } })
    : options.success({ statusCode: 404, header: {}, data: {} });
  const verification = instantiatePage('verification');
  verification.requestedId = 1; verification.data.routeValid = true;
  await verification.refresh();
  check(verification.data.drawPending && !verification.data.showOutcomes && !verification.data.replayAvailable && verification.data.frozenTickets.length === 1, '待开奖不判命中/收益');
  transport = options => options.url.includes('/verification')
    ? options.success({ statusCode: 200, header: {}, data: { data: pendingView } })
    : options.success({ statusCode: 200, header: {}, data: { data: { ...draw, issue: '2026125', drawDate: '2026-11-01' } } });
  await verification.refresh();
  check(!verification.data.drawPending && !verification.data.showOutcomes && verification.data.statusLabel === '当前版本待核验', '已开奖但latest空不等于未中');
  const result = { definitionVersion: 'fixture', recommendationContentHash: recommendation.contentHash, targetIssue: recommendation.targetIssue,
    targetDrawDate: recommendation.targetDrawDate, outcomes: [{ redHits: 3, blueHit: false, grade: 'none', prizeYuan: null }],
    payoutAudit: { eligible: false, fortuneActive: false, withheldReasons: ['验收桩：资格未核实'] }, announcedPrizeReplayYuan: null, formalRoi: null, limitations: [] };
  const versionA = { id: 1, recommendationId: 1, drawFingerprint: 'b'.repeat(64), verifiedAt: '2026-11-01T14:00:00.000Z', result };
  const versionB = { ...versionA, id: 2, drawFingerprint: 'c'.repeat(64) };
  const correctedView = { recommendation, latest: versionA, versions: [versionB, versionA] };
  transport = options => options.url.includes('/verification')
    ? options.success({ statusCode: 200, header: {}, data: { data: correctedView } })
    : options.success({ statusCode: 200, header: {}, data: { data: { ...draw, issue: '2026125', drawDate: '2026-11-01' } } });
  await verification.refresh();
  check(verification.data.latestFingerprint === versionA.drawFingerprint && verification.data.versions[0].id === 2 && !verification.data.replayAvailable, 'A-B-A当前版本按latest且暂停金额');
  const state = require(path.join(output, 'services/validation.js'));
  assert.throws(() => state.validateVerification({ ...correctedView, latest: { ...versionA, result: { ...result, formalRoi: 0 } } })); checks++;
  transport = options => options.fail({ errMsg: 'verification offline' });
  await verification.refresh();
  check(!verification.data.showOutcomes && !verification.data.replayAvailable && !!verification.data.error, '核验刷新失败不冒称当前命中');
  await verifySummary(state, value => { transport = value; }, recommendation);
  await verifyResearchPages(state, () => requestCount, value => { transport = value; });
  console.log(`Independent miniprogram verification passed: ${checks} checks. Fixtures never enter dist.`);
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const tap = dataset => ({ currentTarget: { dataset } });
/** 成绩汇总：空样本null不显示为0；计数不自洽拒绝；失败保留旧汇总。 */
async function verifySummary(validation, setTransport, recommendation) {
  const prizeCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, fortune: 0, none: 0 };
  const empty = { definitionVersion: 'fixture', recommendationCount: 1, issues: { verified: 0, awaitingDraw: 1, awaitingVerification: 0 },
    tickets: { verifiedTicketCount: 0, totalRedHits: 0, averageRedHits: null, blueHitCount: 0, blueHitRate: null,
      redHitDistribution: [0, 0, 0, 0, 0, 0, 0], prizeCounts },
    theoretical: { averageRedHits: 36 / 33, blueHitRate: 1 / 16 },
    payout: { accountedIssueCount: 0, withheldIssueCount: 0, accountedCostYuan: 0, announcedPrizeReplayYuan: 0, formalRoi: null }, limitations: ['桩'] };
  const verified = { ...empty, issues: { verified: 1, awaitingDraw: 0, awaitingVerification: 0 },
    tickets: { ...empty.tickets, verifiedTicketCount: 5, totalRedHits: 6, averageRedHits: 6 / 5, blueHitCount: 1, blueHitRate: 1 / 5,
      redHitDistribution: [1, 3, 0, 1, 0, 0, 0], prizeCounts: { ...prizeCounts, 6: 1, none: 4 } },
    payout: { ...empty.payout, withheldIssueCount: 1 } };
  validation.validateRecommendationSummary(empty); validation.validateRecommendationSummary(verified); checks += 2;
  for (const bad of [{ ...empty, tickets: { ...empty.tickets, averageRedHits: 0 } },
    { ...empty, recommendationCount: 2 }, { ...verified, tickets: { ...verified.tickets, averageRedHits: 1.09 } },
    { ...verified, tickets: { ...verified.tickets, redHitDistribution: [0, 4, 0, 1, 0, 0, 0] } },
    { ...verified, payout: { ...verified.payout, withheldIssueCount: 0 } }, { ...verified, payout: { ...verified.payout, formalRoi: 0 } }]) {
    assert.throws(() => validation.validateRecommendationSummary(bad)); checks++;
  }
  let summary = empty;
  setTransport(options => options.success({ statusCode: 200, header: {}, data: options.url.includes('/summary')
    ? { data: summary } : { data: [recommendation], pagination: { nextBeforeId: 1, limit: 20 } } }));
  const archives = instantiatePage('recommendations');
  await archives.refresh();
  check(archives.data.summary && !archives.data.summary.hasSample && archives.data.items.length === 1, '空样本汇总与档案并行');
  summary = verified;
  await archives.refresh();
  check(archives.data.summary.hasSample && archives.data.summary.redText.includes('1.200') && archives.data.summary.redText.includes('1.091')
    && archives.data.summary.payoutText.includes('不核算') && archives.data.summary.prizeText.includes('六等奖 1'), '已核验汇总映射');
  setTransport(options => options.url.includes('/summary') ? options.fail({ errMsg: 'offline' })
    : options.success({ statusCode: 200, header: {}, data: { data: [recommendation], pagination: { nextBeforeId: 1, limit: 20 } } }));
  await archives.refresh();
  check(archives.data.summary.hasSample && !!archives.data.summaryError && archives.data.error === '', '汇总失败保留旧值且不影响列表');
}
function analysisFixture(window = 100) {
  const stat = (number, theoretical, count) => ({ number, appearanceCount: count, appearanceRate: count / 150, theoreticalAppearanceRate: theoretical,
    expectedAppearanceCount: 150 * theoretical, currentOmission: count ? 1 : 150, currentOmissionIsLowerBound: count === 0, maximumObservedOmission: 150,
    maximumCompleteOmission: null, averageCompleteOmission: count > 1 ? 4.5 : null, completeOmissionCount: 0, completeOmissionDistribution: {},
    heatLabel: count === 0 ? 'cold' : count > 30 ? 'hot' : 'normal', lastAppearanceIssue: count ? '2026149' : null });
  const features = Array.from({ length: 150 }, (_, index) => ({ issue: `2026${String(index + 1).padStart(3, '0')}`, drawDate: '2026-01-01',
    redSum: 90 + (index % 30), redSpan: 20, redOddCount: 3, redEvenCount: 3, redSmallCount: 3, redLargeCount: 3, redZoneCounts: [2, 2, 2],
    consecutiveGroupCount: 0, consecutivePairCount: 0, repeatedRedCount: index === 0 || index === 120 ? null : 1, redTailCounts: Array(10).fill(0),
    acValue: 7, blueBall: 1 + (index % 16), blueIsOdd: true, blueSize: 'small', blueAmplitude: index === 0 ? null : 3 }));
  return { definitionVersion: 'basic-analysis-v1', requestedWindow: window, requestedAsOfIssue: null, sampleDrawCount: 150, availableDrawCount: 150,
    availableFirstIssue: '2026001', availableLastIssue: '2026150', firstIssue: '2026001', lastIssue: '2026150', generatedAt: '2026-10-31T12:00:00.000+08:00',
    dataFingerprint: 'd'.repeat(64), warnings: ['验收桩：样本仅用于逻辑检查'],
    redNumbers: Array.from({ length: 33 }, (_, index) => stat(index + 1, 6 / 33, index === 0 ? 0 : 20 + index)),
    blueNumbers: Array.from({ length: 16 }, (_, index) => stat(index + 1, 1 / 16, 9 + index)), features, featureDistributions: {} };
}
function fakeCanvasContext(calls) {
  const store = { font: '12px sans-serif', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, lineCap: 'butt', lineJoin: 'miter',
    textAlign: 'start', textBaseline: 'alphabetic', shadowBlur: 0, shadowColor: '', shadowOffsetX: 0, shadowOffsetY: 0, lineDashOffset: 0, miterLimit: 10,
    globalCompositeOperation: 'source-over', measureText: text => ({ width: String(text).length * 6 }),
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => null };
  return new Proxy(store, {
    get(target, key) {
      if (key in target || typeof key === 'symbol') return target[key];
      return () => { calls.set(key, (calls.get(key) || 0) + 1); };
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

async function verifyResearchPages(validation, requestTotal, setTransport) {
  const ok = data => options => options.success({ statusCode: 200, header: {}, data: { data } });
  const report = analysisFixture();
  const parsed = validation.validateAnalysis(report);
  check(parsed.features.length === 150 && !('featureDistributions' in parsed) && !('redZoneCounts' in parsed.features[0]), '统计报告只保留页面字段');
  assert.throws(() => validation.validateAnalysis({ ...report, sampleDrawCount: 151 })); checks++;
  assert.throws(() => validation.validateAnalysis({ ...report, redNumbers: report.redNumbers.slice(1) })); checks++;
  assert.throws(() => validation.validateAnalysis({ ...report, features: [...report.features].reverse() })); checks++;

  setTransport(ok(report));
  const client = require(path.join(output, 'services/api.js'));
  let before = requestTotal();
  await client.api.getAnalysis('100'); await client.api.getAnalysis('100');
  check(requestTotal() - before === 1, '同窗口分析请求复用');
  await client.api.getAnalysis('100', true);
  check(requestTotal() - before === 2, '刷新强制重取');
  setTransport(options => options.fail({ errMsg: 'offline' }));
  await rejected(client.api.getAnalysis('300'), 'NETWORK');
  setTransport(ok(analysisFixture(300)));
  before = requestTotal();
  await client.api.getAnalysis('300');
  check(requestTotal() - before === 1, '失败结果不缓存');

  setTransport(ok(report));
  const analysis = instantiatePage('analysis');
  await analysis.load(true);
  check(analysis.data.rows.length === 33 && analysis.data.coverage.includes('150期') && analysis.data.warnings.length === 1, '分析页红球33格与覆盖说明');
  check(analysis.data.rows[0].omission === '≥150' && analysis.data.rows[0].averageOmission === '—' && analysis.data.rows[0].heatText === '冷', '遗漏下界与无完整遗漏为—');
  analysis.selectNumber(tap({ number: 1 }));
  check(analysis.data.selected.title === '红球 01' && analysis.data.selected.lowerBound && analysis.data.selected.averageComplete === '—', '号码详情');
  analysis.chooseColor(tap({ color: 'blue' }));
  check(analysis.data.rows.length === 16 && analysis.data.selected === null, '切换蓝球16格');
  analysis.setData({ window: '30' });
  await analysis.load(false);
  check(analysis.data.rows.length === 16 && analysis.data.shownWindowText === '近100期' && !!analysis.data.error, '窗口不一致时拒收并保留旧窗口数据');

  const distribution = value => ({ mean: value, median: value, minimum: value, maximum: value, standardDeviation: 0, outcomeInterval95: [value, value], monteCarloMeanInterval95: null });
  const succeeded = { id: 2, strategyName: 'M0_uniform_random', strategyVersion: '1.0.0', seed: '1', ticketsPerIssue: 5, evaluationStartIssue: '2026001',
    evaluationEndIssue: '2026010', usesFinalHoldout: false, status: 'succeeded', startedAt: '2026-10-31T09:00:00.000Z', finishedAt: '2026-10-31T09:01:00.000Z',
    summary: { definitionVersion: 'fixture', dataFingerprint: 'e'.repeat(64), formalRoiAvailable: false,
      coverage: { trainingFirstIssue: '2013001', evaluationFirstIssue: '2026001', evaluationLastIssue: '2026010', evaluatedIssues: 10 },
      payoutAudit: { eligibleIssues: 9, withheldIssues: [{ issue: '2026003', reasons: ['验收桩'] }] },
      distributions: { averageRedHits: distribution(1.09), blueHitRate: distribution(0.0625), redLogLoss: distribution(0.47) },
      calibration: { theoreticalAverageRedHits: 36 / 33, theoreticalBlueHitRate: 0.0625, firstRunRedTailP: null, firstRunBlueTailP: null } } };
  const failed = { ...succeeded, id: 1, status: 'failed', summary: null, finishedAt: null };
  assert.throws(() => validation.validateBacktest({ ...succeeded, summary: { ...succeeded.summary, formalRoiAvailable: true } })); checks++;
  assert.throws(() => validation.validateBacktest({ ...succeeded, summary: null })); checks++;
  const legacy = { ...succeeded, id: 3, summary: { ...succeeded.summary, distributions: { averageRedHits: { mean: 1.09, standardDeviation: 0, outcomeInterval95: [1, 1.2], monteCarloMeanInterval95: null } } } };
  const legacyDetail = require(path.join(output, 'research/utils/backtest.js')).runDetail(validation.validateBacktest(legacy));
  check(legacyDetail.hitRows[0].range === '未提供' && legacyDetail.hitRows[0].mean === '1.0900', '早期汇总缺中位数/极值时显示未提供');
  setTransport(options => options.success({ statusCode: 200, header: {}, data: { data: [succeeded, failed], pagination: { limit: 20, nextBeforeId: 1 } } }));
  const backtests = instantiatePage('research/pages/backtests');
  backtests.runs = new Map();
  await backtests.refresh();
  const selected = backtests.data.selected;
  check(backtests.data.items.length === 2 && !backtests.data.hasMore && selected.id === 2 && selected.hasSummary, '回测默认选中最新且不误判更多页');
  check(selected.hitRows[0].mean === '1.0900' && selected.hitRows[0].meanInterval === '未提供' && selected.scoreRows[2].mean === '未提供' && selected.withheldIssues === '1', '回测指标缺失显示未提供');
  backtests.selectRun(tap({ id: 1 }));
  check(backtests.data.selected.id === 1 && !backtests.data.selected.hasSummary && backtests.data.selected.statusText === '失败', '失败运行不画指标');

  const checkResult = { ticket: { redBalls: [1, 2, 3, 4, 5, 6], blueBall: 5 }, features: { redSum: 21, redSpan: 5, redOddCount: 3, redEvenCount: 3,
    redSmallCount: 6, redLargeCount: 0, redZoneCounts: [6, 0, 0], consecutiveGroupCount: 1, consecutivePairCount: 5, repeatedRedCount: null,
    redTailCounts: [0, 1, 1, 1, 1, 1, 1, 0, 0, 0], acValue: 0, blueBall: 5, blueIsOdd: true, blueSize: 'small', blueAmplitude: null },
    theoretical: { jackpotProbability: 1 / 17721088, jackpotOdds: '1/17721088', totalSingleTickets: 17721088 }, disclaimers: ['验收桩声明'] };
  assert.throws(() => validation.validateTicketCheck({ ...checkResult, theoretical: { ...checkResult.theoretical, totalSingleTickets: 1 } }, checkResult.ticket)); checks++;
  const ticketPage = instantiatePage('research/pages/ticket-check');
  for (const number of [6, 1, 2, 3, 4, 5, 7]) ticketPage.toggleRed(tap({ number }));
  check(ticketPage.data.reds.join() === '1,2,3,4,5,6' && !ticketPage.data.ready, '红球最多6个且未选蓝不可提交');
  ticketPage.toggleBlue(tap({ number: 5 }));
  let captured;
  setTransport(options => { captured = options; ok(checkResult)(options); });
  await ticketPage.check();
  check(captured.method === 'POST' && captured.url.endsWith('/api/tickets/check') && !captured.header.Authorization
    && captured.header['Content-Type'] === 'application/json' && Object.keys(captured.data).join() === 'redBalls,blueBall', '体检只POST单注两个字段');
  check(ticketPage.data.result.rows[0].value === '21' && ticketPage.data.result.odds === '1 / 17,721,088', '结构结果与理论概率');
  ticketPage.toggleRed(tap({ number: 6 }));
  check(ticketPage.data.result === null && !ticketPage.data.ready, '编辑后旧结果失效');
  ticketPage.toggleRed(tap({ number: 6 }));
  let respond;
  setTransport(options => { respond = options.success; });
  const pendingCheck = ticketPage.check();
  ticketPage.toggleBlue(tap({ number: 5 }));
  respond({ statusCode: 200, header: {}, data: { data: checkResult } });
  await pendingCheck;
  check(ticketPage.data.result === null && !ticketPage.data.submitting, '在途结果不覆盖新选择');
  ticketPage.toggleBlue(tap({ number: 6 }));
  setTransport(ok(checkResult));
  await ticketPage.check();
  check(ticketPage.data.result === null && !!ticketPage.data.error && ticketPage.data.reds.length === 6, '响应号码不一致则拒收并保留选择');

  setTransport(ok(report));
  const trend = instantiatePage('charts/pages/trend');
  trend.features = [];
  await trend.load(true);
  check(trend.data.points.length === 100 && trend.data.points[0].issue === '2026051' && trend.data.canOlder && !trend.data.canNewer, '走势默认最近100点');
  trend.older();
  check(trend.data.points[0].issue === '2026001' && trend.data.points.length === 100 && !trend.data.canOlder && trend.data.canNewer, '较早分页不越界');
  trend.chooseMetric(tap({ key: 'repeatedRedCount' }));
  check(trend.data.points[0].value === null && trend.data.summary.includes('断点1个'), 'null断线不补零');
  trend.newer();
  check(trend.data.points[trend.data.points.length - 1].issue === '2026150' && trend.data.summary.includes('断点1个'), '较新分页');

  const calls = new Map();
  const node = { width: 0, height: 0, getContext: type => type === '2d' ? context : null };
  const context = fakeCanvasContext(calls);
  const chartPoints = trend.data.points.map(point => ({ issue: point.issue, value: point.value }));
  const { instance: chart, definition } = instantiateComponent('charts/components/line-chart', { points: chartPoints, color: '#C93648', seriesName: '重号' }, { node, width: 320, height: 240 });
  definition.lifetimes.ready.call(chart);
  check(node.width === 640 && node.height === 480 && !chart.data.failed, 'Canvas按像素比初始化');
  await sleep(80);
  check((calls.get('lineTo') || 0) > 50 && (calls.get('stroke') || 0) > 0 && (calls.get('fillText') || 0) > 0, 'ECharts在Canvas 2D桩上绘制折线与坐标');
  chart.touchStart({ touches: [{ x: 160, y: 120 }] });
  chart.touchEnd({ changedTouches: [{ x: 160, y: 120 }] });
  chart.render();
  await sleep(40);
  definition.lifetimes.detached.call(chart);
  const afterDispose = calls.get('lineTo');
  await sleep(60);
  check(calls.get('lineTo') === afterDispose, '组件卸载后停止绘制');
  const { instance: broken, definition: brokenDefinition } = instantiateComponent('charts/components/line-chart', { points: chartPoints }, { width: 0, height: 0 });
  brokenDefinition.lifetimes.ready.call(broken);
  check(broken.data.failed, '无Canvas节点时提示查看数据表');
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { instantiatePage };