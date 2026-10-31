/**
 * 第7批固定四模型探索回测。先登记全部配置再执行，失败不删记录，不挑选模型/参数。
 * 所有模型使用相同起止期、成本与重复种子；正式前瞻段继续锁定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SERVER_ROOT_DIR } from '../src/config';
import { closeDatabase, getDatabase } from '../src/db/connection';
import { ensureHoldoutRegistered, finishBacktestRun, readBacktestDraws, startBacktestRun } from '../src/db/backtestRepository';
import { parseBacktestArguments } from '../src/backtest/backtestArguments';
import { runWalkForwardBacktest } from '../src/backtest/walkForwardEngine';
import { compareModelReports } from '../src/backtest/modelComparison';
import type { BacktestReport } from '../src/backtest/backtestTypes';
import { uniformRandomStrategy } from '../src/models/uniformRandomModel';
import { fixedBasicStrategies } from '../src/models/basicNumberModels';

const BOOTSTRAP_REPETITIONS = 2000;
const BOOTSTRAP_BLOCK_LENGTH = 10;

function main(): void {
  // 默认100次降低探索比较成本，显式CLI可改重复数；不提供模型参数搜索入口。
  const argumentsList = process.argv.slice(2);
  const hasRepetitions = argumentsList.some(argument => argument === '--repetitions' || argument.startsWith('--repetitions='));
  const options = parseBacktestArguments(hasRepetitions ? argumentsList : ['--repetitions=100', ...argumentsList]);
  const database = getDatabase();
  const started = performance.now();
  const strategies = [uniformRandomStrategy, ...fixedBasicStrategies];
  const plans = database.transaction(() => strategies.map(strategy => {
    const registeredStrategy = { ...strategy, parameters: { ...strategy.parameters,
      comparisonProtocol: 'fixed-basic-models-v1', candidateCount: 3, parametersSearched: false,
      bootstrapRepetitions: BOOTSTRAP_REPETITIONS, bootstrapBlockLength: BOOTSTRAP_BLOCK_LENGTH } };
    return { strategy: registeredStrategy, id: startBacktestRun(database, registeredStrategy, options), completed: false };
  }))();
  const reports: BacktestReport[] = [];
  const reportDirectory = path.join(SERVER_ROOT_DIR, 'data', 'reports');
  try {
    ensureHoldoutRegistered(database);
    const draws = readBacktestDraws(database, options.endIssue);
    fs.mkdirSync(reportDirectory, { recursive: true });
    for (const plan of plans) {
      console.log(`固定比较#${plan.id} ${plan.strategy.name}：${options.startIssue}–${options.endIssue}，${options.repetitions}次，每期${options.ticketsPerIssue}注`);
      const report = runWalkForwardBacktest(draws, plan.strategy, options);
      const detailPath = path.join(reportDirectory, `backtest-${plan.id}-${plan.strategy.name}-${options.seed}.json`);
      fs.writeFileSync(detailPath, JSON.stringify({ ...report, runId: plan.id, generatedAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', flag: 'wx' });
      finishBacktestRun(database, plan.id, report, path.relative(SERVER_ROOT_DIR, detailPath).replace(/\\/g, '/'), null);
      plan.completed = true; reports.push(report);
      console.log(`${plan.strategy.name} 红命中=${report.distributions.averageRedHits.mean.toFixed(6)} 蓝命中=${report.distributions.blueHitRate.mean.toFixed(6)}`);
    }
    const comparison = compareModelReports(reports, options.seed, BOOTSTRAP_REPETITIONS, BOOTSTRAP_BLOCK_LENGTH);
    const comparisonPath = path.join(reportDirectory, `basic-model-comparison-${plans[0].id}-${options.seed}.json`);
    fs.writeFileSync(comparisonPath, JSON.stringify({ ...comparison, generatedAt: new Date().toISOString(),
      runIds: plans.map(plan => plan.id), elapsedSeconds: (performance.now() - started) / 1000,
      fixedConfigurations: plans.map(plan => ({ name: plan.strategy.name, version: plan.strategy.version, parameters: plan.strategy.parameters })) }, null, 2),
    { encoding: 'utf8', flag: 'wx' });
    for (const finding of comparison.probabilityComparisons) console.log(`${finding.modelName}/${finding.metric}: 改善=${finding.improvement.toFixed(8)} 区间=${JSON.stringify(finding.approximateBootstrapInterval95)} Holm-p=${finding.holmAdjustedPValue?.toFixed(6) ?? 'NA'}${finding.inferenceUnavailableReason ? `（${finding.inferenceUnavailableReason}）` : ''}`);
    console.log(`比较完成：${((performance.now() - started) / 1000).toFixed(2)}秒；${comparisonPath}；探索分析，不自动准入模型，正式ROI=null`);
  } catch (error) {
    for (const plan of plans.filter(plan => !plan.completed)) {
      try { finishBacktestRun(database, plan.id, null, null, error instanceof Error ? error.message : String(error)); }
      catch (registrationError) { console.error(`比较#${plan.id}失败登记失败：${String(registrationError)}`); }
    }
    throw error;
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`模型比较失败：${(error as Error).message}`); process.exitCode = 1; }
  finally { closeDatabase(); }
}