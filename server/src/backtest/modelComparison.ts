/** 探索性历史模型比较：历史期是评分样本，整段随机重复只用于条件种子差分。 */
import { createResearchRandom, RANDOM_ALGORITHM } from '../analysis/researchRandom';
import type { BacktestReport, MetricDistribution, RepetitionMetrics, ScoreMetrics } from './backtestTypes';
import { summarizeDistribution } from './metrics';
import { assertLegalTicket, TICKET_PRICE_YUAN } from './prizeRules';

const SCORE_NAMES = ['redLogLoss', 'redBrierScore', 'blueLogLoss', 'blueBrierScore'] as const;
const OPTION_NAMES = ['startIssue', 'endIssue', 'ticketsPerIssue', 'repetitions', 'minimumHistory', 'seed'] as const;
const SCORE_TOLERANCE = 1e-10;
type ScoreName = keyof ScoreMetrics;

export interface ProbabilityScoreComparison {
  modelName: string;
  metric: ScoreName;
  pairedIssues: number;
  /** baseline - model；正值仅表示历史平均损失较小。 */
  improvement: number;
  approximateBootstrapInterval95: [number, number] | null;
  centeredBlockBootstrapTwoSidedPValue: number | null;
  holmAdjustedPValue: number | null;
  inferenceUnavailableReason: string | null;
}

export interface ConditionalSeedDifferenceDistribution {
  modelName: string;
  direction: 'model - baseline';
  pairedRepetitions: number;
  averageRedHits: MetricDistribution;
  blueHitRate: MetricDistribution;
  prizeCounts: Record<string, MetricDistribution>;
  accountedPrizeCounts: Record<string, MetricDistribution>;
  accountedPrizeYuan: MetricDistribution;
  accountedNetYuan: MetricDistribution;
  accountedSubsetRoi: MetricDistribution | null;
  ordinaryReplayRoi: MetricDistribution | null;
  maximumDrawdownYuan: MetricDistribution | null;
  formalROI: null;
}

export interface ModelComparisonReport {
  definitionVersion: 'exploratory-model-comparison-v1';
  exploratory: true;
  historicalDataAlreadyViewed: true;
  automaticallyAdmittedModels: [];
  formalROI: null;
  baselineName: string;
  dataFingerprint: string;
  options: BacktestReport['options'];
  issues: string[];
  bootstrap: {
    method: 'moving-circular-block-bootstrap';
    seed: number;
    randomAlgorithm: string;
    repetitions: number;
    requestedBlockLength: number;
    effectiveBlockLength: number;
    intervalMethod: 'approximate-percentile-95';
    pValueMethod: 'centered-bootstrap-two-sided-plus-one';
    exactRandomizationTest: false;
  };
  multiplicity: { method: 'Holm'; familySize: 12 };
  probabilityComparisons: ProbabilityScoreComparison[];
  conditionalSeedDifferenceDistribution: ConditionalSeedDifferenceDistribution[];
  limitations: string[];
}

/** Holm逐步下降校正；返回原顺序，不排序或修改输入。 */
export function adjustHolmPValues(pValues: readonly number[]): number[] {
  if (pValues.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error('Holm p值必须是[0,1]有限数');
  }
  const ordered = pValues.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const adjusted = new Array<number>(pValues.length);
  let previousAdjusted = 0;
  ordered.forEach(({ value, index }, rank) => {
    previousAdjusted = Math.max(previousAdjusted, Math.min(1, value * (pValues.length - rank)));
    adjusted[index] = previousAdjusted;
  });
  return adjusted;
}

/** 锚定均值，使完全相同的差值精确保持常量，避免零差被舍入成非零。 */
function stableMean(values: readonly number[]): number {
  const anchor = values[0];
  const mean = anchor + values.reduce((sum, value) => sum + (value - anchor), 0) / values.length;
  if (!Number.isFinite(mean)) throw new Error('评分差均值非有限数');
  return mean;
}

function modelFamily(name: string): number {
  // 兼容引擎现有M0_uniform_random及带可读后缀的M1/M2/M3名称。
  const matched = /^M([0-3])(?:_|$)/.exec(name);
  if (!matched) throw new Error('报告名称必须属于M0、M1、M2、M3');
  return Number(matched[1]);
}

