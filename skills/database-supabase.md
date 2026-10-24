# Supabase Database

You have access to a Supabase project for database, auth, and storage.

## Environment Variables

- `SUPABASE_URL` — project API URL
- `SUPABASE_SERVICE_ROLE_KEY` — full access key (use server-side only)

## Database

Use the Supabase CLI for migrations:

```bash
supabase migration new <name>     # Create migration
supabase db push                  # Apply migrations
supabase db reset                 # Reset and replay all migrations
```

Write migrations as raw SQL in `supabase/migrations/`.

## Row Level Security (RLS)

- Always enable RLS on tables that store user data
- Write policies that restrict access to the row owner
- Test policies: query as an authenticated user, verify they only see their data

```sql
alter table posts enable row level security;

create policy "Users can read own posts"
  on posts for select
  using (auth.uid() = user_id);
```

## Client Usage

```typescript
import { createClient } from '@supabase/supabase-js'
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
```

## Auth

- Use Supabase Auth for user management
- Access the current user: `supabase.auth.getUser()`
- Protect API routes by verifying the JWT

## Storage

- Use Supabase Storage for file uploads
- Create buckets with appropriate RLS policies
- Generate signed URLs for private files
