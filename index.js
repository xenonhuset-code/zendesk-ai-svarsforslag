const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

// Load environment variables. These are provided by Render at runtime.
const {
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-3.5-turbo',
  ZENDESK_API_TOKEN,
  ZENDESK_EMAIL,
  ZENDESK_SUBDOMAIN,
  WEBHOOK_SECRET,
  PORT = 3000,
} = process.env;

/**
 * Verify the webhook signature sent by Zendesk. If a WEBHOOK_SECRET is set,
 * Zendesk will include a signature in the `X-Webhook-Signature` header. This
 * function computes the expected signature and performs a timing-safe
 * comparison with the provided signature. If no secret is set, the request
 * is trusted by default.
 *
 * @param {object} req The incoming Express request object
 * @returns {boolean} True if the signature is valid or no secret is set
 */
function verifySignature(req) {
  // If no secret is provided, skip verification
  if (!WEBHOOK_SECRET) return true;
  const signatureHeader = req.headers['x-webhook-signature'];
  if (!signatureHeader) return false;
  const payload = JSON.stringify(req.body);
  const expectedDigest = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedDigest),
      Buffer.from(signatureHeader),
    );
  } catch (err) {
    return false;
  }
}

/**
 * Generate a suggested reply to a support ticket using OpenAI's chat
 * completion endpoint. The prompt instructs the model to act as a helpful
 * support agent and uses the ticket subject and description as context.
 *
 * @param {object} ticket The Zendesk ticket object
 * @returns {Promise<string>} A generated reply string
 */
async function generateReply(ticket) {
  // Compose a simple prompt. You could enrich this with more context if needed.
  const prompt = `You are a helpful support agent. Provide a suggested reply for the following ticket.\n\nSubject: ${ticket.subject || ''}\nDescription: ${ticket.description || ''}\n`;
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'You are a customer support assistant.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 150,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    },
  );
  const content = response.data.choices?.[0]?.message?.content;
  return (content || '').trim();
}

/**
 * Update a Zendesk ticket with a new public comment. Authentication is
 * performed using a basic auth header constructed from the agent's email
 * address and API token. The comment will appear as a reply from the agent.
 *
 * @param {number} ticketId The Zendesk ticket ID
 * @param {string} comment The body of the comment to add
 * @returns {Promise<void>}
 */
async function updateZendeskTicket(ticketId, comment) {
  const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`;
  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString(
    'base64',
  );
  await axios.put(
    url,
    {
      ticket: {
        comment: {
          body: comment,
          public: true,
        },
      },
    },
    {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    },
  );
}

const app = express();
app.use(express.json({ verify: (req, res, buf) => {
  // Expose raw body for signature verification
  req.rawBody = buf.toString();
} }));

// Health check route
app.get('/', (req, res) => {
  res.send('Zendesk AI response service is running.');
});

// Webhook handler route. Expects JSON payload from Zendesk triggers.
app.post('/webhook', async (req, res) => {
  try {
    // Validate signature
    if (!verifySignature({ headers: req.headers, body: req.body })) {
      return res.status(401).send('Invalid webhook signature');
    }
    const ticket = req.body.ticket || {};
    const ticketId = ticket.id;
    if (!ticketId) {
      return res.status(400).send('No ticket ID provided');
    }
    // Generate a reply using OpenAI
    const reply = await generateReply(ticket);
    // Update the ticket with the generated reply
    await updateZendeskTicket(ticketId, reply);
    return res.status(200).send('Reply generated and ticket updated');
  } catch (error) {
    console.error('Error handling webhook:', error);
    return res.status(500).send('Internal server error');
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});