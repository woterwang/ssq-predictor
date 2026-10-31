/**
 * 停售期配置读取
 *
 * 配置文件默认位于 server/config/sales-suspension-periods.json，路径可通过环境变量 SALES_SUSPENSION_CONFIG_PATH 修改。
 * 每次调用都重新读取文件，因此修改配置后无需重启服务。
 * 配置内容有误时直接抛错（而不是静默忽略），避免按错误的日历运行。
 */
import fs from 'node:fs';
import { appConfig } from '../config';
import { logger } from '../utils/logger';
import { isValidDateText } from '../utils/time';
import type { SalesSuspensionPeriod } from './drawCalendar';

/**
 * 读取并校验停售期配置。
 * 文件不存在时视为没有停售期，并输出警告。
 */
export function loadSalesSuspensionPeriods(
  configFilePath: string = appConfig.salesSuspensionConfigPath,
): SalesSuspensionPeriod[] {
  if (!fs.existsSync(configFilePath)) {
    logger.warn(`停售期配置文件不存在：${configFilePath}，按“无停售期”处理`);
    return [];
  }

  let configContent: unknown;
  try {
    configContent = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
  } catch (error) {
    throw new Error(`停售期配置文件不是合法 JSON：${configFilePath}（${(error as Error).message}）`);
  }

  const rawPeriods = (configContent as { periods?: unknown } | null)?.periods;
  if (!Array.isArray(rawPeriods)) {
    throw new Error(`停售期配置文件缺少 periods 数组：${configFilePath}`);
  }

  return rawPeriods.map((rawPeriod: unknown, index: number) => {
    const { startDate, endDate, reason } = (rawPeriod ?? {}) as Record<string, unknown>;
    const positionLabel = `停售期配置第 ${index + 1} 项`;

    if (typeof startDate !== 'string' || !isValidDateText(startDate)) {
      throw new Error(`${positionLabel}的 startDate 不是合法日期（YYYY-MM-DD）：${String(startDate)}`);
    }
    if (typeof endDate !== 'string' || !isValidDateText(endDate)) {
      throw new Error(`${positionLabel}的 endDate 不是合法日期（YYYY-MM-DD）：${String(endDate)}`);
    }
    if (startDate > endDate) {
      throw new Error(`${positionLabel}的开始日期 ${startDate} 晚于结束日期 ${endDate}`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`${positionLabel}缺少停售原因 reason`);
    }

    return { startDate, endDate, reason: reason.trim() };
  });
}
