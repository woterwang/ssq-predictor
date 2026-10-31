/**
 * 手动执行一次增量更新
 *
 * 用法：npm run sync:latest
 *
 * 作用：拉取新开奖、补全最近奖级明细、补回最近 100 期内缺失的期号，
 * 然后输出最新 3 期和推算的下一期开奖信息。可重复执行，不会产生重复数据。
 */
import { computeNextDraw } from '../src/calendar/drawCalendar';
import { loadSalesSuspensionPeriods } from '../src/calendar/salesSuspensionConfig';
import { createCwlApiClientFromConfig } from '../src/collector/cwlApiClient';
import { syncLatestDraws } from '../src/collector/incrementalSyncService';
import { closeDatabase, getDatabase } from '../src/db/connection';
import { findLatestDraw, listLatestDraws } from '../src/db/drawRepository';

async function main(): Promise<void> {
  const database = getDatabase();
  const apiClient = createCwlApiClientFromConfig();

  const syncResult = await syncLatestDraws(database, (query) => apiClient.fetchDrawNoticePage(query));

  const describeIssues = (issues: readonly string[]): string => (issues.length > 0 ? issues.join('、') : '无');
  console.log(`更新前最新期号：${syncResult.previousLatestIssue}`);
  console.log(`本次检查到期号：${syncResult.lowestIssueToFetch}（请求接口 ${syncResult.requestedPageCount} 次）`);
  console.log(`新增期号：${describeIssues(syncResult.insertedIssues)}`);
  console.log(`补全奖级明细：${describeIssues(syncResult.updatedIssues)}`);

  if (syncResult.stillMissingIssues.length > 0) {
    console.log(`接口也未返回的缺失期号：${syncResult.stillMissingIssues.join('、')}`);
  }
  for (const rejectedDraw of syncResult.rejectedDraws) {
    console.log(`被拒绝：期号 ${rejectedDraw.issue ?? '未知'}，${rejectedDraw.errors.join('；')}`);
  }
  for (const conflictMessage of syncResult.conflictMessages) {
    console.log(`冲突：${conflictMessage}`);
  }

  const formatBall = (ballNumber: number): string => String(ballNumber).padStart(2, '0');
  console.log('\n最新 3 期：');
  for (const draw of listLatestDraws(database, 3)) {
    const prizeStatus = draw.isPrizeDetailComplete ? '奖级完整' : '奖级待补全';
    console.log(
      `  ${draw.issue}  ${draw.drawDate}  红 ${draw.redBalls.map(formatBall).join(' ')}  蓝 ${formatBall(draw.blueBall)}  ${prizeStatus}`,
    );
  }

  const latestDraw = findLatestDraw(database);
  if (latestDraw !== null) {
    const nextDraw = computeNextDraw(latestDraw, loadSalesSuspensionPeriods());
    console.log(`\n下一期：${nextDraw.issue}，开奖时间 ${nextDraw.drawDate} ${nextDraw.drawTimeBeijing}（北京时间）`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(`增量更新失败：${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
