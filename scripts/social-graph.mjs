// Small, non-fatal Graph API helpers shared by the weekly report and the comment fetcher.
// Every call returns data or records an issue; nothing here throws.

export function graphClient({ token, version = "v22.0", fetchImpl = fetch, issues = [] } = {}) {
  const base = `https://graph.facebook.com/${version}`;

  function note(where, err) {
    const e = (err && err.error) || err || {};
    const msg = String(e.message || e).slice(0, 220);
    const code = e.code;
    const kind = isPermission(e) ? "permission" : code === 190 ? "token" : "error";
    const key = `${where}|${code}|${msg}`;
    if (!issues.some((i) => i.key === key)) issues.push({ key, where, code, kind, message: msg });
  }

  async function get(path, params = {}, where = path) {
    if (!token) return { error: { message: "no token" } };
    const qs = new URLSearchParams({ ...params, access_token: token });
    try {
      const res = await fetchImpl(`${base}/${path}?${qs}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) return { error: data.error || { message: `HTTP ${res.status}` } };
      return data;
    } catch (e) {
      return { error: { message: String((e && e.message) || e) } };
    }
  }

  // Asks for several fields at once; if the Graph refuses one (invalid field or no permission), asks
  // for each field on its own so one bad field never hides the others.
  async function fields(id, list, where) {
    const all = await get(id, { fields: list.join(",") }, where);
    if (!all.error) return all;
    if (list.length === 1) { note(where, all.error); return {}; }
    const out = {};
    for (const f of list) {
      const one = await get(id, { fields: f }, where);
      if (one.error) { note(`${where} ${f.split(/[.{]/)[0]}`, one.error); continue; }
      Object.assign(out, one);
    }
    return out;
  }

  // Same idea for insights: metric names change between API versions (plays -> views), so a refused
  // list falls back to one metric at a time. Returns { name: value }.
  async function insights(id, edge, metrics, where) {
    const read = (d) => Object.fromEntries((d.data || []).map((m) => [m.name, m.values ? m.values[0] && m.values[0].value : m.total_value ? m.total_value.value : undefined]));
    const all = await get(`${id}/${edge}`, { metric: metrics.join(",") }, where);
    if (!all.error) return read(all);
    if (metrics.length === 1) { note(where, all.error); return {}; }
    const out = {};
    for (const m of metrics) {
      const one = await get(`${id}/${edge}`, { metric: m }, where);
      if (one.error) { note(`${where} ${m}`, one.error); continue; }
      Object.assign(out, read(one));
    }
    return out;
  }

  return { get, fields, insights, note, issues };
}

export function isPermission(e) {
  const code = Number(e && e.code);
  const msg = String((e && e.message) || "");
  return code === 10 || code === 200 || (code >= 200 && code < 300) || /permission/i.test(msg);
}

// FB_PAGE_TOKEN may be a user/system-user token; the Page token is looked up the same way
// social-publish.mjs does it.
export async function resolvePage({ token, pageId, version = "v22.0", fetchImpl = fetch }) {
  const g = graphClient({ token, version, fetchImpl });
  let pageToken = token;
  if (token && pageId) {
    const acc = await g.get("me/accounts", { fields: "id,access_token" });
    const page = (acc.data || []).find((p) => String(p.id) === String(pageId));
    if (page && page.access_token) pageToken = page.access_token;
  }
  let ig = null;
  if (pageToken && pageId) {
    const p = await graphClient({ token: pageToken, version, fetchImpl }).get(String(pageId), { fields: "instagram_business_account{id,username}" });
    if (p.instagram_business_account) ig = { id: String(p.instagram_business_account.id), username: p.instagram_business_account.username || "" };
  }
  return { pageToken, ig };
}

export function summarizeIssues(issues) {
  const perms = issues.filter((i) => i.kind === "permission" || i.kind === "token");
  const lines = [...new Set(perms.map((i) => `${i.where.split(" ")[0]}: ${i.message}`))];
  return lines.slice(0, 8);
}
