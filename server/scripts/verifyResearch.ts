/** 可重复离线研究验收：独立手算/理论矩/合成GLM/边界，不修改真实开奖表。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SERVER_ROOT_DIR } from '../src/config';
import { createResearchRandom, fillFairSequence, packAnalysisDraws, validateSimulationCount } from '../src/analysis/researchRandom';
import { benjaminiHochberg, monteCarloP, getExactStructureProbabilities, defineResearchSegments,
  calculateSequenceStatistics, runRandomnessResearch } from '../src/analysis/randomnessResearch';
import { calculateTicketHeat, calculatePopularityFeatures, fitPoissonOffset, predictPoissonCount,
  runPopularityResearch, TOTAL_TICKET_COMBINATIONS } from '../src/analysis/popularityResearch';
import type { AnalysisDraw } from '../src/analysis/analysisTypes';
import type { ResearchDraw } from '../src/db/analysisRepository';
import { readResearchSnapshot } from '../src/db/analysisRepository';
import { closeDatabase, getDatabase } from '../src/db/connection';
import { parseResearchArguments } from './analyzeResearch';
import { calculateNumberStatistics } from '../src/analysis/numberStatistics';

let passed = 0;
function check(description: string, verification: () => void): void {
  verification(); passed++; console.log(`[通过] ${description}`);
}
function sampleDraws(count: number, seed = 7): AnalysisDraw[] {
  const sequence = new Uint8Array(count * 7);
  fillFairSequence(sequence, createResearchRandom(seed));
  return Array.from({ length: count }, (_, index) => ({
    issue: `2026${String(index + 1).padStart(3, '0')}`,
    drawDate: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    redBalls: Array.from(sequence.slice(index * 7, index * 7 + 6)), blueBall: sequence[index * 7 + 6],
  }));
}

try {
  check('PRNG固定种子输出金标，避免算法无意变化', () => {
    const random = createResearchRandom(20261031);
    // 版本固定金标；跨运行/重构后必须保持一致，算法变更需更新版本和种子口径。
    const values = Array.from({ length: 6 }, () => random.nextUint32());
    assert.deepEqual(values, [2114905098, 2257139990, 331455871, 469235580, 1634231689, 1791852528]);
    const repeated = createResearchRandom(20261031);
    assert.deepEqual(values, Array.from({ length: 6 }, () => repeated.nextUint32()));
    assert.notDeepEqual(values, Array.from({ length: 6 }, () => createResearchRandom(1).nextUint32()));
  });
  check('PRNG seed边界及非法整数拒绝', () => {
    createResearchRandom(0); createResearchRandom(0xffffffff);
    for (const seed of [-1, 0x100000000, 1.5, NaN]) assert.throws(() => createResearchRandom(seed));
  });
  check('随机整数上界1和16合法，不接受0/小数', () => {
    const random = createResearchRandom(1);
    assert.equal(random.integer(1), 0);
    for (let index = 0; index < 1000; index++) assert.ok(random.integer(16) < 16);
    assert.throws(() => random.integer(0)); assert.throws(() => random.integer(1.5));
  });
  check('模拟相同种子完全复现，不同种子不同序列', () => {
    assert.deepEqual(sampleDraws(100, 5), sampleDraws(100, 5));
    assert.notDeepEqual(sampleDraws(100, 5), sampleDraws(100, 6));
  });
  const large = new Uint8Array(100000 * 7);
  fillFairSequence(large, createResearchRandom(123456));
  check('十万模拟期所有号码范围、不放回、排序正确', () => {
    for (let offset = 0; offset < large.length; offset += 7) {
      for (let index = 0; index < 6; index++) {
        assert.ok(large[offset + index] >= 1 && large[offset + index] <= 33);
        if (index > 0) assert.ok(large[offset + index] > large[offset + index - 1]);
      }
      assert.ok(large[offset + 6] >= 1 && large[offset + 6] <= 16);
    }
  });
  check('理论红和值均值102、方差459，蓝均值8.5方差21.25，重号均值36/33', () => {
    let sum = 0, sumSquares = 0, blueSum = 0, blueSquares = 0, repeatSum = 0;
    for (let offset = 0; offset < large.length; offset += 7) {
      let redSum = 0;
      for (let position = 0; position < 6; position++) {
        redSum += large[offset + position];
        if (offset > 0 && large.subarray(offset - 7, offset - 1).includes(large[offset + position])) repeatSum++;
      }
      sum += redSum; sumSquares += redSum ** 2;
      blueSum += large[offset + 6]; blueSquares += large[offset + 6] ** 2;
    }
    assert.ok(Math.abs(sum / 100000 - 102) < 0.3);
    assert.ok(Math.abs(sumSquares / 100000 - (sum / 100000) ** 2 - 459) < 8);
    assert.ok(Math.abs(blueSum / 100000 - 8.5) < 0.06);
    assert.ok(Math.abs(blueSquares / 100000 - (blueSum / 100000) ** 2 - 21.25) < 0.3);
    assert.ok(Math.abs(repeatSum / 99999 - 36 / 33) < 0.02);
  });
  check('全部红/蓝单号边际频率匹配理论，不仅检查和值', () => {
    const red = Array<number>(33).fill(0), blue = Array<number>(16).fill(0);
    for (let offset = 0; offset < large.length; offset += 7) {
      for (let index = 0; index < 6; index++) red[large[offset + index] - 1]++;
      blue[large[offset + 6] - 1]++;
    }
    assert.ok(red.every((count) => Math.abs(count / 100000 - 6 / 33) < 0.006));
    assert.ok(blue.every((count) => Math.abs(count / 100000 - 1 / 16) < 0.003));
  });
  check('空模拟缓冲允许；非七字节倍数拒绝', () => {
    fillFairSequence(new Uint8Array(0), createResearchRandom(1));
    assert.throws(() => fillFairSequence(new Uint8Array(8), createResearchRandom(1)));
  });
  check('模拟重复数和CLI参数边界', () => {
    for (const runs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateSimulationCount(runs));
    assert.deepEqual(parseResearchArguments([]), { simulations: 10000, seed: 20261031 });
    assert.deepEqual(parseResearchArguments(['--simulations', '12', '--seed=0']), { simulations: 12, seed: 0 });
    for (const args of [['--x=1'], ['--seed'], ['--simulations=0'], ['--seed=-1'], ['--seed=1', '--seed=2'], ['--simulations=1e4']]) assert.throws(() => parseResearchArguments(args));
  });
  check('Monte Carlo加一与包含相等：0/10000=>1/10001，全超过=>1', () => {
    assert.equal(monteCarloP(0, 10000), 1 / 10001); assert.equal(monteCarloP(10000, 10000), 1);
    assert.equal(monteCarloP(2, 9), 0.3);
    assert.throws(() => monteCarloP(11, 10)); assert.throws(() => monteCarloP(-1, 10));
  });
  check('BH独立手算、原顺序、并列、空族和非法p', () => {
    assert.deepEqual(benjaminiHochberg([0.04, 0.01, 0.03, 0.2]), [0.05333333333333334, 0.04, 0.05333333333333334, 0.2]);
    assert.deepEqual(benjaminiHochberg([0.01, 0.01]), [0.01, 0.01]); assert.deepEqual(benjaminiHochberg([]), []);
    assert.throws(() => benjaminiHochberg([NaN])); assert.throws(() => benjaminiHochberg([1.1]));
  });
  check('精确穷举分布概率和1，奇数期望6*17/33，连号期望30/33', () => {
    const probabilities = getExactStructureProbabilities();
    for (const distribution of Object.values(probabilities)) assert.ok(Math.abs(distribution.reduce((sum, p) => sum + p, 0) - 1) < 1e-12);
    assert.ok(Math.abs(probabilities.redOdd.reduce((sum, p, odd) => sum + p * odd, 0) - 6 * 17 / 33) < 1e-12);
    assert.ok(Math.abs(probabilities.redConsecutive.reduce((sum, p, count) => sum + p * count, 0) - 30 / 33) < 1e-12);
    assert.ok(Math.abs(probabilities.redRepeat.reduce((sum, p, count) => sum + p * count, 0) - 36 / 33) < 1e-12);
  });
  const draws = sampleDraws(30);
  check('真实号码/日期/排序/重复期号非法输入阻止', () => {
    assert.throws(() => packAnalysisDraws([{ ...draws[0], redBalls: [1, 1, 2, 3, 4, 5] }]));
    assert.throws(() => packAnalysisDraws([{ ...draws[0], blueBall: 17 }]));
    assert.throws(() => packAnalysisDraws([draws[0], draws[0]]));
    assert.throws(() => packAnalysisDraws([draws[1], draws[0]]));
  });
  check('手算三期完整遗漏0/1及重号、蓝相等和协方差', () => {
    const hand = draws.slice(0, 3).map((draw, index) => ({ ...draw, redBalls: index === 1 ? [1, 7, 8, 9, 10, 11] : [1, 2, 3, 4, 5, 6], blueBall: index === 1 ? 2 : 1 }));
    const stats = calculateSequenceStatistics(packAnalysisDraws(hand), defineResearchSegments(hand)[0]);
    assert.deepEqual(stats.observed[2], [2, 5, 0, 0, 0, 0]);
    assert.deepEqual(stats.observed[3], [0, 1, 0, 0, 0, 0]);
    assert.equal(stats.observed[7][1], 2); assert.equal(stats.observed[9][0], 0);
    assert.equal(stats.blueLagSigned, 48.75 / 21.25);
    const p = 6 / 33;
    assert.ok(Math.abs(defineResearchSegments(hand)[0].expected[2][0] - 33 * 2 * p * p) < 1e-12);
  });
  check('每次模拟同一等长序列组成全量及年段，报告全部20项', () => {
    const report = runRandomnessResearch(draws, 20, 1);
    assert.equal(report.predefinedCount, 20); assert.equal(report.familySize, 20);
    assert.ok(report.findings.every((finding) => finding.monteCarloP! >= 1 / 21 && finding.monteCarloP! <= 1));
    assert.equal(report.findings[0].observedCounts!.reduce((sum, count) => sum + count, 0), 30 * 6);
    assert.deepEqual(report, runRandomnessResearch(draws, 20, 1));
  });
  check('缺期只跳过全部连续量，保留频次/结构与全部检验定义', () => {
    const report = runRandomnessResearch(draws.filter((_, index) => index !== 5), 5, 2);
    assert.equal(report.familySize, 10); assert.equal(report.predefinedCount, 20);
    assert.equal(report.findings.filter((finding) => finding.skippedReason !== null).length, 10);
    assert.ok(report.findings.filter((finding) => finding.skippedReason !== null).every((finding) => finding.monteCarloP === null));
  });
  check('空研究拒绝、单期连续量跳过；全相等零方差MC p=1', () => {
    assert.throws(() => runRandomnessResearch([], 1, 1));
    const report = runRandomnessResearch([draws[0]], 1, 1);
    assert.equal(report.familySize, 10);
    assert.equal(report.findings.find((finding) => finding.test === 'blueFrequency')!.monteCarloP, 1);
    assert.ok(report.findings.every((finding) => finding.nullStandardDeviation === null));
  });
  check('跨年疑似年末缺期传给旧年段，阻止连续检验', () => {
    const cross = [
      { ...draws[0], issue: '2025001', drawDate: '2025-01-02' },
      { ...draws[1], issue: '2026001', drawDate: '2026-01-01' },
    ];
    const segments = defineResearchSegments(cross);
    assert.ok(segments[0].sequenceProblems.some((problem) => problem.problemType === 'possible_missing_year_end'));
    assert.ok(segments.find((segment) => segment.name === '2025')!.sequenceProblems.length > 0);
  });
  check('热度D与1/15/162期望、零注数处理独立手算', () => {
    for (const grade of [1, 2, 3]) {
      const expected = [1, 15, 162][grade - 1];
      const heat = calculateTicketHeat(2 * TOTAL_TICKET_COMBINATIONS, expected * 2, grade)!;
      assert.equal(heat.expected, expected); assert.equal(heat.ratio, 2);
      assert.equal(calculateTicketHeat(2 * TOTAL_TICKET_COMBINATIONS, 0, grade)!.ratio, 0);
    }
    assert.equal(calculateTicketHeat(null, 0, 1), null); assert.equal(calculateTicketHeat(3, 1, 1), null);
    assert.equal(calculateTicketHeat(2, -1, 1), null); assert.throws(() => calculateTicketHeat(2, 1, 4));
  });
  check('生日/连号/同尾/等差三元组/上期重号手算', () => {
    const features = calculatePopularityFeatures({ ...draws[1], redBalls: [1, 2, 3, 11, 21, 32] }, { ...draws[0], redBalls: [1, 2, 3, 4, 5, 6] });
    assert.deepEqual(features, [5, 2, 4, 2, 3]);
    assert.equal(calculatePopularityFeatures(draws[0], null), null);
  });
  check('Poisson offset截距闭式解，零计数不加伪计数', () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({ features: [], expected: 5 + index % 3, observed: index % 2 === 0 ? 0 : 24 }));
    const model = fitPoissonOffset(rows, 0);
    const ratio = rows.reduce((sum, row) => sum + row.observed, 0) / rows.reduce((sum, row) => sum + row.expected, 0);
    assert.ok(Math.abs(model.coefficients[0] - Math.log(ratio)) < 1e-10);
    assert.ok(Math.abs(predictPoissonCount(rows[0], model) - rows[0].expected * ratio) < 1e-10);
  });
  check('SVD GLM恢复合成系数，恒定列剔除；训练标准化不依赖测试数据', () => {
    const rows = Array.from({ length: 200 }, (_, index) => {
      const x = (index % 20 - 9.5) / 5;
      return { features: [x, 3], expected: 1000, observed: Math.round(1000 * Math.exp(0.2 + 0.4 * x)) };
    });
    const model = fitPoissonOffset(rows, 2);
    assert.deepEqual(model.activeColumns, [0]);
    assert.ok(Math.abs(model.coefficients[0] - 0.2) < 0.001);
    assert.ok(Math.abs(model.coefficients[1] / model.scales[0] - 0.4) < 0.001);
    const means = [...model.means]; predictPoissonCount({ features: [10, 3], expected: 1, observed: 0 }, model);
    assert.deepEqual(model.means, means);
  });
  check('GLM空/全零/非法/精确共线/预测溢出防护', () => {
    assert.throws(() => fitPoissonOffset([], 0));
    assert.throws(() => fitPoissonOffset(Array.from({ length: 30 }, () => ({ features: [], expected: 1, observed: 0 })), 0));
    assert.throws(() => fitPoissonOffset(Array.from({ length: 30 }, (_, index) => ({ features: [index, index], expected: 1, observed: index + 1 })), 2));
    assert.throws(() => fitPoissonOffset(Array.from({ length: 30 }, () => ({ features: [], expected: -1, observed: 1 })), 0));
    const model = fitPoissonOffset(Array.from({ length: 30 }, () => ({ features: [], expected: 1, observed: 1 })), 0);
    assert.throws(() => predictPoissonCount({ features: [], expected: Infinity, observed: 0 }, model));
  });
  check('缺销售仍保留观测与排除理由；空热度和无后续段不伪造模型', () => {
    const missing: ResearchDraw[] = draws.map((draw) => ({ ...draw, salesAmountYuan: null, prizeGrades: [] }));
    const report = runPopularityResearch(missing, 1);
    assert.equal(report.observations.length, 30); assert.ok(report.gradeModels.every((model) => model.status === 'skipped'));
    assert.ok(report.observations.every((row) => row.grades.every((heat) => heat.exclusionReason !== null)));
    assert.equal(runPopularityResearch([], 1).observations.length, 0);
  });
  check('真实快照覆盖与独立SQL计数、销售快照一致', () => {
    const database = getDatabase(), snapshot = readResearchSnapshot(database);
    assert.ok(snapshot.length > 0); packAnalysisDraws(snapshot);
    const totals = database.prepare('SELECT COUNT(*) AS count, SUM(sales_amount_yuan) AS sales FROM draws').get() as { count: number; sales: number };
    assert.equal(snapshot.length, totals.count);
    assert.equal(snapshot.reduce((sum, draw) => sum + (draw.salesAmountYuan ?? 0), 0), totals.sales);
    assert.equal(defineResearchSegments(snapshot)[0].sequenceProblems.length, 0);
  });
  check('真实热度时间训练/后续评估严格隔离，三个奖级全报告且禁止M5自动准入', () => {
    const report = runPopularityResearch(readResearchSnapshot(getDatabase()), 20261031);
    assert.equal(report.gradeModels.length, 3);
    for (const model of report.gradeModels) {
      assert.equal(model.status, 'fitted');
      assert.ok(model.trainingLastIssue! < report.holdoutFirstIssue);
      assert.ok(model.evaluationFirstIssue! >= report.holdoutFirstIssue);
      assert.equal(model.m5Approved, false);
      if ('model' in model) {
        assert.ok(model.model.converged && model.model.conditionNumber < 1e8);
        assert.ok(Number.isFinite(model.evaluationMetrics!.countRMSE));
        assert.ok(Number.isFinite(model.baselineEvaluationMetrics!.countRMSE));
        assert.ok(model.improvement!.familywiseInterval95[0] <= model.improvement!.interval95[0]);
      }
    }
  });
  check('真实紧凑统计频次/完整遗漏与第4批独立实现一致', () => {
    const snapshot = readResearchSnapshot(getDatabase());
    const statistics = calculateSequenceStatistics(packAnalysisDraws(snapshot), defineResearchSegments(snapshot)[0]);
    for (const [color, frequencyIndex, omissionIndex] of [['red', 0, 2], ['blue', 1, 3]] as const) {
      const numbers = calculateNumberStatistics(snapshot, color);
      assert.deepEqual(statistics.observed[frequencyIndex], numbers.map((number) => number.appearanceCount));
      const bins = Array<number>(6).fill(0);
      for (const number of numbers) for (const [gapText, count] of Object.entries(number.completeOmissionDistribution)) {
        const gap = Number(gapText);
        const bin = gap === 0 ? 0 : gap <= 2 ? 1 : gap <= 5 ? 2 : gap <= 10 ? 3 : gap <= 20 ? 4 : 5;
        bins[bin] += count;
      }
      assert.deepEqual(statistics.observed[omissionIndex], bins);
    }
  });
  const formalReportPath = path.join(SERVER_ROOT_DIR, '..', 'docs', 'research-analysis.json');
  if (fs.existsSync(formalReportPath)) {
    check('正式JSON的10000+重复、数据指纹、全族MC/BH及模型指标可复核', () => {
      // 使用运行函数的返回类型，不另建一套重复的统计类型。
      const report = JSON.parse(fs.readFileSync(formalReportPath, 'utf8')) as {
        formalReport: boolean; dataFingerprint: string; randomness: ReturnType<typeof runRandomnessResearch>;
        popularity: ReturnType<typeof runPopularityResearch>;
      };
      assert.equal(report.formalReport, true); assert.ok(report.randomness.simulations >= 10000);
      const fingerprint = createHash('sha256').update(JSON.stringify(readResearchSnapshot(getDatabase()))).digest('hex');
      assert.equal(report.dataFingerprint, fingerprint, '数据已更新，需重新生成正式研究报告');
      assert.equal(report.randomness.predefinedCount, report.randomness.segments.length * 10);
      assert.equal(report.randomness.findings.length, report.randomness.predefinedCount);
      const active = report.randomness.findings.filter((finding) => finding.skippedReason === null);
      const probabilities = active.map((finding) => monteCarloP(finding.exceedances, report.randomness.simulations));
      assert.deepEqual(active.map((finding) => finding.monteCarloP), probabilities);
      assert.deepEqual(active.map((finding) => finding.adjustedP), benjaminiHochberg(probabilities));
      assert.equal(active.length, report.randomness.familySize);
      assert.equal(active.filter((finding) => finding.rejectedAtFdr05).length, report.randomness.rejectionCount);
      const recomputed = runPopularityResearch(readResearchSnapshot(getDatabase()), report.randomness.seed);
      assert.deepEqual(report.popularity.gradeModels, recomputed.gradeModels);
    });
  } else console.log('[提示] 正式报告尚未生成，本次仅验收算法；生成后重复本命令会额外核验JSON。');
  console.log(`\n研究验收 ${passed}项全部通过。`);
} catch (error) { console.error(error); process.exitCode = 1; }
finally { closeDatabase(); }