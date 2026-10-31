/** 仅内存库与 supertest，不读配置/正式库、不抓取网络数据，也不读写回测报告。 */
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../db/connection';
import type { DrawRecord } from '../domain/lottery';
import type { RecommendationRecord } from '../recommend/recommendationTypes';
import { applyPendingMigrations } from '../db/migrations';
import { insertDraw, updateDrawPrizeDetail } from '../db/drawRepository';
import { insertRecommendation, listRecommendations } from '../db/recommendationRepository';
import { computeRecommendationContentHash } from '../recommend/recommendationHash';
import { generateNextRecommendation } from '../recommend/recommendationService';
import { getBasicAnalysis } from '../analysis/basicAnalysisService';
import { calculateDrawFeatures } from '../analysis/drawFeatures';
import { createResearchRandom } from '../analysis/researchRandom';
import { predictUniformRandom } from '../models/uniformRandomModel';
import { createApiApp } from './createApp';
import type { ApiDependencies } from './createApp';

const databases: SqliteDatabase[] = [];
// HTTP 请求头不能直接含中文字符；测试密钥使用可传输的 ASCII，不改变服务器的密钥策略。
const adminKey = 'memory-fixture-fixed-key-test-only';
const initialNow = '2026-10-31T12:00:00+08:00';
const secretMarker = 'PRIVATE_SECRET_D:\\private\\database.sqlite';

function makeDraw(issue = '2026124', drawDate = '2026-10-29'): DrawRecord {
  return {
    issue, drawDate, redBalls: [1, 2, 3, 4, 5, 6], blueBall: 7,
    salesAmountYuan: 100, prizePoolAmountYuan: 200, prizeGrades: [], isPrizeDetailComplete: false,
    firstPrizeRegionText: `<script>${secretMarker}</script>`, dataSource: secretMarker,
    rawRecordJson: JSON.stringify({ code: issue, content: `<script>${secretMarker}</script>`, secret: adminKey }),
  };
}

function fixture(options: Partial<ApiDependencies> = {}, withDraws = true) {
  const database = new Database(':memory:');
  databases.push(database);
  database.pragma('foreign_keys = ON');
  applyPendingMigrations(database);
  if (withDraws) {
    insertDraw(database, makeDraw('2026123', '2026-10-27'), secretMarker);
    insertDraw(database, makeDraw(), secretMarker);
  }
  database.prepare(`INSERT INTO backtest_holdout_policy VALUES (1, 'fixture-v1', '2026125', ?, '不能自动解锁')`)
    .run(initialNow);
  const synchronize = vi.fn(async () => ({ secret: secretMarker, apiKey: adminKey, stack: 'PRIVATE_STACK' }));
  const dependencies: ApiDependencies = {
    database, adminApiKey: adminKey, now: () => new Date(initialNow), loadSuspensionPeriods: () => [], synchronize,
    rateLimit: { windowMs: 60_000, publicMax: 10_000, adminMax: 10_000 }, ...options,
  };
  return { database, dependencies, synchronize, app: createApiApp(dependencies) };
}

function databaseSnapshot(database: SqliteDatabase) {
  const tables = ['draws', 'recommendations', 'recommendation_verifications', 'backtest_runs',
    'backtest_holdout_policy', 'fetch_logs', 'sqlite_sequence'];
  const contents = Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { hash: createHash('sha256').update(JSON.stringify(contents)).digest('hex'),
    changes: database.prepare('SELECT total_changes() AS changes').get() };
}

function expectSafeError(body: unknown, code: string) {
  expect(body).toEqual({ error: { code, message: expect.any(String) } });
  const serialized = JSON.stringify(body);
  for (const privateText of [secretMarker, 'PRIVATE_STACK', 'SQLITE', 'database.sqlite', adminKey]) {
    expect(serialized).not.toContain(privateText);
  }
}

function authorizedPost(app: ReturnType<typeof createApiApp>, path: string) {
  return request(app).post(path).set('Authorization', `Bearer ${adminKey}`).send({});
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) if (database.open) database.close();
});

