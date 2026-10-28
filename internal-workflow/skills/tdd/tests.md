# Good and Bad Tests

## Good Tests

Test through real public interfaces, including module APIs. Use realistic fixtures
and meaningful result/state assertions; mocks at external boundaries are compatible
with good tests. Exact strings, IDs, payloads, or ordering matter when they are
part of the protected contract.

```typescript
// GOOD: Tests observable behavior
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

Characteristics:

- Tests behavior users/callers care about
- Uses public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One coherent behavior per test; use the assertions needed to establish it.

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```typescript
// BAD: Tests implementation details
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Red flags:

- Mocking internal collaborators
- Testing private methods
- Asserting on arbitrary internal call counts/order; retain these only when the lifecycle or ordering is the contract.
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Bypassing the caller-facing interface when the contract concerns caller-visible behavior.

```typescript
// WEAK: Row existence alone does not prove user retrievability
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: Verifies through interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

Direct database inspection is appropriate when persistence is the explicit contract
(e.g. a migration preserves balances), with assertions on the required state.
It does not replace caller-facing proof of user retrievability.

**Tautological tests**: Expected values derived by copying the implementation
can repeat the same bug and fail to provide independent evidence.

```typescript
// BAD: Expected value is recomputed the way the code computes it
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, item) => sum + item.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// GOOD: Expected value comes from an independent, known literal
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```

## Independent Expectations and Regression Value

Derive expectations from business rules, documented contracts, or independently
worked examples. Existing output is evidence of current behavior, not proof of
correctness. Do not approve a snapshot or copy a buggy result merely to make a
test pass. If intended behavior is materially unclear, resolve that gap first.

For example, if the contract gives a 10% discount on 100, the expected total is
90 even when the current implementation returns 95. The regression test should
assert 90 and fail on that bug.

For each test, identify the real contract violation it would catch and check
that a reasonable internal refactor preserving behavior would not break it.
Avoid tests that only prove setup exists or mocks return configured values.
When rewriting tests, preserve the real behavior coverage, especially on critical
paths; do not delete the only protection because its current form is brittle.
