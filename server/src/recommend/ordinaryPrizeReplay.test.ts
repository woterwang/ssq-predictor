/** 仅手造内存数据，验证常规回放与旧严格审计的边界，不导入配置或数据库。 */
import { describe, expect, it } from 'vitest';
import type { BacktestDraw, LotteryTicket } from '../backtest/backtestTypes';
import { buildDrawPayoutPolicy, determinePrizeGrade } from '../backtest/prizeRules';
import {
  buildOrdinaryPrizeReplay, ORDINARY_REPLAY_DEFINITION_VERSION, ORDINARY_REPLAY_LIMITATIONS,
} from './ordinaryPrizeReplay';

const ordinaryGrades = [1, 2, 3, 4, 5, 6] as const;
const winningTicket: LotteryTicket = { redBalls: [1, 2, 3, 4, 5, 6], blueBall: 1 };
const losingTicket: LotteryTicket = { redBalls: [7, 8, 9, 10, 11, 12], blueBall: 2 };

function drawFixture(issue = '2026100', raw: Record<string, unknown> = { code: issue }): BacktestDraw {
  return {
    issue, drawDate: '2026-09-01', redBalls: [1, 2, 3, 4, 5, 6], blueBall: 1,
    prizeGrades: [5000000, 100000, 3000, 200, 10, 5].map((prizePerTicketYuan, index) => ({
      grade: index + 1, winningTicketCount: 1, prizePerTicketYuan,
    })),
    rawRecordJson: JSON.stringify(raw),
  };
}

/** 即使有未中奖票、中奖票或根本没有票，也必须先通过相同的整期审计。 */
function expectPeriodWithheld(draw: BacktestDraw): void {
  for (const tickets of [[losingTicket], [winningTicket, losingTicket], []]) {
    const replay = buildOrdinaryPrizeReplay(draw, tickets);
    expect(replay.eligible).toBe(false);
    expect(replay.withheldReasons.length).toBeGreaterThan(0);
    expect(replay.announcedPrizeReplayYuan).toBeNull();
    expect(replay.outcomes.every(outcome => outcome.prizeYuan === null)).toBe(true);
    expect(replay.costYuan).toBe(tickets.length * 2);
  }
}

describe('常规回放版本及说明', () => {
  it('接口版本固定，常规完整公告可以回放，但不声称完整收益', () => {
    const replay = buildOrdinaryPrizeReplay(drawFixture(), [winningTicket]);
    expect(ORDINARY_REPLAY_DEFINITION_VERSION).toBe('ordinary-prize-replay-v1');
    expect(replay).toMatchObject({ definitionVersion: ORDINARY_REPLAY_DEFINITION_VERSION,
      eligible: true, hasUnverifiedActivity: false, withheldReasons: [], costYuan: 2,
      announcedPrizeReplayYuan: 5000000 });
    expect(replay.warnings).toEqual(ORDINARY_REPLAY_LIMITATIONS);
    expect(ORDINARY_REPLAY_LIMITATIONS.join()).toMatch(/常规1–6奖级.*税前/);
    expect(ORDINARY_REPLAY_LIMITATIONS.join()).toMatch(/排除.*加奖.*派奖.*福运奖/);
    expect(ORDINARY_REPLAY_LIMITATIONS.join()).toMatch(/不代表活动资格已核实.*实际兑奖.*完整收益/);
    expect(ORDINARY_REPLAY_LIMITATIONS.join()).toMatch(/税费.*稀释.*不提供正式ROI/);
    expect(buildDrawPayoutPolicy(drawFixture()).eligible).toBe(true);
  });

  it('空票仍审计整期，完整公告的费用及汇总均为0', () => {
    expect(buildOrdinaryPrizeReplay(drawFixture(), [])).toMatchObject({
      eligible: true, costYuan: 0, announcedPrizeReplayYuan: 0, outcomes: [],
    });
  });
});

