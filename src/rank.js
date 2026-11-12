/* SendFair ranking engine. Shared by the build script (page HTML) and the browser (live re-ranking).
   Quote fields: provider, variant, rate, feeFixed, feePct, payout[], speed, note, refAmount, checkedAt.
   Older quotes with a single "fee" field are read as feeFixed. */
(function (root) {
  "use strict";
  var LABEL = { mobile: "Mobile money", bank: "Bank", cash: "Cash pickup" };
  var DOT = " · ";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fixed(n, d) {
    return Number(n).toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function money(value, currency, digits) {
    var d = digits == null ? (Math.abs(value) >= 1000 ? 0 : 2) : digits;
    return currency + " " + fixed(value, d);
  }
  function rateStr(rate) { return fixed(rate, rate >= 100 ? 2 : 4); }
  function midRate(mid, src, tgt) {
    if (src === tgt) return 1;
    var r = mid && mid.rates;
    if (!r || !r[src] || !r[tgt]) return null;
    return r[tgt] / r[src];
  }
  function ageHours(iso, now) {
    if (!iso) return Infinity;
    var t = new Date(iso).getTime();
    return isNaN(t) ? Infinity : (now - t) / 3600000;
  }
  function ago(iso, now) {
    var h = ageHours(iso, now);
    if (!isFinite(h)) return "";
    var m = Math.round(h * 60);
    if (m < 2) return "just now";
    if (m < 60) return m + " min ago";
    if (h < 48) return Math.round(h) + " h ago";
    return Math.round(h / 24) + " days ago";
  }
  function absTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    return d.getUTCDate() + " " + mon + ", " + String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0") + " UTC";
  }
  function feeParts(q) {
    var f = q.feeFixed != null && q.feeFixed !== "" ? Number(q.feeFixed) : Number(q.fee) || 0;
    return { fixed: f || 0, pct: Number(q.feePct) || 0 };
  }
  // "You pay in total" model: total = sent + fixed fee + pct% of sent.
  function evaluate(q, amount) {
    var rate = Number(q.rate);
    if (!(rate > 0) || !(amount > 0)) return null;
    var f = feeParts(q);
    var sent = (amount - f.fixed) / (1 + f.pct / 100);
    if (!(sent > 0)) return null;
    return { sent: sent, fee: amount - sent, gets: sent * rate, rate: rate, feeFixed: f.fixed, feePct: f.pct };
  }
  function feeStr(q, cur) {
    var f = feeParts(q);
    if (!f.fixed && !f.pct) return "No fee";
    if (f.pct && f.fixed) return "Fee " + fixed(f.pct, 2) + "% + " + money(f.fixed, cur, 2);
    if (f.pct) return "Fee " + fixed(f.pct, 2) + "%";
    return "Fee " + money(f.fixed, cur, 2);
  }

  function rank(o) {
    var best = {};
    (o.list || []).forEach(function (q) {
      var age = ageHours(q.checkedAt, o.now);
      if (age > o.hideH) return;
      if (o.payout && o.payout !== "all" && (q.payout || []).indexOf(o.payout) === -1) return;
      var ev = evaluate(q, o.amount);
      if (!ev) return;
      var p = o.providers[q.provider];
      if (!p) return;
      var row = { q: q, p: p, ev: ev, gets: ev.gets, age: age, stale: age > o.staleH, cost: o.mid ? 1 - ev.gets / (o.amount * o.mid) : null };
      var cur = best[q.provider];
      if (!cur || (cur.stale && !row.stale) || (cur.stale === row.stale && row.gets > cur.gets)) best[q.provider] = row;
    });
    return Object.keys(best).map(function (k) { return best[k]; }).sort(function (a, b) {
      if (a.stale !== b.stale) return a.stale ? 1 : -1;
      return b.gets - a.gets;
    });
  }

  function refWarning(rows, amount, cur) {
    var refs = rows.map(function (x) { return Number(x.q.refAmount) || 0; }).filter(Boolean);
    if (!refs.length) return "";
    refs.sort(function (a, b) { return a - b; });
    var ref = refs[Math.floor(refs.length / 2)];
    if (amount > ref * 3 || amount < ref / 3) {
      return "Quotes were checked for " + money(ref, cur, 0) + ". Providers often change their rate or fee for much larger or smaller amounts, so confirm the final figure on their site.";
    }
    return "";
  }

  function renderRow(x, i, c) {
    var top = i === 0 && !x.stale;
    var chips = (x.q.payout || []).map(function (m) { return '<span class="chip">' + LABEL[m] + "</span>"; }).join("");
    if (top) chips = '<span class="chip best">Most money home</span>' + chips;
    if (x.stale) chips += '<span class="chip stale">Not rechecked today</span>';
    var rep = c.reports && c.reports[x.p.id];
    if (rep && rep.n >= 3) chips += '<span class="chip">Usually arrives: ' + esc(rep.typical) + " (" + rep.n + " reports)</span>";
    var costTxt = x.cost == null ? "" : (x.cost <= 0 ? "At or above the mid-market rate" : fixed(x.cost * 100, 1) + "% total cost vs mid-market");
    var sub = "Rate " + rateStr(x.ev.rate) + DOT + feeStr(x.q, c.s.currency) + (x.q.speed ? DOT + esc(x.q.speed) : "");
    var checked = x.q.checkedAt ? "Checked " + (c.timeStyle === "absolute" ? absTime(x.q.checkedAt) : ago(x.q.checkedAt, c.now)) : "";
    var extra = [checked, x.q.note ? esc(x.q.note) : ""].filter(Boolean).join(DOT);
    return '<article class="result' + (top ? " best" : "") + (x.stale ? " is-stale" : "") + '">' +
      '<div class="rank">' + (i + 1) + "</div>" +
      '<div class="prov"><div class="prov-name">' + esc(x.p.name) + (x.q.variant ? ' <span class="variant">' + esc(x.q.variant) + "</span>" : "") + "</div>" +
      '<div class="prov-sub num">' + sub + '</div><div class="chips">' + chips + "</div>" +
      (extra ? '<div class="prov-sub">' + extra + "</div>" : "") + "</div>" +
      '<div class="gets"><span class="gets-label">They get</span><span class="gets-value num">' + money(x.gets, c.r.currency) + '</span><span class="gets-cost">' + costTxt + "</span></div>" +
      '<div class="go-cell"><a class="go" href="' + esc(c.hrefFor(x.p, c.key)) + '" target="_blank" rel="sponsored nofollow noopener">Go to ' + esc(x.p.name) + "</a></div>" +
      "</article>";
  }

  function renderResults(c) {
    var html = '<p class="disclose">Some providers pay us a commission when you sign up. It never changes the order. <a href="' + esc(c.disclosureHref) + '">How we make money</a></p>';
    if (!(c.amount > 0)) return html + '<div class="empty"><strong>Enter the amount you plan to pay.</strong></div>';
    var warn = refWarning(c.rows, c.amount, c.s.currency);
    if (warn) html += '<p class="refwarn">' + esc(warn) + "</p>";
    if (c.rows.length) {
      html += '<div class="results">' + c.rows.map(function (x, i) { return renderRow(x, i, c); }).join("") + "</div>";
    } else if (c.payout && c.payout !== "all" && c.anyQuotes) {
      html += '<div class="empty"><strong>None of today\'s checked services pay out by ' + LABEL[c.payout].toLowerCase() + " on this route.</strong><span>Choose another way to receive, or check back later today.</span></div>";
    } else {
      var list = (c.checkList || []).map(function (p) {
        return '<a href="' + esc(c.hrefFor(p, c.key)) + '" target="_blank" rel="sponsored nofollow noopener">' + esc(p.name) + "</a>";
      }).join(DOT);
      html += '<div class="empty"><strong>Today\'s quotes for ' + esc(c.s.short) + " to " + esc(c.r.name) + " are being checked.</strong>" +
        "<span>We check every provider by hand each day." + (c.mid ? " Until then, the figures below show what a fair deal looks like, so you can judge any quote you get." : "") + "</span>" +
        (list ? '<span class="checklist">Services to check on this route: ' + list + "</span>" : "") + "</div>";
    }
    if (c.mid) {
      var perfect = c.amount * c.mid;
      var pct = c.avgPct;
      var avg = perfect * (1 - pct / 100);
      var top = c.rows.filter(function (x) { return !x.stale; })[0];
      var gain = top ? top.gets - avg : 0;
      html += '<div class="benchmark">' +
        '<div class="bench"><span class="k">At the mid-market rate, no fees</span><span class="v num">' + money(perfect, c.r.currency) + '</span><span class="s">The ceiling. No service beats this for long.</span></div>' +
        '<div class="bench"><span class="k">At the regional average cost (' + pct + '%)</span><span class="v num">' + money(avg, c.r.currency) + '</span><span class="s">' + esc(c.avgLabel) + "</span></div>" +
        (gain > 0 ? '<div class="bench"><span class="k">Best option vs the average</span><span class="v num">+' + money(gain, c.r.currency) + '</span><span class="s">Extra that reaches home on this transfer.</span></div>' : "") +
        "</div>";
    }
    return html;
  }

  function metaLine(c) {
    var bits = [];
    if (c.mid && c.s.currency !== c.r.currency) bits.push('Mid-market: <strong class="num">1 ' + c.s.currency + " = " + rateStr(c.mid) + " " + c.r.currency + "</strong>");
    var t = function (iso) { return c.timeStyle === "absolute" ? absTime(iso) : ago(iso, c.now); };
    if (c.midUpdated && c.s.currency !== c.r.currency) bits.push("Market rate from " + t(c.midUpdated));
    if (c.quotesUpdated) bits.push("Quotes updated " + t(c.quotesUpdated));
    return bits.map(function (b) { return "<span>" + b + "</span>"; }).join("");
  }

  function shareText(c, url) {
    return shareRaw(c, url).replace(/\u00a0/g, " ");
  }
  function shareRaw(c, url) {
    var top = c.rows.filter(function (x) { return !x.stale; })[0];
    if (top) {
      return "Sending " + money(c.amount, c.s.currency, 0) + " to " + c.r.name + "? Today " + top.p.name + " delivers " + money(top.gets, c.r.currency) +
        ", the most of " + c.rows.length + " services checked. Compare your amount: " + url;
    }
    return "Compare what actually arrives when you send money from " + c.s.short + " to " + c.r.name + ": " + url;
  }

  var api = { LABEL: LABEL, esc: esc, money: money, rateStr: rateStr, midRate: midRate, ageHours: ageHours, ago: ago, absTime: absTime,
    evaluate: evaluate, feeStr: feeStr, rank: rank, renderResults: renderResults, metaLine: metaLine, shareText: shareText };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SFRank = api;
})(typeof window !== "undefined" ? window : this);
