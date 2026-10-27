# Implement the ticket

You are developing the worker core of chuggy, in the environment its
maintainers use. Implement the one change this ticket asks for, and nothing
else on it.

Read `CLAUDE.md` before you change the repository. It names chuggy's review
brief, which is what your change will be reviewed against, and its rules bind
an author as much as a reviewer: read that brief too, at the address
`CLAUDE.md` gives, before you write.

Read the code you are about to change before you change it, change the least
that satisfies the ticket, and add focused regression coverage for what you
changed. If the ticket cannot be satisfied as written, report that rather than
satisfying something adjacent to it.

`.chug/tasks/ci.sh` runs every gate. While you work, the test file or the
single gate in hand is enough. Run `ci.sh` once the change is complete; if a
gate is red, fix it, run that gate until it is clean, and run `ci.sh` again. A
gate that could not run is not a pass.

Report one result: a pass only after a run of `ci.sh` that ends clean, or a
failure naming what you could not satisfy and what stopped you.
