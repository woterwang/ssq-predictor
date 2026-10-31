/**
 * 中国福彩网开奖查询接口客户端
 *
 * 功能：
 * 1. 请求节流：两次请求之间至少间隔配置的毫秒数（默认 1.5 秒），避免给官方站点造成压力；
 * 2. 超时控制：单次请求超过配置时间自动中断；
 * 3. 失败重试：仅对“可能是临时故障”的错误（网络错误、超时、HTTP 429、HTTP 5xx）按指数退避重试；
 *    HTTP 403 等被拒绝访问的情况不重试，重试只会加重拦截；
 * 4. 原始响应存档：每次成功响应按日期存为 JSON 文件，接口字段变化时可回放重新解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import { appConfig } from '../config';
import { logger } from '../utils/logger';
import { formatBeijingTimestamp, sleep } from '../utils/time';
import type { CwlDrawNoticeItemRaw, CwlDrawNoticeQuery, CwlDrawNoticeResponse } from './cwlApiTypes';

/** 请求头：与普通浏览器访问开奖公告页时一致 */
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/',
};

/** 默认最多尝试次数（含首次请求） */
const DEFAULT_MAX_ATTEMPTS = 3;
/** 重试退避的基础等待时间：第 1 次重试等 2 秒，第 2 次等 4 秒，依次翻倍 */
const RETRY_BASE_DELAY_MS = 2000;
/** 错误信息中截取的响应内容长度 */
const ERROR_BODY_PREVIEW_LENGTH = 120;

/** 接口请求错误；isRetryable 表示是否值得重试 */
export class CwlApiRequestError extends Error {
  readonly isRetryable: boolean;

  constructor(message: string, isRetryable: boolean) {
    super(message);
    this.name = 'CwlApiRequestError';
    this.isRetryable = isRetryable;
  }
}

/** 客户端参数 */
export interface CwlApiClientOptions {
  /** 接口地址 */
  apiUrl: string;
  /** 两次请求之间的最小间隔（毫秒） */
  requestIntervalMs: number;
  /** 单次请求超时（毫秒） */
  requestTimeoutMs: number;
  /** 原始响应存档目录；为 null 时不存档 */
  rawResponseArchiveDir: string | null;
  /** 最多尝试次数（含首次请求），默认 3 */
  maxAttempts?: number;
}

export class CwlDrawNoticeApiClient {
  private readonly options: CwlApiClientOptions;
  /** 上一次请求的开始时间（毫秒时间戳），用于节流 */
  private lastRequestStartedAt = 0;

  constructor(options: CwlApiClientOptions) {
    this.options = options;
  }

  /**
   * 获取一页开奖数据；遇到临时故障会自动重试。
   */
  async fetchDrawNoticePage(query: CwlDrawNoticeQuery): Promise<CwlDrawNoticeResponse> {
    const maxAttempts = this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    for (let attemptNumber = 1; ; attemptNumber++) {
      try {
        return await this.requestPageOnce(query);
      } catch (error) {
        const canRetry = error instanceof CwlApiRequestError && error.isRetryable && attemptNumber < maxAttempts;
        if (!canRetry) {
          throw error;
        }
        const backoffMs = RETRY_BASE_DELAY_MS * 2 ** (attemptNumber - 1);
        logger.warn(
          `[采集] 第 ${attemptNumber} 次请求失败（${(error as Error).message}），${backoffMs / 1000} 秒后重试`,
        );
        await sleep(backoffMs);
      }
    }
  }

  /**
   * 发送一次请求（不重试），并校验响应结构。
   */
  private async requestPageOnce(query: CwlDrawNoticeQuery): Promise<CwlDrawNoticeResponse> {
    await this.waitForRequestInterval();

    const requestUrl = this.buildRequestUrl(query);
    const abortController = new AbortController();
    const timeoutTimer = setTimeout(() => abortController.abort(), this.options.requestTimeoutMs);

    let httpStatus: number;
    let responseText: string;
    try {
      const response = await fetch(requestUrl, { headers: REQUEST_HEADERS, signal: abortController.signal });
      httpStatus = response.status;
      responseText = await response.text();
    } catch (error) {
      // 网络错误与超时都可能是临时故障，允许重试
      const reason = abortController.signal.aborted
        ? `请求超时（超过 ${this.options.requestTimeoutMs} 毫秒）`
        : `网络错误：${(error as Error).message}`;
      throw new CwlApiRequestError(reason, true);
    } finally {
      clearTimeout(timeoutTimer);
    }

    if (httpStatus < 200 || httpStatus >= 300) {
      const isRetryable = httpStatus === 429 || httpStatus >= 500;
      const hint = httpStatus === 403 ? '（访问被拒绝，可能被站点安全防护拦截，如经代理出口访问）' : '';
      throw new CwlApiRequestError(
        `HTTP ${httpStatus}${hint}：${responseText.slice(0, ERROR_BODY_PREVIEW_LENGTH)}`,
        isRetryable,
      );
    }

    this.archiveRawResponse(query, responseText);

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(responseText);
    } catch {
      // 返回了网页而不是 JSON，通常是被拦截或接口变更，重试无意义
      throw new CwlApiRequestError(
        `响应不是合法 JSON：${responseText.slice(0, ERROR_BODY_PREVIEW_LENGTH)}`,
        false,
      );
    }

