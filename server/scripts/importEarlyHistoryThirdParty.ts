/**
 * 用第三方接口补齐 2003–2012 年早期开奖数据（官方查询接口只覆盖 2013001 起）
 *
 * 用法：
 *   npm run import:early                 只校验（dry-run），不写库
 *   npm run import:early -- --apply      校验全部通过后备份数据库并写入
 *
 * 数据来源：http://api.huiniao.top/interface/home/lotteryHistory?type=ssq（第三方、非官方、仅 HTTP）。
 * 安全与质量策略：
 * - 只校验并导入期号早于库内最早期号（2013001）的记录；2013 年起的数据一律沿用库内官方数据，不校验、不比对、不覆盖；
 * - 每条记录复用官方数据的解析校验（号码范围、重复、日期真实性、期号与日期年份一致），号码补零并升序；
 * - 另检查期号/日期唯一、与库内数据衔接后的期号连续与日期递增；
 * - 任一校验不通过时拒绝写入（--apply 也不会执行）；
 * - 写入前用 SQLite 备份接口备份数据库；数据来源标记为 huiniao_third_party，奖级明细标记为未完整；
 * - 原始响应存档到 RAW_RESPONSE_ARCHIVE_DIR，便于回放核查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSalesSuspensionPeriods } from '../src/calendar/salesSuspensionConfig';
import { findDrawSequenceProblems } from '../src/collector/drawSequenceValidator';
import { saveDraws } from '../src/collector/drawImportService';
import { parseDrawNoticeItem } from '../src/collector/drawParser';
import { appConfig } from '../src/config';
import { closeDatabase, getDatabase } from '../src/db/connection';
import { finishFetchLog, startFetchLog } from '../src/db/fetchLogRepository';
import { countDraws, listAllDrawIssueAndDates } from '../src/db/drawRepository';
import type { DrawRecord } from '../src/domain/lottery';
import { formatBeijingTimestamp, getBeijingDateString, sleep } from '../src/utils/time';

const THIRD_PARTY_API_URL = 'http://api.huiniao.top/interface/home/lotteryHistory';
const THIRD_PARTY_DATA_SOURCE = 'huiniao_third_party';
const PAGE_SIZE = 100;
const REQUEST_INTERVAL_MS = 1500;
const REQUEST_TIMEOUT_MS = 15000;
/** 单页响应大小上限，防止异常响应占用内存 */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PRINTED_LINES = 20;

/** 第三方接口单条记录（字段类型不可信，使用前逐项校验） */
type ThirdPartyItem = Record<string, unknown>;

interface ThirdPartyPage {
  list: ThirdPartyItem[];
  totalPage: number;
  totalCount: number;
}

/**
 * 请求一页数据并校验响应结构。
 */