function assertComparableReports(reports: readonly BacktestReport[]): BacktestReport[] {
  if (reports.length === 0) throw new Error('报告不能为空');
  if (modelFamily(reports[0].strategy.name) !== 0) throw new Error('首报告必须为M0基线');
  if (reports.length !== 4) throw new Error('固定比较M0与M1、M2、M3，必须提供4份报告');
  if (new Set(reports.map(report => report.strategy.name)).size !== reports.length) throw new Error('报告name重复');
  const families = reports.map(report => modelFamily(report.strategy.name));
  if (new Set(families).size !== 4) throw new Error('模型家族重复：必须恰好包含M0、M1、M2、M3');
  const baseline = reports[0];
  const details = baseline.firstRepetitionDetails;
  if (details.length === 0) throw new Error('逐期评分样本不能为空');
  if (!Number.isSafeInteger(baseline.options.repetitions) || baseline.options.repetitions < 1
    || !Number.isSafeInteger(baseline.options.ticketsPerIssue) || baseline.options.ticketsPerIssue < 1) {
    throw new Error('options重复数/注数非法');
  }
  const expectedPeriodCost = baseline.options.ticketsPerIssue * TICKET_PRICE_YUAN;
  const expectedTotalCost = details.length * expectedPeriodCost;
  const expectedTickets = details.length * baseline.options.ticketsPerIssue;

  for (const report of reports) {
    if (report.dataFingerprint !== baseline.dataFingerprint) throw new Error('dataFingerprint不一致');
    if (OPTION_NAMES.some(name => report.options[name] !== baseline.options[name])) throw new Error('options不一致');
    if (report.definitionVersion !== baseline.definitionVersion || report.randomAlgorithm !== baseline.randomAlgorithm) {
      throw new Error('回测定义或随机算法不一致');
    }
    if (report.firstRepetitionDetails.length !== details.length) throw new Error('issue列表长度不一致');
    const coverage = report.coverage;
    if (coverage.evaluatedIssues !== details.length || coverage.evaluationFirstIssue !== details[0].issue
      || coverage.evaluationLastIssue !== details.at(-1)!.issue
      || coverage.trainingFirstIssue !== baseline.coverage.trainingFirstIssue
      || report.options.startIssue !== details[0].issue || report.options.endIssue !== details.at(-1)!.issue) {
      throw new Error('issue覆盖范围与options不一致');
    }
    const audit = report.payoutAudit;
    const withheld = new Map(audit.withheldIssues.map(entry => [entry.issue, [...entry.reasons].sort()]));
    const baselineWithheld = new Map(baseline.payoutAudit.withheldIssues.map(entry => [entry.issue, [...entry.reasons].sort()]));
    if (!Number.isSafeInteger(audit.eligibleIssues) || audit.eligibleIssues < 0
      || audit.eligibleIssues + audit.withheldIssues.length !== details.length
      || withheld.size !== audit.withheldIssues.length || audit.eligibleIssues !== baseline.payoutAudit.eligibleIssues
      || withheld.size !== baselineWithheld.size
      || [...withheld].some(([issue, reasons]) => !details.some(detail => detail.issue === issue)
        || JSON.stringify(reasons) !== JSON.stringify(baselineWithheld.get(issue)))) {
      throw new Error('payout audit不一致或非法');
    }
    report.firstRepetitionDetails.forEach((detail, index) => {
      const baselineDetail = details[index];
      if (detail.issue !== baselineDetail.issue || (index > 0 && detail.issue <= details[index - 1].issue)) {
        throw new Error('issue列表必须相同、严格递增且不重复');
      }
      assertLegalTicket(detail.actual);
      if (detail.actual.blueBall !== baselineDetail.actual.blueBall
        || [...detail.actual.redBalls].sort((left, right) => left - right).join(',')
          !== [...baselineDetail.actual.redBalls].sort((left, right) => left - right).join(',')) {
        throw new Error('actual开奖号值不一致');
      }
      if (detail.historyCount !== baselineDetail.historyCount || detail.historyEndIssue !== baselineDetail.historyEndIssue) {
        throw new Error('逐期训练历史不一致');
      }
      if (SCORE_NAMES.some(name => !Number.isFinite(detail[name]))) throw new Error('逐期评分必须有限');
      if (detail.costYuan !== expectedPeriodCost || (detail.prizeYuan === null) !== withheld.has(detail.issue)
        || (detail.prizeYuan !== null && (!Number.isFinite(detail.prizeYuan) || detail.prizeYuan < 0))) {
        throw new Error('逐期成本或payout audit不一致');
      }
    });
    if (report.repetitions.length !== report.options.repetitions) throw new Error('repetition数量与options不一致');
    const firstRepetition = report.repetitions[0];
    const meanForScore = (name: ScoreName): number => stableMean(report.firstRepetitionDetails.map(detail => detail[name]));
    const periodMeans: ScoreMetrics = {
      redLogLoss: meanForScore('redLogLoss'), redBrierScore: meanForScore('redBrierScore'),
      blueLogLoss: meanForScore('blueLogLoss'), blueBrierScore: meanForScore('blueBrierScore'),
    };
    const expectedAccountedCost = audit.eligibleIssues * expectedPeriodCost;
    report.repetitions.forEach((repetition, index) => {
      const baselineRepetition = baseline.repetitions[index];
      if (!baselineRepetition || repetition.repetition !== index || repetition.repetition !== baselineRepetition.repetition
        || repetition.seed !== baselineRepetition.seed) throw new Error('对应repetition/seed不一致');
      createResearchRandom(repetition.seed);
      if (repetition.evaluatedIssues !== details.length || repetition.totalTickets !== expectedTickets
        || repetition.totalCostYuan !== expectedTotalCost || repetition.accountedCostYuan !== expectedAccountedCost
        || repetition.totalCostYuan !== baselineRepetition.totalCostYuan
        || repetition.accountedCostYuan !== baselineRepetition.accountedCostYuan) {
        throw new Error('对应重复total cost/eligible cost不一致');
      }
      if (repetition.formalRoi !== null) throw new Error('formalROI必须保持null');
      for (const name of SCORE_NAMES) {
        if (!Number.isFinite(repetition[name]) || Math.abs(repetition[name] - firstRepetition[name]) > SCORE_TOLERANCE
          || Math.abs(firstRepetition[name] - periodMeans[name]) > SCORE_TOLERANCE) {
          throw new Error('重复评分必须有限且等于首重复评分/逐期均值；禁止对随机概率模型误用首重复');
        }
      }
    });
  }
  // 统一模型顺序，输入M1/M2/M3的排列不改变随机抽样流与Holm家族。
  return [...reports.slice(1)].sort((left, right) => modelFamily(left.strategy.name) - modelFamily(right.strategy.name));
}

