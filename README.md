[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/encoderrrr/site-generator-speed-22nov/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/encoderrrr/site-generator-speed-22nov/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)


# site-generator-speed-22nov

A faster drop-in for makefun-site 1.0.0 for the make.fun bounty
[Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly
what makefun-site 1.0.0 returns for every input: each page's `index.html`,
the index and tag pages, `build-report.txt`, and every static file, byte for
byte. `main.ts` is the house harness driver, unchanged.

Speed comes from compiling each template once into a flat instruction list
rendered into a string array, cached slugs and long dates, a line-driven
Markdown renderer with a fast inline path, and per-source cards computed
once and reused. No network, no clock, no file access at runtime.
