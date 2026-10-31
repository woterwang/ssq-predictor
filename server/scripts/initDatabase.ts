/**
 * 数据库初始化脚本
 *
 * 用法：npm run db:init
 *
 * 作用：
 * 1. 创建数据库文件（不存在时）；
 * 2. 执行所有尚未执行的结构迁移；
 * 3. 打印当前表结构，便于人工核对。
 *
 * 可重复执行：数据库已是最新结构时不会做任何修改，也不会影响已有数据。
 */
import { appConfig } from '../src/config';
import { openDatabase } from '../src/db/connection';
import { applyPendingMigrations } from '../src/db/migrations';

/** sqlite_master 中表或触发器的基本信息 */
interface SchemaObjectRow {
  type: 'table' | 'trigger' | 'index';
  name: string;
  tbl_name: string;
}

/** PRAGMA table_info 返回的列信息 */
interface ColumnInfoRow {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: number;
}

function main(): void {
  console.log(`数据库文件：${appConfig.databaseFilePath}`);

  const database = openDatabase(appConfig.databaseFilePath);
  try {
    const migrationResult = applyPendingMigrations(database);

    if (migrationResult.appliedMigrations.length === 0) {
      console.log(`结构已是最新版本（v${migrationResult.currentVersion}），无需迁移。`);
    } else {
      console.log(`结构版本：v${migrationResult.previousVersion} → v${migrationResult.currentVersion}`);
      for (const migration of migrationResult.appliedMigrations) {
        console.log(`  已执行迁移 v${migration.version}：${migration.description}`);
      }
    }

    // 列出业务表、触发器和索引（排除 SQLite 内部对象）
    const schemaObjects = database
      .prepare(
        `SELECT type, name, tbl_name FROM sqlite_master
         WHERE type IN ('table', 'trigger', 'index') AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all() as SchemaObjectRow[];

    const tableNames = schemaObjects.filter((item) => item.type === 'table').map((item) => item.name);

    console.log('\n数据表：');
    for (const tableName of tableNames) {
      // 表名来自 sqlite_master 查询结果，并非外部输入；仍用双引号包裹以防特殊字符
      const columns = database.prepare(`PRAGMA table_info("${tableName}")`).all() as ColumnInfoRow[];
      const columnDescriptions = columns.map((column) => {
        const flags = [column.pk > 0 ? '主键' : '', column.notnull === 1 ? '非空' : ''].filter(Boolean);
        return flags.length > 0 ? `${column.name}(${flags.join(',')})` : column.name;
      });
      console.log(`  ${tableName}：${columns.length} 列`);
      console.log(`    ${columnDescriptions.join(', ')}`);
    }

    const otherObjects = schemaObjects.filter((item) => item.type !== 'table');
    console.log('\n触发器与索引：');
    for (const item of otherObjects) {
      console.log(`  [${item.type}] ${item.name}（所属表 ${item.tbl_name}）`);
    }
  } finally {
    database.close();
  }
}

main();