describe('公共查询与路由顺序', () => {
  it('健康检查只 SELECT 本地数据库，安全响应和 helmet/no-cache，不泄漏连接信息', async () => {
    const { app, database, synchronize } = fixture();
    const before = databaseSnapshot(database);
    const result = await request(app).get('/health').set('Origin', 'https://untrusted.example').expect(200);
    expect(result.body).toEqual({ data: { status: 'ok', database: 'ok' } });
    expect(result.headers['x-powered-by']).toBeUndefined();
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.headers['content-security-policy']).toBeDefined();
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers.etag).toBeUndefined();
    expect(app.get('trust proxy')).toBe(false);
    expect(databaseSnapshot(database)).toEqual(before);
    expect(synchronize).not.toHaveBeenCalled();
  });

  it('draws 默认20、严格排除 beforeIssue、倒序、latest 不被 :issue 截获，白名单排除原文', async () => {
    const { app } = fixture();
    const draws = await request(app).get('/api/draws').expect(200);
    expect(draws.body.data.map((draw: { issue: string }) => draw.issue)).toEqual(['2026124', '2026123']);
    expect(draws.body.pagination).toEqual({ limit: 20, beforeIssue: null, nextBeforeIssue: '2026123' });
    const page = await request(app).get('/api/draws?limit=1&beforeIssue=2026124').expect(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.data[0].issue).toBe('2026123');
    const latest = await request(app).get('/api/draws/latest').expect(200);
    const byIssue = await request(app).get('/api/draws/2026124').expect(200);
    expect(latest.body).toEqual(byIssue.body);
    expect(Object.keys(latest.body.data).sort()).toEqual(['issue', 'drawDate', 'redBalls', 'blueBall',
      'salesAmountYuan', 'prizePoolAmountYuan', 'prizeGrades', 'isPrizeDetailComplete'].sort());
    expect(JSON.stringify(draws.body)).not.toContain(secretMarker);
    expect(JSON.stringify(draws.body)).not.toContain(adminKey);
    expect(JSON.stringify(draws.body)).not.toContain('script');
    await request(app).get('/api/draws?beforeIssue=2026123').expect(200, { data: [],
      pagination: { limit: 20, beforeIssue: '2026123', nextBeforeIssue: null } });
    await request(app).get('/api/draws?limit=100').expect(200);
  });

  it.each(['all', '30', '100', '300'])('statistics/features 复用 getBasicAnalysis，窗口 %s 与走势图升序', async window => {
    const { app, database } = fixture();
    const expected = getBasicAnalysis(database, { window: window === 'all' ? null : Number(window), asOfIssue: '2026124' });
    const result = await request(app).get(`/api/statistics?window=${window}&asOfIssue=2026124`).expect(200);
    const features = await request(app).get(`/api/features?window=${window}&asOfIssue=2026124`).expect(200);
    expect(result.body.data).toEqual(expected);
    expect(features.body).toEqual(result.body);
    expect(features.body.data.features.map((feature: { issue: string }) => feature.issue)).toEqual(['2026123', '2026124']);
  });

  it('asOf 包含式，不存在的截止期接受但报告明确 requested/actual 与警告，空区间不造数据', async () => {
    const { app } = fixture();
    const inclusive = await request(app).get('/api/statistics?asOfIssue=2026123').expect(200);
    expect(inclusive.body.data.sampleDrawCount).toBe(1);
    expect(inclusive.body.data.lastIssue).toBe('2026123');
    const absent = await request(app).get('/api/features?asOfIssue=2026125').expect(200);
    expect(absent.body.data.requestedAsOfIssue).toBe('2026125');
    expect(absent.body.data.availableLastIssue).toBe('2026124');
    expect(absent.body.data.warnings.join()).toContain('未入库');
    const empty = await request(app).get('/api/features?asOfIssue=2003001').expect(200);
    expect(empty.body.data.sampleDrawCount).toBe(0);
    expect(empty.body.data.lastIssue).toBeNull();
  });

  it('空库存活但 latest/不存在资源 404；next 不生成且 null 目标', async () => {
    const { app, database } = fixture({}, false);
    const before = databaseSnapshot(database);
    await request(app).get('/health').expect(200);
    for (const path of ['/api/draws/latest', '/api/draws/2026124', '/api/recommendations/1',
      '/api/recommendations/1/verification', '/missing', '/API/draws', '/api/draws/']) {
      const response = await request(app).get(path).expect(404);
      expectSafeError(response.body, 'NOT_FOUND');
    }
    const next = await request(app).get('/api/recommendations/next').expect(200);
    expect(next.body.data).toMatchObject({ status: 'not_generated', reason: 'no_draws', nextDraw: null, recommendation: null });
    expect(databaseSnapshot(database)).toEqual(before);
  });

  it('回测只读已存汇总，不读假路径、不暴露错误/内部字段，不解锁 holdout', async () => {
    const { app, database } = fixture();
    const insert = database.prepare(`INSERT INTO backtest_runs
      (strategy_name,strategy_version,strategy_params_json,random_seed,tickets_per_issue,
       evaluation_start_issue,evaluation_end_issue,uses_final_holdout,run_status,metrics_summary_json,
       detail_file_path,error_message,started_at,finished_at) VALUES ('M0_uniform_random','1.0.0',?, '123',5,
       '2026001','2026124',1,?,?,?, ?,?,?)`);
    const savedSummary = { definitionVersion: 'saved-v1', dataFingerprint: 'saved-hash',
      coverage: { evaluatedIssues: 100 }, distributions: { averageRedHits: { mean: 1.09 } },
      repetitions: [{ secret: secretMarker }], detailFilePath: secretMarker };
    insert.run(JSON.stringify({ apiKey: adminKey }), 'succeeded', JSON.stringify(savedSummary), secretMarker, null, initialNow, initialNow);
    insert.run('{}', 'failed', null, secretMarker, `SQLITE_ERROR ${secretMarker}`, initialNow, initialNow);
    const before = databaseSnapshot(database);
    const result = await request(app).get('/api/backtests?limit=1').expect(200);
    expect(result.body.data[0]).toMatchObject({ id: 2, status: 'failed', summary: null, usesFinalHoldout: true });
    const previous = await request(app).get('/api/backtests?beforeId=2').expect(200);
    expect(previous.body.data[0].summary).toMatchObject({ definitionVersion: 'saved-v1', dataFingerprint: 'saved-hash',
      distributions: savedSummary.distributions, formalRoiAvailable: false });
    for (const data of [result.body, previous.body]) {
      expect(JSON.stringify(data)).not.toContain(secretMarker);
      expect(JSON.stringify(data)).not.toContain(adminKey);
      expect(JSON.stringify(data)).not.toContain('repetitions');
    }
    expect(databaseSnapshot(database)).toEqual(before);
  });
});

