/** 只放公开服务地址，没有任何管理密钥。正式版未配置域名时明确阻止请求。 */
export const API_ENVIRONMENT = {
  // 本机WLAN局域网地址，供模拟器与同一Wi-Fi下的真机调试；电脑IP变化时需同步修改。
  develop: 'http://192.168.0.108:3001',
  // 体验版域名，供体验版小程序使用。
  trial: 'http://8.148.247.186:3001',
  release: '',
} as const;

export function getApiBaseUrl(): string {
  let version = wx.getAccountInfoSync().miniProgram.envVersion;
  const address: string = API_ENVIRONMENT['trial'];
  if (!address) throw new Error('当前版本尚未配置公众HTTPS服务域名');
  // 真机上的127.0.0.1不是电脑。局域网调试仅在develop配置；正式/体验版只允许HTTPS。
  const pattern = version === 'develop' ? /^https?:\/\/[^/?#@]+(?::\d+)?$/ : /^https:\/\/[^/?#@]+(?::\d+)?$/;
  if (!pattern.test(address)) throw new Error('公众服务地址配置无效');
  return address;
}