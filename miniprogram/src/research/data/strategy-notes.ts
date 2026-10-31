/**
 * 版本化本地策略说明（strategy-notes-v1，2026-10-31）。
 * 参数抄自服务器第7批固定实现；比较数字为当日本地研究报告的静态摘录，不是实时接口结果。
 */
export const STRATEGY_NOTES_VERSION = 'strategy-notes-v1 · 2026-10-31';

export interface StrategyNote {
  code: string;
  name: string;
  status: string;
  statusTheme: 'success' | 'primary' | 'warning' | 'default';
  principle: string;
  parameters: string[];
  limitations: string[];
}

export const STRATEGIES: StrategyNote[] = [
  {
    code: 'M0', name: 'M0_uniform_random · 均匀随机', status: '当前透明随机基线', statusTheme: 'success',
    principle: '每注从33个红球中公平不放回抽6个、从16个蓝球中均匀抽1个；多注只拒绝整注完全重复。首页推荐只使用M0。',
    parameters: ['duplicateTickets = reject（整注去重）', 'structuralFilters = false（不做和值/奇偶等过滤）', '默认每期5注，服务器使用加密随机种子并固化'],
    limitations: ['不提高单注中奖概率；它是检验其他模型的公平参照。', '种子与哈希用于复核内容一致，不是第三方可信时间戳。'],
  },
  {
    code: 'M1', name: 'M1_smooth_frequency · 平滑频次', status: '历史探索对照', statusTheme: 'default',
    principle: '以最近300期出现次数加上相当于100期公平开奖的先验作为权重，按精确加权6元子集分布抽样。',
    parameters: ['window = 300', 'priorStrength = 100（红每号+100×6/33，蓝每号+100/16）', '最大红重叠 = 6，不加结构过滤'],
    limitations: ['历史频次不代表未来概率；第7批比较中四项概率评分均差于M0。'],
  },
  {
    code: 'M2', name: 'M2_time_decay · 时间衰减', status: '历史探索对照', statusTheme: 'default',
    principle: '在M1基础上按距今期数指数衰减出现次数（半衰期100期），先验不衰减。',
    parameters: ['window = 300', 'priorStrength = 100', 'halfLife = 100'],
    limitations: ['近期权重更高不意味着更准；第7批比较中四项概率评分均差于M0。'],
  },
  {
    code: 'M3', name: 'M3_omission_control · 遗漏对照', status: '遗漏反例对照', statusTheme: 'warning',
    principle: '在M1权重上乘有界遗漏系数，轻微偏向当前遗漏较长的号码，用来展示“欠开奖”直觉的局限。',
    parameters: ['window = 300', 'priorStrength = 100', 'omissionExponent = 0.25，倍率封顶3'],
    limitations: ['独立开奖下不存在“欠开奖”；第7批比较中它的评分劣势最明显，仅作反例。'],
  },
  {
    code: 'M4/M5', name: '融合打分 / 反热门', status: '暂不准入', statusTheme: 'default',
    principle: '仅在M1–M3有模型显著优于M0、或取得独立投注偏好证据时才会实现；当前两项前提均未满足。',
    parameters: ['未实现，无参数'],
    limitations: ['不展示任何M4/M5结果，也不提供在客户端选择策略重新推荐。'],
  },
];

/** 第7批完整比较：2013031–2026124、2,052期、每期5注、每模型100重复、seed=20261031。 */
export const COMPARISON = {
  source: '本地研究报告 basic-model-comparison-8-20261031（静态摘录，非实时）',
  range: '评估期 2013031–2026124，共2,052期；每期5注；每模型100次随机重复；种子20261031',
  rows: [
    { model: 'M0', redHits: '1.092796', blueRate: '0.062580', redLoss: '—', blueLoss: '—' },
    { model: 'M1', redHits: '1.091161', blueRate: '0.062646', redLoss: '-0.00054054', blueLoss: '-0.01184292' },
    { model: 'M2', redHits: '1.092601', blueRate: '0.062289', redLoss: '-0.00034638', blueLoss: '-0.00853122' },
    { model: 'M3', redHits: '1.091821', blueRate: '0.062210', redLoss: '-0.00386391', blueLoss: '-0.04255493' },
  ],
  conclusion: 'log loss改善为“M0损失－模型损失”，负数表示差于M0。三模型四项概率评分改善均为负，属于已查看历史上的探索性证据，不是前瞻定论；命中差异很小。',
};
