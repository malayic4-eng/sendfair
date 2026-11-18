// Generic partner-feed adapter. It reads one official JSON or CSV feed for one provider, maps the
// fields with data/adapters/<provider>.json, and returns quotes in SendFair's internal format.
// It never scrapes a provider website. The adapter only runs when both env vars named in its config
// are set; otherwise it returns { skipped: "no env" }.
import { csvRows, getPath, normalizePayout, toIso, toNumber, withinHours } from "./adapter.mjs";

export class PartnerFeedAdapter {
  constructor(config) {
    this.config = config;
    this.id = config.id;
    this.name = config.name || config.id;
    this.provider = config.provider || config.id;
    this.kind = "partner-feed";
  }

  supports(route) {
    return !Array.isArray(this.config.routes) || this.config.routes.includes(route);
  }

  env(env) {
    const e = this.config.env || {};
    return { url: e.url ? env[e.url] || "" : "", key: e.key ? env[e.key] || "" : "" };
  }

  async fetchQuotes({ env = process.env, fetchImpl = fetch, now = Date.now(), routes = null } = {}) {
    const { url, key } = this.env(env);
    if (!url || !key) return { skipped: "no env", quotes: {} };

    const cfg = this.config;
    const format = (cfg.format || "json").toLowerCase();
    const auth = cfg.auth || { header: "Authorization", prefix: "Bearer " };
    const headers = { Accept: format === "csv" ? "text/csv" : "application/json" };
    if (auth.header) headers[auth.header] = `${auth.prefix || ""}${key}`;

    let res;
    try { res = await fetchImpl(url, { method: "GET", headers }); }
    catch (e) { throw new Error(`feed fetch failed: ${e.message || e}`); }
    if (!res || !res.ok) throw new Error(`feed HTTP ${res ? res.status : "no response"}`);

    let rows;
    if (format === "csv") {
      rows = csvRows(await res.text());
    } else {
      let body;
      try { body = await res.json(); } catch (e) { throw new Error(`feed JSON is invalid: ${e.message || e}`); }
      rows = getPath(body, cfg.rowsPath);
      if (!Array.isArray(rows)) throw new Error(`feed JSON has no array at ${cfg.rowsPath || "root"}`);
    }
    if (!rows.length) throw new Error("feed returned no rows");

    const m = cfg.mapping || {};
    const fromMap = cfg.fromMap || {};
    const toMap = cfg.toMap || {};
    const allowed = routes ? new Set(routes) : null;
    const quotes = {};
    let dropped = 0, invalid = 0;

    for (const row of rows) {
      const rawFrom = m.from ? row[m.from] : "";
      const rawTo = m.to ? row[m.to] : "";
      const route = m.route
        ? String(row[m.route] || "").trim()
        : `${Object.prototype.hasOwnProperty.call(fromMap, rawFrom) ? fromMap[rawFrom] : rawFrom}-${Object.prototype.hasOwnProperty.call(toMap, rawTo) ? toMap[rawTo] : rawTo}`;
      if (!route || route.includes("undefined") || (allowed && !allowed.has(route)) || !this.supports(route)) { invalid++; continue; }

      const checkedAt = toIso(row[m.checkedAt]);
      const rate = toNumber(row[m.rate]);
      if (!checkedAt || !(rate > 0) || !withinHours(checkedAt, now, cfg.maxAgeHours || 24)) { dropped++; continue; }

      const quote = {
        provider: this.provider,
        rate,
        feeFixed: toNumber(row[m.fee]) ?? 0,
        feePct: (toNumber(row[m.feePct]) ?? 0) * (cfg.feePctScale ?? 1),
        payout: normalizePayout(row[m.payout], (cfg.defaults && cfg.defaults.payout) || ["bank"]),
        speed: String(row[m.speed] || (cfg.defaults && cfg.defaults.speed) || ""),
        note: `From ${this.name}'s official partner feed (partner feed); confirm on the provider's site`,
        refAmount: toNumber(row[m.refAmount]) ?? null,
        checkedAt,
        source: "partner-feed",
        feed: true
      };
      (quotes[route] = quotes[route] || []).push(quote);
    }
    return { quotes, rows: rows.length, dropped, invalid };
  }
}
