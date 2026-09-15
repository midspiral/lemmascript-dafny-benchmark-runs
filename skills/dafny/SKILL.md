---
name: dafny
description: Complete and debug Dafny proofs using helper lemmas, function postconditions, focused verification, and standard arithmetic lemmas.
---

# Dafny proof completion

## Proof additions

Add helper lemmas, ghost predicates, assertions, and invariants while keeping
the task's existing lines unchanged. Appending a trailing comment to an
existing line (for example, `{  // note`) modifies that line and fails an
additions-only check. Put comments on their own new lines.

## Postconditions for caller composition

A generated function's postcondition may appear in a separate `<fn>_ensures`
lemma while the function itself carries only `requires` and `decreases`.
Callers do not automatically get that lemma's conclusion. When callers need
the property, add the `ensures` directly to the function on its own new lines
above the body-opening `{`. Dafny must prove the added postcondition against
the function body, including recursive calls. This applies to functions with
verified bodies, not trusted or bodyless declarations.

## Verification iteration

- Focus on one lemma with
  `dafny verify --filter-symbol=MyLemma solution.dfy`, carrying over the task's
  verifier flags from `PROMPT.md`.
- Use `--isolate-assertions` to identify which assertion or conjunct fails.
  A larger `--verification-time-limit` can help diagnose slow obligations;
  the supplied checker's per-task budget determines acceptance.
- Finish with the supplied authoritative checker on the whole file. Read
  diagnostics and the final summary. Use `tail -50` to inspect the end of a
  long log; a narrow `grep` can hide errors.

## Nonlinear arithmetic

Multiplication and division of variables can be unstable for Z3 even with
hand-written induction. Use Dafny's standard arithmetic lemmas for
cancellation and monotonicity, establishing each lemma's preconditions:

```dafny
import opened Std.Arithmetic.Mul
import opened Std.Arithmetic.DivMod
```

Insert imports as new lines. The benchmark checker enables
`--standard-libraries` when the file contains `Std.`; add that flag yourself
for direct `dafny verify` diagnostics. Small distributivity steps and
Euclidean identities can often be handled inline.

## Empty bodies and assumptions

An empty lemma body `{}` is still checked: Dafny asks Z3 to prove its
postconditions. A bodyless declaration does not provide a proof.
`assume` tells the verifier to trust a proposition and is not a proof shortcut;
the benchmark forbids adding it. Prove the existing obligations without
narrowing the task's preconditions or weakening its specifications.
