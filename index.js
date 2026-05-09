// ============================================================
// MIDDLEWARE: PodPay → UTMify
// Recebe webhook da PodPay, converte e repassa para UTMify
// ============================================================

const http = require("http");
const https = require("https");

// ⚠️ CONFIGURE AQUI:
const UTMIFY_API_TOKEN = "9nYQNcvyauuo7qxMmRv6xUxENagGOglm3PXG"; // Cole sua Credencial de API da UTMify
const PORT = process.env.PORT || 3000;

// ─── Mapeamento de status PodPay → UTMify ───────────────────
function mapStatus(podpayStatus) {
  const map = {
    // Pagos / aprovados
    paid: "paid",
    approved: "paid",
    completed: "paid",
    active: "paid",
    // Pendentes
    pending: "pending",
    waiting: "pending",
    processing: "pending",
    created: "pending",
    // Cancelados / falhos
    canceled: "canceled",
    cancelled: "canceled",
    failed: "canceled",
    refused: "canceled",
    expired: "canceled",
    // Reembolsados
    refunded: "refunded",
    reversed: "refunded",
    // Chargeback
    chargeback: "chargeback",
    disputed: "chargeback",
  };
  const s = (podpayStatus || "").toLowerCase();
  return map[s] || "pending";
}

// ─── Mapeamento de método de pagamento ──────────────────────
function mapPaymentMethod(method) {
  const map = {
    pix: "pix",
    credit_card: "credit_card",
    creditcard: "credit_card",
    credit: "credit_card",
    debit_card: "debit_card",
    debit: "debit_card",
    boleto: "boleto",
    billet: "boleto",
    bank_slip: "boleto",
  };
  const m = (method || "").toLowerCase();
  return map[m] || method || "pix";
}

// ─── Conversão do payload PodPay → UTMify ───────────────────
function convertPayload(podpay) {
  // A PodPay pode enviar os dados aninhados em "data" ou direto na raiz
  const data = podpay.data || podpay;

  // IDs e status
  const orderId =
    data.id ||
    data.transaction_id ||
    data.order_id ||
    data.reference ||
    String(Date.now());

  const status = mapStatus(data.status || data.transaction_status || podpay.status);

  // Cliente
  const customer = data.customer || data.buyer || data.payer || {};
  const customerName =
    customer.name ||
    customer.full_name ||
    data.customer_name ||
    data.buyer_name ||
    "";
  const customerEmail =
    customer.email || data.customer_email || data.buyer_email || "";
  const customerPhone =
    customer.phone ||
    customer.phone_number ||
    data.customer_phone ||
    data.buyer_phone ||
    "";
  const customerDoc =
    (customer.document || customer.cpf || customer.tax_id || data.document || "")
      .replace(/[.\-\/]/g, "");

  // Produto
  const products = [];
  const rawProducts = data.products || data.items || data.order_items || [];

  if (rawProducts.length > 0) {
    rawProducts.forEach((p, i) => {
      products.push({
        id: String(p.id || p.product_id || i + 1),
        name: p.name || p.product_name || p.description || "Produto",
        planId: String(p.plan_id || p.offer_id || p.id || i + 1),
        planName: p.plan_name || p.offer_name || p.name || "Oferta",
        quantity: p.quantity || p.qty || 1,
        priceInCents: String(
          p.price_in_cents ||
          p.amount_cents ||
          Math.round((p.price || p.amount || 0) * 100)
        ),
      });
    });
  } else {
    // Se não tem array de produtos, monta um produto genérico com o valor total
    const totalCents =
      data.amount_in_cents ||
      data.amount_cents ||
      data.total_cents ||
      Math.round((data.amount || data.total || data.value || 0) * 100);

    products.push({
      id: String(data.product_id || orderId),
      name: data.product_name || data.description || "Venda PodPay",
      planId: String(data.plan_id || data.offer_id || orderId),
      planName: data.plan_name || data.offer_name || "Oferta",
      quantity: 1,
      priceInCents: String(totalCents),
    });
  }

  // Valor total
  const totalCents =
    data.amount_in_cents ||
    data.amount_cents ||
    data.total_cents ||
    Math.round((data.amount || data.total || data.value || 0) * 100);

  // Data
  const createdAt =
    data.created_at ||
    data.created ||
    data.date ||
    new Date().toISOString();

  // Método de pagamento
  const paymentMethod = mapPaymentMethod(
    data.payment_method ||
    data.payment_type ||
    data.method ||
    podpay.payment_method ||
    ""
  );

  return {
    isTest: false,
    status,
    orderId: String(orderId),
    customer: {
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
      country: "BR",
      document: customerDoc,
    },
    platform: "PodPay",
    products,
    createdAt,
    commission: {
      totalPriceInCents: String(totalCents),
      gatewayFeeInCents: String(
        data.fee_in_cents || data.gateway_fee_cents || 0
      ),
      userCommissionInCents: String(totalCents),
    },
    paymentMethod,
    refundedAt: status === "refunded" ? (data.refunded_at || new Date().toISOString()) : null,
    approvedDate: status === "paid" ? (data.paid_at || data.approved_at || createdAt) : null,
  };
}

// ─── Envio para UTMify ───────────────────────────────────────
function sendToUtmify(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: "api.utmify.com.br",
      path: "/api-credentials/orders",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": UTMIFY_API_TOKEN,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        console.log(`[UTMify] Status: ${res.statusCode} | Body: ${data}`);
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on("error", (err) => {
      console.error("[UTMify] Erro na requisição:", err.message);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// ─── Servidor HTTP ───────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "PodPay → UTMify Middleware" }));
    return;
  }

  // Endpoint principal do webhook
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";

    req.on("data", (chunk) => (body += chunk));

    req.on("end", async () => {
      console.log("\n[PodPay] Webhook recebido:", body);

      try {
        const podpayPayload = JSON.parse(body);
        const utmifyPayload = convertPayload(podpayPayload);

        console.log("[Convertido] Payload UTMify:", JSON.stringify(utmifyPayload, null, 2));

        const result = await sendToUtmify(utmifyPayload);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, utmify: result }));
      } catch (err) {
        console.error("[Erro]", err.message);
        // Sempre retorna 200 para PodPay não reenviar em loop
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });

    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`✅ Middleware rodando na porta ${PORT}`);
  console.log(`   Endpoint do webhook: POST http://localhost:${PORT}/webhook`);
});
