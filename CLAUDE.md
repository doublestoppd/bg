Project Goal

Build an original browser-based virtual pet game inspired by early-2000s games such as Neopets.

The game must be simple to understand, modify, debug, and maintain manually. Favor readable, conventional JavaScript over architectural sophistication.

This project will initially be developed with AI assistance, but every system must remain understandable to a human developer.

Required Technology

* Node.js using standard JavaScript and ES modules.
* Express for the backend.
* EJS for server-rendered HTML templates.
* Vanilla JavaScript for browser interactions.
* Plain CSS for styling and responsive layouts.
* PostgreSQL using pg (node-postgres).
* Plain, parameterized SQL queries rather than an ORM.
* Node.js built-in test runner.

Do not introduce TypeScript, React, Vue, Svelte, Tailwind, Prisma, Docker, or other major technologies without discussing the specific need first.

Architecture

Use a modular monolith.

Separate HTTP routes, game rules, database operations, HTML templates, and browser-side JavaScript.

Keep business logic out of routes and templates. Routes should handle requests and responses, while game modules implement gameplay rules.

Place SQL statements in dedicated database modules rather than scattering them throughout the application.

Do not introduce dependency injection frameworks, class hierarchies, elaborate design patterns, generic repository frameworks, or unnecessary abstractions.

Use ordinary functions and objects where practical.

Code Quality

* Prioritize clarity over cleverness.
* Use descriptive variable and function names.
* Keep functions focused on one responsibility.
* Avoid premature optimization.
* Avoid unnecessary dependencies.
* Do not duplicate existing functionality.
* Write comments explaining non-obvious decisions, not obvious syntax.
* Use consistent naming and file organization.
* Never create placeholder systems presented as completed functionality.

Security and Data Integrity

All authoritative game state must be controlled by the server.

Never trust client-submitted currency amounts, rewards, item ownership, or pet statistics.

Use database transactions for purchases, item transfers, and other multi-step state changes.

Use established password hashing, secure session management, CSRF protection, input validation, and parameterized SQL.

Enforce player ownership and permissions on every protected action.

Visual Design

The website should authentically resemble a colorful browser game from 2002–2005.

Use compact layouts, illustrated navigation, square borders, traditional hyperlinks, hand-drawn cartoon artwork, and Verdana/Trebuchet-style typography.

The game world is quirky, eccentric, playful, and slightly strange.

Avoid modern dashboard aesthetics, oversized cards, glass effects, minimalist application interfaces, and generic modern UI libraries.

The website must remain usable on mobile phones without compromising its early-2000s visual identity.

Core gameplay should work through traditional links and HTML forms wherever practical.

Development Workflow

Work in small, complete increments rather than implementing many systems simultaneously.

Before significant changes, explain the files that will be modified and why.

Do not rewrite working systems unnecessarily.

After implementing a feature:

1. Explain which files changed and what each file does.
2. Explain the request-to-database flow in plain language.
3. Run relevant automated tests and report the actual results.
4. Provide instructions for manually testing the feature.
5. Update the documentation when the architecture changes.

Maintain a README.md with installation and startup instructions, and docs/ARCHITECTURE.md explaining how the application works.

Use Git for version control and keep changes small enough to review and revert.

The goal is a maintainable game that can evolve for years, not a demonstration of advanced frameworks or programming techniques.
