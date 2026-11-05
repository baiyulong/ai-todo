import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { MailConfig } from '../config.js';

export interface MailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** SMTP 未配置时为 false：所有发信调用直接跳过（降级为日志），不抛错 */
  readonly enabled: boolean;
  send(payload: MailPayload): Promise<void>;
  verify(): Promise<boolean>;
}

/**
 * SMTP 邮件通道。
 *
 * 设计原则与浏览器通知一致：邮件是尽力而为的附加动作——
 * SMTP 挂了只打日志，绝不把业务请求（建任务 / 转交）变成 500。
 *
 * 未配置 SMTP_HOST 时整个通道降级为「日志模式」：
 * 本该发出去的邮件内容打到 stdout，方便本地开发时验证文案与收件人。
 */
export function createMailer(config: MailConfig): Mailer {
  if (!config.enabled || !config.host) {
    return {
      enabled: false,
      async send(payload) {
        console.log(
          `[mail] SMTP 未配置，跳过发信 → to=${payload.to} subject=${payload.subject}`,
        );
      },
      async verify() {
        return false;
      },
    };
  }

  const transport: Transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    // 发信失败别把进程拖死：连接池超时兜底
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return {
    enabled: true,
    async send(payload) {
      try {
        await transport.sendMail({
          // display name 交给 nodemailer 做非 ASCII 编码；为空时传纯地址字符串
          from: config.from.name ? config.from : config.from.address,
          to: payload.to,
          subject: payload.subject,
          text: payload.text,
          html: payload.html,
        });
      } catch (err) {
        // 吞掉异常只记日志：调用方（建任务 / 转交）不该因 SMTP 故障失败。
        // from 地址一起打出来——QQ/163 报 502 十有八九是 MAIL FROM 地址问题。
        console.error(
          '[mail] 发送失败',
          `from=${config.from.address}`,
          `to=${payload.to}`,
          payload.subject,
          err,
        );
      }
    },
    async verify() {
      try {
        await transport.verify();
        return true;
      } catch (err) {
        console.error('[mail] SMTP 连接校验失败', err);
        return false;
      }
    },
  };
}
