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
  return data.output_text || "Kunde inte skapa svarsförslag.";
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
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function findTicketsNeedingSuggestions() {
  const query = `type:ticket -tags:${AI_TAG} created>=${dateDaysAgo(2)}`;
  const data = await zendeskRequest(`/api/v2/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=desc`);

  return (data.results || [])
    .filter((ticket) => ticket.result_type === "ticket")
    .filter((ticket) => !(ticket.tags || []).includes(AI_TAG))
    .slice(0, 10);
}

app.get("/poll", async (req, res) => {
  try {
    if (!checkSecret(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const tickets = await findTicketsNeedingSuggestions();
    const processed = [];

    for (const ticket of tickets) {
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

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