describe('加奖、派奖仅标记与混入金额阻止的区别', () => {
  it.each(['addmoney', 'addmoney2', 'z2add', 'm2add'])('%s非零不阻止常规回放，旧严格规则仍阻止', field => {
    for (const value of ['100', 100]) {
      const draw = drawFixture('2026100', { [field]: value });
      const replay = buildOrdinaryPrizeReplay(draw, [winningTicket]);
      expect(replay).toMatchObject({ eligible: true, hasUnverifiedActivity: true,
        withheldReasons: [], announcedPrizeReplayYuan: 5000000 });
      expect(replay.warnings.join()).toContain(field);
      expect(replay.warnings.join()).toContain('活动资格未核实');
      expect(buildDrawPayoutPolicy(draw).eligible).toBe(false);
    }
  });

  it.each(['addmoney', 'addmoney2', 'z2add', 'm2add'])('%s的0及其他非空值也仅标记，不能当作空字段', field => {
    for (const value of [0, '0', false, -1, '待核实']) {
      const draw = drawFixture('2026100', { [field]: value });
      expect(buildOrdinaryPrizeReplay(draw, [losingTicket])).toMatchObject({
        eligible: true, hasUnverifiedActivity: true, announcedPrizeReplayYuan: 0,
      });
      expect(buildDrawPayoutPolicy(draw).eligible).toBe(false);
    }
  });

  it.each(['addmoney', 'addmoney2', 'z2add', 'm2add'])('%s为空不标记活动', field => {
    for (const value of [undefined, null, '', ' \t ']) {
      const draw = drawFixture('2026100', { code: '2026100', [field]: value });
      expect(buildOrdinaryPrizeReplay(draw, [])).toMatchObject({ eligible: true, hasUnverifiedActivity: false });
    }
  });

  it('只读顶层活动金额字段，不把同名嵌套字段当作活动标记', () => {
    const draw = drawFixture('2026100', { nested: { addmoney: '100', fyjMoney: '5' } });
    expect(buildOrdinaryPrizeReplay(draw, [])).toMatchObject({ eligible: true, hasUnverifiedActivity: false });
  });

  it.each(['含加奖', '含派奖'])('全文任何位置的%s均阻止，不能擅自减去额外金额', text => {
    const draw = drawFixture('2026100', { nested: { annotation: `5250000（${text}250000）` }, addmoney: '250000' });
    expectPeriodWithheld(draw);
    const replay = buildOrdinaryPrizeReplay(draw, [winningTicket]);
    expect(replay.hasUnverifiedActivity).toBe(true);
    expect(replay.withheldReasons.join()).toMatch(/不能确认公告金额是否混入.*不擅自扣除/);
    expect(buildDrawPayoutPolicy(draw).eligible).toBe(false);
  });

  it('坏JSON仍检查全文的活动文字', () => {
    const draw = drawFixture();
    draw.rawRecordJson = '{"annotation":"含派奖"';
    const replay = buildOrdinaryPrizeReplay(draw, []);
    expect(replay).toMatchObject({ eligible: false, hasUnverifiedActivity: true, announcedPrizeReplayYuan: null });
    expect(replay.withheldReasons).toHaveLength(2);
  });
});

describe('原始公告须为非空JSON对象', () => {
  it.each(['', ' \t ', '{', '[', '{}', ' { } ', 'null', '[]', '[{}]', '"公告"', '0', 'false', 'true'])(
    '空、坏或非对象原文整期阻止：%j', rawRecordJson => {
      const draw = drawFixture();
      draw.rawRecordJson = rawRecordJson;
      expectPeriodWithheld(draw);
      expect(buildOrdinaryPrizeReplay(draw, []).withheldReasons.join()).toContain('原始公告');
    },
  );
});

