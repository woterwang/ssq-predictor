import { getApiBaseUrl } from '../config/environment';
import type { Envelope, PublicDraw, NextRecommendation, Recommendation, VerificationView,
  AnalysisReport, AnalysisWindow, BacktestRun, Ticket, TicketCheckResult } from '../types/api';
import { validateDraw, validateNext, validateRecommendation, validateVerification,
  validateAnalysis, validateBacktest, validateTicketCheck } from './validation';

export class PublicApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 0, public readonly retryAfterSeconds = 0) {
    super(message);
    this.name = 'PublicApiError';
  }
}
// 同一小程序进程内尊重服务端Retry-After；不会自动重试、不会持久化或绕过限流。
let blockedUntil = 0;

function retryAfterSeconds(header: Record<string, unknown>): number {
  const key = Object.keys(header).find(name => name.toLowerCase() === 'retry-after');
  const value = key ? String(header[key]) : '';
  if (/^\d+$/.test(value)) return Math.min(86400, Number(value));
  const seconds = Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, Math.min(86400, seconds)) : 60;
}

function request<T>(path: string, validate: (value: unknown) => T, body: Ticket | null = null): Promise<Envelope<T>> {
  const wait = Math.ceil((blockedUntil - Date.now()) / 1000);
  if (wait > 0) return Promise.reject(new PublicApiError('RATE_LIMITED', `请求频繁，请${wait}秒后再试`, 429, wait));
  let baseUrl: string;
  try { baseUrl = getApiBaseUrl(); } catch (error) {
    return Promise.reject(new PublicApiError('ENVIRONMENT', error instanceof Error ? error.message : '服务地址未配置'));
  }
  return new Promise((resolve, reject) => {
    // 除无状态选号体检外均为GET；不设置Authorization、不接收自由URL、不给客户端管理入口。
    wx.request({
      url: `${baseUrl}${path}`, method: body ? 'POST' : 'GET', timeout: 15000,
      header: body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      ...(body ? { data: { redBalls: body.redBalls, blueBall: body.blueBall } } : {}),
      success(response) {
        if (response.statusCode === 429) {
          const seconds = retryAfterSeconds(response.header);
          blockedUntil = Date.now() + seconds * 1000;
          reject(new PublicApiError('RATE_LIMITED', `请求频繁，请${seconds}秒后再试`, 429, seconds));
          return;
        }
        if (response.statusCode !== 200) {
          const message = response.statusCode === 404 ? '尚未收录该记录'
            : response.statusCode === 400 ? '服务器未接受该请求参数' : '服务暂时不可用，请稍后重试';
          reject(new PublicApiError(response.statusCode === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', message, response.statusCode));
          return;
        }
        try {
          const body = response.data as unknown;
          if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('响应格式无效');
          const envelope = body as Envelope<unknown>;
          resolve({ data: validate(envelope.data), pagination: envelope.pagination });
        } catch { reject(new PublicApiError('INVALID_RESPONSE', '服务数据格式不完整，未将其显示为有效结果')); }
      },
      fail() { reject(new PublicApiError('NETWORK', '未能取得最新数据，请检查网络或开发环境服务地址')); },
    });
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof PublicApiError ? error.message : '未能取得最新数据，请稍后重试';
}
export function isNotFound(error: unknown): boolean { return error instanceof PublicApiError && error.status === 404; }
export function isIssue(value: string): boolean { return /^[1-9]\d{6}$/.test(value) && !value.endsWith('000'); }
function positiveId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('记录编号非法');
  return id;
}
function validIssue(issue: string): string {
  if (!isIssue(issue)) throw new Error('请输入有效的7位期号');
  return issue;
}
export const ANALYSIS_WINDOWS: readonly AnalysisWindow[] = ['30', '100', '300', 'all'];
export function isAnalysisWindow(value: unknown): value is AnalysisWindow { return ANALYSIS_WINDOWS.includes(value as AnalysisWindow); }
// 分析与走势同筛选复用同一请求（仅进程内存，不持久化）；失败不缓存，用户刷新时强制重取。
const analysisCache = new Map<AnalysisWindow, Promise<Envelope<AnalysisReport>>>();

export const api = {
  getNext(): Promise<Envelope<NextRecommendation>> { return request('/api/recommendations/next', validateNext); },
  getLatestDraw(): Promise<Envelope<PublicDraw>> { return request('/api/draws/latest', validateDraw); },
  getDraw(issue: string): Promise<Envelope<PublicDraw>> { return request(`/api/draws/${validIssue(issue)}`, validateDraw); },
  listDraws(beforeIssue: string | null = null): Promise<Envelope<PublicDraw[]>> {
    return request(`/api/draws?limit=20${beforeIssue ? `&beforeIssue=${validIssue(beforeIssue)}` : ''}`, value => {
      if (!Array.isArray(value)) throw new Error('开奖列表无效');
      return value.map(validateDraw);
    });
  },
  listRecommendations(beforeId: number | null = null): Promise<Envelope<Recommendation[]>> {
    return request(`/api/recommendations?limit=20${beforeId === null ? '' : `&beforeId=${positiveId(beforeId)}`}`, value => {
      if (!Array.isArray(value)) throw new Error('推荐列表无效');
      return value.map(validateRecommendation);
    });
  },
  getVerification(id: number): Promise<Envelope<VerificationView>> {
    return request(`/api/recommendations/${positiveId(id)}/verification`, validateVerification);
  },
  getAnalysis(window: AnalysisWindow, refresh = false): Promise<Envelope<AnalysisReport>> {
    if (!isAnalysisWindow(window)) return Promise.reject(new PublicApiError('INVALID_INPUT', '统计窗口无效'));
    const cached = analysisCache.get(window);
    if (cached && !refresh) return cached;
    const pending = request(`/api/statistics?window=${window}`, validateAnalysis);
    analysisCache.set(window, pending);
    pending.catch(() => { if (analysisCache.get(window) === pending) analysisCache.delete(window); });
    return pending;
  },
  listBacktests(beforeId: number | null = null): Promise<Envelope<BacktestRun[]>> {
    return request(`/api/backtests?limit=20${beforeId === null ? '' : `&beforeId=${positiveId(beforeId)}`}`, value => {
      if (!Array.isArray(value)) throw new Error('回测列表无效');
      return value.map(validateBacktest);
    });
  },
  /** 只提交本地选择的单注结构；不传身份、倍数或种子，服务器不保存。 */
  checkTicket(ticket: Ticket): Promise<Envelope<TicketCheckResult>> {
    const reds = ticket.redBalls;
    if (reds.length !== 6 || new Set(reds).size !== 6 || reds.some(n => !Number.isInteger(n) || n < 1 || n > 33)
      || !Number.isInteger(ticket.blueBall) || ticket.blueBall < 1 || ticket.blueBall > 16) {
      return Promise.reject(new PublicApiError('INVALID_INPUT', '须选择6个不重复红球与1个蓝球'));
    }
    const submitted = { redBalls: [...reds].sort((a, b) => a - b), blueBall: ticket.blueBall };
    return request('/api/tickets/check', value => validateTicketCheck(value, submitted), submitted);
  },
};