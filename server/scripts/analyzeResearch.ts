/** 独立离线命令，不在API/调度长期进程中运行CPU密集模拟。只读取快照、写JSON。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SERVER_ROOT_DIR } from '../src/config';
import { closeDatabase, getDatabase } from '../src/db/connection';
import { readResearchSnapshot } from '../src/db/analysisRepository';
import { runRandomnessResearch, TEST_DEFINITIONS } from '../src/analysis/randomnessResearch';
import { runPopularityResearch } from '../src/analysis/popularityResearch';
import { RANDOM_ALGORITHM, createResearchRandom, validateSimulationCount } from '../src/analysis/researchRandom';

/** 同时支持 --seed=123 与 --seed 123；重复和未知参数直接拒绝。 */
export function parseResearchArguments(argumentsList: string[]): { simulations: number; seed: number } {
  const options = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index++) {
    const [name, inlineValue] = argumentsList[index].split('=');
    if (!['--simulations', '--seed'].includes(name) || options.has(name) || argumentsList[index].split('=').length > 2) throw new Error(`未知/重复参数：${argumentsList[index]}`);
    const value = inlineValue ?? argumentsList[++index];
    if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${name}必须为非负整数字符串`);
    options.set(name, value);
  }
  const simulations = Number(options.get('--simulations') ?? 10000), seed = Number(options.get('--seed') ?? 20261031);
  validateSimulationCount(simulations); createResearchRandom(seed);
  return { simulations, seed };
}

function main(): void {
  const started = performance.now(), { simulations, seed } = parseResearchArguments(process.argv.slice(2));
  const database = getDatabase();
  const draws = readResearchSnapshot(database);
  closeDatabase(); // 模拟期间不长期持有数据库连接，数据指纹基于已经取得的单SELECT快照。
  if (draws.length === 0) throw new Error('空数据库不能生成研究报告');
  const fingerprint = createHash('sha256').update(JSON.stringify(draws)).digest('hex');
  console.log(`研究：${draws.length}期 ${draws[0].issue}–${draws.at(-1)!.issue}，seed=${seed}，模拟=${simulations}`);
  const randomness = runRandomnessResearch(draws, simulations, seed, (completed) => console.log(`模拟 ${completed}/${simulations}，累计 ${((performance.now() - started) / 1000).toFixed(2)}秒`));
  const popularity = runPopularityResearch(draws, seed);
  const report = {
    definitionVersion: 'research-analysis-v1', generatedAt: new Date().toISOString(), seed,
    randomAlgorithm: RANDOM_ALGORITHM, nodeVersion: process.version, dataFingerprint: fingerprint,
    dataCoverage: { count: draws.length, firstIssue: draws[0].issue, lastIssue: draws.at(-1)!.issue,
      firstDate: draws[0].drawDate, lastDate: draws.at(-1)!.drawDate, missingEarlierHistory: '2003–2012未覆盖，仅2013年起接口可用历史' },
    formalReport: simulations >= 10000, predefinedTestDefinitions: TEST_DEFINITIONS,
    randomness, popularity,
    decisions: {
      exploitableDrawBiasEstablished: false, m5Approved: false, roiCalculated: false,
      conclusion: randomness.rejectionCount === 0 ? '统一BH校正后未拒绝这些预定义零假设；不证明完全随机，也未证明存在可利用预测偏差'
        : '存在预定义量偏离的统计证据；频次或结构偏离不等于样本外可利用预测，不据此准入预测模型',
      nextStep: '第5批检查点待人工审阅；未实现第6批，未运行策略搜索或收益回测',
    },
    limitations: [
      '有限检验不能覆盖全部随机性性质；不拒绝零假设不证明完全随机，拒绝也不证明可利用预测。',
      'BH汇总全部未跳过的预定义检验，年度/全量/结构之间依赖可能影响BH理论FDR保证；保留全量p/q便于复核，MC有限精度须注意。',
      '完整遗漏使用有限样本端点期望，年段首尾截断不纳入；缺期/疑似年末缺期的连续量明确跳过。',
      'sales/2假设销售额代表2元等价投注注数；复式/胆拖/重复注/机选混合以及销售口径与规则时期变化需人工确认。',
      '一等奖描述精准六红+蓝投注计数，二等奖描述六红错蓝邻域，三等奖描述5红+蓝的162组合邻域，三等奖不是精准组合撞号概率。',
      'Poisson均值拟合不保证独立等方差计数；过度离散、时间混杂、未知投注机制限制解释，特征系数不是因果效应。',
      '2023001起时间留出是本批探索评估，不是第6批最终保留段；未调参，但本段已被查看，不能再次宣称未触碰最终评估。',
      '块bootstrap区间是近似探索证据，三个奖级均报告；M5需独立时期/前瞻证据且不得把邻域信号直接迁移为一等奖撞号概率。',
      '奖金特别规定不改变本批常规奖级注数统计；福运奖中奖条件、派奖资格和适用时期尚未核实，禁止计算ROI。',
    ], elapsedSeconds: (performance.now() - started) / 1000,
  };
  const filename = simulations >= 10000 ? 'research-analysis.json' : `research-analysis-smoke-${simulations}-${seed}.json`;
  const outputPath = simulations >= 10000 ? path.join(SERVER_ROOT_DIR, '..', 'docs', filename) : path.join(SERVER_ROOT_DIR, 'data', 'reports', filename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  // 所有检验而非只显示显著者；完整效应、定义、零分布边界也在JSON。
  for (const finding of randomness.findings) console.log(`${finding.segment}/${finding.test}: stat=${finding.observedStatistic?.toFixed(4) ?? '跳过'} p=${finding.monteCarloP?.toFixed(6) ?? 'NA'} q=${finding.adjustedP?.toFixed(6) ?? 'NA'} effect=${finding.standardizedEffect?.toFixed(3) ?? 'NA'}`);
  for (const model of popularity.gradeModels) console.log('热度模型：', JSON.stringify(model));
  console.log(`BH ${randomness.familySize}项，拒绝${randomness.rejectionCount}项。${report.decisions.conclusion}`);
  console.log(`耗时 ${report.elapsedSeconds.toFixed(2)}秒；${report.formalReport ? '正式' : '仅烟测，不满足正式重复数'}报告：${outputPath}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`研究失败：${(error as Error).message}`); process.exitCode = 1; }
  finally { closeDatabase(); }
}