describe.each(ordinaryGrades)('第%i奖级必须整期审计，不按票的命中情况挑选', grade => {
  it('缺失时整期阻止', () => {
    const draw = drawFixture();
    draw.prizeGrades = draw.prizeGrades.filter(detail => detail.grade !== grade);
    expectPeriodWithheld(draw);
    expect(buildOrdinaryPrizeReplay(draw, []).withheldReasons.join()).toContain(`第${grade}奖级`);
  });

  it('重复时整期阻止，即使金额相同', () => {
    const draw = drawFixture();
    draw.prizeGrades.push({ ...draw.prizeGrades[grade - 1] });
    expectPeriodWithheld(draw);
  });

  it.each([
    ['零值', 0], ['负值', -1], ['非整数', 1.5], ['不安全整数', Number.MAX_SAFE_INTEGER + 1],
    ['空值', null], ['非数字', NaN], ['无穷大', Infinity],
  ] as const)('%s金额整期阻止', (_label, amount) => {
    const draw = drawFixture();
    draw.prizeGrades[grade - 1].prizePerTicketYuan = amount;
    expectPeriodWithheld(draw);
  });
});

describe('福运奖明确排除，不套用严格资格审计', () => {
  const threeRedWrongBlue: LotteryTicket = { redBalls: [1, 2, 3, 7, 8, 9], blueBall: 2 };

  it.each(['2026014', '2026050', '2026075'])('核实窗口%s的3红错蓝：常规none为0，旧规则为fortune', issue => {
    const draw = drawFixture(issue, { fyjMoney: '5' });
    const replay = buildOrdinaryPrizeReplay(draw, [threeRedWrongBlue]);
    expect(replay).toMatchObject({ eligible: true, hasUnverifiedActivity: true, announcedPrizeReplayYuan: 0,
      outcomes: [{ redHits: 3, blueHit: false, grade: 'none', prizeYuan: 0 }] });
    expect(replay.warnings.join()).toContain('排除福运奖');
    const strict = buildDrawPayoutPolicy(draw);
    expect(strict).toMatchObject({ eligible: true, fortuneActive: true, amounts: { fortune: 5 } });
    expect(determinePrizeGrade(3, false, strict.fortuneActive)).toBe('fortune');
  });

  it.each(['2026014', '2026075'])('窗口%s即使无fyjMoney也不阻止常规金额', issue => {
    const draw = drawFixture(issue);
    expect(buildOrdinaryPrizeReplay(draw, [threeRedWrongBlue])).toMatchObject({
      eligible: true, hasUnverifiedActivity: true, announcedPrizeReplayYuan: 0,
    });
    expect(buildDrawPayoutPolicy(draw).eligible).toBe(false);
  });

  it.each(['2026013', '2026076'])('窗口外%s没有福运字段不标记活动', issue => {
    expect(buildOrdinaryPrizeReplay(drawFixture(issue), [threeRedWrongBlue])).toMatchObject({
      eligible: true, hasUnverifiedActivity: false, announcedPrizeReplayYuan: 0,
    });
  });

  it.each(['5', 0, '0', '待核实'])('窗口外非空fyjMoney=%j仅警告，不复用严格资格', fyjMoney => {
    const draw = drawFixture('2026076', { fyjMoney });
    const replay = buildOrdinaryPrizeReplay(draw, [threeRedWrongBlue]);
    expect(replay).toMatchObject({ eligible: true, hasUnverifiedActivity: true, announcedPrizeReplayYuan: 0 });
    expect(replay.warnings.join()).toContain('fyjMoney');
  });

  it.each([null, '', ' \t '])('窗口外空fyjMoney=%j不标记活动', fyjMoney => {
    expect(buildOrdinaryPrizeReplay(drawFixture('2026076', { fyjMoney }), [])).toMatchObject({
      eligible: true, hasUnverifiedActivity: false,
    });
  });
});