describe('严格 query/path 输入', () => {
  it.each([
    '/health?debug=true', '/api/draws?limit=0', '/api/draws?limit=101', '/api/draws?limit=01',
    '/api/draws?limit=1.0', '/api/draws?limit=1e2', '/api/draws?limit=-1', '/api/draws?limit=+1',
    '/api/draws?limit=', '/api/draws?limit=1&limit=2', '/api/draws?%6cimit=1&limit=2',
    '/api/draws?limit[]=1', '/api/draws?__proto__[key]=1', '/api/draws?beforeIssue=2026000',
    '/api/draws?beforeIssue=2026124&beforeIssue=2026123', '/api/draws/latest?limit=1',
    '/api/draws/2026124?debug=true', '/api/draws/202612', '/api/draws/2026000', '/api/draws/1999001',
    '/api/draws/2026124%27', '/api/draws/%ZZ', '/api/statistics?window=20', '/api/features?window=ALL',
    '/api/statistics?window=30&window=100', '/api/features?asOfIssue=2026000', '/api/features?date=2026-10-31',
    '/api/recommendations?beforeId=9007199254740992', '/api/recommendations?beforeId=01',
    '/api/recommendations?limit=101', '/api/recommendations?seed=123', '/api/recommendations/next?now=2020',
    '/api/recommendations/0', '/api/recommendations/1.5', '/api/recommendations/1e2',
    '/api/recommendations/9007199254740992/verification', '/api/recommendations/1/verification?verify=true',
    '/api/backtests?beforeId=2&beforeId=3', '/api/backtests?unlock=true', '/api/backtests?limit=1000000',
  ])('拒绝非法或多余参数：%s', async path => {
    const { app, database } = fixture();
    const before = databaseSnapshot(database);
    const response = await request(app).get(path).expect(400);
    expectSafeError(response.body, 'INVALID_INPUT');
    expect(databaseSnapshot(database)).toEqual(before);
  });
});

