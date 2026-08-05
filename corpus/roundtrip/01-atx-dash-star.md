---
galley: 01J8XK2MDEMO0001
status: draft
owner: priya
---

# Checkout v2

A spec with *emphasis*, **strong**, `inline code`, and a [link](https://example.com).

## API fields

- `currency` — ISO 4217, optional
- `amount` — integer minor units
- `idempotency_key` — required

### Validation

1. Reject a request with no `currency`.
2. Reject a negative `amount`.
3. Accept everything else.

> A blockquote with **bold** text.
> Second line of the same quote.

| Field | Type | Required |
| --- | --- | --- |
| currency | string | no |
| amount | integer | yes |

```ts
export function validate(input: Input): Result {
  return { ok: true };
}
```

---

Final paragraph.
