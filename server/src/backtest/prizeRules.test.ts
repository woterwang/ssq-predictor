/** 奖级命中矩阵及奖金边界：用全14种命中状态覆盖优先级。 */
import { describe, expect, it } from 'vitest';
import { assertLegalTicket, buildDrawPayoutPolicy, determinePrizeGrade } from './prizeRules';
import type { BacktestDraw } from './backtestTypes';

function drawFixture(issue = '2026100', raw: Record<string, unknown> = { code: issue }): BacktestDraw {
  return { issue, drawDate: '2026-09-01', redBalls: [1, 2, 3, 4, 5, 6], blueBall: 1,
    prizeGrades: [5000000, 100000, 3000, 200, 10, 5].map((prizePerTicketYuan, index) => ({ grade: index + 1, winningTicketCount: 1, prizePerTicketYuan })),
    rawRecordJson: JSON.stringify(raw) };
}

describe('常规及福运奖命中矩阵', () => {
  const withoutBlue = ['none', 'none', 'none', 'none', 5, 4, 2];
  const withBlue = [6, 6, 6, 5, 4, 3, 1];
  for (let hits = 0; hits <= 6; hits++) {
    it(`${hits}红错蓝的普通奖级`, () => expect(determinePrizeGrade(hits, false, false)).toBe(withoutBlue[hits]));
    it(`${hits}红中蓝最高奖级不叠加福运奖`, () => expect(determinePrizeGrade(hits, true, true)).toBe(withBlue[hits]));
  }
  it('福运奖仅3红错蓝，4红仍五等奖', () => {
    expect(determinePrizeGrade(3, false, true)).toBe('fortune');
    expect(determinePrizeGrade(4, false, true)).toBe(5);
  });
  it('拒绝非法命中数与非法票', () => {
    expect(() => determinePrizeGrade(7, true, true)).toThrow();
    expect(() => assertLegalTicket({ redBalls: [1, 1, 2, 3, 4, 5], blueBall: 1 })).toThrow();
    expect(() => assertLegalTicket({ redBalls: [1, 2, 3, 4, 5, 34], blueBall: 1 })).toThrow();
    expect(() => assertLegalTicket({ redBalls: [1, 2, 3, 4, 5, 6], blueBall: 17 })).toThrow();
  });
});

describe('收益整期审计', () => {
  it('常规完整原文可以作税前公告回放', () => expect(buildDrawPayoutPolicy(drawFixture()).eligible).toBe(true));
  it('福运奖窗口首尾生效，停止期失效', () => {
    for (const issue of ['2026014', '2026075']) {
      const policy = buildDrawPayoutPolicy(drawFixture(issue, { fyjMoney: '5' }));
      expect(policy.eligible).toBe(true); expect(policy.fortuneActive).toBe(true); expect(policy.amounts.fortune).toBe(5);
    }
    expect(buildDrawPayoutPolicy(drawFixture('2026076')).fortuneActive).toBe(false);
  });
  it('窗口内缺奖金及窗口外特殊字段暂停收益', () => {
    expect(buildDrawPayoutPolicy(drawFixture('2026014')).eligible).toBe(false);
    expect(buildDrawPayoutPolicy(drawFixture('2026076', { fyjMoney: '5' })).eligible).toBe(false);
  });
  it('含加奖/含派奖或额外派奖字段暂停整期，不套奖金', () => {
    for (const raw of [{ annotation: '5250000（含加奖250000）' }, { annotation: '含派奖833333' }, { addmoney: '100' }, { z2add: '30' }]) {
      const policy = buildDrawPayoutPolicy(drawFixture('2026100', raw));
      expect(policy.eligible).toBe(false); expect(policy.withheldReasons.join()).toContain('资格未核实');
    }
  });
  it('缺失/为零浮动奖奖金、重复奖级不能按0收益放行', () => {
    const draw = drawFixture(); draw.prizeGrades[0].prizePerTicketYuan = 0;
    expect(buildDrawPayoutPolicy(draw).eligible).toBe(false);
    draw.prizeGrades[0].prizePerTicketYuan = null;
    expect(buildDrawPayoutPolicy(draw).eligible).toBe(false);
    draw.prizeGrades.push({ ...draw.prizeGrades[1] });
    expect(buildDrawPayoutPolicy(draw).eligible).toBe(false);
  });
  it('无原始公告/错误JSON不能声称已核实收益', () => {
    expect(buildDrawPayoutPolicy(drawFixture('2026100', {})).eligible).toBe(false);
    const draw = drawFixture(); draw.rawRecordJson = '[';
    expect(buildDrawPayoutPolicy(draw).eligible).toBe(false);
  });
});