describe('单注检查与 JSON 边界', () => {
  it('合法无序单注排序并复用 calculateDrawFeatures；理论概率固定，结构不能宣称优越', async () => {
    const { app, database } = fixture();
    const before = databaseSnapshot(database);
    const ticket = { redBalls: [6, 1, 5, 2, 4, 3], blueBall: 7 };
    const response = await request(app).post('/api/tickets/check').send(ticket).expect(200);
    expect(response.body.data.ticket).toEqual({ redBalls: [1, 2, 3, 4, 5, 6], blueBall: 7 });
    const { issue: _issue, drawDate: _date, ...features } = calculateDrawFeatures({ ...ticket,
      issue: '2003001', drawDate: '2003-02-23' }, null);
    expect(response.body.data.features).toEqual(features);
    expect(response.body.data.features).toMatchObject({ redSum: 21, acValue: 0, consecutivePairCount: 5,
      repeatedRedCount: null, blueAmplitude: null });
    expect(response.body.data.features.issue).toBeUndefined();
    expect(response.body.data.theoretical).toEqual({ jackpotProbability: 1 / 17_721_088,
      jackpotOdds: '1/17721088', totalSingleTickets: 17_721_088 });
    expect(response.body.data.disclaimers.join()).toContain('不代表单注优越性');
    expect(databaseSnapshot(database)).toEqual(before);
  });

  it.each([
    {}, { redBalls: [1, 2, 3, 4, 5, 6] }, { redBalls: [1, 2, 3, 4, 5], blueBall: 7 },
    { redBalls: [1, 1, 2, 3, 4, 5], blueBall: 7 }, { redBalls: [0, 2, 3, 4, 5, 6], blueBall: 7 },
    { redBalls: [1, 2, 3, 4, 5, 34], blueBall: 7 }, { redBalls: ['1', 2, 3, 4, 5, 6], blueBall: 7 },
    { redBalls: [1, 2, 3, 4, 5, 6], blueBall: '7' }, { redBalls: [1, 2, 3, 4, 5, 6], blueBall: 17 },
    { redBalls: [1, 2, 3, 4, 5, 6], blueBall: 0 }, { redBalls: [1, 2, 3, 4, 5, 6.1], blueBall: 7 },
    { redBalls: null, blueBall: 7 }, { redBalls: {}, blueBall: 7 },
    { redBalls: [1, 2, 3, 4, 5, 6], blueBall: 7, seed: 123 },
  ])('非法票或额外字段拒绝：%j', async body => {
    const { app } = fixture();
    const response = await request(app).post('/api/tickets/check').send(body).expect(400);
    expectSafeError(response.body, 'INVALID_INPUT');
  });

  it.each(['{', 'null', '42', '"text"', '[]', ' '.repeat(8192) + '{}'])('非对象/损坏/超限 JSON 安全报错', async body => {
    const { app } = fixture();
    const response = await request(app).post('/api/tickets/check').set('Content-Type', 'application/json').send(body).expect(400);
    expectSafeError(response.body, body === '[]' ? 'INVALID_INPUT' : 'INVALID_JSON');
  });

  it('POST 仅 application/json、拒绝空体/压缩/多余 query，合法 charset 与 8KB 内空白可接受', async () => {
    const { app } = fixture();
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/other+json']) {
      const response = await request(app).post('/api/tickets/check').set('Content-Type', contentType).send('{}').expect(400);
      expectSafeError(response.body, 'INVALID_JSON');
    }
    const absent = await request(app).post('/api/tickets/check').set('Content-Type', 'application/json').expect(400);
    expectSafeError(absent.body, 'INVALID_JSON');
    const compressed = await request(app).post('/api/tickets/check').set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip').send('{}').expect(400);
    expectSafeError(compressed.body, 'INVALID_JSON');
    const ticket = { redBalls: [1, 2, 3, 4, 5, 6], blueBall: 7 };
    await request(app).post('/api/tickets/check').set('Content-Type', 'application/json; charset=utf-8')
      .send(' '.repeat(8000) + JSON.stringify(ticket)).expect(200);
    const unknownQuery = await request(app).post('/api/tickets/check?key=unused').send(ticket).expect(400);
    expectSafeError(unknownQuery.body, 'INVALID_INPUT');
  });
});

