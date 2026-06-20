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

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

function checkSecret(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return token === WEBHOOK_SECRET;
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
      input: `Skriv ett svenskt kundservice-svarsförslag. Det ska vara vänligt, tydligt och inte för långt. Detta ska bara vara ett internt förslag, inte skickas direkt till kund.

Ärende:
Rubrik: ${ticket.subject || ""}
Beskrivning: ${ticket.description || ""}`
    })
  });

  const data = await response.json();
  return data.output_text || "Kunde inte skapa svarsförslag.";
}

async function addInternalZendeskComment(ticketId, text) {
  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString("base64");

  await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`, {
    method: "PUT",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ticket: {
        comment: {
          public: false,
          body: `AI-svarsförslag, granska innan du skickar:\n\n${text}`
        }
      }
    })
  });
}

app.post("/zendesk/new-ticket", async (req, res) => {
  try {
    if (!checkSecret(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const ticket = {
      id: req.body.ticket_id || req.body.id || req.body.ticket?.id,
      subject: req.body.subject || req.body.ticket?.subject,
      description: req.body.description || req.body.ticket?.description
    };

    if (!ticket.id) {
      return res.status(400).json({ error: "Missing ticket id" });
    }

    const suggestion = await createAiSuggestion(ticket);
    await addInternalZendeskComment(ticket.id, suggestion);

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