function bootstrapPairedImprovement(
  differences: readonly number[], random: ReturnType<typeof createResearchRandom>,
  repetitions: number, blockLength: number,
): Pick<ProbabilityScoreComparison, 'improvement' | 'approximateBootstrapInterval95'
  | 'centeredBlockBootstrapTwoSidedPValue' | 'inferenceUnavailableReason'> {
  if (differences.some(value => !Number.isFinite(value))) throw new Error('逐期评分差必须有限');
  const improvement = stableMean(differences);
  const unavailable = (reason: string) => ({
    improvement, approximateBootstrapInterval95: null,
    centeredBlockBootstrapTwoSidedPValue: null, inferenceUnavailableReason: reason,
  });
  const insufficientReasons: string[] = [];
  if (differences.length < 30) insufficientReasons.push(`样本不足：n=${differences.length}<30`);
  if (blockLength * 2 >= differences.length) {
    insufficientReasons.push(`块过长：effectiveBlockLength=${blockLength}，两倍块长>=n=${differences.length}`);
  }
  // 门槛未满足时不消耗bootstrap随机流，仍保留描述性平均差。
  if (insufficientReasons.length) return unavailable(insufficientReasons.join('；'));
  const anchor = differences[0];
  const bootstrapMeans: number[] = [];
  let centeredExceedances = 0;
  for (let repetition = 0; repetition < repetitions; repetition++) {
    let sampledCount = 0;
    let centeredSum = 0;
    while (sampledCount < differences.length) {
      const startIndex = random.integer(differences.length);
      // 环形连续块；最后一块截断，保证每次恰好重抽n期而非n个重复。
      for (let offset = 0; offset < blockLength && sampledCount < differences.length; offset++) {
        centeredSum += differences[(startIndex + offset) % differences.length] - anchor;
        sampledCount++;
      }
    }
    const bootstrapMean = anchor + centeredSum / differences.length;
    bootstrapMeans.push(bootstrapMean);
    if (Math.abs(bootstrapMean - improvement) >= Math.abs(improvement)) centeredExceedances++;
  }
  if (!differences.every(value => value === 0)) {
    const bootstrapMean = stableMean(bootstrapMeans);
    const differenceScale = differences.reduce((scale, value) => Math.max(scale, Math.abs(value)), 0);
    // 相对原始差值尺度检测近零方差，先归一化避免平方溢出/下溢。
    const relativeVariance = bootstrapMeans.reduce((sum, value) =>
      sum + ((value - bootstrapMean) / differenceScale) ** 2, 0) / bootstrapMeans.length;
    if (relativeVariance <= Number.EPSILON) return unavailable('重抽样分布无方差（或方差接近数值精度）；非全零差不能据此推断');
  }
  return {
    improvement,
    approximateBootstrapInterval95: summarizeDistribution(bootstrapMeans, false).outcomeInterval95,
    centeredBlockBootstrapTwoSidedPValue: (1 + centeredExceedances) / (repetitions + 1),
    inferenceUnavailableReason: null,
  };
}

