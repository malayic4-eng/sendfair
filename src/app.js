/* SendFair page script: loads the day's data, re-ranks for the visitor's amount, handles sharing and delivery reports. */
(function () {
  "use strict";
  var SF = window.SF || {};
  var R = window.SFRank;
  var cfg = SF.config || {};
  var root = SF.root || "";
  var S = { corridors: null, providers: {}, quotes: {}, coverage: {}, quotesUpdated: null, mid: null, reports: {}, payout: "all" };
  var $ = function (id) { return document.getElementById(id); };
  if (!$("sf-results") || !R) return;

  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  function getJSON(p) {
    return fetch(root + p, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(p); return r.json(); });
  }
  function sender() { var v = $("sf-from").value; return S.corridors.senders.filter(function (s) { return s.id === v; })[0]; }
  function receiver() { var v = $("sf-to").value; return S.corridors.receivers.filter(function (s) { return s.id === v; })[0]; }
  function key() { return $("sf-from").value + "-" + $("sf-to").value; }
  function routeUrl(from, to) { return (SF.routeUrl || "").replace("{from}", from).replace("{to}", to); }
  function hrefFor(p, k) {
    if (cfg.trackClicks) return root + "go/" + encodeURIComponent(p.id) + "?r=" + encodeURIComponent(k);
    return (p.affiliateUrl || p.website).replace("{route}", k);
  }

  function loadMid() {
    return getJSON("data/midmarket.json").then(function (m) {
      if (m && m.demo) return m;
      var fresh = m && m.updatedAt && (Date.now() - new Date(m.updatedAt).getTime()) < 72 * 3600000;
      if (m && m.rates && Object.keys(m.rates).length && fresh) return m;
      return fetch("https://open.er-api.com/v6/latest/USD").then(function (r) { return r.json(); }).then(function (d) {
        if (d.result !== "success") throw new Error("rates");
        return { base: "USD", updatedAt: new Date(d.time_last_update_unix * 1000).toISOString(), rates: d.rates };
      }).catch(function () { return m; });
    }).catch(function () { return null; });
  }

  function loadReports() {
    if (cfg.demo) {
      return getJSON("data/reports-demo.json").then(function (d) { S.reports = (d.routes || {})[key()] || {}; }).catch(function () { S.reports = {}; });
    }
    if (!cfg.reportsEnabled) { S.reports = {}; return Promise.resolve(); }
    return fetch(root + "api/reports?route=" + encodeURIComponent(key())).then(function (r) { return r.ok ? r.json() : { providers: {} }; })
      .then(function (d) { S.reports = d.providers || {}; }).catch(function () { S.reports = {}; });
  }

  function fillSelects() {
    var opt = function (x) { return '<option value="' + x.id + '">' + R.esc(x.label || x.name) + " (" + x.currency + ")</option>"; };
    $("sf-from").innerHTML = S.corridors.senders.map(opt).join("");
    $("sf-to").innerHTML = S.corridors.receivers.map(opt).join("");
    var last = store.get("sf-last") || {};
    $("sf-from").value = SF.from || last.from || "uk";
    $("sf-to").value = SF.to || last.to || "kenya";
    var cur = sender().currency;
    $("sf-amount").value = last.amount && last.currency === cur ? last.amount : (cfg.defaultAmounts || {})[cur] || 300;
    if (last.payout && R.LABEL[last.payout]) setPayout(last.payout);
  }

  function setPayout(v) {
    S.payout = v;
    document.querySelectorAll("[data-payout]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-payout") === v)); });
  }

  function context() {
    var s = sender(), r = receiver(), k = key();
    var amount = parseFloat($("sf-amount").value);
    var mid = R.midRate(S.mid, s.currency, r.currency);
    var list = S.quotes[k] || [];
    var rows = R.rank({ list: list, providers: S.providers, amount: amount, payout: S.payout, mid: mid, now: Date.now(), staleH: cfg.staleAfterHours || 36, hideH: cfg.hideAfterHours || 72 });
    var coverage = S.coverage[k] && S.coverage[k].length ? S.coverage[k] : Object.keys(S.providers);
    return {
      s: s, r: r, key: k, amount: amount, payout: S.payout, mid: mid, rows: rows, now: Date.now(), timeStyle: "relative",
      anyQuotes: list.length > 0, reports: S.reports, hrefFor: hrefFor, disclosureHref: SF.disclosureHref || "#",
      checkList: coverage.map(function (id) { return S.providers[id]; }).filter(Boolean),
      avgPct: (cfg.regionalAverageCost || {}).percent || 8.46, avgLabel: (cfg.regionalAverageCost || {}).label || "",
      midUpdated: S.mid && S.mid.updatedAt, quotesUpdated: S.quotesUpdated
    };
  }

  function render() {
    var c = context();
    $("sf-cur").textContent = c.s.currency;
    store.set("sf-last", { from: c.s.id, to: c.r.id, amount: c.amount, currency: c.s.currency, payout: S.payout });
    $("sf-meta").innerHTML = R.metaLine(c);
    $("sf-note").textContent = c.r.note || "";
    $("sf-note").hidden = !c.r.note;
    $("sf-results").innerHTML = R.renderResults(c);
    var wa = $("sf-wa");
    if (wa) {
      var url = SF.pageUrl || (SF.siteUrl + "/send-money/" + c.s.id + "-to-" + c.r.id + "/");
      wa.href = "https://wa.me/?text=" + encodeURIComponent(R.shareText(c, url));
      wa.setAttribute("data-url", url);
    }
    fillReportProviders(c);
    renderPhone(c);
  }

  // Lock-screen phone in the header: the family's local time and what today's best option delivers.
  var lastNotice = null;
  function renderPhone(c) {
    if (!$("sf-notif")) return;
    var h = R.homeTime(c.r.id, Date.now());
    if ($("sf-ph-city")) $("sf-ph-city").textContent = h.city;
    if ($("sf-ph-time")) $("sf-ph-time").textContent = h.time;
    if ($("sf-ph-date")) $("sf-ph-date").textContent = h.date;
    var n = R.notice(c);
    $("sf-ph-title").textContent = n.title;
    $("sf-ph-text").innerHTML = n.text;
    $("sf-ph-cap").innerHTML = n.cap;
    var sig = n.title + n.text;
    if (lastNotice !== null && sig !== lastNotice) {
      var el = $("sf-notif");
      el.classList.remove("is-new");
      void el.offsetWidth;
      el.classList.add("is-new");
    }
    lastNotice = sig;
  }

  function fillReportProviders(c) {
    var sel = $("sf-rep-provider");
    if (!sel) return;
    var ids = [];
    (S.quotes[c.key] || []).forEach(function (q) { if (ids.indexOf(q.provider) === -1 && S.providers[q.provider]) ids.push(q.provider); });
    if (!ids.length) ids = Object.keys(S.providers);
    var keep = sel.value;
    sel.innerHTML = '<option value="">Choose the service you used</option>' + ids.map(function (id) { return '<option value="' + id + '">' + R.esc(S.providers[id].name) + "</option>"; }).join("");
    if (ids.indexOf(keep) > -1) sel.value = keep;
  }

  function onRouteChange() {
    var last = store.get("sf-last") || {};
    store.set("sf-last", { from: $("sf-from").value, to: $("sf-to").value, amount: parseFloat($("sf-amount").value), currency: last.currency, payout: S.payout });
    if (SF.from && SF.routeUrl) { location.href = routeUrl($("sf-from").value, $("sf-to").value); return; }
    var cur = sender().currency;
    if (last.currency !== cur) $("sf-amount").value = (cfg.defaultAmounts || {})[cur] || 300;
    loadReports().then(render);
  }

  function bind() {
    $("sf-from").addEventListener("change", onRouteChange);
    $("sf-to").addEventListener("change", onRouteChange);
    $("sf-amount").addEventListener("input", render);
    document.querySelectorAll("[data-payout]").forEach(function (b) {
      b.addEventListener("click", function () { setPayout(b.getAttribute("data-payout")); render(); });
    });

    var copy = $("sf-copy");
    if (copy) copy.addEventListener("click", function () {
      var url = $("sf-wa").getAttribute("data-url");
      var done = function () { $("sf-share-msg").textContent = "Link copied."; };
      try {
        navigator.clipboard.writeText(url).then(done, function () { $("sf-share-msg").textContent = url; });
      } catch (e) { $("sf-share-msg").textContent = url; }
    });

    var alertForm = $("sf-alert-form");
    if (alertForm && alertForm.getAttribute("data-demo") === "1") {
      alertForm.addEventListener("submit", function (e) {
        e.preventDefault();
        $("sf-alert-msg").textContent = "Alerts are switched off in this preview. On the live site this adds the email to your mailing list.";
      });
    }

    var rep = $("sf-report");
    if (rep) rep.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("sf-rep-msg");
      var provider = $("sf-rep-provider").value;
      var b = rep.querySelector('input[name="sf-rep-bucket"]:checked');
      if (!provider || !b) { msg.textContent = "Choose the service and how long it took."; return; }
      if (cfg.demo) { msg.textContent = "Reports are switched off in this preview. On the live site this is saved and shown to other senders."; return; }
      msg.textContent = "Sending…";
      fetch(root + "api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route: key(), provider: provider, bucket: b.value }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          msg.textContent = x.ok ? "Thank you. Your report helps other senders." : (x.d && x.d.error) || "Could not save your report. Try again later.";
          if (x.ok) { rep.reset(); loadReports().then(render); }
        })
        .catch(function () { msg.textContent = "Could not save your report. Check your connection and try again."; });
    });
  }

  Promise.all([getJSON("data/corridors.json"), getJSON("data/providers.json"), getJSON("data/quotes.json"), loadMid()])
    .then(function (res) {
      S.corridors = res[0];
      res[1].providers.forEach(function (p) { S.providers[p.id] = p; });
      S.quotes = res[2].quotes || {};
      S.coverage = res[2].coverage || {};
      S.quotesUpdated = res[2].updatedAt;
      S.mid = res[3];
      fillSelects();
      bind();
      return loadReports();
    })
    .then(render)
    .catch(function () {
      if (!$("sf-results").querySelector(".results")) {
        $("sf-results").innerHTML = '<div class="empty"><strong>Rates could not load.</strong><span>Check your connection and refresh the page.</span></div>';
      }
    });
})();
