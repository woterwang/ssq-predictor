/**
 * 启动开奖数据定时同步（常驻进程）
 *
 * 用法：npm run scheduler
 * 按 Ctrl+C 停止。
 *
 * 第 9 批实现接口服务后，定时同步会随接口服务一起启动，本脚本主要用于单独运行或调试。
 * 注意：同一数据库只能运行一个同步进程。
 */
import { closeDatabase } from '../src/db/connection';
import { createDefaultDrawSyncJobContext, startDrawSyncScheduler } from '../src/jobs/drawSyncJob';
import { logger } from '../src/utils/logger';

const scheduler = startDrawSyncScheduler(createDefaultDrawSyncJobContext());

/**
 * 收到退出信号时停止调度并关闭数据库。
 */
function shutdown(signalName: string): void {
  logger.info(`收到 ${signalName}，停止定时同步`);
  scheduler.stop();
  closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