function conditionalDifferences(model: BacktestReport, baseline: BacktestReport): ConditionalSeedDifferenceDistribution {
  const differenceDistribution = (
    readValue: (repetition: RepetitionMetrics) => number | null, allowNormalMeanInterval = false,
  ): MetricDistribution | null => {
    const differences: number[] = [];
    model.repetitions.forEach((repetition, index) => {
      const modelValue = readValue(repetition);
      const baselineValue = readValue(baseline.repetitions[index]);
      if ((modelValue === null) !== (baselineValue === null)) throw new Error('对应重复收益字段的null口径不一致');
      if (modelValue !== null && baselineValue !== null) differences.push(modelValue - baselineValue);
    });
    if (differences.length === 0) return null;
    if (differences.length !== model.repetitions.length) throw new Error('重复收益字段不能部分缺失');
    return summarizeDistribution(differences, allowNormalMeanInterval);
  };
  const countDistributions = (field: 'prizeCounts' | 'accountedPrizeCounts'): Record<string, MetricDistribution> => {
    const grades = Object.keys(baseline.repetitions[0][field]);
    for (const report of [model, baseline]) {
      for (const repetition of report.repetitions) {
        if (Object.keys(repetition[field]).sort().join(',') !== [...grades].sort().join(',')) {
          throw new Error('命中奖级计数字段不一致');
        }
      }
    }
    return Object.fromEntries(grades.map(grade => [grade,
      differenceDistribution(repetition => repetition[field][grade as keyof RepetitionMetrics['prizeCounts']], true)!]));
  };
  return {
    modelName: model.strategy.name, direction: 'model - baseline', pairedRepetitions: model.repetitions.length,
    averageRedHits: differenceDistribution(repetition => repetition.averageRedHits, true)!,
    blueHitRate: differenceDistribution(repetition => repetition.blueHitRate, true)!,
    prizeCounts: countDistributions('prizeCounts'), accountedPrizeCounts: countDistributions('accountedPrizeCounts'),
    accountedPrizeYuan: differenceDistribution(repetition => repetition.accountedPrizeYuan)!,
    accountedNetYuan: differenceDistribution(repetition => repetition.accountedPrizeYuan - repetition.accountedCostYuan)!,
    accountedSubsetRoi: differenceDistribution(repetition => repetition.accountedSubsetRoi),
    ordinaryReplayRoi: differenceDistribution(repetition => repetition.ordinaryReplayRoi),
    maximumDrawdownYuan: differenceDistribution(repetition => repetition.maximumDrawdownYuan), formalROI: null,
  };
}

