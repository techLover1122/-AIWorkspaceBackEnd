# AI IDE — Backend

Node.js backend built with [Hono](https://hono.dev/) that bridges the frontend to the Claude CLI.

## Stack

- **Runtime**: Node.js (ESM TypeScript via `tsx`)
- **Framework**: Hono + `@hono/node-server`
- **Claude integration**: `@anthropic-ai/claude-code`, `node-pty`
- **Port**: `8090` (default)

## Setup

```bash
npm install
```

Create a `.env` file (optional):

```env
PORT=8090
DEBUG=1
```

## Development

```bash
npm run dev
```

## Production

```bash
npm run build
npm start
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Check Claude CLI connection status |
| POST | `/api/auth/api-key` | Set API key |
| POST | `/api/auth/clear` | Clear authentication |
| POST | `/api/auth/subscription/start` | Start OAuth login flow |
| GET | `/api/auth/subscription/status` | Poll OAuth login progress |
| POST | `/api/auth/subscription/cancel` | Cancel in-progress OAuth login |
| POST | `/api/auth/subscription/submit-code` | Submit OAuth authorization code |
| POST | `/api/chat` | Send a chat message (streaming) |
| POST | `/api/abort/:requestId` | Abort an in-progress chat request |
| GET | `/api/projects` | List projects |
| GET | `/api/projects/:name/histories` | List conversation histories |
| GET | `/api/projects/:name/histories/:sessionId` | Get a conversation |
