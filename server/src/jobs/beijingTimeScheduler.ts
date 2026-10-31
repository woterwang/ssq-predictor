/**
 * 按北京时间运行的简易定时调度器
 *
 * 为什么不用 node-cron：
 * node-cron 3.x 依赖的 uuid 8 有已知安全漏洞，修复版 node-cron 4 需要 Node 20 以上；
 * 本项目的定时需求很简单（固定星期几的固定时刻），自行实现更可控，也不引入额外依赖。
 *
 * 工作方式：
 * - 每个任务按规则算出“下一次运行时间”，用 setTimeout 等待；
 * - 到点后先安排下一次，再执行本次，这样本次执行耗时再长也不会影响后续时间点；
 * - 运行时间按北京时间计算，与服务器所在时区无关。
 */
import { logger } from '../utils/logger';
import { addDaysToDate, convertBeijingDateTimeToDate, getBeijingDateString, getWeekdayOfDate } from '../utils/time';

/** 调度规则（北京时间） */
export interface BeijingScheduleRule {
  /** 任务名称，用于日志 */
  label: string;
  /** 在星期几运行（0 = 周日 … 6 = 周六）；null 表示每天运行 */
  weekdays: readonly number[] | null;
  /** 小时，0–23 */
  hour: number;
  /** 分钟，0–59 */
  minute: number;
}

/** 定时任务 */
export interface ScheduledTask {
  rule: BeijingScheduleRule;
  /** 任务内容；抛出的错误会被记录，不影响后续调度 */
  run: () => Promise<void>;
}

/** 运行中的调度器 */
export interface RunningScheduler {
  /** 停止全部任务 */
  stop: () => void;
  /** 查看各任务的下一次运行时间 */
  listNextRunTimes: () => Array<{ label: string; nextRunAt: Date }>;
}

/**
 * 校验规则取值范围，配置错误时直接抛错。
 */
function assertValidScheduleRule(rule: BeijingScheduleRule): void {
  const isValidHour = Number.isInteger(rule.hour) && rule.hour >= 0 && rule.hour <= 23;
  const isValidMinute = Number.isInteger(rule.minute) && rule.minute >= 0 && rule.minute <= 59;
  const isValidWeekdays =
    rule.weekdays === null ||
    (rule.weekdays.length > 0 &&
      rule.weekdays.every((weekday) => Number.isInteger(weekday) && weekday >= 0 && weekday <= 6));
  if (!isValidHour || !isValidMinute || !isValidWeekdays) {
    throw new Error(`定时规则“${rule.label}”取值有误：${JSON.stringify(rule)}`);
  }
}

/**
 * 计算规则在指定时间之后（不含该时间）的下一次运行时间。
 */
export function findNextRunTime(rule: BeijingScheduleRule, after: Date): Date {
  const startDateText = getBeijingDateString(after);

  // 最多向后看 7 天即可覆盖一周内任意星期几
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const candidateDateText = addDaysToDate(startDateText, dayOffset);
    if (rule.weekdays !== null && !rule.weekdays.includes(getWeekdayOfDate(candidateDateText))) {
      continue;
    }
    const candidateRunTime = convertBeijingDateTimeToDate(candidateDateText, rule.hour, rule.minute);
    if (candidateRunTime.getTime() > after.getTime()) {
      return candidateRunTime;
    }
  }
  throw new Error(`定时规则“${rule.label}”在 7 天内找不到运行时间`);
}

/**
 * 启动调度器。
 */
export function startBeijingTimeScheduler(tasks: readonly ScheduledTask[]): RunningScheduler {
  tasks.forEach((task) => assertValidScheduleRule(task.rule));

  const pendingTimers = new Map<string, NodeJS.Timeout>();
  const nextRunTimes = new Map<string, Date>();
  let isStopped = false;

  /**
   * 安排任务在 after 之后的下一次运行。
   * 以“计划运行时间”而非“实际触发时间”为基准推算下一次，避免定时器偶尔提前几毫秒触发导致同一时刻重复运行。
   */
  const scheduleNextRun = (task: ScheduledTask, after: Date): void => {
    const nextRunAt = findNextRunTime(task.rule, after);
    nextRunTimes.set(task.rule.label, nextRunAt);

    // 最长等待约 7 天，小于 setTimeout 的上限（约 24.8 天）
    const waitMs = Math.max(0, nextRunAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      if (isStopped) {
        return;
      }
      scheduleNextRun(task, nextRunAt);
      task.run().catch((error: unknown) => {
        logger.error(`定时任务“${task.rule.label}”执行出错：${(error as Error).message}`);
      });
    }, waitMs);
    pendingTimers.set(task.rule.label, timer);
  };

  const now = new Date();
  tasks.forEach((task) => scheduleNextRun(task, now));

  return {
    stop: () => {
      isStopped = true;
      pendingTimers.forEach((timer) => clearTimeout(timer));
      pendingTimers.clear();
    },
    listNextRunTimes: () =>
      [...nextRunTimes.entries()]
        .map(([label, nextRunAt]) => ({ label, nextRunAt }))
        .sort((left, right) => left.nextRunAt.getTime() - right.nextRunAt.getTime()),
  };
}
