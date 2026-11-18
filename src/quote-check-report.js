/* Browser side of the private Quote Check report page: payment, status polling and GA4 events. */
(function () {
  "use strict";

  function track(name, params) {
    var tries = 0;
    function fire() {
      if (window.SF && typeof window.SF.track === "function") {
        window.SF.track(name, params || {});
        return;
      }
      if (++tries < 20) setTimeout(fire, 200);
    }
    fire();
  }

  function sessionOnce(key) {
    try {
      if (sessionStorage.getItem(key)) return false;
      sessionStorage.setItem(key, "1");
      return true;
    } catch (e) {
      return true;
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    var data = document.querySelector(".qc-data");
    if (data && data.getAttribute("data-paid") === "1") {
      var order = data.getAttribute("data-order");
      track("quote_report_viewed", { order_id: order });
      if (sessionOnce("qc-purchase-" + order)) {
        track("quote_purchase", {
          order_id: order,
          value: Number(data.getAttribute("data-amount") || 0),
          currency: data.getAttribute("data-currency") || ""
        });
      }
    }

    var pay = document.getElementById("qc-pay");
    if (pay) {
      track("quote_preview_shown", {
        order_id: pay.getAttribute("data-order"),
        value: Number(pay.getAttribute("data-amount") || 0),
        currency: pay.getAttribute("data-currency") || ""
      });
      pay.addEventListener("click", function () {
        var msg = document.getElementById("qc-pay-msg");
        var value = Number(pay.getAttribute("data-amount") || 0);
        var currency = pay.getAttribute("data-currency") || "";
        track("quote_checkout_start", { order_id: pay.getAttribute("data-order"), value: value, currency: currency });
        pay.disabled = true;
        if (msg) msg.textContent = "Opening the secure checkout…";
        fetch("/api/quote-check/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: pay.getAttribute("data-order"), token: pay.getAttribute("data-token") })
        }).then(function (res) {
          return res.json().then(function (body) { return { ok: res.ok, body: body }; });
        }).then(function (r) {
          if (r.ok && r.body && r.body.url) {
            location.href = r.body.url;
            return;
          }
          pay.disabled = false;
          if (msg) msg.textContent = (r.body && r.body.error) || "Could not open the checkout. Please try again.";
        }).catch(function () {
          pay.disabled = false;
          if (msg) msg.textContent = "Could not reach the checkout. Check your connection and try again.";
        });
      });
    }

    var wait = document.querySelector(".qc-wait");
    if (wait) {
      var orderId = wait.getAttribute("data-order");
      var token = wait.getAttribute("data-token");
      var msg = document.getElementById("qc-wait-msg");
      var tries = 0;
      function poll() {
        tries++;
        fetch("/api/quote-check/status?order=" + encodeURIComponent(orderId) + "&t=" + encodeURIComponent(token), { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            if (body && body.paid) {
              location.reload();
              return;
            }
            if (body && body.refunded) {
              location.reload();
              return;
            }
            if (tries < 20) setTimeout(poll, 3000);
            else if (msg) msg.textContent = "Still waiting. The payment may still be processing; check your email or refresh this page in a minute.";
          })
          .catch(function () {
            if (tries < 20) setTimeout(poll, 3000);
            else if (msg) msg.textContent = "Still waiting. Refresh this page in a minute.";
          });
      }
      setTimeout(poll, 1500);
    }
  });
})();
