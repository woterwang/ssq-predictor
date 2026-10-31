/** 评分口径与重复分布。红球为33个二元事件；蓝球为16类的一个事件。 */
import type { LotteryTicket, MetricDistribution, ModelPrediction, ScoreMetrics } from './backtestTypes';
import { assertLegalTicket } from './prizeRules';

export const PROBABILITY_EPSILON = 1e-15;

export function assertLegalPrediction(prediction: ModelPrediction, ticketsPerIssue: number): void {
  for (const [probabilities, expectedLength, expectedSum] of [
    [prediction.redProbabilities, 33, 6], [prediction.blueProbabilities, 16, 1],
  ] as const) {
    if (probabilities.length !== expectedLength || probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1)
      || Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - expectedSum) > 1e-8) {
      throw new Error('预测概率非法：红球33项和为6，蓝球16项和为1，每项须在[0,1]');
    }
  }
  if (prediction.tickets.length !== ticketsPerIssue) throw new Error('预测注数与配置不一致');
  const keys = new Set<string>();
  for (const ticket of prediction.tickets) {
    assertLegalTicket(ticket);
    const key = `${[...ticket.redBalls].sort((a, b) => a - b).join(',')}|${ticket.blueBall}`;
    if (keys.has(key)) throw new Error('同一期不允许重复单式票');
    keys.add(key);
  }
}

export function scoreProbabilities(prediction: ModelPrediction, actual: LotteryTicket): ScoreMetrics {
  let redLogLoss = 0, redBrierScore = 0, blueBrierScore = 0;
  const safeProbability = (p: number): number => Math.min(1 - PROBABILITY_EPSILON, Math.max(PROBABILITY_EPSILON, p));
  prediction.redProbabilities.forEach((probability, index) => {
    const label = actual.redBalls.includes(index + 1) ? 1 : 0;
    const clipped = safeProbability(probability);
    redLogLoss -= label * Math.log(clipped) + (1 - label) * Math.log(1 - clipped);
    redBrierScore += (probability - label) ** 2;
  });
  prediction.blueProbabilities.forEach((probability, index) => {
    blueBrierScore += (probability - (actual.blueBall === index + 1 ? 1 : 0)) ** 2;
  });
  return {
    redLogLoss: redLogLoss / 33, redBrierScore: redBrierScore / 33,
    blueLogLoss: -Math.log(safeProbability(prediction.blueProbabilities[actual.blueBall - 1])), blueBrierScore,
  };
}

/** R-7线性分位点，与基础统计一致。 */
function quantile(sorted: number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function summarizeDistribution(values: number[], allowNormalMeanInterval = true): MetricDistribution {
  if (values.length === 0 || values.some(value => !Number.isFinite(value))) throw new Error('分布样本为空或非有限数');
  // 平移后求均值，避免数百个相同评分累加舍入，伪造非零标准差和不含原值的区间。
  const anchor = values[0];
  const mean = anchor + values.reduce((sum, value) => sum + (value - anchor), 0) / values.length;
  const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
  const standardDeviation = Math.sqrt(variance);
  const margin = 1.959963984540054 * standardDeviation / Math.sqrt(values.length);
  const sorted = [...values].sort((a, b) => a - b);
  return { mean, median: quantile(sorted, .5), minimum: sorted[0], maximum: sorted.at(-1)!,
    standardDeviation, outcomeInterval95: [quantile(sorted, .025), quantile(sorted, .975)],
    monteCarloMeanInterval95: values.length >= 30 && allowNormalMeanInterval ? [mean - margin, mean + margin] : null };
}

/** 首次重复不参与零分布：加一校准的双侧尾概率；重尾收益不参与此校准。 */
export function firstRunTailProbability(values: number[], theoreticalMean: number): number | null {
  if (values.length < 100) return null;
  const distance = Math.abs(values[0] - theoreticalMean);
  const exceedances = values.slice(1).filter(value => Math.abs(value - theoreticalMean) >= distance - 1e-14).length;
  return (exceedances + 1) / values.length;
}