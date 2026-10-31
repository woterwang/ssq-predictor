/**
 * 开奖数据导入服务
 *
 * 负责“取数据 → 解析校验 → 入库”的完整流程：
 * - 取数据通过 DrawNoticePageFetcher 注入，可替换为其他数据源或本地样本；
 * - 入库规则（saveDraws）：
 *     新期号                         → 新增；
 *     已有期号，开奖号码或日期不一致   → 记为冲突，不覆盖（需人工核查）；
 *     已有期号，奖级明细尚未完整      → 用新数据更新销售、奖池与奖级明细；
 *     已有期号，奖级明细已完整        → 保持不变；
 * - 可重复执行：同样的数据导入多次，结果不变。
 */
import type { SqliteDatabase } from '../db/connection';
import { findDrawByIssue, insertDraw, updateDrawPrizeDetail } from '../db/drawRepository';
import { finishFetchLog, startFetchLog } from '../db/fetchLogRepository';
import type { DrawRecord, StoredDrawRecord } from '../domain/lottery';
import { formatBeijingTimestamp } from '../utils/time';
import type { CwlDrawNoticeItemRaw, DrawNoticePageFetcher } from './cwlApiTypes';
import { parseDrawNoticeItem } from './drawParser';

/** 全量导入默认每页条数（与官网页面一致） */
const DEFAULT_PAGE_SIZE = 30;
/**
 * 单年最多翻页数。每年约 150 期，按每页 30 条约 5–6 页；
 * 超过上限说明期号区间参数可能未生效（接口返回了全部历史），立即停止以免无效请求。
 */
const MAX_PAGES_PER_YEAR = 20;

/** 入库结果汇总 */
export interface DrawSaveSummary {
  /** 新增的期号 */
  insertedIssues: string[];
  /** 更新了奖级明细的期号 */
  updatedIssues: string[];
  /** 未发生变化的记录数 */
  unchangedCount: number;
  /** 冲突或写入失败的说明，需人工核查 */
  conflictMessages: string[];
}

/** 校验未通过、被拒绝入库的记录 */
export interface RejectedDraw {
  issue: string | null;
  errors: string[];
}

/** 单个年份的导入结果 */
export interface YearImportResult {
  year: number;
  /** 接口报告的该年记录总数 */
  reportedTotal: number;
  /** 实际取得的记录数 */
  fetchedCount: number;
  rejectedDraws: RejectedDraw[];
  saveSummary: DrawSaveSummary;
}

/** 全量导入报告 */
export interface FullImportReport {
  yearResults: YearImportResult[];
  totalFetchedCount: number;
  totalInsertedCount: number;
  totalUpdatedCount: number;
  totalRejectedCount: number;
  totalConflictCount: number;
}

/** 全量导入参数 */
export interface FullImportOptions {
  /** 起始年份（含） */
  fromYear: number;
  /** 结束年份（含） */
  toYear: number;
  /** 每页条数，默认 30 */
  pageSize?: number;
  /** 每完成一年回调一次，用于输出进度 */
  onYearFinished?: (yearResult: YearImportResult) => void;
}

/**
 * 判断两条记录的开奖结果（日期、红球、蓝球）是否一致。
 */
function hasSameDrawResult(storedDraw: StoredDrawRecord, incomingDraw: DrawRecord): boolean {
  return (
    storedDraw.drawDate === incomingDraw.drawDate &&
    storedDraw.blueBall === incomingDraw.blueBall &&
    storedDraw.redBalls.every((redBall, index) => redBall === incomingDraw.redBalls[index])
  );
}

/**
 * 格式化开奖结果，用于冲突说明，如 2026-10-29 03 11 17 22 23 29 + 09。
 */
function describeDrawResult(draw: DrawRecord): string {
  const formatBall = (ballNumber: number): string => String(ballNumber).padStart(2, '0');
  return `${draw.drawDate} ${draw.redBalls.map(formatBall).join(' ')} + ${formatBall(draw.blueBall)}`;
}

/**
 * 把已校验的开奖记录写入数据库（单个事务）。
 */
export function saveDraws(database: SqliteDatabase, draws: readonly DrawRecord[]): DrawSaveSummary {
  const summary: DrawSaveSummary = { insertedIssues: [], updatedIssues: [], unchangedCount: 0, conflictMessages: [] };
  const currentTimestamp = formatBeijingTimestamp();

  const saveAllInTransaction = database.transaction(() => {
    for (const incomingDraw of draws) {
      try {
        const storedDraw = findDrawByIssue(database, incomingDraw.issue);

        if (storedDraw === null) {
          insertDraw(database, incomingDraw, currentTimestamp);
          summary.insertedIssues.push(incomingDraw.issue);
          continue;
        }

        if (!hasSameDrawResult(storedDraw, incomingDraw)) {
          summary.conflictMessages.push(
            `期号 ${incomingDraw.issue} 开奖结果不一致，未覆盖：库内 ${describeDrawResult(storedDraw)}，新数据 ${describeDrawResult(incomingDraw)}`,
          );
          continue;
        }

        // 奖级明细已完整的记录不再改动；未完整且有新内容时才更新
        const hasNewPrizeContent = storedDraw.rawRecordJson !== incomingDraw.rawRecordJson;
        if (!storedDraw.isPrizeDetailComplete && hasNewPrizeContent) {
          updateDrawPrizeDetail(database, incomingDraw, currentTimestamp);
          summary.updatedIssues.push(incomingDraw.issue);
        } else {
          summary.unchangedCount++;
        }
      } catch (error) {
        // 单条写入失败（如开奖日期与其他期重复）只回滚这一条，并记录原因，不影响其他记录
        summary.conflictMessages.push(`期号 ${incomingDraw.issue} 写入失败：${(error as Error).message}`);
      }
    }
  });

  saveAllInTransaction();
  return summary;
}

