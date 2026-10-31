/** M0：公平单式票，不放回选6红、均匀选1蓝。多注只去掉整注重复，不加结构过滤。 */
import { fillFairSequence } from '../analysis/researchRandom';
import type { BacktestStrategy, LotteryTicket, PredictionContext } from '../backtest/backtestTypes';

export function predictUniformRandom(context: PredictionContext) {
  const tickets: LotteryTicket[] = [];
  const seen = new Set<string>();
  const buffer = new Uint8Array(7);
  while (tickets.length < context.ticketsPerIssue) {
    fillFairSequence(buffer, context.random);
    const redBalls = Array.from(buffer.subarray(0, 6));
    const blueBall = buffer[6];
    const key = `${redBalls.join(',')}|${blueBall}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tickets.push({ redBalls, blueBall });
  }
  // 概率来自模型分布，而非有限几注中出现的次数。红球和为6，不是和为1。
  return { redProbabilities: Array(33).fill(6 / 33) as number[], blueProbabilities: Array(16).fill(1 / 16) as number[], tickets };
}

export const uniformRandomStrategy: BacktestStrategy = {
  name: 'M0_uniform_random', version: '1.0.0', parameters: { duplicateTickets: 'reject', structuralFilters: false },
  createPredictor: () => predictUniformRandom,
};