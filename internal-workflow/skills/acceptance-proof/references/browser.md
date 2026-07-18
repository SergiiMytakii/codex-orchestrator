# Browser Proof Procedure

Use browser proof only when at least one frozen criterion describes user-visible web behavior or when the checked diff changes that behavior. Keep the exact frozen criterion IDs and declare `decision.mode: visual`, target `browser`, and a `browser` surface for each applicable criterion.

1. Identify the real local application or fixture entrypoint and the complete user workflow required by the criterion. Do not substitute a nearby route, first reachable screen, static file, or unrelated demo.
2. Launch a real browser against HTTP(S). Complete the workflow through its final interaction and assert the requested final state from live DOM text/state.
3. Repeat the final workflow at one desktop width of at least 1024 pixels and one narrow responsive width of at most 480 pixels. Capture a fresh screenshot and DOM-state JSON after the last interaction at each viewport.
4. Record browser console errors and failed network requests in separate JSON files even when both lists are empty.
5. Review spacing, padding, clipping, overlap, alignment, responsive reflow, and the specific visual complaint. Separately review visible user-facing copy against the frozen criterion. Link each finding to the exact evidence IDs used.
6. Write every artifact below the runner-provided proof directory. Mark screenshots publishable only when they contain no credential, secret, private user path, or unrelated account data. Mark DOM, console, and network artifacts `publishable: false`. Never include credential bytes, authorization headers, environment values, cookies, storage state, or local auth paths.
7. Build the exact generated Proof Report. Each browser criterion must reference both screenshot and DOM evidence at every required viewport. The visual evidence must include workflow entrypoint/steps/final state, viewport captures, console/network refs, `capturedAfterFinalInteraction: true`, and evidence-linked layout/copy reviews.

A screenshot by itself, stale file, one viewport, missing DOM/diagnostics, irrelevant route, rewritten criterion, unanalysed image, or secret-bearing artifact cannot pass. Return `needs-rework` for product behavior defects and a typed `external-block` only for genuinely unavailable browser tooling or service authority.
