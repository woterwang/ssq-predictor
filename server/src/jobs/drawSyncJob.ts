/**
 * 开奖数据同步定时任务
 *
 * 时间安排（北京时间，开奖时间为周二、四、日 21:15）：
 * - 开奖日 21:45：第 1 次同步（官方一般在开奖后不久公布号码）；
 * - 开奖日 22:30：第 2 次同步（号码未取到，或奖级明细尚未公布时再取一次）；
 * - 开奖日 23:30：当晚最后一次同步，仍未取到则输出警告，等待次日补拉；
 * - 每天 10:00：补拉（遗漏的开奖、晚到的奖级明细），仍缺少应有的开奖则发出告警。
 * 另外，调度器启动时立即执行一次补拉，弥补服务停机期间错过的同步。
 *
 * 告警条件：
 * - 每日补拉后，上一个开奖日的数据仍未取得；
 * - 采集连续失败达到 3 次。
 */
import { createCwlApiClientFromConfig } from '../collector/cwlApiClient';
import type { DrawNoticePageFetcher } from '../collector/cwlApiTypes';
import type { IncrementalSyncResult } from '../collector/incrementalSyncService';
import {
  findLatestScheduledDrawDateOnOrBefore,
  findSuspensionPeriodContaining,
  type SalesSuspensionPeriod,
} from '../calendar/drawCalendar';
import { loadSalesSuspensionPeriods } from '../calendar/salesSuspensionConfig';
import { getDatabase, type SqliteDatabase } from '../db/connection';
import { findLatestDraw } from '../db/drawRepository';
import { countRecentConsecutiveFailures, markInterruptedFetchLogs } from '../db/fetchLogRepository';
import { DRAW_WEEKDAYS } from '../domain/lottery';
import { logger } from '../utils/logger';
import { addDaysToDate, formatBeijingDateTimeForLog, getBeijingDateString } from '../utils/time';
import { startBeijingTimeScheduler, type BeijingScheduleRule, type RunningScheduler } from './beijingTimeScheduler';
import { processRecommendationLifecycle, runIncrementalSyncWorkflow, SyncAlreadyRunningError } from './syncWorkflow';

/**
 * 同步类型：
 * - draw_evening：开奖当晚的常规同步；
 * - draw_evening_final：开奖当晚最后一次同步；
 * - daily_catch_up：每日补拉（含启动时的补拉）。
 */
export type DrawSyncRunKind = 'draw_evening' | 'draw_evening_final' | 'daily_catch_up';

/** 同步任务的运行环境；测试时可替换其中任一项 */
export interface DrawSyncJobContext {
  database: SqliteDatabase;
  fetchPage: DrawNoticePageFetcher;
  /** 读取停售期配置；每次运行都重新读取，修改配置无需重启 */
  loadSuspensionPeriods: () => SalesSuspensionPeriod[];
  /** 获取当前时间 */
  now: () => Date;
}

/** 采集连续失败多少次后发出告警 */
const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 3;

/** 定时规则 */
const DRAW_SYNC_SCHEDULE: ReadonlyArray<BeijingScheduleRule & { runKind: DrawSyncRunKind }> = [
  { label: '开奖当晚第 1 次同步', weekdays: DRAW_WEEKDAYS, hour: 21, minute: 45, runKind: 'draw_evening' },
  { label: '开奖当晚第 2 次同步', weekdays: DRAW_WEEKDAYS, hour: 22, minute: 30, runKind: 'draw_evening' },
  { label: '开奖当晚最后一次同步', weekdays: DRAW_WEEKDAYS, hour: 23, minute: 30, runKind: 'draw_evening_final' },
  { label: '每日上午补拉', weekdays: null, hour: 10, minute: 0, runKind: 'daily_catch_up' },
];

/** 是否有同步正在进行；防止上一次未结束时又启动新的同步 */
let isSyncInProgress = false;

/**
 * 输出同步结果。
 */
function logSyncResult(syncResult: IncrementalSyncResult): void {
  const insertedText = syncResult.insertedIssues.length > 0 ? syncResult.insertedIssues.join('、') : '无';
  const updatedText = syncResult.updatedIssues.length > 0 ? syncResult.updatedIssues.join('、') : '无';
  logger.info(
    `同步完成：请求 ${syncResult.requestedPageCount} 次，新增期号 ${insertedText}，补全奖级明细 ${updatedText}`,
  );

  for (const rejectedDraw of syncResult.rejectedDraws) {
    logger.warn(`记录被拒绝：期号 ${rejectedDraw.issue ?? '未知'}，${rejectedDraw.errors.join('；')}`);
  }
  for (const conflictMessage of syncResult.conflictMessages) {
    logger.alert(conflictMessage);
  }
  if (syncResult.stillMissingIssues.length > 0) {
    logger.warn(`以下缺失期号接口也未返回：${syncResult.stillMissingIssues.join('、')}`);
  }
}

/**
 * 执行一次同步，并按同步类型检查“应有的开奖是否已取得”。
 * 出错时只记录日志，不向外抛出，保证定时任务持续运行。
 */
