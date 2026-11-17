# 2. Normative Language

This playbook uses three levels:

- MUST: required unless the task or existing architecture makes it impossible.

- SHOULD: the default; deviate when there is a concrete reason.

- MAY: optional technique that can improve a particular design.

Many clean-code ideas are heuristics rather than laws. For example:
- Functions SHOULD usually be small, but there is no universal line-count limit.

- Functions SHOULD usually do one conceptual thing, but one coherent operation may contain several mechanical steps.

- Functions SHOULD usually have few positional parameters, but three strongly related coordinates may be clearer than an unnecessary wrapper object.

- Duplication SHOULD often be removed, but an incorrect abstraction is worse than a small amount of honest duplication.

- Exceptions MAY be better than error codes for exceptional failures, while explicit Result/union types are often better for expected domain outcomes.

- TDD is a powerful workflow, not a requirement to write a meaningless test before every exploratory line of code.

The objective is understandable software, not ritual compliance.
