/**
 * 基础统计命令：npm run analyze:basic
 * 默认输出全量/30/100/300 期简报，JSON 报告保存于 server/data/reports/。
 * 可选 --window=100（或 all）、--as-of-issue=2026123，支持复核历史时点。
 * 本命令不请求外网、不修改开奖表；历史缺口会直接显示，不声称预测有效。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getBasicAnalysis } from '../src/analysis/basicAnalysisService';
import { SERVER_ROOT_DIR } from '../src/config';
import { closeDatabase, getDatabase } from '../src/db/connection';

function main(): void {
  const allowedArguments = ['--window=', '--as-of-issue='];
  const argumentsList = process.argv.slice(2);
  for (const argument of argumentsList) {
    if (!allowedArguments.some((prefix) => argument.startsWith(prefix))) throw new Error(`未知参数：${argument}`);
  }
  const windowText = argumentsList.find((argument) => argument.startsWith('--window='))?.slice('--window='.length);
  const asOfIssue = argumentsList.find((argument) => argument.startsWith('--as-of-issue='))?.slice('--as-of-issue='.length);
  const windows = windowText === undefined ? [null, 30, 100, 300] : [windowText === 'all' ? null : Number(windowText)];
  const database = getDatabase();
  const reports = windows.map((window) => getBasicAnalysis(database, { window, asOfIssue }));
  for (const report of reports) {
    console.log(`\n窗口 ${report.requestedWindow ?? '全部可用历史'}：${report.sampleDrawCount} 期，${report.firstIssue ?? '无'}–${report.lastIssue ?? '无'}`);
    for (const warning of report.warnings) console.log(`  提示：${warning}`);
    // 并列频次按号码升序展示，不将其解释为命中率排名。
    const mostFrequentReds = [...report.redNumbers].sort((left, right) => right.appearanceCount - left.appearanceCount || left.number - right.number).slice(0, 6);
    console.log(`  红球频次前六：${mostFrequentReds.map((item) => `${String(item.number).padStart(2, '0')}(${item.appearanceCount}次)`).join(' ')}`);
    console.log('  最新一期组合特征：', JSON.stringify(report.features[report.features.length - 1] ?? null));
  }
  const outputDirectory = path.join(SERVER_ROOT_DIR, 'data', 'reports');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `basic-statistics-${asOfIssue ?? 'latest'}-${windowText ?? 'default'}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(reports, null, 2), 'utf8');
  console.log(`\n完整统计 JSON：${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(`统计失败：${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  closeDatabase();
}