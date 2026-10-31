/**
 * 真实库只读验收：在本机临时端口访问真实HTTP处理链，不伪造下一期数据、不请求外网。
 * 所有GET前后比较数据快照；管理员同步依赖故意禁用，避免验收触发生产采集。
 */
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApiApp } from '../src/api/createApp';
import { closeDatabase, getDatabase } from '../src/db/connection';
import { loadSalesSuspensionPeriods } from '../src/calendar/salesSuspensionConfig';
import { findLatestDraw } from '../src/db/drawRepository';
import { listRecommendations } from '../src/db/recommendationRepository';
import { assertRecommendationContentHash } from '../src/recommend/recommendationHash';

async function main(): Promise<void> {
  const database = getDatabase();
  const latest = findLatestDraw(database);
  assert.ok(latest, '真实库需已有历史开奖');
  const snapshot = (): string => JSON.stringify({
    draws: database.prepare('SELECT * FROM draws ORDER BY issue').all(),
    recommendations: database.prepare('SELECT * FROM recommendations ORDER BY id').all(),
    verifications: database.prepare('SELECT * FROM recommendation_verifications ORDER BY id').all(),
    backtests: database.prepare('SELECT * FROM backtest_runs ORDER BY id').all(),
    holdout: database.prepare('SELECT * FROM backtest_holdout_policy ORDER BY id').all(),
  });
  const before = snapshot();
  const app = createApiApp({ database, adminApiKey: null, now: () => new Date(),
    loadSuspensionPeriods: () => loadSalesSuspensionPeriods(),
    synchronize: async () => { throw new Error('只读验收禁止外网同步'); } });
  let checks = 0;
  for (const url of ['/health', '/api/draws?limit=5', '/api/draws/latest', `/api/draws/${latest.issue}`,
    '/api/statistics?window=30', '/api/features?window=100', '/api/recommendations/next',
    '/api/recommendations?limit=5', '/api/backtests?limit=5']) {
    const response = await request(app).get(url).expect(200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(response.headers['x-content-type-options']);
    assert.equal(response.headers['x-powered-by'], undefined);
    assert.ok(response.body.data); checks++;
  }
  const recommendations = listRecommendations(database);
  for (const recommendation of recommendations.slice(0, 5)) {
    assertRecommendationContentHash(recommendation);
    await request(app).get(`/api/recommendations/${recommendation.id}`).expect(200);
    await request(app).get(`/api/recommendations/${recommendation.id}/verification`).expect(200);
    checks += 2;
  }
  const ticket = await request(app).post('/api/tickets/check').send({ redBalls: [1, 2, 3, 4, 5, 6], blueBall: 1 }).expect(200);
  assert.equal(ticket.body.data.theoretical.jackpotProbability, 1 / 17_721_088); checks++;
  for (const url of ['/api/draws?limit=101', '/api/draws?limit=1&limit=2', '/api/statistics?window=999', '/api/recommendations/0']) {
    await request(app).get(url).expect(400); checks++;
  }
  await request(app).post('/api/admin/sync').send({}).expect(503); checks++;
  assert.equal(snapshot(), before, 'HTTP只读验收不能改写开奖、推荐、核验、回测或前瞻政策');
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  console.log(JSON.stringify({ passed: true, httpChecks: checks, latestIssue: latest.issue,
    recommendationCount: recommendations.length, databaseUnchanged: true,
    schemaVersion: database.pragma('user_version', { simple: true }),
    actualFutureDrawVerified: false, note: '真实下一期开奖尚未发生；完整自动生命周期仅在内存模拟验证，正式前瞻评估不解锁' }, null, 2));
}

main().catch(error => { console.error(`API验收失败：${(error as Error).message}`); process.exitCode = 1; }).finally(closeDatabase);