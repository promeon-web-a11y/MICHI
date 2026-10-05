/**
 * 互換レイヤー。ログの正本は lib/logger.ts（アプリ共通）。
 * 旧名（shareLog / ShareLogEntry / getShareLogEntries …）を残している。
 */
export {
  appLog as shareLog,
  clearLogEntries as clearShareLogEntries,
  getLogEntries as getShareLogEntries,
  redactSecrets,
  subscribeLog as subscribeShareLog,
  type LogEntry as ShareLogEntry,
  type LogLevel,
} from '../lib/logger';
