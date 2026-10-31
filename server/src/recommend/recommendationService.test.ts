/** 只用内存库与手造合法开奖，不加载config/CLI，不写正式库或回测报告。 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { DrawRecord } from '../domain/lottery';
import type { SqliteDatabase } from '../db/connection';
import { insertDraw, updateDrawPrizeDetail } from '../db/drawRepository';
import { applyPendingMigrations, SCHEMA_MIGRATIONS } from '../db/migrations';
import { insertRecommendation, listRecommendationVerifications, listRecommendations } from '../db/recommendationRepository';
import { createResearchRandom } from '../analysis/researchRandom';
import { predictUniformRandom } from '../models/uniformRandomModel';
import { assertRecommendationContentHash, canonicalJson, computeDrawFingerprint,
  computeRecommendationContentHash } from './recommendationHash';
import { generateNextRecommendation, getRecommendationVerification,
  verifyPendingRecommendations } from './recommendationService';
import { summarizeRecommendationPerformance } from './recommendationSummary';
import type { RecommendationOptions, RecommendationRecord } from './recommendationTypes';

const databases: SqliteDatabase[] = [];
const sourceIssue = '2026124';
const sourceDate = '2026-10-29';
const productionLikeNow = new Date('2026-10-31T12:00:00+08:00');
const afterTargetDraw = new Date('2026-11-01T21:15:00+08:00');

function makeDraw(issue = sourceIssue, drawDate = sourceDate): DrawRecord {
  return { issue, drawDate, redBalls: [1, 2, 3, 4, 5, 6], blueBall: 7,
    salesAmountYuan: null, prizePoolAmountYuan: null, firstPrizeRegionText: null,
    prizeGrades: [], isPrizeDetailComplete: false, dataSource: 'memory_fixture',
    rawRecordJson: JSON.stringify({ code: issue }) };
}

function memoryDatabase(withSource = true): SqliteDatabase {
  const database = new Database(':memory:');
  databases.push(database);
  database.pragma('foreign_keys = ON');
  applyPendingMigrations(database);
  if (withSource) insertDraw(database, makeDraw(), '2026-10-29T21:30:00+08:00');
  return database;
}

function generate(database: SqliteDatabase, seed = 123): RecommendationRecord {
  return generateNextRecommendation(database, [], productionLikeNow, { seed });
}

function matchingDraw(record: RecommendationRecord, complete = false): DrawRecord {
  const ticket = record.tickets[0];
  return { ...makeDraw(record.targetIssue, record.targetDrawDate!),
    redBalls: [...ticket.redBalls], blueBall: ticket.blueBall,
    isPrizeDetailComplete: complete,
    prizeGrades: complete ? [5000000, 100000, 3000, 200, 10, 5].map((prizePerTicketYuan, index) => ({
      grade: index + 1, winningTicketCount: 1, prizePerTicketYuan,
    })) : [] };
}

/** 构造独立“损坏行”库，禁止通过撤销触发器修改原推荐。 */
function databaseWithChangedRecord(
  original: RecommendationRecord, change: Partial<RecommendationRecord>, rehash = true,
): SqliteDatabase {
  const database = memoryDatabase();
  const changed = { ...original, ...change };
  if (rehash) changed.contentHash = computeRecommendationContentHash(changed);
  insertRecommendation(database, changed);
  return database;
}

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe('M0开奖前固化', () => {
  it('默认5注、源期号、下一期、保守20点截止和内容哈希均正确', () => {
    const database = memoryDatabase();
    const record = generate(database);
    expect(record).toMatchObject({ targetIssue: '2026125', targetDrawDate: '2026-11-01',
      generationDeadline: '2026-11-01T20:00:00.000+08:00', sourceLatestIssue: sourceIssue,
      strategyName: 'M0_uniform_random', strategyVersion: '1.0.0', seed: 123,
      generatedAt: productionLikeNow.toISOString() });
    expect(record.tickets).toHaveLength(5);
    expect(new Set(record.tickets.map(ticket => canonicalJson(ticket))).size).toBe(5);
    expect(record.contentHash).toBe(computeRecommendationContentHash(record));
    expect(() => assertRecommendationContentHash(record)).not.toThrow();
    expect(listRecommendations(database)).toEqual([record]);
    expect(getRecommendationVerification(database, record.id)).toEqual({ recommendation: record, latest: null, versions: [] });
  });

  it('默认crypto种子是UInt32且入库可复现', () => {
    const record = generateNextRecommendation(memoryDatabase(), [], productionLikeNow);
    expect(Number.isInteger(record.seed)).toBe(true);
    expect(record.seed).toBeGreaterThanOrEqual(0);
    expect(record.seed).toBeLessThanOrEqual(0xffffffff);
    expect(record.tickets).toEqual(predictUniformRandom({ targetIssue: record.targetIssue, history: [],
      ticketsPerIssue: 5, random: createResearchRandom(record.seed) }).tickets);
  });

  it('相同seed复现M0，独立数据库/不同生成时间不影响号码', () => {
    const first = generate(memoryDatabase(), 0xffffffff);
    const second = generateNextRecommendation(memoryDatabase(), [], new Date('2026-10-30T01:00:00+08:00'), { seed: 0xffffffff });
    expect(second.tickets).toEqual(first.tickets);
    expect(second.contentHash).not.toBe(first.contentHash);
  });

  it('重复调用返回原件，不按不同seed/注数重生成', () => {
    const database = memoryDatabase();
    const original = generate(database);
    expect(generateNextRecommendation(database, [], new Date('2026-11-01T19:59:59+08:00'),
      { seed: 999, ticketsPerIssue: 12 })).toEqual(original);
    expect(listRecommendations(database)).toHaveLength(1);
  });

  it('跨版本仍然唯一，推荐禁止update/delete', () => {
    const database = memoryDatabase();
    const record = generate(database);
    expect(() => insertRecommendation(database, { ...record, strategyVersion: '2.0.0' })).toThrow(/UNIQUE/);
    expect(() => database.prepare('UPDATE recommendations SET random_seed = ? WHERE id = ?').run('999', record.id)).toThrow(/禁止修改/);
    expect(() => database.prepare('DELETE FROM recommendations WHERE id = ?').run(record.id)).toThrow(/禁止删除/);
  });

  it.each(['2026-11-01T20:00:00+08:00', '2026-11-01T21:16:00+08:00', '2026-11-03T12:00:00+08:00'])(
    '20点/开奖后/源数据过旧拒绝且不补造未来：%s', timestamp => {
      const database = memoryDatabase();
      expect(() => generateNextRecommendation(database, [], new Date(timestamp))).toThrow(/截止|过旧/);
      expect(listRecommendations(database)).toHaveLength(0);
    });

  it.each(['2026-10-29T21:14:59+08:00', '2026-10-29T21:15:00+08:00'])(
    '源开奖前/恰好21:15均拒绝：%s', timestamp => {
      expect(() => generateNextRecommendation(memoryDatabase(), [], new Date(timestamp))).toThrow(/晚于源期开奖/);
    });

  it('21:15后1毫秒可生成，截止前1毫秒可生成', () => {
    expect(generateNextRecommendation(memoryDatabase(), [], new Date('2026-10-29T21:15:00.001+08:00')).id).toBe(1);
    expect(generateNextRecommendation(memoryDatabase(), [], new Date('2026-11-01T19:59:59.999+08:00')).id).toBe(1);
  });

  it('已有推荐过截止仍拒绝调用生成服务（可用读取服务取原件）', () => {
    const database = memoryDatabase();
    generate(database);
    expect(() => generateNextRecommendation(database, [], afterTargetDraw)).toThrow(/截止/);
    expect(listRecommendations(database)).toHaveLength(1);
  });

  it('目标提前入库也不可给已知期号生成，未来源开奖拒绝', () => {
    const database = memoryDatabase();
    insertDraw(database, makeDraw('2026125', '2026-11-01'), productionLikeNow.toISOString());
    expect(() => generateNextRecommendation(database, [], productionLikeNow)).toThrow(/晚于源期开奖/);
    expect(listRecommendations(database)).toHaveLength(0);
  });

  it('空库拒绝', () => {
    expect(() => generate(memoryDatabase(false))).toThrow(/开奖库为空/);
  });

  it('暂停日历只改变下一期开奖日期，不跳号；已有日历变化明确报错', () => {
    const periods = [{ startDate: '2026-11-01', endDate: '2026-11-03', reason: '手造休市' }];
    const database = memoryDatabase();
    const original = generate(database);
    expect(() => generateNextRecommendation(database, periods, productionLikeNow)).toThrow(/日历变化/);
    expect(listRecommendations(database)).toEqual([original]);
    const deferred = generateNextRecommendation(memoryDatabase(), periods, productionLikeNow, { seed: 123 });
    expect(deferred.targetIssue).toBe('2026125');
    expect(deferred.targetDrawDate).toBe('2026-11-05');
    expect(deferred.generationDeadline).toBe('2026-11-05T20:00:00.000+08:00');
  });

  it('非法日历/时间及外层事务拒绝', () => {
    const database = memoryDatabase();
    expect(() => generateNextRecommendation(database, [{ startDate: '2026-02-30', endDate: '2026-11-03', reason: '坏日期' }], productionLikeNow)).toThrow(/日历参数非法/);
    expect(() => generateNextRecommendation(database, [], new Date('bad'))).toThrow(/服务器时间/);
    expect(() => database.transaction(() => generate(database))()).toThrow(/事务外调用/);
    expect(() => database.transaction(() => verifyPendingRecommendations(database, afterTargetDraw))()).toThrow(/事务外调用/);
  });

  it.each([{ ticketsPerIssue: 0 }, { ticketsPerIssue: 1.2 }, { ticketsPerIssue: 1001 }, { ticketsPerIssue: NaN },
    { seed: -1 }, { seed: 0x100000000 }, { seed: 1.1 }, { seed: NaN }, { seed: null }, { ticketsPerIssue: null },
    { now: '2020-01-01' }])('参数先拒绝，不用空库错误掩盖参数问题：%j', options => {
    expect(() => generateNextRecommendation(memoryDatabase(false), [], productionLikeNow, options as RecommendationOptions)).toThrow(/参数|seed|ticketsPerIssue/);
  });

  it('不会读库内历史奖细/分析配置或改变holdout锁', () => {
    const first = generate(memoryDatabase());
    const database = memoryDatabase();
    insertDraw(database, { ...makeDraw('2026123', '2026-10-27'), rawRecordJson: '{"addmoney":"99"}' }, productionLikeNow.toISOString());
    database.prepare(`INSERT INTO backtest_holdout_policy VALUES (1, 'test-v1', '2026125', ?, '手造锁')`).run(productionLikeNow.toISOString());
    const before = database.prepare('SELECT * FROM backtest_holdout_policy').get();
    expect(generate(database)).toMatchObject({ tickets: first.tickets, contentHash: first.contentHash });
    expect(database.prepare('SELECT * FROM backtest_holdout_policy').get()).toEqual(before);
    expect(() => database.exec('DELETE FROM backtest_holdout_policy')).toThrow(/禁止删除/);
  });
});