describe('判级、费用、逐注金额与纯函数约束', () => {
  const amountsWithoutBlue = [0, 0, 0, 0, 10, 200, 100000];
  const amountsWithBlue = [5, 5, 5, 10, 200, 3000, 5000000];
  const gradesWithoutBlue = ['none', 'none', 'none', 'none', 5, 4, 2];
  const gradesWithBlue = [6, 6, 6, 5, 4, 3, 1];

  it.each([0, 1, 2, 3, 4, 5, 6])('%i红在中蓝/错蓝时均按常规最高奖级回放', redHits => {
    const redBalls = [...[1, 2, 3, 4, 5, 6].slice(0, redHits), ...[7, 8, 9, 10, 11, 12].slice(redHits)];
    const replay = buildOrdinaryPrizeReplay(drawFixture(), [{ redBalls, blueBall: 2 }, { redBalls, blueBall: 1 }]);
    expect(replay.outcomes).toEqual([
      { redHits, blueHit: false, grade: gradesWithoutBlue[redHits], prizeYuan: amountsWithoutBlue[redHits] },
      { redHits, blueHit: true, grade: gradesWithBlue[redHits], prizeYuan: amountsWithBlue[redHits] },
    ]);
  });

  it('手算14种命中组合及重复票：费用30元、奖金10103435元，与逐注汇总一致', () => {
    const tickets: LotteryTicket[] = [];
    for (let redHits = 0; redHits <= 6; redHits++) {
      const redBalls = [...[1, 2, 3, 4, 5, 6].slice(0, redHits), ...[7, 8, 9, 10, 11, 12].slice(redHits)];
      tickets.push({ redBalls, blueBall: 2 }, { redBalls, blueBall: 1 });
    }
    tickets.push(winningTicket);
    // 0+0+0+0+10+200+100000 + 5+5+5+10+200+3000+5000000 + 5000000。
    const replay = buildOrdinaryPrizeReplay(drawFixture(), tickets);
    expect(replay.costYuan).toBe(30);
    expect(replay.announcedPrizeReplayYuan).toBe(10103435);
    expect(replay.announcedPrizeReplayYuan).toBe(replay.outcomes.reduce((sum, outcome) => sum + (outcome.prizeYuan ?? 0), 0));
  });

  it('不改动开奖、只读票数组或常量；重复调用没有共享结果状态', () => {
    const draw = drawFixture('2026100', { addmoney: '100' });
    Object.freeze(draw.redBalls);
    for (const detail of draw.prizeGrades) Object.freeze(detail);
    Object.freeze(draw.prizeGrades);
    Object.freeze(draw);
    const ticket: LotteryTicket = Object.freeze({ redBalls: Object.freeze([1, 2, 3, 4, 5, 6]), blueBall: 1 });
    const tickets: readonly LotteryTicket[] = Object.freeze([ticket]);
    const before = JSON.stringify({ draw, tickets });
    const first = buildOrdinaryPrizeReplay(draw, tickets);
    const second = buildOrdinaryPrizeReplay(draw, tickets);
    expect(first).toEqual(second);
    expect(JSON.stringify({ draw, tickets })).toBe(before);
    first.warnings.push('调用方的本地说明');
    first.outcomes[0].prizeYuan = -1;
    expect(second.outcomes[0].prizeYuan).toBe(5000000);
    expect(second.warnings).not.toContain('调用方的本地说明');
    expect(ORDINARY_REPLAY_LIMITATIONS).not.toContain('调用方的本地说明');
  });
});

describe('拒绝非法票及非法开奖号', () => {
  const invalidTickets: LotteryTicket[] = [
    { redBalls: [1, 2, 3, 4, 5], blueBall: 1 },
    { redBalls: [1, 2, 3, 4, 5, 6, 7], blueBall: 1 },
    { redBalls: [1, 1, 2, 3, 4, 5], blueBall: 1 },
    ...[0, 34, 1.5, NaN, Infinity].map(ball => ({ redBalls: [ball, 2, 3, 4, 5, 6], blueBall: 1 })),
    ...[0, 17, 1.5, NaN, Infinity].map(blueBall => ({ redBalls: [1, 2, 3, 4, 5, 6], blueBall })),
  ];

  it.each(invalidTickets)('非法投注号码拒绝：%j', ticket => {
    expect(() => buildOrdinaryPrizeReplay(drawFixture(), [winningTicket, ticket])).toThrow(/单式票须为/);
  });

  it.each(invalidTickets)('非法开奖号即使空票也拒绝：%j', ticket => {
    const draw = { ...drawFixture(), redBalls: [...ticket.redBalls], blueBall: ticket.blueBall };
    expect(() => buildOrdinaryPrizeReplay(draw, [])).toThrow(/单式票须为/);
  });
});