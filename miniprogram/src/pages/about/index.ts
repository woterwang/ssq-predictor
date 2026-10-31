/** 说明页不请求动态总数，不将开发占位表述为上线审核通过。 */
Page({
  openRecommendations() { wx.navigateTo({ url: '/pages/recommendations/index' }); },
  openResearch() { wx.navigateTo({ url: '/research/pages/strategy/index' }); },
  openHistory() { wx.switchTab({ url: '/pages/history/index' }); },
});