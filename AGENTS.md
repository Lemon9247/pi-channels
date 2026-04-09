# AGENTS.md

## Project Instructions

### Exposed tool philosophy

This project does **not** treat tool schemas or tool names as stable public API.

If a tool shape is awkward, overloaded, or conceptually wrong:
- break it
- rename it
- split it apart
- delete compatibility shims
- update the prompts/docs/tests and move on

Prefer tools that match user intent (`msg`, `agent`, `channel`, `reserve`, etc.) over one giant RPC-style multiplexer with an `action` field.

This is a hackable system, not a compatibility museum. Optimize for clarity, composability, and local usefulness.

Short version: **hackable, breakable, shapeable tools win over backwards compatibility.**
