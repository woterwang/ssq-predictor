/**
 * 热度是投注选择的描述，不是开奖概率。分别拟合一、二、三等奖注数，
 * Poisson log(mu)=log(T*p)+截距+标准化组合特征，零计数天然可用，无伪计数。
 * 三等奖为5红+蓝邻域汇总，绝不能用作中奖六红精准组合的撞号概率。
 */
import { Matrix, SingularValueDecomposition } from 'ml-matrix';
import type { AnalysisDraw } from './analysisTypes';
import { calculateDrawFeatures } from './drawFeatures';
import type { ResearchDraw } from '../db/analysisRepository';
import { createResearchRandom } from './researchRandom';
import { findDrawSequenceProblems } from '../collector/drawSequenceValidator';

export const TOTAL_TICKET_COMBINATIONS = 17721088;
export const GRADE_PROBABILITIES = [1, 15, 162].map((numerator) => numerator / TOTAL_TICKET_COMBINATIONS);
export const POPULARITY_FEATURES = [
  { name: 'birthdayCount', definition: '红球≤31个数，仅数字生日代理，不臆测具体图形' },
  { name: 'consecutivePairs', definition: '升序红球相差1的相邻对数' },
  { name: 'sameTailPairs', definition: '红球同个位的两两配对数ΣC(尾数频次,2)' },
  { name: 'arithmeticTriples', definition: '三个不同红球构成等差数列的三元组数量' },
  { name: 'previousRedRepeat', definition: '与紧邻上期的红球重号数；首期/缺口不可计算而非填0' },
] as const;
export const POPULARITY_MODEL_VERSION = 'poisson-offset-svd-irls-v1';
export const HOLDOUT_FIRST_ISSUE = '2023001';

export function calculatePopularityFeatures(draw: AnalysisDraw, previous: AnalysisDraw | null): number[] | null {
  if (previous === null) return null;
  const feature = calculateDrawFeatures(draw, previous);
  const reds = [...draw.redBalls].sort((a, b) => a - b);
  let arithmeticTriples = 0;
  for (let left = 0; left < 4; left++) for (let middle = left + 1; middle < 5; middle++)
    for (let right = middle + 1; right < 6; right++) if (reds[left] + reds[right] === 2 * reds[middle]) arithmeticTriples++;
  return [reds.filter((number) => number <= 31).length, feature.consecutivePairCount,
    feature.redTailCounts.reduce((pairs, count) => pairs + count * (count - 1) / 2, 0), arithmeticTriples,
    feature.repeatedRedCount!];
}

export function calculateTicketHeat(sales: number | null, count: number | null, grade: number) {
  if (![1, 2, 3].includes(grade)) throw new Error('热度只支持奖级1/2/3');
  // 销售额应为安全整数元，奇数销售额不能无声当作半注；有问题记录保留排除理由。
  if (sales === null || !Number.isSafeInteger(sales) || sales <= 0 || sales % 2 !== 0
    || count === null || !Number.isSafeInteger(count) || count < 0) return null;
  const tickets = sales / 2;
  const expected = tickets * GRADE_PROBABILITIES[grade - 1];
  return { tickets, probability: GRADE_PROBABILITIES[grade - 1], observed: count, expected, ratio: count / expected };
}

export interface PoissonObservation { features: number[]; expected: number; observed: number }
interface PoissonModel {
  coefficients: number[]; means: number[]; scales: number[]; activeColumns: number[];
  iterations: number; converged: boolean; conditionNumber: number; trainingDispersion: number;
}
function designRow(features: readonly number[], model: Pick<PoissonModel, 'means' | 'scales' | 'activeColumns'>): number[] {
  return [1, ...model.activeColumns.map((column) => (features[column] - model.means[column]) / model.scales[column])];
}
function linearPredictor(row: readonly number[], coefficients: readonly number[]): number {
  return row.reduce((sum, value, index) => sum + value * coefficients[index], 0);
}
function poissonObjective(rows: readonly PoissonObservation[], design: number[][], coefficients: number[]): number {
  let objective = 0;
  for (let index = 0; index < rows.length; index++) {
    const eta = Math.log(rows[index].expected) + linearPredictor(design[index], coefficients);
    if (!Number.isFinite(eta) || Math.abs(eta) > 40) return Infinity;
    objective += Math.exp(eta) - rows[index].observed * eta; // 与参数无关的log(y!)省略。
  }
  return objective;
}

