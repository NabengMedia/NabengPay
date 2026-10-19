/* Nabeng Paystack MoMo Collection — public/app.js
 * Frontend only. Keep Paystack secret keys and Supabase service-role keys on the server.
 */
"use strict";

(() => {
  const byId = (id) => document.getElementById(id);

  const form = byId("paymentForm");
  const submitButton = byId("submitButton");
  const resultBox = byId("resultBox");
  const emptyState = byId("emptyState");
  const latestPayment = byId("latestPayment");
  const otpSection = byId("otpSection");
  const otpInput = byId("otpInput");
  const submitOtpButton = byId("submitOtpButton");
  const historyBody = byId("historyBody");
  const historySearch = byId("historySearch");
  const historyStatus = byId("historyStatus");
  const historyRefresh = byId("historyRefresh");
  const todayAmount = byId("todayAmount");
  const todaySuccess = byId("todaySuccess");
  const todayMeta = byId("todayMeta");

  if (!form || !submitButton || !resultBox || !emptyState || !latestPayment) {
    console.error(
      "Nabeng MoMo: required page elements are missing. Check public/index.html IDs."
    );
    return;
  }

  let requestCount = 0;
  let successfulCount = 0;
  let pendingCount = 0;
  let activeReference = null;
  let activePhone = "";
  let activeProvider = "";
  let waitingForOtp = false;
  let otpHintMessage = "";
  let pollTimer = null;
  let pollInProgress = false;
  let historyTimer = null;
  const countedSuccess = new Set();
  const countedFinal = new Set();

  const year = byId("year");
  if (year) year.textContent = new Date().getFullYear();

  function setResult(message, type = "pending") {
    resultBox.hidden = false;
    resultBox.className = `result-box ${type}`;
    resultBox.textContent = message;
  }

  function updateStats() {
    const total = byId("totalCount");
    const success = byId("successCount");
    const pending = byId("pendingCount");
    if (total) total.textContent = String(requestCount);
    if (success) success.textContent = String(successfulCount);
    if (pending) pending.textContent = String(pendingCount);
  }

  function addDetail(label, value) {
    const row = document.createElement("div");
    row.className = "detail-row";
    const left = document.createElement("span");
    left.textContent = label;
    const right = document.createElement("strong");
    right.textContent = value == null || value === "" ? "—" : String(value);
    row.append(left, right);
    return row;
  }

  function formatAmount(payment) {
    if (payment.amount != null && payment.amount !== "") {
      const amount = Number(payment.amount);
      if (Number.isFinite(amount)) return amount.toFixed(2);
    }
    if (payment.amount_pesewas != null) {
      return (Number(payment.amount_pesewas) / 100).toFixed(2);
    }
    return "0.00";
  }

  function renderPayment(payment, phone, provider) {
    emptyState.hidden = true;
    latestPayment.hidden = false;
    latestPayment.replaceChildren();

    const amount = document.createElement("div");
    amount.className = "payment-amount";
    amount.textContent = `GH₵ ${formatAmount(payment)}`;

    const status = document.createElement("span");
    const normalizedStatus = String(payment.status || "pending").toLowerCase();
    status.className = `payment-status ${normalizedStatus}`;
    status.textContent = normalizedStatus.replaceAll("_", " ");

    latestPayment.append(
      amount,
      status,
      addDetail("Reference", payment.reference),
      addDetail("Mobile number", phone),
      addDetail("Network", provider),
      addDetail(
        "Created",
        payment.created_at ? new Date(payment.created_at).toLocaleString() : "—"
      )
    );
  }

  function providerName(code) {
    return (
      {
        mtn: "MTN Mobile Money",
        vod: "Telecel",
        atl: "ATMoney / AirtelTigo"
      }[String(code || "").toLowerCase()] || code || "—"
    );
  }

  function showOtpSection(hint) {
    waitingForOtp = true;
    if (hint) otpHintMessage = hint;
    if (!otpSection) return;
    otpSection.hidden = false;
    if (otpInput) otpInput.focus();
  }

  function hideOtpSection() {
    waitingForOtp = false;
    otpHintMessage = "";
    if (!otpSection) return;
    otpSection.hidden = true;
    if (otpInput) otpInput.value = "";
  }

  async function readJson(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {
        error: text.slice(0, 300) || `Server returned HTTP ${response.status}.`
      };
    }
  }

  async function apiRequest(url, options = {}) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {})
        },
        cache: "no-store"
      });
    } catch (error) {
      const networkError = new Error(
        "Could not reach the Nabeng payment server. Check your internet connection and Render service logs."
      );
      networkError.cause = error;
      throw networkError;
    }

    const data = await readJson(response);
    if (!response.ok) {
      const message =
        data.error ||
        data.message ||
        `The server returned HTTP ${response.status}.`;

      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function isFinalStatus(status) {
    return ["success", "failed", "abandoned", "reversed", "cancelled"].includes(
      String(status || "").toLowerCase()
    );
  }

  function markFinalOnce(reference, status) {
    if (countedFinal.has(reference)) return;
    countedFinal.add(reference);
    pendingCount = Math.max(0, pendingCount - 1);

    if (String(status).toLowerCase() === "success" && !countedSuccess.has(reference)) {
      countedSuccess.add(reference);
      successfulCount += 1;
    }
    updateStats();
  }

  async function loadTodayStats() {
    if (!todayAmount) return;
    try {
      const data = await apiRequest("/api/stats/today");
      todayAmount.textContent = Number(data.successAmount || 0).toFixed(2);
      if (todaySuccess) todaySuccess.textContent = String(data.successCount || 0);
      if (todayMeta) {
        todayMeta.textContent = `${data.totalRequests || 0} requests · ${data.pendingCount || 0} pending`;
      }
    } catch (error) {
      console.warn("Today stats unavailable:", error.message);
    }
  }

  function scheduleHistoryLoad(delayMs = 250) {
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      loadHistory().catch((err) => console.warn("History load failed:", err.message));
    }, delayMs);
  }

  async function loadHistory() {
    if (!historyBody) return;

    const q = historySearch ? historySearch.value.trim() : "";
    const status = historyStatus ? historyStatus.value : "";
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    params.set("limit", "40");

    try {
      const data = await apiRequest(`/api/payments?${params.toString()}`);
      const payments = data.payments || [];

      historyBody.replaceChildren();

      if (!payments.length) {
        const row = document.createElement("tr");
        row.className = "history-empty-row";
        const cell = document.createElement("td");
        cell.colSpan = 7;
        cell.textContent = q || status ? "No payments match your search." : "No payments yet.";
        row.appendChild(cell);
        historyBody.appendChild(row);
        return;
      }

      for (const payment of payments) {
        historyBody.appendChild(buildHistoryRow(payment));
      }
    } catch (error) {
      historyBody.replaceChildren();
      const row = document.createElement("tr");
      row.className = "history-empty-row";
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.textContent = `Could not load history: ${error.message}`;
      row.appendChild(cell);
      historyBody.appendChild(row);
    }
  }

  function buildHistoryRow(payment) {
    const tr = document.createElement("tr");
    const status = String(payment.status || "pending").toLowerCase();
    const when = payment.created_at
      ? new Date(payment.created_at).toLocaleString()
      : "—";

    const cells = [
      when,
      `GH₵ ${formatAmount(payment)}`,
      payment.phone || "—",
      providerName(payment.provider),
      null, // status badge
      payment.reference || "—",
      null // actions
    ];

    cells.forEach((value, index) => {
      const td = document.createElement("td");
      if (index === 4) {
        const badge = document.createElement("span");
        badge.className = `history-status ${status}`;
        badge.textContent = status.replaceAll("_", " ");
        td.appendChild(badge);
      } else if (index === 5) {
        const ref = document.createElement("div");
        ref.className = "history-ref";
        ref.title = payment.reference || "";
        ref.textContent = payment.reference || "—";
        td.appendChild(ref);
      } else if (index === 6) {
        const actions = document.createElement("div");
        actions.className = "history-actions";

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "mini-btn";
        copyBtn.textContent = "Copy";
        copyBtn.title = "Copy reference";
        copyBtn.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(payment.reference || "");
            copyBtn.textContent = "Copied";
            setTimeout(() => {
              copyBtn.textContent = "Copy";
            }, 1200);
          } catch {
            copyBtn.textContent = "Fail";
            setTimeout(() => {
              copyBtn.textContent = "Copy";
            }, 1200);
          }
        });

        const checkBtn = document.createElement("button");
        checkBtn.type = "button";
        checkBtn.className = "mini-btn";
        checkBtn.textContent = "Check";
        checkBtn.title = "Refresh status from Paystack";
        checkBtn.addEventListener("click", async () => {
          checkBtn.disabled = true;
          checkBtn.textContent = "…";
          try {
            await checkPayment(
              payment.reference,
              payment.phone || "",
              payment.provider || ""
            );
            scheduleHistoryLoad(100);
            loadTodayStats();
          } catch (error) {
            setResult(`Status check failed: ${error.message}`, "error");
          } finally {
            checkBtn.disabled = false;
            checkBtn.textContent = "Check";
          }
        });

        actions.append(copyBtn, checkBtn);
        td.appendChild(actions);
      } else if (index === 3) {
        const tag = document.createElement("span");
        tag.className = "provider-tag";
        tag.textContent = value;
        td.appendChild(tag);
      } else {
        td.textContent = value;
      }
      tr.appendChild(td);
    });

    return tr;
  }

  async function checkPayment(reference, phone, provider) {
    const data = await apiRequest(
      `/api/payment/${encodeURIComponent(reference)}`
    );

    const payment = { ...data, reference: data.reference || reference };
    renderPayment(payment, phone, providerName(provider));

    const status = String(data.status || "pending").toLowerCase();

    if (waitingForOtp && status !== "success") {
      setResult(
        otpHintMessage ||
          "An OTP was sent to the customer's phone. Enter the code below to complete the payment.",
        "pending"
      );
      if (otpSection) otpSection.hidden = false;
      return false;
    }

    if (isFinalStatus(status)) {
      markFinalOnce(reference, status);
      hideOtpSection();

      if (status === "success") {
        setResult(
          `Payment verified successfully by Paystack. Reference: ${reference}`,
          "success"
        );
        loadTodayStats();
        scheduleHistoryLoad(200);
      } else {
        setResult(
          `Paystack reports this payment as ${status}. Check the transaction before making another charge. Reference: ${reference}`,
          "error"
        );
        scheduleHistoryLoad(200);
      }
      return true;
    }

    setResult(
      `Payment status: ${status}. Ask the customer to check their phone and approve the MoMo prompt if one was sent. Do not submit another charge while this reference is unresolved.`,
      "pending"
    );
    return false;
  }

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    pollInProgress = false;
  }

  function startPolling(reference, phone, provider) {
    stopPolling();
    activeReference = reference;
    activePhone = phone;
    activeProvider = provider;
    const startedAt = Date.now();
    const maxDurationMs = waitingForOtp ? 10 * 60 * 1000 : 4 * 60 * 1000;

    const poll = async () => {
      if (activeReference !== reference || pollInProgress) return;
      if (Date.now() - startedAt >= maxDurationMs) {
        if (waitingForOtp) {
          setResult(
            `Still waiting for the OTP. Enter the code from the customer's SMS below, or check Paystack for reference ${reference}.`,
            "pending"
          );
          if (otpSection) otpSection.hidden = false;
        } else {
          setResult(
            `The payment is still unconfirmed. Do not charge again yet. Check Paystack and verify reference ${reference} before taking further action.`,
            "pending"
          );
        }
        stopPolling();
        return;
      }

      pollInProgress = true;
      try {
        const isFinal = await checkPayment(reference, phone, provider);
        if (isFinal) {
          stopPolling();
          return;
        }
      } catch (error) {
        if (waitingForOtp) {
          setResult(
            otpHintMessage ||
              `Status check failed (${error.message}). You can still enter the OTP below. Reference: ${reference}`,
            "pending"
          );
          if (otpSection) otpSection.hidden = false;
        } else {
          setResult(
            `The payment outcome is not confirmed yet. Status check failed: ${error.message} Do not retry the charge. Reference: ${reference}`,
            "pending"
          );
        }
      } finally {
        pollInProgress = false;
      }

      if (activeReference === reference) {
        const delay = waitingForOtp ? 8000 : 5000;
        pollTimer = setTimeout(poll, delay);
      }
    };

    pollTimer = setTimeout(poll, waitingForOtp ? 6000 : 3000);
  }

  function getFormValue(name) {
    const field = form.elements.namedItem(name);
    return field && typeof field.value === "string" ? field.value.trim() : "";
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitButton.disabled) return;

    stopPolling();
    hideOtpSection();
    submitButton.disabled = true;
    const originalButtonText = submitButton.textContent;
    submitButton.textContent = "Sending request…";
    resultBox.hidden = true;

    const amount = Number(getFormValue("amount"));
    const phone = getFormValue("phone");
    const provider = getFormValue("provider");
    const email = getFormValue("email");

    if (!Number.isFinite(amount) || amount <= 0) {
      setResult("Enter a valid amount greater than zero.", "error");
      submitButton.disabled = false;
      submitButton.textContent = originalButtonText || "Send payment request";
      return;
    }
    if (!phone || !provider || !email) {
      setResult("Enter the customer's phone number, network, and email.", "error");
      submitButton.disabled = false;
      submitButton.textContent = originalButtonText || "Send payment request";
      return;
    }

    const payload = { amount, phone, provider, email };

    try {
      const data = await apiRequest("/api/charge", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      const reference = data.reference;
      if (!reference) {
        setResult(
          "The server did not return a payment reference. Check Render logs before attempting another charge.",
          "error"
        );
        return;
      }

      requestCount += 1;
      pendingCount += 1;
      updateStats();

      activeReference = reference;
      activePhone = phone;
      activeProvider = provider;

      renderPayment(
        {
          reference,
          amount,
          status: "pending",
          created_at: new Date().toISOString()
        },
        phone,
        providerName(provider)
      );

      const needsOtp = Boolean(data.needsOtp || data.nextAction === "send_otp");

      if (needsOtp) {
        const hint =
          data.displayText ||
          data.customerMessage ||
          "An OTP was sent to the customer's phone. Enter the code below to complete the payment.";
        setResult(hint, "pending");
        showOtpSection(hint);
      } else {
        setResult(
          `${data.displayText ? `${data.displayText} ` : `Payment request submitted for ${phone}. `}Keep this reference for checking the result: ${reference}. Do not submit another charge until this one is resolved.`,
          "pending"
        );
      }

      form.reset();
      startPolling(reference, phone, provider);
      scheduleHistoryLoad(400);
      loadTodayStats();
    } catch (error) {
      const responseData = error.data || {};
      const reference = responseData.reference;

      if (reference) {
        requestCount += 1;
        pendingCount += 1;
        updateStats();
        activeReference = reference;
        activePhone = phone;
        activeProvider = provider;
        renderPayment(
          {
            reference,
            amount,
            status: "pending",
            created_at: new Date().toISOString()
          },
          phone,
          providerName(provider)
        );
        setResult(
          `The charge request returned an error, but its outcome may be uncertain. Check the existing reference before retrying. Reference: ${reference}. Details: ${error.message}`,
          "pending"
        );
        startPolling(reference, phone, provider);
        scheduleHistoryLoad(400);
      } else {
        setResult(
          `${error.message} No payment reference was returned, so this page cannot confirm whether Paystack received the request. Check Render logs and Paystack transactions before trying again.`,
          "error"
        );
      }
      console.error("Nabeng MoMo charge request failed:", {
        message: error.message,
        httpStatus: error.status || null,
        reference: reference || null
      });
    } finally {
      submitButton.disabled = false;
      submitButton.innerHTML = 'Send payment request <span>→</span>';
    }
  });

  if (submitOtpButton) {
    submitOtpButton.addEventListener("click", async () => {
      const reference = activeReference;
      const otp = (otpInput && otpInput.value ? otpInput.value : "").trim();

      if (!reference) {
        setResult("No active payment to submit OTP for.", "error");
        return;
      }
      if (!/^\d{4,8}$/.test(otp)) {
        setResult(
          "Enter the numeric OTP the customer received (usually 6 digits).",
          "error"
        );
        return;
      }

      submitOtpButton.disabled = true;
      const originalText = submitOtpButton.textContent;
      submitOtpButton.textContent = "Submitting…";

      try {
        const data = await apiRequest("/api/submit-otp", {
          method: "POST",
          body: JSON.stringify({ reference, otp })
        });

        const status = String(data.status || "pending").toLowerCase();

        if (status === "success") {
          markFinalOnce(reference, "success");
          hideOtpSection();
          stopPolling();
          setResult(
            `Payment verified successfully. Reference: ${reference}`,
            "success"
          );
          renderPayment(
            {
              reference,
              amount: data.amount,
              amount_pesewas: data.amount_pesewas,
              status: "success",
              created_at: new Date().toISOString()
            },
            activePhone,
            providerName(activeProvider)
          );
          loadTodayStats();
          scheduleHistoryLoad(200);
        } else if (isFinalStatus(status) && status !== "abandoned") {
          markFinalOnce(reference, status);
          hideOtpSection();
          stopPolling();
          setResult(
            `Paystack reports this payment as ${status}. Reference: ${reference}`,
            "error"
          );
          scheduleHistoryLoad(200);
        } else {
          setResult(
            data.displayText ||
              data.message ||
              "OTP submitted. Waiting for confirmation from Paystack…",
            "pending"
          );
          if (otpSection) otpSection.hidden = false;
          startPolling(reference, activePhone, activeProvider);
        }
      } catch (error) {
        setResult(`OTP submission failed: ${error.message}. You can try the code again.`, "error");
        if (otpSection) otpSection.hidden = false;
        waitingForOtp = true;
      } finally {
        submitOtpButton.disabled = false;
        submitOtpButton.textContent = originalText || "Submit OTP";
      }
    });
  }

  if (otpInput) {
    otpInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (submitOtpButton && !submitOtpButton.disabled) {
          submitOtpButton.click();
        }
      }
    });
  }

  if (historySearch) {
    historySearch.addEventListener("input", () => scheduleHistoryLoad(300));
  }
  if (historyStatus) {
    historyStatus.addEventListener("change", () => scheduleHistoryLoad(50));
  }
  if (historyRefresh) {
    historyRefresh.addEventListener("click", () => {
      scheduleHistoryLoad(0);
      loadTodayStats();
    });
  }

  // Initial load
  updateStats();
  loadTodayStats();
  scheduleHistoryLoad(0);

  window.addEventListener("beforeunload", () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (historyTimer) clearTimeout(historyTimer);
  });
})();
