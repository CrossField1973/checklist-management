import nodemailer from "nodemailer";
import type { Config } from "./config.js";

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

/** SMTP-Versand über nodemailer. Gibt null zurück, wenn SMTP nicht konfiguriert ist (Funktion „Passwort vergessen“ ist dann aus). */
export function createMailer(config: Config): Mailer | null {
  if (!config.smtpEnabled) return null;
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ?? (config.SMTP_SECURE ? 465 : 587),
    secure: config.SMTP_SECURE ?? false,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
  });
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from: config.SMTP_FROM, to, subject, text });
    },
  };
}

export function resetPasswordMail(lang: "de" | "en", link: string) {
  return lang === "de"
    ? {
        subject: "Passwort zurücksetzen",
        text: `Du hast das Zurücksetzen deines Passworts angefordert.\n\nLink (1 Stunde gültig, nur einmal verwendbar):\n${link}\n\nWenn du das nicht warst, ignoriere diese E-Mail.`,
      }
    : {
        subject: "Reset your password",
        text: `You requested a password reset.\n\nLink (valid for 1 hour, single use):\n${link}\n\nIf this wasn't you, ignore this email.`,
      };
}
