# 24. Git and Change Hygiene

## 24.1 Keep commits coherent

A commit should represent one understandable unit of change when practical. It should be possible to state its purpose in one sentence.

## 24.2 Do not commit generated or local junk unintentionally

Check for:

- .env files;
- IDE state;
- local databases;
- coverage/build output unless repository policy tracks it;
- credentials;
- debug artifacts;
- large binary files unrelated to the product.

## 24.3 Do not use source comments as changelog

Git already tracks line history. Put user-visible changes in the actual changelog/release notes when the project maintains them.

## 24.4 Avoid drive-by rewrites

A feature branch should not opportunistically rewrite unrelated modules because an AI spotted style improvements. Broad changes increase regression and review risk.
