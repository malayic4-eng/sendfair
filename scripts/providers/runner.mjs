// Runs adapters and keeps per-adapter failure state. After two failures in a row it calls the
// notifier once (the `alerted` flag prevents a new email every run until the feed recovers).
import { mergeQuotes } from "./merge.mjs";

export async function runFeeds({ adapters, env = process.env, fetchImpl = fetch, now = Date.now(), routes = null, state = {}, notify = async () => ({ sent: false, error: "no notifier" }), quotesFile, mid = {}, providers = new Set(), sendsFrom = {}, defaultAmounts = {}, routeCurrency = {} }) {
  const results = [];
  for (const adapter of adapters) {
    const st = state[adapter.id] || (state[adapter.id] = { consecutiveFailures: 0, lastRun: null, lastSuccess: null, lastError: "", alerted: false });
    st.lastRun = new Date(now).toISOString();
    try {
      const out = await adapter.fetchQuotes({ env, fetchImpl, now, routes });
      if (out && out.skipped) { results.push({ id: adapter.id, skipped: out.skipped }); continue; }
      const merged = mergeQuotes(quotesFile, out.quotes, { now, mid, providers, sendsFrom, defaultAmounts, routeCurrency });
      st.consecutiveFailures = 0;
      st.lastSuccess = new Date(now).toISOString();
      st.lastError = "";
      st.alerted = false;
      results.push({ id: adapter.id, ok: true, rows: out.rows ?? null, added: merged.added, kept: merged.kept, dropped: merged.dropped.length, invalid: out.invalid ?? 0 });
    } catch (e) {
      st.consecutiveFailures = (st.consecutiveFailures || 0) + 1;
      st.lastError = String((e && e.message) || e).slice(0, 500);
      const item = { id: adapter.id, ok: false, error: st.lastError, consecutiveFailures: st.consecutiveFailures };
      if (st.consecutiveFailures >= 2 && !st.alerted) {
        const alert = await notify({
          subject: `SendFair: ${adapter.name} partner feed failed twice`,
          text: `${adapter.name} (${adapter.id}) failed twice in a row.\n\nLast error: ${st.lastError}\nRun: ${new Date(now).toISOString()}\n\nThe adapter is skipped until its feed recovers; no provider data was published by it.`
        });
        st.alerted = true;
        item.alert = alert;
      }
      results.push(item);
    }
  }
  return { results, state };
}