async function fetchPage(pageNo: number, archiveDir: string): Promise<ThirdPartyPage> {
  const url = `${THIRD_PARTY_API_URL}?type=ssq&page=${pageNo}&limit=${PAGE_SIZE}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`第 ${pageNo} 页请求失败：HTTP ${response.status}`);
  }
  const responseText = await response.text();
  if (Buffer.byteLength(responseText) > MAX_RESPONSE_BYTES) {
    throw new Error(`第 ${pageNo} 页响应过大，已拒绝`);
  }
  fs.writeFileSync(path.join(archiveDir, `page-${String(pageNo).padStart(3, '0')}.json`), responseText);

  const body = JSON.parse(responseText) as { code?: unknown; data?: { data?: Record<string, unknown> } };
  const pageData = body.data?.data;
  if (body.code !== 1 || pageData === undefined || !Array.isArray(pageData.list)) {
    throw new Error(`第 ${pageNo} 页响应结构不符合预期`);
  }
  const totalPage = Number(pageData.totalPage);
  const totalCount = Number(pageData.totalCount);
  if (!Number.isInteger(totalPage) || !Number.isInteger(totalCount) || totalPage < 1) {
    throw new Error(`第 ${pageNo} 页缺少合法的 totalPage/totalCount`);
  }
  return { list: pageData.list as ThirdPartyItem[], totalPage, totalCount };
}

/**
 * 抓取全部分页；总页数以第一页返回为准，并校验取得条数等于 totalCount。
 */
async function fetchAllItems(archiveDir: string): Promise<ThirdPartyItem[]> {
  const firstPage = await fetchPage(1, archiveDir);
  const allItems = [...firstPage.list];
  for (let pageNo = 2; pageNo <= firstPage.totalPage; pageNo++) {
    await sleep(REQUEST_INTERVAL_MS);
    const page = await fetchPage(pageNo, archiveDir);
    allItems.push(...page.list);
    process.stdout.write(`\r已抓取 ${pageNo}/${firstPage.totalPage} 页`);
  }
  process.stdout.write('\n');
  if (allItems.length !== firstPage.totalCount) {
    throw new Error(`取得 ${allItems.length} 条，与接口报告总数 ${firstPage.totalCount} 不一致`);
  }
  return allItems;
}

/**
 * 第三方记录 → 与官方一致的解析校验流程（补零、升序、范围、日期真实性等）。
 */
function parseThirdPartyItem(item: ThirdPartyItem) {
  const redBallTexts = [item.one, item.two, item.three, item.four, item.five, item.six].map((value) => String(value ?? ''));
  const parseResult = parseDrawNoticeItem(
    { code: item.code, date: item.day, red: redBallTexts.join(','), blue: String(item.seven ?? '') },
    THIRD_PARTY_DATA_SOURCE,
  );
  if (!parseResult.isValid) {
    return parseResult;
  }
  // 原始记录用第三方原文保存（解析时构造的中间对象不保留），日期、号码以校验后的值为准
  const draw: DrawRecord = { ...parseResult.draw, rawRecordJson: JSON.stringify(item) };
  return { isValid: true as const, draw };
}

function printLimited(title: string, lines: readonly string[]): void {
  if (lines.length === 0) {
    return;
  }
  console.log(`\n${title}（共 ${lines.length} 条）：`);
  lines.slice(0, MAX_PRINTED_LINES).forEach((line) => console.log(`  - ${line}`));
  if (lines.length > MAX_PRINTED_LINES) {
    console.log(`  …… 其余 ${lines.length - MAX_PRINTED_LINES} 条省略`);
  }
}

async function main(): Promise<void> {
  const shouldApply = process.argv.slice(2).includes('--apply');
  const database = getDatabase();
  const archiveDir = path.join(appConfig.rawResponseArchiveDir, `huiniao-${getBeijingDateString()}`);
  fs.mkdirSync(archiveDir, { recursive: true });

  console.log(`模式：${shouldApply ? '校验通过后写入' : '仅校验（dry-run）'}\n`);
  const allItems = await fetchAllItems(archiveDir);

  // 库内最早一期之后的数据一律以现有官方数据为准：不校验、不比对、不覆盖
  const existingRows = listAllDrawIssueAndDates(database);
  if (existingRows.length === 0) {
    throw new Error('库内没有任何官方数据，请先执行 import:full');
  }
  const earliestExistingIssue = existingRows[0].issue;
  const earliestExistingDate = existingRows[0].drawDate;
  const items = allItems.filter((item) => String(item.code) < earliestExistingIssue);
  console.log(`第三方共 ${allItems.length} 条，其中早于 ${earliestExistingIssue} 的 ${items.length} 条参与校验，其余 ${allItems.length - items.length} 条忽略`);

  // 1. 逐条解析校验
  const parsedDraws: DrawRecord[] = [];
  const rejectedLines: string[] = [];
  const normalizedIssues: string[] = [];
  for (const item of items) {
    const parseResult = parseThirdPartyItem(item);
    if (!parseResult.isValid) {
      rejectedLines.push(`期号 ${String(item.code)}：${parseResult.errors.join('；')}`);
      continue;
    }
    parsedDraws.push(parseResult.draw);
    const originalBallTexts = [item.one, item.two, item.three, item.four, item.five, item.six, item.seven];
    if (originalBallTexts.some((value) => !/^\d{2}$/.test(String(value)))) {
      normalizedIssues.push(parseResult.draw.issue);
    }
  }

  // 2. 期号、日期唯一性
  const duplicateLines: string[] = [];
  const seenIssues = new Set<string>();
  const seenDates = new Set<string>();
  for (const draw of parsedDraws) {
    if (seenIssues.has(draw.issue)) duplicateLines.push(`期号重复：${draw.issue}`);
    if (seenDates.has(draw.drawDate)) duplicateLines.push(`开奖日期重复：${draw.drawDate}（期号 ${draw.issue}）`);
    seenIssues.add(draw.issue);
    seenDates.add(draw.drawDate);
  }

  // 3. 待写入记录：期号早于库内最早期号，且日期必须早于库内最早日期
  const existingIssueSet = new Set(existingRows.map((row) => row.issue));
  const candidates = [...parsedDraws].sort((left, right) => left.issue.localeCompare(right.issue));
  const candidateProblemLines = candidates
    .filter((draw) => draw.drawDate >= earliestExistingDate || existingIssueSet.has(draw.issue))
    .map((draw) => `待写入记录 ${draw.issue}（${draw.drawDate}）与库内数据冲突`);

  // 4. 与库内现有数据合并后的序列检查
  const sequenceProblems = findDrawSequenceProblems(
    [...candidates, ...existingRows],
    loadSalesSuspensionPeriods(),
  );
  const blockingSequenceProblems = sequenceProblems.filter((problem) => problem.problemType !== 'possible_missing_year_end');
  const yearEndWarnings = sequenceProblems.filter((problem) => problem.problemType === 'possible_missing_year_end');

  console.log(`通过解析校验 ${parsedDraws.length} 条，拒绝 ${rejectedLines.length} 条`);
  console.log(`补零/规范化的记录：${normalizedIssues.length > 0 ? normalizedIssues.join('、') : '无'}`);
  console.log(
    `待补写 ${candidates.length} 期：${candidates[0]?.issue ?? '-'}（${candidates[0]?.drawDate ?? '-'}）` +
      ` – ${candidates[candidates.length - 1]?.issue ?? '-'}（${candidates[candidates.length - 1]?.drawDate ?? '-'}）`,
  );
  printLimited('被拒绝的记录', rejectedLines);
  printLimited('重复', duplicateLines);
  printLimited('与库内数据冲突', candidateProblemLines);
  printLimited('合并后序列问题（缺期/日期顺序，会阻止写入）', blockingSequenceProblems.map((problem) => problem.message));
  printLimited('年末可能缺期提示（按现行开奖日推算，早年规则不同，仅供参考）', yearEndWarnings.map((problem) => problem.message));

  const blockingIssueCount =
    rejectedLines.length + duplicateLines.length + candidateProblemLines.length + blockingSequenceProblems.length;
  if (blockingIssueCount > 0) {
    console.log('\n校验未通过，不会写入。');
    process.exitCode = 1;
    return;
  }
  console.log('\n校验全部通过。');
  if (!shouldApply) {
    console.log('dry-run 结束，未写入。确认无误后加 --apply 写入。');
    return;
  }
  if (candidates.length === 0) {
    console.log('没有需要补写的记录。');
    return;
  }

  // 6. 备份后写入
  const backupDir = path.join(path.dirname(appConfig.databaseFilePath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `ssq-before-early-import-${formatBeijingTimestamp().replace(/[:.]/g, '-')}.db`);
  await database.backup(backupPath);
  console.log(`已备份数据库：${backupPath}`);

  const countBefore = countDraws(database);
  const fetchLogId = startFetchLog(database, 'full_import', {
    source: THIRD_PARTY_DATA_SOURCE,
    url: THIRD_PARTY_API_URL,
    issueRange: [candidates[0].issue, candidates[candidates.length - 1].issue],
  });
  try {
    const summary = saveDraws(database, candidates);
    const countAfter = countDraws(database);
    const failureMessage =
      summary.conflictMessages.length > 0 || countAfter - countBefore !== candidates.length
        ? `写入异常：${summary.conflictMessages.join('；')}`
        : null;
    finishFetchLog(database, fetchLogId, {
      runStatus: failureMessage === null ? 'succeeded' : 'failed',
      fetchedRecordCount: items.length,
      insertedRecordCount: summary.insertedIssues.length,
      updatedRecordCount: summary.updatedIssues.length,
      errorMessage: failureMessage,
    });
    console.log(`写入完成：新增 ${summary.insertedIssues.length} 期，库内 ${countBefore} → ${countAfter} 期`);
    if (failureMessage !== null) {
      console.log(failureMessage);
      process.exitCode = 1;
    }
  } catch (error) {
    finishFetchLog(database, fetchLogId, {
      runStatus: 'failed',
      fetchedRecordCount: items.length,
      insertedRecordCount: 0,
      updatedRecordCount: 0,
      errorMessage: (error as Error).message,
    });
    throw error;
  }

  const integrity = database.pragma('integrity_check', { simple: true });
  const finalProblems = findDrawSequenceProblems(listAllDrawIssueAndDates(database), loadSalesSuspensionPeriods()).filter(
    (problem) => problem.problemType !== 'possible_missing_year_end',
  );
  console.log(`integrity_check：${String(integrity)}；写入后序列问题：${finalProblems.length}`);
}

main()
  .catch((error: unknown) => {
    console.error(`\n执行失败：${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDatabase();
  });
