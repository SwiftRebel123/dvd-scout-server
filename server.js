const http = require("http");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

console.log("API key present:", !!ANTHROPIC_API_KEY);

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("DVD Scout server is running");
    return;
  }

  if (req.method === "POST" && req.url === "/scan") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const { imageBase64 } = JSON.parse(body);

        const prompt = `You are an eBay DVD reseller assistant. Look at this image of DVDs or Blu-rays on a shelf.
Extract every readable movie or TV title visible. Categorize each:
- HOT: Strong eBay sell-through, typically $8+. Popular action/thriller, cult classics, collector sets, complete TV seasons, Blu-rays, Disney, Marvel/DC, Nicolas Cage, Arnold, Stallone, Denzel, Tarantino, Scorsese, Coen Brothers, horror classics, limited releases.
- WORTH_IT: Decent sellers $4-8. Recognizable titles with moderate demand.
- SKIP: Oversaturated, low value $1-3. Common titles with huge supply.
Respond ONLY with valid JSON, no markdown, no extra text:
{"hot":["Title"],"worth_it":["Title"],"skip":["Title"]}`;

        const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-5",
            max_tokens: 1000,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
                { type: "text", text: prompt }
              ]
            }]
          })
        });

        const data = await apiResponse.json();
        console.log("Anthropic response status:", apiResponse.status);
        console.log("Anthropic response:", JSON.stringify(data).slice(0, 300));

        if (!data.content || !data.content[0]) {
          throw new Error("No content in response: " + JSON.stringify(data));
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
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DVD Scout server running on port ${PORT}`);
});
