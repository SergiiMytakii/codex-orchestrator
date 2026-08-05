# Refactoring After GREEN

Stop when GREEN code is clear and local. Refactor only after GREEN and only when
the current change exposes specific concrete observed complexity: duplication,
confusion, or misplaced ownership that the edit will reduce.

Keep it local. Do not add helpers, classes, value objects, deeper modules, or
unrelated cleanup from pattern preference alone. Rerun affected tests.
