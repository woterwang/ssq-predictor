/** 可嵌入的 Express 工厂；所有运行依赖由入口注入，不启动监听、不读取 appConfig/CLI。 */
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Express, RequestHandler, ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { getBasicAnalysis } from '../analysis/basicAnalysisService';
import { calculateDrawFeatures } from '../analysis/drawFeatures';
import { findPublicDraw, listPublicBacktests, listPublicDraws, listPublicRecommendations,
  publicRecommendation } from '../db/apiRepository';
import { findRecommendationById } from '../db/recommendationRepository';
import { generateNextRecommendation, getRecommendationVerification, verifyPendingRecommendations } from '../recommend/recommendationService';
import { summarizeRecommendationPerformance } from '../recommend/recommendationSummary';
import type { ApiDependencies } from './apiTypes';
import { API_DISCLAIMERS } from './apiTypes';
import { allowedQuery, analysisQuery, ApiError, assertEmptyBody,
  paginationQuery, parseIssue, parsePositiveInteger, parseTicket } from './apiValidation';
import { nextRecommendationView } from './nextRecommendation';

export type { ApiDependencies } from './apiTypes';

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', '请求的资源不存在');
}

export function createApiApp(dependencies: ApiDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.enable('strict routing');
  app.enable('case sensitive routing');
  app.set('trust proxy', false);
  app.set('query parser', 'simple');
  app.set('json escape', true);
  app.use(helmet());
  // 全 API 禁缓存，管理及推荐（含错误响应）更不能被代理缓存或变成 304。
  app.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });

  const limits = dependencies.rateLimit ?? { windowMs: 60_000, publicMax: 120, adminMax: 5 };
  for (const value of [limits.windowMs, limits.publicMax, limits.adminMax]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('API 限流配置须为安全正整数');
  }
  const limiter = (maximum: number) => rateLimit({
    windowMs: limits.windowMs, limit: maximum, standardHeaders: 'draft-8', legacyHeaders: false,
    // trust proxy 固定为 false，主动忽略代理头；关闭的只是对应警告，不改变按 socket IP 限流。
    validate: { xForwardedForHeader: false, forwardedHeader: false },
    handler: (_request, response) => response.status(429).json({ error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' } }),
  });
  const publicLimiter = limiter(limits.publicMax);
  app.use((request, response, next) => {
    if (request.path === '/api/admin' || request.path.startsWith('/api/admin/')) next();
    else publicLimiter(request, response, next);
  });

  // 固定长度 SHA-256 摘要再 timingSafeEqual；请求只接受 Authorization，不从 query/body 取密钥。
  const expectedKeyHash = dependencies.adminApiKey === null ? null
    : createHash('sha256').update(dependencies.adminApiKey, 'utf8').digest();
  app.use('/api/admin', limiter(limits.adminMax), (request, response, next) => {
    if (expectedKeyHash === null) return next(new ApiError(503, 'ADMIN_DISABLED', '管理接口未配置密钥'));
    const authorization = request.get('Authorization') ?? '';
    const bearer = /^Bearer ([^\s]+)$/i.exec(authorization);
    const suppliedHash = createHash('sha256').update(bearer?.[1] ?? '', 'utf8').digest();
    const matches = timingSafeEqual(expectedKeyHash, suppliedHash);
    if (bearer === null || !matches) {
      response.set('WWW-Authenticate', 'Bearer');
      return next(new ApiError(401, 'UNAUTHORIZED', '需要有效的管理身份凭证'));
    }
    next();
  });

  // body-parser 的 verify 参数是 Node 请求/响应类型，WeakSet 避免扩展 Express/Node 的全局接口。
  const requestsWithJsonBody = new WeakSet<object>();
  const jsonParser = express.json({ limit: '8kb', strict: true, inflate: false,
    verify: (request, _response, buffer) => { if (buffer.length > 0) requestsWithJsonBody.add(request); } });
  app.use((request, response, next) => {
    if (request.method !== 'POST') return next();
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.get('Content-Type') ?? '')) {
      return next(new ApiError(400, 'INVALID_JSON', 'POST 只接受 application/json 请求体'));
    }
    jsonParser(request, response, next);
  });
  app.use((request, _response, next) => {
    if (request.method === 'POST' && !requestsWithJsonBody.has(request)) {
      return next(new ApiError(400, 'INVALID_JSON', '必须提供 JSON 请求体'));
    }
    next();
  });

  app.get('/health', (request, response) => {
    allowedQuery(request, []);
    dependencies.database.prepare('SELECT 1 AS alive').get();
    response.json({ data: { status: 'ok', database: 'ok' } });
  });
  app.get('/api/draws', (request, response) => {
    const { limit, beforeIssue } = paginationQuery(request, 'beforeIssue');
    const data = listPublicDraws(dependencies.database, limit, beforeIssue);
    response.json({ data, pagination: { limit, beforeIssue, nextBeforeIssue: data.at(-1)?.issue ?? null } });
  });
  // 固定端点必须先于动态期号端点注册。
  app.get('/api/draws/latest', (request, response) => {
    allowedQuery(request, []);
    response.json({ data: listPublicDraws(dependencies.database, 1, null)[0] ?? notFound() });
  });
  app.get('/api/draws/:issue', (request, response) => {
    allowedQuery(request, []);
    response.json({ data: findPublicDraw(dependencies.database, parseIssue(request.params.issue)) ?? notFound() });
  });
  for (const path of ['/api/statistics', '/api/features']) {
    app.get(path, (request, response) => {
      // 不存在的 asOfIssue 也是合法包含式上界；报告给出 requested/actual 截止与明确 warnings。
      response.json({ data: getBasicAnalysis(dependencies.database, analysisQuery(request)) });
    });
  }
  app.get('/api/recommendations/next', (request, response) => {
    allowedQuery(request, []);
    response.json({ data: nextRecommendationView(dependencies) });
  });
  app.get('/api/recommendations', (request, response) => {
    const { limit, beforeId } = paginationQuery(request, 'beforeId');
    const data = listPublicRecommendations(dependencies.database, limit, beforeId);
    response.json({ data, pagination: { limit, beforeId, nextBeforeId: data.at(-1)?.id ?? null }, disclaimers: API_DISCLAIMERS });
  });
  app.get('/api/recommendations/summary', (request, response) => {
    allowedQuery(request, []);
    response.json({ data: summarizeRecommendationPerformance(dependencies.database), disclaimers: API_DISCLAIMERS });
  });
  app.get('/api/recommendations/:id/verification', (request, response) => {
    allowedQuery(request, []);
    const view = getRecommendationVerification(dependencies.database, parsePositiveInteger(request.params.id)) ?? notFound();
    response.json({ data: { ...view, recommendation: publicRecommendation(view.recommendation) }, disclaimers: API_DISCLAIMERS });
  });
  app.get('/api/recommendations/:id', (request, response) => {
    allowedQuery(request, []);
    const record = findRecommendationById(dependencies.database, parsePositiveInteger(request.params.id)) ?? notFound();
    response.json({ data: publicRecommendation(record), disclaimers: API_DISCLAIMERS });
  });
  app.get('/api/backtests', (request, response) => {
    const { limit, beforeId } = paginationQuery(request, 'beforeId');
    const data = listPublicBacktests(dependencies.database, limit, beforeId);
    response.json({ data, pagination: { limit, beforeId, nextBeforeId: data.at(-1)?.id ?? null } });
  });
  app.post('/api/tickets/check', (request, response) => {
    allowedQuery(request, []);
    const ticket = parseTicket(request.body);
    // 组合特征不需要真实期号：固定占位只供纯函数使用，响应去掉占位期号/日期。
    const { issue: _issue, drawDate: _date, ...features } = calculateDrawFeatures({
      issue: '2003001', drawDate: '2003-02-23', redBalls: ticket.redBalls, blueBall: ticket.blueBall,
    }, null);
    response.json({ data: { ticket, features,
      theoretical: { jackpotProbability: 1 / 17_721_088, jackpotOdds: '1/17721088', totalSingleTickets: 17_721_088 },
      disclaimers: API_DISCLAIMERS } });
  });

  const emptyAdminRequest: RequestHandler = (request, _response, next) => {
    allowedQuery(request, []);
    assertEmptyBody(request.body);
    next();
  };
  app.post('/api/admin/sync', emptyAdminRequest, (_request, response, next) => {
    // 兼容同步抛错与异步拒绝，Express 4 不会自动捕获 Promise 的 rejection。
    Promise.resolve().then(() => dependencies.synchronize()).then(
      () => response.json({ data: { synchronized: true } }), next,
    );
  });
  app.post('/api/admin/recommendations/generate', emptyAdminRequest, (_request, response) => {
    const view = nextRecommendationView(dependencies);
    if (view.nextDraw === null || !['not_generated', 'available'].includes(view.status)) {
      throw new ApiError(400, 'GENERATION_UNAVAILABLE', '当前无法生成推荐：请检查开奖同步与保守生成截止');
    }
    // 不传 options：服务默认 M0、5 注、crypto UInt32 种子；时间仅来自服务器依赖。
    const record = generateNextRecommendation(dependencies.database, dependencies.loadSuspensionPeriods(), dependencies.now());
    response.json({ data: publicRecommendation(record), disclaimers: API_DISCLAIMERS });
  });
  app.post('/api/admin/recommendations/verify', emptyAdminRequest, (_request, response) => {
    const result = verifyPendingRecommendations(dependencies.database, dependencies.now());
    // 核心逐条 skip 原因可能包含底层异常，只公开固定说明与对应 id。
    response.json({ data: { ...result, skipped: result.skipped.map(item => ({ recommendationId: item.recommendationId,
      reason: '记录未通过核验条件，请由服务端检查' })) }, disclaimers: API_DISCLAIMERS });
  });

  app.use((_request, _response, next) => next(new ApiError(404, 'NOT_FOUND', '请求的资源不存在')));
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ApiError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    // 只认 JSON 解析器错误类别，不透传 error.message/status/stack 或 SQLite 的诊断文本。
    const parserType = error !== null && typeof error === 'object' && 'type' in error ? error.type : null;
    if (['entity.parse.failed', 'entity.too.large', 'encoding.unsupported', 'charset.unsupported',
      'request.aborted', 'request.size.invalid'].includes(String(parserType))) {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: 'JSON 请求体无效或超过 8KB 限制' } });
      return;
    }
    if (error instanceof URIError) {
      response.status(400).json({ error: { code: 'INVALID_INPUT', message: 'URL 编码不合法' } });
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器暂时无法完成请求' } });
  };
  app.use(errorHandler);
  return app;
}