/**
 * 全量导入历史开奖数据
 *
 * 用法：
 *   npm run import:full                                  导入官方接口覆盖的 2013 年至今数据
 *   npm run import:full -- --from-year=2015              从 2015 年导入到今年（中途失败后续跑）
 *   npm run import:full -- --from-year=2020 --to-year=2021
 *
 * 可重复执行：已入库的期号不会重复写入；奖级明细未完整的期会被补全。
 * 结束后输出：各年导入情况、被拒绝记录、冲突记录、序列完整性问题、最近 5 期（供与官网抽查比对）。
 */
import { loadSalesSuspensionPeriods } from '../src/calendar/salesSuspensionConfig';
import { createCwlApiClientFromConfig } from '../src/collector/cwlApiClient';
import { importFullHistory, type YearImportResult } from '../src/collector/drawImportService';
import { findDrawSequenceProblems } from '../src/collector/drawSequenceValidator';
import { closeDatabase, getDatabase } from '../src/db/connection';
import {
  countDraws,
  listAllDrawIssueAndDates,
  listIssuesWithIncompletePrizeDetail,
  listLatestDraws,
} from '../src/db/drawRepository';
import { CWL_API_FIRST_AVAILABLE_YEAR, FIRST_DRAW_YEAR } from '../src/domain/lottery';
import { getBeijingYear } from '../src/utils/time';

/** 最多逐条打印的问题数，超出部分只给出数量 */
const MAX_PRINTED_PROBLEMS = 50;

/**
 * 读取形如 --from-year=2015 的年份参数；未提供时返回默认值。
 */
function readYearArgument(argumentName: string, defaultYear: number): number {
  const argumentPrefix = `--${argumentName}=`;
  const matchedArgument = process.argv.slice(2).find((argument) => argument.startsWith(argumentPrefix));
  if (matchedArgument === undefined) {
    return defaultYear;
  }
  const year = Number(matchedArgument.slice(argumentPrefix.length));
  const currentYear = getBeijingYear();
  if (!Number.isInteger(year) || year < FIRST_DRAW_YEAR || year > currentYear) {
    throw new Error(`参数 --${argumentName} 必须是 ${FIRST_DRAW_YEAR}–${currentYear} 之间的年份`);
  }
  return year;
}

/**
 * 打印列表，超过上限时省略剩余部分。
 */
function printLimitedList(title: string, lines: readonly string[]): void {
  if (lines.length === 0) {
    return;
  }
  console.log(`\n${title}（共 ${lines.length} 条）：`);
  for (const line of lines.slice(0, MAX_PRINTED_PROBLEMS)) {
    console.log(`  - ${line}`);
  }
  if (lines.length > MAX_PRINTED_PROBLEMS) {
    console.log(`  …… 其余 ${lines.length - MAX_PRINTED_PROBLEMS} 条省略`);
  }
}

/**
 * 输出单年导入进度。
 */
function printYearProgress(yearResult: YearImportResult): void {
  const { year, reportedTotal, fetchedCount, rejectedDraws, saveSummary } = yearResult;
  const countMismatchHint = reportedTotal !== fetchedCount ? '  ⚠ 取得条数与接口报告总数不一致' : '';
  console.log(
    `${year} 年：接口报告 ${reportedTotal} 条，取得 ${fetchedCount} 条，` +
      `新增 ${saveSummary.insertedIssues.length}，更新 ${saveSummary.updatedIssues.length}，未变 ${saveSummary.unchangedCount}，` +
      `拒绝 ${rejectedDraws.length}，冲突 ${saveSummary.conflictMessages.length}${countMismatchHint}`,
  );
}

async function main(): Promise<void> {
  const fromYear = readYearArgument('from-year', CWL_API_FIRST_AVAILABLE_YEAR);
  const toYear = readYearArgument('to-year', getBeijingYear());
  if (fromYear > toYear) {
    throw new Error(`起始年份 ${fromYear} 不能晚于结束年份 ${toYear}`);
  }

  console.log(`开始全量导入：${fromYear}–${toYear} 年\n`);
  console.log('数据覆盖提示：本接口实测从 2013001 起；2003–2012 年尚需独立数据源补齐。\n');
  const database = getDatabase();
  const apiClient = createCwlApiClientFromConfig();

  const report = await importFullHistory(database, (query) => apiClient.fetchDrawNoticePage(query), {
    fromYear,
    toYear,
    onYearFinished: printYearProgress,
  });

  console.log(
    `\n本次合计：取得 ${report.totalFetchedCount} 条，新增 ${report.totalInsertedCount}，` +
      `更新 ${report.totalUpdatedCount}，拒绝 ${report.totalRejectedCount}，冲突 ${report.totalConflictCount}`,
  );

  // 被拒绝与冲突的记录需要人工核查
  const rejectedLines = report.yearResults.flatMap((yearResult) =>
    yearResult.rejectedDraws.map((rejectedDraw) => `期号 ${rejectedDraw.issue ?? '未知'}：${rejectedDraw.errors.join('；')}`),
  );
  const conflictLines = report.yearResults.flatMap((yearResult) => yearResult.saveSummary.conflictMessages);
  printLimitedList('被拒绝的记录', rejectedLines);
  printLimitedList('冲突或写入失败的记录', conflictLines);

  // 基于库内全部数据做序列完整性检查（含年末缺期检查，需要停售期配置）
  const sequenceProblems = findDrawSequenceProblems(listAllDrawIssueAndDates(database), loadSalesSuspensionPeriods());
  console.log(`\n库内共 ${countDraws(database)} 期`);
  if (sequenceProblems.length === 0) {
    console.log('序列检查：未发现期号缺失或日期顺序问题');
  } else {
    printLimitedList(
      '序列检查发现的问题',
      sequenceProblems.map((problem) => problem.message),
    );
  }

  const incompleteIssues = listIssuesWithIncompletePrizeDetail(database);
  if (incompleteIssues.length > 0) {
    printLimitedList('奖级明细未完整的期号（可稍后重新导入补全）', incompleteIssues);
  }

  // 最近 5 期，供人工与官网抽查比对
  console.log('\n最近 5 期（请与官网抽查比对）：');
  for (const draw of listLatestDraws(database, 5)) {
    const formatBall = (ballNumber: number): string => String(ballNumber).padStart(2, '0');
    console.log(
      `  ${draw.issue}  ${draw.drawDate}  红 ${draw.redBalls.map(formatBall).join(' ')}  蓝 ${formatBall(draw.blueBall)}` +
        `  销售额 ${draw.salesAmountYuan ?? '未公布'}  奖池 ${draw.prizePoolAmountYuan ?? '未公布'}`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(`\n导入失败：${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
