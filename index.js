import express from "express";

const app = express();
app.use(express.json());

const {
  WEBHOOK_SECRET,
  ZENDESK_SUBDOMAIN,
  ZENDESK_EMAIL,
  ZENDESK_API_TOKEN,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4.1-mini",
  PORT = 3000
} = process.env;

const AI_TAG = "ai_svarsforslag_skapat";

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function checkSecret(req) {
  const bearerToken = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return bearerToken === WEBHOOK_SECRET || req.query.secret === WEBHOOK_SECRET;
}

function requireConfig() {
  const missing = [];
  for (const [name, value] of Object.entries({
    WEBHOOK_SECRET,
    ZENDESK_SUBDOMAIN,
    ZENDESK_EMAIL,
    ZENDESK_API_TOKEN,
    OPENAI_API_KEY
  })) {
    if (!value) missing.push(name);
  }

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

function zendeskAuthHeader() {
  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");
  return `Basic ${auth}`;
}

async function zendeskRequest(path, options = {}) {
  const response = await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com${path}`, {
    ...options,
    headers: {
      Authorization: zendeskAuthHeader(),
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Zendesk error ${response.status}: ${body}`);
  }

  return response.json();
}

function extractOpenAiText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
      if (typeof content.output_text === "string") parts.push(content.output_text);
    }
  }

  return parts.join("\n").trim();
}

async function createAiSuggestion(ticket) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: `Skriv ett svenskt kundservice-svarsförslag.

Viktigt:
- Detta är bara ett internt förslag.
- Svara inte som om något är säkert om information saknas.
- Var vänlig, tydlig och inte för lång.
- Kunden ska inte se detta förrän en människa godkänt det.

Ärende:
Rubrik: ${ticket.subject || ""}
Beskrivning: ${ticket.description || ""}`
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const text = extractOpenAiText(data);

  if (!text) {
    console.error("OpenAI response without text:", JSON.stringify(data));
    throw new Error("OpenAI returned no text");
  }

  return text;
}

async function getTicket(ticketId) {
  const data = await zendeskRequest(`/api/v2/tickets/${ticketId}.json`);
  return data.ticket;
}

async function addInternalZendeskComment(ticketId, text) {
  await zendeskRequest(`/api/v2/tickets/${ticketId}.json`, {
    method: "PUT",
    body: JSON.stringify({
      ticket: {
        additional_tags: [AI_TAG],
        comment: {
          public: false,
          body: `AI-svarsförslag, granska innan du skickar:\n\n${text}`
        }
      }
    })
  });
}

function dateDaysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

async function findTicketsNeedingSuggestions() {
  const query = `type:ticket -tags:${AI_TAG} created>=${dateDaysAgo(2)}`;
  const data = await zendeskRequest(
    `/api/v2/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=desc`
  );

  return (data.results || [])
    .filter((ticket) => ticket.result_type === "ticket")
    .filter((ticket) => !(ticket.tags || []).includes(AI_TAG))
    .slice(0, 10);
}

async function processNewTickets() {
  const tickets = await findTicketsNeedingSuggestions();
  const processed = [];

  for (const ticket of tickets) {
    const suggestion = await createAiSuggestion(ticket);
    await addInternalZendeskComment(ticket.id, suggestion);
    processed.push(ticket.id);
  }

  return processed;
}

app.get("/poll", async (req, res) => {
  try {
    requireConfig();

    if (!checkSecret(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const processed = await processNewTickets();
    res.json({ ok: true, processed });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/retry", async (req, res) => {
  try {
    requireConfig();

    if (!checkSecret(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const ids = String(req.query.ids || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      return res.status(400).json({ error: "Missing ids" });
    }

    const processed = [];
    for (const id of ids) {
      const ticket = await getTicket(id);
      const suggestion = await createAiSuggestion(ticket);
      await addInternalZendeskComment(ticket.id, suggestion);
      processed.push(ticket.id);
    }

    res.json({ ok: true, processed });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/zendesk/new-ticket", async (req, res) => {
  try {
    requireConfig();

    if (!checkSecret(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const ticket = {
      id: req.body.ticket_id || req.body.id || req.body.ticket?.id || req.body.detail?.id,
      subject: req.body.subject || req.body.ticket?.subject || req.body.detail?.subject,
      description: req.body.description || req.body.ticket?.description || req.body.detail?.description
    };

    if (!ticket.id) {
      return res.status(400).json({ error: "Missing ticket id" });
    }

    const suggestion = await createAiSuggestion(ticket);
    await addInternalZendeskComment(ticket.id, suggestion);

    res.json({ ok: true, processed: [ticket.id] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
