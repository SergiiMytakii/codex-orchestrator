---
name: codebase-design
description: Reference vocabulary and a bounded decision lens for designing deep modules. Use when a named module interface or seam must be designed or evaluated, when tests need a durable public seam, or when another skill needs the deep-module vocabulary. Do not use as a session driver, repository-wide architecture scan, or implementation workflow.
---

# Codebase Design

Design deep modules: a lot of behaviour behind a small interface, placed at a clean seam, testable through that interface. Use this language and these principles wherever code is being designed or restructured. The aim is leverage for callers, locality for maintainers, and testability for everyone.

## Reference Contract

Use this skill as the vocabulary owner and bounded decision lens. Answer the named design question through supplied or locally verified evidence. Do not start repository-wide exploration, implementation, writes, subagents, or an open-ended design session merely because this skill loaded.

Let the active driver own workflow, checkpoints, user dialogue, and mutations. Use `$improve-codebase-architecture` for an explicitly requested architecture scan, `$grilling` for an interactive decision tree, and the normal plan/spec/TDD flows for design authority and implementation.

Use Design It Twice only after a consequential deepening candidate is selected and its constraints are known.

## Glossary

Use these terms exactly — don't substitute "component", "service", "API", or "boundary". Consistent language is the whole point.

**Module** — anything with an interface and an implementation. Deliberately scale-agnostic: a function, class, package, or tier-spanning slice. Avoid: unit, component, service.

**Interface** — everything a caller must know to use the module correctly: the type signature, but also invariants, ordering constraints, error modes, required configuration, and performance characteristics. Avoid: API, signature.

**Implementation** — what's inside a module, its body of code. Distinct from **Adapter**: a thing can be a small adapter with a large implementation or a large adapter with a small implementation. Reach for "adapter" when the seam is the topic; "implementation" otherwise.

**Depth** — leverage at the interface: the amount of behaviour a caller or test can exercise per unit of interface they have to learn. A module is **deep** when a large amount of behaviour sits behind a small interface, **shallow** when the interface is nearly as complex as the implementation.

**Seam** — a place where you can alter behaviour without editing in that place; the location at which a module's interface lives. Avoid: boundary.

**Adapter** — a concrete thing that satisfies an interface at a seam. Describes role, not substance.

**Leverage** — what callers get from depth: more capability per unit of interface they learn.

**Locality** — what maintainers get from depth: change, bugs, knowledge, and verification concentrate in one place rather than spreading across callers.

## Deep vs shallow

**Deep module** = small interface + lots of implementation.

**Shallow module** = large interface + little implementation.

When designing an interface, ask:

- Can I reduce the number of methods?
- Can I simplify the parameters?
- Can I hide more complexity inside?

## Principles

- **Depth is a property of the interface, not the implementation.**
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter means a hypothetical seam. Two adapters means a real one.**

## Designing for testability

Good interfaces make testing natural:

1. Accept dependencies, don't create them.
2. Return results, don't produce side effects.
3. Keep the surface area small.

## Relationships

- A **Module** has exactly one **Interface**.
- **Depth** is a property of a **Module**, measured against its **Interface**.
- A **Seam** is where a **Module**'s **Interface** lives.
- An **Adapter** sits at a **Seam** and satisfies the **Interface**.
- **Depth** produces **Leverage** for callers and **Locality** for maintainers.

## Rejected framings

- **Depth as ratio of implementation-lines to interface-lines** — rewards padding the implementation.
- **"Interface" as the TypeScript `interface` keyword or a class's public methods** — too narrow.
- **"Boundary"** — overloaded with DDD's bounded context. Say **seam** or **interface**.

## Going deeper

- **Deepening a cluster given its dependencies** — see [DEEPENING.md](./DEEPENING.md)
- **Exploring alternative interfaces** — see [DESIGN-IT-TWICE.md](./DESIGN-IT-TWICE.md)
