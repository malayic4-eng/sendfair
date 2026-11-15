/* House-shell estimate: cement, steel, roofing, sand and labour.
   Shared by the static build and the browser calculator. */
(function (root) {
  "use strict";
  function fx(amount, from, to, rates) {
    if (!(amount > 0) || !rates || !rates[from] || !rates[to]) return null;
    return amount / rates[from] * rates[to];
  }
  function choicesFor(data, id, key, rates) {
    var seen = {};
    var cursor = id;
    while (cursor && !seen[cursor]) {
      seen[cursor] = 1;
      var c = data.countries[cursor];
      if (!c) break;
      var item = (c.items || {})[key];
      var hasOpts = item && item.options && item.options.length;
      var hasPrice = item && item.price > 0;
      if (hasOpts || hasPrice) {
        var raw = hasOpts ? item.options : [{ id: "listed", name: "Listed price", price: item.price, source: item.source, url: item.url, guide: !!item.guide, "default": true }];
        var home = data.countries[id];
        var out = [];
        for (var i = 0; i < raw.length; i++) {
          var o = raw[i];
          if (!(o.price > 0)) continue;
          var price = o.price;
          var source = o.source || (item && item.source) || "";
          var quoted = !o.guide && !(item && item.guide);
          if (cursor !== id) {
            price = fx(o.price, c.currency, home.currency, rates);
            if (!(price > 0)) continue;
            var note = "Guide, scaled from the " + c.name + " figure at the mid-market rate. ";
            source = source.indexOf(note) === 0 ? source : note + source;
            quoted = false;
          }
          out.push({
            id: o.id, name: o.name, price: price, source: source,
            url: o.url || (item && item.url) || "", quoted: quoted, isDefault: !!o["default"]
          });
        }
        return out;
      }
      cursor = (item && item.guideFrom) || c.guideFrom;
    }
    return [];
  }
  function priceOf(data, id, key, rates, seen, optionId) {
    var choices = choicesFor(data, id, key, rates);
    if (!choices.length) return null;
    var chosen = null;
    var i;
    if (optionId) {
      for (i = 0; i < choices.length; i++) if (choices[i].id === optionId) chosen = choices[i];
    }
    if (!chosen) {
      for (i = 0; i < choices.length; i++) if (choices[i].isDefault) chosen = choices[i];
    }
    if (!chosen) chosen = choices[0];
    var c = data.countries[id];
    return {
      price: chosen.price, quoted: chosen.quoted, source: chosen.source, url: chosen.url,
      currency: c.currency, origin: c.name, optionId: chosen.id, optionName: chosen.name, choices: choices
    };
  }
  function quantities(data, m2, storeys, roof) {
    var m = data.model[storeys >= 2 ? "two" : "one"];
    var footprint = m2 / (storeys >= 2 ? 2 : 1);
    var slab = roof === "slab";
    var q = {
      cementBags: m2 * (m.cementBags + m.cementFinish),
      steelKg: m2 * m.steelKg,
      roofM2: slab ? 0 : footprint * m.roofM2,
      timberM2: slab ? 0 : footprint * m.roofM2,
      sandM3: m2 * (m.sandM3 + m.sandFinish),
      blocks: Math.round(m2 * m.blocks),
      ballastM3: footprint * m.ballastM3,
      windows: Math.max(3, Math.round(m2 * m.windows)),
      doorsIn: Math.max(2, Math.round(m2 * m.doorsIn)),
      doorsOut: storeys >= 2 ? 2 : 1,
      tilesM2: m2 * m.tilesM2,
      wallTilesM2: m2 * (m.wallTilesM2 || 0),
      ceilingM2: slab ? 0 : m2 * m.ceilingM2,
      paintL: m2 * m.paintL,
      elecPoints: Math.max(8, Math.round(m2 * m.elecPoints)),
      pipeM: m2 * m.pipeM,
      wc: m2 < 70 ? 1 : m2 < 160 ? 2 : 3,
      tank: 1,
      gutterM: slab ? 0 : footprint * (m.gutterM || 0),
      formworkM2: slab ? m2 * (storeys >= 2 ? 1.05 : 1) : (storeys >= 2 ? footprint * 1.05 : 0),
      masonDays: m2 * (m.masonDays + m.masonFinish),
      handDays: m2 * (m.handDays + m.handFinish),
      carpenterDays: m2 * m.carpenterDays,
      painterDays: m2 * m.painterDays,
      sparkDays: m2 * m.sparkDays,
      plumbDays: m2 * m.plumbDays
    };
    if (slab) {
      q.cementBags += m2 * data.model.slabExtra.cementBags;
      q.steelKg += m2 * data.model.slabExtra.steelKg;
    }
    return q;
  }
  function roundQty(n, d) {
    var p = Math.pow(10, d || 0);
    return Math.round(n * p) / p;
  }
  function estimate(data, id, m2, storeys, rates, picks) {
    var c = data.countries[id];
    if (!c || !(m2 > 0)) return null;
    storeys = storeys >= 2 ? 2 : 1;
    picks = picks || {};
    var q = quantities(data, m2, storeys, c.roof);
    var lines = [];
    function add(key, label, qty, qtyLabel, rateKey, unitName, group) {
      if (!(qty > 0)) return;
      var unit = priceOf(data, id, rateKey, rates, null, picks[key]);
      if (!unit) {
        lines.push({ key: key, label: label, group: group, qty: qty, qtyLabel: qtyLabel, cost: null, quoted: false, source: "No price this month." });
        return;
      }
      var choices = unit.choices && unit.choices.length > 1 ? unit.choices : null;
      lines.push({
        key: key, label: label, group: group, qty: qty,
        qtyLabel: qtyLabel + (choices ? " · " + unit.optionName : ""),
        unitPrice: unit.price, unitName: unitName, cost: qty * unit.price,
        quoted: unit.quoted, source: unit.source, url: unit.url,
        choice: unit.optionId, choiceName: unit.optionName, choices: choices
      });
    }
    function trade(key, label, days, rateKey) {
      var n = Math.round(days);
      if (!(n > 0)) return;
      add(key, label, n, n + " days", rateKey, "per day", "Labour");
    }
    var bars = Math.round(q.steelKg / (data.barKg || 10.65));
    var steelNote = Math.round(q.steelKg) + " kg, for footings, the ground slab, columns, the ring beam and lintels. At 12mm by 12m that is about " + bars + " bars";
    if (storeys >= 2) steelNote += ". The two-floor allowance adds the upper slab, its beams and the staircase";
    if (c.roof === "slab") steelNote += ". The concrete roof slab is included";
    add("cement", "Cement", roundQty(q.cementBags), Math.round(q.cementBags) + " bags of 50kg, for concrete, block mortar, plaster both sides and the floor screed", "cement", "per bag", "Structure");
    add("steel", "Steel", roundQty(q.steelKg), steelNote, "steel", "per kg", "Structure");
    add("ballast", "Ballast", roundQty(q.ballastM3, 1), roundQty(q.ballastM3, 1) + " m³ of hardcore and concrete aggregate under the ground floor", "ballast", "per m³", "Structure");
    add("sand", "Sand", roundQty(q.sandM3, 1), roundQty(q.sandM3, 1) + " m³, for concrete, mortar, plaster and the screed", "sand", "per m³", "Structure");
    add("formwork", "Slab formwork", roundQty(q.formworkM2, 0), Math.round(q.formworkM2) + " m² of soffit shuttering" + (storeys >= 2 ? ", including the staircase" : ""), "formwork", "per m²", "Structure");
    add("blocks", "Blocks", q.blocks, q.blocks + " hollow blocks", "blocks", "each", "Walls and roof");
    if (c.roof === "slab") {
      lines.push({ key: "roof", group: "Walls and roof", label: "Roof", qty: 0, qtyLabel: "Concrete slab. The extra cement and steel above stand in for it. No sheets, no timber trusses, no board ceiling.", cost: 0, quoted: true, source: "No iron sheets on a concrete roof.", slab: true });
    } else {
      add("roof", "Roofing", roundQty(q.roofM2, 0), Math.round(q.roofM2) + " m² of sheet, with pitch and overhang", "roof", "per m²", "Walls and roof");
      add("timber", "Roof timber", roundQty(q.timberM2, 0), Math.round(q.timberM2) + " m² of trusses", "timber", "per m²", "Walls and roof");
      add("gutter", "Gutters and downpipes", roundQty(q.gutterM, 0), Math.round(q.gutterM) + " m around the eaves, downpipes included at the same rate", "gutter", "per m", "Walls and roof");
    }
    add("windows", "Windows", q.windows, q.windows + " windows", "window", "each", "Windows and doors");
    add("doorIn", "Internal doors", q.doorsIn, q.doorsIn + " internal doors", "doorIn", "each", "Windows and doors");
    add("doorOut", "External doors", q.doorsOut, q.doorsOut + " external door" + (q.doorsOut > 1 ? "s" : ""), "doorOut", "each", "Windows and doors");
    add("tiles", "Floor tiles", roundQty(q.tilesM2, 0), Math.round(q.tilesM2) + " m² of floor, including cutting waste", "tiles", "per m²", "Finishes");
    add("wallTiles", "Wall tiles", roundQty(q.wallTilesM2, 0), Math.round(q.wallTilesM2) + " m² on bathroom and kitchen walls", "tiles", "per m²", "Finishes");
    add("ceiling", "Ceiling boards", roundQty(q.ceilingM2, 0), Math.round(q.ceilingM2) + " m² of board", "ceiling", "per m²", "Finishes");
    add("ceilingFrame", "Ceiling frame", roundQty(q.ceilingM2, 0), Math.round(q.ceilingM2) + " m² of metal channels, screws and jointing. Fixing labour is with the carpenter", "ceilingFrame", "per m²", "Finishes");
    add("paint", "Paint", roundQty(q.paintL, 0), Math.round(q.paintL) + " litres, primer and two coats inside and out", "paint", "per litre", "Finishes");
    add("elec", "Wiring", q.elecPoints, q.elecPoints + " lights and sockets, materials", "elecPoint", "per point", "Services");
    add("pipe", "Plumbing pipe", roundQty(q.pipeM, 0), Math.round(q.pipeM) + " m of pipe", "pipe", "per m", "Services");
    add("wc", "WCs", q.wc, q.wc + " WC and cistern", "wc", "each", "Services");
    add("basin", "Wash basins", q.wc, q.wc + " basin and pillar tap", "basin", "each", "Services");
    add("shower", "Showers", q.wc, q.wc + " shower", "shower", "each", "Services");
    add("sink", "Kitchen sink", 1, "One single-bowl sink", "sink", "each", "Services");
    add("tank", "Water tank", q.tank, "One 1,000 litre tank", "tank", "each", "Services");
    trade("mason", "Masons", q.masonDays, "mason");
    trade("hand", "Labourers", q.handDays, "hand");
    trade("carpenter", "Carpenter", q.carpenterDays, "carpenter");
    trade("painter", "Painter", q.painterDays, "painter");
    trade("spark", "Electrician", q.sparkDays, "spark");
    trade("plumber", "Plumber", q.plumbDays, "plumber");
    var priced = lines.filter(function (l) { return l.cost > 0; });
    var total = priced.reduce(function (s, l) { return s + l.cost; }, 0);
    return {
      country: c, id: id, m2: m2, storeys: storeys, lines: lines, total: total, currency: c.currency,
      quotedLines: lines.filter(function (l) { return l.quoted && (l.cost > 0 || l.slab); }).length,
      guideLines: lines.filter(function (l) { return l.cost > 0 && !l.quoted; }).length,
      missing: lines.filter(function (l) { return !(l.cost > 0) && !l.slab; }).length
    };
  }
  var api = { estimate: estimate, fx: fx, priceOf: priceOf, choicesFor: choicesFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SFBuild = api;

  if (typeof document === "undefined" || !document.getElementById("sf-build")) return;
  var box = document.getElementById("sf-build");
  var rootPath = box.getAttribute("data-root") || "";
  var out = document.getElementById("sf-build-out");
  function getJSON(p) {
    return fetch(rootPath + p, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(p); return r.json(); });
  }
  function money(n, cur) {
    if (!(n > 0) && n !== 0) return "–";
    var d = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
    return cur + " " + Number(n).toLocaleString("en", { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  Promise.all([getJSON("data/build-costs.json"), getJSON("data/midmarket.json"), getJSON("data/corridors.json")]).then(function (res) {
    var data = res[0], rates = (res[1] && res[1].rates) || {}, corridors = res[2];
    var country = box.getAttribute("data-country") || "kenya";
    var qs = new URLSearchParams(location.search);
    var picks = {};
    qs.forEach(function (v, k) { if (k.indexOf("opt_") === 0 && v) picks[k.slice(4)] = v; });
    var house = qs.get("size") || "3";
    var storeys = qs.get("floors") === "2" ? 2 : 1;
    var custom = house === "custom";
    if (qs.get("m2")) { custom = true; house = "custom"; }
    function m2() {
      if (custom) return parseFloat(document.getElementById("sf-build-m2").value) || 0;
      var h = data.houses.filter(function (x) { return x.id === house; })[0];
      return h ? h.m2 : 110;
    }
    function sender() {
      var id = document.getElementById("sf-build-from").value;
      return corridors.senders.filter(function (s) { return s.id === id; })[0];
    }
    function draw() {
      var area = m2();
      var est = estimate(data, country, area, storeys, rates, picks);
      if (!est) { out.innerHTML = "<p>Choose a country we cover.</p>"; return; }
      var s = sender();
      var sendAmt = s ? fx(est.total, est.currency, s.currency, rates) : null;
      var href = s ? rootPath + "send-money/" + s.id + "-to-" + country + "/?amount=" + Math.max(1, Math.round(sendAmt)) : rootPath;
      var houseName = custom ? Math.round(area) + " m²" : (data.houses.filter(function (x) { return x.id === house; })[0] || {}).name;
      var lastGroup = "";
      var lines = est.lines.map(function (l) {
        var head = "";
        if (l.group && l.group !== lastGroup) { lastGroup = l.group; head = '<div class="build-group">' + esc(l.group) + "</div>"; }
        var tag = l.slab ? "" : l.cost > 0 ? (l.quoted ? '<span class="build-tag is-quoted">Listed price</span>' : '<span class="build-tag is-guide">Guide</span>') : '<span class="build-tag">No price</span>';
        var cost = l.slab ? "Included above" : l.cost > 0 ? money(l.cost, est.currency) : "–";
        var pickHtml = "";
        if (l.choices) {
          pickHtml = '<label class="build-pick">Type <select data-pick="' + esc(l.key) + '">' + l.choices.map(function (o) {
            return '<option value="' + esc(o.id) + '"' + (o.id === l.choice ? " selected" : "") + ">" + esc(o.name) + " · " + esc(money(o.price, est.currency)) + (l.unitName ? " " + esc(l.unitName) : "") + "</option>";
          }).join("") + "</select></label>";
        }
        return head + '<div class="build-line"><div><strong>' + esc(l.label) + "</strong> " + tag + '<span class="build-qty">' + esc(l.qtyLabel) + "</span>" + pickHtml + '</div><div class="num">' + esc(cost) + "</div></div>";
      }).join("");
      var fin = est.country.finished;
      var finHtml = "";
      if (fin) {
        finHtml = '<div class="build-finish"><span class="k">' + esc(fin.label) + '</span><strong class="num">' + esc(money(fin.low * area, est.currency)) + " – " + esc(money(fin.high * area, est.currency)) + '</strong><span class="s">' + esc(fin.source) + "</span></div>";
      }
      var shareUrl = (location.origin || "") + "/cost-to-build/" + country + "/" + pageQuery();
      var share = "A " + (houseName || "house") + (storeys === 2 ? ", two floors," : " bungalow") + " in " + est.country.name + " comes to about " + money(est.total, est.currency) + " for the build, without land or the contractor's fee, on SendFair's " + data.updated + " check. Match the receipts to the quantities before you send. " + shareUrl;
      out.innerHTML = '<div class="build-total"><span class="k">The build, without land or the contractor\'s fee</span><strong class="num">' + esc(money(est.total, est.currency)) + '</strong><span class="s">' + esc(houseName) + (storeys === 2 ? ", two floors" : ", one floor") + " · " + Math.round(area) + " m² in " + esc(est.country.city) + ". " + est.quotedLines + " line" + (est.quotedLines === 1 ? "" : "s") + " from a published list, " + est.guideLines + " guide" + (est.guideLines === 1 ? "" : "s") + ".</span></div>" +
        '<div class="build-lines">' + lines + "</div>" +
        '<p class="note">' + esc(est.country.note) + "</p>" +
        finHtml +
        '<div class="build-send"><div><span class="k">If you sent this from ' + esc(s ? s.name : "") + '</span><strong class="num">' + esc(sendAmt ? money(sendAmt, s.currency) : "–") + '</strong><span class="s">Changed at the mid-market rate. Fees on the transfer are extra. Land and the contractor\'s fee are not in the total.</span></div><a class="btn" href="' + esc(href) + '">Compare who delivers the most</a></div>' +
        '<p class="build-ask">Ask for receipts that match the bags, blocks, windows and days above. A round sum with no quantities is how a quote gets inflated.</p>' +
        '<div class="share"><a href="https://wa.me/?text=' + encodeURIComponent(share) + '" target="_blank" rel="noopener">Share on WhatsApp</a></div>' +
        '<details class="build-src"><summary>Where the prices come from</summary><ul>' + est.lines.filter(function (l) { return l.source; }).map(function (l) {
          return "<li><strong>" + esc(l.label) + ".</strong> " + esc(l.source) + (l.url ? ' <a href="' + esc(l.url) + '" target="_blank" rel="noopener">Source</a>' : "") + "</li>";
        }).join("") + "</ul><p>Checked " + esc(data.updated) + ". Next refresh " + esc(data.nextReview) + ". City prices move, and a town away from " + esc(est.country.city) + " can differ. This is not a structural design. Left out on purpose: the plot of land, the contractor's fee, permits, a septic tank or biodigester, kitchen cupboards, wardrobes, and a boundary wall.</p></details>";
    }
    var countrySel = document.getElementById("sf-build-country");
    countrySel.innerHTML = Object.keys(data.countries).map(function (id) {
      var c = data.countries[id];
      return '<option value="' + id + '"' + (id === country ? " selected" : "") + ">" + esc(c.name) + "</option>";
    }).join("");
    var fromSel = document.getElementById("sf-build-from");
    var fromId = qs.get("from") || "uk";
    fromSel.innerHTML = corridors.senders.map(function (s) {
      return '<option value="' + s.id + '"' + (s.id === fromId ? " selected" : "") + ">" + esc(s.name) + "</option>";
    }).join("");
    var sizes = document.getElementById("sf-build-sizes");
    sizes.innerHTML = data.houses.map(function (h) {
      return '<button type="button" data-house="' + h.id + '" aria-pressed="' + (h.id === house && !custom) + '">' + esc(h.name) + '<span>' + h.m2 + " m²</span></button>";
    }).join("") + '<button type="button" data-house="custom" aria-pressed="' + custom + '">Your size</button>';
    document.getElementById("sf-build-custom").hidden = !custom;
    if (qs.get("m2")) document.getElementById("sf-build-m2").value = qs.get("m2");
    document.querySelectorAll("#sf-build-storey [data-storeys]").forEach(function (x) {
      x.setAttribute("aria-pressed", String(parseInt(x.getAttribute("data-storeys"), 10) === storeys));
    });
    function pageQuery() {
      var q = new URLSearchParams();
      if (house && house !== "3") q.set("size", house);
      if (storeys === 2) q.set("floors", "2");
      if (custom) q.set("m2", String(Math.round(m2()) || 120));
      var fromId = document.getElementById("sf-build-from").value;
      if (fromId && fromId !== "uk") q.set("from", fromId);
      Object.keys(picks).forEach(function (k) { if (picks[k]) q.set("opt_" + k, picks[k]); });
      var s = q.toString();
      return s ? "?" + s : "";
    }
    countrySel.addEventListener("change", function () {
      location.assign("/cost-to-build/" + countrySel.value + "/" + pageQuery());
    });
    fromSel.addEventListener("change", draw);
    document.getElementById("sf-build-storey").addEventListener("click", function (e) {
      var b = e.target.closest("[data-storeys]"); if (!b) return;
      storeys = parseInt(b.getAttribute("data-storeys"), 10) || 1;
      document.querySelectorAll("#sf-build-storey [data-storeys]").forEach(function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      draw();
    });
    sizes.addEventListener("click", function (e) {
      var b = e.target.closest("[data-house]"); if (!b) return;
      house = b.getAttribute("data-house");
      custom = house === "custom";
      document.getElementById("sf-build-custom").hidden = !custom;
      sizes.querySelectorAll("[data-house]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      draw();
    });
    document.getElementById("sf-build-m2").addEventListener("input", draw);
    out.addEventListener("change", function (e) {
      var sel = e.target.closest("select[data-pick]");
      if (!sel) return;
      picks[sel.getAttribute("data-pick")] = sel.value;
      draw();
    });
    draw();
  }).catch(function () {
    out.innerHTML = '<p class="note">Building prices could not load. Check your connection and refresh the page.</p>';
  });
})(typeof window !== "undefined" ? window : globalThis);
