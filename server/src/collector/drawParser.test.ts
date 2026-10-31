/**
 * 开奖记录解析与校验测试（号码校验是全系统的数据基础，必须有测试兜底）
 */
import { describe, expect, it } from 'vitest';
import type { CwlDrawNoticeItemRaw } from './cwlApiTypes';
import { parseDrawNoticeItem } from './drawParser';

/** 构造一条合法的原始记录；奖金数值为测试数据，非真实开奖结果 */
function buildValidRawItem(overrides: Partial<CwlDrawNoticeItemRaw> = {}): CwlDrawNoticeItemRaw {
  return {
    name: '双色球',
    code: '2026124',
    date: '2026-10-29(四)',
    red: '22,03,29,11,17,23',
    blue: '09',
    sales: '346568144',
    poolmoney: '1075698427',
    content: '江苏1注，共1注。',
    prizegrades: [
      { type: 1, typenum: '8', typemoney: '5000000' },
      { type: 2, typenum: '120', typemoney: '200000' },
      { type: 3, typenum: '1500', typemoney: '3000' },
      { type: 4, typenum: '80000', typemoney: '200' },
      { type: 5, typenum: '1600000', typemoney: '10' },
      { type: 6, typenum: '9000000', typemoney: '5' },
    ],
    ...overrides,
  };
}

/** 解析并断言无效，返回错误原因 */
function expectInvalid(rawItem: CwlDrawNoticeItemRaw): string[] {
  const parseResult = parseDrawNoticeItem(rawItem);
  expect(parseResult.isValid).toBe(false);
  return parseResult.isValid ? [] : parseResult.errors;
}

describe('parseDrawNoticeItem 合法记录', () => {
  it.each(['5250000（含加奖250000）', '5250000（含派奖250000）'])('历史奖金 %s 读取总金额，不重复相加', (prizeText) => {
    const parseResult = parseDrawNoticeItem(buildValidRawItem({
      prizegrades: [{ type: 1, typenum: '20', typemoney: prizeText }],
    }));
    expect(parseResult.isValid).toBe(true);
    if (parseResult.isValid) {
      expect(parseResult.draw.prizeGrades[0].prizePerTicketYuan).toBe(5250000);
    }
  });

  it('正确解析各字段，红球升序，奖级明细完整', () => {
    const parseResult = parseDrawNoticeItem(buildValidRawItem());
    expect(parseResult.isValid).toBe(true);
    if (!parseResult.isValid) return;

    const { draw } = parseResult;
    expect(draw.issue).toBe('2026124');
    expect(draw.drawDate).toBe('2026-10-29');
    expect(draw.redBalls).toEqual([3, 11, 17, 22, 23, 29]);
    expect(draw.blueBall).toBe(9);
    expect(draw.salesAmountYuan).toBe(346568144);
    expect(draw.prizeGrades).toHaveLength(6);
    expect(draw.isPrizeDetailComplete).toBe(true);
  });

  it('奖级注数未公布时记录仍有效，但标记为不完整；空金额视为未公布', () => {
    const parseResult = parseDrawNoticeItem(
      buildValidRawItem({ sales: '', poolmoney: '', prizegrades: [{ type: 1, typenum: '', typemoney: '' }] }),
    );
    expect(parseResult.isValid).toBe(true);
    if (!parseResult.isValid) return;
    expect(parseResult.draw.salesAmountYuan).toBeNull();
    expect(parseResult.draw.isPrizeDetailComplete).toBe(false);
  });
});

describe('parseDrawNoticeItem 号码校验', () => {
  it.each([
    ['红球超出 33', { red: '03,11,17,22,23,34' }],
    ['红球为 0', { red: '00,11,17,22,23,29' }],
    ['红球重复', { red: '03,03,17,22,23,29' }],
    ['红球只有 5 个', { red: '03,11,17,22,23' }],
    ['红球含非数字', { red: '03,11,17,22,23,ab' }],
    ['红球为空', { red: '' }],
    ['蓝球超出 16', { blue: '17' }],
    ['蓝球为 0', { blue: '00' }],
    ['蓝球有 2 个', { blue: '09,10' }],
  ])('%s → 无效', (_caseName, overrides) => {
    expect(expectInvalid(buildValidRawItem(overrides)).length).toBeGreaterThan(0);
  });
});

describe('parseDrawNoticeItem 期号与日期校验', () => {
  it.each([
    ['期号不是 7 位', { code: '26124' }],
    ['期号早于 2003 年', { code: '2002001' }],
    ['期号序号为 000', { code: '2026000' }],
    ['日期不存在', { date: '2026-02-30(一)' }],
    ['日期格式错误', { date: '20261029' }],
    ['期号年份与日期年份不一致', { code: '2025124' }],
    ['销售额不是数字', { sales: '约3亿' }],
  ])('%s → 无效', (_caseName, overrides) => {
    expect(expectInvalid(buildValidRawItem(overrides)).length).toBeGreaterThan(0);
  });

  it('多项错误同时存在时全部报告', () => {
    const errors = expectInvalid(buildValidRawItem({ red: '03,11', blue: '17' }));
    expect(errors.length).toBe(2);
  });
});
