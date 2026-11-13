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
  // Amount with the currency code set smaller, for the big figures.
  function moneyHtml(value, currency, digits) {
    var d = digits == null ? (Math.abs(value) >= 1000 ? 0 : 2) : digits;
    return '<span class="cur">' + currency + "</span>" + fixed(value, d);
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
    // Amounts that look the same on screen count as a tie: tied services share a position.
    // Within a tie, the lower fee comes first, then the name, so the order is stable and explainable.
    var shown = function (v) { return Math.round(v * (Math.abs(v) >= 1000 ? 1 : 100)); };
    var rows = Object.keys(best).map(function (k) { return best[k]; }).sort(function (a, b) {
      if (a.stale !== b.stale) return a.stale ? 1 : -1;
      if (shown(a.gets) !== shown(b.gets)) return b.gets - a.gets;
      if (a.ev.fee !== b.ev.fee) return a.ev.fee - b.ev.fee;
      return a.p.name < b.p.name ? -1 : 1;
    });
    rows.forEach(function (x, i) {
      var prev = rows[i - 1];
      x.pos = prev && prev.stale === x.stale && shown(prev.gets) === shown(x.gets) ? prev.pos : i + 1;
    });
    rows.forEach(function (x) {
      x.tied = rows.filter(function (y) { return y.stale === x.stale && y.pos === x.pos; }).length > 1;
    });
    return rows;
  }
  // Services that share the top spot today (fresh quotes only).
  function leaders(rows) {
    var fresh = rows.filter(function (x) { return !x.stale; });
    return fresh.length ? fresh.filter(function (x) { return x.pos === fresh[0].pos; }) : [];
  }
  function names(list) {
    var n = list.map(function (x) { return x.p.name; });
    return n.length > 1 ? n.slice(0, -1).join(", ") + " and " + n[n.length - 1] : n.join("");
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

  // One compact line per service, so the whole ranking fits on screen. Notes become numbered footnotes under the table.
  var SHORT = { mobile: "Mobile money", bank: "Bank", cash: "Cash pickup" };
  function renderRow(x, i, c, fn) {
    var top = !x.stale && x.pos === 1 && c.rows.length > 1;
    var costTxt = x.cost == null ? "" : (x.cost <= 0 ? "At mid-market or better" : fixed(x.cost * 100, 1) + "% cost vs mid-market");
    var how = (x.q.payout || []).map(function (m) { return SHORT[m]; }).join(", ");
    var checked = x.q.checkedAt ? "checked " + (c.timeStyle === "absolute" ? absTime(x.q.checkedAt) : ago(x.q.checkedAt, c.now)) : "";
    var rep = c.reports && c.reports[x.p.id];
    var bits = ["Rate " + rateStr(x.ev.rate), feeStr(x.q, c.s.currency)];
    var extra = [];
    if (x.q.speed) extra.push(esc(x.q.speed));
    if (how) extra.push(how);
    if (rep && rep.n >= 3) extra.push("usually arrives " + esc(rep.typical));
    if (checked && !x.stale) extra.push(checked);
    if (extra.length) bits.push('<span class="xtra">' + extra.join(DOT) + "</span>");
    if (x.stale) bits.push('<span class="stale-txt">not rechecked today</span>');
    var mark = fn ? ' <a class="fn" href="#sf-fn-' + fn + '" aria-label="Note ' + fn + '">' + fn + "</a>" : "";
    return '<article class="result' + (top ? " best" : "") + (x.stale ? " is-stale" : "") + '">' +
      '<div class="rank"' + (x.tied ? ' title="Tied"' : "") + ">" + (x.pos || i + 1) + (x.tied ? "=" : "") + "</div>" +
      '<div class="prov"><div class="prov-name"><span>' + esc(x.p.name) + "</span>" + (x.q.variant ? '<span class="variant">' + esc(x.q.variant) + "</span>" : "") +
      (top ? '<span class="chip best">' + (x.tied ? "Joint best" : "Most money home") + "</span>" : "") + mark + "</div>" +
      '<div class="prov-sub num">' + bits.join('<span class="dot">' + DOT + "</span>") + "</div></div>" +
      '<div class="gets"><span class="gets-value num">' + moneyHtml(x.gets, c.r.currency) + '</span><span class="gets-cost">' + costTxt + "</span></div>" +
      '<div class="go-cell"><a class="go" href="' + esc(c.hrefFor(x.p, c.key)) + '" target="_blank" rel="sponsored nofollow noopener" aria-label="Go to ' + esc(x.p.name) + '">Go<span class="go-name"> to ' + esc(x.p.name) + "</span></a></div>" +
      "</article>";
  }

  function renderResults(c) {
    var html = "";
    if (!(c.amount > 0)) return '<div class="empty"><strong>Enter the amount you plan to pay.</strong></div>';
    var warn = refWarning(c.rows, c.amount, c.s.currency);
    if (c.rows.length) {
      var notes = [], idx = {};
      var rows = c.rows.map(function (x, i) {
        var n = 0;
        if (x.q.note) {
          if (!idx[x.q.note]) { notes.push({ who: x.p.name, text: x.q.note }); idx[x.q.note] = notes.length; }
          n = idx[x.q.note];
        }
        return renderRow(x, i, c, n);
      }).join("");
      html += '<div class="results" role="list"><div class="results-head" aria-hidden="true"><span></span><span>Service</span><span>They get</span><span></span></div>' + rows + "</div>";
      if (warn) html += '<p class="refwarn">' + esc(warn) + "</p>";
      html += '<div class="below"><p class="disclose">Ranked by the amount that arrives. Some providers pay us a commission when you sign up; it never changes the order. <a href="' + esc(c.disclosureHref) + '">How we make money</a></p>' +
        (notes.length ? '<ol class="notes">' + notes.map(function (n, k) { return '<li id="sf-fn-' + (k + 1) + '"><strong>' + esc(n.who) + ":</strong> " + esc(n.text) + "</li>"; }).join("") + "</ol>" : "") + "</div>";
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
        '<div class="bench"><span class="k">At the mid-market rate, no fees</span><span class="v num">' + moneyHtml(perfect, c.r.currency) + '</span><span class="s">The ceiling. No service beats this for long.</span></div>' +
        '<div class="bench"><span class="k">At the regional average cost (' + pct + '%)</span><span class="v num">' + moneyHtml(avg, c.r.currency) + '</span><span class="s">' + esc(c.avgLabel) + "</span></div>" +
        (gain > 0 ? '<div class="bench"><span class="k">Best option vs the average</span><span class="v num gain">' + moneyHtml(gain, c.r.currency).replace("</span>", "</span>+") + '</span><span class="s">Extra that reaches home on this transfer.</span></div>' : "") +
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

  // Local time in the family's city, for the phone's lock screen.
  var HOME = { nigeria: ["Lagos", "Africa/Lagos"], ghana: ["Accra", "Africa/Accra"], kenya: ["Nairobi", "Africa/Nairobi"],
    uganda: ["Kampala", "Africa/Kampala"], zambia: ["Lusaka", "Africa/Lusaka"], zimbabwe: ["Harare", "Africa/Harare"] };
  function homeTime(id, now) {
    var h = HOME[id] || ["", "UTC"], d = new Date(now), time = "", date = "";
    try {
      time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: h[1] });
      date = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: h[1] });
    } catch (e) {}
    return { city: h[0], time: time, date: date };
  }

  // The phone notification in the page header: what the family would see for today's best option.
  var NOTICE_TITLE = { mobile: "Mobile money", bank: "Bank alert", cash: "Cash pickup" };
  function notice(c) {
    var top = c.rows.filter(function (x) { return !x.stale; })[0];
    if (!(c.amount > 0)) return { title: "SendFair", text: "Enter the amount you plan to pay to see what arrives.", cap: "" };
    if (!top) return { title: "SendFair", text: "Today\u2019s quotes for " + esc(c.s.short) + " to " + esc(c.r.name) + " are being checked.", cap: "" };
    var how = c.payout && c.payout !== "all" ? c.payout : (top.q.payout || [])[0] || "mobile";
    var amt = "<b>" + esc(money(top.gets, c.r.currency, 2)) + "</b>";
    var lead = leaders(c.rows);
    var by = lead.length > 1 ? " Sent from " + esc(c.s.short) + ". " + esc(names(lead)) + " tie for the most today."
      : " Sent from " + esc(c.s.short) + " with " + esc(top.p.name) + ".";
    var text = how === "cash" ? amt + " is ready to collect." + by : "You have received " + amt + "." + by;
    var n = c.rows.length;
    var cap = "Today\u2019s best for " + esc(money(c.amount, c.s.currency, 0)) + " from " + esc(c.s.short) + " to " + esc(c.r.name) +
      (n > 1 ? ", out of " + n + " services checked." : ".");
    return { title: NOTICE_TITLE[how] || "Mobile money", text: text, cap: cap.replace(/\u00a0/g, " ") };
  }

  function shareText(c, url) {
    return shareRaw(c, url).replace(/\u00a0/g, " ");
  }
  function shareRaw(c, url) {
    var top = c.rows.filter(function (x) { return !x.stale; })[0];
    var lead = leaders(c.rows);
    if (top && lead.length > 1) {
      return "Sending " + money(c.amount, c.s.currency, 0) + " to " + c.r.name + "? Today " + names(lead) + " tie at " + money(top.gets, c.r.currency) +
        ", the most of " + c.rows.length + " services checked. Compare your amount: " + url;
    }
    if (top) {
      return "Sending " + money(c.amount, c.s.currency, 0) + " to " + c.r.name + "? Today " + top.p.name + " delivers " + money(top.gets, c.r.currency) +
        (c.rows.length > 1 ? ", the most of " + c.rows.length + " services checked" : "") + ". Compare your amount: " + url;
    }
    return "Compare what actually arrives when you send money from " + c.s.short + " to " + c.r.name + ": " + url;
  }

  var api = { LABEL: LABEL, esc: esc, money: money, rateStr: rateStr, midRate: midRate, ageHours: ageHours, ago: ago, absTime: absTime,
    evaluate: evaluate, feeStr: feeStr, rank: rank, renderResults: renderResults, metaLine: metaLine, shareText: shareText, notice: notice, moneyHtml: moneyHtml, homeTime: homeTime, leaders: leaders, names: names };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SFRank = api;
})(typeof window !== "undefined" ? window : this);
