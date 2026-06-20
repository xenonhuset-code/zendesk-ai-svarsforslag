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
