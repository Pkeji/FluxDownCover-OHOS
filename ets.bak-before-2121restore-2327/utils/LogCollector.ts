/**
 * 全局日志收集器
 * 记录 APP 运行中的错误、警告、异常、功能无反馈等问题
 * 双击设置页面版本号可复制全部日志
 */

import { promptAction } from '@kit.ArkUI';

export interface LogEntry {
  time: string;
  level: 'ERROR' | 'WARN' | 'INFO';
  tag: string;
  message: string;
}

class LogCollector {
  private logs: LogEntry[] = [];
  private maxLogs = 500;
  private lastToastTime = 0;
  private readonly toastIntervalMs = 10000; // 10秒节流

  private now(): string {
    const d = new Date();
    const pad = (n: number) => n < 10 ? '0' + n : '' + n;
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${d.getMilliseconds()}`;
  }

  error(tag: string, message: string): void {
    this.add('ERROR', tag, message);
    console.error(`[FluxDown ERROR][${tag}] ${message}`);
    // 报错时提示用户日志已保存（10秒节流）
    const now = Date.now();
    if (now - this.lastToastTime > this.toastIntervalMs) {
      this.lastToastTime = now;
      try {
        promptAction.showToast({
          message: '已记录错误日志，双击设置→版本号可复制',
          duration: 2500
        });
      } catch (_) {
        // ignore
      }
    }
  }

  warn(tag: string, message: string): void {
    this.add('WARN', tag, message);
    console.warn(`[FluxDown WARN][${tag}] ${message}`);
  }

  info(tag: string, message: string): void {
    this.add('INFO', tag, message);
    console.info(`[FluxDown INFO][${tag}] ${message}`);
  }

  private add(level: 'ERROR' | 'WARN' | 'INFO', tag: string, message: string): void {
    this.logs.push({ time: this.now(), level, tag, message });
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  getAll(): string {
    if (this.logs.length === 0) {
      return '暂无日志记录';
    }
    return this.logs.map((l: LogEntry) => `[${l.time}][${l.level}][${l.tag}] ${l.message}`).join('\n');
  }

  clear(): void {
    this.logs = [];
  }

  getCount(): number {
    return this.logs.length;
  }
}

export const logCollector = new LogCollector();
