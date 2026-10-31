/**
 * 独立验收：只读真实开奖，不修改draws；内存DB验登记，概率用枚举组合与手算交叉核验。
 * 不依赖某个种子恰好显著：用理论方差的6倍标准误检验聚合模拟均值。
 */
import assert from 'node:assert/strict';
import { closeDatabase, getDatabase } from '../src/db/connection';
import { readBacktestDraws } from '../src/db/backtestRepository';
import { uniformRandomStrategy } from '../src/models/uniformRandomModel';
import { runWalkForwardBacktest } from '../src/backtest/walkForwardEngine';
import { determinePrizeGrade } from '../src/backtest/prizeRules';

function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - i + 1) / i;
  return Math.round(result);
}

function main(): void {
  const database = getDatabase();
  const draws = readBacktestDraws(database, '2026124');
  assert.ok(draws.length > 30, '真实历史至少31期');
  const options = { startIssue: draws[30].issue, endIssue: draws.at(-1)!.issue,
    ticketsPerIssue: 5, repetitions: 100, seed: 20261031, minimumHistory: 30 };
  const report = runWalkForwardBacktest(draws, uniformRandomStrategy, options);
  const meanRed = report.distributions.averageRedHits.mean, meanBlue = report.distributions.blueHitRate.mean;
  const n = report.coverage.evaluatedIssues * options.ticketsPerIssue * options.repetitions;
  // 单票红球命中为Hypergeometric(N=33,K=6,n=6)，方差6*(6/33)*(27/33)*(27/32)。
  // 同期开奖独立均匀抽票（整票去重轻微负相关），跨重复独立，使用略保守的独立票方差。
  const redVariance = 6 * (6 / 33) * (27 / 33) * (27 / 32);
  assert.ok(Math.abs(meanRed - 36 / 33) < 6 * Math.sqrt(redVariance / n), 'M0平均红球命中符合理论');
  assert.ok(Math.abs(meanBlue - 1 / 16) < 6 * Math.sqrt((1 / 16) * (15 / 16) / n), 'M0蓝球命中符合理论');
  assert.ok(Math.abs(report.distributions.blueLogLoss.mean - Math.log(16)) < 1e-10);
  assert.ok(Math.abs(report.distributions.blueBrierScore.mean - 15 / 16) < 1e-10);
  assert.ok(report.firstRepetitionDetails.every(period => period.historyEndIssue! < period.issue));
  assert.equal(report.repetitions.length, 100);
  assert.ok(report.repetitions.every(run => Object.values(run.prizeCounts).reduce((a, b) => a + b, 0) === run.totalTickets));
  assert.ok(report.repetitions.every(run => run.formalRoi === null));
  assert.ok(report.payoutAudit.withheldIssues.length > 0, '真实历史含未核实派奖，不提供全区间ROI');

  // 枚举“命中红球个数×蓝球命中”的组合数，覆盖整个17721088单式票空间。
  const ordinaryCounts: Record<string, number> = {}, fortuneCounts: Record<string, number> = {};
  let combinations = 0;
  for (let hits = 0; hits <= 6; hits++) {
    const reds = choose(6, hits) * choose(27, 6 - hits);
    for (const blueHit of [false, true]) {
      const count = reds * (blueHit ? 1 : 15);
      combinations += count;
      const grade = determinePrizeGrade(hits, blueHit, false);
      const specialGrade = determinePrizeGrade(hits, blueHit, true);
      ordinaryCounts[grade] = (ordinaryCounts[grade] ?? 0) + count;
      fortuneCounts[specialGrade] = (fortuneCounts[specialGrade] ?? 0) + count;
    }
  }
  assert.equal(combinations, 17_721_088);
  assert.deepEqual([ordinaryCounts['1'], ordinaryCounts['2'], ordinaryCounts['3'], ordinaryCounts['4'], ordinaryCounts['5'], ordinaryCounts['6']],
    [1, 15, 162, 7695, 137475, 1043640]);
  assert.equal(fortuneCounts.fortune, choose(6, 3) * choose(27, 3) * 15);
  assert.equal(fortuneCounts['5'], ordinaryCounts['5']);
  console.log(JSON.stringify({ passed: true, simulatedTickets: n, averageRedHits: meanRed,
    theoreticalRed: 36 / 33, blueHitRate: meanBlue, theoreticalBlue: 1 / 16,
    withheldPayoutIssues: report.payoutAudit.withheldIssues.length, eligiblePayoutIssues: report.payoutAudit.eligibleIssues,
    ordinaryWinningCombinationCounts: ordinaryCounts, fortuneWinningCombinationCount: fortuneCounts.fortune,
    note: '单元测试另由npm test覆盖防泄漏、奖级、前瞻政策与登记' }, null, 2));
}

try { main(); } catch (error) { console.error(`回测验收失败：${(error as Error).message}`); process.exitCode = 1; }
finally { closeDatabase(); }