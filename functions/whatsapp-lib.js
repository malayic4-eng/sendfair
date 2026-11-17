// Sends WhatsApp messages through the Meta WhatsApp Business Cloud API.
// Replies to inbound messages are inside the 24-hour customer-service window; alerts fired later need
// an approved template (WHATSAPP_ALERT_TEMPLATE), because they are business-initiated.
const GRAPH = "https://graph.facebook.com/v20.0";

function ready(env) { return !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID); }

export async function sendText(env, to, body) {
  if (!ready(env) || !to) return false;
  try {
    const res = await fetch(`${GRAPH}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: String(to), type: "text", text: { preview_url: true, body: String(body).slice(0, 4096) } })
    });
    if (!res.ok) console.log("whatsapp send", res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) { console.log("whatsapp send failed", e && e.message); return false; }
}

// parameters are the {{1}}, {{2}}… body variables of the approved alert template.
export async function sendTemplate(env, to, parameters) {
  if (!ready(env) || !env.WHATSAPP_ALERT_TEMPLATE || !to) return false;
  try {
    const res = await fetch(`${GRAPH}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: String(to),
        type: "template",
        template: {
          name: env.WHATSAPP_ALERT_TEMPLATE,
          language: { code: env.WHATSAPP_TEMPLATE_LANG || "en" },
          components: [{ type: "body", parameters: (parameters || []).map((p) => ({ type: "text", text: String(p) })) }]
        }
      })
    });
    if (!res.ok) console.log("whatsapp template", res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) { console.log("whatsapp template failed", e && e.message); return false; }
}
