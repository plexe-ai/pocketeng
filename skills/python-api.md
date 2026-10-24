# Python API Development

You are working on a Python API.

## Stack

- **FastAPI** for the web framework (or Flask if already in use)
- **Pydantic** for request/response models and validation
- **SQLAlchemy** for ORM (or raw SQL if the project uses it)
- **Alembic** for database migrations
- **pytest** for testing

## Conventions

- Type hints everywhere — function signatures, variables, return types
- Pydantic models for all request/response schemas — never use raw dicts
- Async endpoints by default (`async def`) unless the operation is CPU-bound
- Keep route handlers thin — business logic goes in service layer
- Use dependency injection (`Depends()`) for DB sessions, auth, etc.

## Project Structure

```
app/
  main.py             # FastAPI app, router includes
  routes/             # Route handlers grouped by domain
  models/             # SQLAlchemy models
  schemas/            # Pydantic request/response models
  services/           # Business logic
  deps.py             # Shared dependencies (DB session, auth)
migrations/           # Alembic migrations
tests/                # pytest tests mirroring app structure
```

## Error Handling

- Use HTTPException with clear status codes and messages
- Never expose internal errors to clients
- Log errors with context (request ID, user ID)

## Database

- Always use migrations — never modify the schema manually
- Use `alembic revision --autogenerate` to create migrations
- Foreign keys and indexes on frequently queried columns
- Use transactions for multi-step operations

## Testing

- Every endpoint gets at least one happy-path test
- Use `TestClient` for integration tests
- Use fixtures for database setup/teardown
- Test files: `test_<module>.py`
