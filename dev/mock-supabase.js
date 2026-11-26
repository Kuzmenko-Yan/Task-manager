// Локальный мок Supabase PostgREST для интеграционной проверки server.js.
// НЕ часть приложения — только для теста. Эмулирует ровно те запросы,
// которые делает server.js через @supabase/supabase-js.
const http = require("http");
const { URL } = require("url");

const tables = { users: [], tasks: [] };
let nextUserId = 1;
let nextTaskId = 1;

function matches(row, params) {
  for (const [key, val] of params.entries()) {
    if (["select", "order", "limit"].includes(key)) continue;
    const m = val.match(/^eq\.(.*)$/);
    if (m) {
      const expected = m[1];
      // Числа приходят строками — сравниваем мягко
      if (String(row[key]) !== expected) return false;
    }
  }
  return true;
}

function applyOrder(rows, orderParam) {
  if (!orderParam) return rows;
  const [col, dir] = orderParam.split(".");
  return [...rows].sort((a, b) => {
    const x = a[col], y = b[col];
    return dir === "desc" ? y - x : x - y;
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const table = url.pathname.replace("/rest/v1/", "");
  if (!tables[table]) {
    res.writeHead(404).end("{}");
    return;
  }
  const rows = tables[table];
  const wantsObject = (req.headers.accept || "").includes("vnd.pgrst.object+json");
  const wantsRepresentation = (req.headers.prefer || "").includes("return=representation");

  const sendRows = (list, status = 200) => {
    let out = applyOrder(list, url.searchParams.get("order"));
    const limit = parseInt(url.searchParams.get("limit") || "0");
    if (limit) out = out.slice(0, limit);
    if (wantsObject) {
      if (out.length === 0) {
        // Как настоящий PostgREST: 406, supabase-js maybeSingle → null
        res.writeHead(406, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "PGRST116", message: "0 rows" }));
      } else {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out[0]));
      }
    } else {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    }
  };

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const filtered = rows.filter((r) => matches(r, url.searchParams));

    if (req.method === "GET") {
      sendRows(filtered);
    } else if (req.method === "POST") {
      const data = JSON.parse(body || "{}");
      if (table === "users") {
        data.id = nextUserId++;
        data.created_at = new Date().toISOString();
      } else {
        data.id = nextTaskId++;
        data.created_at = new Date().toISOString();
      }
      rows.push(data);
      if (wantsRepresentation) sendRows([data], 201);
      else res.writeHead(201).end("");
    } else if (req.method === "PATCH") {
      const data = JSON.parse(body || "{}");
      filtered.forEach((r) => Object.assign(r, data));
      if (wantsRepresentation) sendRows(filtered);
      else res.writeHead(204).end("");
    } else if (req.method === "DELETE") {
      tables[table] = rows.filter((r) => !filtered.includes(r));
      if (wantsRepresentation) sendRows(filtered);
      else res.writeHead(204).end("");
    } else {
      res.writeHead(405).end();
    }
  });
});

server.listen(3999, () => console.log("Mock Supabase on :3999"));
