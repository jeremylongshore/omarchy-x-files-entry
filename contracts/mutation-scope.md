# Mutation-testing contract

X Files keeps a 90% breaking mutation floor over the two decision cores where
a plausible-looking regression would most directly hurt a user:

- `Model.js:594-705`: actionable-reply eligibility, spend accounting, the hard
  monthly stop, and the complete bar/panel status derived from those decisions.
- `Model.js:890-1000`: reply classification records, bounded eviction,
  parent/conversation routing, duplicate ingestion, and final queue assembly.

The scope is intentionally explicit rather than presenting a weak score over
formatting helpers and large regular-expression tables as a meaningful safety
signal. The entire `Model.js` remains subject to the 95/90/95/95 coverage
floors, deterministic unit suite, three-repeat race lane, fixture-driven render
contract, and canonical static/runtime gates. Changing either line range must
also update the contract test that binds its endpoints to the named functions.
