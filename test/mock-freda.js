// Faux Freda Pay Issuing pour les tests locaux (port 4555)
import http from "node:http";
const P = new Map(); let n = 0;
http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    const send = (s, j) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    if (!/^Bearer sk_test_/.test(req.headers.authorization || "")) return send(401, { error: { message: "clé" } });
    if (req.method === "POST" && req.url === "/v1/payments") {
      const j = JSON.parse(b);
      for (const p of P.values()) if (p.reference === j.reference) return send(201, p);
      if (j.method === "carte" && j.currency !== "USD") return send(400, { error: { message: "USD requis" } });
      const id = "pay_test" + (++n) + "_" + Math.random().toString(36).slice(2, 8);
      const p = { id, reference: j.reference, amount: j.amount, currency: j.currency || "HTG", method: j.method, status: "pending", fee: null, net_amount: null, checkout_url: "https://checkout.example/" + id, created_at: new Date().toISOString() };
      P.set(id, p); return send(201, p);
    }
    const m = req.url.match(/^\/v1\/payments\/(.+)$/);
    if (req.method === "GET" && m) { const p = P.get(m[1]); return p ? send(200, p) : send(404, {}); }
    const s = req.url.match(/^\/_set\/(.+)\/(succeeded|failed)$/);
    if (s) { const p = P.get(s[1]); p.status = s[2]; if (s[2] === "succeeded") { p.fee = p.amount * 0.04; p.net_amount = p.amount * 0.96; } return send(200, p); }
    send(404, {});
  });
}).listen(4555, () => console.log("mock freda 4555"));
