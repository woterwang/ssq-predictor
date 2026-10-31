/**
 * 固定大小子集分布 P(S)=prod(w_i)/e_k(w)，不是顺序加权抽球的Plackett–Luce分布。
 * 前/后缀基本对称多项式DP同时给出精确边际和精确抽样条件概率。
 * 权重仅决定分布，不直接当作红球边际概率；号码从1开始。
 */
import type { createResearchRandom } from '../analysis/researchRandom';

export const WEIGHTED_SUBSET_VERSION = 'product-subset-dp-v1';

export interface WeightedSubsetDistribution {
  readonly marginals: readonly number[];
  readonly size: number;
  sample(random: ReturnType<typeof createResearchRandom>): number[];
}

/** 防止极端比例下溢；本批模型均有正先验，权重比例远离边界。 */
function normalizePositiveWeights(weights: readonly number[]): number[] {
  if (weights.length === 0 || weights.some(weight => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error('权重必须非空、有限且严格为正');
  }
  const maximum = Math.max(...weights);
  const normalized = weights.map(weight => weight / maximum);
  if (normalized.some(weight => weight < 1e-12)) throw new Error('权重比例过于极端，需增加平滑先验');
  return normalized;
}

export function buildWeightedSubsetDistribution(weights: readonly number[], size: number): WeightedSubsetDistribution {
  if (weights.length > 33 || !Number.isInteger(size) || size < 1 || size > weights.length || size > 6) {
    throw new Error('子集大小须为1–6且不超过球池大小，球池最多33个');
  }
  const normalized = normalizePositiveWeights(weights);
  const count = normalized.length;
  const prefix = Array.from({ length: count + 1 }, () => new Float64Array(size + 1));
  const suffix = Array.from({ length: count + 1 }, () => new Float64Array(size + 1));
  prefix[0][0] = 1; suffix[count][0] = 1;
  for (let index = 0; index < count; index++) {
    prefix[index + 1][0] = 1;
    for (let selected = 1; selected <= size; selected++) {
      prefix[index + 1][selected] = prefix[index][selected] + normalized[index] * prefix[index][selected - 1];
    }
  }
  for (let index = count - 1; index >= 0; index--) {
    suffix[index][0] = 1;
    for (let selected = 1; selected <= size; selected++) {
      suffix[index][selected] = suffix[index + 1][selected] + normalized[index] * suffix[index + 1][selected - 1];
    }
  }
  const partition = suffix[0][size];
  if (!(partition > 0) || !Number.isFinite(partition)) throw new Error('子集配分函数无效');
  const marginals = normalized.map((weight, index) => {
    // 排除号码i后从左右共选k-1个，乘wi即所有含i子集的总权重。
    let excludedCoefficient = 0;
    for (let leftSize = 0; leftSize < size; leftSize++) {
      excludedCoefficient += prefix[index][leftSize] * suffix[index + 1][size - 1 - leftSize];
    }
    return Math.min(1, Math.max(0, weight * excludedCoefficient / partition));
  });
  if (Math.abs(marginals.reduce((sum, value) => sum + value, 0) - size) > 1e-9) throw new Error('子集边际和校验失败');
  return Object.freeze({
    marginals: Object.freeze(marginals), size,
    sample(random: ReturnType<typeof createResearchRandom>): number[] {
      const selectedNumbers: number[] = [];
      let remaining = size;
      for (let index = 0; index < count && remaining > 0; index++) {
        const mustInclude = count - index === remaining;
        const inclusionProbability = normalized[index] * suffix[index + 1][remaining - 1] / suffix[index][remaining];
        if (mustInclude || random.nextUint32() / 0x100000000 < inclusionProbability) {
          selectedNumbers.push(index + 1); remaining--;
        }
      }
      if (remaining !== 0) throw new Error('子集抽样未完成');
      return selectedNumbers;
    },
  });
}

export function normalizeCategoryWeights(weights: readonly number[]): number[] {
  const normalized = normalizePositiveWeights(weights);
  const total = normalized.reduce((sum, weight) => sum + weight, 0);
  return normalized.map(weight => weight / total);
}

export function sampleCategory(probabilities: readonly number[], random: ReturnType<typeof createResearchRandom>): number {
  const uniform = random.nextUint32() / 0x100000000;
  let cumulative = 0;
  for (let index = 0; index < probabilities.length; index++) {
    cumulative += probabilities[index];
    if (uniform < cumulative) return index + 1;
  }
  return probabilities.length; // 有限浮点累加尾误差兜底，不增加未知类别
}