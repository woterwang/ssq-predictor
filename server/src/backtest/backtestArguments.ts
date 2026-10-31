/** CLI参数解析为纯函数，不加载环境配置/数据库，方便在NODE_ENV=test下独立验收。 */
import type { BacktestOptions } from './backtestTypes';
import { assertValidBacktestOptions } from './walkForwardEngine';

export function parseBacktestArguments(argumentsList: string[]): BacktestOptions {
  const allowed = ['--start-issue', '--end-issue', '--tickets', '--repetitions', '--seed', '--minimum-history'];
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index++) {
    const parts = argumentsList[index].split('=');
    const name = parts[0], value = parts[1] ?? argumentsList[++index];
    if (!allowed.includes(name) || values.has(name) || parts.length > 2 || value === undefined || !/^\d+$/.test(value)) {
      throw new Error(`未知/重复/无效参数：${name}`);
    }
    values.set(name, value);
  }
  const options = {
    startIssue: values.get('--start-issue') ?? '2013031', endIssue: values.get('--end-issue') ?? '2026124',
    ticketsPerIssue: Number(values.get('--tickets') ?? 5), repetitions: Number(values.get('--repetitions') ?? 500),
    seed: Number(values.get('--seed') ?? 20261031), minimumHistory: Number(values.get('--minimum-history') ?? 30),
  };
  assertValidBacktestOptions(options);
  return options;
}