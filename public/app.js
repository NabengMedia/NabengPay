const form = document.getElementById("paymentForm");
const submitButton = document.getElementById("submitButton");
const resultBox = document.getElementById("resultBox");
const emptyState = document.getElementById("emptyState");
const latestPayment = document.getElementById("latestPayment");

let requestCount = 0;
let successfulCount = 0;
let pendingCount = 0;
let pollTimer = null;

document.getElementById("year").textContent = new Date().getFullYear();

function setResult(message, type = "pending") {
  resultBox.hidden = false;
  resultBox.className = `result-box ${type}`;
  resultBox.textContent = message;
}

function updateStats(status) {
  document.getElementById("totalCount").textContent = requestCount;
  document.getElementById("successCount").textContent = successfulCount;
  document.getElementById("pendingCount").textContent = pendingCount;
}

function addDetail(label, value) {
  const row = document.createElement("div");
  row.className = "detail-row";
  const left = document.createElement("span");
  left.textContent = label;
  const right = document.createElement("strong");
  right.textContent = value || "—";
  row.append(left, right);
  return row;
}

function renderPayment(payment, phone, provider) {
  emptyState.hidden = true;
  latestPayment.hidden = false;
  latestPayment.replaceChildren();

  const amount = document.createElement("div");
  amount.className = "payment-amount";
  amount.textContent = `GH₵ ${payment.amount || (Number(payment.amount_pesewas || 0) / 100).toFixed(2)}`;

  const status = document.createElement("span");
  status.className = `payment-status ${payment.status}`;
  status.textContent = payment.status || "pending";

  latestPayment.append(amount, status);
  latestPayment.append(
    addDetail("Reference", payment.reference),
    addDetail("Mobile number", phone),
    addDetail("Network", provider),
    addDetail("Created", payment.created_at ? new Date(payment.created_at).toLocaleString() : "—")
  );
}

function providerName(code) {
  return ({ mtn: "MTN Mobile Money", vod: "Telecel / Vodafone", atl: "AirtelTigo" })[code] || code;
}

async function checkPayment(reference, phone, provider) {
  try {
    const response = await fetch(`/api/payment/${encodeURIComponent(reference)}`, {
      headers: { "Accept": "application/json" }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to check payment status.");

    renderPayment(data, phone, providerName(provider));
    if (data.status === "success") {
      successfulCount += 1;
      pendingCount = Math.max(0, pendingCount - 1);
      updateStats();
      setResult("Payment verified successfully by Paystack.", "success");
      return true;
    }
    if (["failed", "abandoned", "reversed"].includes(data.status)) {
      pendingCount = Math.max(0, pendingCount - 1);
      updateStats();
      setResult(`The payment status is ${data.status}. If needed, start a new request.`, "error");
      return true;
    }
    renderPayment(data, phone, providerName(provider));
    setResult("Payment request is still pending. Ask the customer to approve the prompt on their phone. This page will keep checking.", "pending");
    return false;
  } catch (error) {
    setResult(`${error.message} The system will try again shortly.`, "pending");
    return false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pollTimer) clearInterval(pollTimer);
  submitButton.disabled = true;
  submitButton.textContent = "Sending request…";
  resultBox.hidden = true;

  const payload = {
    amount: Number(form.amount.value),
    phone: form.phone.value.trim(),
    provider: form.provider.value,
    email: form.email.value.trim()
  };

  try {
    const response = await fetch("/api/charge", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not start the payment request.");

    requestCount += 1;
    pendingCount += 1;
    updateStats();
    renderPayment({
      reference: data.reference,
      amount: payload.amount.toFixed(2),
      status: "pending",
      created_at: new Date().toISOString()
    }, payload.phone, providerName(payload.provider));

    const message = data.displayText
      ? `Request sent. ${data.displayText} Keep this page open while the payment is verified. Reference: ${data.reference}`
      : `Request sent to ${payload.phone}. Approve the prompt on the customer's phone. The system will verify the result with Paystack. Reference: ${data.reference}`;
    setResult(message, "pending");
    form.reset();

    const reference = data.reference;
    let checks = 0;
    pollTimer = setInterval(async () => {
      checks += 1;
      const isFinal = await checkPayment(reference, payload.phone, payload.provider);
      if (isFinal || checks >= 60) {
        clearInterval(pollTimer);
        pollTimer = null;
        if (!isFinal) setResult("This payment is still pending after several checks. You can leave this page open and refresh the status by starting a new check later. Do not treat it as paid until Paystack confirms success.", "pending");
      }
    }, 5000);
    // Check immediately once, then continue polling.
    await checkPayment(reference, payload.phone, payload.provider);
  } catch (error) {
    setResult(error.message, "error");
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Send payment request <span>→</span>';
  }
});
