# iOS Proof Procedure

Use iOS proof only when a frozen criterion describes user-visible iOS behavior or the checked diff changes that behavior. Keep exact criterion IDs and declare `decision.mode: visual`, target `ios`, and an `ios` surface for each applicable criterion.

1. Perform read-only Xcode/Simulator discovery. If any Simulator is already booted or Flutter, VM Service, XCTest, Simulator UI, or IDE ownership is ambiguous, return a typed tool blocker without mutation.
2. Acquire the lease with the exact immutable helper, lease root, artifact, proof ID, bundle ID, owner PID, xcrun path, runtime ID, and device-type ID supplied by the runner. The helper creates a new proof-bound Simulator after durable intent. Never select, boot, install into, or delete an existing device; never use the `booted` alias.
3. Boot, build, install, and launch only through the returned UDID. Bind the exact bundle/process with the helper before accepting evidence. Every later `simctl` or test command must contain that literal UDID.
4. Complete the workflow with XCUITest or an equivalent accessibility driver. Select controls by accessibility identity or hierarchy, never guessed coordinates. Capture pre/final accessibility hierarchy and prove the requested final state from live accessibility text/state.
5. While the exact final app process remains live, capture a fresh Simulator PNG and process-scoped Simulator log, then verify the same lease/app/process again. Broad logs are forbidden.
6. Review spacing, padding, clipping, overlap, alignment, and the specific visual complaint. Separately review visible copy against the frozen criterion and link both reviews to exact evidence IDs.
7. Write artifacts only below the proof directory. Keep hierarchy, logs, and lease local-only. A screenshot may be publishable only when it contains no credential, secret, private path, or unrelated account data. Keep UDID, bundle/process identity, lease token, raw logs, and local paths out of publishable results.
8. Emit the exact generated Proof Report with screenshot plus hierarchy linked to every iOS criterion, process-log and lease refs, workflow/final state, post-interaction freshness, and evidence-linked layout/copy reviews.

The runner reconciles shutdown/delete and releases the lease after terminal proof settlement. Do not release early. Screenshot-only, stale, unleased, target-drifted, guessed-interaction, broad-log, rewritten-criterion, or secret-bearing evidence cannot pass.
