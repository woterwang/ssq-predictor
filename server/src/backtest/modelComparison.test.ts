/** 小样本离线验证：不访问数据库、不运行历史回测。 */
import { describe, expect, it } from 'vitest';
import { createResearchRandom } from '../analysis/researchRandom';
import type { BacktestReport, PeriodDetail, RepetitionMetrics } from './backtestTypes';
import { adjustHolmPValues, compareModelReports, type ProbabilityScoreComparison } from './modelComparison';
import { summarizeDistribution } from './metrics';

function makeReport(name: string, scores: number[], repetitions = 3): BacktestReport {
  const actual = { redBalls: [1, 2, 3, 4, 5, 6], blueBall: 1 };
  const counts: RepetitionMetrics['prizeCounts'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, fortune: 0, none: scores.length };
  const details: PeriodDetail[] = scores.map((score, index) => ({
    issue: `2026${String(index + 1).padStart(3, '0')}`, historyCount: index + 30, historyEndIssue: index ? `2026${String(index).padStart(3, '0')}` : '2025150',
    predictionHash: 'fixture', prediction: {
      redProbabilities: Array<number>(33).fill(6 / 33), blueProbabilities: Array<number>(16).fill(1 / 16), tickets: [actual],
    }, actual: structuredClone(actual), outcomes: [{ redHits: 0, blueHit: false, grade: 'none', prizeYuan: 0 }],
    costYuan: 2, prizeYuan: 0, redLogLoss: score, redBrierScore: score, blueLogLoss: score, blueBrierScore: score,
  }));
  const meanScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return {
    definitionVersion: 'fixture-v1', strategy: { name, version: '1', parameters: {} },
    options: { startIssue: details[0].issue, endIssue: details.at(-1)!.issue, ticketsPerIssue: 1, repetitions, minimumHistory: 30, seed: 42 },
    randomAlgorithm: 'fixture-random', dataFingerprint: 'same-history',
    coverage: { trainingFirstIssue: '2025001', evaluationFirstIssue: details[0].issue, evaluationLastIssue: details.at(-1)!.issue, evaluatedIssues: scores.length },
    payoutAudit: { eligibleIssues: scores.length, withheldIssues: [] },
    repetitions: Array.from({ length: repetitions }, (_, index) => ({
      repetition: index, seed: index + 100, evaluatedIssues: scores.length, totalTickets: scores.length,
      redLogLoss: meanScore, redBrierScore: meanScore, blueLogLoss: meanScore, blueBrierScore: meanScore,
      averageRedHits: index, blueHitRate: index / 10, prizeCounts: { ...counts }, accountedPrizeCounts: { ...counts },
      totalCostYuan: scores.length * 2, accountedCostYuan: scores.length * 2, accountedPrizeYuan: index * 5,
      accountedSubsetRoi: (index * 5 - scores.length * 2) / (scores.length * 2),
      ordinaryReplayRoi: (index * 5 - scores.length * 2) / (scores.length * 2), formalRoi: null, maximumDrawdownYuan: index,
    })), distributions: {}, calibration: { theoreticalAverageRedHits: 36 / 33, theoreticalBlueHitRate: 1 / 16, firstRunRedTailP: null, firstRunBlueTailP: null },
    firstRepetitionDetails: details, limitations: [],
  };
}

function makeReports(scores = [2, 4], repetitions = 3): BacktestReport[] {
  return ['M0_uniform_random', 'M1', 'M2_frequency', 'M3'].map(name => makeReport(name, scores, repetitions));
}

function expectUnavailable(comparison: ProbabilityScoreComparison, reason: string): void {
  expect(comparison.approximateBootstrapInterval95).toBeNull();
  expect(comparison.centeredBlockBootstrapTwoSidedPValue).toBeNull();
  expect(comparison.holmAdjustedPValue).toBeNull();
  expect(comparison.inferenceUnavailableReason).toContain(reason);
}

