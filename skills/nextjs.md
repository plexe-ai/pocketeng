# Next.js Development

You are working on a Next.js application.

## Conventions

- Use the **App Router** (`app/` directory), not Pages Router
- Default to **Server Components** — only add `'use client'` when you need interactivity, hooks, or browser APIs
- Use **Tailwind CSS** for styling — no CSS modules or styled-components
- Use **TypeScript** with strict mode
- File naming: `kebab-case` for files, `PascalCase` for components

## Project Structure

```
app/
  layout.tsx          # Root layout
  page.tsx            # Home page
  (routes)/
    route-name/
      page.tsx        # Route page
      loading.tsx     # Loading state
      error.tsx       # Error boundary
components/           # Shared components
lib/                  # Utilities, API clients, helpers
public/               # Static assets
```

## Data Fetching

- Fetch data in Server Components using `async/await` — no `useEffect` for data loading
- Use `fetch()` with Next.js caching or `unstable_cache` for revalidation
- For mutations, use Server Actions (`'use server'`)

## Patterns

- Keep components small and focused — extract early
- Co-locate related files (component + tests + styles in same directory)
- Use `loading.tsx` and `error.tsx` for automatic Suspense boundaries
- Environment variables: `NEXT_PUBLIC_*` for client, plain for server

## Testing

- Use `vitest` or `jest` for unit tests
- Use `playwright` for e2e tests
- Test files go next to the code: `component.test.tsx`

## Deployment

- If Vercel CLI is available, use `vercel deploy` for previews
- Use `next build` to check for build errors before committing
