/**
 * 基础统计验收脚本：npm run verify:basic
 * 小样本用手算期望，真实频次用独立 SQL；缓存行为仅在内存数据库中验证。
 * 不访问外网、不修改正式开奖表。保留此命令供后续人工维护时重复核验。
 */
import assert from 'node:assert/strict';
import { getBasicAnalysis } from '../src/analysis/basicAnalysisService';
import { calculateDrawFeatures } from '../src/analysis/drawFeatures';
import { calculateNumberStatistics } from '../src/analysis/numberStatistics';
import type { AnalysisDraw } from '../src/analysis/analysisTypes';
import { closeDatabase, getDatabase, openDatabase } from '../src/db/connection';
import { parseRawDrawItems, saveDraws } from '../src/collector/drawImportService';
import { applyPendingMigrations } from '../src/db/migrations';
import { findDrawByIssue } from '../src/db/drawRepository';

let checkCount = 0;
function check(description: string, verification: () => void): void {
  verification();
  checkCount++;
  console.log(`[通过] ${description}`);
}

const redSamples = [
  [1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12], [1, 2, 13, 14, 15, 16],
  [17, 18, 19, 20, 21, 22], [23, 24, 25, 26, 27, 28], [1, 3, 4, 5, 6, 32],
];
const sampleDraws: AnalysisDraw[] = redSamples.map((redBalls, index) => ({
  issue: `202600${index + 1}`, drawDate: `2026-01-0${index + 1}`, redBalls,
  blueBall: [1, 2, 1, 3, 3, 1][index],
}));

function verifyHandCalculatedStatistics(): void {
  const reds = calculateNumberStatistics(sampleDraws, 'red');
  const blues = calculateNumberStatistics(sampleDraws, 'blue');
  check('红球1在第1/3/6期出现，完整遗漏为1和2、平均1.5、当前0', () => {
    assert.equal(reds[0].appearanceCount, 3);
    assert.equal(reds[0].appearanceRate, 0.5);
    assert.equal(reds[0].currentOmission, 0);
    assert.equal(reds[0].averageCompleteOmission, 1.5);
    assert.equal(reds[0].maximumCompleteOmission, 2);
    assert.equal(reds[0].maximumObservedOmission, 2);
    assert.deepEqual(reds[0].completeOmissionDistribution, { '1': 1, '2': 1 });
  });
  check('红球7仅第2期出现：当前遗漏4，完整平均值应为空', () => {
    assert.equal(reds[6].currentOmission, 4);
    assert.equal(reds[6].averageCompleteOmission, null);
    assert.equal(reds[6].currentOmissionIsLowerBound, false);
  });
  check('未出现红球33：当前遗漏为至少6期，不虚构上次出现', () => {
    assert.equal(reds[32].currentOmission, 6);
    assert.equal(reds[32].currentOmissionIsLowerBound, true);
    assert.equal(reds[32].lastAppearanceIssue, null);
  });
  check('蓝球3连续两期出现：完整遗漏0，当前遗漏1', () => {
    assert.equal(blues[2].averageCompleteOmission, 0);
    assert.equal(blues[2].currentOmission, 1);
  });
  check('空样本频率/均值为空，冷热为unavailable', () => {
    const empty = calculateNumberStatistics([], 'red');
    assert.equal(empty.length, 33);
    assert.ok(empty.every((item) => item.appearanceRate === null && item.averageCompleteOmission === null && item.heatLabel === 'unavailable'));
  });
  check('并列相同频次不强制拆成冷热号码', () => {
    const uniformBlueDraws = Array.from({ length: 16 }, (_, index) => ({ ...sampleDraws[0], blueBall: index + 1 }));
    assert.ok(calculateNumberStatistics(uniformBlueDraws, 'blue').every((item) => item.heatLabel === 'normal'));
  });
  check('六球全连：一组五对，和值21、跨度5、AC=0', () => {
    const feature = calculateDrawFeatures(sampleDraws[0], null);
    assert.equal(feature.consecutiveGroupCount, 1);
    assert.equal(feature.consecutivePairCount, 5);
    assert.equal(feature.redSum, 21);
    assert.equal(feature.redSpan, 5);
    assert.equal(feature.acValue, 0);
    assert.equal(feature.repeatedRedCount, null);
    assert.equal(feature.blueAmplitude, null);
  });
  check('三球连号算一组两对，两段连号算两组', () => {
    const feature = calculateDrawFeatures({ ...sampleDraws[0], redBalls: [1, 2, 3, 10, 11, 20] }, sampleDraws[0]);
    assert.equal(feature.consecutiveGroupCount, 2);
    assert.equal(feature.consecutivePairCount, 3);
    assert.equal(feature.repeatedRedCount, 3);
  });
}

