import { COMPARISON, STRATEGIES, STRATEGY_NOTES_VERSION } from '../../data/strategy-notes';

/** 纯本地静态说明：不请求接口、不切换线上策略、不生成号码。 */
Page({
  data: {
    version: STRATEGY_NOTES_VERSION,
    strategies: STRATEGIES.map(item => ({ ...item, expanded: item.code === 'M0' })),
    comparison: COMPARISON,
  },
  toggle(event: WechatMiniprogram.CustomEvent) {
    const code: unknown = event.currentTarget.dataset.code;
    this.setData({ strategies: this.data.strategies.map(item => item.code === code ? { ...item, expanded: !item.expanded } : item) });
  },
  openBacktests() { wx.navigateTo({ url: '/research/pages/backtests/index' }); },
  openAbout() { wx.switchTab({ url: '/pages/about/index' }); },
});
