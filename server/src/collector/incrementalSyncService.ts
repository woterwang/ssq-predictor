/**
 * 增量更新服务
 *
 * 每次运行做三件事（通常只需请求 1 次接口）：
 * 1. 拉取库内最新一期之后的新开奖；
 * 2. 补全最近 10 期中奖级明细尚未完整的记录（官方奖级明细可能晚于开奖号码公布）；
 * 3. 补回最近 100 期范围内缺失的期号（如数据被误删）。
 *
 * 实现方式：
 * - 用 issueCount=100 请求官方“最近 100 期”，按期号倒序分页（每页 30 条，最多 4 页）；
 * - 先算出“需要获取的最小期号”，翻页直到覆盖该期号即停止，因此大多数情况下只请求第 1 页；
 * - 若最近 100 期都覆盖不到（库内数据过旧），不写入任何数据，提示改用全量导入补齐，
 *   避免在库内留下一段无法自动修复的空缺。
 */
import type { SqliteDatabase } from '../db/connection';
import { listLatestDraws } from '../db/drawRepository';
import { finishFetchLog, startFetchLog } from '../db/fetchLogRepository';
import type { CwlDrawNoticeItemRaw, DrawNoticePageFetcher } from './cwlApiTypes';
import { parseRawDrawItems, saveDraws, type RejectedDraw } from './drawImportService';
import { findDrawSequenceProblems } from './drawSequenceValidator';

/** 增量更新覆盖的范围：官方最近 100 期 */
const INCREMENTAL_WINDOW_DRAW_COUNT = 100;
/** 每页条数 */
const INCREMENTAL_PAGE_SIZE = 30;
/** 最多翻页数：100 期按每页 30 条共 4 页 */
const INCREMENTAL_MAX_PAGES = Math.ceil(INCREMENTAL_WINDOW_DRAW_COUNT / INCREMENTAL_PAGE_SIZE);
/** 检查奖级明细是否完整的最近期数 */
const RECENT_PRIZE_REFRESH_DRAW_COUNT = 10;

/** 增量更新结果 */
export interface IncrementalSyncResult {
  /** 更新前库内最新期号 */
  previousLatestIssue: string;
  /** 本次需要获取的最小期号（决定翻页深度） */
  lowestIssueToFetch: string;
  /** 请求接口的次数 */
  requestedPageCount: number;
  /** 从接口取得的记录数 */
  fetchedCount: number;
  /** 新增的期号（含补回的缺失期号） */
  insertedIssues: string[];
  /** 补全了奖级明细的期号 */
  updatedIssues: string[];
  /** 本次计划补回、但接口也没有返回的缺失期号 */
  stillMissingIssues: string[];
  /** 校验未通过的记录 */
  rejectedDraws: RejectedDraw[];
  /** 冲突或写入失败的说明 */
  conflictMessages: string[];
}

/**
 * 读取原始记录中的期号，用于判断翻页是否已覆盖目标期号。
 * 这里只做粗略读取，记录是否合法由后续解析校验决定。
 */
function readRawIssue(rawItem: CwlDrawNoticeItemRaw): string {
  return typeof rawItem.code === 'string' ? rawItem.code.trim() : '';
}

/**
 * 执行一次增量更新。
 */
