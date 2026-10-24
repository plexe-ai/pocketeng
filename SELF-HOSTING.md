# Self-Hosting PocketEngineer

Run the entire PocketEngineer stack on your own infrastructure.

## Architecture

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   iOS App    │    │ Web Dashboard│    │   CLI        │
│ (Capacitor)  │    │ (Next.js)    │    │  (Bash)      │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │
       └───────────┬───────┘                   │
                   ▼                           │
          ┌────────────────┐                   │
          │  Backend API   │                   │
          │ (AWS Lambda)   │                   │
          └────────┬───────┘                   │
                   │                           │
          ┌────────▼───────┐                   │
          │   Supabase     │                   │
          │  (Auth + DB)   │                   │
          └────────────────┘                   │
                                               │
          ┌────────────────┐                   │
          │  EC2 Instances │◄──────────────────┘
          │ (your servers)  │     SSH direct
          └────────────────┘
```

## Prerequisites

- AWS account with CLI configured
- [Supabase](https://supabase.com) project (free tier works) — or self-hosted Supabase
- Node.js 18+ and npm
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Xcode 16+ (if building the iOS app via Capacitor)

## Step 1: Supabase Setup

### Option A: Hosted Supabase (recommended)

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **Settings → API** and note:
   - **Project URL** (e.g. `https://yourproject.supabase.co`)
   - **anon/public key** (starts with `eyJ...`)
   - **JWT Secret** (in Settings → API → JWT Settings)

3. Enable **Apple** as an auth provider under **Authentication → Providers**
4. Enable **GitHub** as an auth provider (for GitHub OAuth in onboarding)

### Option B: Self-hosted Supabase

```bash
git clone https://github.com/supabase/supabase
cd supabase/docker
cp .env.example .env
# Edit .env with your settings
docker compose up -d
```

## Step 2: Deploy the Backend

```bash
cd backend

# Copy and fill in your config
cp samconfig.toml.example samconfig.toml
# Edit samconfig.toml — set SupabaseUrl, SupabaseJwtSecret
```

Edit `samconfig.toml`:
```toml
parameter_overrides = "SupabaseUrl=https://yourproject.supabase.co SupabaseJwtSecret=your-jwt-secret-here SlackSigningSecret="
```

Deploy:
```bash
sam build
sam deploy
```

Note the **API Gateway URL** from the output (e.g. `https://abc123.execute-api.us-east-1.amazonaws.com/prod`).

## Step 3: Deploy the Web Dashboard

```bash
cd web

# Copy and fill in your config
cp .env.example .env.local
```

Edit `.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=https://yourproject.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_API_BASE_URL=https://your-api-id.execute-api.us-east-1.amazonaws.com/prod
```

Deploy to Vercel:
```bash
npm install
vercel --prod
```

Or run locally:
```bash
npm run dev
```

## Step 4: Configure the iOS App

The iOS app is a Capacitor web shell that loads your deployed web dashboard in a WKWebView.

Edit `web/capacitor.config.ts` to point at your web dashboard URL:

```typescript
const config: CapacitorConfig = {
  server: {
    url: 'https://your-dashboard-domain.com',
    cleartext: false,
  },
}
```

Build and deploy:
```bash
cd web
npx cap sync ios
# Open ios/App/App.xcodeproj in Xcode, archive and upload to App Store Connect
```

## Step 5: Install the CLI

```bash
curl -fsSL https://pocketeng.ai/install | sh
```

The CLI connects directly to EC2 via SSH — no backend dependency.

## Step 6: Set Up the MCP Server (optional)

```bash
cd mcp-server
npm install
```

The MCP server is automatically registered by `pocketeng login` or `pocketeng setup`. It enables Claude Code to sync files and manage sessions.

## Configuration Reference

### Backend (template.yaml parameters)

| Parameter | Description | Required |
|-----------|-------------|----------|
| `SupabaseUrl` | Your Supabase project URL | Yes |
| `SupabaseJwtSecret` | JWT secret for token verification | Yes |
| `SlackSigningSecret` | Slack app signing secret | No |
| `Stage` | Deployment stage (`prod` or `dev`) | No (default: `prod`) |

### Web Dashboard (.env.local)

| Variable | Description | Required |
|----------|-------------|----------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase public key | Yes |
| `NEXT_PUBLIC_API_BASE_URL` | Backend API Gateway URL | Yes |
| `NEXT_PUBLIC_LINEAR_CLIENT_ID` | Linear OAuth client ID | No |
| `NEXT_PUBLIC_SLACK_CLIENT_ID` | Slack OAuth client ID | No |

### iOS App (capacitor.config.ts)

| Value | Description | Required |
|-------|-------------|----------|
| `server.url` | Your deployed web dashboard URL | Yes |

The iOS app inherits all config from the web dashboard -- Supabase and API settings come from the web app's environment variables.

## What Gets Created in Your AWS Account

- **Lambda functions** (8): Provision, Servers, Status, Action, Lifecycle, Chat, SlackCommand, SlackWorker
- **API Gateway** (HTTP API): Public endpoint for the above
- **DynamoDB tables** (2): `pe-servers-{stage}`, `pe-slack-mappings-{stage}`
- **KMS key**: Encrypts SSH keys and API keys at rest
- **EC2 instances**: Created on-demand when users provision workspaces

Estimated cost for light usage: ~$5-10/month (mostly KMS + DynamoDB, Lambda is free tier).

## Troubleshooting

**"anthropicApiKey required" error**: The web dashboard sends the API key during provisioning. Make sure the Anthropic key is set in the user's account (onboarding step 2).

**iOS app can't connect**: Verify `server.url` in `capacitor.config.ts` points to your deployed web dashboard URL. Check CloudWatch logs for Lambda errors.

**SAM deploy fails**: Make sure your AWS CLI is configured (`aws sts get-caller-identity`). The stack needs IAM, EC2, DynamoDB, KMS, and Lambda permissions.
