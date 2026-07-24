# Refactoring After GREEN

Stop when GREEN code is clear and local. Refactor only when the current change
introduced concrete duplication, confusion, or misplaced ownership and the edit
reduces total complexity.

Keep it local. Do not add helpers, classes, value objects, deeper modules, or
unrelated cleanup from pattern preference alone. Rerun affected tests.
