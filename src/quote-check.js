/* SendFair Quote Check upload page: file selection, client checks, upload and the free preview redirect. */
(function () {
  "use strict";

  var form = document.getElementById("qc-form");
  if (!form) return;
  var cfg = {};
  try { cfg = JSON.parse(form.getAttribute("data-config") || "{}"); } catch (e) { cfg = {}; }
  var enabled = form.getAttribute("data-enabled") === "true" && cfg.enabled !== false;
  var input = document.getElementById("qc-files");
  var drop = document.getElementById("qc-drop");
  var list = document.getElementById("qc-file-list");
  var errorBox = document.getElementById("qc-error");
  var progress = document.getElementById("qc-progress");
  var submit = document.getElementById("qc-submit");
  var country = document.getElementById("qc-country");
  var currency = document.getElementById("qc-quote-currency");
  var priceEls = document.querySelectorAll("[data-qc-price]");
  var started = false;

  function track(name, params) {
    var tries = 0;
    function fire() {
      if (window.SF && typeof window.SF.track === "function") { window.SF.track(name, params || {}); return; }
      if (++tries < 15) setTimeout(fire, 200);
    }
    fire();
  }

  function money(amount, cur) {
    var n = Number(amount);
    if (!isFinite(n)) return cur;
    return cur + " " + n.toLocaleString("en", { maximumFractionDigits: 0 });
  }

  function priceFor(cur) {
    var prices = cfg.prices || {};
    if (prices[cur] > 0) return { currency: cur, amount: prices[cur] };
    var fallback = cfg.defaultPriceCurrency || "USD";
    return { currency: fallback, amount: prices[fallback] || 0 };
  }

  function updatePrice() {
    var p = priceFor(currency ? currency.value : (cfg.defaultCurrency || "USD"));
    priceEls.forEach(function (el) { el.textContent = money(p.amount, p.currency); });
  }

  function setCurrencyForCountry() {
    if (!country || !currency) return;
    var c = (cfg.countries || {})[country.value];
    if (!c || !c.currency) return;
    var has = Array.prototype.some.call(currency.options, function (o) { return o.value === c.currency; });
    if (!has) {
      var opt = document.createElement("option");
      opt.value = c.currency;
      opt.textContent = c.currency;
      currency.appendChild(opt);
    }
    currency.value = c.currency;
    updatePrice();
  }

  function fileItems() {
    return input && input.files ? Array.prototype.slice.call(input.files) : [];
  }

  function sizeText(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  function renderFiles() {
    if (!list) return;
    var files = fileItems();
    list.innerHTML = "";
    files.forEach(function (f, i) {
      var li = document.createElement("li");
      li.className = "qc-file";
      var name = document.createElement("span");
      name.textContent = f.name + " · " + sizeText(f.size);
      var rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "Remove";
      rm.setAttribute("aria-label", "Remove " + f.name);
      rm.addEventListener("click", function () { removeFile(i); });
      li.appendChild(name);
      li.appendChild(rm);
      list.appendChild(li);
    });
  }

  function setFiles(files) {
    if (!input) return;
    try {
      var dt = new DataTransfer();
      files.forEach(function (f) { dt.items.add(f); });
      input.files = dt.files;
    } catch (e) {
      // Some older browsers cannot rebuild a FileList; the input keeps its own selection.
    }
    renderFiles();
  }

  function removeFile(index) {
    var files = fileItems();
    files.splice(index, 1);
    setFiles(files);
  }

  function clientErrors(files) {
    var errors = [];
    var max = cfg.maxFiles || 5;
    var maxFile = (cfg.maxFileMb || 15) * 1024 * 1024;
    var maxTotal = (cfg.maxTotalMb || 45) * 1024 * 1024;
    if (!files.length) errors.push("Attach at least one file: a PDF, a photo, an XLSX or a CSV.");
    if (files.length > max) errors.push("Attach no more than " + max + " files.");
    var total = 0;
    files.forEach(function (f) {
      total += f.size;
      var name = String(f.name || "").toLowerCase();
      if (!/\.(pdf|jpe?g|png|xlsx|csv)$/.test(name)) errors.push(f.name + ": use PDF, JPG/PNG, XLSX or CSV.");
      if (f.size > maxFile) errors.push(f.name + ": the file is larger than " + (cfg.maxFileMb || 15) + " MB.");
    });
    if (total > maxTotal) errors.push("The files together are larger than " + (cfg.maxTotalMb || 45) + " MB.");
    return errors;
  }

  function showError(errors) {
    if (!errorBox) return;
    var listHtml = errors.length > 1 ? "<ul>" + errors.slice(1).map(function (e) { return "<li>" + escapeHtml(e) + "</li>"; }).join("") + "</ul>" : "";
    errorBox.innerHTML = "<strong>" + escapeHtml(errors[0] || "Check the form.") + "</strong>" + listHtml;
    errorBox.hidden = false;
    errorBox.focus && errorBox.focus();
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }

  function hideError() { if (errorBox) errorBox.hidden = true; }

  function startOnce() {
    if (started) return;
    started = true;
    track("quote_upload_start", {});
  }

  if (!enabled) {
    if (submit) { submit.disabled = true; submit.textContent = "Quote Check is not open yet"; }
    if (input) input.disabled = true;
    var notice = document.getElementById("qc-disabled");
    if (notice) notice.hidden = false;
    form.addEventListener("submit", function (e) { e.preventDefault(); });
    return;
  }

  if (country) country.addEventListener("change", setCurrencyForCountry);
  if (currency) currency.addEventListener("change", updatePrice);
  updatePrice();

  if (input) {
    input.addEventListener("change", function () { startOnce(); renderFiles(); hideError(); });
  }
  if (drop) {
    drop.addEventListener("click", function (e) { if (e.target === input) return; if (input) input.click(); });
    drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input && input.click(); } });
    ["dragenter", "dragover"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("is-over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("is-over"); });
    });
    drop.addEventListener("drop", function (e) {
      startOnce();
      var dropped = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
      var existing = fileItems();
      var merged = existing.concat(dropped).slice(0, (cfg.maxFiles || 5));
      setFiles(merged);
      hideError();
    });
  }
  form.addEventListener("focusin", startOnce, { once: true });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    hideError();
    var files = fileItems();
    var errors = clientErrors(files);
    if (errors.length) { showError(errors); return; }
    if (submit) { submit.disabled = true; submit.textContent = "Reading the quote…"; }
    if (progress) progress.hidden = false;
    var data = new FormData(form);
    fetch("/api/quote-check/upload", { method: "POST", body: data })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (r) {
        if (r.ok && r.body && r.body.order && r.body.order.reportPath) {
          track("quote_uploaded", { country: country ? country.value : "", files: files.length, currency: currency ? currency.value : "" });
          if (progress) progress.querySelector("span:last-child").textContent = "Opening your free preview…";
          setTimeout(function () { location.href = r.body.order.reportPath; }, 180);
          return;
        }
        if (submit) { submit.disabled = false; submit.textContent = "Check my quote"; }
        if (progress) progress.hidden = true;
        var errs = [r.body && r.body.error ? r.body.error : "The upload failed. Please try again."];
        if (r.body && r.body.details) errs = errs.concat(r.body.details);
        showError(errs);
      })
      .catch(function () {
        if (submit) { submit.disabled = false; submit.textContent = "Check my quote"; }
        if (progress) progress.hidden = true;
        showError(["Could not reach the server. Check your connection and try again."]);
      });
  });
})();
