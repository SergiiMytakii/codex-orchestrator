# When to Mock

Mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Databases (sometimes - prefer test DB)
- Time/randomness
- File system (sometimes)

Don't mock:

- Your own classes/modules
- Internal collaborators
- Anything you control

## Designing for Mockability

Use the existing public or system-boundary seam first. Add dependency injection,
an adapter, or an SDK wrapper only when production ownership or the requested
contract requires it—not only to make a test easier to mock.