function verifyCacheAndCutoff(): void {
  const database = openDatabase(':memory:');
  try {
    applyPendingMigrations(database);
    check('空库报告仍返回完整号码表，样本数0', () => {
      const report = getBasicAnalysis(database);
      assert.equal(report.sampleDrawCount, 0);
      assert.equal(report.features.length, 0);
    });
    const rawItems = sampleDraws.map((draw) => ({
      code: draw.issue, date: draw.drawDate, red: draw.redBalls.join(','), blue: String(draw.blueBall),
    }));
    saveDraws(database, parseRawDrawItems(rawItems, null).validDraws);
    const initial = getBasicAnalysis(database);
    check('重复请求命中缓存，返回对象及数组递归冻结', () => {
      assert.equal(initial, getBasicAnalysis(database));
      assert.ok(Object.isFrozen(initial) && Object.isFrozen(initial.redNumbers) && Object.isFrozen(initial.redNumbers[0]));
    });
    check('窗口第一期仍可读取窗口外的紧邻上期', () => {
      const report = getBasicAnalysis(database, { window: 1 });
      assert.equal(report.firstIssue, '2026006');
      assert.equal(report.features[0].repeatedRedCount, 0);
      assert.equal(report.features[0].blueAmplitude, 2);
    });
    const historical = getBasicAnalysis(database, { asOfIssue: '2026003' });
    saveDraws(database, parseRawDrawItems([{
      code: '2026007', date: '2026-01-07', red: '1,2,3,4,5,6', blue: '1',
    }], null).validDraws);
    check('新增开奖使当前缓存失效并更新频次', () => {
      const changed = getBasicAnalysis(database);
      assert.notEqual(changed, initial);
      assert.equal(changed.sampleDrawCount, 7);
      assert.equal(changed.redNumbers[0].appearanceCount, 4);
    });
    check('未来数据新增不影响历史截止统计及其缓存', () => {
      assert.equal(historical, getBasicAnalysis(database, { asOfIssue: '2026003' }));
      assert.equal(historical.sampleDrawCount, 3);
      assert.equal(historical.lastIssue, '2026003');
    });
    const beforeCorrection = getBasicAnalysis(database);
    database.prepare("UPDATE draws SET blue_ball = 2 WHERE issue = '2026007'").run();
    check('期数和最新期号不变，号码修正仍使缓存失效', () => {
      const changed = getBasicAnalysis(database);
      assert.notEqual(changed.dataFingerprint, beforeCorrection.dataFingerprint);
      assert.equal(changed.blueNumbers[1].appearanceCount, 2);
    });
    database.prepare("DELETE FROM draws WHERE issue = '2026005'").run();
    check('缺期使缓存失效，跨缺口重号及振幅不伪装为上期指标', () => {
      const changed = getBasicAnalysis(database);
      assert.equal(changed.sampleDrawCount, 6);
      assert.equal(changed.features.find((item) => item.issue === '2026006')?.repeatedRedCount, null);
      assert.equal(changed.features.find((item) => item.issue === '2026006')?.blueAmplitude, null);
      assert.ok(changed.warnings.some((warning) => warning.includes('期号不相邻')));
    });
    check('窗口大于样本返回实际数量，非法窗口/期号拒绝', () => {
      assert.equal(getBasicAnalysis(database, { window: 100 }).sampleDrawCount, 6);
      assert.throws(() => getBasicAnalysis(database, { window: 0 }));
      assert.throws(() => getBasicAnalysis(database, { window: 1.5 }));
      assert.throws(() => getBasicAnalysis(database, { asOfIssue: 'invalid' }));
    });
  } finally {
    database.close();
  }
}

