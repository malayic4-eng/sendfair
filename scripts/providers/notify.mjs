// Sends the owner an email when a partner feed fails twice in a row.
// Preferred: Resend (RESEND_API_KEY + OWNER_ALERT_EMAIL). Fallback: OWNER_ALERT_WEBHOOK.
// If neither is configured the caller writes data/adapters/alerts.jsonl and fails the run, so the
// GitHub Actions failure email reaches the owner as a last resort.
export async function notifyOwner({ subject, text }, { env = process.env, fetchImpl = fetch } = {}) {
  if (env.RESEND_API_KEY && env.OWNER_ALERT_EMAIL) {
    try {
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: env.OWNER_ALERT_FROM || "SendFair alerts <alerts@sendfair.africa>",
          to: [env.OWNER_ALERT_EMAIL],
          subject,
          text
        })
      });
      return res.ok ? { sent: "resend" } : { sent: false, error: `resend ${res.status}` };
    } catch (e) { return { sent: false, error: String((e && e.message) || e) }; }
  }
  if (env.OWNER_ALERT_WEBHOOK) {
    try {
      const res = await fetchImpl(env.OWNER_ALERT_WEBHOOK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject, text })
      });
      return res.ok ? { sent: "webhook" } : { sent: false, error: `webhook ${res.status}` };
    } catch (e) { return { sent: false, error: String((e && e.message) || e) }; }
  }
  return { sent: false, error: "no owner alert channel: set RESEND_API_KEY + OWNER_ALERT_EMAIL, or OWNER_ALERT_WEBHOOK" };
}