describe('探索性配对评分比较', () => {
  it('相同两期报告手算差0，但样本不足全部推断null，固定12项', () => {
    const result = compareModelReports(makeReports(), 42, 100);
    expect(result.probabilityComparisons).toHaveLength(12);
    for (const comparison of result.probabilityComparisons) {
      expect(comparison.pairedIssues).toBe(2);
      expect(comparison.improvement).toBe(0);
      expectUnavailable(comparison, '样本不足');
    }
    expect(result.bootstrap.effectiveBlockLength).toBe(2);
    expect(result.exploratory).toBe(true);
    expect(result.historicalDataAlreadyViewed).toBe(true);
    expect(result.bootstrap.exactRandomizationTest).toBe(false);
    expect(result.automaticallyAdmittedModels).toEqual([]);
    expect(result.formalROI).toBeNull();
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('小样本正改善手算：[2,4]-[1,1]=[1,3]均值2，不报告完整环块的伪推断', () => {
    const reports = makeReports();
    reports[1] = makeReport('M1', [1, 1]);
    const comparisons = compareModelReports(reports, 9, 100).probabilityComparisons.slice(0, 4);
    for (const comparison of comparisons) {
      expect(comparison.improvement).toBe(2);
      expect(comparison.pairedIssues).toBe(2);
      expectUnavailable(comparison, '样本不足');
      expect(comparison.inferenceUnavailableReason).toContain('块过长');
    }
  });

  it('小样本负改善手算为-1，全部推断null', () => {
    const reports = makeReports();
    reports[1] = makeReport('M1', [3, 5]);
    for (const comparison of compareModelReports(reports, 9, 100).probabilityComparisons.slice(0, 4)) {
      expect(comparison.improvement).toBe(-1);
      expect(comparison.pairedIssues).toBe(2);
      expectUnavailable(comparison, '样本不足');
    }
  });

  it('固定seed可复现，模型输入排列不改变结果，输入不被修改', () => {
    const reports = makeReports(Array.from({ length: 40 }, (_, index) => [2, 4, 6, 8, 10][index % 5]));
    reports[1] = makeReport('M1', Array.from({ length: 40 }, (_, index) => [1, 3, 2, 6, 7][index % 5]));
    const original = structuredClone(reports);
    const result = compareModelReports(reports, 123, 150, 2);
    expect(compareModelReports(reports, 123, 150, 2)).toEqual(result);
    expect(compareModelReports([reports[0], reports[3], reports[1], reports[2]], 123, 150, 2)).toEqual(result);
    expect(compareModelReports(reports, 124, 150, 2).probabilityComparisons).not.toEqual(result.probabilityComparisons);
    expect(reports).toEqual(original);
  });

  it('单期合法；默认B=2000、默认块长10；评分重复不增加历史样本数', () => {
    const result = compareModelReports(makeReports([2], 40), 0);
    expect(result.bootstrap.repetitions).toBe(2000);
    expect(result.bootstrap.requestedBlockLength).toBe(10);
    expect(result.bootstrap.effectiveBlockLength).toBe(1);
    expect(result.probabilityComparisons.every(comparison => comparison.pairedIssues === 1)).toBe(true);
    result.probabilityComparisons.forEach(comparison => expectUnavailable(comparison, '样本不足'));
    expect(result.conditionalSeedDifferenceDistribution[0].pairedRepetitions).toBe(40);
  });

  it('n=31、block2独立抽样核对环块跨尾、最后截断至n及中心化双侧p公式', () => {
    const differences = Array.from({ length: 31 }, (_, index) => [31, -31, 62, -62][index % 4]);
    const reports = makeReports(Array<number>(31).fill(100));
    reports[1] = makeReport('M1', differences.map(difference => 100 - difference));
    const observedMean = 2;
    const random = createResearchRandom(123);
    const bootstrapMeans: number[] = [];
    let sawCircularWrap = false;
    for (let repetition = 0; repetition < 100; repetition++) {
      const sampledDifferences: number[] = [];
      // n=31、长度2：抽16个环块，然后只保留前31期；整数均值避免阈值末位舍入。
      for (let block = 0; block < 16; block++) {
        const start = random.integer(31);
        if (start === 30) sawCircularWrap = true;
        sampledDifferences.push(differences[start], differences[(start + 1) % 31]);
      }
      bootstrapMeans.push(sampledDifferences.slice(0, 31).reduce((sum, value) => sum + value, 0) / 31);
    }
    const exceedances = bootstrapMeans.filter(mean => Math.abs(mean - observedMean) >= Math.abs(observedMean)).length;
    const comparison = compareModelReports(reports, 123, 100, 2).probabilityComparisons[0];
    expect(sawCircularWrap).toBe(true);
    expect(comparison.improvement).toBeCloseTo(observedMean, 12);
    // 独立直接求和与实现的锚定求和有末位舍入差，区间按数值精度核对。
    const expectedInterval = summarizeDistribution(bootstrapMeans, false).outcomeInterval95;
    expect(comparison.inferenceUnavailableReason).toBeNull();
    expect(comparison.approximateBootstrapInterval95![0]).toBeCloseTo(expectedInterval[0], 12);
    expect(comparison.approximateBootstrapInterval95![1]).toBeCloseTo(expectedInterval[1], 12);
    expect(comparison.centeredBlockBootstrapTwoSidedPValue).toBe((1 + exceedances) / 101);
  });

  it.each([[10, 10, '样本不足'], [29, 2, '样本不足'], [30, 15, '块过长'], [40, 20, '块过长'], [40, 100, '块过长']] as const)(
    'n=%s、block=%s门槛不满足时全部推断null', (n, block, reason) => {
      const result = compareModelReports(makeReports(Array<number>(n).fill(2)), 42, 100, block);
      result.probabilityComparisons.forEach(comparison => expectUnavailable(comparison, reason));
      expect(result.bootstrap.effectiveBlockLength).toBe(Math.min(n, block));
      expect(result.limitations.join('；')).toContain('inferenceUnavailableReason');
    },
  );

  it.each([1, -1, 1e-12])('n40常量非零差%s禁用推断，不能报告最小p', difference => {
    const reports = makeReports(Array<number>(40).fill(2));
    reports[1] = makeReport('M1', Array<number>(40).fill(2 - difference));
    for (const comparison of compareModelReports(reports, 42, 100, 2).probabilityComparisons.slice(0, 4)) {
      expect(comparison.improvement).toBe(2 - (2 - difference));
      expect(comparison.pairedIssues).toBe(40);
      expectUnavailable(comparison, '重抽样分布无方差');
    }
  });

  it('n40近常量差的数值级方差不提供推断', () => {
    const reports = makeReports(Array<number>(40).fill(2));
    reports[1] = makeReport('M1', Array.from({ length: 40 }, (_, index) => 1 + (index % 2) * 1e-12));
    compareModelReports(reports, 42, 100, 2).probabilityComparisons.slice(0, 4)
      .forEach(comparison => expectUnavailable(comparison, '重抽样分布无方差'));
  });

  it.each([30, 40])('全零差n%s且块长充分时合法区间[0,0]、p1', n => {
    for (const comparison of compareModelReports(makeReports(Array<number>(n).fill(2)), 42, 100, 2).probabilityComparisons) {
      expect(comparison.improvement).toBe(0);
      expect(comparison.approximateBootstrapInterval95).toEqual([0, 0]);
      expect(comparison.centeredBlockBootstrapTwoSidedPValue).toBe(1);
      expect(comparison.holmAdjustedPValue).toBe(1);
      expect(comparison.inferenceUnavailableReason).toBeNull();
    }
  });

  it('部分推断不可用时用1占位，剩余项仍按12项Holm校正且不可用输出null', () => {
    const reports = makeReports(Array<number>(40).fill(10));
    reports[1] = makeReport('M1', Array<number>(40).fill(9));
    reports[2] = makeReport('M2_frequency', Array.from({ length: 40 }, (_, index) => 9 - index % 3));
    const result = compareModelReports(reports, 42, 100, 2);
    const expected = adjustHolmPValues(result.probabilityComparisons.map(comparison => comparison.centeredBlockBootstrapTwoSidedPValue ?? 1));
    result.probabilityComparisons.forEach((comparison, index) => {
      expect(comparison.holmAdjustedPValue).toBe(comparison.centeredBlockBootstrapTwoSidedPValue === null ? null : expected[index]);
    });
    result.probabilityComparisons.slice(0, 4).forEach(comparison => expectUnavailable(comparison, '重抽样分布无方差'));
    result.probabilityComparisons.slice(4, 8).forEach(comparison => {
      expect(comparison.centeredBlockBootstrapTwoSidedPValue).toBe(1 / 101);
      expect(comparison.holmAdjustedPValue).toBe(12 / 101);
      expect(comparison.inferenceUnavailableReason).toBeNull();
    });
    expect(result.multiplicity.familySize).toBe(12);
  });
});

describe('比较输入防误用', () => {
  const mismatches: Array<[string, (reports: BacktestReport[]) => void, string]> = [
    ['fingerprint', reports => { reports[1].dataFingerprint = 'different'; }, 'dataFingerprint'],
    ...(['startIssue', 'endIssue', 'ticketsPerIssue', 'repetitions', 'minimumHistory', 'seed'] as const).map(option => [
      `options.${option}`, (reports: BacktestReport[]) => {
        if (option === 'startIssue' || option === 'endIssue') reports[1].options[option] = '2026099';
        else reports[1].options[option]++;
      }, 'options',
    ] as [string, (reports: BacktestReport[]) => void, string]),
    ['actual蓝球', reports => {
      const detail = reports[1].firstRepetitionDetails[0];
      detail.actual = { ...detail.actual, blueBall: 2 };
    }, 'actual'],
    ['actual红球', reports => {
      const detail = reports[1].firstRepetitionDetails[0];
      detail.actual = { ...detail.actual, redBalls: [2, 3, 4, 5, 6, 7] };
    }, 'actual'],
    ['issue', reports => { reports[1].firstRepetitionDetails[0].issue = '2026099'; }, 'issue'],
    ['issue缺期', reports => { reports[1].firstRepetitionDetails.pop(); }, 'issue'],
    ['issue乱序', reports => { reports[1].firstRepetitionDetails.reverse(); }, 'issue'],
    ['重复评分', reports => { reports[1].repetitions[1].redLogLoss += 1e-8; }, '重复评分'],
    ['首重复不等于逐期均值', reports => { reports[1].repetitions.forEach(repetition => { repetition.blueLogLoss++; }); }, '重复评分'],
    ['逐期NaN', reports => { reports[1].firstRepetitionDetails[0].redBrierScore = NaN; }, '逐期评分'],
    ['重复Infinity', reports => { reports[1].repetitions[1].blueBrierScore = Infinity; }, '重复评分'],
    ['重复数量', reports => { reports[1].repetitions.pop(); }, 'repetition数量'],
    ['repetition编号', reports => { reports[1].repetitions[1].repetition = 2; }, 'repetition/seed'],
    ['重复seed', reports => { reports[1].repetitions[1].seed++; }, 'repetition/seed'],
    ['total cost', reports => { reports[1].repetitions[1].totalCostYuan++; }, 'cost'],
    ['eligible cost', reports => { reports[1].repetitions[1].accountedCostYuan++; }, 'cost'],
    ['payout audit', reports => { reports[1].payoutAudit.eligibleIssues--; }, 'payout audit'],
    ['formalROI', reports => { Object.assign(reports[1].repetitions[0], { formalRoi: 1 }); }, 'formalROI'],
  ];
  it.each(mismatches)('%s不一致时拒绝', (_name, modify, message) => {
    const reports = makeReports();
    modify(reports);
    expect(() => compareModelReports(reports, 42, 100)).toThrow(message);
  });

  it('1e-10内重复评分容差允许，仍只使用逐期样本', () => {
    const reports = makeReports();
    reports[1].repetitions[1].redLogLoss += 5e-11;
    expect(compareModelReports(reports, 42, 100).probabilityComparisons[0].improvement).toBe(0);
  });

  it('所有报告即使共享空逐期列表或重复issue也拒绝', () => {
    const reports = makeReports();
    reports.forEach(report => { report.firstRepetitionDetails[1].issue = report.firstRepetitionDetails[0].issue; });
    expect(() => compareModelReports(reports, 42, 100)).toThrow('issue');
    reports.forEach(report => { report.firstRepetitionDetails = []; });
    expect(() => compareModelReports(reports, 42, 100)).toThrow('不能为空');
  });

  it('空报告、非M0首、重复name、错误家族或非固定3模型拒绝', () => {
    const reports = makeReports();
    expect(() => compareModelReports([], 42, 100)).toThrow('不能为空');
    expect(() => compareModelReports([reports[1], reports[0], reports[2], reports[3]], 42, 100)).toThrow('首报告');
    expect(() => compareModelReports([reports[0], reports[1], reports[1], reports[3]], 42, 100)).toThrow('name重复');
    expect(() => compareModelReports(reports.slice(0, 3), 42, 100)).toThrow('4份');
    reports[3].strategy.name = 'M2_another';
    expect(() => compareModelReports(reports, 42, 100)).toThrow('模型家族重复');
  });

  it.each([99, 100001, 100.5, NaN, Infinity])('bootstrap=%s拒绝', repetitions => {
    expect(() => compareModelReports(makeReports(), 42, repetitions)).toThrow('bootstrapRepetitions');
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('非法blockLength=%s拒绝', blockLength => {
    expect(() => compareModelReports(makeReports(), 42, 100, blockLength)).toThrow('blockLength');
  });
  it.each([-1, 1.5, 0x100000000, NaN])('非法seed=%s拒绝', seed => {
    expect(() => compareModelReports(makeReports(), seed, 100)).toThrow('seed');
  });
});

describe('整段条件种子差分与Holm', () => {
  it('同seed整段model-baseline差分，不当作历史模型优势；收益正态区间禁用', () => {
    const reports = makeReports([2, 4], 40);
    reports[1].repetitions.forEach(repetition => {
      repetition.averageRedHits += 1;
      repetition.blueHitRate += .1;
      repetition.accountedPrizeYuan += repetition.repetition * 10;
      repetition.accountedSubsetRoi! += repetition.repetition * 10 / repetition.accountedCostYuan;
      repetition.ordinaryReplayRoi = repetition.accountedSubsetRoi;
    });
    const distribution = compareModelReports(reports, 42, 100).conditionalSeedDifferenceDistribution[0];
    expect(distribution.direction).toBe('model - baseline');
    expect(distribution.pairedRepetitions).toBe(40);
    expect(distribution.averageRedHits.mean).toBe(1);
    expect(distribution.blueHitRate.mean).toBeCloseTo(.1, 12);
    expect(distribution.accountedPrizeYuan.mean).toBe(195);
    expect(distribution.accountedNetYuan).toEqual(distribution.accountedPrizeYuan);
    expect(distribution.accountedPrizeYuan.monteCarloMeanInterval95).toBeNull();
    expect(distribution.accountedSubsetRoi!.monteCarloMeanInterval95).toBeNull();
    expect(distribution.ordinaryReplayRoi!.monteCarloMeanInterval95).toBeNull();
    expect(distribution.maximumDrawdownYuan!.monteCarloMeanInterval95).toBeNull();
    expect(distribution.formalROI).toBeNull();
  });

  it('未核算期一致时保留收益null；不一致的暂停理由或收益null拒绝', () => {
    const reports = makeReports();
    reports.forEach(report => {
      report.payoutAudit = { eligibleIssues: 0, withheldIssues: report.firstRepetitionDetails.map(detail => ({ issue: detail.issue, reasons: ['未核实活动'] })) };
      report.firstRepetitionDetails.forEach(detail => { detail.prizeYuan = null; });
      report.repetitions.forEach(repetition => {
        repetition.accountedCostYuan = 0; repetition.accountedPrizeYuan = 0;
        repetition.accountedSubsetRoi = null; repetition.ordinaryReplayRoi = null; repetition.maximumDrawdownYuan = null;
      });
    });
    expect(compareModelReports(reports, 42, 100).conditionalSeedDifferenceDistribution[0].accountedSubsetRoi).toBeNull();
    reports[1].payoutAudit.withheldIssues[0].reasons = ['另一理由'];
    expect(() => compareModelReports(reports, 42, 100)).toThrow('payout audit');
    reports[1].payoutAudit.withheldIssues[0].reasons = ['未核实活动'];
    reports[1].repetitions[0].ordinaryReplayRoi = 0;
    expect(() => compareModelReports(reports, 42, 100)).toThrow('null');
  });

  it('Holm简单手算、原顺序、并列、单调累积和截断为1', () => {
    const input = [.04, .01, .03, .8];
    expect(adjustHolmPValues(input)).toEqual([.09, .04, .09, .8]);
    expect(input).toEqual([.04, .01, .03, .8]);
    expect(adjustHolmPValues([.02, .02, .5])).toEqual([.06, .06, .5]);
    expect(adjustHolmPValues([.6, .7])).toEqual([1, 1]);
    expect(adjustHolmPValues([0, 1])).toEqual([0, 1]);
    expect(adjustHolmPValues([])).toEqual([]);
    for (const value of [-.1, 1.1, NaN, Infinity]) expect(() => adjustHolmPValues([value])).toThrow('Holm');
  });
});