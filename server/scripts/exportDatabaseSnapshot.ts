/**
 * 导出一个一致快照，供上线前数据库分发/迁移使用。
 *
 * 适用场景：
 * - 生产环境上线前，把现有 SQLite 数据库转成稳定快照；
 * - 不要把数据库文件直接提交到 Git，也不要用 .gitignore 兜底；
 * - 只导出一个独立的 .db 文件，便于在目标服务器恢复。
 *
 * 用法：
 *   npm run db:export-snapshot
 *
 * 输出：
 *   server/data/releases/ssq-release-YYYY-MM-DDTHH-mm-ssZ.db
 *
 * 说明：
 * - SQLite 在 WAL 模式下，直接复制 ssq.db 可能拿到不一致快照；
 * - backup() 会生成一个一致的数据库快照，适合上线前分发；
 * - 生产环境数据库文件一律独立搬运，不进入 Git。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SERVER_ROOT_DIR = path.resolve(__dirname, '..');
const DATABASE_FILE_PATH = path.join(SERVER_ROOT_DIR, 'data', 'ssq.db');
const RELEASES_DIR = path.join(SERVER_ROOT_DIR, 'data', 'releases');

function buildSnapshotFilePath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(RELEASES_DIR, `ssq-release-${timestamp}.db`);
}

function printSummary(database: Database.Database): void {
  const counts = database
    .prepare(`SELECT COUNT(*) AS drawCount, MIN(issue) AS earliestIssue, MAX(issue) AS latestIssue FROM draws`)
    .get() as { drawCount: number; earliestIssue: string | null; latestIssue: string | null };
  const integrity = database.pragma('integrity_check', { simple: true }) as string;
  const version = database.pragma('user_version', { simple: true }) as number;

  console.log(`
数据库快照导出摘要：
  路径: ${DATABASE_FILE_PATH}
  integrity_check: ${integrity}
  user_version: ${version}
  drawCount: ${counts.drawCount}
  earliestIssue: ${counts.earliestIssue ?? 'N/A'}
  latestIssue: ${counts.latestIssue ?? 'N/A'}
`);
}

function main(): void {
  if (!fs.existsSync(DATABASE_FILE_PATH)) {
    throw new Error(`数据库不存在：${DATABASE_FILE_PATH}`);
  }

  fs.mkdirSync(RELEASES_DIR, { recursive: true });

  const sourceDatabase = new Database(DATABASE_FILE_PATH);
  const snapshotPath = buildSnapshotFilePath();

  void (async () => {
    try {
      console.log(`开始导出一致快照：${snapshotPath}`);
      printSummary(sourceDatabase);

      await sourceDatabase.backup(snapshotPath);

      const exportedStats = fs.statSync(snapshotPath);
      console.log(`快照已导出：${snapshotPath}`);
      console.log(`文件大小：${exportedStats.size} bytes`);
    } finally {
      sourceDatabase.close();
    }
  })().catch((error: unknown) => {
    console.error(`导出失败：${(error as Error).message}`);
    process.exitCode = 1;
    sourceDatabase.close();
  });
}

main();
