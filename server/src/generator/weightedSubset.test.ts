/** 小球池穷举独立核查DP；抽样频率与精确边际对照，避免和为6但分布错误。 */
import { describe, expect, it } from 'vitest';
import { createResearchRandom } from '../analysis/researchRandom';
import { buildWeightedSubsetDistribution, normalizeCategoryWeights } from './weightedSubset';
import { generateWeightedTickets } from './ticketGenerator';

describe('固定大小乘积权重分布', () => {
  it('四球选二手算配分35及边际9/35、16/35、21/35、24/35', () => {
    const distribution = buildWeightedSubsetDistribution([1, 2, 3, 4], 2);
    const expected = [9, 16, 21, 24].map(value => value / 35);
    distribution.marginals.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12));
    expect(distribution.marginals[3]).not.toBeCloseTo(2 * 4 / 10, 3); // 简单归一化×6不是包含边际
  });
  it('全选与等权边际正确，缩放不变，外部权重修改不污染分布', () => {
    expect(buildWeightedSubsetDistribution([1, 2, 3], 3).marginals).toEqual([1, 1, 1]);
    const equal = buildWeightedSubsetDistribution(Array(33).fill(1) as number[], 6);
    expect(equal.marginals.every(p => Math.abs(p - 6 / 33) < 1e-12)).toBe(true);
    const weights = [1, 2, 3, 4], original = buildWeightedSubsetDistribution(weights, 2);
    const scaled = buildWeightedSubsetDistribution(weights.map(w => w * 1e100), 2);
    expect(original.marginals).toEqual(scaled.marginals);
    weights[0] = 100;
    expect(original.marginals[0]).toBeCloseTo(9 / 35, 12); expect(Object.isFrozen(original.marginals)).toBe(true);
  });
  it('10万次抽样匹配全部小池子集概率，不仅匹配单号频率', () => {
    const distribution = buildWeightedSubsetDistribution([1, 2, 3, 4], 2);
    const random = createResearchRandom(20261031), counts = new Map<string, number>();
    for (let draw = 0; draw < 100000; draw++) {
      const sample = distribution.sample(random), key = sample.join(',');
      expect(sample.length).toBe(2); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, weight] of [['1,2', 2], ['1,3', 3], ['1,4', 4], ['2,3', 6], ['2,4', 8], ['3,4', 12]] as const) {
      const p = weight / 35;
      expect(Math.abs((counts.get(key) ?? 0) / 100000 - p)).toBeLessThan(6 * Math.sqrt(p * (1 - p) / 100000));
    }
  });
  it('相同种子复现合法红球样本', () => {
    const distribution = buildWeightedSubsetDistribution(Array.from({ length: 33 }, (_, i) => i + 1), 6);
    const first = createResearchRandom(17), second = createResearchRandom(17);
    for (let i = 0; i < 100; i++) expect(distribution.sample(first)).toEqual(distribution.sample(second));
    expect(distribution.marginals.reduce((sum, p) => sum + p, 0)).toBeCloseTo(6, 12);
  });
  it('拒绝零负权重、NaN、极端比例及非法大小', () => {
    for (const weights of [[], [0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [1e-20, 1]]) expect(() => buildWeightedSubsetDistribution(weights, 1)).toThrow();
    for (const size of [0, 7, 2.5]) expect(() => buildWeightedSubsetDistribution([1, 1, 1], size)).toThrow();
    expect(normalizeCategoryWeights([1, 3])).toEqual([.25, .75]);
  });
});

describe('多注约束生成', () => {
  const reds = buildWeightedSubsetDistribution(Array(33).fill(1) as number[], 6);
  const blues = Array(16).fill(1 / 16) as number[];
  it('注数去重、最大红重叠与种子可复现', () => {
    const options = { count: 5, maximumSharedRedBalls: 2 };
    const tickets = generateWeightedTickets(reds, blues, createResearchRandom(15), options);
    expect(tickets).toEqual(generateWeightedTickets(reds, blues, createResearchRandom(15), options));
    expect(new Set(tickets.map(ticket => `${ticket.redBalls}|${ticket.blueBall}`)).size).toBe(5);
    tickets.forEach((ticket, index) => tickets.slice(index + 1).forEach(other => {
      expect(ticket.redBalls.filter(ball => other.redBalls.includes(ball)).length).toBeLessThanOrEqual(2);
    }));
  });
  it('不可能约束达到尝试上限时报错，不偷偷松绑', () => {
    const sixPool = buildWeightedSubsetDistribution([1, 1, 1, 1, 1, 1], 6);
    expect(() => generateWeightedTickets(sixPool, blues, createResearchRandom(1), { count: 2, maximumSharedRedBalls: 0, maximumAttempts: 10 })).toThrow('约束未满足');
  });
  it('拒绝非法蓝概率/生成参数', () => {
    expect(() => generateWeightedTickets(reds, [1], createResearchRandom(1), { count: 2 })).toThrow();
    for (const options of [{ count: 0 }, { count: 2, maximumSharedRedBalls: 7 }, { count: 2, maximumAttempts: 1 }]) {
      expect(() => generateWeightedTickets(reds, blues, createResearchRandom(1), options)).toThrow();
    }
  });
});