describe('canonical内容哈希', () => {
  it('对象键排序但数组顺序保留；纯函数不依赖config', () => {
    expect(canonicalJson({ z: [2, 1], a: { y: 3, b: true } })).toBe('{"a":{"b":true,"y":3},"z":[2,1]}');
    expect(() => canonicalJson({ value: undefined })).toThrow(/canonical/);
    expect(() => canonicalJson(Infinity)).toThrow(/canonical/);
  });

  it('所有固化字段参与hash，id不参与，对象键顺序无关', () => {
    const record = generate(memoryDatabase());
    const changes: Partial<RecommendationRecord>[] = [
      { strategyVersion: '2' }, { strategyName: 'M1' }, { strategyParams: { changed: true } },
      { seed: 124 }, { tickets: record.tickets.slice(1) }, { generatedAt: '2026-10-31T05:00:00.000Z' },
      { targetIssue: '2026126' }, { targetDrawDate: '2026-11-03' },
      { generationDeadline: '2026-11-01T19:00:00.000+08:00' }, { sourceLatestIssue: '2026123' },
    ];
    for (const change of changes) expect(computeRecommendationContentHash({ ...record, ...change })).not.toBe(record.contentHash);
    expect(computeRecommendationContentHash({ ...record, id: 999 } as RecommendationRecord)).toBe(record.contentHash);
    expect(computeRecommendationContentHash({ ...record,
      strategyParams: Object.fromEntries(Object.entries(record.strategyParams).reverse()) })).toBe(record.contentHash);
  });

  it('坏hash不返回原件、不核验，不偷偷重生成', () => {
    const original = generate(memoryDatabase());
    const database = databaseWithChangedRecord(original, { contentHash: '0'.repeat(64) }, false);
    expect(() => generate(database)).toThrow(/哈希不一致/);
    expect(() => getRecommendationVerification(database, 1)).toThrow(/哈希不一致/);
    insertDraw(database, matchingDraw(original), afterTargetDraw.toISOString());
    const result = verifyPendingRecommendations(database, afterTargetDraw);
    expect(result).toMatchObject({ verifiedCount: 0, skippedCount: 1 });
    expect(result.skipped[0].reason).toMatch(/哈希不一致/);
    expect(listRecommendationVerifications(database, 1)).toHaveLength(0);
  });
});

