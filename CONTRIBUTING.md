# Contributing

Thanks for looking. Small, focused changes are easiest to review.

1. Open an issue first for anything bigger than a bug fix.
2. Keep the packages dependency-free: `motion/` needs no libraries and `switchboard/` uses only the Python standard library.
3. Add or update a check for what you change, and run both suites before sending it:
   `node motion/test_motion.js`, `node motion/test_cradle.js`, `python switchboard/test_switchboard.py`.
4. By sending a contribution you agree that it is licensed under both MIT and Apache-2.0, the same as this project (see section 5 of the Apache license).
5. Keep the SPDX header (`SPDX-License-Identifier: MIT OR Apache-2.0`) at the top of every source file.
