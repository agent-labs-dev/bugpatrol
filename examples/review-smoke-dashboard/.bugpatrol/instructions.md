# The Bugpatrol dashboard

The app is the dashboard of Bugpatrol, a QA team of AI agents. It is read-only: it shows the files that the agents wrote, here a fixture workspace with made-up data.

- **Overview**: the agents, the issues that need a human, the live screen.
- **Issues**: a list on the left. Click an issue to see its detail: screenshots, steps, the judge's reasoning, and the proposed fix with its diff, fix attempts, and retests. The issue "Save button overlaps account text" has a fix.
- **Reviews**, **Activity**, **Flow**, **Screens**, **Memory**: the other pages, from the header.

The screenshots in the fixture are one-pixel images, so an empty or grey image is expected, not a bug. The page redraws when the workspace files change, which can close an open section.
