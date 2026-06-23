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
const AI_MARKER = "AI-svarsforslag, granska innan du skickar:";

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
    throw new Error(`Zendesk error ${response.status}: ${body.slice(0, 500)}`);
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
      input: `Skriv ett svenskt kundservice-svarsforslag.

Viktigt:
- Detta ar bara ett internt forslag.
- Svara inte som om nagot ar sakert om information saknas.
- Var vanlig, tydlig och inte for lang.
- Kunden ska inte se detta forran en manniska godkant det.
Arende:
Rubrik: ${ticket.subject || ""}
Beskrivning: ${ticket.description || ""}`
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json();
  const text = extractOpenAiText(data);

  if (!text) {
    console.error("OpenAI response without text:", JSON.stringify(data).slice(0, 1000));
    throw new Error("OpenAI returned no text");
  }

  return text;
}

async function getTicket(ticketId) {
  const data = await zendeskRequest(`/api/v2/tickets/${ticketId}.json`);
  return data.ticket;
}

async function getTicketComments(ticketId) {
  const data = await zendeskRequest(`/api/v2/tickets/${ticketId}/comments.json`);
  return data.comments || [];
}

function hasAiMarker(body) {
  const text = String(body || "").toLowerCase();
  return text.includes("ai-svarsforslag") || text.includes("ai-svarsförslag");
}

async function shouldCreateSuggestion(ticket) {
  if ((ticket.tags || []).includes(AI_TAG)) {
    return false;
  }

  if (["solved", "closed"].includes(ticket.status)) {
    return false;
  }

  const comments = await getTicketComments(ticket.id);

  if (comments.some((comment) => hasAiMarker(comment.body))) {
    return false;
  }

  const hasPublicAgentReply = comments.some((comment) =>
    comment.public === true && String(comment.author_id) !== String(ticket.requester_id)
  );

  return !hasPublicAgentReply;
}

async function addInternalZendeskComment(ticketId, text) {
  await zendeskRequest(`/api/v2/tickets/${ticketId}.json`, {
    method: "PUT",
    body: JSON.stringify({
      ticket: {
        additional_tags: [AI_TAG],
        comment: {
          public: false,
          body: `${AI_MARKER}\n\n${text}`
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
  const query = `type:ticket status<solved -tags:${AI_TAG} created>=${dateDaysAgo(2)}`;
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
  const skipped = [];
  const failed = [];

  for (const ticket of tickets) {
    try {
      if (!(await shouldCreateSuggestion(ticket))) {
        skipped.push(ticket.id);
        continue;
      }

      const suggestion = await createAiSuggestion(ticket);
      await addInternalZendeskComment(ticket.id, suggestion);
      processed.push(ticket.id);
    } catch (error) {
      console.error(`Failed to process ticket ${ticket.id}:`, error);
      failed.push(ticket.id);
    }
  }

  return { processed, skipped, failed };
}

function shortError(error) {
  const message = error?.message || "Unknown error";
  return message.length > 180 ? `${message.slice(0, 180)}...` : message;
}

app.get("/poll", async (req, res) => {
  try {
    requireConfig();

    if (!checkSecret(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const result = await processNewTickets();
    res.json({
      ok: true,
      processed_count: result.processed.length,
      skipped_count: result.skipped.length,
      failed_count: result.failed.length
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: shortError(error) });
  }
});

app.get("/retry", async (req, res) => {
  try {
    requireConfig();

    if (!checkSecret(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const ids = String(req.query.ids || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      return res.status(400).json({ ok: false, error: "Missing ids" });
    }

    const processed = [];
    for (const id of ids) {
      const ticket = await getTicket(id);
      const suggestion = await createAiSuggestion(ticket);
      await addInternalZendeskComment(ticket.id, suggestion);
      processed.push(ticket.id);
    }

    res.json({ ok: true, processed_count: processed.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: shortError(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
