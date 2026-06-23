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
