import { getConfig } from './settings.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// A plain, classic layout (tables, inline styles) that renders in every mail client.
function layout({ heading, intro, buttonLabel, url, outro }) {
  const sans = 'font-family:Arial,Helvetica,sans-serif';
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;color:#18181b;font-family:Georgia,serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px">
<tr><td style="font-size:18px;font-weight:bold;padding-bottom:20px">Content Agent</td></tr>
<tr><td style="font-size:24px;padding-bottom:12px">${escape(heading)}</td></tr>
<tr><td style="${sans};font-size:15px;line-height:1.6;color:#3f3f46;padding-bottom:24px">${escape(intro)}</td></tr>
<tr><td style="padding-bottom:24px"><a href="${escape(url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;${sans};font-size:15px;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:8px">${escape(buttonLabel)}</a></td></tr>
<tr><td style="${sans};font-size:13px;line-height:1.6;color:#71717a">${escape(outro)}<br><br>Button not working? Paste this link into your browser:<br><a href="${escape(url)}" style="color:#4f46e5;word-break:break-all">${escape(url)}</a></td></tr>
</table></td></tr></table></body></html>`;
}

async function send({ to, subject, text, html }) {
  const config = await getConfig();
  if (!config.resend_api_key) {
    console.log(`\n[email] Not sent (add a Resend API key in Settings → Sign-in & email). To: ${to}\n  ${subject}\n  ${text.replace(/\n+/g, '\n  ')}\n`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resend_api_key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.email_from, to: [to], subject, text, html }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(`[email] Resend refused the email to ${to}: ${body.message || res.status}`);
    throw new Error('We could not send the email right now. Try again in a few minutes.');
  }
}

export const emailConfigured = (config) => Boolean(config.resend_api_key);

export function sendVerificationEmail(user, url) {
  const intro = `Hi ${user.name || 'there'}, confirm your email address to finish setting up your account.`;
  const outro = 'This link expires in 24 hours. If you did not create an account, you can ignore this email.';
  return send({
    to: user.email,
    subject: 'Confirm your email address',
    text: `${intro}\n\n${url}\n\n${outro}`,
    html: layout({ heading: 'Confirm your email', intro, buttonLabel: 'Confirm email', url, outro }),
  });
}

export function sendPasswordResetEmail(user, url) {
  const intro = `Hi ${user.name || 'there'}, we received a request to reset your password.`;
  const outro = "This link expires in 1 hour and works once. If you didn't ask for this, ignore this email: your password stays the same.";
  return send({
    to: user.email,
    subject: 'Reset your password',
    text: `${intro}\n\n${url}\n\n${outro}`,
    html: layout({ heading: 'Reset your password', intro, buttonLabel: 'Choose a new password', url, outro }),
  });
}