export async function runDrawSync(context: DrawSyncJobContext, runKind: DrawSyncRunKind): Promise<void> {
  if (isSyncInProgress) {
    logger.warn('上一次同步尚未结束，本次跳过');
    return;
  }
  isSyncInProgress = true;

  try {
    const { database } = context;
    const today = getBeijingDateString(context.now());
    const suspensionPeriods = context.loadSuspensionPeriods();
    const isEveningRun = runKind !== 'daily_catch_up';

    if (isEveningRun) {
      const currentSuspension = findSuspensionPeriodContaining(today, suspensionPeriods);
      if (currentSuspension !== null) {
        logger.info(`今天处于停售期（${currentSuspension.reason}），跳过同步`);
        return;
      }
      const latestDraw = findLatestDraw(database);
      if (latestDraw !== null && latestDraw.drawDate === today && latestDraw.isPrizeDetailComplete) {
        const lifecycle = processRecommendationLifecycle(database, suspensionPeriods, context.now());
        logger.info(`今晚开奖（${latestDraw.issue}）已完整，跳过网络同步；核验新增${lifecycle.verification.verifiedCount}条，下一期推荐状态${lifecycle.generationStatus}`);
        return;
      }
    }

    const { synchronization: syncResult, lifecycle } = await runIncrementalSyncWorkflow(context);
    logSyncResult(syncResult);
    logger.info(`推荐核验：新增${lifecycle.verification.verifiedCount}、待开奖${lifecycle.verification.pendingCount}、跳过${lifecycle.verification.skippedCount}；下一期推荐${lifecycle.generationStatus}`);
    if (lifecycle.verification.skippedCount > 0) logger.alert('有推荐未通过核验条件，请检查元数据与内容哈希');

    // 应已取得的最近一期开奖日期：当晚同步看今天；每日补拉看昨天及以前最近的开奖日
    const expectedDrawDate = isEveningRun
      ? today
      : findLatestScheduledDrawDateOnOrBefore(addDaysToDate(today, -1), suspensionPeriods);
    const latestDrawAfterSync = findLatestDraw(database);
    const hasExpectedDraw = latestDrawAfterSync !== null && latestDrawAfterSync.drawDate >= expectedDrawDate;

    if (!hasExpectedDraw) {
      if (runKind === 'draw_evening_final') {
        logger.warn(`今晚（${today}）的开奖数据仍未取得，将在次日 10:00 补拉`);
      } else if (runKind === 'daily_catch_up') {
        logger.alert(
          `应于 ${expectedDrawDate} 开奖的数据仍未取得（库内最新为 ${latestDrawAfterSync?.issue ?? '无'}），` +
            `请检查网络、官方接口，或该日是否为未配置的停售期`,
        );
      }
      // 当晚前两次同步未取到属于正常情况，等待后续同步即可
    } else if (runKind === 'daily_catch_up' && latestDrawAfterSync !== null && !latestDrawAfterSync.isPrizeDetailComplete) {
      logger.warn(`期号 ${latestDrawAfterSync.issue} 的奖级明细仍未完整，后续同步会继续补全`);
    }
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      logger.warn('管理接口或其他任务正在同步，本次定时任务跳过');
      return;
    }
    const errorMessage = (error as Error).message;
    logger.error(`同步失败：${errorMessage}`);

    const consecutiveFailureCount = countRecentConsecutiveFailures(context.database);
    if (consecutiveFailureCount >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD) {
      logger.alert(`采集已连续失败 ${consecutiveFailureCount} 次，请检查网络或官方接口。最近一次错误：${errorMessage}`);
    }
  } finally {
    isSyncInProgress = false;
  }
}

/**
 * 启动定时同步。
 */
export function startDrawSyncScheduler(context: DrawSyncJobContext): RunningScheduler {
  // 上次进程中断时可能留下“进行中”的采集日志，先标记为失败
  const interruptedLogCount = markInterruptedFetchLogs(context.database);
  if (interruptedLogCount > 0) {
    logger.warn(`发现 ${interruptedLogCount} 条因进程中断而未完成的采集日志，已标记为失败`);
  }

  const scheduler = startBeijingTimeScheduler(
    DRAW_SYNC_SCHEDULE.map((scheduleRule) => ({
      rule: scheduleRule,
      run: () => runDrawSync(context, scheduleRule.runKind),
    })),
  );

  logger.info('开奖数据定时同步已启动，各任务下一次运行时间（北京时间）：');
  for (const { label, nextRunAt } of scheduler.listNextRunTimes()) {
    logger.info(`  ${formatBeijingDateTimeForLog(nextRunAt)}  ${label}`);
  }

  // 启动时立即补拉一次，弥补停机期间错过的同步
  void runDrawSync(context, 'daily_catch_up');

  return scheduler;
}

/**
 * 使用正式配置（共享数据库连接、官方接口、停售期配置文件、系统时间）创建运行环境。
 */
export function createDefaultDrawSyncJobContext(): DrawSyncJobContext {
  const apiClient = createCwlApiClientFromConfig();
  return {
    database: getDatabase(),
    fetchPage: (query) => apiClient.fetchDrawNoticePage(query),
    loadSuspensionPeriods: () => loadSalesSuspensionPeriods(),
    now: () => new Date(),
  };
}
