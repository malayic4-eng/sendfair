/* SendFair ranking engine. Shared by the build script (page HTML) and the browser (live re-ranking).
   Quote fields: provider, variant, rate, feeFixed, feePct, payout[], speed, note, refAmount, checkedAt.
   Older quotes with a single "fee" field are read as feeFixed. */
(function (root) {
  "use strict";
  var LABEL = { mobile: "Mobile money", bank: "Bank", cash: "Cash pickup" };
  var PAYIN = { all: "Any", bank: "Bank transfer", card: "Card", cash: "Cash at an agent" };
  var DOT = " · ";
  var SSA = { nigeria: 1, ghana: 1, kenya: 1, uganda: 1, zambia: 1, zimbabwe: 1, senegal: 1, ivorycoast: 1, mali: 1, cameroon: 1, ethiopia: 1, southafrica: 1, tanzania: 1, drc: 1, rwanda: 1 };
  function isAuto(q) { return !!(q && (q.source === "wise-feed" || q.source === "worldremit" || q.source === "scrape" || /^Updated automatically from/.test(q.note || ""))); }
  function sourceLabel(q) {
    var s = q && q.source;
    if (s === "worldremit") return "WorldRemit's website";
    if (s === "scrape") return "the provider's website";
    return "Wise's comparison data";
  }
  function payMethodOf(q, p) {
    if (q && q.payMethod && q.payMethod !== "any") return q.payMethod;
    var list = (p && p.payIn) || [];
    var onlyCard = list.length && list.every(function (m) { return /card|debit|apple pay|google pay/i.test(m); }) && !list.some(function (m) { return /bank/i.test(m); });
    return onlyCard ? "card" : (q && q.payMethod) || "any";
  }

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
  // When the mid-market rate for src -> tgt was read: the older of the two currencies' times
  // (mid.rateAt per currency when the build applied Wise corrections, else the file's own time).
  function midAt(mid, src, tgt) {
    if (!mid) return null;
    var at = mid.rateAt || {}, base = mid.base || "USD", out = null;
    [src, tgt].forEach(function (c) {
      if (!c || c === base) return;
      var t = at[c] || mid.updatedAt;
      if (t && (!out || t < out)) out = t;
    });
    return out || mid.overrideAt || mid.updatedAt || null;
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
  // Rate and fee read at several amounts (feed "tiers": [{amount, rate, fee}]). Needs two or more valid points.
  function cleanTiers(t) {
    if (!t || !t.length) return null;
    var out = [], seen = {};
    for (var i = 0; i < t.length; i++) {
      var x = t[i], a = x && Number(x.amount), r = x && Number(x.rate), f = x && Number(x.fee || 0);
      if (!(a > 0) || !(r > 0) || !isFinite(f) || f < 0 || seen[a]) continue;
      seen[a] = 1;
      out.push({ amount: a, rate: r, fee: f });
    }
    out.sort(function (a, b) { return a.amount - b.amount; });
    return out.length > 1 ? out : null;
  }
  // Rate from the tier nearest the amount; fee interpolated between the neighbouring tiers (straight line
  // through the nearest two outside the range), never below 0. covered: within a factor 3 of the checked range,
  // the same tolerance the single-amount warning uses.
  function tierAt(tiers, amount) {
    var t = cleanTiers(tiers);
    if (!t || !(amount > 0)) return null;
    var near = t[0];
    t.forEach(function (x) { if (Math.abs(x.amount - amount) < Math.abs(near.amount - amount)) near = x; });
    var i = 0;
    while (i < t.length - 2 && amount > t[i + 1].amount) i++;
    var a = t[i], b = t[i + 1];
    var fee = a.fee + (b.fee - a.fee) * (amount - a.amount) / (b.amount - a.amount);
    var min = t[0].amount, max = t[t.length - 1].amount;
    return { rate: near.rate, fee: Math.max(0, fee), at: near.amount, min: min, max: max, covered: amount >= min / 3 && amount <= max * 3 };
  }
  // "You pay in total" model: total = sent + fixed fee + pct% of sent.
  function evaluate(q, amount, o) {
    var tier = q && q.tiers ? tierAt(q.tiers, amount) : null;
    var base = tier && !q.promoApplied ? tier.rate : Number(q.rate); // a first-transfer rate keeps its own rate
    var rate = base;
    if (o && o.customer === "new" && q.promo && Number(q.promo.rate) > 0) {
      var cap = Number(q.promo.cap) || 0;
      if (!cap || amount <= cap) rate = Number(q.promo.rate);
    }
    if (!(rate > 0) || !(amount > 0)) return null;
    var f = tier ? { fixed: tier.fee, pct: 0 } : feeParts(q);
    var sent = (amount - f.fixed) / (1 + f.pct / 100);
    if (!(sent > 0)) return null;
    return { sent: sent, fee: amount - sent, gets: sent * rate, rate: rate, feeFixed: f.fixed, feePct: f.pct, promo: rate !== base, tier: tier };
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
    var pay = (target / rate) * (1 + f.pct / 100) + f.fixed;
    if (q.tiers && cleanTiers(q.tiers)) {
      // The fee and rate depend on the amount paid: settle on it in a few steps.
      for (var i = 0; i < 6; i++) {
        var t = tierAt(q.tiers, pay);
        if (!t) break;
        var next = target / t.rate + t.fee;
        if (Math.abs(next - pay) < 0.005) { pay = next; break; }
        pay = next;
      }
    }
    return pay;
  }
  // Ranks by what arrives for `amount`, or, with `target`, by the least you pay for `target` to arrive.
  function rank(o) {
    var best = {}, target = o.target > 0 ? o.target : 0;
    var score = function (x) { return target ? -Math.round(x.pay * 100) : shown(x.gets); };
    var shown = function (v) { return Math.round(v * (Math.abs(v) >= 1000 ? 1 : 100)); };
    var list = mergeFeed(o.list, o.feed, o);
    var suspect = midSuspect(list, o);
    list.forEach(function (q) {
      if (o.promo) q = withPromo(q);
      var p = o.providers[q.provider];
      if (!p) return;
      if (!payInOk(p, o.payIn, q)) return;
      var age = ageHours(q.checkedAt, o.now);
      if (age > o.hideH) return;
      if (o.payout && o.payout !== "all" && (q.payout || []).indexOf(o.payout) === -1) return;
      var pay = target ? payFor(q, target) : o.amount;
      var ev = pay ? evaluate(q, pay, o) : null;
      if (!ev) return;
      // An automatic rate well above mid-market is usually a parsing error, unless the mid-market
      // reference itself looks out of date (most automatic quotes are above it): then keep every row.
      if (o.mid && !suspect && isAuto(q) && ev.rate > o.mid * 1.015) return;
      var row = { q: q, p: p, ev: ev, gets: ev.gets, pay: pay, age: age, stale: age > o.staleH, cost: o.mid && !suspect ? 1 - ev.gets / (pay * o.mid) : null };
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
    if (suspect) rows.midSuspect = true;
    return rows;
  }
  // True when the mid-market reference looks wrong for this route: more than half of the fresh automatic
  // quotes (at least two) are above mid × 1.015. Their own rates cannot all be parsing errors; the reference
  // (e.g. a free feed that lags a devaluation) is the likelier culprit.
  function midSuspect(list, o) {
    if (!o.mid) return false;
    var amount = o.amount > 0 ? o.amount : (o.refAmount || 0);
    var n = 0, above = 0;
    list.forEach(function (q) {
      if (!isAuto(q) || ageHours(q.checkedAt, o.now) > o.staleH) return;
      var ev = amount > 0 ? evaluate(q, amount) : (Number(q.rate) > 0 ? { rate: Number(q.rate) } : null);
      if (!ev) return;
      n++;
      if (ev.rate > o.mid * 1.015) above++;
    });
    return n >= 2 && above / n > 0.5;
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

  // Warns only about rows whose price was not read near this amount: rows with tiers covering the
  // amount are left out; an uncovered tiered row counts with its nearest checked amount.
  function refWarning(rows, amount, cur) {
    var refs = rows.map(function (x) {
      var t = x.ev && x.ev.tier;
      if (t) return t.covered ? 0 : (amount > t.max ? t.max : t.min);
      return Number(x.q.refAmount) || 0;
    }).filter(Boolean);
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
    return '<span class="avatar' + (cls ? " " + cls : "") + '" aria-hidden="true" data-initials="' + esc(initials(p.name)) + '" style="background:' + hue(p.id) + '">' +
      '<picture><source srcset="/logos/' + esc(p.id) + '-22.avif 22w, /logos/' + esc(p.id) + '-44.avif 44w" sizes="22px" type="image/avif"><source srcset="/logos/' + esc(p.id) + '-22.webp 22w, /logos/' + esc(p.id) + '-44.webp 44w" sizes="22px" type="image/webp"><img src="/logos/' + esc(p.id) + '.png" alt="' + esc(p.name) + ' logo" width="22" height="22" loading="lazy" decoding="async" onerror="this.remove()"></picture></span>';
  }
  function hue(id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return HUES[h % HUES.length]; }
  // Notes that say the same thing for most services are summed up once under the table instead of as footnotes.
  var VARIANT_HINT = {
    "card deposit": "Paid straight onto the recipient's bank card (Visa or Mastercard), usually within minutes",
    "mobile money": "Paid into a mobile money wallet such as M-Pesa or MTN MoMo",
    "bank": "Paid into the recipient's bank account",
    "cash pickup": "Collected in cash at an agent",
    "express": "Faster delivery, usually for a higher fee or lower rate",
    "economy": "Slower delivery, usually for a better rate or lower fee"
  };
  function variantHint(v) { return VARIANT_HINT[String(v || "").toLowerCase()] || ""; }
  var GENERAL_NOTE = /^(Standard rate;|Fee read at (two amounts|the reference amount)|Updated automatically from|No transfer fees shown|Payout method not shown)/;
  function promoRate(q) {
    if (Number(q.promoRate) > 0) return Number(q.promoRate);
    var n = q.note || "";
    var m = n.match(/welcome rate\s+([\d.]+)/i) || n.match(/intro \(first-transfer\) rate\s+([\d.]+)/i);
    return m ? Number(m[1]) : 0;
  }
  function withPromo(q) {
    var r = promoRate(q);
    if (!(r > 0)) return q;
    var o = {};
    for (var k in q) o[k] = q[k];
    o.rate = r;
    o.promoApplied = true;
    return o;
  }
  function payInOk(p, want, q) {
    if (!want || want === "all") return true;
    var method = payMethodOf(q, p);
    if (method === want) return true;
    if (method !== "any") return false;
    var list = (p && p.payIn) || [];
    if (!list.length) return true;
    var re = want === "bank" ? /bank/i : want === "card" ? /card|debit|credit|apple|google/i : /cash|agent/i;
    return list.some(function (m) { return re.test(m); });
  }
  // After a few hours, a newer automatic quote replaces the hand check for that provider.
  // o.country (receiver ISO2) and o.sharedCurrency (the receive currency is used by more than one receiving
  // country): a feed row for a shared currency counts only when it is marked with this country, because a
  // currency-only quote may be priced for a different country (USD to Zimbabwe vs USD to DR Congo).
  // o.feedTiers: { provider: [{amount, rate, fee}] } for this route (wise-feed.json "tiers").
  function feedCountryOk(f, o) {
    if (!o || !o.country) return true;
    if (f.country && f.country !== o.country) return false;
    if (o.sharedCurrency && f.country !== o.country) return false;
    return true;
  }
  function mergeFeed(list, feed, o) {
    var now = o.now, lockH = o.handLockH == null ? 6 : o.handLockH, hideH = o.hideH, amount = o.refAmount || o.amount;
    list = (list || []).filter(function (q) {
      // A published Wise-feed quote on a shared-currency route must carry this country too.
      return !(q && q.source === "wise-feed" && !feedCountryOk({ country: q.country }, o));
    });
    if (!feed) return list;
    Object.keys(feed).forEach(function (id) {
      var f = feed[id];
      if (!(f && Number(f.rate) > 0 && f.collected)) return;
      if (!feedCountryOk(f, o)) return;
      var feedAge = ageHours(f.collected, now);
      if (feedAge > hideH) return;
      var mine = list.filter(function (q) { return q.provider === id; });
      var hands = mine.filter(function (q) { return !isAuto(q); });
      var newestHand = hands.sort(function (a, b) { return ageHours(a.checkedAt, now) - ageHours(b.checkedAt, now); })[0];
      if (newestHand && ageHours(newestHand.checkedAt, now) <= lockH) return;
      var payout = [];
      mine.forEach(function (q) { (q.payout || []).forEach(function (m) { if (payout.indexOf(m) < 0) payout.push(m); }); });
      var speed = f.speed || (hands.filter(function (q) { return q.speed; })[0] || {}).speed || "";
      // Tiers: passed in, on the feed row, or kept from the published quote of the same collection.
      var same = mine.filter(function (q) { return isAuto(q) && q.checkedAt === f.collected && q.tiers; })[0];
      var tiers = (o.feedTiers && o.feedTiers[id]) || f.tiers || (same && same.tiers) || null;
      var nq = {
        provider: id, variant: "", rate: Number(f.rate), feeFixed: Number(f.fee) || 0, feePct: 0,
        payout: payout.length ? payout : ["bank"], speed: speed,
        note: "Updated automatically from " + sourceLabel({ source: "wise-feed" }) + "; confirm on the provider's site",
        refAmount: amount, checkedAt: f.collected, source: "wise-feed"
      };
      if (cleanTiers(tiers)) nq.tiers = tiers;
      if (f.country) nq.country = f.country;
      list = list.filter(function (q) { return q.provider !== id; });
      list.push(nq);
    });
    return list;
  }
  // Where senders can check a provider's licence, by sending country.
  var REGISTER = {
    uk: ["the FCA register", "https://register.fca.org.uk/"],
    us: ["FinCEN's MSB search", "https://www.fincen.gov/msb-registrant-search"],
    canada: ["FINTRAC's MSB registry", "https://fintrac-canafe.canada.ca/msb-esm/reg-eng"],
    europe: ["the EBA register of payment institutions", "https://euclid.eba.europa.eu/register/pir/search"],
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
    var costTxt = x.cost == null ? "" : (x.cost <= 0 ? "Above the mid-market rate — please check" : fixed(x.cost * 100, 1) + "% cost vs mid-market");
    var how = (x.q.payout || []).map(function (m) { return SHORT[m]; }).join(", ");
    var checked = x.q.checkedAt ? "checked " + (c.timeStyle === "absolute" ? absTime(x.q.checkedAt) : ago(x.q.checkedAt, c.now)) : "";
    var rep = c.reports && c.reports[x.p.id];
    var tier = x.ev.tier;
    var bits = (x.q.variant ? ['<span class="variant-sub">' + esc(x.q.variant) + "</span>"] : []).concat(["Rate " + rateStr(x.ev.rate), feeStr(tier ? { feeFixed: x.ev.feeFixed, feePct: 0 } : x.q, c.s.currency)]);
    var extra = [];
    if (x.q.speed) extra.push(esc(x.q.speed));
    if (how) extra.push(how);
    if (rep && rep.n >= 3) extra.push("usually arrives " + esc(rep.typical));
    if (checked) extra.push(checked + (isAuto(x.q) ? " (auto)" : " (hand-checked)"));
    var ref = Number(x.q.refAmount) || 0, shownAmt = x.pay || c.amount;
    if (tier) { if (!tier.covered) bits.push('<span class="ref-txt" title="The rate and fee were read for other amounts; they can differ for yours">checked for ' + esc(money(tier.min, c.s.currency, 0)) + "–" + esc(money(tier.max, c.s.currency, 0)) + "</span>"); }
    else if (ref && shownAmt > 0 && Math.abs(shownAmt - ref) / ref > 0.15) bits.push('<span class="ref-txt" title="The rate and fee were read for this amount; they can differ for yours">checked for ' + esc(money(ref, c.s.currency, 0)) + "</span>");
    if (extra.length) bits.push('<span class="xtra">' + extra.join(DOT) + "</span>");
    if (x.stale) bits.push('<span class="stale-txt">not rechecked today</span>');
    var mark = fn ? ' <a class="fn" href="#sf-fn-' + fn + '" aria-label="Footnote ' + fn + ' about ' + esc(x.p.name) + '">' + fn + "</a>" : "";
    return '<article class="result' + (top ? " best" : "") + (x.stale ? " is-stale" : "") + '">' +
      '<div class="rank"' + (x.tied ? ' title="Tied"' : "") + ">" + (x.pos || i + 1) + (x.tied ? "=" : "") + "</div>" +
      '<div class="prov"><div class="prov-name notranslate">' + badge(x.p) + '<span>' + esc(x.p.name) + "</span>" + (x.q.variant ? '<span class="variant"' + (variantHint(x.q.variant) ? ' title="' + esc(variantHint(x.q.variant)) + '"' : "") + ">" + esc(x.q.variant) + "</span>" : "") +
      (top ? '<span class="chip best">' + (x.tied ? "Joint best" : c.target ? "Cheapest" : "Most money home") + "</span>" : "") + mark +
      (x.p.rating ? '<a class="tp" href="' + esc(x.p.rating.url) + '" target="_blank" rel="noopener" title="Trustpilot: ' + x.p.rating.score + " out of 5 from " + fixed(x.p.rating.reviews, 0) + ' reviews"><span aria-hidden="true">★</span> ' + x.p.rating.score + "</a>" : (x.p.ratingUrl ? '<a class="tp" href="' + esc(x.p.ratingUrl) + '" target="_blank" rel="noopener" title="Trustpilot reviews">Trustpilot</a>' : "")) +
      '<button type="button" class="more-btn" aria-expanded="' + open + '" aria-controls="' + pid + '"><span class="more-txt">Details</span><span aria-hidden="true" class="chev">▾</span></button>' + "</div>" +
      '<div class="prov-sub num">' + bits.join('<span class="dot">' + DOT + "</span>") + "</div></div>" +
      (c.target
        ? '<div class="gets notranslate"><span class="gets-value num">' + moneyHtml(x.pay, c.s.currency) + "</span>" +
          (top && c.low && c.low.pay - x.pay >= 0.01 ? '<span class="gets-save num">' + esc(money(c.low.pay - x.pay, c.s.currency, 2)) + " less than the dearest</span>" : '<span class="gets-cost">' + costTxt + "</span>") + "</div>"
        : '<div class="gets notranslate"><span class="gets-value num">' + moneyHtml(x.gets, c.r.currency) + "</span>" +
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
      ["Rating", x.p.rating ? '<a href="' + esc(x.p.rating.url) + '" target="_blank" rel="noopener">Trustpilot ' + x.p.rating.score + "/5</a> (" + esc(x.p.rating.label) + ", " + fixed(x.p.rating.reviews, 0) + " reviews)" : (x.p.ratingUrl ? '<a href="' + esc(x.p.ratingUrl) + '" target="_blank" rel="noopener">Trustpilot</a> (open to read current reviews)' : "Not rated yet")],
      ["Checked", x.q.checkedAt ? esc(absTime(x.q.checkedAt)) + " for " + (x.ev.tier ? esc(money(x.ev.tier.min, cur, 0)) + " to " + esc(money(x.ev.tier.max, cur, 0)) + " (fee for your amount worked out between those)" : esc(money(Number(x.q.refAmount) || c.amount, cur, 0))) + (isAuto(x.q) ? ", automatically from " + sourceLabel(x.q) : ", by hand on the provider's site") : ""]
    ];
    if (x.q.variant) items.splice(1, 0, ["Option", esc(x.q.variant) + (variantHint(x.q.variant) ? ": " + esc(variantHint(x.q.variant).charAt(0).toLowerCase() + variantHint(x.q.variant).slice(1)) : "")]);
    if (x.q.note) items.push(["Note", esc(String(x.q.note).replace(/\s*;\s*;/g, ". ").replace(/\.\s*;/g, ". "))]);
    if (x.q.promoApplied) items.push(["First-transfer rate", "This row uses the welcome or intro rate the provider publishes for new customers."]);
    return '<div class="more" id="' + pid + '"' + (open ? "" : " hidden") + '><dl>' + items.filter(function (it) { return it[1]; }).map(function (it) { return "<div><dt>" + it[0] + "</dt><dd>" + it[1] + "</dd></div>"; }).join("") + "</dl></div>";
  }

  // Quick picks above the ranking: best service per way of receiving, and the fastest where speeds are known.
  function picks(c) {
    var all = (c.allRows || c.rows).filter(function (x) { return !x.stale; });
    if (all.length < 2) return "";
    var out = [];
    ["mobile", "bank", "cash"].forEach(function (m) {
      var best = all.filter(function (x) { return (x.q.payout || []).indexOf(m) > -1; })[0];
      if (best) out.push('<button type="button" class="pick" data-payout="' + m + '" title="Show only ' + LABEL[m].toLowerCase() + ' services"><span class="pick-k">Best by ' + LABEL[m].toLowerCase() + '</span><span class="pick-v notranslate">' + esc(best.p.name) + ' <span class="pick-n num">' + esc(c.target ? money(best.pay, c.s.currency, 2) : fixed(best.gets, best.gets >= 1000 ? 0 : 2)) + "</span></span></button>");
    });
    var fast = all.filter(function (x) { return /minute|instant|second/i.test(x.q.speed || ""); })[0];
    if (fast) out.push('<span class="pick"><span class="pick-k">Fastest</span><span class="pick-v notranslate">' + esc(fast.p.name) + ' <span class="pick-n">' + esc(fast.q.speed) + "</span></span></span>");
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

  function amountNote(c) {
    if (c.target || !c.rows.length || !c.list || !c.providers) return "";
    var base = Number(c.amount);
    if (!(base > 0)) return "";
    var amts = [base];
    [base * 2, base * 4].forEach(function (a) { if (amts.indexOf(a) < 0) amts.push(a); });
    var namesAt = amts.map(function (a) {
      var rows = rank({ list: c.list, feed: c.feed, feedTiers: c.feedTiers, country: c.country, sharedCurrency: c.sharedCurrency, refAmount: c.refAmount, providers: c.providers, amount: a, payout: c.payout, payIn: c.payIn, promo: c.promo, mid: c.mid, now: c.now, staleH: c.staleH || 36, hideH: c.hideH || 72, handLockH: c.handLockH || 6 });
      var top = rows.filter(function (x) { return !x.stale; })[0];
      return top ? { a: a, name: top.p.name } : null;
    }).filter(Boolean);
    if (namesAt.length < 2) return "";
    var first = namesAt[0], other = namesAt.filter(function (x) { return x.name !== first.name; })[0];
    if (!other) return '<p class="note amount-note">For ' + esc(money(first.a, c.s.currency, 0)) + ", " + esc(first.name) + " delivers the most on this check. The same service leads at the larger amounts we compared.</p>";
    return '<p class="note amount-note">For ' + esc(money(first.a, c.s.currency, 0)) + ", " + esc(first.name) + " delivers the most. At " + esc(money(other.a, c.s.currency, 0)) + ", " + esc(other.name) + " does. Change the amount above to see the order for your transfer.</p>";
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
      html += amountNote(c);
      if (warn) html += '<p class="refwarn">' + esc(warn) + "</p>";
      if (c.rows.some(function (x) { return isAuto(x.q); })) html += '<p class="note">"(auto)" rows are refreshed automatically from Wise\'s comparison data or the provider\'s own website. Payout options on those rows may be incomplete.</p>';
      if (c.rows.some(function (x) { return x.tied; })) html += '<p class="note tie-note">"=" means tied: the same amount arrives. Tied services are listed with the lower fee first.</p>';
      var reg = REGISTER[c.s.id];
      html += '<div class="below"><p class="disclose">' + (c.target ? "Ranked by the least you pay for " + esc(money(c.target, c.r.currency)) + " to arrive" : "Ranked by the amount that arrives") +
        (c.promo ? ", using first-transfer rates where the provider publishes one" : ", using standard rates" + (c.hasPromo === false ? "" : " (turn on first-transfer offers above if you are new)")) +
        '. Some providers pay us a commission when you sign up; it never changes the order. <a href="' + esc(c.disclosureHref) + '">How we make money</a></p>' +
        (reg ? '<p class="disclose">Before you send, check the service is licensed ' + (reg[2] || "on") + ' <a href="' + reg[1] + '" target="_blank" rel="noopener">' + reg[0] + "</a>.</p>" : "") +
        (notes.length ? '<ol class="notes">' + notes.map(function (n, k) { return '<li id="sf-fn-' + (k + 1) + '"><strong>' + esc(n.who) + ":</strong> " + esc(n.text) + "</li>"; }).join("") + "</ol>" : "") + "</div>";
    } else if (c.payout && c.payout !== "all" && c.anyQuotes) {
      html += '<div class="empty"><strong>None of today\'s checked services pay out by ' + LABEL[c.payout].toLowerCase() + " on this route.</strong><span>Choose another way to receive, or check back later today.</span></div>";
    } else {
      var list = (c.checkList || []).map(function (p) {
        return '<a href="' + esc(c.hrefFor(p, c.key)) + '" target="_blank" rel="sponsored nofollow noopener">' + esc(p.name) + "</a>";
      }).join(DOT);
      html += '<div class="empty"><strong>' + (c.anyQuotes ? "Quotes for " + esc(c.s.short) + " to " + esc(c.r.name) + " are too old to rank." : "No online price for " + esc(c.s.short) + " to " + esc(c.r.name) + " has been checked yet.") + "</strong>" +
        "<span>" + (c.anyQuotes ? "The last check is older than three days, so it is hidden until we recheck it." : "We have no current online quote priced for this route, so there is no ranking to use yet. Compare the services on their own sites or apps, using the fair-deal figures below as a guide.") + "</span>" +
        (list ? '<span class="checklist">Services to check on this route: ' + list + "</span>" : "") + "</div>";
    }
    var midOk = c.mid && !(c.rows && c.rows.midSuspect);
    if (midOk && c.target) {
      var ideal = c.target / c.mid, avgPay = ideal / (1 - c.avgPct / 100);
      var cheapest = c.rows.filter(function (x) { return !x.stale; })[0];
      var saved = cheapest ? avgPay - cheapest.pay : 0;
      html += '<div class="benchmark">' +
        '<div class="bench"><span class="k">At the mid-market rate, no fees</span><span class="v num">' + moneyHtml(ideal, c.s.currency) + '</span><span class="s">The least it could ever cost.</span></div>' +
        (c.ssa ? '<div class="bench"><span class="k">At the regional average cost (' + c.avgPct + '%)</span><span class="v num">' + moneyHtml(avgPay, c.s.currency) + '</span><span class="s">' + esc(c.avgLabel) + "</span></div>" : "") +
        (c.ssa && saved > 0 ? '<div class="bench"><span class="k">Cheapest option vs the average</span><span class="v num gain">' + moneyHtml(saved, c.s.currency) + '</span><span class="s">Kept in your pocket on this transfer.</span></div>' : "") +
        "</div>";
    } else if (midOk) {
      var perfect = c.amount * c.mid;
      var pct = c.avgPct;
      var avg = perfect * (1 - pct / 100);
      var top = c.rows.filter(function (x) { return !x.stale; })[0];
      var gain = top ? top.gets - avg : 0;
      html += '<div class="benchmark">' +
        '<div class="bench"><span class="k">At the mid-market rate, no fees</span><span class="v num">' + moneyHtml(perfect, c.r.currency) + '</span><span class="s">' +
          (top && top.gets > perfect ? esc(top.p.name) + " beats the mid-market rate today. That is usually a promotional or subsidised rate, so check it on their screen before you pay." : "Converting at the market rate with no fee. Services rarely beat this.") + "</span></div>" +
        (c.ssa ? '<div class="bench"><span class="k">At the regional average cost (' + pct + '%)</span><span class="v num">' + moneyHtml(avg, c.r.currency) + '</span><span class="s">' + esc(c.avgLabel) + "</span></div>" : "") +
        (c.ssa && gain > 0 ? '<div class="bench"><span class="k">Best option vs the average</span><span class="v num gain">' + moneyHtml(gain, c.r.currency).replace("</span>", "</span>+") + '</span><span class="s">Extra that reaches home on this transfer.</span></div>' : "") +
        "</div>";
    }
    if (c.pending && c.pending.length) {
      html += '<p class="note pending-note">Also sends on this route, not priced in this check: ' +
        c.pending.map(function (p) { return '<a href="' + esc(c.hrefFor(p, c.key)) + '" target="_blank" rel="sponsored nofollow noopener">' + esc(p.name) + "</a>"; }).join(DOT) + ".</p>";
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
      var susp = (c.allRows || c.rows || {}).midSuspect;
      bits.push('Mid-market: <strong class="num">1 ' + c.s.currency + " = " + rateStr(c.mid) + " " + c.r.currency + "</strong>" + (susp ? ' <span class="trend">may be out of date: most services quote above it, so the cost vs mid-market is not shown</span>' : trend + spark(c.hist)));
    }
    var t = function (iso) { return c.timeStyle === "absolute" ? absTime(iso) : ago(iso, c.now); };
    if (c.midUpdated && c.s.currency !== c.r.currency) bits.push("Market rate from " + t(c.midUpdated));
    var times = (c.allRows || c.rows || []).filter(function (x) { return !x.stale && x.q.checkedAt; }).map(function (x) { return x.q.checkedAt; }).sort();
    if (times.length) {
      var oldest = times[0], newest = times[times.length - 1];
      var span = c.timeStyle === "absolute" ? absTime(oldest) + (newest !== oldest ? " to " + (newest.slice(0, 10) === oldest.slice(0, 10) ? absTime(newest).replace(/^\d+ \w+, /, "") : absTime(newest)) : "")
        : (Math.round(ageHours(oldest, c.now)) === Math.round(ageHours(newest, c.now)) ? ago(oldest, c.now) : ago(newest, c.now).replace(/ ago$/, "") + " to " + ago(oldest, c.now));
      bits.push("Quotes checked " + span);
    }
    return bits.map(function (b) { return "<span>" + b + "</span>"; }).join("");
  }

  // Local time in the family's city, for the phone's lock screen.
  var HOME = { nigeria: ["Lagos", "Africa/Lagos"], ghana: ["Accra", "Africa/Accra"], kenya: ["Nairobi", "Africa/Nairobi"],
    uganda: ["Kampala", "Africa/Kampala"], zambia: ["Lusaka", "Africa/Lusaka"], zimbabwe: ["Harare", "Africa/Harare"],
    egypt: ["Cairo", "Africa/Cairo"], morocco: ["Casablanca", "Africa/Casablanca"], senegal: ["Dakar", "Africa/Dakar"], ivorycoast: ["Abidjan", "Africa/Abidjan"],
    mali: ["Bamako", "Africa/Bamako"], cameroon: ["Douala", "Africa/Douala"], ethiopia: ["Addis Ababa", "Africa/Addis_Ababa"], southafrica: ["Johannesburg", "Africa/Johannesburg"],
    tanzania: ["Dar es Salaam", "Africa/Dar_es_Salaam"], drc: ["Kinshasa", "Africa/Kinshasa"], rwanda: ["Kigali", "Africa/Kigali"] };
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
    if (!top) return { title: "SendFair", text: c.anyQuotes ? "Today\u2019s quotes for " + esc(c.s.short) + " to " + esc(c.r.name) + " are being checked." : "No online prices yet for " + esc(c.s.short) + " to " + esc(c.r.name) + ".", cap: "" };
    var how = c.payout && c.payout !== "all" ? c.payout : (top.q.payout || [])[0] || "mobile";
    var amt = "<b>" + esc(money(top.gets, c.r.currency, 2)) + "</b>";
    var lead = leaders(c.rows);
    var by = c.target ? " Sent from " + esc(c.s.short) + " with " + esc(top.p.name) + " for " + esc(money(top.pay, c.s.currency, 2)) + "."
      : lead.length > 1 ? " " + (lead.length === 2 ? esc(names(lead)) + " tie" : lead.length + " services tie") + " for the most today."
      : " Sent from " + esc(c.s.short) + " with " + esc(top.p.name) + ".";
    var text = how === "cash" ? amt + " is ready to collect." + by : "You have received " + amt + "." + by;
    var n = c.rows.length;
    var checkedDay = top.q.checkedAt ? absTime(top.q.checkedAt).replace(/, .*/, "") : "";
    var todayUtc = absTime(new Date(c.now).toISOString()).replace(/, .*/, "");
    var when = checkedDay && checkedDay !== todayUtc ? "Best from quotes checked " + checkedDay : "Today\u2019s best";
    var cap = c.target
      ? (checkedDay && checkedDay !== todayUtc ? "Cheapest from quotes checked " + checkedDay : "Today\u2019s cheapest") + " way to get " + esc(money(c.target, c.r.currency, 0)) + " to " + esc(c.r.name) + (n > 1 ? ", out of " + n + " services checked." : ".")
      : when + " for " + esc(money(c.amount, c.s.currency, 0)) + " from " + esc(c.s.short) + " to " + esc(c.r.name) +
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
    var checkedDay = top && top.q.checkedAt ? absTime(top.q.checkedAt).replace(/, .*/, "") : "";
    var todayUtc = absTime(new Date(c.now || Date.now()).toISOString()).replace(/, .*/, "");
    var when = checkedDay && checkedDay !== todayUtc ? "On quotes checked " + checkedDay + ", " : "Today ";
    if (top && c.target) {
      return "Need " + money(c.target, c.r.currency) + " to arrive in " + c.r.name + "? " + when + top.p.name + " gets it there for " + money(top.pay, c.s.currency, 2) +
        (c.rows.length > 1 ? ", the least of " + c.rows.length + " services checked" : "") + ". Compare: " + url;
    }
    if (top && lead.length > 1) {
      return "Sending " + money(c.amount, c.s.currency, 0) + " to " + c.r.name + "? " + when + names(lead) + " tie at " + money(top.gets, c.r.currency) +
        ", the most of " + c.rows.length + " services checked. Compare your amount: " + url;
    }
    if (top) {
      return "Sending " + money(c.amount, c.s.currency, 0) + " to " + c.r.name + "? " + when + top.p.name + " delivers " + money(top.gets, c.r.currency) +
        (c.rows.length > 1 ? ", the most of " + c.rows.length + " services checked" : "") + ". Compare your amount: " + url;
    }
    return "Compare what actually arrives when you send money from " + c.s.short + " to " + c.r.name + ": " + url;
  }

  var api = { LABEL: LABEL, esc: esc, money: money, rateStr: rateStr, midRate: midRate, ageHours: ageHours, ago: ago, absTime: absTime,
    evaluate: evaluate, payFor: payFor, tierAt: tierAt, midAt: midAt, midSuspect: midSuspect, feeStr: feeStr, rank: rank, renderResults: renderResults, metaLine: metaLine, shareText: shareText, notice: notice, moneyHtml: moneyHtml, homeTime: homeTime, leaders: leaders, names: names, picks: picks, spark: spark, badge: badge, mergeFeed: mergeFeed, promoRate: promoRate, SSA: SSA };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SFRank = api;
})(typeof window !== "undefined" ? window : this);
