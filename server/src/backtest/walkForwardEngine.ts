/**
 * 严格按期滚动：预测先执行并复制/冻结，再读取目标开奖号评分。
 * 模型接口只传目标期号和此前号码历史；不传整库、不传目标奖金/销售额。
 * 这是接口隔离而非恶意代码沙箱：策略不得自行读库或通过闭包偷看未来。
 */
import { createHash } from 'node:crypto';
import type { AnalysisDraw } from '../analysis/analysisTypes';
import { createResearchRandom, packAnalysisDraws, RANDOM_ALGORITHM } from '../analysis/researchRandom';
import type { BacktestDraw, BacktestOptions, BacktestReport, BacktestStrategy, ModelPrediction, PeriodDetail, RepetitionMetrics } from './backtestTypes';
import { buildDrawPayoutPolicy, countTicketHits, determinePrizeGrade, PRIZE_GRADES, PRIZE_RULE_VERSION, TICKET_PRICE_YUAN } from './prizeRules';
import { assertLegalPrediction, firstRunTailProbability, scoreProbabilities, summarizeDistribution } from './metrics';
import { FINAL_HOLDOUT_START_ISSUE } from './holdoutPolicy';

export function assertValidBacktestOptions(options: BacktestOptions): void {
  for (const issue of [options.startIssue, options.endIssue]) {
    if (!/^\d{7}$/.test(issue) || issue.endsWith('000')) throw new Error('评估期号须为有效7位期号');
  }
  if (options.startIssue > options.endIssue) throw new Error('评估起期不能大于止期');
  for (const [name, value, maximum] of [
    ['ticketsPerIssue', options.ticketsPerIssue, 1000], ['repetitions', options.repetitions, 10000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name}须为1–${maximum}整数`);
  }
  if (!Number.isSafeInteger(options.minimumHistory) || options.minimumHistory < 0) throw new Error('minimumHistory须为非负整数');
  createResearchRandom(options.seed);
}

/** 每个重复的种子独立派生；不依赖墙钟、进程状态或随机调用数。 */
export function deriveRepetitionSeed(seed: number, repetition: number): number {
  return createHash('sha256').update(`backtest-stream-v1:${seed}:${repetition}`).digest().readUInt32LE(0);
}

function freezePrediction(prediction: ModelPrediction): ModelPrediction {
  return Object.freeze({
    redProbabilities: Object.freeze([...prediction.redProbabilities]),
    blueProbabilities: Object.freeze([...prediction.blueProbabilities]),
    tickets: Object.freeze(prediction.tickets.map(ticket => Object.freeze({
      redBalls: Object.freeze([...ticket.redBalls].sort((a, b) => a - b)), blueBall: ticket.blueBall,
    }))),
  });
}

export function runWalkForwardBacktest(inputDraws: readonly BacktestDraw[], strategy: BacktestStrategy, options: BacktestOptions): BacktestReport {
  assertValidBacktestOptions(options);
  if (options.endIssue >= FINAL_HOLDOUT_START_ISSUE) throw new Error(`最终前瞻段${FINAL_HOLDOUT_START_ISSUE}起已锁定，本批禁止评估`);
  // 未来行先排除再校验/做指纹，未来开奖的改变不会影响历史回测。
  const draws: BacktestDraw[] = structuredClone(inputDraws.filter(draw => draw.issue <= options.endIssue));
  packAnalysisDraws(draws);
  const firstIndex = draws.findIndex(draw => draw.issue === options.startIssue);
  if (firstIndex < 0 || draws.at(-1)?.issue !== options.endIssue) throw new Error('评估起止期必须已入库，不静默缩短区间');
  if (firstIndex < options.minimumHistory) throw new Error(`起期前仅${firstIndex}条历史，少于minimumHistory=${options.minimumHistory}`);
  const evaluated = draws.slice(firstIndex);
  if (evaluated.length * options.ticketsPerIssue * options.repetitions > 20_000_000) throw new Error('单次回测超过2000万票上限，请缩小配置');

  // 一次构造所有不可变前缀，重复间复用，避免500次回测反复复制完整历史。
  const safeHistory: AnalysisDraw[] = draws.map(draw => Object.freeze({
    issue: draw.issue, drawDate: draw.drawDate, redBalls: Object.freeze([...draw.redBalls]), blueBall: draw.blueBall,
  }));
  const histories = evaluated.map((_, offset) => Object.freeze(safeHistory.slice(0, firstIndex + offset)));
  const payoutPolicies = evaluated.map(buildDrawPayoutPolicy);
  const withheldIssues = payoutPolicies.flatMap((policy, index) => policy.eligible ? [] : [{ issue: evaluated[index].issue, reasons: policy.withheldReasons }]);
  const summaries: RepetitionMetrics[] = [];
  const details: PeriodDetail[] = [];

  for (let repetition = 0; repetition < options.repetitions; repetition++) {
    const repetitionSeed = deriveRepetitionSeed(options.seed, repetition);
    const random = createResearchRandom(repetitionSeed);
    const predict = strategy.createPredictor();
    let redHitsTotal = 0, blueHitsTotal = 0;
    let redLogLoss = 0, redBrierScore = 0, blueLogLoss = 0, blueBrierScore = 0;
    let accountedPrizeYuan = 0, accountedCostYuan = 0;
    let cumulativeNet = 0, peakNet = 0, maximumDrawdown = 0;
    const prizeCounts = Object.fromEntries(PRIZE_GRADES.map(grade => [grade, 0])) as RepetitionMetrics['prizeCounts'];
    const accountedPrizeCounts = Object.fromEntries(PRIZE_GRADES.map(grade => [grade, 0])) as RepetitionMetrics['prizeCounts'];

    evaluated.forEach((draw, index) => {
      const context = Object.freeze({ targetIssue: draw.issue, history: histories[index], ticketsPerIssue: options.ticketsPerIssue, random });
      const predicted = predict(context);
      assertLegalPrediction(predicted, options.ticketsPerIssue);
      const prediction = freezePrediction(predicted);
      // 从这里开始才使用目标开奖号码、奖金。预测已不可改写。
      const actual = { redBalls: draw.redBalls, blueBall: draw.blueBall };
      const scores = scoreProbabilities(prediction, actual);
      redLogLoss += scores.redLogLoss; redBrierScore += scores.redBrierScore;
      blueLogLoss += scores.blueLogLoss; blueBrierScore += scores.blueBrierScore;
      const policy = payoutPolicies[index];
      let periodPrize = 0;
      const outcomes = prediction.tickets.map(ticket => {
        const hits = countTicketHits(ticket, actual);
        redHitsTotal += hits.redHits; blueHitsTotal += Number(hits.blueHit);
        const grade = determinePrizeGrade(hits.redHits, hits.blueHit, policy.fortuneActive);
        prizeCounts[grade]++;
        if (policy.eligible) accountedPrizeCounts[grade]++;
        const prizeYuan = policy.eligible ? policy.amounts[grade] ?? null : null;
        if (policy.eligible && prizeYuan === null) throw new Error(`奖级${grade}奖金未定义`);
        periodPrize += prizeYuan ?? 0;
        return { ...hits, grade, prizeYuan };
      });
      const cost = options.ticketsPerIssue * TICKET_PRICE_YUAN;
      if (policy.eligible) {
        accountedCostYuan += cost; accountedPrizeYuan += periodPrize;
        cumulativeNet += periodPrize - cost;
        peakNet = Math.max(peakNet, cumulativeNet);
        maximumDrawdown = Math.max(maximumDrawdown, peakNet - cumulativeNet);
      }
      if (repetition === 0) details.push({
        issue: draw.issue, historyCount: histories[index].length, historyEndIssue: histories[index].at(-1)?.issue ?? null,
        predictionHash: createHash('sha256').update(JSON.stringify(prediction)).digest('hex'), prediction, actual,
        outcomes, costYuan: cost, prizeYuan: policy.eligible ? periodPrize : null, ...scores,
      });
    });
    const totalTickets = evaluated.length * options.ticketsPerIssue;
    const subsetRoi = accountedCostYuan > 0 ? (accountedPrizeYuan - accountedCostYuan) / accountedCostYuan : null;
    summaries.push({
      repetition, seed: repetitionSeed, evaluatedIssues: evaluated.length, totalTickets,
      redLogLoss: redLogLoss / evaluated.length, redBrierScore: redBrierScore / evaluated.length,
      blueLogLoss: blueLogLoss / evaluated.length, blueBrierScore: blueBrierScore / evaluated.length,
      averageRedHits: redHitsTotal / totalTickets, blueHitRate: blueHitsTotal / totalTickets, prizeCounts, accountedPrizeCounts,
      totalCostYuan: totalTickets * TICKET_PRICE_YUAN, accountedCostYuan, accountedPrizeYuan,
      accountedSubsetRoi: subsetRoi, ordinaryReplayRoi: withheldIssues.length === 0 ? subsetRoi : null,
      formalRoi: null, maximumDrawdownYuan: withheldIssues.length === 0 ? maximumDrawdown : null,
    });
  }

  const metricNames = ['averageRedHits', 'blueHitRate', 'redLogLoss', 'redBrierScore', 'blueLogLoss', 'blueBrierScore', 'accountedPrizeYuan'] as const;
  const distributions = Object.fromEntries(metricNames.map(name => [name,
    summarizeDistribution(summaries.map(summary => summary[name]), name !== 'accountedPrizeYuan')]));
  const isM0 = strategy.name === 'M0_uniform_random';
  return {
    definitionVersion: `walk-forward-v1/${PRIZE_RULE_VERSION}`, strategy: { name: strategy.name, version: strategy.version, parameters: structuredClone(strategy.parameters) },
    options: { ...options }, randomAlgorithm: RANDOM_ALGORITHM,
    dataFingerprint: createHash('sha256').update(JSON.stringify(draws)).digest('hex'),
    coverage: { trainingFirstIssue: draws[0].issue, evaluationFirstIssue: evaluated[0].issue, evaluationLastIssue: evaluated.at(-1)!.issue, evaluatedIssues: evaluated.length },
    payoutAudit: { eligibleIssues: evaluated.length - withheldIssues.length, withheldIssues },
    repetitions: summaries, distributions,
    calibration: { theoreticalAverageRedHits: 36 / 33, theoreticalBlueHitRate: 1 / 16,
      firstRunRedTailP: isM0 ? firstRunTailProbability(summaries.map(summary => summary.averageRedHits), 36 / 33) : null,
      firstRunBlueTailP: isM0 ? firstRunTailProbability(summaries.map(summary => summary.blueHitRate), 1 / 16) : null },
    firstRepetitionDetails: details,
    limitations: [
      '历史仅覆盖2013年起；历史被多次查看，本报告为探索回放，不是未触碰的最终评估。',
      `${FINAL_HOLDOUT_START_ISSUE}起为锁定前瞻段，本批禁止运行，最终模型及评估长度仍须预登记。`,
      '红球loss/Brier按33个边际二元事件平均，蓝球loss按类别自然对数、Brier按16类求和；不是红球联合分布对数损失。',
      'log loss以1e-15裁剪0/1避免无穷；Brier使用原概率。概率不是有限推荐注中的号码频率。',
      '随机结果区间来自整段重复分布；MC均值近似区间仅反映随机种子误差，不是历史样本不确定性或策略优势。',
      '奖金分布保留中位数/极值/分位点，不提供重尾奖金均值的正态区间；偶发大奖可能严重拉高均值。',
      '首重复双侧MC尾概率仅校准M0框架，不是策略相对M0的优越性p值，不应据此挑选种子。',
      '收益按历史单注公告金额税前回放，不模拟增加中奖注数引起的浮动奖稀释，也不计税收或兑奖。',
      '活动标注/额外加奖字段及奖金缺失整期暂停核算；已核算子集ROI不代表全历史ROI，未发现标注不保证无活动。正式ROI仍为null。',
      '3红错蓝福运奖仅在已核实2026014–2026075窗口；普通最高奖级优先，不能叠加。',
      '模型只使用已有历史行；缺期不会填造数据。策略接口隔离不是沙箱，策略不得自行读取数据库或外部未来数据。',
      '所有重复均报告；奖金重尾分布尤其不能因偶发一等奖宣称有效。本单模型报告不包含参数搜索或跨模型优势判定。',
      '概率评分对应单注基础模型分布；多注去重或限制重叠后，后续票的条件抽样边际不同，不将两者混称。',
    ],
  };
}