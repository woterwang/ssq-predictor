/**
 * 第7批固定对照模型，不搜索参数。M3仅用于展示遗漏启发式的局限，不准入推荐。
 * 所有分布只依赖传入历史，不读取DB；WeakMap按不可变历史对象缓存DP，跨随机重复复用。
 */
import type { AnalysisDraw } from '../analysis/analysisTypes';
import type { BacktestStrategy, PredictionContext } from '../backtest/backtestTypes';
import { buildWeightedSubsetDistribution, normalizeCategoryWeights, WEIGHTED_SUBSET_VERSION } from '../generator/weightedSubset';
import { generateWeightedTickets } from '../generator/ticketGenerator';

export type BasicModelKind = 'M1' | 'M2' | 'M3';
export interface BasicModelParameters {
  window: number;
  /** 相当于多少期公平开奖的先验，红球逐号加strength*6/33，蓝加strength/16。 */
  priorStrength: number;
  halfLife: number;
  omissionExponent: number;
}

export const FIXED_BASIC_MODEL_PARAMETERS: Readonly<BasicModelParameters> = Object.freeze({
  window: 300, priorStrength: 100, halfLife: 100, omissionExponent: .25,
});

function validateParameters(parameters: BasicModelParameters): void {
  if (!Number.isSafeInteger(parameters.window) || parameters.window < 1 || parameters.window > 10000
    || !Number.isFinite(parameters.priorStrength) || parameters.priorStrength < 1 || parameters.priorStrength > 100000
    || !Number.isFinite(parameters.halfLife) || parameters.halfLife < 1 || parameters.halfLife > 10000
    || !Number.isFinite(parameters.omissionExponent) || parameters.omissionExponent < 0 || parameters.omissionExponent > 1) throw new Error('基础模型参数非法');
}

export function calculateModelWeights(history: readonly AnalysisDraw[], kind: BasicModelKind, parameters: BasicModelParameters) {
  if (!['M1', 'M2', 'M3'].includes(kind)) throw new Error('未知基础模型');
  validateParameters(parameters);
  const sample = history.slice(-parameters.window);
  const redWeights = Array(33).fill(parameters.priorStrength * 6 / 33) as number[];
  const blueWeights = Array(16).fill(parameters.priorStrength / 16) as number[];
  sample.forEach((draw, index) => {
    const decay = kind === 'M2' ? 2 ** (-(sample.length - 1 - index) / parameters.halfLife) : 1;
    draw.redBalls.forEach(ball => { redWeights[ball - 1] += decay; });
    blueWeights[draw.blueBall - 1] += decay;
  });
  if (kind === 'M3') {
    // 反例对照：在平滑频次基础上轻微偏向当前遗漏。封顶3倍；未出现仅是窗口遗漏下界。
    // 独立开奖下不会“欠开奖”，这不是中奖概率提高的理论依据。
    const omissions = (maximum: number, includes: (draw: AnalysisDraw, number: number) => boolean): number[] =>
      Array.from({ length: maximum }, (_, index) => {
        let omitted = 0;
        for (let position = sample.length - 1; position >= 0 && !includes(sample[position], index + 1); position--) omitted++;
        return omitted;
      });
    const adjust = (weights: number[], gaps: number[], expectedGap: number): void => {
      gaps.forEach((gap, index) => { weights[index] *= Math.min(3, ((gap + 1) / (expectedGap + 1)) ** parameters.omissionExponent); });
    };
    if (sample.length > 0) {
      adjust(redWeights, omissions(33, (draw, number) => draw.redBalls.includes(number)), 27 / 6);
      adjust(blueWeights, omissions(16, (draw, number) => draw.blueBall === number), 15);
    }
  }
  return { redWeights, blueWeights };
}

export function createBasicNumberStrategy(kind: BasicModelKind, inputParameters: BasicModelParameters = { ...FIXED_BASIC_MODEL_PARAMETERS }): BacktestStrategy {
  const parameters = Object.freeze({ ...inputParameters });
  validateParameters(parameters);
  const prepare = (history: readonly AnalysisDraw[]) => {
    const weights = calculateModelWeights(history, kind, parameters);
    return { reds: buildWeightedSubsetDistribution(weights.redWeights, 6), blues: Object.freeze(normalizeCategoryWeights(weights.blueWeights)) };
  };
  // WeakMap不会长期保留数据库快照；只缓存确定性分布，不缓存票/随机状态/实际开奖号。
  const cache = new WeakMap<readonly AnalysisDraw[], ReturnType<typeof prepare>>();
  const names = { M1: 'M1_smooth_frequency', M2: 'M2_time_decay', M3: 'M3_omission_control' };
  return {
    name: names[kind], version: '1.0.0',
    parameters: { ...parameters, kind, distribution: WEIGHTED_SUBSET_VERSION, maximumSharedRedBalls: 6,
      controlOnly: kind === 'M3', duplicateTickets: 'reject', missingIssues: 'observed-row-distance',
      probabilityDefinition: 'single-ticket-base-distribution-before-portfolio-rejections' },
    createPredictor: () => (context: PredictionContext) => {
      let prepared = cache.get(context.history);
      if (!prepared) { prepared = prepare(context.history); cache.set(context.history, prepared); }
      return { redProbabilities: prepared.reds.marginals, blueProbabilities: prepared.blues,
        tickets: generateWeightedTickets(prepared.reds, prepared.blues, context.random, { count: context.ticketsPerIssue }) };
    },
  };
}

export const fixedBasicStrategies = ['M1', 'M2', 'M3'].map(kind => createBasicNumberStrategy(kind as BasicModelKind));