/** IRLS每一步直接对sqrt(mu)*X做SVD，不形成病态的X'WX正规方程；线搜索防发散。 */
export function fitPoissonOffset(rows: readonly PoissonObservation[], featureCount: number): PoissonModel {
  if (!Number.isInteger(featureCount) || featureCount < 0 || rows.length < Math.max(20, featureCount * 10)) throw new Error('GLM训练样本不足');
  if (rows.some((row) => row.features.length !== featureCount || row.features.some((value) => !Number.isFinite(value))
    || !Number.isFinite(row.expected) || row.expected <= 0 || !Number.isSafeInteger(row.observed) || row.observed < 0)) throw new Error('GLM输入非法');
  const totalObserved = rows.reduce((sum, row) => sum + row.observed, 0);
  if (totalObserved === 0) throw new Error('训练计数全为0，有限Poisson截距不存在');
  // 标准化只看训练段，不允许后续评估段影响设计矩阵。
  const means = Array.from({ length: featureCount }, (_, column) => rows.reduce((sum, row) => sum + row.features[column], 0) / rows.length);
  const scales = means.map((mean, column) => Math.sqrt(rows.reduce((sum, row) => sum + (row.features[column] - mean) ** 2, 0) / rows.length));
  const activeColumns = scales.flatMap((scale, index) => scale > 1e-10 ? [index] : []);
  const design = rows.map((row) => designRow(row.features, { means, scales, activeColumns }));
  let coefficients = [Math.log(totalObserved / rows.reduce((sum, row) => sum + row.expected, 0)), ...activeColumns.map(() => 0)];
  let converged = false, iterations = 0, conditionNumber = 0;
  for (let iteration = 0; iteration < 100; iteration++) {
    iterations = iteration + 1;
    const weights = rows.map((row, index) => row.expected * Math.exp(linearPredictor(design[index], coefficients)));
    const weightedDesign = new Matrix(design.map((row, index) => row.map((value) => value * Math.sqrt(weights[index]))));
    const response = Matrix.columnVector(rows.map((row, index) => Math.sqrt(weights[index])
      * (linearPredictor(design[index], coefficients) + (row.observed - weights[index]) / weights[index])));
    const decomposition = new SingularValueDecomposition(weightedDesign, { autoTranspose: true });
    conditionNumber = decomposition.condition;
    if (decomposition.rank < coefficients.length || !Number.isFinite(conditionNumber) || conditionNumber > 1e8) {
      throw new Error(`GLM参数不可辨识/病态，condition=${conditionNumber}`);
    }
    const candidate = decomposition.solve(response).to1DArray();
    const oldObjective = poissonObjective(rows, design, coefficients);
    let step = 1;
    let next = candidate;
    while (poissonObjective(rows, design, next) > oldObjective + 1e-8 && step > 1 / 65536) {
      step /= 2; next = coefficients.map((value, index) => value + step * (candidate[index] - value));
    }
    if (!Number.isFinite(poissonObjective(rows, design, next)) || next.some((value) => Math.abs(value) > 30)
      || poissonObjective(rows, design, next) > oldObjective + 1e-8) throw new Error('GLM线搜索失败/参数越界');
    const difference = Math.max(...next.map((value, index) => Math.abs(value - coefficients[index])));
    coefficients = next;
    if (difference < 1e-8) { converged = true; break; }
  }
  if (!converged) throw new Error('GLM未收敛，不输出伪有效模型');
  const trainingDispersion = rows.reduce((sum, row, index) => {
    const mean = row.expected * Math.exp(linearPredictor(design[index], coefficients));
    return sum + (row.observed - mean) ** 2 / mean;
  }, 0) / (rows.length - coefficients.length);
  return { coefficients, means, scales, activeColumns, iterations, converged, conditionNumber, trainingDispersion };
}

export function predictPoissonCount(row: PoissonObservation, model: PoissonModel): number {
  const eta = Math.log(row.expected) + linearPredictor(designRow(row.features, model), model.coefficients);
  if (!Number.isFinite(eta) || Math.abs(eta) > 40) throw new Error('样本外预测越界');
  return Math.exp(eta);
}

