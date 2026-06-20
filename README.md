## Zendesk AI Response Service

This repository contains a simple Node.js service that listens for Zendesk
webhook events and uses the OpenAI Chat Completion API to generate suggested
responses for incoming support tickets. When a ticket is received via a Zendesk
trigger, the service generates a reply and updates the ticket with the
suggestion.

### How it works

1. **Webhook endpoint (`/webhook`)**: Zendesk triggers should be configured
   to send ticket events (e.g., when a new ticket is created) to the `/webhook`
   endpoint of this service. The incoming payload is verified using the
   `WEBHOOK_SECRET` if provided.
2. **Generate a reply**: The service composes a prompt using the ticket
   subject and description and calls the OpenAI Chat Completion API with the
   model specified by `OPENAI_MODEL`.
3. **Update the ticket**: Once a reply is generated, it uses the Zendesk API
   to add a public comment to the ticket with the generated response.

### Environment variables

The service relies on the following environment variables (all must be
configured in your Render service under **Environment**):

| Variable | Description |
| --- | --- |
| `OPENAI_API_KEY` | Your OpenAI API key with access to the Chat Completion API. |
| `OPENAI_MODEL` | The model to use (e.g., `gpt-3.5-turbo`). Defaults to `gpt-3.5-turbo`. |
| `ZENDESK_API_TOKEN` | Zendesk API token generated under Admin Center \> Apps and integrations \> Zendesk API. |
| `ZENDESK_EMAIL` | The Zendesk account email associated with the API token. |
| `ZENDESK_SUBDOMAIN` | Your Zendesk subdomain (e.g., `mycompany` if your URL is `mycompany.zendesk.com`). |
| `WEBHOOK_SECRET` | Optional secret used to verify incoming webhook signatures from Zendesk triggers. |
| `PORT` | The port the server should listen on. Render sets this automatically. |

### Running locally

To run the service locally for development:

```bash
cd zendesk-ai-svarsforslag
npm install
OPENAI_API_KEY=your-openai-key \
ZENDESK_API_TOKEN=your-zendesk-token \
ZENDESK_EMAIL=you@example.com \
ZENDESK_SUBDOMAIN=your-subdomain \
npm start
```

Expose the service publicly (e.g., using [ngrok](https://ngrok.com/)) and
configure a Zendesk trigger to send events to `https://<public-url>/webhook`.

### Deploying on Render

1. Add all required environment variables on the Render dashboard under
   **Environment**.
2. Push this directory to GitHub and connect it to a Render Web Service.
3. Ensure the **Build Command** is `npm install` and the **Start Command** is
   `npm start`. Render will build and deploy the service.
4. Create a Zendesk webhook and trigger that POSTs ticket events to your
   Render service URL (e.g., `https://your-service.onrender.com/webhook`).

### Disclaimer

This service is provided as a starting point for integrating OpenAI with
Zendesk. Depending on your needs, you may wish to enrich the prompt, handle
more ticket fields, or adjust the ticket update logic (e.g., add private
comments instead of public ones).