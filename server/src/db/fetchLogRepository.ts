/*
 * @Author: hp.com
 * @Date: 2026-10-31 13:38:35
 * @LastEditors: WRG
 * @LastEditTime: 2026-10-31 13:38:58
 * @😍: 😃😃
 */
/**
 * 采集日志数据访问
 *
 * 每次采集开始时写入一条 running 记录，结束时更新为 succeeded 或 failed，
 * 即使进程中途崩溃，也能从残留的 running 记录发现异常。
 */
import { formatBeijingTimestamp } from '../utils/time';
import type { SqliteDatabase } from './connection';

/** 采集方式 */
export type FetchMode = 'full_import' | 'incremental' | 'prize_detail_refresh';

/** 采集结束时的结果 */
export interface FetchLogOutcome {
  runStatus: 'succeeded' | 'failed';
  /** 从接口取得的记录数 */
  fetchedRecordCount: number;
  /** 新增入库的记录数 */
  insertedRecordCount: number;
  /** 更新的已有记录数 */
  updatedRecordCount: number;
  /** 失败原因或需要人工关注的说明 */
  errorMessage: string | null;
}

/**
 * 记录一次采集开始，返回日志编号。
 */
export function startFetchLog(
  database: SqliteDatabase,
  fetchMode: FetchMode,
  requestParams: Record<string, unknown>,
): number {
  const insertResult = database
    .prepare(
      `INSERT INTO fetch_logs (fetch_mode, request_params_json, run_status, started_at)
       VALUES (?, ?, 'running', ?)`,
    )
    .run(fetchMode, JSON.stringify(requestParams), formatBeijingTimestamp());
  return Number(insertResult.lastInsertRowid);
}

/**
 * 记录一次采集结束。
 */
export function finishFetchLog(database: SqliteDatabase, fetchLogId: number, outcome: FetchLogOutcome): void {
  database
    .prepare(
      `UPDATE fetch_logs SET
         run_status = ?,
         fetched_record_count = ?,
         inserted_record_count = ?,
         updated_record_count = ?,
         error_message = ?,
         finished_at = ?
       WHERE id = ?`,
    )
    .run(
      outcome.runStatus,
      outcome.fetchedRecordCount,
      outcome.insertedRecordCount,
      outcome.updatedRecordCount,
      outcome.errorMessage,
      formatBeijingTimestamp(),
      fetchLogId,
    );
}

/**
 * 把残留的 running 记录标记为 failed（通常是进程在采集中途被中断），返回标记条数。
 * 只应在定时任务启动时调用；请勿同时运行多个采集进程，否则会误标另一进程正在进行的采集。
 */
export function markInterruptedFetchLogs(database: SqliteDatabase): number {
  const updateResult = database
    .prepare(
      `UPDATE fetch_logs SET
         run_status = 'failed',
         error_message = '进程在采集过程中被中断',
         finished_at = ?
       WHERE run_status = 'running'`,
    )
    .run(formatBeijingTimestamp());
  return updateResult.changes;
}

/**
 * 统计最近连续失败的采集次数：从最新一条往前数，遇到成功即停止。
 * 仍在进行中（running）的记录不计入。
 */
export function countRecentConsecutiveFailures(database: SqliteDatabase, lookbackLimit = 20): number {
  const recentStatuses = database
    .prepare(
      `SELECT run_status AS runStatus FROM fetch_logs
       WHERE run_status != 'running'
       ORDER BY id DESC LIMIT ?`,
    )
    .all(lookbackLimit) as Array<{ runStatus: 'succeeded' | 'failed' }>;

  let consecutiveFailureCount = 0;
  for (const { runStatus } of recentStatuses) {
    if (runStatus !== 'failed') {
      break;
    }
    consecutiveFailureCount++;
  }
  return consecutiveFailureCount;
}
