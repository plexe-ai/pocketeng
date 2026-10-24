---
type: reference
status: canonical
last_reviewed: 2026-04-23
related:
  - references/env-variables.md
  - playbooks/deploy-to-test-stack.md
  - protocols/safety-protocol.md
  - protocols/no-bypass.md
tags: [reference, aws, debugging]
---

# AWS CLI as a Debugging Handle

**When to read:** when you're debugging anything backend — a failing request, a missing row, a Lambda that "ran but didn't do the thing".
**When to update:** when we add a new AWS resource class worth probing, or a new profile/region convention.

## Summary

**Every dev machine should already have the AWS CLI logged in** against the test account, with `AWS_PROFILE` and `AWS_REGION` set. This isn't a nice-to-have — it's the single biggest lever you have for debugging the system honestly, because it lets you ask the real infrastructure what it thinks the truth is instead of reasoning from logs or screenshots alone.

Today:

- Account: the one your local `prod`-named profile reaches.
- Region: `us-west-1`.
- Stack: `pocketeng-backend-test`.

Source `.env.test` before you start and you're configured: `set -a; source .env.test; set +a`.

---

## The five handles worth memorizing

When something breaks, you almost always want one of these. Each one takes about 10 seconds to run — much faster than reading a stack trace and guessing.

### 1. DynamoDB — what does the row actually look like?

```bash
aws dynamodb get-item --table-name pe-sessions-prod \
  --key '{"sessionId":{"S":"<id>"}}'

aws dynamodb scan --table-name pe-servers-prod \
  --filter-expression 'userId = :u' \
  --expression-attribute-values '{":u":{"S":"<uid>"}}' \
  --max-items 5
```

(Tables end in `-prod` on the test stack — see the naming-gotcha in [`env-variables.md`](env-variables.md).)

### 2. CloudWatch Logs — what did the Lambda actually say?

```bash
# Find the log group
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/pocketeng-backend-test

# Tail live
aws logs tail /aws/lambda/<function> --follow

# Filter a window
aws logs filter-log-events --log-group-name /aws/lambda/<function> \
  --start-time $(($(date +%s) - 600))000 \
  --filter-pattern 'ERROR'
```

### 3. CloudFormation — what got deployed, what's the API URL, what's the current state?

```bash
aws cloudformation describe-stacks --stack-name pocketeng-backend-test \
  --query 'Stacks[0].Outputs'

aws cloudformation describe-stack-events --stack-name pocketeng-backend-test \
  --max-items 20
```

### 4. Caller identity — which account am I actually talking to?

```bash
aws sts get-caller-identity
```

Run this whenever something looks weird. The most common cause of "the row is missing" is "you're looking at the wrong account" or "wrong region".

### 5. EC2 — is the server I provisioned actually up?

```bash
aws ec2 describe-instances --instance-ids <id> \
  --query 'Reservations[0].Instances[0].[State.Name,PublicIpAddress]'
```

---

## The pattern — "when your mental model disagrees with reality, ask the system"

This is the same principle the browser harness follows with `page.evaluate()` and JWT-decoding probes (see [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md)). When two sources of "truth" disagree, a three-line `aws` call that reads the actual state is almost always faster than deeper reasoning.

Don't guess at DDB contents. Don't guess at Lambda errors. Don't guess at which stack your URL hits. Ask.

---

## Debugging a broken deploy

1. `aws cloudformation describe-stack-events --stack-name pocketeng-backend-test --max-items 30` — look for a `CREATE_FAILED` or `UPDATE_FAILED` row with a `ResourceStatusReason`.
2. If a Lambda is stuck, `aws logs tail /aws/lambda/<function> --since 10m`.
3. If the whole thing is wedged, revert the template to a known-good commit and redeploy (see [`../playbooks/deploy-to-test-stack.md`](../playbooks/deploy-to-test-stack.md)).

---

## Safety rails

- **Read-only commands are free.** Scan tables, tail logs, describe stacks — run them liberally.
- **Writes require intent.** `delete-item`, `terminate-instances`, `delete-stack` — treat each as destructive. See [`../protocols/safety-protocol.md`](../protocols/safety-protocol.md).
- **Never run a write against prod credentials** (if/when a prod-scoped profile exists). Always confirm `aws sts get-caller-identity` before a destructive call.
- **Don't log secrets.** A lot of `aws` commands return JSON with credentials, JWT secrets, or KMS material. Redact before pasting into a PR.

---

## If `aws` isn't working

- `aws configure list` — shows which profile & region the current shell is using.
- `aws sso login --profile <name>` if your org uses SSO.
- For SAML / role-chaining, check the profile's `role_arn` / `source_profile` in `~/.aws/credentials`.
- Not configured at all? See [`../playbooks/dev-environment-setup.md`](../playbooks/dev-environment-setup.md).

Don't work around missing AWS access — **surface it** to the user and stop until it's fixed. Guessing at infra state leads directly to the kinds of bugs this harness exists to prevent (see [`../protocols/no-bypass.md`](../protocols/no-bypass.md)).

---

## See also

- [`env-variables.md`](env-variables.md) — `AWS_PROFILE`, `AWS_REGION`, `.env.test`
- [`../playbooks/deploy-to-test-stack.md`](../playbooks/deploy-to-test-stack.md)
- [`../protocols/safety-protocol.md`](../protocols/safety-protocol.md)
- [`../protocols/no-bypass.md`](../protocols/no-bypass.md)

## Referenced by

- `README.md`
- `references/env-variables.md`
- `playbooks/deploy-to-test-stack.md`
