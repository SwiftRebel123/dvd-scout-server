const http = require("http");
const { google } = require("googleapis");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}");

console.log("API key present:", !!ANTHROPIC_API_KEY);
console.log("Sheet ID present:", !!GOOGLE_SHEET_ID);
console.log("Google credentials present:", !!GOOGLE_CREDENTIALS.client_email);

// Google Sheets auth
const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  corsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Shelf Scout server is running");
    return;
  }

  // Scan shelf image
  if (req.method === "POST" && req.url === "/scan") {
    try {
      const body = await readBody(req);
      const { imageBase64, category, mediaType } = JSON.parse(body);
      const imageMediaType = mediaType || "image/jpeg";

      const isBook = category === "books";
      const prompt = isBook
        ? `You are an eBay book reseller assistant. Look at this image of books on a shelf.
Extract every readable book title and author visible. Also read the publisher if visible on the spine.
Categorize each:
- HOT: Strong eBay sell-through $8+. Textbooks, first editions, out of print, collectible, niche subjects, popular series, hardcovers from well-known authors, self-help bestsellers, technical manuals.
- WORTH_IT: Decent sellers $4-8. Recognizable titles, popular fiction, moderate demand.
- SKIP: Oversaturated, low value $1-3. Common paperbacks, book club editions, heavily supplied titles.
- NOT_SURE: Titles you can partially read but aren't confident about.
For each item include title, author if visible, and publisher/studio if visible on spine.
Respond ONLY with valid JSON, no markdown:
{"hot":[{"title":"Title","studio":"Publisher","author":"Author"}],"worth_it":[{"title":"Title","studio":"Publisher","author":"Author"}],"skip":[{"title":"Title","studio":"Publisher","author":"Author"}],"not_sure":[{"title":"Title","studio":"Publisher","author":"Author"}]}`
        : `You are an eBay DVD reseller assistant. Look at this image of DVDs or Blu-rays on a shelf.
Extract every readable movie or TV title visible. Also read the studio name if visible on the spine (e.g. Warner Bros, Universal, Sony, Paramount, Disney, MGM, Lionsgate).
Categorize each:
- HOT: Strong eBay sell-through $8+. Popular action/thriller, cult classics, collector sets, complete TV seasons, Blu-rays, Disney, Marvel/DC, Nicolas Cage, Arnold, Stallone, Denzel, Tarantino, Scorsese, Coen Brothers, horror classics, limited releases.
- WORTH_IT: Decent sellers $4-8. Recognizable titles with moderate demand.
- SKIP: Oversaturated, low value $1-3. Common titles with huge supply.
- NOT_SURE: Titles you can partially read but aren't confident about.
For each item include title and studio if visible.
Respond ONLY with valid JSON, no markdown:
{"hot":[{"title":"Title","studio":"Studio"}],"worth_it":[{"title":"Title","studio":"Studio"}],"skip":[{"title":"Title","studio":"Studio"}],"not_sure":[{"title":"Title","studio":"Studio"}]}`;

      const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 2000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: imageMediaType, data: imageBase64 } },
              { type: "text", text: prompt }
            ]
          }]
        })
      });

      const data = await apiResponse.json();
      console.log("Anthropic status:", apiResponse.status);

      if (!data.content || !data.content[0]) {
        throw new Error("No content: " + JSON.stringify(data));
      }

      const raw = data.content[0].text.trim().replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(parsed));
    } catch (e) {
      console.error("Scan error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Get all sales from Google Sheets
  if (req.method === "GET" && req.url === "/sales") {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "Sheet1!A2:F1000",
      });
      const rows = response.data.values || [];
      const sales = rows.map(row => ({
        title: row[0] || "",
        studio: row[1] || "",
        category: row[2] || "",
        price: row[3] || "",
        date: row[4] || "",
        notes: row[5] || ""
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(sales));
    } catch (e) {
      console.error("Sales fetch error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Log a sale to Google Sheets
  if (req.method === "POST" && req.url === "/log-sale") {
    try {
      const body = await readBody(req);
      const { title, studio, category, price, notes } = JSON.parse(body);
      const date = new Date().toLocaleDateString("en-US");

      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "Sheet1!A:F",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[title, studio || "", category || "", price, date, notes || ""]]
        }
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      console.error("Log sale error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Shelf Scout server running on port ${PORT}`);
});
