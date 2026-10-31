/** 模型只使用历史的手算、未来隔离和合法概率验收。 */
import { describe, expect, it } from 'vitest';
import { calculateModelWeights, createBasicNumberStrategy, FIXED_BASIC_MODEL_PARAMETERS } from './basicNumberModels';
import { createResearchRandom } from '../analysis/researchRandom';
import { assertLegalPrediction } from '../backtest/metrics';
import { runWalkForwardBacktest } from '../backtest/walkForwardEngine';
import type { BacktestDraw, PredictionContext } from '../backtest/backtestTypes';

const history = [
  { issue: '2026001', drawDate: '2026-01-01', redBalls: [1, 2, 3, 4, 5, 6], blueBall: 1 },
  { issue: '2026002', drawDate: '2026-01-02', redBalls: [1, 7, 8, 9, 10, 11], blueBall: 2 },
];
const parameters = { ...FIXED_BASIC_MODEL_PARAMETERS, window: 2, priorStrength: 16, halfLife: 1 };

describe('基础模型权重与分布', () => {
  it('M1频次+公平先验手算，并且窗口只保留末期', () => {
    const weights = calculateModelWeights(history, 'M1', parameters);
    expect(weights.redWeights[0]).toBeCloseTo(16 * 6 / 33 + 2, 12);
    expect(weights.redWeights[1]).toBeCloseTo(16 * 6 / 33 + 1, 12);
    expect(weights.blueWeights.slice(0, 3)).toEqual([2, 2, 1]);
    const short = calculateModelWeights(history, 'M1', { ...parameters, window: 1 });
    expect(short.blueWeights.slice(0, 3)).toEqual([1, 2, 1]);
  });
  it('M2一期半衰期：旧期0.5、最新期1，先验不衰减', () => {
    const weights = calculateModelWeights(history, 'M2', parameters);
    expect(weights.redWeights[0]).toBeCloseTo(16 * 6 / 33 + 1.5, 12);
    expect(weights.blueWeights.slice(0, 3)).toEqual([1.5, 2, 1]);
  });
  it('M3为有界遗漏对照，指数0退回M1，未出现不无限放大', () => {
    expect(calculateModelWeights(history, 'M3', { ...parameters, omissionExponent: 0 })).toEqual(calculateModelWeights(history, 'M1', parameters));
    const strategy = createBasicNumberStrategy('M3'); expect(strategy.parameters.controlOnly).toBe(true);
    expect(calculateModelWeights(history, 'M3', parameters).redWeights.every(Number.isFinite)).toBe(true);
  });
  it('所有模型空历史退回公平边际，不将权重归一化×6当概率', () => {
    for (const kind of ['M1', 'M2', 'M3'] as const) {
      const predictor = createBasicNumberStrategy(kind).createPredictor();
      const context: PredictionContext = { targetIssue: '2026001', history: [], ticketsPerIssue: 5, random: createResearchRandom(3) };
      const prediction = predictor(context); assertLegalPrediction(prediction, 5);
      expect(prediction.redProbabilities.every(p => Math.abs(p - 6 / 33) < 1e-12)).toBe(true);
      expect(prediction.blueProbabilities.every(p => p === 1 / 16)).toBe(true);
    }
  });
  it('每种模型同历史/种子复现，缓存只复用确定性概率', () => {
    for (const kind of ['M1', 'M2', 'M3'] as const) {
      const strategy = createBasicNumberStrategy(kind, parameters);
      const context: PredictionContext = { history, targetIssue: '2026003', ticketsPerIssue: 3, random: createResearchRandom(123) };
      const first = strategy.createPredictor()(context);
      const second = strategy.createPredictor()({ ...context, random: createResearchRandom(123) });
      expect(first).toEqual(second); assertLegalPrediction(first, 3);
    }
  });
  it('修改目标或未来开奖号不改目标之前及目标自身的预测', () => {
    const draws: BacktestDraw[] = [...history, { ...history[1], issue: '2026003', drawDate: '2026-01-03' }].map(draw => ({ ...draw, prizeGrades: [], rawRecordJson: '{}' }));
    const changed = structuredClone(draws); changed[2].redBalls = [20, 21, 22, 23, 24, 25]; changed[2].blueBall = 16;
    const options = { startIssue: '2026002', endIssue: '2026003', ticketsPerIssue: 2, repetitions: 2, minimumHistory: 1, seed: 123 };
    for (const kind of ['M1', 'M2', 'M3'] as const) {
      const strategy = createBasicNumberStrategy(kind, parameters);
      const first = runWalkForwardBacktest(draws, strategy, options), second = runWalkForwardBacktest(changed, strategy, options);
      expect(first.firstRepetitionDetails.map(p => p.prediction)).toEqual(second.firstRepetitionDetails.map(p => p.prediction));
      expect(first.repetitions[0].redLogLoss).toBe(first.repetitions[1].redLogLoss);
    }
  });
  it('非法参数明确拒绝，不允许0平滑或负衰减', () => {
    expect(() => createBasicNumberStrategy('M1', { ...parameters, priorStrength: 0 })).toThrow();
    expect(() => createBasicNumberStrategy('M2', { ...parameters, halfLife: -1 })).toThrow();
    expect(() => createBasicNumberStrategy('M3', { ...parameters, omissionExponent: NaN })).toThrow();
  });
});