describe('开奖后追加核验', () => {
  it('待开奖计pending；提前入库的future目标直到21:15才能核验', () => {
    const database = memoryDatabase();
    const record = generate(database);
    expect(verifyPendingRecommendations(database, productionLikeNow)).toMatchObject({ verifiedCount: 0, pendingCount: 1 });
    insertDraw(database, matchingDraw(record), productionLikeNow.toISOString());
    expect(verifyPendingRecommendations(database, productionLikeNow)).toMatchObject({ verifiedCount: 0, pendingCount: 1 });
    expect(verifyPendingRecommendations(database, new Date('2026-11-01T21:14:59.999+08:00'))).toMatchObject({ verifiedCount: 0, pendingCount: 1 });
    expect(verifyPendingRecommendations(database, afterTargetDraw)).toMatchObject({ verifiedCount: 1, pendingCount: 0 });
  });

  it('常规奖级与红蓝命中正确；奖细补充追加版本、同指纹幂等、原推荐完全不变', () => {
    const database = memoryDatabase();
    const record = generate(database);
    const firstDraw = matchingDraw(record);
    insertDraw(database, firstDraw, afterTargetDraw.toISOString());
    const first = verifyPendingRecommendations(database, afterTargetDraw);
    expect(first).toMatchObject({ verifiedCount: 1, pendingCount: 0 });
    const firstVersion = first.verifications[0];
    expect(firstVersion.result.outcomes[0]).toEqual({ redHits: 6, blueHit: true, grade: 1, prizeYuan: null });
    expect(firstVersion.result.prizeCounts['1']).toBe(1);
    expect(firstVersion.result.payoutAudit.eligible).toBe(false);
    expect(firstVersion.result.announcedPrizeReplayYuan).toBeNull();
    expect(firstVersion.result.formalRoi).toBeNull();
    expect(verifyPendingRecommendations(database, afterTargetDraw)).toMatchObject({ verifiedCount: 0, unchangedCount: 1 });
    const completedDraw = matchingDraw(record, true);
    updateDrawPrizeDetail(database, completedDraw, '2026-11-02T12:00:00+08:00');
    const second = verifyPendingRecommendations(database, new Date('2026-11-02T12:00:00+08:00'));
    expect(second.verifiedCount).toBe(1);
    expect(second.verifications[0].drawFingerprint).not.toBe(firstVersion.drawFingerprint);
    expect(second.verifications[0].result.payoutAudit.eligible).toBe(true);
    expect(second.verifications[0].result.outcomes[0].prizeYuan).toBe(5000000);
    expect(second.verifications[0].result.announcedPrizeReplayYuan).toBeGreaterThanOrEqual(5000000);
    expect(second.verifications[0].result.formalRoi).toBeNull();
    expect(listRecommendations(database)).toEqual([record]);
    const view = getRecommendationVerification(database, record.id)!;
    expect(view.latest).toEqual(second.verifications[0]);
    expect(view.versions).toEqual([second.verifications[0], firstVersion]);
    expect(() => database.prepare('UPDATE recommendation_verifications SET verified_at = ?').run('x')).toThrow(/禁止修改/);
    expect(() => database.exec('DELETE FROM recommendation_verifications')).toThrow(/禁止删除/);
    expect(() => database.prepare(`INSERT INTO recommendation_verifications
      (recommendation_id, draw_fingerprint, result_json, verified_at) VALUES (?, ?, '{}', ?)`)
      .run(record.id, firstVersion.drawFingerprint, afterTargetDraw.toISOString())).toThrow(/UNIQUE/);
  });

  it('仅原始公告修正也新增核验，不因号码相同覆盖旧版本', () => {
    const database = memoryDatabase();
    const record = generate(database);
    const draw = matchingDraw(record, true);
    insertDraw(database, draw, afterTargetDraw.toISOString());
    verifyPendingRecommendations(database, afterTargetDraw);
    updateDrawPrizeDetail(database, { ...draw, rawRecordJson: '{"addmoney":"99"}' }, afterTargetDraw.toISOString());
    const result = verifyPendingRecommendations(database, afterTargetDraw);
    expect(result.verifiedCount).toBe(1);
    expect(result.verifications[0].result.payoutAudit.eligible).toBe(false);
    expect(listRecommendationVerifications(database, record.id)).toHaveLength(2);
  });

  it('号码和奖级及原始JSON都参与指纹，抓取时间不参与', () => {
    const draw = makeDraw();
    const fingerprint = computeDrawFingerprint(draw);
    for (const change of [{ blueBall: 8 }, { redBalls: [1, 2, 3, 4, 5, 8] },
      { prizeGrades: [{ grade: 1, winningTicketCount: 1, prizePerTicketYuan: 100 }] },
      { rawRecordJson: '{"corrected":true}' }]) {
      expect(computeDrawFingerprint({ ...draw, ...change })).not.toBe(fingerprint);
    }
    expect(computeDrawFingerprint({ ...draw, fetchedAt: 'later' } as DrawRecord)).toBe(fingerprint);
  });

  it.each([
    { generationDeadline: null }, { sourceLatestIssue: null }, { targetDrawDate: null },
    { generatedAt: '2026-11-01T20:00:00.000+08:00' }, { generatedAt: '2026-11-01T21:16:00.000+08:00' },
    { generatedAt: '2026-10-29T21:15:00.000+08:00' }, { generatedAt: 'bad' },
    { generatedAt: '2026-10-30T24:00:00.000+08:00' },
    { generationDeadline: '2026-11-01T21:00:00.000+08:00' },
    { sourceLatestIssue: '2026123' }, { strategyParams: {} },
  ])('hash一致也不代表元数据/时间合法：%j', change => {
    const original = generate(memoryDatabase());
    const database = databaseWithChangedRecord(original, change);
    insertDraw(database, matchingDraw(original), afterTargetDraw.toISOString());
    const result = verifyPendingRecommendations(database, afterTargetDraw);
    expect(result).toMatchObject({ verifiedCount: 0, skippedCount: 1 });
    expect(result.skipped[0].reason.length).toBeGreaterThan(0);
  });

  it('实际开奖日期不等于固化日期明确skip', () => {
    const database = memoryDatabase();
    const record = generate(database);
    insertDraw(database, { ...matchingDraw(record), drawDate: '2026-11-03' }, afterTargetDraw.toISOString());
    const result = verifyPendingRecommendations(database, new Date('2026-11-04T12:00:00+08:00'));
    expect(result).toMatchObject({ verifiedCount: 0, skippedCount: 1 });
    expect(result.skipped[0].reason).toMatch(/日期.*不一致/);
  });

  it('找不到id返回null，非法id拒绝', () => {
    const database = memoryDatabase();
    expect(getRecommendationVerification(database, 123)).toBeNull();
    expect(() => getRecommendationVerification(database, 0)).toThrow(/id/);
  });

  it('v3旧行升级v4保留NULL且只读，不自动回填假时间元数据', () => {
    const database = new Database(':memory:');
    databases.push(database);
    for (const migration of SCHEMA_MIGRATIONS.slice(0, 3)) database.exec(migration.upgradeSql);
    database.pragma('user_version = 3');
    database.prepare(`INSERT INTO recommendations (target_issue, strategy_name, strategy_version,
      strategy_params_json, random_seed, tickets_json, content_hash, generated_at)
      VALUES ('2026125', 'M0_uniform_random', '1.0.0', '{}', '1', '[]', ?, ?)`)
      .run('0'.repeat(64), productionLikeNow.toISOString());
    expect(applyPendingMigrations(database)).toMatchObject({ previousVersion: 3, currentVersion: 4 });
    expect(database.prepare('SELECT target_draw_date, generation_deadline, source_latest_issue FROM recommendations').get())
      .toEqual({ target_draw_date: null, generation_deadline: null, source_latest_issue: null });
    expect(verifyPendingRecommendations(database, afterTargetDraw)).toMatchObject({ verifiedCount: 0, skippedCount: 1 });
    expect(() => database.prepare('UPDATE recommendations SET target_draw_date = ?').run('2026-11-01')).toThrow(/禁止修改/);
    expect(applyPendingMigrations(database).appliedMigrations).toHaveLength(0);
  });
});

