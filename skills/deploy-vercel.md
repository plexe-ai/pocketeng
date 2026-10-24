# Vercel Deployment

You have access to the Vercel CLI for deploying and previewing changes.

## Preview Deployments

After making significant changes, create a preview deployment:

```bash
vercel deploy
```

Share the preview URL in your response so the user can check the result.

## Production Deployments

Only deploy to production when explicitly asked:

```bash
vercel --prod
```

## Environment Variables

- Check existing env vars: `vercel env ls`
- Add new ones: `vercel env add VARIABLE_NAME`
- Environment variables set via Vercel dashboard are automatically available

## Useful Commands

- `vercel ls` — list recent deployments
- `vercel inspect <url>` — check deployment details
- `vercel logs <url>` — check runtime logs
- `vercel dev` — run locally with Vercel environment

## Best Practices

- Always run `npm run build` (or equivalent) before deploying to catch errors
- Preview first, then promote to production
- Don't hardcode environment-specific values — use env vars
