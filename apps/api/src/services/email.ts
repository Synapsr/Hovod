import { env, emailEnabled, appUrl } from '../env.js';

/**
 * Transactional email through the Resend REST API (plain `fetch`, no SDK).
 *
 * Every caller treats email as best effort: when Resend is not configured the
 * message is logged and `{ sent: false }` comes back — nothing throws.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  sent: boolean;
  /** Resend message id when sent. */
  id?: string;
  /** Why it was not sent (missing config, API error). */
  reason?: string;
}

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  if (!emailEnabled) {
    console.log(`[email] not configured — skipped "${message.subject}" to ${message.to}`);
    return { sent: false, reason: 'email_not_configured' };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(`[email] Resend responded ${response.status} for "${message.subject}" to ${message.to}: ${body.slice(0, 300)}`);
      return { sent: false, reason: `resend_${response.status}` };
    }

    const data = (await response.json().catch(() => ({}))) as { id?: string };
    return { sent: true, id: data.id };
  } catch (err) {
    console.warn(`[email] Failed to send "${message.subject}" to ${message.to}: ${(err as Error).message}`);
    return { sent: false, reason: (err as Error).message };
  }
}

/* ─── Templates ──────────────────────────────────────────── */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return 'soon';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Minimal, client-safe layout: one column, inline styles, a single button. */
function layout(title: string, paragraphs: string[], cta?: { label: string; url: string }, footer?: string): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;line-height:1.5">${p}</p>`).join('');
  const button = cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${escapeHtml(cta.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#6b7280;word-break:break-all">Or copy this link: ${escapeHtml(cta.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
<h1 style="margin:0 0 20px;font-size:20px">${escapeHtml(title)}</h1>
${body}${button}
<p style="margin:24px 0 0;font-size:12px;color:#9ca3af">${footer ? escapeHtml(footer) : 'Hovod — video hosting made simple.'}</p>
</div></body></html>`;
}

export interface Template extends Omit<EmailMessage, 'to'> {}

export function invitationTemplate(opts: { orgName: string; inviterName: string | null; role: string; inviteUrl: string; expiresAt: Date }): Template {
  const who = opts.inviterName ? `${escapeHtml(opts.inviterName)} invited you` : 'You have been invited';
  const subject = `You're invited to join ${opts.orgName} on Hovod`;
  return {
    subject,
    html: layout(subject, [
      `${who} to join <strong>${escapeHtml(opts.orgName)}</strong> as ${escapeHtml(opts.role)}.`,
      `This invitation expires on ${formatDate(opts.expiresAt)}.`,
    ], { label: 'Accept invitation', url: opts.inviteUrl }, 'If you were not expecting this invitation you can ignore this email.'),
    text: `${opts.inviterName ? `${opts.inviterName} invited you` : 'You have been invited'} to join ${opts.orgName} on Hovod as ${opts.role}.\n\nAccept: ${opts.inviteUrl}\n\nThis invitation expires on ${formatDate(opts.expiresAt)}.`,
  };
}

export function passwordResetTemplate(opts: { resetUrl: string; expiresAt: Date }): Template {
  const subject = 'Reset your Hovod password';
  return {
    subject,
    html: layout(subject, [
      'Someone asked to reset the password of your Hovod account. Click the button below to choose a new one.',
      'The link is valid for one hour and can be used once.',
    ], { label: 'Reset password', url: opts.resetUrl }, 'If you did not request a reset, ignore this email — your password stays unchanged.'),
    text: `Reset your Hovod password:\n\n${opts.resetUrl}\n\nThe link is valid for one hour. If you did not request this, ignore this email.`,
  };
}

export function welcomeTemplate(opts: { name: string | null; orgName: string; plan: string }): Template {
  const subject = 'Welcome to Hovod — your subscription is active';
  const hello = opts.name ? `Hi ${escapeHtml(opts.name)},` : 'Hi,';
  return {
    subject,
    html: layout(subject, [
      `${hello} your <strong>${escapeHtml(opts.plan)}</strong> plan for <strong>${escapeHtml(opts.orgName)}</strong> is active. Here is how to get started:`,
      '<strong>1.</strong> Upload or import your first video from the <em>Videos</em> page.',
      '<strong>2.</strong> Grab the embed code or share link once it is ready.',
      '<strong>3.</strong> Create an API key under <em>Settings → API keys</em> to automate uploads.',
    ], { label: 'Open the dashboard', url: `${appUrl}/videos` }, 'Manage your plan at any time from Settings → Subscription.'),
    text: `${opts.name ? `Hi ${opts.name},` : 'Hi,'} your ${opts.plan} plan for ${opts.orgName} is active.\n\n1. Upload or import your first video from the Videos page.\n2. Grab the embed code or share link once it is ready.\n3. Create an API key under Settings → API keys to automate uploads.\n\nDashboard: ${appUrl}/videos`,
  };
}

export function paymentFailedTemplate(opts: { orgName: string; graceUntil: Date | null }): Template {
  const subject = `Payment failed for ${opts.orgName}`;
  return {
    subject,
    html: layout(subject, [
      `We could not collect the latest payment for <strong>${escapeHtml(opts.orgName)}</strong>.`,
      `Update your payment method before <strong>${formatDate(opts.graceUntil)}</strong> to keep uploading and processing videos. After that date the workspace becomes read-only (your videos keep playing) until the payment goes through.`,
    ], { label: 'Update payment method', url: `${appUrl}/settings` }, 'Stripe will retry the payment automatically over the coming days.'),
    text: `We could not collect the latest payment for ${opts.orgName}.\n\nUpdate your payment method before ${formatDate(opts.graceUntil)} to keep uploading: ${appUrl}/settings\n\nAfter that date the workspace becomes read-only until the payment goes through.`,
  };
}

export function subscriptionCanceledTemplate(opts: { orgName: string }): Template {
  const subject = `Your Hovod subscription for ${opts.orgName} has ended`;
  return {
    subject,
    html: layout(subject, [
      `The subscription of <strong>${escapeHtml(opts.orgName)}</strong> is canceled. The workspace is now read-only: existing videos keep playing, but nothing new can be uploaded or processed.`,
      'You can subscribe again at any time to restore full access — or run Hovod yourself, it is open source.',
    ], { label: 'Resubscribe', url: `${appUrl}/settings` }, 'Thank you for having used Hovod.'),
    text: `The subscription of ${opts.orgName} is canceled. The workspace is now read-only.\n\nResubscribe: ${appUrl}/settings\n\nOr self-host Hovod — it is open source.`,
  };
}
