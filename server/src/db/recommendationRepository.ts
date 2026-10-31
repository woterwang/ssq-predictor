/** 仅数据访问，连接只作类型引用，不触发生产配置加载。 */
import type { SqliteDatabase } from './connection';
import type {
  RecommendationRecord, RecommendationVerificationRecord, RecommendationVerificationResult,
} from '../recommend/recommendationTypes';

interface RecommendationRow {
  id: number; target_issue: string; target_draw_date: string | null;
  generation_deadline: string | null; source_latest_issue: string | null;
  strategy_name: string; strategy_version: string; strategy_params_json: string;
  random_seed: string; tickets_json: string; content_hash: string; generated_at: string;
}

function mapRecommendation(row: RecommendationRow): RecommendationRecord {
  return {
    id: row.id, targetIssue: row.target_issue, targetDrawDate: row.target_draw_date,
    generationDeadline: row.generation_deadline, sourceLatestIssue: row.source_latest_issue,
    strategyName: row.strategy_name, strategyVersion: row.strategy_version,
    strategyParams: JSON.parse(row.strategy_params_json) as RecommendationRecord['strategyParams'],
    seed: Number(row.random_seed), tickets: JSON.parse(row.tickets_json) as RecommendationRecord['tickets'],
    contentHash: row.content_hash, generatedAt: row.generated_at,
  };
}

export function findRecommendationById(database: SqliteDatabase, id: number): RecommendationRecord | null {
  const row = database.prepare('SELECT * FROM recommendations WHERE id = ?').get(id) as RecommendationRow | undefined;
  return row ? mapRecommendation(row) : null;
}

/** 不按版本过滤，数据库唯一约束也跨版本，不能改版本号绕过固化。 */
export function findRecommendationByTargetAndStrategy(
  database: SqliteDatabase, targetIssue: string, strategyName: string,
): RecommendationRecord | null {
  const row = database.prepare('SELECT * FROM recommendations WHERE target_issue = ? AND strategy_name = ?')
    .get(targetIssue, strategyName) as RecommendationRow | undefined;
  return row ? mapRecommendation(row) : null;
}

export function listRecommendations(database: SqliteDatabase): RecommendationRecord[] {
  return (database.prepare('SELECT * FROM recommendations ORDER BY id').all() as RecommendationRow[]).map(mapRecommendation);
}

export function insertRecommendation(
  database: SqliteDatabase, record: Omit<RecommendationRecord, 'id'>,
): RecommendationRecord {
  const result = database.prepare(`INSERT INTO recommendations
    (target_issue, strategy_name, strategy_version, strategy_params_json, random_seed, tickets_json,
     content_hash, generated_at, target_draw_date, generation_deadline, source_latest_issue)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.targetIssue, record.strategyName, record.strategyVersion, JSON.stringify(record.strategyParams),
    String(record.seed), JSON.stringify(record.tickets), record.contentHash, record.generatedAt,
    record.targetDrawDate, record.generationDeadline, record.sourceLatestIssue,
  );
  return { ...record, id: Number(result.lastInsertRowid) };
}

interface VerificationRow {
  id: number; recommendation_id: number; draw_fingerprint: string; result_json: string; verified_at: string;
}

function mapVerification(row: VerificationRow): RecommendationVerificationRecord {
  return {
    id: row.id, recommendationId: row.recommendation_id, drawFingerprint: row.draw_fingerprint,
    result: JSON.parse(row.result_json) as RecommendationVerificationResult, verifiedAt: row.verified_at,
  };
}

export function listRecommendationVerifications(
  database: SqliteDatabase, recommendationId: number,
): RecommendationVerificationRecord[] {
  return (database.prepare(`SELECT * FROM recommendation_verifications
    WHERE recommendation_id = ? ORDER BY id DESC`).all(recommendationId) as VerificationRow[]).map(mapVerification);
}

export function insertRecommendationVerification(
  database: SqliteDatabase, record: Omit<RecommendationVerificationRecord, 'id'>,
): RecommendationVerificationRecord {
  const result = database.prepare(`INSERT INTO recommendation_verifications
    (recommendation_id, draw_fingerprint, result_json, verified_at) VALUES (?, ?, ?, ?)`).run(
    record.recommendationId, record.drawFingerprint, JSON.stringify(record.result), record.verifiedAt,
  );
  return { ...record, id: Number(result.lastInsertRowid) };
}