/** 防泄漏、可复现、概率口径、登记与前瞻边界。正式数据库不参与单元测试。 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runWalkForwardBacktest, deriveRepetitionSeed } from './walkForwardEngine';
import { uniformRandomStrategy } from '../models/uniformRandomModel';
import type { BacktestDraw, BacktestOptions, BacktestStrategy, ModelPrediction } from './backtestTypes';
import { assertLegalPrediction, scoreProbabilities, summarizeDistribution } from './metrics';
import { applyPendingMigrations } from '../db/migrations';
import { ensureHoldoutRegistered, finishBacktestRun, startBacktestRun } from '../db/backtestRepository';
import { parseBacktestArguments } from './backtestArguments';

const draws: BacktestDraw[] = Array.from({ length: 4 }, (_, index) => ({
  issue: `202600${index + 1}`, drawDate: `2026-01-0${index + 1}`, redBalls: [1, 2, 3, 4, 5, 6], blueBall: index + 1,
  prizeGrades: [5000000, 100000, 3000, 200, 10, 5].map((prizePerTicketYuan, grade) => ({ grade: grade + 1, winningTicketCount: 1, prizePerTicketYuan })),
  rawRecordJson: JSON.stringify({ code: `202600${index + 1}` }),
}));
const options: BacktestOptions = { startIssue: '2026002', endIssue: '2026004', seed: 123, ticketsPerIssue: 2, repetitions: 3, minimumHistory: 1 };

function fixedPrediction(): ModelPrediction {
  return { redProbabilities: Array(33).fill(6 / 33) as number[], blueProbabilities: Array(16).fill(1 / 16) as number[],
    tickets: [{ redBalls: [1, 2, 3, 4, 5, 6], blueBall: 2 }, { redBalls: [1, 2, 3, 4, 5, 6], blueBall: 3 }] };
}

describe('滚动回测隔离及收益', () => {
  it('只暴露目标期之前的号码历史，递归只读，无奖金/原始记录', () => {
    const spy: BacktestStrategy = { ...uniformRandomStrategy, createPredictor: () => context => {
      expect(context.history.length).toBe(Number(context.targetIssue.slice(-3)) - 1);
      expect(Object.keys(context).sort()).toEqual(['history', 'random', 'targetIssue', 'ticketsPerIssue']);
      expect(context.history.every(draw => draw.issue < context.targetIssue)).toBe(true);
      expect(Object.keys(context.history[0]).sort()).toEqual(['blueBall', 'drawDate', 'issue', 'redBalls']);
      expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.history)).toBe(true);
      expect(Object.isFrozen(context.history[0])).toBe(true); expect(Object.isFrozen(context.history[0].redBalls)).toBe(true);
      expect(() => (context.history[0].redBalls as number[]).push(33)).toThrow();
      return fixedPrediction();
    } };
    runWalkForwardBacktest(draws, spy, options);
  });
  it('修改未来数据不改变较早预测；指纹按实际使用截止隔离', () => {
    const modified = structuredClone(draws); modified[3].redBalls = [7, 8, 9, 10, 11, 12]; modified[3].blueBall = 16;
    const originalReport = runWalkForwardBacktest(draws, uniformRandomStrategy, options);
    const modifiedReport = runWalkForwardBacktest(modified, uniformRandomStrategy, options);
    expect(originalReport.firstRepetitionDetails.slice(0, 2)).toEqual(modifiedReport.firstRepetitionDetails.slice(0, 2));
    expect(originalReport.firstRepetitionDetails[2].prediction).toEqual(modifiedReport.firstRepetitionDetails[2].prediction);
    const earlier = { ...options, endIssue: '2026003' };
    expect(runWalkForwardBacktest(draws, uniformRandomStrategy, earlier)).toEqual(runWalkForwardBacktest(modified, uniformRandomStrategy, earlier));
  });
  it('同种子完全复现，增加重复不改变原有重复', () => {
    const first = runWalkForwardBacktest(draws, uniformRandomStrategy, options);
    expect(first).toEqual(runWalkForwardBacktest(draws, uniformRandomStrategy, options));
    expect(runWalkForwardBacktest(draws, uniformRandomStrategy, { ...options, repetitions: 4 }).repetitions.slice(0, 3)).toEqual(first.repetitions);
    expect(deriveRepetitionSeed(123, 0)).not.toBe(deriveRepetitionSeed(123, 1));
  });
  it('每次重复重新构建预测器，不传递上一轮状态', () => {
    let factories = 0;
    const strategy = { ...uniformRandomStrategy, createPredictor: () => { factories++; return () => fixedPrediction(); } };
    runWalkForwardBacktest(draws, strategy, options); expect(factories).toBe(3);
  });
  it('固定票按当期奖金回放、成本与最高奖级计数正确', () => {
    const strategy = { ...uniformRandomStrategy, createPredictor: () => () => fixedPrediction() };
    const report = runWalkForwardBacktest(draws, strategy, options);
    const metrics = report.repetitions[0];
    expect(metrics.prizeCounts[1]).toBe(2); expect(metrics.prizeCounts[2]).toBe(4);
    expect(metrics.totalCostYuan).toBe(12); expect(metrics.accountedPrizeYuan).toBe(10_400_000);
    expect(metrics.ordinaryReplayRoi).toBe((10_400_000 - 12) / 12); expect(metrics.formalRoi).toBeNull();
    expect(report.firstRepetitionDetails[0].predictionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(report.firstRepetitionDetails[0].prediction)).toBe(true);
  });
  it('含派奖整期不核算，命中统计保留，全区间ROI与回撤为null', () => {
    const changed = structuredClone(draws); changed[1].rawRecordJson = JSON.stringify({ annotation: '含派奖' });
    const strategy = { ...uniformRandomStrategy, createPredictor: () => () => fixedPrediction() };
    const report = runWalkForwardBacktest(changed, strategy, options);
    expect(report.payoutAudit.withheldIssues).toHaveLength(1);
    expect(report.firstRepetitionDetails[0].prizeYuan).toBeNull();
    expect(report.repetitions[0].accountedCostYuan).toBe(8);
    expect(report.repetitions[0].ordinaryReplayRoi).toBeNull(); expect(report.repetitions[0].maximumDrawdownYuan).toBeNull();
    expect(report.repetitions[0].prizeCounts[1]).toBe(2);
    expect(report.repetitions[0].accountedPrizeCounts[1]).toBe(1);
    expect(report.repetitions[0].accountedPrizeCounts[2]).toBe(3);
  });
  it('连亏净值从0开始，回撤为实际累计投入，不遗漏首期亏损', () => {
    const strategy = { ...uniformRandomStrategy, createPredictor: () => () => ({ ...fixedPrediction(), tickets: [
      { redBalls: [7, 8, 9, 10, 11, 12], blueBall: 15 }, { redBalls: [7, 8, 9, 10, 11, 12], blueBall: 16 },
    ] }) };
    const metrics = runWalkForwardBacktest(draws, strategy, options).repetitions[0];
    expect(metrics.accountedPrizeYuan).toBe(0); expect(metrics.ordinaryReplayRoi).toBe(-1);
    expect(metrics.maximumDrawdownYuan).toBe(12); expect(metrics.prizeCounts.none).toBe(6);
  });
  it('前瞻段硬拒绝；不存在起止期/历史不足/重复期拒绝', () => {
    expect(() => runWalkForwardBacktest(draws, uniformRandomStrategy, { ...options, endIssue: '2026125' })).toThrow('锁定');
    expect(() => runWalkForwardBacktest(draws, uniformRandomStrategy, { ...options, startIssue: '2026000' })).toThrow();
    expect(() => runWalkForwardBacktest(draws, uniformRandomStrategy, { ...options, endIssue: '2026005' })).toThrow('已入库');
    expect(() => runWalkForwardBacktest(draws, uniformRandomStrategy, { ...options, minimumHistory: 2 })).toThrow('历史');
    expect(() => runWalkForwardBacktest([draws[0], draws[0], ...draws.slice(1)], uniformRandomStrategy, options)).toThrow('严格递增');
  });
});

describe('评分、概率与命令参数', () => {
  it('M0手算评分：红边际熵/Brier，蓝log16和15/16', () => {
    const scores = scoreProbabilities(fixedPrediction(), { redBalls: [1, 2, 3, 4, 5, 6], blueBall: 1 });
    const p = 6 / 33;
    expect(scores.redLogLoss).toBeCloseTo(-p * Math.log(p) - (1 - p) * Math.log(1 - p), 12);
    expect(scores.redBrierScore).toBeCloseTo(p * (1 - p), 12);
    expect(scores.blueLogLoss).toBeCloseTo(Math.log(16), 12); expect(scores.blueBrierScore).toBeCloseTo(15 / 16, 12);
  });
  it('预测边际和错误、NaN、非法票/重复票/注数错误拒绝', () => {
    expect(() => assertLegalPrediction({ ...fixedPrediction(), redProbabilities: Array(33).fill(1 / 33) as number[] }, 2)).toThrow();
    expect(() => assertLegalPrediction({ ...fixedPrediction(), blueProbabilities: [NaN] }, 2)).toThrow();
    expect(() => assertLegalPrediction({ ...fixedPrediction(), tickets: [fixedPrediction().tickets[0], fixedPrediction().tickets[0]] }, 2)).toThrow('重复');
    expect(() => assertLegalPrediction(fixedPrediction(), 3)).toThrow('注数');
  });
  it('0/1概率logloss有界，Brier仍用未裁剪原概率', () => {
    const predicted = { ...fixedPrediction(), redProbabilities: Array.from({ length: 33 }, (_, i) => i < 6 ? 1 : 0),
      blueProbabilities: Array.from({ length: 16 }, (_, i) => i === 0 ? 1 : 0) };
    const scores = scoreProbabilities(predicted, { redBalls: [7, 8, 9, 10, 11, 12], blueBall: 2 });
    expect(Number.isFinite(scores.redLogLoss)).toBe(true); expect(Number.isFinite(scores.blueLogLoss)).toBe(true);
    expect(scores.redBrierScore).toBeCloseTo(12 / 33, 12); expect(scores.blueBrierScore).toBe(2);
  });
  it('结果区间R7分位点与均值MC区间不混淆', () => {
    const distribution = summarizeDistribution([0, 1, 2, 3]);
    expect(distribution.mean).toBe(1.5); expect(distribution.outcomeInterval95[0]).toBeCloseTo(.075, 12);
    expect(distribution.monteCarloMeanInterval95).toBeNull();
    const constant = summarizeDistribution(Array(500).fill(Math.log(16)) as number[]);
    expect(constant.mean).toBe(Math.log(16)); expect(constant.standardDeviation).toBe(0);
    expect(summarizeDistribution(Array(100).fill(10) as number[], false).monteCarloMeanInterval95).toBeNull();
  });
  it('CLI支持两种参数形式，重复/未知/负值拒绝', () => {
    expect(parseBacktestArguments(['--seed=0', '--tickets', '3']).seed).toBe(0);
    for (const args of [['--foo=1'], ['--seed=1', '--seed=2'], ['--seed=-1'], ['--tickets=0'], ['--seed=4294967296'], ['--seed']]) {
      expect(() => parseBacktestArguments(args)).toThrow();
    }
  });
});

describe('前瞻政策与运行登记', () => {
  it('迁移可重复，政策只能登记一次，禁止改写/删除', () => {
    const db = new Database(':memory:');
    try {
      applyPendingMigrations(db); applyPendingMigrations(db);
      ensureHoldoutRegistered(db); ensureHoldoutRegistered(db);
      expect((db.prepare('SELECT count(*) AS n FROM backtest_holdout_policy').get() as { n: number }).n).toBe(1);
      expect(() => db.exec("UPDATE backtest_holdout_policy SET start_issue='2027001'")).toThrow('禁止改写');
      expect(() => db.exec('DELETE FROM backtest_holdout_policy')).toThrow('禁止删除');
      const id = startBacktestRun(db, uniformRandomStrategy, options);
      finishBacktestRun(db, id, null, null, '故意失败');
      expect((db.prepare('SELECT run_status FROM backtest_runs WHERE id=?').get(id) as { run_status: string }).run_status).toBe('failed');
      expect(() => finishBacktestRun(db, id, null, null, '再写')).toThrow('禁止覆盖');
    } finally { db.close(); }
  });
  it('前瞻数据已入库时拒绝事后登记政策', () => {
    const db = new Database(':memory:');
    try {
      applyPendingMigrations(db);
      db.prepare(`INSERT INTO draws (issue,draw_date,red_ball_1,red_ball_2,red_ball_3,red_ball_4,red_ball_5,red_ball_6,blue_ball,
        data_source,fetched_at,updated_at) VALUES ('2026125','2026-11-01',1,2,3,4,5,6,1,'test','now','now')`).run();
      expect(() => ensureHoldoutRegistered(db)).toThrow('事后登记');
    } finally { db.close(); }
  });
});