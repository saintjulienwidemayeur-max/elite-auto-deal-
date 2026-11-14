// Faux Brevo pour les tests locaux (port 4556) : garde les emails reçus, lisibles via GET /_emails?a=adresse
import http from "node:http";
const MAILS = [];
http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    const send = (s, j) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.method === "POST" && req.url === "/v3/smtp/email") {
      if (req.headers["api-key"] !== "xkeysib-test") return send(401, { message: "clé" });
      const j = JSON.parse(b); MAILS.push({ a: j.to[0].email, sujet: j.subject, texte: j.textContent, html: j.htmlContent, pieces: (j.attachment || []).map(p => ({ nom: p.name, octets: Buffer.from(p.content, "base64").length, debut: Buffer.from(p.content, "base64").subarray(0, 5).toString() })) });
      return send(201, { messageId: "<test@brevo>" });
    }
    if (req.method === "GET" && req.url.startsWith("/_emails")) {
      const a = new URL(req.url, "http://x").searchParams.get("a");
      return send(200, MAILS.filter(m => !a || m.a === a));
    }
    send(404, {});
  });
}).listen(4556, () => console.log("mock brevo 4556"));
