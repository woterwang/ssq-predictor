/**
 * 定时任务与管理同步共用的入口：同一数据库同一进程只允许一次网络同步。
 * 顺序固定为开奖同步→核验已有推荐→固化下一期M0。不同进程仍须部署为单实例。
 */
import type { SqliteDatabase } from '../db/connection';
import type { DrawNoticePageFetcher } from '../collector/cwlApiTypes';
import { syncLatestDraws } from '../collector/incrementalSyncService';
import { findLatestDraw } from '../db/drawRepository';
import { computeNextDraw } from '../calendar/drawCalendar';
import type { SalesSuspensionPeriod } from '../calendar/drawCalendar';
import { generateNextRecommendation, getConservativeGenerationDeadline, verifyPendingRecommendations } from '../recommend/recommendationService';

export interface SyncWorkflowContext {
  database: SqliteDatabase;
  fetchPage: DrawNoticePageFetcher;
  loadSuspensionPeriods: () => SalesSuspensionPeriod[];
  now: () => Date;
}

const busyDatabases = new WeakSet<SqliteDatabase>();
export class SyncAlreadyRunningError extends Error {
  constructor() { super('同一数据库的开奖同步正在运行'); }
}

/** 无写入伪造日期；只有真实服务器时间处于合法生成窗口才生成。 */
export function processRecommendationLifecycle(database: SqliteDatabase, periods: readonly SalesSuspensionPeriod[], now: Date) {
  const verification = verifyPendingRecommendations(database, now);
  const latest = findLatestDraw(database);
  if (!latest) return { verification, recommendation: null, generationStatus: 'empty_history' as const };
  const target = computeNextDraw(latest, periods);
  const latestDrawTime = Date.parse(`${latest.drawDate}T21:15:00.000+08:00`);
  if (now.getTime() <= latestDrawTime) {
    return { verification, recommendation: null, generationStatus: 'source_not_drawn' as const };
  }
  if (now.getTime() >= Date.parse(getConservativeGenerationDeadline(target.drawDate))) {
    return { verification, recommendation: null, generationStatus: 'deadline_passed_or_stale' as const };
  }
  return { verification, recommendation: generateNextRecommendation(database, periods, now), generationStatus: 'available' as const };
}

export async function runIncrementalSyncWorkflow(context: SyncWorkflowContext) {
  if (busyDatabases.has(context.database)) throw new SyncAlreadyRunningError();
  busyDatabases.add(context.database);
  try {
    const synchronization = await syncLatestDraws(context.database, context.fetchPage);
    // 网络等待后重新取时间、重新加载日历，不能沿用请求开始时已经过期的生成窗口。
    const lifecycle = processRecommendationLifecycle(context.database, context.loadSuspensionPeriods(), context.now());
    return { synchronization, lifecycle };
  } finally { busyDatabases.delete(context.database); }
}

/** 停机时等待正在进行的工作，不能在其写库前关闭数据库。 */
export function isDatabaseSyncRunning(database: SqliteDatabase): boolean {
  return busyDatabases.has(database);
}