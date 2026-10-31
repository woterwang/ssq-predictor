/**
 * 日志工具
 *
 * 统一输出格式：[北京时间] [级别] 内容，便于部署后用 grep 按级别筛选。
 *
 * 级别说明：
 * - 信息：正常运行过程；
 * - 警告：暂时异常但会自动恢复（如今晚数据未取到，次日会补拉）；
 * - 错误：本次操作失败；
 * - 告警：需要人工处理的问题（如连续多次失败、应有的开奖数据迟迟取不到）。
 *   目前与“错误”一样输出到标准错误；第 13 批部署时再接入通知渠道（如邮件、企业微信）。
 */
import { formatBeijingDateTimeForLog } from './time';

type LogLevelLabel = '信息' | '警告' | '错误' | '告警';

function writeLog(levelLabel: LogLevelLabel, message: string): void {
  const logLine = `[${formatBeijingDateTimeForLog()}] [${levelLabel}] ${message}`;
  if (levelLabel === '信息') {
    console.log(logLine);
  } else if (levelLabel === '警告') {
    console.warn(logLine);
  } else {
    console.error(logLine);
  }
}

export const logger = {
  info: (message: string): void => writeLog('信息', message),
  warn: (message: string): void => writeLog('警告', message),
  error: (message: string): void => writeLog('错误', message),
  alert: (message: string): void => writeLog('告警', message),
};
