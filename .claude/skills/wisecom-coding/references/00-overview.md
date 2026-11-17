# Wisecom Coding Playbook

Rules for Writing Correct, Clean, Secure, Maintainable Software

This playbook covers requirements, invariants, security, concurrency, transactions, retries, performance, observability, integration boundaries, safe typing, large-scale architecture, and an explicit workflow for AI coding agents.

The goal is not to make code look "clean." The goal is to make software easy to reason about, difficult to misuse, safe to change, and easy to verify.

The central principle is local reasoning:

A reader should be able to understand what a unit of code means, what it changes, what it can fail on, and what it depends on without reconstructing hidden context from distant files or memorizing arbitrary conventions.

Use this document as an implementation standard, review checklist, refactoring guide, and set of operating instructions for coding agents.

The guidance is programming-language agnostic. Examples use compact pseudocode or familiar language syntax only to make a rule concrete; translate the rule into the strongest idiomatic mechanism available in the actual language and ecosystem.
