/**
 * 数据库连接管理
 *
 * 使用 better-sqlite3（同步 API）：本项目数据量小、单进程运行，
 * 同步调用让代码更直观，也不存在并发写入竞争问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { appConfig } from '../config';
import { applyPendingMigrations } from './migrations';

/** 数据库连接类型别名，供其他模块引用 */
export type SqliteDatabase = Database.Database;

/** 进程内共享的数据库连接，首次使用时创建 */
let sharedDatabase: SqliteDatabase | null = null;

/**
 * 打开指定路径的数据库文件并设置运行参数（不执行迁移）。
 * 目录不存在时自动创建。
 */
export function openDatabase(databaseFilePath: string): SqliteDatabase {
  fs.mkdirSync(path.dirname(databaseFilePath), { recursive: true });

  const database = new Database(databaseFilePath);

  // WAL 模式：读写互不阻塞，写入性能更好
  database.pragma('journal_mode = WAL');
  // SQLite 默认不检查外键，需要显式开启
  database.pragma('foreign_keys = ON');
  // 数据库被锁时最多等待 5 秒再报错，避免定时任务与接口同时访问时直接失败
  database.pragma('busy_timeout = 5000');
  // WAL 模式下使用 NORMAL 同步级别，兼顾安全与性能
  database.pragma('synchronous = NORMAL');

  return database;
}

/**
 * 获取共享数据库连接。
 * 首次调用时打开配置中的数据库文件，并自动升级到最新表结构。
 */
export function getDatabase(): SqliteDatabase {
  if (sharedDatabase === null) {
    const database = openDatabase(appConfig.databaseFilePath);
    applyPendingMigrations(database);
    sharedDatabase = database;
  }
  return sharedDatabase;
}

/**
 * 关闭共享数据库连接（进程退出或脚本结束时调用）。
 */
export function closeDatabase(): void {
  if (sharedDatabase !== null) {
    sharedDatabase.close();
    sharedDatabase = null;
  }
}