export async function syncLatestDraws(
  database: SqliteDatabase,
  fetchPage: DrawNoticePageFetcher,
): Promise<IncrementalSyncResult> {
  // 库内最近 100 期（按期号倒序）
  const recentStoredDraws = listLatestDraws(database, INCREMENTAL_WINDOW_DRAW_COUNT);
  if (recentStoredDraws.length === 0) {
    throw new Error('库内没有开奖数据，请先运行 npm run import:full 全量导入');
  }
  const previousLatestIssue = recentStoredDraws[0].issue;
  const oldestRecentIssue = recentStoredDraws[recentStoredDraws.length - 1].issue;

  // 最近 10 期中奖级明细未完整的期号
  const incompletePrizeIssues = recentStoredDraws
    .slice(0, RECENT_PRIZE_REFRESH_DRAW_COUNT)
    .filter((draw) => !draw.isPrizeDetailComplete)
    .map((draw) => draw.issue);

  // 最近 100 期范围内缺失的期号。
  // 只取比范围内最早一期更晚的缺失期号：范围起点之前的“缺失”只是因为不在本次查询范围内，并非真的缺失
  const missingIssues = findDrawSequenceProblems(recentStoredDraws)
    .filter((problem) => problem.problemType === 'missing_issue' && problem.issue !== null)
    .map((problem) => problem.issue as string)
    .filter((issue) => issue > oldestRecentIssue);

  // 需要获取的最小期号：库内最新一期（用于发现新开奖）、待补全期号、缺失期号三者中最早的
  const lowestIssueToFetch = [previousLatestIssue, ...incompletePrizeIssues, ...missingIssues].sort()[0];

  const fetchLogId = startFetchLog(database, 'incremental', {
    previousLatestIssue,
    lowestIssueToFetch,
    incompletePrizeIssues,
    missingIssues,
  });

  try {
    // 按期号倒序翻页，直到覆盖 lowestIssueToFetch
    const rawItems: CwlDrawNoticeItemRaw[] = [];
    let hasReachedLowestIssue = false;
    let requestedPageCount = 0;

    for (let pageNo = 1; pageNo <= INCREMENTAL_MAX_PAGES; pageNo++) {
      const pageResponse = await fetchPage({
        issueCount: INCREMENTAL_WINDOW_DRAW_COUNT,
        pageNo,
        pageSize: INCREMENTAL_PAGE_SIZE,
      });
      requestedPageCount++;
      rawItems.push(...pageResponse.result);

      hasReachedLowestIssue = rawItems.some((rawItem) => {
        const rawIssue = readRawIssue(rawItem);
        return rawIssue !== '' && rawIssue <= lowestIssueToFetch;
      });
      const isLastPage = pageNo >= pageResponse.pageNum || pageResponse.result.length === 0;
      if (hasReachedLowestIssue || isLastPage) {
        break;
      }
    }

    if (!hasReachedLowestIssue) {
      throw new Error(
        `官方最近 ${INCREMENTAL_WINDOW_DRAW_COUNT} 期中没有覆盖到期号 ${lowestIssueToFetch}，库内数据缺口过大，` +
          `请运行 npm run import:full -- --from-year=${lowestIssueToFetch.slice(0, 4)} 补齐，本次未写入任何数据`,
      );
    }

    // 只保存需要的期号范围（更早的记录本次不处理）；接口按期号倒序返回，入库前改为升序，日志更易读
    const { validDraws, rejectedDraws } = parseRawDrawItems(rawItems, null);
    const drawsToSave = validDraws
      .filter((draw) => draw.issue >= lowestIssueToFetch)
      .sort((left, right) => left.issue.localeCompare(right.issue));
    const saveSummary = saveDraws(database, drawsToSave);

    const returnedIssues = new Set(validDraws.map((draw) => draw.issue));
    const stillMissingIssues = missingIssues.filter((issue) => !returnedIssues.has(issue));

    const attentionNotes = [
      rejectedDraws.length > 0 ? `拒绝 ${rejectedDraws.length} 条` : '',
      saveSummary.conflictMessages.length > 0 ? `冲突 ${saveSummary.conflictMessages.length} 条` : '',
      stillMissingIssues.length > 0 ? `接口未返回缺失期号 ${stillMissingIssues.join('、')}` : '',
    ].filter(Boolean);

    finishFetchLog(database, fetchLogId, {
      runStatus: 'succeeded',
      fetchedRecordCount: rawItems.length,
      insertedRecordCount: saveSummary.insertedIssues.length,
      updatedRecordCount: saveSummary.updatedIssues.length,
      errorMessage: attentionNotes.length > 0 ? `需人工核查：${attentionNotes.join('；')}` : null,
    });

    return {
      previousLatestIssue,
      lowestIssueToFetch,
      requestedPageCount,
      fetchedCount: rawItems.length,
      insertedIssues: saveSummary.insertedIssues,
      updatedIssues: saveSummary.updatedIssues,
      stillMissingIssues,
      rejectedDraws,
      conflictMessages: saveSummary.conflictMessages,
    };
  } catch (error) {
    finishFetchLog(database, fetchLogId, {
      runStatus: 'failed',
      fetchedRecordCount: 0,
      insertedRecordCount: 0,
      updatedRecordCount: 0,
      errorMessage: (error as Error).message,
    });
    throw error;
  }
}