function verifyRealDatabase(): void {
  const database = getDatabase();
  for (const window of [null, 30, 100, 300]) {
    const report = getBasicAnalysis(database, { window });
    assert.ok(report.sampleDrawCount > 0, '正式库没有数据，请先全量导入');
    // 独立 SQL 直接将6个红球列转成单列，不复用统计模块的计数算法。
    const frequencies = database.prepare(`
      WITH sample AS (SELECT * FROM draws WHERE issue >= ? AND issue <= ?),
      red_numbers AS (
        SELECT red_ball_1 AS number FROM sample UNION ALL SELECT red_ball_2 FROM sample
        UNION ALL SELECT red_ball_3 FROM sample UNION ALL SELECT red_ball_4 FROM sample
        UNION ALL SELECT red_ball_5 FROM sample UNION ALL SELECT red_ball_6 FROM sample
      ) SELECT number, COUNT(*) AS count FROM red_numbers GROUP BY number
    `).all(report.firstIssue, report.lastIssue) as Array<{ number: number; count: number }>;
    check(`真实窗口${window ?? '全量'}：33个红球频次与独立SQL一致，总频次=6×期数`, () => {
      for (const row of frequencies) assert.equal(report.redNumbers[row.number - 1].appearanceCount, row.count);
      assert.equal(report.redNumbers.reduce((sum, item) => sum + item.appearanceCount, 0), 6 * report.sampleDrawCount);
    });
    const blueFrequencies = database.prepare(`
      SELECT blue_ball AS number, COUNT(*) AS count FROM draws
      WHERE issue >= ? AND issue <= ? GROUP BY blue_ball
    `).all(report.firstIssue, report.lastIssue) as Array<{ number: number; count: number }>;
    check(`真实窗口${window ?? '全量'}：蓝球频次与SQL一致，特征分布总数正确`, () => {
      for (const row of blueFrequencies) assert.equal(report.blueNumbers[row.number - 1].appearanceCount, row.count);
      assert.equal(report.blueNumbers.reduce((sum, item) => sum + item.appearanceCount, 0), report.sampleDrawCount);
      assert.equal(Object.values(report.featureDistributions.redSum).reduce((sum, count) => sum + count, 0), report.sampleDrawCount);
    });
  }
  const latest = getBasicAnalysis(database).features.find((item) => item.issue === '2026124');
  const draw = findDrawByIssue(database, '2026124');
  assert.ok(latest && draw, '用于手算抽查的2026124期不存在');
  check('真实2026124：和值105、跨度26、奇偶5:1、大小2:4、分区2:2:2', () => {
    assert.deepEqual(draw.redBalls, [3, 11, 17, 22, 23, 29]);
    assert.equal(latest.redSum, 105);
    assert.equal(latest.redSpan, 26);
    assert.equal(latest.redOddCount, 5);
    assert.equal(latest.redEvenCount, 1);
    assert.equal(latest.redSmallCount, 2);
    assert.equal(latest.redLargeCount, 4);
    assert.deepEqual(latest.redZoneCounts, [2, 2, 2]);
  });
  check('真实2026124：连号22/23、AC=7、上期重号0、蓝球振幅3', () => {
    assert.equal(latest.consecutiveGroupCount, 1);
    assert.equal(latest.consecutivePairCount, 1);
    assert.equal(latest.acValue, 7);
    assert.equal(latest.repeatedRedCount, 0);
    assert.equal(latest.blueAmplitude, 3);
    assert.deepEqual(latest.redTailCounts, [0, 1, 1, 2, 0, 0, 0, 1, 0, 1]);
  });
  check('真实截止2026123不包含2026124，红球1最近遗漏可用SQL独立核对', () => {
    const report = getBasicAnalysis(database, { window: 30, asOfIssue: '2026123' });
    assert.equal(report.lastIssue, '2026123');
    assert.ok(report.features.every((item) => item.issue <= '2026123'));
    const rows = database.prepare(`SELECT issue FROM draws WHERE issue >= ? AND issue <= ?
      AND 1 IN (red_ball_1,red_ball_2,red_ball_3,red_ball_4,red_ball_5,red_ball_6) ORDER BY issue`)
      .all(report.firstIssue, report.lastIssue) as Array<{ issue: string }>;
    const lastIssue = rows[rows.length - 1]?.issue;
    const expectedGap = lastIssue === undefined ? report.sampleDrawCount :
      (database.prepare('SELECT COUNT(*) AS count FROM draws WHERE issue > ? AND issue <= ?').get(lastIssue, report.lastIssue) as { count: number }).count;
    assert.equal(report.redNumbers[0].currentOmission, expectedGap);
  });
}

try {
  verifyHandCalculatedStatistics();
  verifyCacheAndCutoff();
  verifyRealDatabase();
  console.log(`\n基础统计验收：${checkCount} 项全部通过。`);
} catch (error) {
  console.error('基础统计验收失败：', error);
  process.exitCode = 1;
} finally {
  closeDatabase();
}