describe('管理身份认证与固定参数', () => {
  const paths = ['/api/admin/sync', '/api/admin/recommendations/generate', '/api/admin/recommendations/verify'];
  it.each(paths)('%s 只接受固定 Bearer，不能 query/body 密钥绕过', async path => {
    const { app, database, synchronize } = fixture();
    const before = databaseSnapshot(database);
    for (const authorization of ['', 'Basic test', 'Bearer wrong', 'Bearer', `Bearer ${adminKey} extra`]) {
      const response = await request(app).post(path).set('Authorization', authorization).send({}).expect(401);
      expectSafeError(response.body, 'UNAUTHORIZED');
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const queryKey = await request(app).post(`${path}?key=${encodeURIComponent(adminKey)}`).send({}).expect(401);
    const bodyKey = await request(app).post(path).send({ key: adminKey }).expect(401);
    expectSafeError(queryKey.body, 'UNAUTHORIZED');
    expectSafeError(bodyKey.body, 'UNAUTHORIZED');
    expect(databaseSnapshot(database)).toEqual(before);
    expect(synchronize).not.toHaveBeenCalled();
  });

  it.each(paths)('%s 未配密钥一律 503，包括提供任意 Bearer', async path => {
    const { app, synchronize } = fixture({ adminApiKey: null });
    const result = await authorizedPost(app, path).expect(503);
    expectSafeError(result.body, 'ADMIN_DISABLED');
    expect(synchronize).not.toHaveBeenCalled();
    await request(app).get('/health').expect(200);
  });

  it.each(['seed', 'now', 'time', 'tickets', 'ticketsPerIssue', 'key', 'strategy', '__proto__'])('%s 不得通过管理 body/query 指定', async parameter => {
    const { app, database, synchronize } = fixture();
    const before = databaseSnapshot(database);
    for (const path of paths) {
      const extraBody = await request(app).post(path).set('Authorization', `Bearer ${adminKey}`)
        .send(JSON.stringify({ [parameter]: '123' })).set('Content-Type', 'application/json').expect(400);
      expectSafeError(extraBody.body, 'INVALID_INPUT');
      const extraQuery = await authorizedPost(app, `${path}?${parameter}=123`).expect(400);
      expectSafeError(extraQuery.body, 'INVALID_INPUT');
    }
    expect(databaseSnapshot(database)).toEqual(before);
    expect(synchronize).not.toHaveBeenCalled();
  });

  it('认证成功的 sync 仅调用注入 callback，不透传 unknown 返回值，不额外生成/核验', async () => {
    const { app, synchronize, database } = fixture({ adminApiKey: 'x' });
    const before = databaseSnapshot(database);
    const result = await request(app).post('/api/admin/sync').set('Authorization', 'bearer x').send({}).expect(200);
    expect(result.body).toEqual({ data: { synchronized: true } });
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(databaseSnapshot(database)).toEqual(before);
  });

  it('管理员同样受 JSON 限制，空数组/null/空体不能视为 {}；GET/未知管理路径不触发命令', async () => {
    const { app, synchronize } = fixture();
    for (const body of ['[]', 'null', ' '.repeat(8192) + '{}']) {
      await request(app).post('/api/admin/sync').set('Authorization', `Bearer ${adminKey}`)
        .set('Content-Type', 'application/json').send(body).expect(400);
    }
    await request(app).post('/api/admin/sync').set('Authorization', `Bearer ${adminKey}`)
      .set('Content-Type', 'application/json').expect(400);
    await request(app).get('/api/admin/sync').set('Authorization', `Bearer ${adminKey}`).expect(404);
    await authorizedPost(app, '/api/admin/unknown').expect(404);
    expect(synchronize).not.toHaveBeenCalled();
  });
});

describe('next 状态与完整推荐生命周期', () => {
  it.each([
    ['2026-10-29T21:15:00+08:00', 'awaiting_draw', 'source_draw_not_finished'],
    ['2026-10-31T12:00:00+08:00', 'not_generated', null],
    ['2026-11-01T19:59:59.999+08:00', 'not_generated', null],
    ['2026-11-01T20:00:00+08:00', 'closed', 'generation_cutoff_reached'],
    ['2026-11-01T21:14:59.999+08:00', 'closed', 'generation_cutoff_reached'],
    ['2026-11-01T21:15:00+08:00', 'awaiting_draw', 'target_draw_not_synchronized'],
    ['2026-11-05T12:00:00+08:00', 'awaiting_draw', 'target_draw_not_synchronized'],
  ])('服务器时间 %s → %s，GET 不写库/不跳过未同步开奖', async (timestamp, status, reason) => {
    const { app, database } = fixture({ now: () => new Date(timestamp) });
    const before = databaseSnapshot(database);
    const response = await request(app).get('/api/recommendations/next').expect(200);
    expect(response.body.data).toMatchObject({ status, reason, sourceLatestIssue: '2026124', recommendation: null,
      nextDraw: { issue: '2026125', drawDate: '2026-11-01', drawTimeBeijing: '21:15' },
      generationDeadline: '2026-11-01T20:00:00.000+08:00' });
    expect(response.body.data.disclaimers.join()).toContain('保守');
    expect(databaseSnapshot(database)).toEqual(before);
    if (status === 'closed' || status === 'awaiting_draw') {
      const generate = await authorizedPost(app, '/api/admin/recommendations/generate').expect(400);
      expectSafeError(generate.body, 'GENERATION_UNAVAILABLE');
      expect(databaseSnapshot(database)).toEqual(before);
    }
  });

  it('暂停日历改变日期不跳号；固化后日历变化安全拒绝而非重写', async () => {
    let periods: ReturnType<ApiDependencies['loadSuspensionPeriods']> = [{ startDate: '2026-11-01', endDate: '2026-11-03', reason: '测试休市' }];
    const { app, database } = fixture({ loadSuspensionPeriods: () => periods });
    const next = await request(app).get('/api/recommendations/next').expect(200);
    expect(next.body.data.nextDraw).toMatchObject({ issue: '2026125', drawDate: '2026-11-05' });
    const generate = await authorizedPost(app, '/api/admin/recommendations/generate').expect(200);
    expect(generate.body.data.targetDrawDate).toBe('2026-11-05');
    const before = databaseSnapshot(database);
    periods = [];
    expectSafeError((await request(app).get('/api/recommendations/next').expect(500)).body, 'INTERNAL_ERROR');
    expect(databaseSnapshot(database)).toEqual(before);
  });

  it('M0 POST 默认5注 crypto seed→所有 GET 不写库/改hash→模拟同步开奖号→POST 追加核验→补奖再追加版本', async () => {
    let now = new Date(initialNow);
    const { app, database, dependencies } = fixture({ now: () => now });
    const initial = databaseSnapshot(database);
    await request(app).get('/api/recommendations/next').expect(200);
    await request(app).get('/api/recommendations').expect(200);
    expect(databaseSnapshot(database)).toEqual(initial);
    const generated = await authorizedPost(app, '/api/admin/recommendations/generate').expect(200);
    const original = generated.body.data as RecommendationRecord;
    expect(original).toMatchObject({ id: 1, targetIssue: '2026125', strategyName: 'M0_uniform_random',
      generatedAt: now.toISOString(), sourceLatestIssue: '2026124' });
    expect(original.tickets).toHaveLength(5);
    expect(Number.isInteger(original.seed)).toBe(true);
    expect(original.seed).toBeGreaterThanOrEqual(0);
    expect(original.seed).toBeLessThanOrEqual(0xffffffff);
    expect(original.contentHash).toBe(computeRecommendationContentHash(original));
    expect(original.tickets).toEqual(predictUniformRandom({ targetIssue: original.targetIssue, history: [],
      ticketsPerIssue: 5, random: createResearchRandom(original.seed) }).tickets);
    const repeated = await authorizedPost(app, '/api/admin/recommendations/generate').expect(200);
    expect(repeated.body).toEqual(generated.body);
    const generatedSnapshot = databaseSnapshot(database);
    for (const path of ['/health', '/api/draws', '/api/draws/latest', '/api/draws/2026124', '/api/statistics',
      '/api/features', '/api/recommendations', '/api/recommendations/next', '/api/recommendations/1',
      '/api/recommendations/1/verification', '/api/backtests']) {
      const response = await request(app).get(path).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(databaseSnapshot(database)).toEqual(generatedSnapshot);
    }
    const available = await request(app).get('/api/recommendations/next').expect(200);
    expect(available.body.data.status).toBe('available');
    expect(available.body.data.recommendation).toEqual(original);
    const unopened = await request(app).get('/api/recommendations/1/verification').expect(200);
    expect(unopened.body.data).toMatchObject({ latest: null, versions: [] });
    now = new Date('2026-11-01T20:00:00+08:00');
    const closed = await request(app).get('/api/recommendations/next').expect(200);
    expect(closed.body.data.status).toBe('closed');
    expect(closed.body.data.recommendation).toEqual(original);
    await authorizedPost(app, '/api/admin/recommendations/generate').expect(400);
    expect(databaseSnapshot(database)).toEqual(generatedSnapshot);

    now = new Date('2026-11-01T21:15:00+08:00');
    const target: DrawRecord = { ...makeDraw(original.targetIssue, original.targetDrawDate!),
      redBalls: [...original.tickets[0].redBalls], blueBall: original.tickets[0].blueBall };
    dependencies.synchronize = vi.fn(async () => { insertDraw(database, target, now.toISOString()); return { secret: secretMarker }; });
    await authorizedPost(app, '/api/admin/sync').expect(200, { data: { synchronized: true } });
    const beforeVerify = databaseSnapshot(database);
    const notVerifiedByGet = await request(app).get('/api/recommendations/1/verification').expect(200);
    expect(notVerifiedByGet.body.data.versions).toEqual([]);
    const newNext = await request(app).get('/api/recommendations/next').expect(200);
    expect(newNext.body.data).toMatchObject({ status: 'awaiting_draw', reason: 'source_draw_not_finished',
      nextDraw: { issue: '2026126' }, recommendation: null });
    expect(listRecommendations(database)).toEqual([original]);
    expect(databaseSnapshot(database)).toEqual(beforeVerify);
    const verified = await authorizedPost(app, '/api/admin/recommendations/verify').expect(200);
    expect(verified.body.data.verifiedCount).toBe(1);
    expect(verified.body.data.verifications[0].result.outcomes[0]).toEqual({ redHits: 6, blueHit: true, grade: 1, prizeYuan: null });
    expect(verified.body.data.verifications[0].result.formalRoi).toBeNull();
    const firstRead = await request(app).get('/api/recommendations/1/verification').expect(200);
    expect(firstRead.body.data.versions).toHaveLength(1);
    expect(firstRead.body.data.latest).toEqual(verified.body.data.verifications[0]);
    const idempotent = await authorizedPost(app, '/api/admin/recommendations/verify').expect(200);
    expect(idempotent.body.data).toMatchObject({ verifiedCount: 0, unchangedCount: 1 });
    const completedTarget: DrawRecord = { ...target, isPrizeDetailComplete: true,
      rawRecordJson: JSON.stringify({ code: original.targetIssue }),
      prizeGrades: [5000000, 100000, 3000, 200, 10, 5].map((prizePerTicketYuan, index) => ({
        grade: index + 1, winningTicketCount: 1, prizePerTicketYuan,
      })) };
    now = new Date('2026-11-02T12:00:00+08:00');
    dependencies.synchronize = vi.fn(async () => updateDrawPrizeDetail(database, completedTarget, now.toISOString()));
    await authorizedPost(app, '/api/admin/sync').expect(200);
    const beforeSecondVerify = databaseSnapshot(database);
    expect((await request(app).get('/api/recommendations/1/verification').expect(200)).body.data.versions).toHaveLength(1);
    expect(databaseSnapshot(database)).toEqual(beforeSecondVerify);
    const second = await authorizedPost(app, '/api/admin/recommendations/verify').expect(200);
    expect(second.body.data.verifiedCount).toBe(1);
    expect(second.body.data.verifications[0].result.outcomes[0].prizeYuan).toBe(5000000);
    const finalRead = await request(app).get('/api/recommendations/1/verification').expect(200);
    expect(finalRead.body.data.versions).toHaveLength(2);
    expect(finalRead.body.data.versions[1]).toEqual(firstRead.body.data.versions[0]);
    expect(finalRead.body.data.recommendation).toEqual(original);
    expect(finalRead.body.data.latest.drawFingerprint).not.toBe(finalRead.body.data.versions[1].drawFingerprint);
    expect(listRecommendations(database)).toEqual([original]);
    expect(database.prepare('SELECT start_issue FROM backtest_holdout_policy').get()).toEqual({ start_issue: '2026125' });
    const finalSnapshot = databaseSnapshot(database);
    await request(app).get('/api/recommendations/1').expect(200);
    await request(app).get('/api/recommendations/1/verification').expect(200);
    expect(databaseSnapshot(database)).toEqual(finalSnapshot);
  });

  it('推荐 beforeId 严格排除，倒序与默认分页', async () => {
    let now = new Date(initialNow);
    const { app, database } = fixture({ now: () => now });
    await authorizedPost(app, '/api/admin/recommendations/generate').expect(200);
    insertDraw(database, makeDraw('2026125', '2026-11-01'), initialNow);
    now = new Date('2026-11-02T12:00:00+08:00');
    await authorizedPost(app, '/api/admin/recommendations/generate').expect(200);
    const list = await request(app).get('/api/recommendations').expect(200);
    expect(list.body.data.map((record: RecommendationRecord) => record.id)).toEqual([2, 1]);
    const page = await request(app).get('/api/recommendations?limit=1&beforeId=2').expect(200);
    expect(page.body.data[0].id).toBe(1);
    const empty = await request(app).get('/api/recommendations?beforeId=1').expect(200);
    expect(empty.body.data).toEqual([]);
  });
});

describe('错误脱敏与限流', () => {
  it.each([false, true])('sync 同步抛错或异步 rejection 都统一脱敏：async=%s', async asynchronous => {
    const failure = new Error(`SQLITE_ERROR ${secretMarker} ${adminKey}`);
    failure.stack = 'PRIVATE_STACK';
    const { app } = fixture({ synchronize: asynchronous ? async () => { throw failure; } : () => { throw failure; } });
    expectSafeError((await authorizedPost(app, '/api/admin/sync').expect(500)).body, 'INTERNAL_ERROR');
  });

  it('数据库关闭/分析失败/非法日历和时钟统一 JSON 500，不返回底层路径或 stack', async () => {
    const closed = fixture();
    closed.database.close();
    for (const path of ['/health', '/api/draws', '/api/statistics', '/api/recommendations/1']) {
      expectSafeError((await request(closed.app).get(path).expect(500)).body, 'INTERNAL_ERROR');
    }
    const invalidClock = fixture({ now: () => new Date('invalid') });
    expectSafeError((await request(invalidClock.app).get('/api/recommendations/next').expect(500)).body, 'INTERNAL_ERROR');
    const invalidCalendar = fixture({ loadSuspensionPeriods: () => [{ startDate: '2026-02-30', endDate: '2026-11-03', reason: secretMarker }] });
    expectSafeError((await request(invalidCalendar.app).get('/api/recommendations/next').expect(500)).body, 'INTERNAL_ERROR');
  });

  it('损坏 hash 在所有推荐 GET 统一拒绝，不偷偷重生成/核验；POST skip 不暴露内部原因', async () => {
    const source = fixture();
    const original = generateNextRecommendation(source.database, [], new Date(initialNow), { seed: 123 });
    const { app, database } = fixture();
    insertRecommendation(database, { ...original, contentHash: '0'.repeat(64) });
    const before = databaseSnapshot(database);
    for (const path of ['/api/recommendations', '/api/recommendations/next', '/api/recommendations/1',
      '/api/recommendations/1/verification']) {
      expectSafeError((await request(app).get(path).expect(500)).body, 'INTERNAL_ERROR');
    }
    expect(databaseSnapshot(database)).toEqual(before);
    const skip = await authorizedPost(app, '/api/admin/recommendations/verify').expect(200);
    expect(skip.body.data).toMatchObject({ skippedCount: 1, verifiedCount: 0,
      skipped: [{ recommendationId: 1, reason: '记录未通过核验条件，请由服务端检查' }] });
    expect(databaseSnapshot(database)).toEqual(before);
  });

  it('public 与 admin 各自限流，伪造 XFF/Forwarded 不得换身份绕过；默认 proxy=false', async () => {
    const { app, synchronize } = fixture({ rateLimit: { windowMs: 60_000, publicMax: 2, adminMax: 1 } });
    await request(app).get('/health').set('X-Forwarded-For', '1.1.1.1').expect(200);
    await request(app).get('/health').set('X-Forwarded-For', '2.2.2.2').expect(200);
    const publicBlocked = await request(app).get('/api/draws').set('X-Forwarded-For', '3.3.3.3')
      .set('Forwarded', 'for=4.4.4.4').expect(429);
    expectSafeError(publicBlocked.body, 'RATE_LIMITED');
    expect(publicBlocked.headers['retry-after']).toBeDefined();
    await authorizedPost(app, '/api/admin/sync').set('X-Forwarded-For', '5.5.5.5').expect(200);
    const adminBlocked = await authorizedPost(app, '/api/admin/sync').set('X-Forwarded-For', '6.6.6.6').expect(429);
    expectSafeError(adminBlocked.body, 'RATE_LIMITED');
    expect(adminBlocked.headers['cache-control']).toBe('no-store');
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(app.get('trust proxy')).toBe(false);
  });

  it('未认证管理请求也消耗管理额度，默认 public120/min、admin5/min', async () => {
    const { app, synchronize } = fixture({ rateLimit: undefined });
    for (let index = 0; index < 120; index++) await request(app).get('/health').expect(200);
    await request(app).get('/health').expect(429);
    for (let index = 0; index < 5; index++) await request(app).post('/api/admin/sync').send({}).expect(401);
    expectSafeError((await authorizedPost(app, '/api/admin/sync').expect(429)).body, 'RATE_LIMITED');
    expect(synchronize).not.toHaveBeenCalled();
  });
});