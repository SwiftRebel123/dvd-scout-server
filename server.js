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

      // PASS 1: Read spines from image
      const pass1Prompt = isBook
        ? `You are an eBay book reseller assistant. Carefully examine this shelf image.
FIRST identify the physical layout — there are three possible arrangements:
1. VERTICAL COLUMNS: Books standing upright side by side in columns. Read each column TOP TO BOTTOM, starting from the leftmost column and moving right.
2. HORIZONTAL STACKS: Books stacked flat in piles. Read each pile TOP TO BOTTOM, starting from the leftmost pile and moving right.
3. MULTIPLE SHELVES: Books standing upright across multiple horizontal shelves (like a bookcase). Read LEFT TO RIGHT across the top shelf, then LEFT TO RIGHT across the next shelf down, continuing to the bottom shelf.
Choose the layout that best matches what you see, then read ALL titles in that order.
For each spine, read it CHARACTER BY CHARACTER. Do not guess — if you cannot read a character clearly, mark the whole title as low_confidence=true.
Also read the publisher and author if visible.
Assign a value category:
- HOT: Textbooks, first editions, out of print, collectible, niche subjects, popular series hardcovers, self-help bestsellers, technical manuals. $8+
- WORTH_IT: Recognizable titles, popular fiction, moderate demand. $4-8
- SKIP: Common paperbacks, book club editions, oversupplied titles. $1-3
Return a SINGLE array in the correct reading order. Respond ONLY with valid JSON, no markdown:
{"items":[{"title":"Exact title as read","studio":"Publisher","author":"Author","category":"HOT","low_confidence":false}]}`
        : `You are an eBay DVD reseller assistant. Carefully examine this shelf image.
FIRST identify the physical layout — there are three possible arrangements:
1. VERTICAL COLUMNS: DVDs standing upright side by side in columns. Read each column TOP TO BOTTOM, starting from the leftmost column and moving right.
2. HORIZONTAL STACKS: DVDs stacked flat in piles. Read each pile TOP TO BOTTOM, starting from the leftmost pile and moving right.
3. MULTIPLE SHELVES: DVDs standing upright across multiple horizontal shelves (like a bookcase). Read LEFT TO RIGHT across the top shelf, then LEFT TO RIGHT across the next shelf down, continuing to the bottom shelf.
Choose the layout that best matches what you see, then read ALL titles in that order.
For each spine, read it CHARACTER BY CHARACTER. Do not guess — if you cannot read characters clearly, mark the title as low_confidence=true.
Also read the studio name if visible (e.g. Warner Bros, Universal, Sony, Paramount, Disney, MGM, Lionsgate).
Assign a value category:
- HOT: Popular action/thriller, cult classics, collector sets, complete TV seasons, Blu-rays, Disney, Marvel/DC, Cage, Arnold, Stallone, Denzel, Tarantino, Scorsese, horror classics. $8+
- WORTH_IT: Recognizable titles with moderate demand. $4-8
- SKIP: Common oversupplied titles. $1-3
Return a SINGLE array in the correct reading order. Respond ONLY with valid JSON, no markdown:
{"items":[{"title":"Exact title as read","studio":"Studio","category":"HOT","low_confidence":false}]}`;

      const pass1Response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 3000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: imageMediaType, data: imageBase64 } },
              { type: "text", text: pass1Prompt }
            ]
          }]
        })
      });

      const pass1Data = await pass1Response.json();
      console.log("Pass 1 status:", pass1Response.status);

      if (!pass1Data.content || !pass1Data.content[0]) {
        throw new Error("Pass 1 failed: " + JSON.stringify(pass1Data));
      }

      const raw1 = pass1Data.content[0].text.trim().replace(/```json|```/g, "").trim();
      const parsed1 = JSON.parse(raw1);

      let items = parsed1.items || [];

      // PASS 2: Verify low-confidence titles using web search
      const uncertain = items.filter(i => i.low_confidence);
      console.log(`Pass 2: verifying ${uncertain.length} uncertain titles`);

      if (uncertain.length > 0) {
        // Batch verify all uncertain titles in one AI call
        const uncertainList = uncertain.map((i, idx) => `${idx + 1}. "${i.title}"`).join('
');
        const pass2Prompt = `You are an expert in movies and books. The following titles were read from ${isBook ? 'book' : 'DVD'} spines but may have been misread. For each one, determine the most likely correct title based on what was read. If a title looks correct already, keep it. If it looks like a misread, provide the corrected title and studio/publisher.

Titles to verify:
${uncertainList}

Respond ONLY with valid JSON, no markdown:
{"verified":[{"index":1,"title":"Corrected Title","studio":"Studio","confirmed":true}]}`;

        const pass2Response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-5",
            max_tokens: 2000,
            messages: [{ role: "user", content: pass2Prompt }]
          })
        });

        const pass2Data = await pass2Response.json();
        if (pass2Data.content && pass2Data.content[0]) {
          const raw2 = pass2Data.content[0].text.trim().replace(/```json|```/g, "").trim();
          const parsed2 = JSON.parse(raw2);

          // Apply corrections back to items
          if (parsed2.verified) {
            let uncertainIdx = 0;
            items = items.map(item => {
              if (item.low_confidence) {
                const correction = parsed2.verified[uncertainIdx];
                uncertainIdx++;
                if (correction) {
                  return {
                    ...item,
                    title: correction.title || item.title,
                    studio: correction.studio || item.studio,
                    low_confidence: !correction.confirmed,
                    corrected: correction.title !== item.title
                  };
                }
              }
              return item;
            });
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items }));
    } catch (e) {
      console.error("Scan error:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Suggest lots
  if (req.method === "POST" && req.url === "/suggest-lots") {
    try {
      const body = await readBody(req);
      const { titles, category } = JSON.parse(body);

      const prompt = `You are an eBay reseller expert. Here is a list of ${category === 'books' ? 'books' : 'DVDs'}:

${titles}

For each title, identify its genre. Then suggest the best lot groupings for eBay resale — which titles should be sold together and why. Consider series, genre, director, actor, theme, and audience. For each suggested lot give it a name, list the titles, and estimate a selling price range for the lot. Also flag any individual titles that are worth more sold alone.

Respond ONLY with valid JSON, no markdown:
{"lots":[{"name":"Lot Name","titles":["Title1","Title2"],"reason":"Why these go together","price_range":"$X-$Y"}],"sell_alone":[{"title":"Title","reason":"Why sell alone","price_range":"$X-$Y"}]}`;

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
          messages: [{ role: "user", content: prompt }]
        })
      });

      const data = await apiResponse.json();
      if (!data.content || !data.content[0]) throw new Error("No content: " + JSON.stringify(data));

      const raw = data.content[0].text.trim().replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(parsed));
    } catch (e) {
      console.error("Suggest lots error:", e.message);
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