    return assertDrawNoticeResponse(parsedBody);
  }

  /**
   * 节流：距上次请求不足最小间隔时，等待剩余时间。
   */
  private async waitForRequestInterval(): Promise<void> {
    const elapsedMs = Date.now() - this.lastRequestStartedAt;
    const remainingMs = this.options.requestIntervalMs - elapsedMs;
    if (remainingMs > 0) {
      await sleep(remainingMs);
    }
    this.lastRequestStartedAt = Date.now();
  }

  /**
   * 拼接请求地址。未使用的参数也传空字符串，与官网页面的请求方式保持一致。
   */
  private buildRequestUrl(query: CwlDrawNoticeQuery): string {
    const searchParams = new URLSearchParams({
      name: 'ssq',
      issueCount: query.issueCount === undefined ? '' : String(query.issueCount),
      issueStart: query.issueStart ?? '',
      issueEnd: query.issueEnd ?? '',
      dayStart: query.dayStart ?? '',
      dayEnd: query.dayEnd ?? '',
      pageNo: String(query.pageNo),
      pageSize: String(query.pageSize),
      systemType: 'PC',
    });
    return `${this.options.apiUrl}?${searchParams.toString()}`;
  }

  /**
   * 把原始响应存为文件：<存档目录>/<日期>/<时分秒毫秒>_<查询范围>_p<页码>.json
   */
  private archiveRawResponse(query: CwlDrawNoticeQuery, responseText: string): void {
    if (this.options.rawResponseArchiveDir === null) {
      return;
    }
    const timestamp = formatBeijingTimestamp(); // 如 2026-10-31T13:28:00.123+08:00
    const dateFolderName = timestamp.slice(0, 10);
    const timeLabel = timestamp.slice(11, 23).replace(/[:.]/g, '');
    const rangeLabel = query.issueStart ? `${query.issueStart}-${query.issueEnd ?? ''}` : 'latest';
    const archiveDir = path.join(this.options.rawResponseArchiveDir, dateFolderName);

    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, `${timeLabel}_${rangeLabel}_p${query.pageNo}.json`), responseText, 'utf8');
  }
}

/**
 * 校验响应的基本结构：state 为 0、result 为对象数组、分页字段为数字。
 * 单条记录的字段由解析器另行校验。
 */
function assertDrawNoticeResponse(body: unknown): CwlDrawNoticeResponse {
  if (typeof body !== 'object' || body === null) {
    throw new CwlApiRequestError('响应结构错误：不是 JSON 对象', false);
  }
  const responseObject = body as Record<string, unknown>;

  if (responseObject.state !== 0) {
    throw new CwlApiRequestError(
      `接口返回失败状态：state=${String(responseObject.state)}，message=${String(responseObject.message)}`,
      false,
    );
  }

  const resultList = responseObject.result;
  if (!Array.isArray(resultList) || resultList.some((item) => typeof item !== 'object' || item === null)) {
    throw new CwlApiRequestError('响应结构错误：result 不是对象数组', false);
  }

  const numericFieldNames = ['total', 'pageNum', 'pageNo', 'pageSize'] as const;
  for (const fieldName of numericFieldNames) {
    if (typeof responseObject[fieldName] !== 'number') {
      throw new CwlApiRequestError(`响应结构错误：${fieldName} 不是数字`, false);
    }
  }

  return {
    state: 0,
    message: String(responseObject.message ?? ''),
    total: responseObject.total as number,
    pageNum: responseObject.pageNum as number,
    pageNo: responseObject.pageNo as number,
    pageSize: responseObject.pageSize as number,
    result: resultList as CwlDrawNoticeItemRaw[],
  };
}

/**
 * 按应用配置创建客户端。
 */
export function createCwlApiClientFromConfig(): CwlDrawNoticeApiClient {
  return new CwlDrawNoticeApiClient({
    apiUrl: appConfig.cwlDrawNoticeApiUrl,
    requestIntervalMs: appConfig.cwlRequestIntervalMs,
    requestTimeoutMs: appConfig.cwlRequestTimeoutMs,
    rawResponseArchiveDir: appConfig.rawResponseArchiveDir,
  });
}