function evaluate(rows: readonly PoissonObservation[], model: PoissonModel) {
  let countAbsolute = 0, countSquared = 0, ratioAbsolute = 0, ratioSquared = 0, deviance = 0;
  const countSquaredLosses: number[] = [];
  for (const row of rows) {
    const predicted = predictPoissonCount(row, model), residual = row.observed - predicted;
    countAbsolute += Math.abs(residual); countSquared += residual ** 2; countSquaredLosses.push(residual ** 2);
    ratioAbsolute += Math.abs(residual / row.expected); ratioSquared += (residual / row.expected) ** 2;
    deviance += 2 * (row.observed === 0 ? predicted : row.observed * Math.log(row.observed / predicted) - residual);
  }
  return { countMAE: countAbsolute / rows.length, countRMSE: Math.sqrt(countSquared / rows.length),
    ratioMAE: ratioAbsolute / rows.length, ratioRMSE: Math.sqrt(ratioSquared / rows.length),
    meanPoissonDeviance: deviance / rows.length, countSquaredLosses };
}

/** 配对移动块bootstrap仅描述这次时间留出段的损失改进，不当作前瞻确认。 */
function bootstrapImprovement(differences: number[], seed: number) {
  const random = createResearchRandom(seed), estimates: number[] = [];
  const blockLength = Math.min(12, differences.length), runs = 2000;
  for (let run = 0; run < runs; run++) {
    let sum = 0, taken = 0;
    while (taken < differences.length) {
      const start = random.integer(differences.length - blockLength + 1);
      for (let offset = 0; offset < blockLength && taken < differences.length; offset++, taken++) sum += differences[start + offset];
    }
    estimates.push(sum / differences.length);
  }
  estimates.sort((a, b) => a - b);
  return { runs, seed, blockLength, definition: '基线平方计数误差−GLM平方计数误差，正值表示改进；配对移动块bootstrap百分位区间',
    meanImprovement: differences.reduce((sum, value) => sum + value, 0) / differences.length,
    interval95: [estimates[Math.floor(runs * 0.025)], estimates[Math.floor(runs * 0.975)]],
    // 三个奖级同时观察，报告更保守的Bonferroni家族区间，避免只挑好看的模型。
    familywiseInterval95: [estimates[Math.floor(runs * 0.05 / 6)], estimates[Math.floor(runs * (1 - 0.05 / 6))]],
  };
}

