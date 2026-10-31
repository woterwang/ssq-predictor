/**
 * 独立核验第7批：真实截止历史手算M1/M2；穷举33选6核对精确边际，不复用DP递推。
 * 不读取2026125起前瞻段、不修改正式开奖表，也不进行模型参数搜索。
 */
import assert from 'node:assert/strict';
import { closeDatabase, getDatabase } from '../src/db/connection';
import { readBacktestDraws } from '../src/db/backtestRepository';
import { calculateModelWeights, FIXED_BASIC_MODEL_PARAMETERS } from '../src/models/basicNumberModels';
import { buildWeightedSubsetDistribution } from '../src/generator/weightedSubset';
import { createResearchRandom } from '../src/analysis/researchRandom';

function closeTo(actual: number, expected: number, tolerance = 1e-10): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `数值不一致：${actual} != ${expected}`);
}

function main(): void {
  const draws = readBacktestDraws(getDatabase(), '2026124');
  assert.ok(draws.length >= 300);
  const history = draws.slice(0, -1); // 针对2026124的分布，不能混入本期自身。
  const sample = history.slice(-300);
  const models = ['M1', 'M2'] as const;
  for (const kind of models) {
    const result = calculateModelWeights(history, kind, { ...FIXED_BASIC_MODEL_PARAMETERS });
    for (let redNumber = 1; redNumber <= 33; redNumber++) {
      let independentWeight = 100 * 6 / 33;
      for (let age = 0; age < sample.length; age++) {
        if (sample[sample.length - 1 - age].redBalls.includes(redNumber)) independentWeight += kind === 'M2' ? Math.exp(-Math.LN2 * age / 100) : 1;
      }
      closeTo(result.redWeights[redNumber - 1], independentWeight);
    }
    for (let blueNumber = 1; blueNumber <= 16; blueNumber++) {
      let independentWeight = 100 / 16;
      for (let age = 0; age < sample.length; age++) {
        if (sample[sample.length - 1 - age].blueBall === blueNumber) independentWeight += kind === 'M2' ? Math.exp(-Math.LN2 * age / 100) : 1;
      }
      closeTo(result.blueWeights[blueNumber - 1], independentWeight);
    }
  }

  // 完整穷举1107568个红球子集：按乘积累加各号包含权重，再除总配分函数。
  const weights = calculateModelWeights(history, 'M1', { ...FIXED_BASIC_MODEL_PARAMETERS }).redWeights;
  const maximum = Math.max(...weights);
  const normalized = weights.map(weight => weight / maximum);
  const includedWeight = Array(33).fill(0) as number[];
  const selected: number[] = [];
  let partition = 0, subsetCount = 0;
  function enumerate(firstIndex: number, remaining: number, product: number): void {
    if (remaining === 0) {
      partition += product; subsetCount++;
      for (const index of selected) includedWeight[index] += product;
      return;
    }
    for (let index = firstIndex; index <= 33 - remaining; index++) {
      selected.push(index); enumerate(index + 1, remaining - 1, product * normalized[index]); selected.pop();
    }
  }
  enumerate(0, 6, 1);
  assert.equal(subsetCount, 1_107_568);
  const distribution = buildWeightedSubsetDistribution(weights, 6);
  includedWeight.forEach((total, index) => closeTo(distribution.marginals[index], total / partition));
  closeTo(distribution.marginals.reduce((sum, p) => sum + p, 0), 6);

  const random = createResearchRandom(20261031);
  const counts = Array(33).fill(0) as number[];
  for (let draw = 0; draw < 100000; draw++) {
    const balls = distribution.sample(random);
    assert.equal(new Set(balls).size, 6);
    balls.forEach(ball => { counts[ball - 1]++; });
  }
  for (let index = 0; index < 33; index++) {
    const p = distribution.marginals[index];
    assert.ok(Math.abs(counts[index] / 100000 - p) < 6 * Math.sqrt(p * (1 - p) / 100000));
  }
  console.log(JSON.stringify({ passed: true, targetIssue: draws.at(-1)!.issue,
    historyEndIssue: history.at(-1)!.issue, independentWeightChecks: 2 * (33 + 16),
    enumeratedRedSubsets: subsetCount, simulatedSubsets: 100000, marginalSum: distribution.marginals.reduce((sum, p) => sum + p, 0),
    note: '比较统计及小样本推断保护由npm test独立覆盖；本命令不解锁前瞻段' }, null, 2));
}

try { main(); } catch (error) { console.error(`基础模型验收失败：${(error as Error).message}`); process.exitCode = 1; }
finally { closeDatabase(); }