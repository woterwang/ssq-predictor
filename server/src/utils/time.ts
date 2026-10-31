/**
 * 时间工具
 *
 * 开奖、定时任务均以北京时间为准；服务器可能运行在其他时区，
 * 因此不依赖系统时区，统一按 UTC+8 计算。
 */

/** 北京时间相对 UTC 的偏移（毫秒）；中国不实行夏令时，固定 +8 小时 */
const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把时间格式化为带时区的北京时间字符串，如 2026-10-31T13:28:00.123+08:00。
 */
export function formatBeijingTimestamp(date: Date = new Date()): string {
  const shiftedDate = new Date(date.getTime() + BEIJING_UTC_OFFSET_MS);
  return shiftedDate.toISOString().replace('Z', '+08:00');
}

/**
 * 获取北京时间下的年份。
 */
export function getBeijingYear(date: Date = new Date()): number {
  return new Date(date.getTime() + BEIJING_UTC_OFFSET_MS).getUTCFullYear();
}

/**
 * 获取北京时间下的日期，格式 YYYY-MM-DD。
 */
export function getBeijingDateString(date: Date = new Date()): string {
  return formatBeijingTimestamp(date).slice(0, 10);
}

/**
 * 格式化为日志用的北京时间，如 2026-10-31 13:28:00。
 */
export function formatBeijingDateTimeForLog(date: Date = new Date()): string {
  return formatBeijingTimestamp(date).slice(0, 19).replace('T', ' ');
}

/**
 * 把“北京时间某日某时某分”转换为 Date 对象。
 * @param dateText 日期，YYYY-MM-DD
 */
export function convertBeijingDateTimeToDate(dateText: string, hour: number, minute: number): Date {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - BEIJING_UTC_OFFSET_MS);
}

// ---------------------------------------------------------------------------
// 以下函数只处理 YYYY-MM-DD 格式的日期字符串（不含时刻），按纯日历计算，与时区无关
// ---------------------------------------------------------------------------

/**
 * 判断是否为真实存在的 YYYY-MM-DD 日期（排除 2026-02-30 这类值）。
 */
export function isValidDateText(dateText: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    return false;
  }
  const [year, month, day] = dateText.split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day
  );
}

/**
 * 日期加减天数，如 addDaysToDate('2026-12-31', 1) → '2027-01-01'。
 */
export function addDaysToDate(dateText: string, dayCount: number): string {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + dayCount)).toISOString().slice(0, 10);
}

/**
 * 获取日期是星期几：0 = 周日，1 = 周一，…，6 = 周六。
 */
export function getWeekdayOfDate(dateText: string): number {
  const [year, month, day] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * 等待指定毫秒数。
 */
export function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