describe('推荐成绩汇总', () => {
  it('空库与待开奖不造0均值', () => {
    const empty = summarizeRecommendationPerformance(memoryDatabase());
    expect(empty).toMatchObject({ recommendationCount: 0, issues: { verified: 0, awaitingDraw: 0, awaitingVerification: 0 },
      tickets: { verifiedTicketCount: 0, averageRedHits: null, blueHitRate: null }, payout: { formalRoi: null } });
    const database = memoryDatabase();
    generate(database);
    expect(summarizeRecommendationPerformance(database)).toMatchObject({ recommendationCount: 1,
      issues: { verified: 0, awaitingDraw: 1, awaitingVerification: 0 }, tickets: { averageRedHits: null } });
  });

  it('A→B→A修正只用当前指纹核验；奖金审计未通过整期暂停核算', () => {
    const database = memoryDatabase();
    const record = generate(database);
    const drawA = matchingDraw(record);
    insertDraw(database, drawA, afterTargetDraw.toISOString());
    const summaryBefore = summarizeRecommendationPerformance(database);
    expect(summaryBefore.issues).toEqual({ verified: 0, awaitingDraw: 0, awaitingVerification: 1 });
    verifyPendingRecommendations(database, afterTargetDraw);
    const withheld = summarizeRecommendationPerformance(database);
    const outcomes = listRecommendationVerifications(database, record.id)[0].result.outcomes;
    const redHits = outcomes.reduce((sum, outcome) => sum + outcome.redHits, 0);
    expect(withheld.issues.verified).toBe(1);
    expect(withheld.tickets).toMatchObject({ verifiedTicketCount: 5, totalRedHits: redHits, averageRedHits: redHits / 5 });
    expect(withheld.tickets.redHitDistribution.reduce((sum, count) => sum + count, 0)).toBe(5);
    expect(withheld.tickets.redHitDistribution[6]).toBeGreaterThanOrEqual(1);
    expect(withheld.tickets.prizeCounts['1']).toBe(1);
    expect(withheld.payout).toEqual({ accountedIssueCount: 0, withheldIssueCount: 1, accountedCostYuan: 0,
      announcedPrizeReplayYuan: 0, formalRoi: null });
    updateDrawPrizeDetail(database, matchingDraw(record, true), afterTargetDraw.toISOString());
    expect(summarizeRecommendationPerformance(database).issues).toEqual({ verified: 0, awaitingDraw: 0, awaitingVerification: 1 });
    verifyPendingRecommendations(database, afterTargetDraw);
    const accounted = summarizeRecommendationPerformance(database).payout;
    expect(accounted).toMatchObject({ accountedIssueCount: 1, withheldIssueCount: 0, accountedCostYuan: 10 });
    expect(accounted.announcedPrizeReplayYuan).toBeGreaterThanOrEqual(5000000);
    updateDrawPrizeDetail(database, drawA, afterTargetDraw.toISOString());
    expect(summarizeRecommendationPerformance(database)).toEqual(withheld);
    expect(listRecommendationVerifications(database, record.id)).toHaveLength(2);
  });
});