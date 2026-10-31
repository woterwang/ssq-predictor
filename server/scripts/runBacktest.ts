/** M0离线回测入口。输出存data/reports，不自动提交报告、不覆盖既有运行。 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SERVER_ROOT_DIR } from '../src/config';
import { closeDatabase, getDatabase } from '../src/db/connection';
import { ensureHoldoutRegistered, finishBacktestRun, readBacktestDraws, startBacktestRun } from '../src/db/backtestRepository';
import { uniformRandomStrategy } from '../src/models/uniformRandomModel';
import { runWalkForwardBacktest } from '../src/backtest/walkForwardEngine';
import { parseBacktestArguments } from '../src/backtest/backtestArguments';

function main(): void {
  const options = parseBacktestArguments(process.argv.slice(2));
  const database = getDatabase();
  const started = performance.now();
  const id = startBacktestRun(database, uniformRandomStrategy, options);
  try {
    ensureHoldoutRegistered(database);
    const draws = readBacktestDraws(database, options.endIssue);
    console.log(`回测#${id}：${options.startIssue}–${options.endIssue}，每期${options.ticketsPerIssue}注，${options.repetitions}次，seed=${options.seed}`);
    const report = runWalkForwardBacktest(draws, uniformRandomStrategy, options);
    const detailPath = path.join(SERVER_ROOT_DIR, 'data', 'reports', `backtest-${id}-M0-${options.seed}.json`);
    fs.mkdirSync(path.dirname(detailPath), { recursive: true });
    const output = { ...report, runId: id, generatedAt: new Date().toISOString(), elapsedSeconds: (performance.now() - started) / 1000 };
    // wx禁止覆盖，登记id虽自增，仍防止复制数据库/重建后覆盖旧报告。
    fs.writeFileSync(detailPath, JSON.stringify(output, null, 2), { encoding: 'utf8', flag: 'wx' });
    finishBacktestRun(database, id, report, path.relative(SERVER_ROOT_DIR, detailPath).replace(/\\/g, '/'), null);
    console.log(JSON.stringify({ runId: id, coverage: report.coverage, distributions: report.distributions,
      calibration: report.calibration, withheldIssues: report.payoutAudit.withheldIssues.length, formalRoiAvailable: false }, null, 2));
    console.log(`回测完成：${output.elapsedSeconds.toFixed(2)}秒；报告：${detailPath}`);
  } catch (error) {
    // 失败登记本身若遇到磁盘/数据库异常，不覆盖原始错误。
    try { finishBacktestRun(database, id, null, null, error instanceof Error ? error.message : String(error)); }
    catch (registrationError) { console.error(`回测#${id}失败登记也失败：${String(registrationError)}`); }
    throw error;
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`回测失败：${(error as Error).message}`); process.exitCode = 1; }
  finally { closeDatabase(); }
}