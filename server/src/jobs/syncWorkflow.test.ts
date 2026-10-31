/** 同步→推荐→模拟下一期开奖→核验完整链路。所有开奖仅写入内存DB。 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPendingMigrations } from '../db/migrations';
import { insertDraw, updateDrawPrizeDetail } from '../db/drawRepository';
import { listRecommendations } from '../db/recommendationRepository';
import { generateNextRecommendation, getRecommendationVerification, verifyPendingRecommendations } from '../recommend/recommendationService';
import type { DrawRecord } from '../domain/lottery';
import type { CwlDrawNoticeItemRaw, DrawNoticePageFetcher } from '../collector/cwlApiTypes';
import { isDatabaseSyncRunning, processRecommendationLifecycle, runIncrementalSyncWorkflow, SyncAlreadyRunningError } from './syncWorkflow';

const databases: Database.Database[] = [];
function makeDraw(issue = '2026124', drawDate = '2026-10-29'): DrawRecord {
  return { issue, drawDate, redBalls: [3, 11, 17, 22, 23, 29], blueBall: 9,
    salesAmountYuan: null, prizePoolAmountYuan: null, firstPrizeRegionText: null,
    prizeGrades: [5000000, 100000, 3000, 200, 10, 5].map((prizePerTicketYuan, index) => ({ grade: index + 1, winningTicketCount: 1, prizePerTicketYuan })),
    isPrizeDetailComplete: true, dataSource: 'memory_fixture', rawRecordJson: JSON.stringify({ code: issue }) };
}
function memoryDatabase() {
  const database = new Database(':memory:'); databases.push(database); database.pragma('foreign_keys=ON');
  applyPendingMigrations(database); insertDraw(database, makeDraw(), '2026-10-29T22:00:00+08:00');
  return database;
}
function rawItem(draw: DrawRecord): CwlDrawNoticeItemRaw {
  return { code: draw.issue, date: draw.drawDate, red: draw.redBalls.join(','), blue: String(draw.blueBall),
    prizegrades: draw.prizeGrades.map(grade => ({ type: grade.grade, typenum: String(grade.winningTicketCount), typemoney: String(grade.prizePerTicketYuan) })) };
}
function fetcher(items: CwlDrawNoticeItemRaw[]): DrawNoticePageFetcher {
  return async query => ({ state: 0, message: '内存模拟', total: items.length, pageNum: 1, pageNo: query.pageNo, pageSize: query.pageSize, result: items });
}
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe('同步推荐生命周期', () => {
  it('从同步生成、重复不改、次期入库核验，自动生成再下一期', async () => {
    const database = memoryDatabase();
    let now = new Date('2026-10-31T12:00:00+08:00');
    let items = [rawItem(makeDraw())];
    const context = { database, fetchPage: (query: Parameters<DrawNoticePageFetcher>[0]) => fetcher(items)(query),
      loadSuspensionPeriods: () => [], now: () => now };
    const first = await runIncrementalSyncWorkflow(context);
    expect(first.lifecycle.recommendation?.targetIssue).toBe('2026125');
    const recommendation = first.lifecycle.recommendation!;
    const repeated = await runIncrementalSyncWorkflow(context);
    expect(repeated.lifecycle.recommendation).toEqual(recommendation); expect(listRecommendations(database)).toHaveLength(1);
    const ticket = recommendation.tickets[0];
    items = [rawItem({ ...makeDraw('2026125', '2026-11-01'), redBalls: [...ticket.redBalls], blueBall: ticket.blueBall }), ...items];
    now = new Date('2026-11-01T21:45:00+08:00');
    const afterDraw = await runIncrementalSyncWorkflow(context);
    expect(afterDraw.synchronization.insertedIssues).toEqual(['2026125']);
    expect(afterDraw.lifecycle.verification.verifiedCount).toBe(1);
    expect(afterDraw.lifecycle.recommendation?.targetIssue).toBe('2026126');
    expect(getRecommendationVerification(database, recommendation.id)?.latest?.result.outcomes[0]).toMatchObject({ redHits: 6, blueHit: true, grade: 1 });
    expect(getRecommendationVerification(database, recommendation.id)?.latest?.result.formalRoi).toBeNull();
  });
  it('管理与调度并发共享锁，失败释放锁', async () => {
    const database = memoryDatabase();
    let release!: (value: Awaited<ReturnType<DrawNoticePageFetcher>>) => void;
    const response = new Promise<Awaited<ReturnType<DrawNoticePageFetcher>>>(resolve => { release = resolve; });
    const context = { database, fetchPage: async () => response, loadSuspensionPeriods: () => [], now: () => new Date('2026-10-31T12:00:00+08:00') };
    const first = runIncrementalSyncWorkflow(context);
    expect(isDatabaseSyncRunning(database)).toBe(true);
    await expect(runIncrementalSyncWorkflow(context)).rejects.toBeInstanceOf(SyncAlreadyRunningError);
    release(await fetcher([rawItem(makeDraw())])({ pageNo: 1, pageSize: 30 })); await first;
    expect(isDatabaseSyncRunning(database)).toBe(false);
    await expect(runIncrementalSyncWorkflow({ ...context, fetchPage: async () => { throw new Error('网络失败'); } })).rejects.toThrow('网络失败');
    expect(isDatabaseSyncRunning(database)).toBe(false);
  });
  it('网络结束后重新读时钟，到20点后不能沿用旧时钟生成', async () => {
    const database = memoryDatabase();
    let now = new Date('2026-11-01T19:59:59+08:00');
    const result = await runIncrementalSyncWorkflow({ database,
      fetchPage: async query => { now = new Date('2026-11-01T20:00:01+08:00'); return fetcher([rawItem(makeDraw())])(query); },
      loadSuspensionPeriods: () => [], now: () => now });
    expect(result.lifecycle.generationStatus).toBe('deadline_passed_or_stale'); expect(listRecommendations(database)).toHaveLength(0);
  });
  it('源期未来或过旧不生成；空库生命周期只给明确状态', () => {
    const database = memoryDatabase();
    expect(processRecommendationLifecycle(database, [], new Date('2026-10-29T21:00:00+08:00')).generationStatus).toBe('source_not_drawn');
    expect(processRecommendationLifecycle(database, [], new Date('2026-11-03T12:00:00+08:00')).generationStatus).toBe('deadline_passed_or_stale');
    const empty = new Database(':memory:'); databases.push(empty); applyPendingMigrations(empty);
    expect(processRecommendationLifecycle(empty, [], new Date('2026-10-31T12:00:00+08:00')).generationStatus).toBe('empty_history');
  });
});

describe('奖级与核验版本一致性', () => {
  it('福运奖3红错蓝获5元，奖级与计数不误标未中奖', () => {
    const database = new Database(':memory:'); databases.push(database); applyPendingMigrations(database);
    insertDraw(database, makeDraw('2026013', '2026-01-29'), '2026-01-29T22:00:00+08:00');
    const record = generateNextRecommendation(database, [], new Date('2026-01-30T12:00:00+08:00'), { ticketsPerIssue: 1, seed: 123 });
    const ticket = record.tickets[0], others = Array.from({ length: 33 }, (_, i) => i + 1).filter(ball => !ticket.redBalls.includes(ball));
    const target = { ...makeDraw('2026014', '2026-02-01'), redBalls: [...ticket.redBalls.slice(0, 3), ...others.slice(0, 3)].sort((a, b) => a - b),
      blueBall: ticket.blueBall === 16 ? 1 : ticket.blueBall + 1, rawRecordJson: JSON.stringify({ code: '2026014', fyjMoney: '5', fyjCount: '1' }) };
    insertDraw(database, target, '2026-02-01T22:00:00+08:00');
    const result = verifyPendingRecommendations(database, new Date('2026-02-01T22:30:00+08:00')).verifications[0].result;
    expect(result.outcomes[0]).toMatchObject({ grade: 'fortune', prizeYuan: 5 });
    expect(result.prizeCounts.fortune).toBe(1); expect(result.prizeCounts.none).toBe(0); expect(result.announcedPrizeReplayYuan).toBe(5);
  });
  it('奖金A→B→A修正只复用A核验；未核验B不能展示A作当前版', () => {
    const database = memoryDatabase();
    const recommendation = generateNextRecommendation(database, [], new Date('2026-10-31T12:00:00+08:00'), { seed: 17 });
    const drawA = makeDraw('2026125', '2026-11-01'); insertDraw(database, drawA, '2026-11-01T22:00:00+08:00');
    const now = new Date('2026-11-01T22:30:00+08:00');
    const versionA = verifyPendingRecommendations(database, now).verifications[0];
    const drawB = structuredClone(drawA); drawB.prizeGrades[0].prizePerTicketYuan = 6000000;
    updateDrawPrizeDetail(database, drawB, now.toISOString());
    expect(getRecommendationVerification(database, recommendation.id)?.latest).toBeNull();
    const versionB = verifyPendingRecommendations(database, now).verifications[0];
    expect(getRecommendationVerification(database, recommendation.id)?.latest).toEqual(versionB);
    updateDrawPrizeDetail(database, drawA, now.toISOString());
    expect(verifyPendingRecommendations(database, now).unchangedCount).toBe(1);
    const view = getRecommendationVerification(database, recommendation.id)!;
    expect(view.latest).toEqual(versionA); expect(view.versions).toEqual([versionB, versionA]);
  });
});