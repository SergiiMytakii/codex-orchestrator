# Code Review Framework Lenses

Load this reference when a framework is explicit or strongly implied by files/configs.

## Next.js

- Server/client component boundaries, hydration assumptions, browser APIs on server.
- `fetch` cache modes, route segment caching, `revalidatePath`/`revalidateTag`, stale data behavior.
- Route handlers/server actions: input validation, auth, serialization of dates/errors/nullables.
- Loading, empty, error, navigation, optimistic update, rollback, back/refresh behavior.
- SSR/client mismatch from locale, feature flags, sessions, params, and search params.

## NestJS

- Request flow through controller, guard, pipe, interceptor, service, repository, events/queues.
- DTO validation versus runtime payload, especially transforms, enums, optionals, nested objects.
- Server-side auth and tenant scope before side effects.
- Transaction boundaries, partial writes, outbox/queue ordering, retry safety.
- Exception mapping, HTTP status behavior, cache decorators, request scope, singleton mutable state, cron/queue concurrency.

## Flutter

- Widget lifecycle: `init`, `build`, async callbacks, `dispose`, state updates after unmount.
- Navigation/back stack, dialog/sheet dismissal, duplicate submit from rapid taps.
- State management transitions, stale emissions, missed listeners, dropped fields.
- Loading, offline, empty, error, retry states.
- Platform permissions, keyboard insets, small-screen overflow, animation/controller/stream cleanup.

## Dart

- Null-safety assumptions, casts, `late`, `!`, JSON parsing, generated serializers.
- `Future`, `Stream`, timer, isolate ordering, cancellation, uncaught errors.
- Equality, copy semantics, immutable updates, mutation during iteration.
- Date/duration/timezone handling, numeric precision, parsing, generic runtime assumptions.
