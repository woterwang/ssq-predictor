/**
 * 配置管理模块
 *
 * 职责：
 * 1. 从 server/.env 文件和系统环境变量中读取配置（系统环境变量优先，dotenv 不会覆盖已存在的变量）；
 * 2. 对配置做类型转换和合法性校验，配置错误时启动即报错，避免带病运行；
 * 3. 把相对路径统一解析为以 server 目录为基准的绝对路径。
 *
 * 其他模块统一通过 `appConfig` 读取配置，不要直接访问 process.env。
 */
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * server 目录的绝对路径。
 * 本文件位于 src/config/（构建后位于 dist/config/），向上两级即为 server 目录，
 * 因此无论从哪个工作目录启动，解析结果都一致。
 */
export const SERVER_ROOT_DIR = path.resolve(__dirname, '..', '..');

// 加载 server/.env；文件不存在时静默跳过，全部使用默认值
dotenv.config({ path: path.join(SERVER_ROOT_DIR, '.env') });

/** 运行环境 */
export type RuntimeEnvironment = 'development' | 'production';

/** 应用配置结构 */
export interface AppConfig {
  /** 运行环境 */
  runtimeEnvironment: RuntimeEnvironment;
  /** SQLite 数据库文件的绝对路径 */
  databaseFilePath: string;
  /** 官方接口原始响应存档目录的绝对路径 */
  rawResponseArchiveDir: string;
  /** 停售期配置文件的绝对路径 */
  salesSuspensionConfigPath: string;
  /** 中国福彩网开奖查询接口地址 */
  cwlDrawNoticeApiUrl: string;
  /** 两次请求官方接口之间的最小间隔（毫秒） */
  cwlRequestIntervalMs: number;
  /** 单次请求官方接口的超时时间（毫秒） */
  cwlRequestTimeoutMs: number;
  /** 管理接口密钥；未配置时为 null，届时管理接口应拒绝所有请求 */
  adminApiKey: string | null;
  /** 默认只监听本机；生产由HTTPS反向代理访问，不自动信任代理IP头。 */
  apiHost: string;
  apiPort: number;
}

/** 请求官方接口的最小间隔下限：1 秒，避免对官方站点造成压力 */
const MIN_CWL_REQUEST_INTERVAL_MS = 1000;

/**
 * 读取字符串配置项；未设置或为空白时返回默认值。
 */
function readStringSetting(settingName: string, defaultValue: string): string {
  const rawValue = process.env[settingName];
  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultValue;
  }
  return rawValue.trim();
}

/**
 * 读取正整数配置项；未设置时返回默认值，格式不合法或小于下限时直接抛错。
 */
function readPositiveIntegerSetting(settingName: string, defaultValue: number, minimumValue = 1): number {
  const rawValue = process.env[settingName];
  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultValue;
  }
  const parsedValue = Number(rawValue.trim());
  if (!Number.isInteger(parsedValue) || parsedValue < minimumValue) {
    throw new Error(`配置项 ${settingName} 必须是不小于 ${minimumValue} 的整数，当前值为 "${rawValue}"`);
  }
  return parsedValue;
}

/**
 * 读取运行环境；只接受 development 与 production 两个值。
 */
function readRuntimeEnvironment(): RuntimeEnvironment {
  const rawValue = readStringSetting('NODE_ENV', 'development');
  if (rawValue !== 'development' && rawValue !== 'production') {
    throw new Error(`配置项 NODE_ENV 只能是 development 或 production，当前值为 "${rawValue}"`);
  }
  return rawValue;
}

/**
 * 读取并校验 URL 配置项；只允许 https 协议，防止误配为明文或其他协议地址。
 */
function readHttpsUrlSetting(settingName: string, defaultValue: string): string {
  const rawValue = readStringSetting(settingName, defaultValue);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawValue);
  } catch {
    throw new Error(`配置项 ${settingName} 不是合法的 URL：${rawValue}`);
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`配置项 ${settingName} 必须使用 https 协议：${rawValue}`);
  }
  return rawValue;
}

/**
 * 把配置中的路径解析为绝对路径；相对路径以 server 目录为基准。
 */
function resolvePathFromServerRoot(configuredPath: string): string {
  return path.isAbsolute(configuredPath) ? configuredPath : path.resolve(SERVER_ROOT_DIR, configuredPath);
}

/**
 * 组装并校验全部配置。
 */
function loadAppConfig(): AppConfig {
  const adminApiKeySetting = readStringSetting('ADMIN_API_KEY', '');
  const runtimeEnvironment = readRuntimeEnvironment();
  const apiPort = readPositiveIntegerSetting('API_PORT', 3001);
  if (apiPort > 65535) throw new Error('API_PORT 不能大于65535');
  if (runtimeEnvironment === 'production' && adminApiKeySetting !== '' && adminApiKeySetting.length < 32) {
    throw new Error('生产管理密钥至少32个字符；未配置则禁用管理接口');
  }

  return {
    runtimeEnvironment,
    apiHost: readStringSetting('API_HOST', 'localhost'),
    apiPort,
    databaseFilePath: resolvePathFromServerRoot(readStringSetting('DATABASE_FILE_PATH', 'data/ssq.db')),
    rawResponseArchiveDir: resolvePathFromServerRoot(
      readStringSetting('RAW_RESPONSE_ARCHIVE_DIR', 'data/raw_responses'),
    ),
    salesSuspensionConfigPath: resolvePathFromServerRoot(
      readStringSetting('SALES_SUSPENSION_CONFIG_PATH', 'config/sales-suspension-periods.json'),
    ),
    cwlDrawNoticeApiUrl: readHttpsUrlSetting(
      'CWL_DRAW_NOTICE_API_URL',
      'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice',
    ),
    cwlRequestIntervalMs: readPositiveIntegerSetting(
      'CWL_REQUEST_INTERVAL_MS',
      1500,
      MIN_CWL_REQUEST_INTERVAL_MS,
    ),
    cwlRequestTimeoutMs: readPositiveIntegerSetting('CWL_REQUEST_TIMEOUT_MS', 15000),
    adminApiKey: adminApiKeySetting === '' ? null : adminApiKeySetting,
  };
}

/** 全局唯一的应用配置（模块首次加载时读取并校验） */
export const appConfig: AppConfig = Object.freeze(loadAppConfig());
