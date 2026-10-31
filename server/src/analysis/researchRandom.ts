/** 可复现研究用 PRNG，不用于密码、安全令牌或真实开奖。算法与种子写入报告。 */
import type { AnalysisDraw } from './analysisTypes';

export const RANDOM_ALGORITHM = 'xoshiro128**/splitmix32-seed/rejection-v1';

export function validateSimulationCount(simulations: number): void {
  if (!Number.isSafeInteger(simulations) || simulations < 1) throw new Error('simulations 必须是安全正整数');
}

export function createResearchRandom(seed: number): { nextUint32: () => number; integer: (bound: number) => number } {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed 必须是 0–4294967295 整数');
  let seedState = seed >>> 0;
  const state = Array.from({ length: 4 }, () => {
    seedState = (seedState + 0x9e3779b9) >>> 0;
    let mixed = seedState;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
    return (mixed ^ (mixed >>> 15)) >>> 0;
  });
  if (state.reduce((combined, value) => combined | value, 0) === 0) state[0] = 1;
  const rotate = (value: number, bits: number): number => (value << bits) | (value >>> (32 - bits));
  const nextUint32 = (): number => {
    const result = Math.imul(rotate(Math.imul(state[1], 5), 7), 9) >>> 0;
    const temporary = state[1] << 9;
    state[2] ^= state[0]; state[3] ^= state[1]; state[1] ^= state[2]; state[0] ^= state[3];
    state[2] ^= temporary; state[3] = rotate(state[3], 11);
    return result;
  };
  return {
    nextUint32,
    integer: (bound) => {
      if (!Number.isInteger(bound) || bound < 1 || bound > 0x100000000) throw new Error('随机整数上界非法');
      // 拒绝不能整除 bound 的尾部，避免 uint32 % bound 的微小模偏差。
      const limit = Math.floor(0x100000000 / bound) * bound;
      let value: number;
      do { value = nextUint32(); } while (value >= limit);
      return value % bound;
    },
  };
}

/** 紧凑序列：每期七字节。局部 Fisher–Yates 不放回，交换复原后复用同一球池。 */
export function fillFairSequence(sequence: Uint8Array, random: ReturnType<typeof createResearchRandom>): void {
  if (sequence.length % 7 !== 0) throw new Error('序列长度必须为 7 的倍数');
  const pool = Uint8Array.from({ length: 33 }, (_, index) => index + 1);
  const swaps = new Uint8Array(6);
  for (let offset = 0; offset < sequence.length; offset += 7) {
    for (let index = 0; index < 6; index++) {
      const chosenIndex = index + random.integer(33 - index);
      swaps[index] = chosenIndex;
      [pool[index], pool[chosenIndex]] = [pool[chosenIndex], pool[index]];
      // 插入排序六个数，无需创建 features/Set/每期对象。
      let insertionIndex = index;
      while (insertionIndex > 0 && sequence[offset + insertionIndex - 1] > pool[index]) {
        sequence[offset + insertionIndex] = sequence[offset + insertionIndex - 1];
        insertionIndex--;
      }
      sequence[offset + insertionIndex] = pool[index];
    }
    for (let index = 5; index >= 0; index--) {
      [pool[index], pool[swaps[index]]] = [pool[swaps[index]], pool[index]];
    }
    sequence[offset + 6] = random.integer(16) + 1;
  }
}

/** 边界验证只对真实数据执行一次；不在千万次模拟的内层重复检查。 */
export function packAnalysisDraws(draws: readonly AnalysisDraw[]): Uint8Array {
  const sequence = new Uint8Array(draws.length * 7);
  draws.forEach((draw, index) => {
    if (!/^\d{7}$/.test(draw.issue) || draw.issue.endsWith('000') || !/^\d{4}-\d{2}-\d{2}$/.test(draw.drawDate)) {
      throw new Error(`非法期号或日期：${draw.issue}`);
    }
    const sorted = [...draw.redBalls].sort((left, right) => left - right);
    if (sorted.length !== 6 || new Set(sorted).size !== 6 || sorted.some((ball) => !Number.isInteger(ball) || ball < 1 || ball > 33)
      || !Number.isInteger(draw.blueBall) || draw.blueBall < 1 || draw.blueBall > 16) throw new Error(`非法号码：${draw.issue}`);
    if (index > 0 && (draw.issue <= draws[index - 1].issue || draw.drawDate <= draws[index - 1].drawDate)) {
      throw new Error('真实开奖必须按期号、日期严格递增且不重复');
    }
    sequence.set([...sorted, draw.blueBall], index * 7);
  });
  return sequence;
}