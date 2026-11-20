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
            url: o.url || (item && item.url) || "", quoted: quoted, isDefault: !!o["default"],
            allIn: !!(o.allIn != null ? o.allIn : item && item.allIn)
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
      currency: c.currency, origin: c.name, optionId: chosen.id, optionName: chosen.name, choices: choices,
      allIn: !!chosen.allIn
    };
  }
  function bedrooms(m2) {
    if (m2 < 60) return 1;
    if (m2 < 95) return 2;
    if (m2 < 130) return 3;
    if (m2 < 170) return 4;
    if (m2 < 220) return 5;
    return Math.max(6, Math.round(m2 / 40));
  }
  function plotOf(beds) {
    var plots = [
      null,
      { name: "30 by 60 ft", perimeter: 54.864 },
      { name: "40 by 60 ft", perimeter: 60.96 },
      { name: "40 by 80 ft", perimeter: 73.152 },
      { name: "50 by 80 ft", perimeter: 79.248 },
      { name: "50 by 100 ft", perimeter: 91.44 }
    ];
    if (beds <= 5) return plots[beds];
    return { name: "a plot larger than 50 by 100 ft", perimeter: 91.44 + (beds - 5) * 12.192 };
  }
  function quantities(data, m2, storeys, roof) {
    var m = data.model[storeys >= 2 ? "two" : "one"];
    var footprint = m2 / (storeys >= 2 ? 2 : 1);
    var slab = roof === "slab";
    var beds = bedrooms(m2);
    var plot = plotOf(beds);
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
      beds: beds,
      kitchenM: Math.max(2.4, Math.round(m2 * 0.042 * 10) / 10),
      wardrobeM: Math.round(((m2 < 70 ? 2.4 : 3) + Math.max(0, beds - 1) * 2.4) * 10) / 10,
      wallM: Math.round(plot.perimeter - 4),
      plotName: plot.name,
      septic: 1,
      gate: 1,
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
  function permitChoice(item, pick) {
    var options = item.options || [];
    var chosen = null;
    var i;
    if (pick) for (i = 0; i < options.length; i++) if (options[i].id === pick) chosen = options[i];
    if (!chosen) for (i = 0; i < options.length; i++) if (options[i]["default"]) chosen = options[i];
    if (!chosen && options.length) chosen = options[0];
    return chosen;
  }
  function pushPermit(lines, item, pick, qty, qtyLabel, unitPrice, unitName, cost) {
    var chosen = permitChoice(item, pick);
    var guide = chosen && chosen.guide != null ? !!chosen.guide : !!item.guide;
    var source = (chosen && chosen.source) || item.source || "";
    var choices = null;
    if (item.options && item.options.length > 1) {
      choices = item.options.map(function (o) {
        var price = o.amount != null ? o.amount : o.rate;
        return { id: o.id, name: o.name, price: price, source: o.source || item.source || "", url: o.url || item.url || "", quoted: !(o.guide != null ? o.guide : item.guide), isDefault: !!o["default"] };
      });
    }
    if (choices && chosen) qtyLabel = qtyLabel + " · " + chosen.name;
    if (!(cost > 0)) {
      lines.push({ key: item.key, label: item.label, group: "Permits", qty: qty || 1, qtyLabel: qtyLabel, cost: null, quoted: false, source: source, url: item.url || "" });
      return;
    }
    lines.push({
      key: item.key, label: item.label, group: "Permits", qty: qty, qtyLabel: qtyLabel,
      unitPrice: unitPrice, unitName: unitName, cost: cost, quoted: !guide, source: source, url: item.url || "",
      choice: chosen ? chosen.id : null, choiceName: chosen ? chosen.name : null, choices: choices
    });
  }
  function addPermits(list, m2, storeys, q, subtotal, rates, currency, picks, lines) {
    if (!list || !list.length) {
      lines.push({ key: "permit", label: "Building permit", group: "Permits", qty: 1, qtyLabel: "One permit is required. No fee was published for this country in this check.", cost: null, quoted: false, source: "No published residential permit fee in this check.", url: "" });
      return;
    }
    list.forEach(function (item) {
      var chosen = permitChoice(item, picks[item.key]);
      var rate = chosen && chosen.rate != null ? chosen.rate : item.rate;
      var amount = chosen && chosen.amount != null ? chosen.amount : item.amount;
      var footprint = m2 / (storeys >= 2 ? 2 : 1);
      var method = item.method;
      if (method === "flat") {
        pushPermit(lines, item, picks[item.key], 1, item.qtyLabel, amount, "each", amount);
      } else if (method === "perM2") {
        pushPermit(lines, item, picks[item.key], Math.round(m2), Math.round(m2) + " m² of floor. " + item.qtyLabel, rate, "per m²", Math.round(m2 * rate));
      } else if (method === "usdPerM2") {
        var local = fx(rate, "USD", currency, rates);
        if (!(local > 0)) {
          pushPermit(lines, item, null, Math.round(m2), Math.round(m2) + " m². The dollar fee could not be changed into " + currency + " this month.", null, "per m²", null);
        } else {
          pushPermit(lines, item, null, Math.round(m2), Math.round(m2) + " m² at USD " + rate + " a square metre, changed at the mid-market rate. " + item.qtyLabel, local, "per m²", Math.round(m2 * local));
        }
      } else if (method === "band") {
        var step = null;
        var steps = item.steps || [];
        for (var i = 0; i < steps.length; i++) if (m2 <= steps[i].upto) { step = steps[i]; break; }
        if (!step && steps.length) step = steps[steps.length - 1];
        var bandAmount = step ? step.amount : null;
        pushPermit(lines, item, null, 1, Math.round(m2) + " m² of floor, the " + (step ? step.name : "listed") + " band. " + item.qtyLabel, bandAmount, "each", bandAmount);
      } else if (method === "percent") {
        var base = Math.max(item.minimum || 0, (item.rate || 0) * subtotal) + (item.extra || 0);
        pushPermit(lines, item, null, 1, item.qtyLabel, Math.round(base), "each", Math.round(base));
      } else if (method === "joburg") {
        var fee = m2 <= item.smallMax ? item.smallFee : Math.max(item.minimum, item.rate * m2);
        pushPermit(lines, item, null, 1, Math.round(m2) + " m². A house of " + item.smallMax + " m² or less is a flat fee. Above that the fee is " + item.rate + " a square metre, and at least " + item.minimum + ". " + item.qtyLabel, Math.round(fee), "each", Math.round(fee));
      } else if (method === "kcca") {
        var arch = item.archPerM2 * footprint;
        var slabFee = storeys >= 2 ? item.slab : 0;
        var net = arch + slabFee + item.wall + item.occupation;
        var withVat = Math.round(net * (1 + item.vat));
        var kccaLabel = Math.round(footprint) + " m² on the ground at UGX " + item.archPerM2 + ", structural inspection " + (slabFee ? "UGX " + item.slab + " for the upper slab" : "not charged on one floor") + ", boundary-wall inspection UGX " + item.wall + ", occupation permit UGX " + item.occupation + ", then " + Math.round(item.vat * 100) + "% VAT";
        pushPermit(lines, item, null, 1, kccaLabel, withVat, "each", withVat);
      } else if (method === "ghana") {
        var fixed = item.form + item.jacket + item.site + item.perBedroom * q.beds + (storeys >= 2 ? item.twoStorey : item.oneStorey);
        var ghanaFee = Math.round(fixed + item.percent * subtotal);
        var ghanaLabel = "Form " + item.form + ", jacket " + item.jacket + ", site-plan check " + item.site + ", " + item.perBedroom + " for each of " + q.beds + " bedrooms, Class A " + (storeys >= 2 ? "two-storey " + item.twoStorey : "single-storey " + item.oneStorey) + ", plus " + (item.percent * 100) + "% of this page's total before the permit. " + item.qtyLabel;
        pushPermit(lines, item, null, 1, ghanaLabel, ghanaFee, "each", ghanaFee);
      } else if (method === "nigeria") {
        var row = item.small;
        if (q.beds >= 5) row = item.large;
        else if (q.beds >= 4 || storeys >= 2) row = item.duplex;
        else if (q.beds >= 3) row = item.bungalow;
        pushPermit(lines, { key: item.key, label: item.label, source: row.source, url: item.url, guide: true }, null, 1, row.qtyLabel, row.amount, "each", row.amount);
      } else {
        pushPermit(lines, item, null, 1, item.qtyLabel || "One application", null, "each", null);
      }
    });
  }
  function roundQty(n, d) {
    var p = Math.pow(10, d || 0);
    return Math.round(n * p) / p;
  }
  var FINISH = { windows: 1, doorIn: 1, doorOut: 1, tiles: 1, wallTiles: 1, ceiling: 1, ceilingFrame: 1, paint: 1, kitchen: 1, wardrobe: 1, wc: 1, basin: 1, shower: 1, sink: 1 };
  function planOf(data) {
    var p = (data && data.planning) || {};
    return {
      contingency: p.contingencyRate > 0 ? p.contingencyRate : 0.1,
      haulage: p.siteHaulage > 0 ? p.siteHaulage : 0.4,
      economy: p.finishEconomy > 0 ? p.finishEconomy : 0.65,
      luxury: p.finishLuxury > 0 ? p.finishLuxury : 1.65
    };
  }
  function estimate(data, id, m2, storeys, rates, picks, opts) {
    var c = data.countries[id];
    if (!c || !(m2 > 0)) return null;
    storeys = storeys >= 2 ? 2 : 1;
    picks = picks || {};
    opts = opts || {};
    var finish = opts.finish === "economy" || opts.finish === "luxury" ? opts.finish : "standard";
    var steep = opts.site === "steep";
    var plan = planOf(data);
    var q = quantities(data, m2, storeys, c.roof);
    var linePicks = {};
    var pk;
    for (pk in picks) if (Object.prototype.hasOwnProperty.call(picks, pk)) linePicks[pk] = picks[pk];
    if (!linePicks.septic) linePicks.septic = q.beds <= 2 ? "small" : q.beds <= 4 ? "mid" : "large";
    var lines = [];
    function add(key, label, qty, qtyLabel, rateKey, unitName, group) {
      if (!(qty > 0)) return;
      var optionId = linePicks[key];
      var spread = false;
      if (FINISH[key] && finish !== "standard" && !optionId) {
        var menu = choicesFor(data, id, rateKey, rates);
        if (menu.length > 1) {
          var best = menu[0];
          for (var i = 1; i < menu.length; i++) {
            if (finish === "economy" ? menu[i].price < best.price : menu[i].price > best.price) best = menu[i];
          }
          optionId = best.id;
        } else spread = true;
      }
      var unit = priceOf(data, id, rateKey, rates, null, optionId);
      if (!unit) {
        lines.push({ key: key, label: label, group: group, qty: qty, qtyLabel: qtyLabel, unitName: unitName, cost: null, quoted: false, source: "No price this month." });
        return;
      }
      var price = unit.price;
      var quoted = unit.quoted;
      var source = unit.source;
      var text = qtyLabel;
      var choices = unit.choices && unit.choices.length > 1 ? unit.choices : null;
      if (choices) text += " · " + unit.optionName;
      if (spread) {
        var factor = finish === "economy" ? plan.economy : plan.luxury;
        price = price * factor;
        quoted = false;
        source = "Planning spread: priced at " + Math.round(factor * 100) + "% of the listed finish price, because this line has only one published figure. It is not a second shop receipt. " + source;
      }
      if (steep && (key === "sand" || key === "ballast")) {
        price = price * (1 + plan.haulage);
        quoted = false;
        text += ". The cubic metres are unchanged. The price includes a " + Math.round(plan.haulage * 100) + "% planning allowance for a steep plot or a long haul. A soil test is still required";
        source = "Planning allowance for a steep site or a long haul. Not a measured delivery quote. " + source;
      }
      lines.push({
        key: key, label: label, group: group, qty: qty, qtyLabel: text,
        unitPrice: price, unitName: unitName, cost: qty * price,
        quoted: quoted, source: source, url: unit.url, allIn: unit.allIn,
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
    add("kitchen", "Kitchen cupboards", roundQty(q.kitchenM, 1), roundQty(q.kitchenM, 1) + " m of base cupboards for a " + q.beds + "-bedroom kitchen. Wall cupboards on about 70% of that run are inside the rate", "kitchen", "per m", "Finishes");
    var wardrobeNote = roundQty(q.wardrobeM, 1) + " m of fitted wardrobe, one run per bedroom";
    if (q.beds > 1) wardrobeNote += ": " + (m2 < 70 ? "2.4" : "3") + " m in the main bedroom and 2.4 m in each of the other " + (q.beds - 1);
    add("wardrobe", "Wardrobes", roundQty(q.wardrobeM, 1), wardrobeNote, "wardrobe", "per m", "Finishes");
    add("elec", "Wiring", q.elecPoints, q.elecPoints + " lights and sockets, materials", "elecPoint", "per point", "Services");
    add("pipe", "Plumbing pipe", roundQty(q.pipeM, 0), Math.round(q.pipeM) + " m of pipe", "pipe", "per m", "Services");
    add("wc", "WCs", q.wc, q.wc + " WC and cistern", "wc", "each", "Services");
    add("basin", "Wash basins", q.wc, q.wc + " basin and pillar tap", "basin", "each", "Services");
    add("shower", "Showers", q.wc, q.wc + " shower", "shower", "each", "Services");
    add("sink", "Kitchen sink", 1, "One single-bowl sink", "sink", "each", "Services");
    add("tank", "Water tank", q.tank, "One 1,000 litre tank", "tank", "each", "Services");
    add("septic", "Septic tank", q.septic, "One concrete septic tank for a " + q.beds + "-bedroom house that is not on a sewer", "septic", "each", "Plot");
    add("boundary", "Boundary wall", q.wallM, q.wallM + " m around a " + q.plotName + " plot. A 4 m gate opening is left out of this length. One floor or two uses the same plot, because the wall follows the land", "boundary", "per m", "Plot");
    add("gate", "Gate", q.gate, "One vehicle gate in that opening. The wall rate does not include it", "gate", "each", "Plot");
    trade("mason", "Masons", q.masonDays, "mason");
    trade("hand", "Labourers", q.handDays, "hand");
    trade("carpenter", "Carpenter", q.carpenterDays, "carpenter");
    trade("painter", "Painter", q.painterDays, "painter");
    trade("spark", "Electrician", q.sparkDays, "spark");
    trade("plumber", "Plumber", q.plumbDays, "plumber");
    var subtotal = lines.reduce(function (s, l) { return s + (l.cost > 0 ? l.cost : 0); }, 0);
    addPermits(c.permits, m2, storeys, q, subtotal, rates, c.currency, linePicks, lines);
    var priced = lines.filter(function (l) { return l.cost > 0; });
    var total = priced.reduce(function (s, l) { return s + l.cost; }, 0);
    var stages = [];
    var seenG = {};
    lines.forEach(function (l) {
      if (!l.group) return;
      if (!seenG[l.group]) { seenG[l.group] = { group: l.group, cost: 0 }; stages.push(seenG[l.group]); }
      if (l.cost > 0) seenG[l.group].cost += l.cost;
    });
    var band = c.finished && c.finished.low > 0 && c.finished.high > 0 ? {
      low: c.finished.low * m2, high: c.finished.high * m2, perLow: c.finished.low, perHigh: c.finished.high,
      label: c.finished.label, source: c.finished.source, url: c.finished.url || ""
    } : null;
    var contractor = c.contractor && c.contractor.rate > 0 ? {
      rate: c.contractor.rate, amount: total * c.contractor.rate, source: c.contractor.source, url: c.contractor.url || ""
    } : { rate: null, amount: null, source: "No published contractor margin for this country in this check.", url: "" };
    return {
      country: c, id: id, m2: m2, storeys: storeys, beds: q.beds, lines: lines, total: total, currency: c.currency,
      quotedLines: lines.filter(function (l) { return l.quoted && (l.cost > 0 || l.slab); }).length,
      guideLines: lines.filter(function (l) { return l.cost > 0 && !l.quoted; }).length,
      missing: lines.filter(function (l) { return !(l.cost > 0) && !l.slab; }).length,
      stages: stages, band: band, finish: finish, site: steep ? "steep" : "flat",
      contingency: { rate: plan.contingency, amount: total * plan.contingency, source: "A planning allowance of " + Math.round(plan.contingency * 100) + "% of the receipt, for price movement and items this list missed. It is not a shop price." },
      contractor: contractor,
      professional: id === "kenya"
        ? { amount: null, source: "Legal Notice 188 of 2023 sets the BORAQS minimum for an architect's normal service on new works: 6% when the works cost KES 10 million to 100 million. Below that the minimum is higher, including 8% from KES 2 million to 4 million and 7.5% from KES 4 million to 6 million. A quantity surveyor and an engineer have separate scales. This line does not add a fee.", url: "https://boraqs.go.ke/wp-content/uploads/2023/09/L.-N.-188-THE-ARCHITECTS-AND-QUANTITY-SURVEYORS-ACT.pdf" }
        : { amount: null, source: "No architect or engineer fee scale was published in this check. Ask for their scale. This is not a permit.", url: "" }
    };
  }
  // A city factor multiplies materials and labour (not the permit) on the national receipt.
  function applyRegion(est, factor) {
    if (!(factor > 0) || Math.abs(factor - 1) < 1e-9) return est;
    var lines = est.lines.map(function (l) {
      if (l.group === "Permits") return l;
      return Object.assign({}, l, { cost: l.cost > 0 ? l.cost * factor : l.cost });
    });
    var total = lines.reduce(function (s, l) { return s + (l.cost > 0 ? l.cost : 0); }, 0);
    var stages = est.stages.map(function (g) {
      return g.group === "Permits" ? g : Object.assign({}, g, { cost: g.cost > 0 ? g.cost * factor : g.cost });
    });
    return Object.assign({}, est, {
      lines: lines, total: total, stages: stages,
      contingency: Object.assign({}, est.contingency, { amount: total * est.contingency.rate }),
      contractor: est.contractor.amount > 0 ? Object.assign({}, est.contractor, { amount: total * est.contractor.rate }) : est.contractor,
      region: { factor: factor }
    });
  }
  function regionalEstimate(data, id, m2, storeys, rates, picks, opts, factor) {
    return applyRegion(estimate(data, id, m2, storeys, rates, picks, opts), factor);
  }
  var api = { estimate: estimate, regionalEstimate: regionalEstimate, fx: fx, priceOf: priceOf, choicesFor: choicesFor, quantities: quantities };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SFBuild = api;

  if (typeof document === "undefined" || !document.getElementById("sf-build")) return;
  var box = document.getElementById("sf-build");
  var rootPath = box.getAttribute("data-root") || "";
  var regionFactor = parseFloat(box.getAttribute("data-factor")) || 1;
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
  // Consent is stored by app.js as JSON ("\"all\"" or "\"essential\""). done() runs once the event is sent
  // (or after 800 ms, or straight away without consent), so a page change does not drop the event.
  function track(name, params, done) {
    var finished = false, finish = function () { if (!finished) { finished = true; if (done) done(); } };
    try {
      var choice = null;
      try { choice = JSON.parse(localStorage.getItem("sf-consent") || "null"); } catch (e) {}
      if (choice !== "all") return finish();
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: name }, params || {}));
      if (window.gtag) {
        window.gtag("event", name, Object.assign({ transport_type: "beacon", event_callback: finish }, params || {}));
        setTimeout(finish, 800);
      } else finish();
    } catch (e) { finish(); }
  }
  Promise.all([getJSON("data/build-costs.json"), getJSON("data/midmarket.json"), getJSON("data/corridors.json")]).then(function (res) {
    var data = res[0], rates = (res[1] && res[1].rates) || {}, corridors = res[2];
    var country = box.getAttribute("data-country") || "kenya";
    var lang = box.getAttribute("data-lang") === "fr" ? "fr" : "en";
    var frPage = { senegal: 1, ivorycoast: 1, mali: 1, cameroon: 1, drc: 1, rwanda: 1 };
    var frCountry = { senegal: "Sénégal", ivorycoast: "Côte d'Ivoire", mali: "Mali", cameroon: "Cameroun", drc: "RD Congo", rwanda: "Rwanda" };
    var frNote = {
      senegal: "Le ciment est la fourchette de détail à Dakar. Les autres lignes sont converties depuis le Grand Accra.",
      ivorycoast: "Le ciment est le plafond officiel : une boutique doit être à ce prix ou en dessous. Les autres lignes sont converties depuis le Grand Accra.",
      mali: "Pas de liste de boutique à Bamako dans ce contrôle. Le ciment suit le plafond d'Abidjan et les autres lignes suivent ce guide. Le transport jusqu'à Bamako coûte en général en plus.",
      cameroon: "Pas de liste de boutique à Douala dans ce contrôle. Le franc d'Afrique centrale est arrimé au franc d'Afrique de l'Ouest, donc le plafond du ciment d'Abidjan sert seulement de guide.",
      drc: "Pas de liste de prix à Kinshasa ni à Lubumbashi dans ce contrôle. Chaque ligne est un guide converti depuis Nairobi, et le transport à l'intérieur de la RD Congo peut le dépasser.",
      rwanda: "Le ciment est une annonce d'un fournisseur à Kigali. Les autres lignes sont converties depuis Nairobi."
    };
    var frGroup = { "Structure": "Gros œuvre", "Walls and roof": "Murs et toiture", "Windows and doors": "Fenêtres et portes", "Finishes": "Finitions", "Services": "Réseaux", "Plot": "Parcelle", "Labour": "Main-d'œuvre", "Permits": "Permis" };
    var frLine = { cement: "Ciment", steel: "Acier", ballast: "Gravier", sand: "Sable", formwork: "Coffrage de dalle", blocks: "Blocs", roof: "Toiture", timber: "Bois de charpente", gutter: "Gouttières", windows: "Fenêtres", doorIn: "Portes intérieures", doorOut: "Portes extérieures", tiles: "Carrelage de sol", wallTiles: "Carrelage mural", ceiling: "Plafond", ceilingFrame: "Ossature de plafond", paint: "Peinture", kitchen: "Cuisine", wardrobe: "Placards", elec: "Électricité", pipe: "Tuyauterie", wc: "WC", basin: "Lavabos", shower: "Douches", sink: "Évier", tank: "Réservoir", septic: "Fosse septique", boundary: "Mur de clôture", gate: "Portail", mason: "Maçons", hand: "Manœuvres", carpenter: "Menuisier", painter: "Peintre", spark: "Électricien", plumber: "Plombier" };
    var orderKeys = [["cement", "bags", "sacs"], ["steel", "kg", "kg"], ["sand", "m³", "m³"], ["ballast", "m³", "m³"], ["blocks", "blocks", "blocs"], ["roof", "m² of sheet", "m² de tôle"], ["timber", "m² of truss", "m² de charpente"], ["windows", "windows", "fenêtres"], ["doorIn", "internal doors", "portes intérieures"], ["doorOut", "external doors", "portes extérieures"], ["tiles", "m² of floor tile", "m² de carrelage"], ["mason", "mason days", "jours de maçon"], ["hand", "labourer days", "jours de manœuvre"], ["carpenter", "carpenter days", "jours de menuisier"], ["painter", "painter days", "jours de peintre"], ["spark", "electrician days", "jours d'électricien"], ["plumber", "plumber days", "jours de plombier"]];
    var stageCheck = {
      en: {
        "Structure": "Photograph the footing trenches and the steel before the concrete goes in. Keep the cement and steel receipts.",
        "Walls and roof": "Photograph the walls at plate height and the roof before it is covered. Keep the block and sheet receipts.",
        "Windows and doors": "Photograph each frame in its opening. Keep the supplier's receipt.",
        "Finishes": "Photograph one wet room and one finished room. Keep the tile and paint receipts.",
        "Services": "Photograph the pipes and the distribution board before they are closed up. Keep the fitting receipts.",
        "Plot": "Photograph the septic tank before it is buried, and the boundary wall. Keep those receipts.",
        "Labour": "Keep a note of who was on site and for how many days. A round weekly sum with no names is the figure to question.",
        "Permits": "Keep the official receipt and the stamped approved plan. Cash with no receipt is not this fee."
      },
      fr: {
        "Structure": "Photographiez les fouilles et l'acier avant de couler le béton. Gardez les reçus du ciment et de l'acier.",
        "Walls and roof": "Photographiez les murs à la panne sablière et la toiture avant de la couvrir. Gardez les reçus des blocs et des tôles.",
        "Windows and doors": "Photographiez chaque cadre dans son ouverture. Gardez le reçu du fournisseur.",
        "Finishes": "Photographiez une pièce d'eau et une pièce finie. Gardez les reçus du carrelage et de la peinture.",
        "Services": "Photographiez les tuyaux et le tableau avant de les fermer. Gardez les reçus des appareils.",
        "Plot": "Photographiez la fosse avant de la remblayer, et le mur de clôture. Gardez ces reçus.",
        "Labour": "Notez qui était sur le chantier et pendant combien de jours. Une somme ronde sans noms est le chiffre à questionner.",
        "Permits": "Gardez le reçu officiel et le plan approuvé cacheté. De l'argent liquide sans reçu n'est pas ce frais."
      }
    };
    var leftOut = {
      en: [
        ["A soil test", "The steep-or-far switch is a planning allowance on sand and ballast. It is not a soil test."],
        ["A land survey", "Beacons and a survey stay out of the receipt."],
        ["Water beyond the tank", "The receipt has one tank. A borehole, a pump or a long connection is extra."],
        ["Power", "A grid connection, or solar where there is no grid, is not in the receipt."],
        ["A retaining wall", "A steep plot may need one. This receipt does not price it."],
        ["Price movement", "Cement and steel can move before a long build ends. This list is the month it was checked."],
        ["Borrowing", "Interest on a loan is not in the receipt."]
      ],
      fr: [
        ["Une étude de sol", "Le bouton terrain pentu est une marge sur le sable et le gravier. Ce n'est pas une étude de sol."],
        ["Un bornage", "Les bornes et le levé restent hors du reçu."],
        ["L'eau au-delà du réservoir", "Le reçu compte un réservoir. Un forage, une pompe ou un long branchement est en plus."],
        ["L'électricité", "Un branchement au réseau, ou le solaire hors réseau, n'est pas dans le reçu."],
        ["Un mur de soutènement", "Un terrain pentu peut en exiger un. Ce reçu ne le chiffre pas."],
        ["Le mouvement des prix", "Le ciment et l'acier peuvent bouger avant la fin d'un long chantier. Cette liste est celle du mois du contrôle."],
        ["L'emprunt", "Les intérêts d'un prêt ne sont pas dans le reçu."]
      ]
    };
    var lastCsv = "";
    var lastLink = "";
    function shownGroup(name) { return lang === "fr" && frGroup[name] ? frGroup[name] : name; }
    function shownLabel(l) { return lang === "fr" && frLine[l.key] ? frLine[l.key] : l.label; }
    function csvCell(value) {
      var s = String(value == null ? "" : value);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var qs = new URLSearchParams(location.search);
    var picks = {};
    qs.forEach(function (v, k) { if (k.indexOf("opt_") === 0 && v) picks[k.slice(4)] = v; });
    var house = qs.get("size") || box.getAttribute("data-size") || "3";
    var storeys = qs.get("floors") === "2" ? 2 : 1;
    var custom = house === "custom";
    if (qs.get("m2")) { custom = true; house = "custom"; }
    var finish = qs.get("finish") === "economy" || qs.get("finish") === "luxury" ? qs.get("finish") : "standard";
    var site = qs.get("site") === "steep" ? "steep" : "flat";
    var withSet = {};
    String(qs.get("with") || "").split(",").forEach(function (k) { if (k) withSet[k] = 1; });
    function m2() {
      if (custom) return parseFloat(document.getElementById("sf-build-m2").value) || 0;
      var h = data.houses.filter(function (x) { return x.id === house; })[0];
      return h ? h.m2 : 110;
    }
    function sender() {
      var id = document.getElementById("sf-build-from").value;
      return corridors.senders.filter(function (s) { return s.id === id; })[0];
    }
    function sendHref(amount) {
      var s = sender();
      if (!s) return { s: null, amt: null, href: rootPath };
      var amt = fx(amount, data.countries[country].currency, s.currency, rates);
      return { s: s, amt: amt, href: rootPath + "send-money/" + s.id + "-to-" + country + "/?amount=" + Math.max(1, Math.round(amt || 0)) };
    }
    function quoteWords(est, amount) {
      if (!(amount > 0)) return "";
      if (lang === "fr") {
        var diffFr = amount - est.total;
        var pctFr = est.total > 0 ? Math.round(Math.abs(diffFr) / est.total * 100) : 0;
        var bitsFr = ["Leur chiffre est " + money(amount, est.currency) + ". Ce reçu est " + money(est.total, est.currency) + "."];
        if (diffFr > est.total * 0.02) bitsFr.push("Il dépasse le reçu de " + money(diffFr, est.currency) + ", environ " + pctFr + " %. Demandez quelle ligne paie l'écart : la marge de l'entrepreneur, le transport, ou une réserve.");
        else if (diffFr < -est.total * 0.02) bitsFr.push("Il est sous le reçu de " + money(-diffFr, est.currency) + ", environ " + pctFr + " %. Demandez ce qui manque : les finitions, la fosse, le mur, le portail ou le permis.");
        else bitsFr.push("Il rejoint ce reçu. Demandez les mêmes quantités.");
        if (est.band) {
          var bandFr = money(est.band.low, est.currency) + " à " + money(est.band.high, est.currency);
          if (amount < est.band.low) bitsFr.push("Il est aussi sous la fourchette publiée de " + bandFr + ". Cette fourchette inclut un entrepreneur. Ce reçu non.");
          else if (amount > est.band.high) bitsFr.push("Il est aussi au-dessus de la fourchette publiée de " + bandFr + ". Demandez les quantités derrière le chiffre rond.");
          else bitsFr.push("Il est dans la fourchette publiée de " + bandFr + ". Cette fourchette inclut un entrepreneur. Ce reçu non.");
        }
        return bitsFr.join(" ");
      }
      var diff = amount - est.total;
      var pct = est.total > 0 ? Math.round(Math.abs(diff) / est.total * 100) : 0;
      var bits = ["Their figure is " + money(amount, est.currency) + ". This receipt is " + money(est.total, est.currency) + "."];
      if (diff > est.total * 0.02) {
        bits.push("It is " + money(diff, est.currency) + " above the receipt, about " + pct + "%.");
        var reasons = [];
        if (est.contractor.amount > 0) reasons.push("a published small-job contractor allowance of " + Math.round(est.contractor.rate * 100) + "% would be about " + money(est.contractor.amount, est.currency));
        reasons.push("a " + Math.round(est.contingency.rate * 100) + "% contingency would be about " + money(est.contingency.amount, est.currency));
        reasons.push("haulage beyond the city price");
        bits.push("The usual reasons a quote sits above this receipt are " + reasons.join(", ") + ".");
      } else if (diff < -est.total * 0.02) {
        bits.push("It is " + money(-diff, est.currency) + " below the receipt, about " + pct + "%. Ask which lines are missing: the finish, the septic tank, the boundary wall, the gate or the permit.");
      } else {
        bits.push("It sits with this receipt. Ask them to show the same quantities.");
      }
      if (est.band) {
        var band = money(est.band.low, est.currency) + " to " + money(est.band.high, est.currency);
        if (amount < est.band.low) bits.push("It also sits below the published whole-house band of " + band + ". That band includes a contractor. This receipt does not.");
        else if (amount > est.band.high) bits.push("It also sits above the published whole-house band of " + band + ". Ask for the quantities behind the round sum.");
        else bits.push("It sits inside the published whole-house band of " + band + ". That band includes a contractor. This receipt does not.");
      } else bits.push("No published whole-house band was in this check, so match their quote to the quantities on this receipt.");
      return bits.join(" ");
    }
    function draw() {
      var area = m2();
      var est = regionalEstimate(data, country, area, storeys, rates, picks, { finish: finish, site: site }, regionFactor);
      if (!est) { out.innerHTML = "<p>Choose a country we cover.</p>"; return; }
      var sent = sendHref(est.total);
      var s = sent.s;
      var houseName = custom ? Math.round(area) + " m²" : (data.houses.filter(function (x) { return x.id === house; })[0] || {}).name;
      var shape = storeys === 2 ? (lang === "fr" ? "maison à deux niveaux" : "maisonette, two floors") : (lang === "fr" ? "plain-pied" : "bungalow, one floor");
      var lastGroup = "";
      var lines = est.lines.map(function (l) {
        var head = "";
        if (l.group && l.group !== lastGroup) { lastGroup = l.group; head = '<div class="build-group">' + esc(shownGroup(l.group)) + "</div>"; }
        var tag = l.slab ? "" : l.cost > 0 ? (l.quoted ? '<span class="build-tag is-quoted">' + (lang === "fr" ? "Prix affiché" : "Listed price") + "</span>" : '<span class="build-tag is-guide">' + (lang === "fr" ? "Guide" : "Guide") + "</span>") : '<span class="build-tag">' + (lang === "fr" ? "Sans prix" : "No price") + "</span>";
        if (l.allIn && l.cost > 0) tag += '<span class="build-tag is-allin" title="' + esc(lang === "fr" ? "Tarif tout compris d'un entrepreneur : matériaux, main-d'œuvre, matériel et marge. Pas de main-d'œuvre à ajouter pour cette ligne." : "A contractor's all-in rate: materials, labour, equipment and margin. Don't add separate labour for this line.") + '">' + (lang === "fr" ? "Tout compris" : "All-in rate") + "</span>";
        var cost = l.slab ? (lang === "fr" ? "Compris au-dessus" : "Included above") : l.cost > 0 ? money(l.cost, est.currency) : "–";
        var pickHtml = "";
        if (l.choices) {
          pickHtml = '<label class="build-pick">' + (lang === "fr" ? "Type" : "Type") + ' <select data-pick="' + esc(l.key) + '">' + l.choices.map(function (o) {
            return '<option value="' + esc(o.id) + '"' + (o.id === l.choice ? " selected" : "") + ">" + esc(o.name) + " · " + esc(money(o.price, est.currency)) + (l.unitName ? " " + esc(l.unitName) : "") + "</option>";
          }).join("") + "</select></label>";
        }
        return head + '<div class="build-line"><div><strong>' + esc(shownLabel(l)) + "</strong> " + tag + '<span class="build-qty">' + esc(l.qtyLabel) + "</span>" + pickHtml + '</div><div class="num">' + esc(cost) + "</div></div>";
      }).join("");
      var sheetRows = "";
      var sheetGroup = "";
      est.lines.forEach(function (l) {
        if (l.group !== sheetGroup) {
          sheetGroup = l.group;
          sheetRows += '<tr class="sheet-group"><th colspan="4">' + esc(shownGroup(l.group)) + "</th></tr>";
        }
        var rate = l.unitPrice > 0 ? money(l.unitPrice, est.currency) + (l.unitName ? " " + l.unitName : "") : "–";
        var cost = l.slab ? (lang === "fr" ? "Compris au-dessus" : "Included above") : l.cost > 0 ? money(l.cost, est.currency) : "–";
        sheetRows += "<tr><td>" + esc(shownLabel(l)) + "</td><td>" + esc(l.qtyLabel) + "</td><td class=\"num\">" + esc(rate) + "</td><td class=\"num\">" + esc(cost) + "</td></tr>";
      });
      var byKey = {};
      est.lines.forEach(function (l) { byKey[l.key] = l; });
      var orderBits = [];
      var orderCsv = [];
      orderKeys.forEach(function (row) {
        var l = byKey[row[0]];
        if (!l || !(l.qty > 0)) return;
        var unit = lang === "fr" ? row[2] : row[1];
        if (l.qty === 1) {
          var one = { "external doors": "external door", "internal doors": "internal door", windows: "window", blocks: "block", "portes extérieures": "porte extérieure", "portes intérieures": "porte intérieure", "fenêtres": "fenêtre", blocs: "bloc" };
          if (one[unit]) unit = one[unit];
        }
        var bit = shownLabel(l) + " " + l.qty + " " + unit;
        orderBits.push(bit);
        orderCsv.push("<li>" + esc(shownLabel(l)) + " <strong>" + esc(String(l.qty)) + "</strong> " + esc(unit) + "</li>");
      });
      var slabNote = byKey.roof && byKey.roof.slab ? (lang === "fr" ? " Toiture en dalle : pas de tôles dans cette liste." : " Concrete roof: no sheets on this list.") : "";
      var orderTitle = lang === "fr" ? "À commander" : "Order list";
      var orderLead = lang === "fr" ? "Les quantités de ce reçu, à envoyer à la personne sur le terrain. Ce n'est pas un devis." : "The quantities on this receipt, for the person on the plot. This is not a quote.";
      var orderHtml = '<div class="build-order"><div class="build-group">' + orderTitle + "</div><p>" + esc(orderLead + slabNote) + "</p><ul>" + orderCsv.join("") + "</ul></div>";
      var bandHtml = est.band
        ? '<div class="build-finish"><span class="k">' + (lang === "fr" ? "Fourchette publiée, entrepreneur inclus" : "Published whole-house band, includes a contractor") + '</span><strong class="num">' + esc(money(est.band.low, est.currency)) + " – " + esc(money(est.band.high, est.currency)) + '</strong><span class="s">' + esc(est.band.label) + ". " + esc(est.band.source) + "</span></div>"
        : '<div class="build-finish"><span class="k">' + (lang === "fr" ? "Fourchette publiée" : "Published whole-house band") + '</span><strong class="num">' + (lang === "fr" ? "Aucune dans ce contrôle" : "No band in this check") + '</strong><span class="s">' + (lang === "fr" ? "Le reçu est le chiffre à rapprocher des sacs, des blocs et des jours. Le devis d'un entrepreneur sera au-dessus." : "The receipt is the figure you can match to bags, blocks and days. A contractor's quote will sit above it.") + "</span></div>";
      var month = est.total / 12;
      var monthSend = sendHref(month);
      var checks = stageCheck[lang] || stageCheck.en;
      var stageHtml = est.stages.filter(function (g) { return g.cost > 0; }).map(function (g) {
        var part = sendHref(g.cost);
        var pct = est.total > 0 ? Math.round(g.cost / est.total * 100) : 0;
        var linkWord = lang === "fr" ? "Envoyer cette étape" : "Send this stage";
        var link = part.s ? '<a href="' + esc(part.href) + '">' + linkWord + "</a>" : "";
        var check = checks[g.group] ? '<span class="build-check">' + esc(checks[g.group]) + "</span>" : "";
        var pctBit = lang === "fr" ? pct + " % du reçu" : pct + "% of the receipt";
        var sendBit = part.amt > 0 ? (lang === "fr" ? " · environ " + money(part.amt, part.s.currency) + " à envoyer" : " · about " + money(part.amt, part.s.currency) + " to send") : "";
        return '<div class="build-stage"><div><strong>' + esc(shownGroup(g.group)) + "</strong><span>" + esc(pctBit + sendBit) + "</span>" + check + '</div><div class="num">' + esc(money(g.cost, est.currency)) + "</div>" + link + "</div>";
      }).join("");
      var monthLine = lang === "fr"
        ? "Environ " + money(month, est.currency) + " par mois sur 12 mois" + (monthSend.amt > 0 ? ", environ " + money(monthSend.amt, monthSend.s.currency) + " à envoyer" : "") + ". C'est une répartition égale. Un vrai chantier paie le gros œuvre d'abord, donc les premiers envois sont plus gros."
        : "About " + money(month, est.currency) + " a month for 12 months" + (monthSend.amt > 0 ? ", about " + money(monthSend.amt, monthSend.s.currency) + " to send" : "") + ". That is an even split. A real build pays the structure first, so the early transfers are larger.";
      var quoteRaw = (document.getElementById("sf-build-quote").value || "").replace(/[, ]/g, "");
      var quoteAmt = parseFloat(quoteRaw);
      var quoteEmpty = lang === "fr" ? "Collez leur somme. La page la compare à ce reçu et, s'il y en a une, à la fourchette publiée." : "Paste their lump sum. We will set it against this receipt, and against the published band where we have one.";
      var quoteHtml = quoteAmt > 0 ? '<p class="build-quote-read">' + esc(quoteWords(est, quoteAmt)) + "</p>" : '<p class="build-quote-read">' + esc(quoteEmpty) + "</p>";
      var allow = [];
      var extraSum = 0;
      if (withSet.contingency) {
        extraSum += est.contingency.amount;
        allow.push("<li><strong>" + (lang === "fr" ? "Imprévus, " : "Contingency, ") + Math.round(est.contingency.rate * 100) + "%.</strong> " + esc(money(est.contingency.amount, est.currency)) + ". " + esc(est.contingency.source) + "</li>");
      }
      if (withSet.contractor) {
        if (est.contractor.amount > 0) extraSum += est.contractor.amount;
        allow.push("<li><strong>" + (lang === "fr" ? "Marge de l'entrepreneur." : "Contractor's fee.") + "</strong> " + (est.contractor.amount > 0 ? esc(money(est.contractor.amount, est.currency)) + ". " : (lang === "fr" ? "Non chiffrée. " : "Not priced. ")) + esc(est.contractor.source) + "</li>");
      }
      if (withSet.professional) allow.push("<li><strong>" + (lang === "fr" ? "Architecte et ingénieur." : "Architect and engineer.") + "</strong> " + (lang === "fr" ? "Non chiffré. " : "Not priced. ") + esc(est.professional.source) + (est.professional.url ? ' <a href="' + esc(est.professional.url) + '" target="_blank" rel="noopener">' + (lang === "fr" ? "Texte" : "Scale") + "</a>" : "") + "</li>");
      var allowHtml = '<div class="build-allow"><p>' + (lang === "fr" ? "Le reçu ci-dessus ne change pas quand vous cochez une marge." : "The receipt above does not change when you tick an allowance.") + "</p>" +
        (allow.length ? "<ul>" + allow.join("") + "</ul>" : "") +
        (extraSum > 0 ? "<p><strong>" + (lang === "fr" ? "Reçu plus les marges chiffrées : " : "Receipt plus the priced allowances: ") + esc(money(est.total + extraSum, est.currency)) + ".</strong> " + (lang === "fr" ? "Le reçu lui-même reste " : "The receipt itself is still ") + esc(money(est.total, est.currency)) + ".</p>" : "") +
        "</div>";
      var leftItems = (leftOut[lang] || leftOut.en).map(function (row) {
        return "<li><strong>" + esc(row[0]) + ".</strong> " + esc(row[1]) + "</li>";
      }).join("");
      var leftHtml = '<div class="build-left"><div class="build-group">' + (lang === "fr" ? "Hors du reçu" : "Left out of the receipt") + "</div><ul>" + leftItems + "</ul></div>";
      var extraSend = "";
      if (extraSum > 0) {
        var both = sendHref(est.total + extraSum);
        if (both.s) extraSend = '<a class="btn btn-ghost" href="' + esc(both.href) + '">' + (lang === "fr" ? "Comparer un envoi qui couvre aussi ces marges" : "Compare a transfer that also covers those allowances") + "</a>";
      }
      var setting = lang === "fr"
        ? "Le standard est le prix affiché. Économie et luxe ne changent que le carrelage, la peinture, les portes, les fenêtres et les appareils. La structure, la main-d'œuvre et le permis restent au prix affiché. Une ligne choisie à la main reste celle que vous avez choisie. "
        : "Standard is the listed price. Economy and luxury change tiles, paint, doors, windows and fittings only. Structure, labour and the permit stay on the listed price. A line you pick yourself stays as you picked it. ";
      if (site === "steep") setting += lang === "fr" ? "Le sable et le gravier incluent une marge pour un terrain pentu ou un long transport. Une étude de sol reste nécessaire. " : "Sand and ballast include a planning allowance for a steep plot or a long haul. A soil test is still required. ";
      var shareUrl = (location.origin || "") + (lang === "fr" ? "/fr" : "") + "/cost-to-build/" + country + "/" + pageQuery();
      var placeName = lang === "fr" && frCountry[country] ? frCountry[country] : est.country.name;
      var orderMessage = (lang === "fr" ? "Liste SendFair, pas un devis. " : "SendFair order list, not a quote. ") + (houseName || "") + " " + shape + ", " + placeName + ", " + est.country.city + ". " + orderBits.join(". ") + "." + slabNote + (lang === "fr" ? " Rapprochez les bons de livraison de ces quantités. " : " Match the delivery notes to these quantities. ") + shareUrl;
      var share = (lang === "fr" ? "Une " : "A ") + (houseName || (lang === "fr" ? "maison" : "house")) + " " + shape + (lang === "fr" ? " en " : " in ") + placeName + (lang === "fr" ? " revient à environ " : " comes to about ") + money(est.total, est.currency) + (lang === "fr" ? " pour le bâti, sans le terrain ni la marge de l'entrepreneur, contrôle SendFair du " : " for the build, without land or the contractor's fee, on SendFair's ") + data.updated + (lang === "fr" ? ". Rapprochez les reçus des quantités avant d'envoyer. " : " check. Match the receipts to the quantities before you send. ") + shareUrl;
      lastLink = shareUrl;
      var csvRows = [["Item", "Quantity", "Rate", "Source", "Amount"]];
      est.lines.forEach(function (l) {
        csvRows.push([shownLabel(l), l.slab ? "" : l.qtyLabel, l.unitPrice > 0 ? l.unitPrice : "", l.source || "", l.slab ? "" : (l.cost > 0 ? l.cost : "")]);
      });
      csvRows.push(["Receipt total", "", "", est.currency, est.total]);
      csvRows.push(["Left out", "Land, the contractor's fee, contingency, architect and engineer", "", "", ""]);
      lastCsv = csvRows.map(function (row) { return row.map(csvCell).join(","); }).join("\n");
      var listedWord = lang === "fr" ? " lignes au prix affiché, " : " lines from a published list, ";
      var guideWord = lang === "fr" ? " guides." : " guides.";
      var headK = lang === "fr" ? "Le reçu, sans le terrain ni la marge de l'entrepreneur" : "The receipt, without land or the contractor's fee";
      var stageTitle = lang === "fr" ? "Quand l'argent sort" : "When the money goes out";
      var sendK = lang === "fr" ? "Si vous envoyiez le reçu depuis " : "If you sent the receipt from ";
      var sendS = lang === "fr" ? "Converti au taux de milieu de marché. Les frais de transfert sont en plus. Les marges restent hors de ce montant." : "Changed at the mid-market rate. Fees on the transfer are extra. The allowances stay out of this amount.";
      var sendBtn = lang === "fr" ? "Comparer qui remet le plus" : "Compare who delivers the most";
      var ask = lang === "fr" ? "Demandez des reçus qui correspondent aux sacs, aux blocs, aux fenêtres et aux jours ci-dessus. Une somme ronde sans quantités est la façon habituelle de gonfler un devis." : "Ask for receipts that match the bags, blocks, windows and days above. A round sum with no quantities is how a quote gets inflated.";
      var receiptPage = rootPath + (lang === "fr" ? "fr/" : "") + "cost-to-build/what-this-receipt-is/";
      out.innerHTML = '<div class="build-head"><div class="build-total"><span class="k">' + esc(headK) + '</span><strong class="num">' + esc(money(est.total, est.currency)) + '</strong><span class="s">' + esc(houseName) + " · " + esc(shape) + " · " + Math.round(area) + " m² · about " + esc(money(Math.round(est.total / area), est.currency)) + " per m² · " + esc(placeName) + " · " + esc(est.country.city) + ". " + est.quotedLines + listedWord + est.guideLines + guideWord + " " + esc(setting) + "</span></div>" + bandHtml + "</div>" +
        orderHtml +
        '<div class="build-stages"><div class="build-group">' + esc(stageTitle) + "</div>" + stageHtml + '<p class="build-month">' + esc(monthLine) + "</p></div>" +
        '<div class="build-lines">' + lines + "</div>" +
        allowHtml +
        leftHtml +
        '<div id="sf-quote-read">' + quoteHtml + "</div>" +
        '<p class="note">' + esc(lang === "fr" && frNote[country] ? frNote[country] : est.country.note) + "</p>" +
        '<div class="build-send"><div><span class="k">' + esc(sendK + (s ? s.name : "")) + '</span><strong class="num">' + esc(sent.amt ? money(sent.amt, s.currency) : "–") + '</strong><span class="s">' + esc(sendS) + '</span></div><a class="btn" href="' + esc(sent.href) + '">' + esc(sendBtn) + "</a>" + extraSend + "</div>" +
        '<p class="build-ask">' + esc(ask) + "</p>" +
        '<p class="build-links"><button type="button" id="sf-build-print">' + (lang === "fr" ? "Imprimer ce reçu" : "Print this receipt") + '</button> <button type="button" id="sf-build-csv">' + (lang === "fr" ? "Télécharger le tableur" : "Download the spreadsheet") + '</button> <button type="button" id="sf-build-save">' + (lang === "fr" ? "Enregistrer et partager ce plan" : "Save & share this plan") + '</button> <a href="' + esc(rootPath + "cost-to-build/material-prices/") + '">' + (lang === "fr" ? "Prix des matériaux" : "Material prices") + '</a> <a href="' + esc(rootPath + "cost-to-build/same-house/") + '">' + (lang === "fr" ? "La même maison dans chaque pays" : "The same house in every country") + '</a> <a href="' + esc(receiptPage) + '">' + (lang === "fr" ? "Ce que ce reçu chiffre" : "What this receipt prices") + "</a></p>" +
        '<div class="share"><a href="https://wa.me/?text=' + encodeURIComponent(orderMessage) + '" target="_blank" rel="noopener">' + (lang === "fr" ? "Envoyer la liste sur WhatsApp" : "Send the order list on WhatsApp") + '</a> <a href="https://wa.me/?text=' + encodeURIComponent(share) + '" target="_blank" rel="noopener">' + (lang === "fr" ? "Partager le total" : "Share the total") + '</a> <button type="button" id="sf-build-copy">' + (lang === "fr" ? "Copier le lien" : "Copy the link") + "</button></div>" +
        '<details class="build-src"><summary>' + (lang === "fr" ? "D'où viennent les prix" : "Where the prices come from") + "</summary><ul>" + est.lines.filter(function (l) { return l.source; }).map(function (l) {
          return "<li><strong>" + esc(shownLabel(l)) + ".</strong> " + esc(l.source) + (l.url ? ' <a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + (lang === "fr" ? "Source" : "Source") + "</a>" : "") + "</li>";
        }).join("") + "</ul><p>" + (est.country.pricesDated ? esc((lang === "fr" ? "Prix relevés : " : "Prices dated ") + est.country.pricesDated + ". ") : "") + (lang === "fr" ? "Liste revue le " : "List reviewed ") + esc(data.updated) + (lang === "fr" ? ". Prochain contrôle le " : ". Next refresh ") + esc(data.nextReview) + ".</p></details>" + '<details class="build-src" id="sf-material-calc"><summary>' + (lang === "fr" ? "Calculateurs de matériaux" : "Material calculators") + '</summary><div class="mat-calc"><label>Concrete — floor area <input type="number" data-mat="conc-area" placeholder="m²" inputmode="decimal"> × thickness <input type="number" data-mat="conc-thick" value="0.15" step="0.01" inputmode="decimal"> m → <strong data-mat-out="conc">…</strong></label><label>Tile — floor area <input type="number" data-mat="tile-area" placeholder="m²" inputmode="decimal"> (10% waste) → <strong data-mat-out="tile">…</strong></label><label>Paint — wall area <input type="number" data-mat="paint-area" placeholder="m²" inputmode="decimal"> (2 coats) → <strong data-mat-out="paint">…</strong></label></div></details>' +
        '<article class="build-sheet"><h2>SendFair receipt</h2><p>' + esc(houseName) + " · " + esc(shape) + " · " + Math.round(area) + " m² · " + esc(placeName) + " · " + esc(est.country.city) + " · " + esc(data.updated) + "</p><p><strong>" + esc(money(est.total, est.currency)) + "</strong></p><p>" + esc(orderBits.join(" · ")) + esc(slabNote) + "</p>" +
        (est.band ? "<p>" + esc(money(est.band.low, est.currency)) + " – " + esc(money(est.band.high, est.currency)) + ". " + esc(est.band.source) + "</p>" : "") +
        '<table><thead><tr><th>Item</th><th>Quantity</th><th>Rate</th><th>Amount</th></tr></thead><tbody>' + sheetRows + "</tbody></table>" +
        (allow.length ? "<ul>" + allow.join("") + "</ul>" : "") +
        "<p>" + esc(shareUrl) + "</p></article>";
      if (history.replaceState) history.replaceState(null, "", location.pathname + pageQuery());
    }
    var countrySel = document.getElementById("sf-build-country");
    countrySel.innerHTML = Object.keys(data.countries).map(function (id) {
      var c = data.countries[id];
      var name = lang === "fr" && frCountry[id] ? frCountry[id] : c.name;
      return '<option value="' + id + '"' + (id === country ? " selected" : "") + ">" + esc(name) + "</option>";
    }).join("");
    var fromSel = document.getElementById("sf-build-from");
    var fromId = qs.get("from") || "uk";
    fromSel.innerHTML = corridors.senders.map(function (s) {
      return '<option value="' + s.id + '"' + (s.id === fromId ? " selected" : "") + ">" + esc(s.name) + "</option>";
    }).join("");
    var sizes = document.getElementById("sf-build-sizes");
    var frHouse = { "1": "1 chambre", "2": "2 chambres", "3": "3 chambres", "4": "4 chambres", "5": "5 chambres" };
    sizes.innerHTML = data.houses.map(function (h) {
      var name = lang === "fr" && frHouse[h.id] ? frHouse[h.id] : h.name;
      return '<button type="button" data-house="' + h.id + '" aria-pressed="' + (h.id === house && !custom) + '">' + esc(name) + '<span>' + h.m2 + " m²</span></button>";
    }).join("") + '<button type="button" data-house="custom" aria-pressed="' + custom + '">' + (lang === "fr" ? "Votre surface" : "Your size") + "</button>";
    document.getElementById("sf-build-custom").hidden = !custom;
    if (qs.get("m2")) document.getElementById("sf-build-m2").value = qs.get("m2");
    document.querySelectorAll("#sf-build-storey [data-storeys]").forEach(function (x) {
      x.setAttribute("aria-pressed", String(parseInt(x.getAttribute("data-storeys"), 10) === storeys));
    });
    document.querySelectorAll("#sf-build-finish [data-finish]").forEach(function (x) {
      x.setAttribute("aria-pressed", String(x.getAttribute("data-finish") === finish));
    });
    document.querySelectorAll("#sf-build-site [data-site]").forEach(function (x) {
      x.setAttribute("aria-pressed", String(x.getAttribute("data-site") === site));
    });
    var quoteInput = document.getElementById("sf-build-quote");
    if (qs.get("quote") && quoteInput) quoteInput.value = qs.get("quote");
    ["contingency", "contractor", "professional"].forEach(function (k) {
      var boxEl = document.getElementById("sf-x-" + k);
      if (boxEl) boxEl.checked = !!withSet[k];
    });
    function pageQuery() {
      var q = new URLSearchParams();
      if (house && house !== "3") q.set("size", house);
      if (storeys === 2) q.set("floors", "2");
      if (custom) q.set("m2", String(Math.round(m2()) || 120));
      if (finish !== "standard") q.set("finish", finish);
      if (site === "steep") q.set("site", "steep");
      var fromId = document.getElementById("sf-build-from").value;
      if (fromId && fromId !== "uk") q.set("from", fromId);
      var quoteNow = (document.getElementById("sf-build-quote").value || "").replace(/[, ]/g, "");
      if (parseFloat(quoteNow) > 0) q.set("quote", quoteNow);
      var withNow = ["contingency", "contractor", "professional"].filter(function (k) { return withSet[k]; });
      if (withNow.length) q.set("with", withNow.join(","));
      Object.keys(picks).forEach(function (k) { if (picks[k]) q.set("opt_" + k, picks[k]); });
      var s = q.toString();
      return s ? "?" + s : "";
    }
    countrySel.addEventListener("change", function () {
      var id = countrySel.value;
      location.assign((lang === "fr" && frPage[id] ? "/fr" : "") + "/cost-to-build/" + id + "/" + pageQuery());
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
    document.getElementById("sf-build-finish").addEventListener("click", function (e) {
      var b = e.target.closest("[data-finish]"); if (!b) return;
      finish = b.getAttribute("data-finish") || "standard";
      document.querySelectorAll("#sf-build-finish [data-finish]").forEach(function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      draw();
    });
    document.getElementById("sf-build-site").addEventListener("click", function (e) {
      var b = e.target.closest("[data-site]"); if (!b) return;
      site = b.getAttribute("data-site") === "steep" ? "steep" : "flat";
      document.querySelectorAll("#sf-build-site [data-site]").forEach(function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      draw();
    });
    document.getElementById("sf-build-quote").addEventListener("input", draw);
    ["contingency", "contractor", "professional"].forEach(function (k) {
      document.getElementById("sf-x-" + k).addEventListener("change", function (e) {
        if (e.target.checked) withSet[k] = 1;
        else delete withSet[k];
        draw();
      });
    });
    out.addEventListener("input", function (e) {
      var t = e.target, k = t.getAttribute && t.getAttribute("data-mat");
      if (!k) return;
      var box = document.getElementById("sf-material-calc");
      if (!box) return;
      var show = function (id, txt) { var el = box.querySelector('[data-mat-out="' + id + '"]'); if (el) el.textContent = txt; };
      var num = function (sel) { var el = box.querySelector('[data-mat="' + sel + '"]'); return el ? parseFloat(el.value) : NaN; };
      if (k === "conc-area" || k === "conc-thick") {
        var a = num("conc-area"), th = num("conc-thick");
        show("conc", (a > 0 && th > 0) ? "about " + Math.ceil(a * th * 7) + " bags of cement (1:2:4 mix)" : "…");
      } else if (k === "tile-area") {
        var ta = num("tile-area");
        show("tile", ta > 0 ? "about " + Math.round(ta * 1.1 * 10) / 10 + " m² of tiles" : "…");
      } else if (k === "paint-area") {
        var pa = num("paint-area");
        show("paint", pa > 0 ? "about " + Math.ceil(pa * 2 / 10) + " litres" : "…");
      }
    });
    out.addEventListener("change", function (e) {
      var sel = e.target.closest("select[data-pick]");
      if (!sel) return;
      picks[sel.getAttribute("data-pick")] = sel.value;
      draw();
    });
    out.addEventListener("click", function (e) {
      if (e.target.closest("#sf-build-print")) window.print();
      var csvBtn = e.target.closest("#sf-build-csv");
      if (csvBtn && lastCsv) {
        var blob = new Blob([lastCsv], { type: "text/csv;charset=utf-8" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "sendfair-receipt.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      var copyBtn = e.target.closest("#sf-build-copy");
      if (copyBtn && lastLink) {
        var done = function () { copyBtn.textContent = lang === "fr" ? "Lien copié" : "Link copied"; };
        var fallback = function () {
          var ta = document.createElement("textarea");
          ta.value = lastLink;
          ta.setAttribute("readonly", "");
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch (err) { copyBtn.textContent = lastLink; }
          ta.remove();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(lastLink).then(done).catch(fallback);
        else fallback();
      }
      var saveBtn = e.target.closest("#sf-build-save");
      if (saveBtn) {
        var stateObj = {};
        new URLSearchParams(pageQuery().replace(/^\?/, "")).forEach(function (v, k) { stateObj[k] = v; });
        if (box.getAttribute("data-city")) stateObj.city = box.getAttribute("data-city");
        saveBtn.disabled = true;
        saveBtn.textContent = lang === "fr" ? "Enregistrement…" : "Saving…";
        fetch(rootPath + "api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ country: country, state: stateObj }) })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (x) {
            if (!x.ok) { saveBtn.disabled = false; saveBtn.textContent = (x.d && x.d.error) || (lang === "fr" ? "Échec — réessayez" : "Could not save — try again"); return; }
            track("plan_saved", { country: country }, function () { location.href = "/cost-to-build/" + country + "/plan/" + x.d.id + "/"; });
          })
          .catch(function () { saveBtn.disabled = false; saveBtn.textContent = lang === "fr" ? "Échec — vérifiez la connexion" : "Could not save — check your connection"; });
      }
    });
    draw();
  }).catch(function () {
    out.innerHTML = '<p class="note">Building prices could not load. Check your connection and refresh the page.</p>';
  });
})(typeof window !== "undefined" ? window : globalThis);
