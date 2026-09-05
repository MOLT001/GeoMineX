/**
 * Email delivery — OTP codes and invitations.
 *
 * Behind an interface so the transport can change without touching the auth
 * module (PRD §7). In development, with no SMTP configured, messages are
 * logged instead of sent — the OTP code is written to the log ONLY outside
 * production, so a developer can complete a login locally.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export interface EmailService {
  sendOtpCode(to: string, code: string, ttlMinutes: number): Promise<void>;
  sendInvite(to: string, inviteUrl: string, expiresInHours: number): Promise<void>;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: (env.SMTP_PORT ?? 587) === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

async function deliver(to: string, subject: string, text: string, devPreview: string): Promise<void> {
  const tx = getTransporter();

  if (!tx) {
    if (env.isProduction) {
      // env.ts already refuses to boot production without SMTP; this is the
      // belt-and-braces guard in case that check is ever relaxed.
      throw new Error('Email transport is not configured');
    }
    logger.warn(`[dev email] to=${to} subject="${subject}" — ${devPreview}`);
    return;
  }

  await tx.sendMail({ from: env.EMAIL_FROM, to, subject, text });
}

export const emailService: EmailService = {
  async sendOtpCode(to, code, ttlMinutes) {
    await deliver(
      to,
      'Your GeoMineX sign-in code',
      `Your GeoMineX sign-in code is ${code}. It expires in ${ttlMinutes} minutes.\n\n` +
        `If you did not request this code, you can ignore this email.`,
      // Dev-only: never reached when NODE_ENV=production.
      `code=${code}`,
    );
  },

  async sendInvite(to, inviteUrl, expiresInHours) {
    await deliver(
      to,
      'You have been invited to GeoMineX',
      `You have been invited to GeoMineX.\n\nAccept your invitation: ${inviteUrl}\n\n` +
        `This link expires in ${expiresInHours} hours and can be used once.`,
      `url=${inviteUrl}`,
    );
  },
};
