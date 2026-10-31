/** 严格边界校验：不做宽松数字转换，不忽略额外字段或重复查询参数。 */
import type { Request } from 'express';
import type { AnalysisQuery } from '../analysis/analysisTypes';
import type { LotteryTicket } from '../backtest/backtestTypes';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function invalidInput(message = '请求参数格式不合法'): never {
  throw new ApiError(400, 'INVALID_INPUT', message);
}

/** 从原始 URL 校验，不依赖可能截断参数或吞掉 __proto__ 的查询解析器。 */
export function allowedQuery(request: Request, allowedNames: readonly string[]): Map<string, string> {
  const queryOffset = request.originalUrl.indexOf('?');
  const parameters = new URLSearchParams(queryOffset < 0 ? '' : request.originalUrl.slice(queryOffset + 1));
  const values = new Map<string, string>();
  for (const [name, value] of parameters) {
    if (!allowedNames.includes(name) || values.has(name) || value.length === 0) {
      invalidInput('不接受未知、重复或空的查询参数');
    }
    values.set(name, value);
  }
  return values;
}

export function parseIssue(value: string): string {
  if (!/^[1-9]\d{6}$/.test(value) || value.endsWith('000') || Number(value.slice(0, 4)) < 2003) {
    invalidInput('期号须为有效的七位数字（年份及非零年内序号）');
  }
  return value;
}

export function parsePositiveInteger(value: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!/^[1-9]\d*$/.test(value)) invalidInput('数字参数须为无前导零的正整数');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) invalidInput('数字参数超出允许范围');
  return parsed;
}

export function paginationQuery(request: Request, cursorName: 'beforeIssue' | 'beforeId') {
  const query = allowedQuery(request, ['limit', cursorName]);
  const limit = query.has('limit') ? parsePositiveInteger(query.get('limit')!, 100) : 20;
  const cursor = query.get(cursorName);
  return {
    limit,
    beforeIssue: cursorName === 'beforeIssue' && cursor !== undefined ? parseIssue(cursor) : null,
    beforeId: cursorName === 'beforeId' && cursor !== undefined ? parsePositiveInteger(cursor) : null,
  };
}

export function analysisQuery(request: Request): AnalysisQuery {
  const query = allowedQuery(request, ['window', 'asOfIssue']);
  const windowText = query.get('window') ?? 'all';
  if (!['all', '30', '100', '300'].includes(windowText)) invalidInput('window 只接受 all、30、100、300');
  const asOfIssue = query.get('asOfIssue');
  return {
    window: windowText === 'all' ? null : Number(windowText),
    ...(asOfIssue === undefined ? {} : { asOfIssue: parseIssue(asOfIssue) }),
  };
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) invalidInput('请求体必须是 JSON 对象');
  return body as Record<string, unknown>;
}

export function assertEmptyBody(body: unknown): void {
  if (Object.keys(bodyObject(body)).length !== 0) invalidInput('管理请求只接受空对象 {}，不允许指定时间、种子或注数');
}

export function parseTicket(body: unknown): LotteryTicket {
  const object = bodyObject(body);
  if (Object.keys(object).length !== 2 || !Object.hasOwn(object, 'redBalls') || !Object.hasOwn(object, 'blueBall')) {
    invalidInput('单注只接受 redBalls 和 blueBall 两个字段');
  }
  const { redBalls, blueBall } = object;
  if (!Array.isArray(redBalls) || redBalls.length !== 6 || new Set(redBalls).size !== 6
    || redBalls.some(ball => typeof ball !== 'number' || !Number.isInteger(ball) || ball < 1 || ball > 33)
    || typeof blueBall !== 'number' || !Number.isInteger(blueBall) || blueBall < 1 || blueBall > 16) {
    invalidInput('单式票须为六个不重复的 1–33 整数红球与一个 1–16 整数蓝球');
  }
  return { redBalls: [...redBalls].sort((left, right) => left - right), blueBall };
}