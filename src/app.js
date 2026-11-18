/* SendFair page script: loads the day's data, re-ranks for the visitor's amount, handles sharing and delivery reports. */
(function () {
  "use strict";
  var SF = window.SF || {};
  var R = window.SFRank;
  var cfg = SF.config || {};
  var root = SF.root || "";
  var S = { corridors: null, providers: {}, quotes: {}, coverage: {}, quotesUpdated: null, mid: null, reports: {}, payout: "all", payIn: "all", promo: false, mode: "pay", feed: {} };
  var $ = function (id) { return document.getElementById(id); };

  // Exchange-rate pages: simple converter at the mid-market rate.
  var conv = $("sf-conv");
  if (conv) {
    var cin = $("sf-conv-in"), cout = $("sf-conv-mid"), mid = parseFloat(conv.getAttribute("data-mid")), to = conv.getAttribute("data-to");
    var upd = function () { var v = parseFloat(cin.value); cout.textContent = v > 0 ? to + " " + (v * mid).toLocaleString("en", { maximumFractionDigits: v * mid >= 1000 ? 0 : 2, minimumFractionDigits: v * mid >= 1000 ? 0 : 2 }) : "–"; };
    cin.addEventListener("input", upd);
  }

  function consentChoice() {
    try { return JSON.parse(localStorage.getItem("sf-consent") || "null"); } catch (e) { return null; }
  }
  function allowOptional() { return consentChoice() === "all"; }
  function stripImpact() {
    document.querySelectorAll('script[src*="impactcdn.com"]').forEach(function (s) { if (s.parentNode) s.parentNode.removeChild(s); });
    try { window.impactStat = function () {}; } catch (e) {}
  }
  if (consentChoice() === "essential") stripImpact();

  function setupNav() {
    var header = document.querySelector(".site-header");
    var nav = document.querySelector(".site-nav");
    if (!header || !nav || $("sf-nav-toggle")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "sf-nav-toggle";
    btn.className = "nav-toggle";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "sf-nav");
    btn.setAttribute("aria-label", "Open menu");
    btn.innerHTML = "<span></span><span></span><span></span>";
    nav.id = nav.id || "sf-nav";
    header.querySelector(".wrap").appendChild(btn);
    btn.addEventListener("click", function () {
      var on = header.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", String(on));
      btn.setAttribute("aria-label", on ? "Close menu" : "Open menu");
    });
  }

  function fixAvatars() {
    document.querySelectorAll(".avatar").forEach(function (el) {
      var img = el.querySelector("img");
      var bits = [];
      el.childNodes.forEach(function (n) {
        if (n.nodeType === 3 && n.textContent.trim()) bits.push(n.textContent.trim());
      });
      var initials = el.getAttribute("data-initials") || bits.join("");
      if (initials) el.setAttribute("data-initials", initials);
      bits.forEach(function () {
        el.childNodes.forEach(function (n) { if (n.nodeType === 3) n.textContent = ""; });
      });
      if (img && !img.getAttribute("alt")) {
        var name = (el.nextElementSibling && el.nextElementSibling.textContent) || (el.closest("h1") && el.closest("h1").textContent) || "";
        name = name.replace(/\s*review.*$/i, "").trim() || "Provider";
        img.setAttribute("alt", name + " logo");
      }
    });
  }

  function setupLanguage() {
    var b = $("sf-lang"), box = $("sf-lang-box");
    if (!b || !box) return;
    var fresh = b.cloneNode(true);
    b.parentNode.replaceChild(fresh, b);
    b = fresh;
    var langs = (cfg.translateLanguages || "en,fr,ar,sw,pt").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    var names = { en: "English", fr: "Français", ar: "العربية", sw: "Kiswahili", pt: "Português", ha: "Hausa", yo: "Yorùbá", am: "አማርኛ", so: "Soomaali" };
    if (!$("sf-lang-choices")) {
      var row = document.createElement("div");
      row.id = "sf-lang-choices";
      row.className = "lang-choices";
      langs.forEach(function (id) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = names[id] || id;
        btn.setAttribute("data-lang", id);
        row.appendChild(btn);
      });
      var wrap = box.querySelector(".wrap") || box;
      wrap.insertBefore(row, wrap.querySelector(".lang-note") || wrap.firstChild);
    }
    function loadGoogle() {
      if (document.getElementById("sf-gt-script")) return;
      window.sfTranslateInit = function () {
        if (!window.google || !google.translate) return;
        new google.translate.TranslateElement({ pageLanguage: "en", includedLanguages: langs.join(","), autoDisplay: false, layout: google.translate.TranslateElement.InlineLayout.SIMPLE }, "google_translate_element");
      };
      var s = document.createElement("script");
      s.id = "sf-gt-script";
      s.src = "https://translate.google.com/translate_a/element.js?cb=sfTranslateInit";
      s.async = true;
      document.head.appendChild(s);
    }
    function applyLang(id) {
      document.cookie = "googtrans=" + (id === "en" ? ";path=/;max-age=0" : "/en/" + id + ";path=/");
      if (id === "en") { location.hash = ""; location.reload(); return; }
      if (!allowOptional()) {
        var note = box.querySelector(".lang-note");
        if (note) note.textContent = "Accept optional scripts in the banner to translate the page, or keep it in English.";
        return;
      }
      loadGoogle();
      setTimeout(function () { location.reload(); }, 80);
    }
    b.addEventListener("click", function () {
      var open = box.hidden;
      box.hidden = !open;
      b.setAttribute("aria-expanded", String(open));
    });
    box.addEventListener("click", function (e) {
      var lang = e.target.closest && e.target.closest("[data-lang]");
      if (lang) applyLang(lang.getAttribute("data-lang"));
    });
    var m = document.cookie.match(/googtrans=.en.([a-zA-Z-]+)/);
    if (m && m[1] !== "en" && allowOptional()) loadGoogle();
  }

  function trackerOn() { return !!(cfg.ga4 || cfg.gtm || cfg.clarity); }
  function sfEvent(name, params) {
    if (!allowOptional() || !trackerOn()) return;
    window.dataLayer = window.dataLayer || [];
    var payload = { event: name };
    if (params) Object.keys(params).forEach(function (k) { payload[k] = params[k]; });
    window.dataLayer.push(payload);
    if (window.gtag) window.gtag("event", name, params || {});
  }
  function loadTrackers() {
    if (!allowOptional() || !trackerOn() || window.__sfTrackers) return;
    window.__sfTrackers = true;
    window.dataLayer = window.dataLayer || [];
    if (cfg.gtm) {
      window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
      var g = document.createElement("script");
      g.async = true;
      g.src = "https://www.googletagmanager.com/gtm.js?id=" + encodeURIComponent(cfg.gtm);
      document.head.appendChild(g);
    }
    if (cfg.ga4) {
      var s = document.createElement("script");
      s.async = true;
      s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(cfg.ga4);
      document.head.appendChild(s);
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag("js", new Date());
      window.gtag("config", cfg.ga4);
    }
    if (cfg.clarity) {
      (function (c, l, a, r, i) {
        c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
        var t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + encodeURIComponent(i);
        var y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
      })(window, document, "clarity", "script", cfg.clarity);
    }
  }
  function loadImpact() {
    if (!allowOptional() || !cfg.impactSrc || document.querySelector('script[src*="impactcdn.com"]')) return;
    var s = document.createElement("script");
    s.async = true;
    s.src = cfg.impactSrc;
    document.head.appendChild(s);
  }
  // Travelpayouts Drive: travel offers, only on pages whose build sets driveSrc (the flying-home pages), after consent.
  function loadDrive() {
    if (!allowOptional() || !cfg.driveSrc || document.querySelector('script[src*="emrldco.com"]')) return;
    var s = document.createElement("script");
    s.async = true;
    s.setAttribute("data-cmp-ab", "2");
    s.src = cfg.driveSrc;
    document.head.appendChild(s);
  }
  function loadAds() {
    if (!allowOptional() || !cfg.adsenseClient || document.getElementById("sf-ads")) return;
    var s = document.createElement("script");
    s.id = "sf-ads";
    s.async = true;
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + encodeURIComponent(cfg.adsenseClient);
    s.crossOrigin = "anonymous";
    document.head.appendChild(s);
    s.addEventListener("load", function () { try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {} });
  }
  function escText(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function readList(key) {
    try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { return []; }
  }

  // ---- returning senders (no account): saved routes, savings estimate, share result ----
  function routeStore() { try { return JSON.parse(localStorage.getItem("sf-routes") || "[]"); } catch (e) { return []; } }
  function setRouteStore(list) { try { localStorage.setItem("sf-routes", JSON.stringify(list.slice(0, 20))); } catch (e) {} }
  function routeLabel(route) { return route.split("-").map(function (x) { return x.charAt(0).toUpperCase() + x.slice(1); }).join(" to "); }
  function receiverOf(route) { var id = route.split("-").slice(1).join("-"); return ((S.corridors && S.corridors.receivers) || []).find(function (r) { return r.id === id; }) || null; }
  function moneyShort(v, cur) { if (!cur) return ""; return cur + " " + (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en") : v.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })); }
  function bestFor(route, amount) {
    var parts = route.split("-"), from = parts[0], to = parts.slice(1).join("-");
    var s = ((S.corridors && S.corridors.senders) || []).find(function (x) { return x.id === from; });
    var r = ((S.corridors && S.corridors.receivers) || []).find(function (x) { return x.id === to; });
    if (!s || !r) return null;
    var rows = R.rank({ list: S.quotes[route] || [], feed: S.feed[route] || null, providers: S.providers, amount: amount, payout: "all", payIn: "all", promo: false, mid: R.midRate(S.mid, s.currency, r.currency), now: Date.now(), staleH: (cfg.staleAfterHours || 36), hideH: (cfg.hideAfterHours || 72), handLockH: (cfg.preferAutoAfterHours || cfg.handLockHours || 6), refAmount: (cfg.defaultAmounts || {})[s.currency] });
    var fresh = rows.filter(function (x) { return !x.stale; });
    return fresh.length ? { gets: fresh[0].gets, name: fresh[0].p.name } : null;
  }
  function savedLink(r) {
    var parts = r.route.split("-"), s = ((S.corridors && S.corridors.senders) || []).find(function (x) { return x.id === parts[0]; });
    var standard = cfg.amountPages && s && (cfg.amountPages[s.currency] || []).indexOf(r.amount) > -1;
    return (root || "/") + "send-money/" + r.route + "/" + (standard ? r.amount + "/" : "?amount=" + encodeURIComponent(r.amount));
  }
  function renderYourRoutes() {
    var wrap = $("sf-your-routes"), box = $("sf-your-routes-list");
    if (!wrap || !box) return;
    var list = routeStore();
    if (!list.length) { wrap.hidden = true; return; }
    box.innerHTML = "<ul>" + list.map(function (r) {
      var best = bestFor(r.route, r.amount), cur = receiverOf(r.route) ? receiverOf(r.route).currency : "";
      var change = best && r.lastGets > 0 ? best.gets - r.lastGets : null;
      return '<li><a href="' + escText(savedLink(r)) + '">' + escText(r.label || routeLabel(r.route)) + "</a><span>" + (best ? escText(best.name) + " · " + escText(moneyShort(best.gets, cur)) : "Checking today's rates…") + (change != null ? " · " + (change >= 0 ? "+" : "") + escText(moneyShort(change, cur)) + " since your last visit" : "") + "</span></li>";
    }).join("") + "</ul>";
    wrap.hidden = false;
    var sends = []; try { sends = JSON.parse(localStorage.getItem("sf-sends") || "[]"); } catch (e) {}
    var sav = $("sf-savings");
    if (sav) {
      if (!sends.length) { sav.hidden = true; return; }
      var cur = receiverOf(sends[0].route) ? receiverOf(sends[0].route).currency : "";
      var total = sends.reduce(function (a, x) { return a + Math.max(0, (x.gets || 0) - (x.average || 0)); }, 0);
      sav.textContent = "You've sent " + sends.length + " time" + (sends.length === 1 ? "" : "s") + " with SendFair and received about " + moneyShort(total, cur) + " more than the regional average cost. This is an estimate based on our check at the time, not a guarantee.";
      sav.hidden = false;
    }
  }
  function saveRoute(route, amount) {
    if (!route) return;
    amount = Math.round(amount);
    if (!(amount > 0)) return;
    var list = routeStore().filter(function (r) { return !(r.route === route && r.amount === amount); });
    var best = bestFor(route, amount), label = routeLabel(route);
    try { var p = window.prompt("Name this route (for example, “Mum in Kisumu”)", label); if (p && p.trim()) label = p.trim().slice(0, 40); } catch (e) {}
    list.unshift({ route: route, amount: amount, payout: S.payout, label: label, lastGets: best ? best.gets : null, savedAt: new Date().toISOString() });
    setRouteStore(list);
    renderYourRoutes();
    sfEvent("save_route", { route: route, amount: amount });
  }
  function maybeRecordSend(a) {
    var href = a.getAttribute("href") || "";
    var m = href.match(/\/go\/([^?]+)\?r=([a-z-]+)/);
    if (!m) return;
    var route = m[2];
    if (!routeStore().some(function (r) { return r.route === route; })) return;
    var amount = parseFloat(($("sf-amount") || {}).value) || 0, best = bestFor(route, amount);
    if (!best || !(amount > 0)) return;
    var rec = receiverOf(route), s = ((S.corridors && S.corridors.senders) || []).find(function (x) { return route.indexOf(x.id + "-") === 0; });
    var mid = s && rec ? R.midRate(S.mid, s.currency, rec.currency) : null;
    var avg = mid ? amount * mid * (1 - ((cfg.regionalAverageCost || {}).percent || 8.46) / 100) : 0;
    try {
      var list = JSON.parse(localStorage.getItem("sf-sends") || "[]");
      list.unshift({ date: new Date().toISOString(), route: route, amount: amount, provider: (S.providers[decodeURIComponent(m[1])] || {}).name || decodeURIComponent(m[1]), gets: best.gets, average: avg });
      localStorage.setItem("sf-sends", JSON.stringify(list.slice(0, 50)));
    } catch (e) {}
    sfEvent("saved_route_send", { route: route });
  }
  function currentAmount(btn) {
    var v = parseFloat(($("sf-amount") || {}).value);
    return v > 0 ? Math.round(v) : (Math.round(parseFloat(btn.getAttribute("data-amount"))) || 0);
  }
  function shareImageUrl(btn, amount, story) {
    var base = (SF.siteUrl || location.origin).replace(/\/$/, "");
    return base + "/og/result.png?route=" + encodeURIComponent(btn.getAttribute("data-route") || "") + "&amount=" + encodeURIComponent(Math.round(amount)) + (story ? "&size=story" : "");
  }
  function sharePageLink(btn, amount) {
    var base = (SF.siteUrl || location.origin).replace(/\/$/, "");
    return base + "/send-money/" + (btn.getAttribute("data-route") || "") + "/?amount=" + encodeURIComponent(Math.round(amount)) + "&ref=share";
  }
  function prepareFallbacks(btn) {
    var amount = currentAmount(btn), link = sharePageLink(btn, amount), text = "What arrives for a transfer today, compared by SendFair: ";
    var fb = $("sf-fb"), x = $("sf-x");
    if (fb) fb.href = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(link);
    if (x) x.href = "https://twitter.com/intent/tweet?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent(text);
    var wa = $("sf-wa-text"); if (wa) wa.onclick = function () { window.open("https://wa.me/?text=" + encodeURIComponent(text + " " + link), "_blank"); };
    var dl = $("sf-download"); if (dl) dl.onclick = function () { window.open(shareImageUrl(btn, amount, true), "_blank"); };
    var c2 = $("sf-copy2"); if (c2) c2.onclick = function () { if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { var m = $("sf-share-msg"); if (m) m.textContent = "Link copied."; }); };
  }
  function shareResult(btn) {
    var amount = currentAmount(btn), link = sharePageLink(btn, amount);
    sfEvent("share_result", { route: btn.getAttribute("data-route"), amount: amount, method: navigator.share ? "web" : "fallback" });
    if (navigator.share) {
      fetch(shareImageUrl(btn, amount)).then(function (r) { return r.ok ? r.blob() : null; }).then(function (blob) {
        var text = "Compare what actually arrives: " + link;
        if (blob && navigator.canShare) {
          var file = new File([blob], "sendfair-result.png", { type: "image/png" });
          if (navigator.canShare({ files: [file] })) { navigator.share({ files: [file], text: text, title: "SendFair result" }).catch(function () {}); return; }
        }
        navigator.share({ text: text, url: link, title: "SendFair result" }).catch(function () {});
      }).catch(function () { navigator.share({ text: "Compare what actually arrives: " + link, url: link }).catch(function () {}); });
      return;
    }
    var panel = $("sf-share-more"); if (panel) panel.hidden = false;
    prepareFallbacks(btn);
  }
  function renderComments() {
    var box = $("sf-comments"); if (!box) return;
    var list = S.comments || [];
    if (!list.length) { box.hidden = true; return; }
    box.querySelector("ul").innerHTML = list.map(function (c) {
      return '<li><span class="c-meta">' + escText((c.provider || "") + " · " + String(c.at || "").slice(0, 10)) + (c.rating ? " · " + c.rating + "/5" : "") + "</span><p>" + escText(c.text || "") + "</p></li>";
    }).join("");
    box.hidden = false;
  }
  function setupDiscovery() {
    loadTrackers();
    var article = document.querySelector("[data-guide]");
    if (article) {
      var slug = article.getAttribute("data-guide");
      var read = readList("sf-read").filter(function (s) { return s !== slug; });
      read.unshift(slug);
      try { localStorage.setItem("sf-read", JSON.stringify(read.slice(0, 30))); } catch (e) {}
      sfEvent("article_view", { article: slug });
      var saveBtn = document.querySelector("[data-save]");
      if (saveBtn && readList("sf-saved").some(function (x) { return x.path === saveBtn.getAttribute("data-save"); })) saveBtn.textContent = "Saved";
    }
    var savedBox = document.getElementById("sf-saved");
    if (savedBox) {
      var saved = readList("sf-saved");
      if (saved.length) {
        document.getElementById("sf-saved-list").innerHTML = saved.map(function (x) {
          return "<li><a href=\"" + escText((root || "/") + x.path) + "\">" + escText(x.title) + "</a></li>";
        }).join("");
        savedBox.hidden = false;
      }
    }
    if (article) {
      fetch((root || "/") + "data/search.json", { cache: "no-cache" }).then(function (r) { return r.json(); }).then(function (data) {
        var items = (data.items || []).filter(function (it) { return it.kind === "guide" && it.slug; });
        var interest = readList("sf-saved").map(function (x) { return x.slug; }).concat(readList("sf-read"));
        var tags = {};
        items.forEach(function (it) {
          if (interest.indexOf(it.slug) !== -1 && it.slug !== article.getAttribute("data-guide")) (it.tags || []).forEach(function (t) { tags[t] = 1; });
        });
        if (!Object.keys(tags).length) return;
        var recs = items.filter(function (it) {
          return it.slug !== article.getAttribute("data-guide") && (it.tags || []).some(function (t) { return tags[t]; });
        }).slice(0, 4);
        if (!recs.length) return;
        var box = document.createElement("div");
        box.id = "sf-also";
        box.innerHTML = "<h2>From guides you opened</h2><ul class=\"route-links\">" + recs.map(function (it) {
          return "<li><a href=\"" + escText((root || "/") + it.url) + "\">" + escText(it.title) + "</a></li>";
        }).join("") + "</ul><p class=\"note\">Chosen on this device from guides you opened or saved that share a topic. Nothing is sent to SendFair.</p>";
        var related = document.getElementById("related");
        if (related && related.parentNode) related.parentNode.insertBefore(box, related);
        else article.appendChild(box);
      }).catch(function () {});
    }
    document.addEventListener("click", function (e) {
      var save = e.target.closest && e.target.closest("[data-save]");
      if (save) {
        var path = save.getAttribute("data-save");
        var list = readList("sf-saved");
        var at = list.findIndex(function (x) { return x.path === path; });
        if (at >= 0) { list.splice(at, 1); save.textContent = "Save"; }
        else list.unshift({ path: path, title: save.getAttribute("data-title") || "", slug: article ? article.getAttribute("data-guide") : "" });
        try { localStorage.setItem("sf-saved", JSON.stringify(list.slice(0, 40))); } catch (err) {}
      }
      var copy = e.target.closest && e.target.closest("[data-copy]");
      if (copy) {
        var url = copy.getAttribute("data-copy");
        var msg = copy.parentNode.querySelector(".share-msg");
        var done = function () { if (msg) msg.textContent = "Link copied."; };
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () { if (msg) msg.textContent = url; });
        else if (msg) msg.textContent = url;
        sfEvent("share", { method: "copy" });
      }
      var shareA = e.target.closest && e.target.closest(".share a");
      if (shareA) sfEvent("share", { method: (shareA.textContent || "").trim() });
      var go = e.target.closest && e.target.closest('a[href*="/go/"]');
      if (go) { sfEvent("cta", { link: go.getAttribute("href") }); maybeRecordSend(go); }
      var shareBtn = e.target.closest && e.target.closest("#sf-share-result");
      if (shareBtn) { e.preventDefault(); shareResult(shareBtn); return; }
      var saveBtn = e.target.closest && e.target.closest("#sf-save-route");
      if (saveBtn) { e.preventDefault(); saveRoute(saveBtn.getAttribute("data-route"), currentAmount(saveBtn)); saveBtn.textContent = "Saved"; return; }
    });
    document.addEventListener("submit", function (e) {
      var f = e.target;
      if (f && (f.id === "sf-alert-form" || f.id === "sf-exit-form" || (f.classList && f.classList.contains("news-form")))) sfEvent("newsletter", {});
    });
    var form = document.getElementById("sf-search");
    if (form) {
      var input = document.getElementById("sf-q");
      var section = document.getElementById("sf-search-section");
      var out = document.getElementById("sf-search-out");
      var suggest = document.getElementById("sf-search-suggest");
      var index = [];
      function recent() {
        var list = readList("sf-searches");
        if (!suggest || input.value || !list.length) { if (suggest && !input.value) suggest.innerHTML = ""; return; }
        suggest.innerHTML = list.slice(0, 6).map(function (q) { return "<button type=\"button\" data-q=\"" + escText(q) + "\">" + escText(q) + "</button>"; }).join("");
      }
      function run(q) {
        var words = q.toLowerCase().split(/\s+/).filter(Boolean);
        var kind = section ? section.value : "";
        var hits = index.filter(function (item) {
          if (kind && item.kind !== kind) return false;
          var hay = (item.title + " " + (item.description || "") + " " + (item.tags || []).join(" ")).toLowerCase();
          return words.every(function (w) { return hay.indexOf(w) !== -1; });
        }).slice(0, 20);
        if (!hits.length) {
          out.innerHTML = "<p>Nothing matched. Try a country, a fee, or a permit. Start from the <a href=\"" + escText(root || "/") + "guides/\">guides</a> or the <a href=\"" + escText(root || "/") + "cost-to-build/\">house calculator</a>.</p>";
          return;
        }
        out.innerHTML = "<ul class=\"route-links\">" + hits.map(function (h) {
          return "<li><a href=\"" + escText((root || "/") + h.url) + "\">" + escText(h.title) + "</a></li>";
        }).join("") + "</ul>";
      }
      fetch((root || "/") + "data/search.json", { cache: "no-cache" }).then(function (r) { return r.json(); }).then(function (data) {
        index = data.items || [];
        var params = new URLSearchParams(location.search);
        if (params.get("section") && section) section.value = params.get("section");
        if (params.get("q")) { input.value = params.get("q"); run(params.get("q")); }
        recent();
      }).catch(function () { out.textContent = "Search could not load on this copy of the page."; });
      input.addEventListener("input", function () {
        var q = input.value.trim().toLowerCase();
        if (!suggest) return;
        if (q.length < 2) { recent(); return; }
        var tips = index.filter(function (item) { return item.title.toLowerCase().indexOf(q) !== -1; }).slice(0, 5);
        suggest.innerHTML = tips.map(function (item) { return "<button type=\"button\" data-q=\"" + escText(item.title) + "\">" + escText(item.title) + "</button>"; }).join("");
      });
      suggest && suggest.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest("[data-q]");
        if (!b) return;
        input.value = b.getAttribute("data-q");
        form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
      });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var q = input.value.trim();
        if (!q) return;
        var list = [q].concat(readList("sf-searches").filter(function (x) { return x !== q; })).slice(0, 8);
        try { localStorage.setItem("sf-searches", JSON.stringify(list)); } catch (err) {}
        var query = "?q=" + encodeURIComponent(q) + (section && section.value ? "&section=" + encodeURIComponent(section.value) : "");
        history.replaceState(null, "", query);
        run(q);
        if (suggest) suggest.innerHTML = "";
        sfEvent("search", { search_term: q });
      });
    }
    if (cfg.newsletter && window.matchMedia("(min-width: 900px)").matches) {
      document.addEventListener("mouseout", function (e) {
        if (e.clientY > 8 || e.relatedTarget) return;
        try { if (sessionStorage.getItem("sf-exit")) return; sessionStorage.setItem("sf-exit", "1"); } catch (err) { return; }
        var box = document.createElement("div");
        box.className = "exit";
        var embed = String(cfg.newsletter).indexOf("embed-subscribe") !== -1 ? "<input type=\"hidden\" name=\"embed\" value=\"1\">" : "";
        box.innerHTML = "<form id=\"sf-exit-form\" action=\"" + escText(cfg.newsletter) + "\" method=\"post\"><h2>Before you go</h2><p>One morning email with the rate. We ask you to confirm the address first. Unsubscribe in every message.</p>" + embed + "<label class=\"label\" for=\"sf-exit-email\">Email</label><input id=\"sf-exit-email\" name=\"email\" type=\"email\" required><button type=\"submit\">Send me the rate</button> <button type=\"button\" data-exit-close>Not now</button></form>";
        document.body.appendChild(box);
        box.addEventListener("click", function (ev) { if (ev.target === box || (ev.target.closest && ev.target.closest("[data-exit-close]"))) box.remove(); });
      });
    }
    var vitals = {};
    try { vitals = JSON.parse(localStorage.getItem("sf-vitals") || "{}"); } catch (e) { vitals = {}; }
    function storeVitals() {
      vitals.at = new Date().toISOString();
      try { localStorage.setItem("sf-vitals", JSON.stringify(vitals)); } catch (e) {}
    }
    if (window.PerformanceObserver) {
      try { new PerformanceObserver(function (list) { var entries = list.getEntries(); var last = entries[entries.length - 1]; if (last) { vitals.lcp = Math.round(last.startTime); storeVitals(); } }).observe({ type: "largest-contentful-paint", buffered: true }); } catch (e) {}
      try { var cls = 0; new PerformanceObserver(function (list) { list.getEntries().forEach(function (en) { if (!en.hadRecentInput) cls += en.value; }); vitals.cls = Math.round(cls * 1000) / 1000; storeVitals(); }).observe({ type: "layout-shift", buffered: true }); } catch (e) {}
      try { new PerformanceObserver(function (list) { var entries = list.getEntries(); var last = entries[entries.length - 1]; if (last) { vitals.inp = Math.round(last.duration || 0); storeVitals(); } }).observe({ type: "event", buffered: true, durationThreshold: 40 }); } catch (e) {}
    }
    var vbox = document.getElementById("sf-vitals");
    if (vbox) vbox.textContent = (vitals.lcp || vitals.inp || vitals.cls != null) ? ("Last note in this browser: " + (vitals.lcp ? "largest paint " + vitals.lcp + " ms. " : "") + (vitals.inp ? "slow input " + vitals.inp + " ms. " : "") + (vitals.cls != null ? "layout shift " + vitals.cls + ". " : "") + "This is not a 75th-percentile field report.") : "No speed note in this browser yet. Open a public page, then come back. The note stays on this device.";
    var deskSearch = document.getElementById("sf-desk-searches");
    if (deskSearch) {
      var words = readList("sf-searches");
      deskSearch.textContent = words.length ? "Searches in this browser: " + words.join(", ") : "No searches stored in this browser.";
    }
  }
  function consentCopy() {
    var line = "SendFair uses Google Translate if you pick a language, and Impact so a provider can credit a signup.";
    var extra = [];
    if (cfg.ga4) extra.push("Google Analytics");
    if (cfg.gtm) extra.push("Google Tag Manager");
    if (cfg.clarity) extra.push("Microsoft Clarity");
    if (cfg.adsenseClient) extra.push("Google ads");
    if (extra.length) line += " If you accept, it also loads " + extra.join(", ") + ".";
    line += " You can compare rates without the optional tools.";
    return line;
  }
  function setupConsentBar() {
    if (document.getElementById("sf-consent") || consentChoice()) {
      if (consentChoice() === "all") { loadTrackers(); loadImpact(); loadAds(); loadDrive(); }
      return;
    }
    var bar = document.createElement("div");
    bar.id = "sf-consent";
    bar.className = "consent";
    bar.innerHTML = '<div class="wrap"><p>' + consentCopy() + ' <a href="' + (root || "") + 'privacy/">Privacy</a></p><div class="consent-actions"><button type="button" data-c="essential">Essential only</button><button type="button" class="btn" data-c="all">Accept</button></div></div>';
    (document.body || document.documentElement).appendChild(bar);
    bar.addEventListener("click", function (e) {
      var b = e.target.closest("[data-c]"); if (!b) return;
      var choice = b.getAttribute("data-c");
      try { localStorage.setItem("sf-consent", JSON.stringify(choice)); } catch (err) {}
      bar.remove();
      if (choice === "essential") stripImpact();
      if (choice === "all") { loadTrackers(); loadImpact(); loadAds(); loadDrive(); }
    });
  }

  function prefetch(urls) {
    var run = function () {
      urls.forEach(function (href) {
        if (!href) return;
        var link = document.createElement("link");
        link.rel = "prefetch";
        link.as = "document";
        link.href = href;
        document.head.appendChild(link);
      });
    };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 1500);
  }

  function setupCookieSettings() {
    var btn = document.getElementById("sf-cookie-settings");
    if (!btn) return;
    if (!consentChoice()) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.addEventListener("click", function () {
      try { localStorage.removeItem("sf-consent"); } catch (err) {}
      location.reload();
    });
  }
  function setupAiHelper() {
    if (document.getElementById("sf-ai-btn")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "sf-ai-btn";
    btn.className = "ai-btn";
    btn.setAttribute("aria-label", "Ask SendFair");
    btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H8l-4 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    var panel = document.createElement("div");
    panel.id = "sf-ai";
    panel.className = "ai-panel";
    panel.hidden = true;
    panel.innerHTML = '<div class="ai-head"><strong>Ask SendFair</strong><button type="button" id="sf-ai-close" aria-label="Close">×</button></div>' +
      '<div class="ai-msgs" id="sf-ai-msgs"><div class="ai-msg ai-bot">Hi! Ask me about a route (e.g. "UK to Kenya for 250") or building a house.</div></div>' +
      '<form class="ai-form" id="sf-ai-form"><input id="sf-ai-input" placeholder="e.g. UK to Kenya for 250" autocomplete="off" aria-label="Your question"><button type="submit">Send</button></form>';
    document.body.appendChild(btn);
    document.body.appendChild(panel);
    function add(cls, text) {
      var d = document.createElement("div");
      d.className = "ai-msg " + cls;
      d.textContent = text;
      var box = document.getElementById("sf-ai-msgs");
      box.appendChild(d);
      box.scrollTop = box.scrollHeight;
    }
    btn.addEventListener("click", function () {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) document.getElementById("sf-ai-input").focus();
    });
    document.getElementById("sf-ai-close").addEventListener("click", function () { panel.hidden = true; });
    document.getElementById("sf-ai-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = document.getElementById("sf-ai-input");
      var q = input.value.trim();
      if (!q) return;
      input.value = "";
      add("ai-user", q);
      add("ai-bot", "…");
      fetch(root + "api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q })
      }).then(function (r) { return r.json(); }).then(function (d) {
        var msgs = document.getElementById("sf-ai-msgs");
        msgs.lastElementChild.textContent = d.answer || "Sorry, something went wrong.";
        msgs.scrollTop = msgs.scrollHeight;
      }).catch(function () {
        var msgs = document.getElementById("sf-ai-msgs");
        msgs.lastElementChild.textContent = "Sorry, couldn't reach the assistant. Try again.";
      });
    });
  }
  setupAiHelper();
  setupNav();
  fixAvatars();
  setupLanguage();
  setupConsentBar();
  setupCookieSettings();
  setupDiscovery();
  if (location.pathname.indexOf("/cost-to-build/") === -1) prefetch([root + "cost-to-build/"]);

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
      S.comments = [];
      return getJSON("data/reports-demo.json").then(function (d) { S.reports = (d.routes || {})[key()] || {}; }).catch(function () { S.reports = {}; });
    }
    if (!cfg.reportsEnabled) { S.reports = {}; S.comments = []; return Promise.resolve(); }
    return fetch(root + "api/reports?route=" + encodeURIComponent(key())).then(function (r) { return r.ok ? r.json() : { providers: {} }; })
      .then(function (d) { S.reports = d.providers || {}; S.comments = d.comments || []; renderComments(); }).catch(function () { S.reports = {}; S.comments = []; });
  }

  function fillSelects() {
    var opt = function (x) { return '<option value="' + x.id + '">' + R.esc(x.label || x.name) + " (" + x.currency + ")</option>"; };
    $("sf-from").innerHTML = S.corridors.senders.map(opt).join("");
    $("sf-to").innerHTML = S.corridors.receivers.map(opt).join("");
    var last = store.get("sf-last") || {};
    var qs = new URLSearchParams(location.search);
    $("sf-from").value = qs.get("from") || SF.from || last.from || "uk";
    $("sf-to").value = qs.get("to") || SF.to || last.to || "kenya";
    var cur = sender().currency;
    var qAmt = parseFloat(qs.get("amount"));
    $("sf-amount").value = qAmt > 0 ? qAmt : (SF.amount > 0 ? SF.amount : (last.amount && last.currency === cur ? last.amount : (cfg.defaultAmounts || {})[cur] || 300));
    if (last.payout && R.LABEL[last.payout]) setPayout(last.payout);
    if (last.payIn) S.payIn = last.payIn;
    if (last.promo) S.promo = !!last.promo;
    if (SF.routeUrl && location.pathname.indexOf("/send-money/") === -1) {
      prefetch([SF.routeUrl.replace("{from}", $("sf-from").value).replace("{to}", $("sf-to").value)]);
    }
  }

  function setPayout(v) {
    S.payout = v;
    document.querySelectorAll("[data-payout]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-payout") === v)); });
  }

  function context() {
    var s = sender(), r = receiver(), k = key();
    var entered = parseFloat($("sf-amount").value);
    var target = S.mode === "get" ? (entered > 0 ? entered : 0) : undefined;
    var amount = target === undefined ? entered : NaN;
    var mid = R.midRate(S.mid, s.currency, r.currency);
    var list = S.quotes[k] || [];
    var opts = { list: list, feed: S.feed[k] || null, providers: S.providers, amount: amount, target: target, payout: S.payout, payIn: S.payIn, promo: S.promo, customer: S.promo ? "new" : "", mid: mid, now: Date.now(), staleH: cfg.staleAfterHours || 36, hideH: cfg.hideAfterHours || 72, handLockH: cfg.preferAutoAfterHours || cfg.handLockHours || 6, refAmount: (cfg.defaultAmounts || {})[s.currency] };
    var rows = R.rank(opts);
    var allRows = (S.payout === "all" && S.payIn === "all") ? rows : R.rank(Object.assign({}, opts, { payout: "all", payIn: "all" }));
    var hist = Object.keys((S.history || {}).days || {}).sort().map(function (d) { var e = S.history.days[d][k] || {}; return { d: d, mid: e.mid, best: e.best }; }).filter(function (e) { return e.mid || e.best; });
    if (target !== undefined) { var top0 = rows.filter(function (x) { return !x.stale; })[0]; amount = top0 ? top0.pay : NaN; }
    var from = $("sf-from").value, coverage = S.coverage[k] && S.coverage[k].length ? S.coverage[k] : Object.keys(S.providers).filter(function (id) { var p = S.providers[id]; return !p.sendsFrom || p.sendsFrom.indexOf(from) > -1; });
    var ranked = {};
    rows.forEach(function (x) { ranked[x.p.id] = 1; });
    var gulfExtras = { uae: ["luluexchange", "alansari", "alfardan", "moneygram", "wise", "remitly"], oman: ["worldremit", "westernunion", "moneygram", "luluexchange", "omanexchange", "ria"] };
    var extra = gulfExtras[from] || [];
    extra.forEach(function (id) { if (coverage.indexOf(id) < 0) coverage = coverage.concat([id]); });
    ["lemfi", "nala", "mukuru"].forEach(function (id) {
      var p = S.providers[id];
      if (p && (!p.sendsFrom || p.sendsFrom.indexOf(from) > -1) && coverage.indexOf(id) < 0) coverage = coverage.concat([id]);
    });
    return {
      s: s, r: r, key: k, amount: amount, target: target, payout: S.payout, payIn: S.payIn, promo: S.promo, mid: mid, rows: rows, allRows: allRows, hist: hist, open: S.open, now: Date.now(), timeStyle: "relative",
      list: list, feed: opts.feed, staleH: opts.staleH, hideH: opts.hideH, handLockH: opts.handLockH, providers: S.providers,
      anyQuotes: list.length > 0, reports: S.reports, hrefFor: hrefFor, disclosureHref: SF.disclosureHref || "#",
      checkList: coverage.map(function (id) { return S.providers[id]; }).filter(Boolean),
      pending: coverage.map(function (id) { return S.providers[id]; }).filter(function (p) { return p && !ranked[p.id]; }),
      ssa: !!(R.SSA && R.SSA[r.id]),
      avgPct: (cfg.regionalAverageCost || {}).percent || 8.46, avgLabel: (cfg.regionalAverageCost || {}).label || "",
      midUpdated: S.mid && S.mid.updatedAt, quotesUpdated: S.quotesUpdated,
      midPrev: S.mid && S.mid.previous ? R.midRate(S.mid.previous, s.currency, r.currency) : null, midPrevAt: S.mid && S.mid.previous && S.mid.previous.updatedAt
    };
  }

  // One-tap common amounts next to the amount box, in the sending currency.
  function renderQuick() {
    var box = $("sf-quick"); if (!box) return;
    box.hidden = S.mode === "get";
    var list = (cfg.quickAmounts || {})[sender().currency] || [];
    var cur = parseFloat($("sf-amount").value);
    if (cur > 0 && list.indexOf(cur) < 0) list = list.concat([cur]).sort(function (a, b) { return a - b; });
    box.innerHTML = list.map(function (a) { return '<button type="button" data-amt="' + a + '" aria-pressed="' + (a === cur) + '">' + (a >= 1000 ? a / 1000 + "k" : a) + "</button>"; }).join("");
  }

  function render() {
    renderQuick();
    var c = context();
    var get = S.mode === "get";
    $("sf-cur").textContent = c.s.currency;
    var mb = $("sf-mode");
    if (mb) {
      mb.innerHTML = (get ? "Get" : "Pay") + ' <span class="mode-cur">' + (get ? c.r.currency : c.s.currency) + '</span><span class="mode-ic" aria-hidden="true">⇄</span>';
      mb.setAttribute("aria-label", (get ? "Amount they receive, in " + c.r.currency : "Amount you pay, in " + c.s.currency) + ". Switch to " + (get ? "the amount you pay" : "the amount they need"));
      var lab = $("sf-amount-label"); if (lab) lab.textContent = get ? "They need to receive" : "You pay in total";
      $("sf-amount").closest(".amount-wrap").classList.toggle("is-get", get);
    }
    if (!get) store.set("sf-last", { from: c.s.id, to: c.r.id, amount: c.amount, currency: c.s.currency, payout: S.payout, payIn: S.payIn, promo: S.promo });
    $("sf-meta").innerHTML = R.metaLine(c);
    $("sf-note").textContent = c.r.note || "";
    $("sf-note").hidden = !c.r.note;
    $("sf-results").innerHTML = R.renderResults(c);
    if ($("sf-picks")) $("sf-picks").innerHTML = R.picks(c);
    var wa = $("sf-wa");
    if (wa) {
      var url = SF.pageUrl || (SF.siteUrl + "/send-money/" + c.s.id + "-to-" + c.r.id + "/");
      wa.href = "https://wa.me/?text=" + encodeURIComponent(R.shareText(c, url));
      wa.setAttribute("data-url", url);
    }
    fillReportProviders(c);
    renderPhone(c);
    ensureFilters();
    fixCopy(c);
  }

  function setPayIn(v) {
    S.payIn = v;
    document.querySelectorAll("[data-payin]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-payin") === v)); });
  }

  function ensureFilters() {
    if ($("sf-payin")) {
      document.querySelectorAll("[data-payin]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-payin") === S.payIn)); });
      var pr = $("sf-promo"); if (pr) pr.setAttribute("aria-pressed", String(S.promo));
      return;
    }
    var tabs = document.querySelector(".payout-tabs");
    if (!tabs) return;
    var box = document.createElement("div");
    box.className = "extra-filters";
    box.innerHTML = '<div class="payout-field payin-field"><span class="label" id="sf-payin-label">You pay by</span><div class="payout-tabs" id="sf-payin" role="group" aria-labelledby="sf-payin-label">' +
      '<button type="button" data-payin="all" aria-pressed="' + (S.payIn === "all") + '">Any</button>' +
      '<button type="button" data-payin="bank" aria-pressed="' + (S.payIn === "bank") + '">Bank</button>' +
      '<button type="button" data-payin="card" aria-pressed="' + (S.payIn === "card") + '">Card</button></div></div>' +
      '<button type="button" class="promo-btn" id="sf-promo" aria-pressed="' + S.promo + '">First-transfer offers</button>';
    tabs.parentNode.appendChild(box);
  }

  function fixCopy(c) {
    var hasMobile = (c.allRows || c.rows).some(function (x) { return !x.stale && (x.q.payout || []).indexOf("mobile") > -1; });
    var top = c.rows.filter(function (x) { return !x.stale; })[0];
    var amt = R.money(c.amount, c.s.currency, 0).replace(/\u00a0/g, " ");
    document.querySelectorAll("details").forEach(function (d) {
      var s = d.querySelector("summary"), p = d.querySelector("p");
      if (!s || !p) return;
      var q = s.textContent;
      if (/cheapest way/i.test(q) && !c.rows.length) {
        p.textContent = "No service publishes an online price for this route yet. Compare the services listed above in their apps or at a branch, using the mid-market figure as a guide. There is no ranking on this page until an online quote is checked.";
      } else if (/cheapest way/i.test(q) && top) {
        p.textContent = "For " + amt + ", " + top.p.name + " delivers the most after fees and the exchange-rate margin. The order can change with the amount: check the table of common amounts on this page. The ranking updates when you change the figure above.";
      }
      if (/receive the money|Vodafone Cash|OPay|M-Pesa|mobile money/i.test(q) && /several services pay out to mobile money/i.test(p.textContent) && !hasMobile) {
        p.textContent = "None of the services we priced on this check list a mobile-money payout. Use Bank above the ranking, or confirm on the provider's own site.";
      }
    });
    var lede = document.querySelector(".hero .lede, .hero-copy .lede");
    if (lede && /Vodafone Cash|Orange Cash|InstaPay/.test(lede.textContent) && !hasMobile) {
      lede.textContent = lede.textContent.replace(/ by Vodafone Cash, Orange Cash and InstaPay-linked wallets, bank or cash pickup/i, " by bank").replace(/Vodafone Cash, Orange Cash and InstaPay-linked wallets, /g, "");
    }
    document.querySelectorAll(".howto li").forEach(function (li) {
      if (!c.rows.length && /service at the top/i.test(li.textContent)) {
        li.innerHTML = "<strong>Compare in the app or at a branch.</strong> No service publishes an online price for this route yet, so there is no ranking to use. Open the services listed above and compare what they quote for your amount.";
      }
    });
    fixAvatars();
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
    store.set("sf-last", { from: $("sf-from").value, to: $("sf-to").value, amount: parseFloat($("sf-amount").value), currency: last.currency, payout: S.payout, payIn: S.payIn, promo: S.promo });
    if (SF.from && SF.routeUrl) { location.href = routeUrl($("sf-from").value, $("sf-to").value); return; }
    var cur = sender().currency;
    if (last.currency !== cur) $("sf-amount").value = (cfg.defaultAmounts || {})[cur] || 300;
    loadReports().then(render);
  }

  function bind() {
    $("sf-from").addEventListener("change", onRouteChange);
    $("sf-to").addEventListener("change", onRouteChange);
    $("sf-amount").addEventListener("input", render);
    S.open = {};
    // Switch between "you pay" and "they need to receive": the amount carries over at today's best rate.
    var modeBtn = $("sf-mode");
    if (modeBtn) modeBtn.addEventListener("click", function () {
      var c = context(), v;
      if (S.mode === "get") { S.mode = "pay"; v = c.amount; }
      else { S.mode = "get"; var top = c.rows.filter(function (x) { return !x.stale; })[0]; v = top ? top.gets : (c.mid ? c.amount * c.mid : 0); }
      if (v > 0) $("sf-amount").value = v >= 1000 ? Math.round(v / 100) * 100 : Math.round(v);
      render();
      $("sf-amount").focus();
    });
    document.addEventListener("click", function (e) {
      var mb = e.target.closest && e.target.closest(".more-btn");
      if (mb) {
        var id = mb.getAttribute("aria-controls"), panel = document.getElementById(id), on = mb.getAttribute("aria-expanded") !== "true";
        mb.setAttribute("aria-expanded", String(on)); if (panel) panel.hidden = !on; S.open[id] = on;
        return;
      }
      var pk = e.target.closest && e.target.closest(".pick[data-payout]");
      if (pk) { setPayout(pk.getAttribute("data-payout")); render(); return; }
      var pi = e.target.closest && e.target.closest("[data-payin]");
      if (pi) { setPayIn(pi.getAttribute("data-payin")); render(); return; }
      if (e.target.closest && e.target.closest("#sf-promo")) { S.promo = !S.promo; render(); }
    });
    var quick = $("sf-quick");
    if (quick) quick.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-amt]"); if (!btn) return;
      $("sf-amount").value = btn.getAttribute("data-amt");
      render();
    });
    document.querySelectorAll("[data-payout]").forEach(function (b) {
      b.addEventListener("click", function () { setPayout(b.getAttribute("data-payout")); render(); });
    });
    setupAlerts();

    var copy = $("sf-copy");
    if (copy) copy.addEventListener("click", function () {
      var url = $("sf-wa").getAttribute("data-url");
      var done = function () { $("sf-share-msg").textContent = "Link copied."; };
      try {
        navigator.clipboard.writeText(url).then(done, function () { $("sf-share-msg").textContent = url; });
      } catch (e) { $("sf-share-msg").textContent = url; }
    });

    // Rate alert on route pages: saved through /api/alert; a confirmation email follows.
    var af = $("sf-alert-route");
    if (af) af.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = $("sf-alert-msg"), btn = af.querySelector("button");
      var via = (af.querySelector('input[name="sf-alert-via"]:checked') || {}).value || "email";
      var body = { route: af.getAttribute("data-route"), email: af.email.value.trim(), amount: parseFloat(af.amount.value), target: parseFloat(af.target.value), via: via, whatsapp: (af.whatsapp && af.whatsapp.value || "").trim() };
      if (window.turnstile) { var tk = window.turnstile.getResponse(); if (!tk) { msg.textContent = "Please complete the captcha."; return; } body.turnstile = tk; }
      if (via === "whatsapp") {
        if (!/^\+?[0-9\s-]{8,}$/.test(body.whatsapp)) { msg.textContent = "Enter a WhatsApp number with country code."; $("sf-alert-wa").focus(); return; }
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) { msg.textContent = "Enter a valid email address."; af.email.focus(); return; }
      if (!(body.amount > 0) || !(body.target > 0)) { msg.textContent = "Enter both amounts."; return; }
      btn.disabled = true; msg.textContent = "Saving…";
      fetch(root + "api/alert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          btn.disabled = false;
          if (!x.ok) { msg.textContent = x.d.error || "Could not save your alert. Try again."; return; }
          msg.textContent = via === "whatsapp"
            ? (x.d.pending ? "Saved. We'll send a WhatsApp confirmation to " + body.whatsapp + " when the target is hit." : "Alert saved for WhatsApp " + body.whatsapp + ".")
            : (x.d.pending ? "Saved. We'll send a confirmation email to " + body.email + " within a day; click it to switch the alert on." : "Check your email: click the link we sent to " + body.email + " to switch the alert on.");
          af.email.value = "";
        })
        .catch(function () { btn.disabled = false; msg.textContent = "Could not save your alert. Check your connection and try again."; });
    });

    var alertForm = $("sf-alert-form");
    if (alertForm && alertForm.getAttribute("data-demo") === "1") {
      alertForm.addEventListener("submit", function (e) {
        e.preventDefault();
        $("sf-alert-msg").textContent = "Alerts are switched off in this preview. On the live site this adds the email to your mailing list.";
      });
    }

    function setupAlerts() {
      var af = $("sf-alert-route");
      if (!af || $("sf-alert-via")) return;
      var email = af.querySelector('input[type=email]');
      if (!email) return;
      var via = document.createElement("div");
      via.className = "alert-via";
      via.innerHTML = '<label><input type="radio" name="sf-alert-via" value="email" checked> Email</label>' +
        '<label><input type="radio" name="sf-alert-via" id="sf-alert-via" value="whatsapp"> WhatsApp</label>';
      email.parentNode.insertBefore(via, email);
      var wa = document.createElement("input");
      wa.type = "tel"; wa.name = "whatsapp"; wa.id = "sf-alert-wa"; wa.placeholder = "+254 7xx xxx xxx"; wa.hidden = true;
      email.parentNode.insertBefore(wa, email.nextSibling);
      via.addEventListener("change", function () {
        var w = via.querySelector('input[value=whatsapp]').checked;
        wa.hidden = !w; email.hidden = w; email.required = !w; wa.required = w;
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
      var ratingEl = rep.querySelector('input[name="sf-rep-rating"]:checked');
      var commentEl = $("sf-rep-comment");
      var payload = { route: key(), provider: provider, bucket: b.value, rating: ratingEl ? parseInt(ratingEl.value, 10) : 0, comment: commentEl ? commentEl.value.trim() : "" };
      fetch(root + "api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          msg.textContent = x.ok ? (payload.comment ? "Thank you. Your comment appears here once it has been reviewed." : "Thank you. Your report helps other senders.") : (x.d && x.d.error) || "Could not save your report. Try again later.";
          if (x.ok) { rep.reset(); loadReports().then(render); }
        })
        .catch(function () { msg.textContent = "Could not save your report. Check your connection and try again."; });
    });
  }

  Promise.all([getJSON("data/corridors.json"), getJSON("data/providers.json"), getJSON("data/quotes.json"), loadMid(), getJSON("data/history.json").catch(function () { return { days: {} }; }), getJSON("data/wise-feed.json").catch(function () { return { routes: {} }; })])
    .then(function (res) {
      S.corridors = res[0];
      res[1].providers.forEach(function (p) { S.providers[p.id] = p; });
      S.quotes = res[2].quotes || {};
      S.coverage = res[2].coverage || {};
      S.quotesUpdated = res[2].updatedAt;
      S.mid = res[3];
      S.history = res[4];
      S.feed = (res[5] && res[5].routes) || {};
      fillSelects();
      bind();
      return loadReports();
    })
    .then(function () {
      render();
      renderYourRoutes();
      if (new URLSearchParams(location.search).get("ref") === "share") sfEvent("share_result", { ref: "landing" });
    })
    .catch(function () {
      if (!$("sf-results").querySelector(".results")) {
        $("sf-results").innerHTML = '<div class="empty"><strong>Rates could not load.</strong><span>Check your connection and refresh the page.</span></div>';
      }
    });

  // Other small scripts on the page (Quote Check) use the same consent-gated event helper.
  window.SF = SF;
  SF.track = sfEvent;
  SF.allowOptional = allowOptional;
})();
