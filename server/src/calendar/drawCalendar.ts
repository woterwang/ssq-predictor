/**
 * 开奖日历
 *
 * 规则：
 * - 每周二、四、日 21:15（北京时间）开奖；
 * - 停售期（如春节休市）内不开奖，停售期由配置文件提供（见 salesSuspensionConfig.ts）；
 * - 期号格式为“4 位年份 + 3 位年内序号”，每年从 001 开始；
 * - 期号不受停售影响：停售结束后接着上一期的序号继续编号，停售只影响开奖日期。
 *
 * 本模块只做纯日期计算（输入日期字符串与停售期列表，输出结果），不读文件、不访问数据库，便于验证。
 */
import { DRAW_TIME_BEIJING, DRAW_WEEKDAYS } from '../domain/lottery';
import { addDaysToDate, getWeekdayOfDate } from '../utils/time';

/** 一段停售期（起止日期都包含在内） */
export interface SalesSuspensionPeriod {
  /** 开始日期，YYYY-MM-DD */
  startDate: string;
  /** 结束日期，YYYY-MM-DD */
  endDate: string;
  /** 停售原因，如“2027 年春节休市” */
  reason: string;
}

/** 下一期开奖信息 */
export interface NextDrawInfo {
  /** 下一期期号 */
  issue: string;
  /** 下一期开奖日期，YYYY-MM-DD */
  drawDate: string;
  /** 开奖时间（北京时间），如 21:15 */
  drawTimeBeijing: string;
}

/**
 * 向前或向后查找开奖日时最多查找的天数。
 * 历史上最长的停售（2020 年疫情期间）约两个多月，取 400 天足够覆盖；
 * 超过说明停售期配置有误（如结束日期写错年份）。
 */
const MAX_DRAW_DATE_SEARCH_DAYS = 400;

/**
 * 查找包含指定日期的停售期；不在任何停售期内时返回 null。
 * 日期格式为 YYYY-MM-DD，可直接按字符串比较大小。
 */
export function findSuspensionPeriodContaining(
  dateText: string,
  suspensionPeriods: readonly SalesSuspensionPeriod[],
): SalesSuspensionPeriod | null {
  return (
    suspensionPeriods.find((period) => period.startDate <= dateText && dateText <= period.endDate) ?? null
  );
}

/**
 * 判断某天是否开奖：是周二、四、日，且不在停售期内。
 */
export function isScheduledDrawDate(dateText: string, suspensionPeriods: readonly SalesSuspensionPeriod[]): boolean {
  return (
    DRAW_WEEKDAYS.includes(getWeekdayOfDate(dateText)) &&
    findSuspensionPeriodContaining(dateText, suspensionPeriods) === null
  );
}

/**
 * 从指定日期出发，逐日向前或向后查找第一个开奖日。
 * @param startDateText 起始日期（本身也参与判断）
 * @param stepDays 1 = 向后查找，-1 = 向前查找
 */
function searchScheduledDrawDate(
  startDateText: string,
  stepDays: 1 | -1,
  suspensionPeriods: readonly SalesSuspensionPeriod[],
): string {
  let candidateDate = startDateText;
  for (let searchedDays = 0; searchedDays <= MAX_DRAW_DATE_SEARCH_DAYS; searchedDays++) {
    if (isScheduledDrawDate(candidateDate, suspensionPeriods)) {
      return candidateDate;
    }
    candidateDate = addDaysToDate(candidateDate, stepDays);
  }
  throw new Error(
    `从 ${startDateText} 起 ${MAX_DRAW_DATE_SEARCH_DAYS} 天内找不到开奖日，请检查停售期配置是否有误`,
  );
}

/**
 * 查找指定日期之后（不含当天）的第一个开奖日。
 */
export function findNextScheduledDrawDate(
  afterDateText: string,
  suspensionPeriods: readonly SalesSuspensionPeriod[],
): string {
  return searchScheduledDrawDate(addDaysToDate(afterDateText, 1), 1, suspensionPeriods);
}

/**
 * 查找指定日期当天或之前的最近一个开奖日。
 */
export function findLatestScheduledDrawDateOnOrBefore(
  dateText: string,
  suspensionPeriods: readonly SalesSuspensionPeriod[],
): string {
  return searchScheduledDrawDate(dateText, -1, suspensionPeriods);
}

/**
 * 根据最近一期开奖推算下一期的期号与开奖日期。
 *
 * 注意：结果以“库内最新一期”为起点。库内数据未及时更新时，推算出的可能是已经开过奖的期，
 * 因此生成推荐前应先执行增量更新。
 */
export function computeNextDraw(
  latestDraw: { issue: string; drawDate: string },
  suspensionPeriods: readonly SalesSuspensionPeriod[],
): NextDrawInfo {
  const nextDrawDate = findNextScheduledDrawDate(latestDraw.drawDate, suspensionPeriods);
  const latestIssueYear = latestDraw.issue.slice(0, 4);
  const nextDrawYear = nextDrawDate.slice(0, 4);

  // 同一年内序号加 1；跨年则从新一年的 001 开始
  const nextIssue =
    nextDrawYear === latestIssueYear
      ? `${latestIssueYear}${String(Number(latestDraw.issue.slice(4)) + 1).padStart(3, '0')}`
      : `${nextDrawYear}001`;

  const drawTimeBeijing = `${String(DRAW_TIME_BEIJING.hour).padStart(2, '0')}:${String(DRAW_TIME_BEIJING.minute).padStart(2, '0')}`;
  return { issue: nextIssue, drawDate: nextDrawDate, drawTimeBeijing };
}
