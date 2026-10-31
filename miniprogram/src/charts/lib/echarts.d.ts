/** 构建时由scripts/echarts-entry.mjs定制打包为同目录echarts.js；此处只声明本分包实际使用的接口。 */
export interface ChartZrHandler { dispatch(eventName: string, event: Record<string, unknown>): void }
export interface ChartInstance {
  setOption(option: Record<string, unknown>, notMerge?: boolean): void;
  getZr(): { handler: ChartZrHandler };
  dispose(): void;
}
export function init(canvas: object, theme: null, options: { width: number; height: number; devicePixelRatio: number }): ChartInstance;
export function setPlatformAPI(api: { measureText?: (text: string, font?: string) => { width: number } }): void;
