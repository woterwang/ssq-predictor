/** API和定时任务共用同一连接/同步锁。单实例运行，HTTPS交由部署反向代理。 */
import { appConfig } from './config';
import { closeDatabase, getDatabase } from './db/connection';
import { createApiApp } from './api/createApp';
import { ApiError } from './api/apiValidation';
import { createDefaultDrawSyncJobContext, startDrawSyncScheduler } from './jobs/drawSyncJob';
import { isDatabaseSyncRunning, runIncrementalSyncWorkflow, SyncAlreadyRunningError } from './jobs/syncWorkflow';
import { logger } from './utils/logger';

const database = getDatabase();
const context = createDefaultDrawSyncJobContext();
const app = createApiApp({ database, adminApiKey: appConfig.adminApiKey, now: context.now,
  loadSuspensionPeriods: context.loadSuspensionPeriods,
  synchronize: async () => {
    try { return await runIncrementalSyncWorkflow(context); }
    catch (error) {
      if (error instanceof SyncAlreadyRunningError) throw new ApiError(409, 'SYNC_IN_PROGRESS', '开奖同步正在进行，请稍后再试');
      throw error;
    }
  },
});
let shuttingDown = false;
let scheduler: ReturnType<typeof startDrawSyncScheduler> | null = null;
const server = app.listen(appConfig.apiPort, appConfig.apiHost, () => {
  logger.info(`API已监听http://${appConfig.apiHost}:${appConfig.apiPort}，正式小程序必须经已备案HTTPS域名访问`);
  scheduler = startDrawSyncScheduler(context);
});
server.on('error', error => { logger.error(`API监听失败：${error.message}`); closeDatabase(); process.exitCode = 1; });

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`收到${signal}，停止接收新请求及调度，等待同步结束`);
  scheduler?.stop();
  let requestsClosed = false;
  server.close(() => { requestsClosed = true; });
  // Node 18.18支持关闭keep-alive空闲连接，正在处理的请求仍正常完成。
  server.closeIdleConnections();
  const timer = setInterval(() => {
    if (!requestsClosed || isDatabaseSyncRunning(database)) return;
    clearInterval(timer); closeDatabase();
  }, 100);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));