export function runPopularityResearch(draws: readonly ResearchDraw[], seed: number) {
  const problems = findDrawSequenceProblems(draws);
  const unsafeYears = new Set(problems.filter((problem) => problem.problemType === 'possible_missing_year_end').map((problem) => problem.issue?.slice(0, 4)));
  const observations = draws.map((draw, index) => {
    const previous = draws[index - 1];
    const adjacent = previous !== undefined && (draw.issue.slice(0, 4) === previous.issue.slice(0, 4)
      ? Number(draw.issue.slice(4)) === Number(previous.issue.slice(4)) + 1
      : Number(draw.issue.slice(0, 4)) === Number(previous.issue.slice(0, 4)) + 1 && draw.issue.endsWith('001') && !unsafeYears.has(previous.issue.slice(0, 4)));
    const features = calculatePopularityFeatures(draw, adjacent ? previous : null);
    return { issue: draw.issue, features,
      grades: [1, 2, 3].map((grade) => {
        const matches = draw.prizeGrades.filter((detail) => detail.grade === grade);
        const heat = calculateTicketHeat(draw.salesAmountYuan, matches.length === 1 ? matches[0].winningTicketCount : null, grade);
        return { grade, ...heat, exclusionReason: heat === null ? '销售额/奖级计数缺失、非法或奖级重复' : null };
      }), featureExclusionReason: features === null ? '无可比紧邻上期' : null };
  });
  const gradeModels = [1, 2, 3].map((grade) => {
    const eligible = observations.flatMap((row) => {
      const heat = row.grades[grade - 1];
      return row.features !== null && heat.expected !== undefined && heat.observed !== undefined
        ? [{ issue: row.issue, features: row.features, expected: heat.expected, observed: heat.observed }] : [];
    });
    const training = eligible.filter((row) => row.issue < HOLDOUT_FIRST_ISSUE);
    const evaluation = eligible.filter((row) => row.issue >= HOLDOUT_FIRST_ISSUE);
    const coverage = { grade, eligibleCount: eligible.length, excludedCount: draws.length - eligible.length,
      trainingCount: training.length, trainingFirstIssue: training[0]?.issue ?? null, trainingLastIssue: training.at(-1)?.issue ?? null,
      evaluationCount: evaluation.length, evaluationFirstIssue: evaluation[0]?.issue ?? null, evaluationLastIssue: evaluation.at(-1)?.issue ?? null };
    try {
      if (evaluation.length < 30) throw new Error('后续评估不足30期');
      const model = fitPoissonOffset(training, POPULARITY_FEATURES.length);
      const baseline = fitPoissonOffset(training.map((row) => ({ ...row, features: [] })), 0);
      const modelMetrics = evaluate(evaluation, model), baselineMetrics = evaluate(evaluation.map((row) => ({ ...row, features: [] })), baseline);
      const improvement = bootstrapImprovement(baselineMetrics.countSquaredLosses.map((loss, index) => loss - modelMetrics.countSquaredLosses[index]), (seed + grade) >>> 0);
      const { countSquaredLosses: _modelLoss, ...evaluationMetrics } = modelMetrics;
      const { countSquaredLosses: _baselineLoss, ...baselineEvaluationMetrics } = baselineMetrics;
      return { ...coverage, status: 'fitted', model, baseline, evaluationMetrics, baselineEvaluationMetrics, improvement,
        coefficientTable: [{ name: 'intercept', coefficient: model.coefficients[0], multiplier: Math.exp(model.coefficients[0]) },
          ...model.activeColumns.map((column, index) => ({ name: POPULARITY_FEATURES[column].name,
            definition: POPULARITY_FEATURES[column].definition,
            coefficient: model.coefficients[index + 1], multiplier: Math.exp(model.coefficients[index + 1]),
            rawUnitCoefficient: model.coefficients[index + 1] / model.scales[column],
            rawUnitMultiplier: Math.exp(model.coefficients[index + 1] / model.scales[column]) }))],
        exploratoryOutOfSampleEvidence: improvement.meanImprovement > 0 && improvement.familywiseInterval95[0] > 0,
        m5Approved: false, decision: '仅为时间留出段探索证据；不准入M5，需独立时期稳定性/前瞻验证及奖级对应性确认' };
    } catch (error) { return { ...coverage, status: 'skipped', reason: (error as Error).message, m5Approved: false }; }
  });
  const yearlyHeat = [...new Set(draws.map((draw) => draw.issue.slice(0, 4)))].map((year) => ({ year,
    grades: [1, 2, 3].map((grade) => {
      const rows = observations.filter((row) => row.issue.startsWith(year)).map((row) => row.grades[grade - 1]).filter((heat) => heat.expected !== undefined);
      const observed = rows.reduce((sum, row) => sum + row.observed!, 0), expected = rows.reduce((sum, row) => sum + row.expected!, 0);
      return { grade, count: rows.length, observed, expected, aggregateRatio: expected > 0 ? observed / expected : null };
    }) }));
  return { modelVersion: POPULARITY_MODEL_VERSION, library: 'ml-matrix@6.12.1', formula: 'log(mu)=log(sales/2*p)+intercept+Σ beta*trainingStandardizedFeature',
    coefficientDefinition: 'coefficient和multiplier表示特征增加1个训练标准差；rawUnit对应原始特征增加1单位；不代表开奖概率或因果效应',
    featureDefinitions: POPULARITY_FEATURES, holdoutFirstIssue: HOLDOUT_FIRST_ISSUE,
    weighting: 'Poisson似然内生权重mu，非log平滑比值回归；样本外MAE/RMSE按期等权，同时报告计数与比值尺度',
    uncertainty: '中奖注数可能过度离散/同注复制/时期漂移，Poisson仅均值模型；报告Pearson离散系数，不输出错误的独立Poisson系数显著性',
    zeroHandling: '保留零注数，不加伪计数；全零训练拒绝拟合',
    observations, yearlyHeat, gradeModels };
}