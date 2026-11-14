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

  // What you'd pay in total so that `target` arrives (the reverse of evaluate).
  function payFor(q, target) {
    var rate = Number(q.rate);
    if (!(rate > 0) || !(target > 0)) return null;
    var f = feeParts(q);
    return (target / rate) * (1 + f.pct / 100) + f.fixed;
  }
  // Ranks by what arrives for `amount`, or, with `target`, by the least you pay for `target` to arrive.
  function rank(o) {
    var best = {}, target = o.target > 0 ? o.target : 0;
    var score = function (x) { return target ? -Math.round(x.pay * 100) : shown(x.gets); };
    var shown = function (v) { return Math.round(v * (Math.abs(v) >= 1000 ? 1 : 100)); };
    (o.list || []).forEach(function (q) {
      var age = ageHours(q.checkedAt, o.now);
      if (age > o.hideH) return;
      if (o.payout && o.payout !== "all" && (q.payout || []).indexOf(o.payout) === -1) return;
      var pay = target ? payFor(q, target) : o.amount;
      var ev = pay ? evaluate(q, pay) : null;
      if (!ev) return;
      var p = o.providers[q.provider];
      if (!p) return;
      var row = { q: q, p: p, ev: ev, gets: ev.gets, pay: pay, age: age, stale: age > o.staleH, cost: o.mid ? 1 - ev.gets / (pay * o.mid) : null };
      var cur = best[q.provider];
      if (!cur || (cur.stale && !row.stale) || (cur.stale === row.stale && score(row) > score(cur))) best[q.provider] = row;
    });
    // Amounts that look the same on screen count as a tie: tied services share a position.
    // Within a tie, the lower fee comes first, then the name, so the order is stable and explainable.
    var rows = Object.keys(best).map(function (k) { return best[k]; }).sort(function (a, b) {
      if (a.stale !== b.stale) return a.stale ? 1 : -1;
      if (score(a) !== score(b)) return score(b) - score(a);
      if (a.ev.fee !== b.ev.fee) return a.ev.fee - b.ev.fee;
      return a.p.name < b.p.name ? -1 : 1;
    });
    rows.forEach(function (x, i) {
      var prev = rows[i - 1];
      x.pos = prev && prev.stale === x.stale && score(prev) === score(x) ? prev.pos : i + 1;
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

  // Badge per service: the service's own icon (served from /logos/), with coloured initials underneath
  // that show if the icon can't load.
  var HUES = ["#3b46b8", "#0a7a5c", "#8a3c8f", "#b0522a", "#5f6b1f", "#2f6f9f", "#9a3651", "#6b4fb3"];
  function initials(name) {
    var w = String(name).replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || "?").slice(0, 2)).toUpperCase();
  }
  function badge(p, cls) {
    return '<span class="avatar' + (cls ? " " + cls : "") + '" aria-hidden="true" style="background:' + hue(p.id) + '">' + initials(p.name) +
      '<img src="/logos/' + esc(p.id) + '.png" alt="" width="22" height="22" loading="lazy" decoding="async" onerror="this.remove()"></span>';
  }
  function hue(id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return HUES[h % HUES.length]; }
  // Notes that say the same thing for most services are summed up once under the table instead of as footnotes.
  var GENERAL_NOTE = /^(Standard rate;|Fee read at two amounts)/;
  // Where senders can check a provider's licence, by sending country.
  var REGISTER = {
    uk: ["the FCA register", "https://register.fca.org.uk/"],
    us: ["FinCEN's MSB search", "https://www.fincen.gov/msb-registrant-search"],
    canada: ["FINTRAC's MSB registry", "https://fintrac-canafe.canada.ca/msb-esm/reg-eng"],
    australia: ["AUSTRAC's remittance register", "https://www.austrac.gov.au/remittance-sector-register-and-remittance-registration-actions"],
    uae: ["the Central Bank of the UAE", "https://www.centralbank.ae/", "by"],
    saudi: ["the Saudi Central Bank (SAMA)", "https://www.sama.gov.sa/", "by"],
    qatar: ["Qatar Central Bank", "https://www.qcb.gov.qa/", "by"],
    kuwait: ["the Central Bank of Kuwait", "https://www.cbk.gov.kw/", "by"],
    bahrain: ["the Central Bank of Bahrain", "https://www.cbb.gov.bh/", "by"],
    oman: ["the Central Bank of Oman", "https://cbo.gov.om/", "by"]
  };

  // One compact line per service, so the whole ranking fits on screen. Notes become numbered footnotes under the table.
  var SHORT = { mobile: "Mobile money", bank: "Bank", cash: "Cash pickup" };
  function renderRow(x, i, c, fn) {
    var top = !x.stale && x.pos === 1 && c.rows.length > 1;
    var pid = "sf-more-" + x.p.id + (x.q.variant ? "-" + String(x.q.variant).toLowerCase().replace(/[^a-z0-9]+/g, "-") : "");
    var open = !!(c.open && c.open[pid]);
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
      '<div class="prov"><div class="prov-name">' + badge(x.p) + '<span>' + esc(x.p.name) + "</span>" + (x.q.variant ? '<span class="variant">' + esc(x.q.variant) + "</span>" : "") +
      (top ? '<span class="chip best">' + (x.tied ? "Joint best" : c.target ? "Cheapest" : "Most money home") + "</span>" : "") + mark +
      (x.p.rating ? '<a class="tp" href="' + esc(x.p.rating.url) + '" target="_blank" rel="noopener" title="Trustpilot: ' + x.p.rating.score + " out of 5 from " + fixed(x.p.rating.reviews, 0) + ' reviews"><span aria-hidden="true">★</span> ' + x.p.rating.score + "</a>" : "") +
      '<button type="button" class="more-btn" aria-expanded="' + open + '" aria-controls="' + pid + '"><span class="more-txt">Details</span><span aria-hidden="true" class="chev">▾</span></button>' + "</div>" +
      '<div class="prov-sub num">' + bits.join('<span class="dot">' + DOT + "</span>") + "</div></div>" +
      (c.target
        ? '<div class="gets"><span class="gets-value num">' + moneyHtml(x.pay, c.s.currency) + "</span>" +
          (top && c.low && c.low.pay - x.pay >= 0.01 ? '<span class="gets-save num">' + esc(money(c.low.pay - x.pay, c.s.currency, 2)) + " less than the dearest</span>" : '<span class="gets-cost">' + costTxt + "</span>") + "</div>"
        : '<div class="gets"><span class="gets-value num">' + moneyHtml(x.gets, c.r.currency) + "</span>" +
          (top && c.low && x.gets - c.low.gets >= 1 ? '<span class="gets-save num">' + esc(money(x.gets - c.low.gets, c.r.currency)) + " more than the lowest</span>" : '<span class="gets-cost">' + costTxt + "</span>") + "</div>") +
      '<div class="go-cell"><a class="go" href="' + esc(c.hrefFor(x.p, c.key)) + '" target="_blank" rel="sponsored nofollow noopener" aria-label="Go to ' + esc(x.p.name) + '">Go<span class="go-name"> to ' + esc(x.p.name) + "</span></a></div>" +
      details(x, c, pid, open) +
      "</article>";
  }

  // The "Details" panel: how the amount is worked out, ways to receive and pay, speed, rating, notes.
  function details(x, c, pid, open) {
    var cur = c.s.currency, f = feeParts(x.q);
    var maths = money(x.pay || c.amount, cur, 2) + " you pay" +
      (x.ev.fee > 0.004 ? " − " + money(x.ev.fee, cur, 2) + " fee" + (f.pct && f.fixed ? " (" + fixed(f.pct, 2) + "% + " + money(f.fixed, cur, 2) + ")" : "") : ", no fee") +
      " = " + money(x.ev.sent, cur, 2) + " converted at " + rateStr(x.ev.rate) + " = " + money(x.gets, c.r.currency, 2);
    var items = [
      ["How it adds up", esc(maths)],
      ["They can receive by", esc((x.q.payout || []).map(function (m) { return LABEL[m]; }).join(", ") || "Not stated")],
      ["Delivery time", esc(x.q.speed || "Not shown by the provider for this route")],
      ["Ways to pay", esc((x.p.payIn || []).join(", ") || "See the provider's site") + ((x.p.payIn || []).some(function (m) { return /credit/i.test(m); }) ? ". Card payments can cost more; the rate above assumes the provider's standard method." : "")],
      ["Rating", x.p.rating ? '<a href="' + esc(x.p.rating.url) + '" target="_blank" rel="noopener">Trustpilot ' + x.p.rating.score + "/5</a> (" + esc(x.p.rating.label) + ", " + fixed(x.p.rating.reviews, 0) + " reviews)" : "Not rated yet"],
      ["Checked", x.q.checkedAt ? esc(absTime(x.q.checkedAt)) + " for " + esc(money(Number(x.q.refAmount) || c.amount, cur, 0)) : ""]
    ];
    if (x.q.note) items.push(["Note", esc(x.q.note)]);
    return '<div class="more" id="' + pid + '"' + (open ? "" : " hidden") + '><dl>' + items.filter(function (it) { return it[1]; }).map(function (it) { return "<div><dt>" + it[0] + "</dt><dd>" + it[1] + "</dd></div>"; }).join("") + "</dl></div>";
  }

  // Quick picks above the ranking: best service per way of receiving, and the fastest where speeds are known.
  function picks(c) {
    var all = (c.allRows || c.rows).filter(function (x) { return !x.stale; });
    if (all.length < 2) return "";
    var out = [];
    ["mobile", "bank", "cash"].forEach(function (m) {
      var best = all.filter(function (x) { return (x.q.payout || []).indexOf(m) > -1; })[0];
      if (best) out.push('<button type="button" class="pick" data-payout="' + m + '" title="Show only ' + LABEL[m].toLowerCase() + ' services"><span class="pick-k">Best by ' + LABEL[m].toLowerCase() + '</span><span class="pick-v">' + esc(best.p.name) + ' <span class="pick-n num">' + esc(c.target ? money(best.pay, c.s.currency, 2) : fixed(best.gets, best.gets >= 1000 ? 0 : 2)) + "</span></span></button>");
    });
    var fast = all.filter(function (x) { return /minute|instant|second/i.test(x.q.speed || ""); })[0];
    if (fast) out.push('<span class="pick"><span class="pick-k">Fastest</span><span class="pick-v">' + esc(fast.p.name) + ' <span class="pick-n">' + esc(fast.q.speed) + "</span></span></span>");
    return out.join("");
  }

  // Tiny line chart of the mid-market rate over recent days (needs 3+ days).
  function spark(hist) {
    var pts = (hist || []).filter(function (h) { return h.mid; });
    if (pts.length < 3) return "";
    var v = pts.map(function (h) { return h.mid; }), lo = Math.min.apply(null, v), hi = Math.max.apply(null, v), w = 84, h = 18;
    var d = v.map(function (y, i) { return (i ? "L" : "M") + (i * w / (v.length - 1)).toFixed(1) + " " + (hi === lo ? h / 2 : h - 2 - (y - lo) / (hi - lo) * (h - 4)).toFixed(1); }).join(" ");
    return ' <svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="Mid-market rate over the last ' + v.length + ' days"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }

  function renderResults(c) {
    var html = "";
    if (c.target === 0 || !(c.amount > 0 || c.target > 0)) return '<div class="empty"><strong>' + (c.target != null ? "Enter the amount they need to receive." : "Enter the amount you plan to pay.") + "</strong></div>";
    var warn = refWarning(c.rows, c.target ? (c.rows[0] ? c.rows[0].pay : 0) : c.amount, c.s.currency);
    if (c.rows.length) {
      var notes = [], idx = {};
      var fresh = c.rows.filter(function (x) { return !x.stale; });
      c.low = fresh.length > 1 ? fresh[fresh.length - 1] : null;
      var rows = c.rows.map(function (x, i) {
        var n = 0;
        if (x.q.note && !GENERAL_NOTE.test(x.q.note)) {
          if (!idx[x.q.note]) { notes.push({ who: x.p.name, text: x.q.note }); idx[x.q.note] = notes.length; }
          n = idx[x.q.note];
        }
        return renderRow(x, i, c, n);
      }).join("");
      html += '<div class="results" role="list"><div class="results-head" aria-hidden="true"><span></span><span>Service</span><span>' + (c.target ? "You pay" : "They get") + '</span><span></span></div>' + rows + "</div>";
      if (warn) html += '<p class="refwarn">' + esc(warn) + "</p>";
      var reg = REGISTER[c.s.id];
      html += '<div class="below"><p class="disclose">' + (c.target ? "Ranked by the least you pay for " + esc(money(c.target, c.r.currency)) + " to arrive" : "Ranked by the amount that arrives") + ', using standard rates (first-transfer offers are left out). Some providers pay us a commission when you sign up; it never changes the order. <a href="' + esc(c.disclosureHref) + '">How we make money</a></p>' +
        (reg ? '<p class="disclose">Before you send, check the service is licensed ' + (reg[2] || "on") + ' <a href="' + reg[1] + '" target="_blank" rel="noopener">' + reg[0] + "</a>.</p>" : "") +
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
    if (c.mid && c.target) {
      var ideal = c.target / c.mid, avgPay = ideal / (1 - c.avgPct / 100);
      var cheapest = c.rows.filter(function (x) { return !x.stale; })[0];
      var saved = cheapest ? avgPay - cheapest.pay : 0;
      html += '<div class="benchmark">' +
        '<div class="bench"><span class="k">At the mid-market rate, no fees</span><span class="v num">' + moneyHtml(ideal, c.s.currency) + '</span><span class="s">The least it could ever cost.</span></div>' +
        '<div class="bench"><span class="k">At the regional average cost (' + c.avgPct + '%)</span><span class="v num">' + moneyHtml(avgPay, c.s.currency) + '</span><span class="s">' + esc(c.avgLabel) + "</span></div>" +
        (saved > 0 ? '<div class="bench"><span class="k">Cheapest option vs the average</span><span class="v num gain">' + moneyHtml(saved, c.s.currency) + '</span><span class="s">Kept in your pocket on this transfer.</span></div>' : "") +
        "</div>";
    } else if (c.mid) {
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
    if (c.mid && c.s.currency !== c.r.currency) {
      var trend = "";
      if (c.midPrev) {
        var ch = c.mid / c.midPrev - 1;
        var since = c.midPrevAt ? " vs " + (c.timeStyle === "absolute" ? absTime(c.midPrevAt) : ago(c.midPrevAt, c.now)) : "";
        trend = Math.abs(ch) < 0.0005 ? ' <span class="trend">no change' + since + "</span>"
          : ' <span class="trend ' + (ch > 0 ? "up" : "down") + '" title="' + (ch > 0 ? "More " + c.r.currency + " per " + c.s.currency : "Fewer " + c.r.currency + " per " + c.s.currency) + '">' + (ch > 0 ? "▲ " : "▼ ") + fixed(Math.abs(ch) * 100, 1) + "%" + since + "</span>";
      }
      bits.push('Mid-market: <strong class="num">1 ' + c.s.currency + " = " + rateStr(c.mid) + " " + c.r.currency + "</strong>" + trend + spark(c.hist));
    }
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
    if (!(c.amount > 0) && !(c.target > 0)) return { title: "SendFair", text: "Enter an amount to see what arrives.", cap: "" };
    if (!top) return { title: "SendFair", text: "Today\u2019s quotes for " + esc(c.s.short) + " to " + esc(c.r.name) + " are being checked.", cap: "" };
    var how = c.payout && c.payout !== "all" ? c.payout : (top.q.payout || [])[0] || "mobile";
    var amt = "<b>" + esc(money(top.gets, c.r.currency, 2)) + "</b>";
    var lead = leaders(c.rows);
    var by = c.target ? " Sent from " + esc(c.s.short) + " with " + esc(top.p.name) + " for " + esc(money(top.pay, c.s.currency, 2)) + "."
      : lead.length > 1 ? " " + (lead.length === 2 ? esc(names(lead)) + " tie" : lead.length + " services tie") + " for the most today."
      : " Sent from " + esc(c.s.short) + " with " + esc(top.p.name) + ".";
    var text = how === "cash" ? amt + " is ready to collect." + by : "You have received " + amt + "." + by;
    var n = c.rows.length;
    var cap = c.target ? "Today\u2019s cheapest way to get " + esc(money(c.target, c.r.currency, 0)) + " to " + esc(c.r.name) + (n > 1 ? ", out of " + n + " services checked." : ".") : "Today\u2019s best for " + esc(money(c.amount, c.s.currency, 0)) + " from " + esc(c.s.short) + " to " + esc(c.r.name) +
      (n > 1 ? ", out of " + n + " services checked." : ".");
    if (c.target) return { title: NOTICE_TITLE[how] || "Mobile money", text: text, cap: cap.replace(/\u00a0/g, " ") };
    return { title: NOTICE_TITLE[how] || "Mobile money", text: text, cap: cap.replace(/\u00a0/g, " ") };
  }

  function shareText(c, url) {
    return shareRaw(c, url).replace(/\u00a0/g, " ");
  }
  function shareRaw(c, url) {
    var top = c.rows.filter(function (x) { return !x.stale; })[0];
    var lead = leaders(c.rows);
    if (top && c.target) {
      return "Need " + money(c.target, c.r.currency) + " to arrive in " + c.r.name + "? Today " + top.p.name + " gets it there for " + money(top.pay, c.s.currency, 2) +
        (c.rows.length > 1 ? ", the least of " + c.rows.length + " services checked" : "") + ". Compare: " + url;
    }
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
    evaluate: evaluate, payFor: payFor, feeStr: feeStr, rank: rank, renderResults: renderResults, metaLine: metaLine, shareText: shareText, notice: notice, moneyHtml: moneyHtml, homeTime: homeTime, leaders: leaders, names: names, picks: picks, spark: spark, badge: badge };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SFRank = api;
})(typeof window !== "undefined" ? window : this);
