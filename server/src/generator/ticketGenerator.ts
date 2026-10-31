/** 多注去重与红球重叠约束。约束无法满足时明确失败，不静默放松。 */
import type { createResearchRandom } from '../analysis/researchRandom';
import type { LotteryTicket } from '../backtest/backtestTypes';
import type { WeightedSubsetDistribution } from './weightedSubset';
import { sampleCategory } from './weightedSubset';

export interface TicketGenerationOptions {
  count: number;
  /** 6表示不约束重叠。本批比较统一使用6，不增加结构过滤带来的额外分布变化。 */
  maximumSharedRedBalls?: number;
  maximumAttempts?: number;
}

export function generateWeightedTickets(redDistribution: WeightedSubsetDistribution, blueProbabilities: readonly number[],
  random: ReturnType<typeof createResearchRandom>, options: TicketGenerationOptions): LotteryTicket[] {
  const maximumShared = options.maximumSharedRedBalls ?? 6;
  const maximumAttempts = options.maximumAttempts ?? Math.max(1000, options.count * 100);
  if (redDistribution.size !== 6 || blueProbabilities.length !== 16
    || blueProbabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1)
    || Math.abs(blueProbabilities.reduce((sum, p) => sum + p, 0) - 1) > 1e-9) throw new Error('生成单式票须6红及16类蓝概率');
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 1000
    || !Number.isInteger(maximumShared) || maximumShared < 0 || maximumShared > 6
    || !Number.isInteger(maximumAttempts) || maximumAttempts < options.count || maximumAttempts > 1_000_000) throw new Error('生成数量/重叠/尝试上限非法');
  const tickets: LotteryTicket[] = [];
  const seen = new Set<string>();
  // 概率评分描述“单注基础分布”，不是去重/重叠拒绝后第j注的条件边际。
  // 去重会改变后续注的条件分布；严格重叠限制尤其不能声称仍保持原模型边际。
  for (let attempt = 0; attempt < maximumAttempts && tickets.length < options.count; attempt++) {
    const redBalls = redDistribution.sample(random);
    const blueBall = sampleCategory(blueProbabilities, random);
    const key = `${redBalls.join(',')}|${blueBall}`;
    if (seen.has(key) || tickets.some(ticket => redBalls.filter(ball => ticket.redBalls.includes(ball)).length > maximumShared)) continue;
    seen.add(key); tickets.push({ redBalls, blueBall });
  }
  if (tickets.length !== options.count) throw new Error(`生成约束未满足：${maximumAttempts}次尝试仅生成${tickets.length}/${options.count}注`);
  return tickets;
}