/**
 * 解析并校验一批原始记录，分为有效记录与被拒绝记录。
 * expectedYear 不为空时，额外要求期号属于该年份（防止接口忽略查询参数返回其他年份数据）。
 */
export function parseRawDrawItems(
  rawItems: readonly CwlDrawNoticeItemRaw[],
  expectedYear: number | null,
): { validDraws: DrawRecord[]; rejectedDraws: RejectedDraw[] } {
  const validDraws: DrawRecord[] = [];
  const rejectedDraws: RejectedDraw[] = [];

  for (const rawItem of rawItems) {
    const parseResult = parseDrawNoticeItem(rawItem);
    if (!parseResult.isValid) {
      rejectedDraws.push({ issue: parseResult.issue, errors: parseResult.errors });
      continue;
    }
    if (expectedYear !== null && parseResult.draw.issue.slice(0, 4) !== String(expectedYear)) {
      rejectedDraws.push({
        issue: parseResult.draw.issue,
        errors: [`期号不属于请求的年份 ${expectedYear}，接口可能未按期号区间过滤`],
      });
      continue;
    }
    validDraws.push(parseResult.draw);
  }

  return { validDraws, rejectedDraws };
}

/**
 * 导入某一年的全部开奖数据（按期号区间 YYYY001–YYYY999 分页拉取）。
 */
async function importOneYear(
  database: SqliteDatabase,
  fetchPage: DrawNoticePageFetcher,
  year: number,
  pageSize: number,
): Promise<YearImportResult> {
  const issueStart = `${year}001`;
  // 每年期数远小于 999，用 999 作为结束期号即可覆盖全年
  const issueEnd = `${year}999`;

  const rawItems: CwlDrawNoticeItemRaw[] = [];
  let reportedTotal = 0;

  for (let pageNo = 1; ; pageNo++) {
    if (pageNo > MAX_PAGES_PER_YEAR) {
      throw new Error(`${year} 年分页数超过 ${MAX_PAGES_PER_YEAR} 页，期号区间参数可能未生效，已停止导入`);
    }
    const pageResponse = await fetchPage({ issueStart, issueEnd, pageNo, pageSize });
    reportedTotal = pageResponse.total;
    rawItems.push(...pageResponse.result);

    const isLastPage = pageNo >= pageResponse.pageNum || pageResponse.result.length === 0;
    if (isLastPage) {
      break;
    }
  }

  const { validDraws, rejectedDraws } = parseRawDrawItems(rawItems, year);
  const saveSummary = saveDraws(database, validDraws);

  return { year, reportedTotal, fetchedCount: rawItems.length, rejectedDraws, saveSummary };
}

/**
 * 汇总各年份结果。
 */
function summarizeYearResults(yearResults: readonly YearImportResult[]): FullImportReport {
  const sumBy = (pickValue: (yearResult: YearImportResult) => number): number =>
    yearResults.reduce((total, yearResult) => total + pickValue(yearResult), 0);

  return {
    yearResults: [...yearResults],
    totalFetchedCount: sumBy((yearResult) => yearResult.fetchedCount),
    totalInsertedCount: sumBy((yearResult) => yearResult.saveSummary.insertedIssues.length),
    totalUpdatedCount: sumBy((yearResult) => yearResult.saveSummary.updatedIssues.length),
    totalRejectedCount: sumBy((yearResult) => yearResult.rejectedDraws.length),
    totalConflictCount: sumBy((yearResult) => yearResult.saveSummary.conflictMessages.length),
  };
}

/**
 * 全量导入：按年份逐年拉取并入库，整个过程记录一条采集日志。
 * 中途失败时，已完成年份的数据保留；修正问题后可用 fromYear 从失败年份继续。
 */
export async function importFullHistory(
  database: SqliteDatabase,
  fetchPage: DrawNoticePageFetcher,
  options: FullImportOptions,
): Promise<FullImportReport> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const fetchLogId = startFetchLog(database, 'full_import', {
    fromYear: options.fromYear,
    toYear: options.toYear,
    pageSize,
  });

  const yearResults: YearImportResult[] = [];
  try {
    for (let year = options.fromYear; year <= options.toYear; year++) {
      const yearResult = await importOneYear(database, fetchPage, year, pageSize);
      yearResults.push(yearResult);
      options.onYearFinished?.(yearResult);
    }

    const report = summarizeYearResults(yearResults);
    const needsAttention = report.totalRejectedCount > 0 || report.totalConflictCount > 0;
    finishFetchLog(database, fetchLogId, {
      runStatus: 'succeeded',
      fetchedRecordCount: report.totalFetchedCount,
      insertedRecordCount: report.totalInsertedCount,
      updatedRecordCount: report.totalUpdatedCount,
      errorMessage: needsAttention
        ? `需人工核查：拒绝 ${report.totalRejectedCount} 条，冲突 ${report.totalConflictCount} 条`
        : null,
    });
    return report;
  } catch (error) {
    const partialReport = summarizeYearResults(yearResults);
    const lastFinishedYear = yearResults.length > 0 ? yearResults[yearResults.length - 1].year : null;
    finishFetchLog(database, fetchLogId, {
      runStatus: 'failed',
      fetchedRecordCount: partialReport.totalFetchedCount,
      insertedRecordCount: partialReport.totalInsertedCount,
      updatedRecordCount: partialReport.totalUpdatedCount,
      errorMessage: `${(error as Error).message}（已完成年份：${lastFinishedYear ?? '无'}）`,
    });
    throw error;
  }
}
