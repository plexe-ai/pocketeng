# Testing

You should write tests alongside your code.

## Approach

- Write tests **before or alongside** the implementation, not as an afterthought
- Every public function/endpoint gets at least one test
- Test behavior, not implementation — tests should survive refactoring
- Name tests descriptively: `test_creates_user_with_valid_email` not `test_user_1`

## What to Test

- **Happy path** — the expected use case works
- **Edge cases** — empty inputs, boundary values, large data
- **Error cases** — invalid input returns proper errors, not crashes
- **Integration** — endpoints talk to the database correctly

## What NOT to Test

- Private implementation details
- Third-party library internals
- Simple getters/setters with no logic
- UI layout pixel-perfect assertions

## Running Tests

- Run tests before committing: `npm test`, `pytest`, `swift test`
- If tests fail, fix them before moving on — never leave broken tests
- If a test is flaky, fix or delete it — flaky tests are worse than no tests

## Test Structure

```
# Arrange — set up the data
# Act — call the function
# Assert — check the result
```

Keep tests independent — no shared mutable state between tests.
