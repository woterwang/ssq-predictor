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
import { getDatabase } from '../src/db/connection';
import { isDatabaseSyncRunning } from '../src/jobs/syncWorkflow';

const scheduler = startDrawSyncScheduler(createDefaultDrawSyncJobContext());

/**
 * 收到退出信号时停止调度并关闭数据库。
 */
let shuttingDown = false;
function shutdown(signalName: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`收到 ${signalName}，停止定时同步`);
  scheduler.stop();
  const database = getDatabase();
  const timer = setInterval(() => {
    if (isDatabaseSyncRunning(database)) return;
    clearInterval(timer); closeDatabase();
  }, 100);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