/** 固定3模型×4评分的探索性比较；不写库、不运行回测、不自动准入模型。 */
export function compareModelReports(
  reports: readonly BacktestReport[], seed: number, bootstrapRepetitions = 2000, blockLength = 10,
): ModelComparisonReport {
  if (!Number.isSafeInteger(bootstrapRepetitions) || bootstrapRepetitions < 100 || bootstrapRepetitions > 100000) {
    throw new Error('bootstrapRepetitions必须为100–100000整数');
  }
  if (!Number.isSafeInteger(blockLength) || blockLength < 1) throw new Error('blockLength必须为安全正整数');
  const random = createResearchRandom(seed);
  const models = assertComparableReports(reports);
  const baseline = reports[0];
  const effectiveBlockLength = Math.min(blockLength, baseline.firstRepetitionDetails.length);
  // 先验证整段条件差分，收益不提供正态均值区间，更不当作历史模型优势。
  const conditionalSeedDifferenceDistribution = models.map(model => conditionalDifferences(model, baseline));
  const probabilityComparisons: ProbabilityScoreComparison[] = models.flatMap(model => SCORE_NAMES.map(metric => ({
    modelName: model.strategy.name, metric, pairedIssues: baseline.firstRepetitionDetails.length,
    ...bootstrapPairedImprovement(baseline.firstRepetitionDetails.map((detail, index) =>
      detail[metric] - model.firstRepetitionDetails[index][metric]), random, bootstrapRepetitions, effectiveBlockLength),
    holmAdjustedPValue: null,
  })));
  // 未计算项以p=1参与固定12项家族，但对外仍输出null，不能缩小家族。
  const adjustedPValues = adjustHolmPValues(probabilityComparisons.map(comparison => comparison.centeredBlockBootstrapTwoSidedPValue ?? 1));
  probabilityComparisons.forEach((comparison, index) => {
    comparison.holmAdjustedPValue = comparison.centeredBlockBootstrapTwoSidedPValue === null ? null : adjustedPValues[index];
  });
  return {
    definitionVersion: 'exploratory-model-comparison-v1', exploratory: true, historicalDataAlreadyViewed: true,
    automaticallyAdmittedModels: [], formalROI: null, baselineName: baseline.strategy.name,
    dataFingerprint: baseline.dataFingerprint, options: { ...baseline.options },
    issues: baseline.firstRepetitionDetails.map(detail => detail.issue),
    bootstrap: {
      method: 'moving-circular-block-bootstrap', seed, randomAlgorithm: RANDOM_ALGORITHM, repetitions: bootstrapRepetitions,
      requestedBlockLength: blockLength, effectiveBlockLength, intervalMethod: 'approximate-percentile-95',
      pValueMethod: 'centered-bootstrap-two-sided-plus-one', exactRandomizationTest: false,
    },
    multiplicity: { method: 'Holm', familySize: 12 }, probabilityComparisons, conditionalSeedDifferenceDistribution,
    limitations: [
      '历史已被查看，所有比较均为探索性分析，不是未触碰保留段验证；任何结果均不自动准入模型。',
      '评分以相同期的baseline-model配对差为样本；随机重复的评分绝不当作独立历史样本。',
      '仅在全部重复汇总评分与首重复一致（绝对误差1e-10内）时使用首重复逐期详情；汇总一致不能证明隐藏的逐期随机概率完全一致。',
      '95%区间是moving circular block bootstrap近似百分位区间；中心化块bootstrap双侧p值非精确随机化检验。',
      '块长度默认为10，有效块长为min(blockLength,n)，每次重抽至n；n<30或两倍有效块长>=n时不计算bootstrap，区间及两个p值为null，原因见inferenceUnavailableReason；平均差仍是描述性结果。',
      '非全零差的重抽样均值分布无方差或相对方差<=Number.EPSILON时禁用全部推断，常量非零差不能报告最小p值；全零差在样本及块长门槛满足时可报告[0,0]与p=1。块依赖假设及长度选择仍影响近似结果。',
      '固定M1/M2/M3与四评分共12项统一Holm校正；不可计算项以p=1占位参与校正但输出null，可计算项仍按12项家族校正；未覆盖已看历史上的参数搜索或其他事后选择。',
      'conditionalSeedDifferenceDistribution仅是同seed整段重复的model-baseline条件差分分布，不称模型优势；相同种子不保证不同模型的随机调用路径相同。',
      '收益为相同审计子集的税前公告金额回放；重尾收益禁用正态均值区间，正式formalROI始终为null。',
    ],
  };
}