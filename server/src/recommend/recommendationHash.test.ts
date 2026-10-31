/** 独立导入纯帮助函数，不依赖service、数据库连接、CLI或config。 */
import { describe, expect, it } from 'vitest';
import { assertRecommendationContentHash, canonicalJson, computeRecommendationContentHash } from './recommendationHash';
import type { RecommendationContent } from './recommendationTypes';

const content: RecommendationContent = {
  strategyName: 'M0_uniform_random', strategyVersion: '1.0.0', strategyParams: { example: { b: 2, a: 1 } },
  seed: 0, tickets: [{ redBalls: [1, 2, 3, 4, 5, 6], blueBall: 7 }],
  targetIssue: '2026125', targetDrawDate: '2026-11-01',
  generationDeadline: '2026-11-01T20:00:00.000+08:00', sourceLatestIssue: '2026124',
  generatedAt: '2026-10-31T04:00:00.000Z',
};

describe('无配置依赖的canonical帮助函数', () => {
  it('纯JSON键排序、数组保持顺序，含中文内容可复算', () => {
    expect(canonicalJson({ 说明: '一致性而非可信时间戳', params: { z: 0, a: [6, 1] } }))
      .toBe('{"params":{"a":[6,1],"z":0},"说明":"一致性而非可信时间戳"}');
    const contentHash = computeRecommendationContentHash(content);
    expect(contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertRecommendationContentHash({ ...content, contentHash })).not.toThrow();
    expect(computeRecommendationContentHash({ ...content, strategyParams: { example: { a: 1, b: 2 } } })).toBe(contentHash);
  });

  it('篡改时间/目标/票顺序会拒绝，hash不能验证开奖前第三方时间', () => {
    const contentHash = computeRecommendationContentHash(content);
    expect(() => assertRecommendationContentHash({ ...content, targetIssue: '2026126', contentHash })).toThrow(/哈希不一致/);
    expect(computeRecommendationContentHash({ ...content, tickets: [{ redBalls: [6, 5, 4, 3, 2, 1], blueBall: 7 }] }))
      .not.toBe(contentHash);
  });

  it.each([undefined, NaN, Infinity, new Date(), { value: undefined }, [undefined]])('非JSON值不静默丢失：%j', value => {
    expect(() => canonicalJson(value)).toThrow(/canonical/);
  });
});