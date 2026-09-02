# Archive

Historical planning documents. **Nothing here describes current behaviour.** Each file's frontmatter
carries `status`, `reviewed` (the date it was audited against the code) and `outcome` (what actually
happened, with commit hashes). Read `outcome` first; the body is what we *intended* at the time.

Status vocabulary, shared with `docs/plans/` and `docs/brainstorms/`:

| status | meaning |
|---|---|
| `completed` | All major deliverables landed. Archived. |
| `superseded` | A brainstorm that became a plan, or a plan replaced by a later one. Archived. |
| `abandoned` | Implemented then reverted, or dropped. Archived. |
| `partial` | Some units landed, some did not. Stays in `docs/plans/` until finished or abandoned. |
| `proposed` | Written, never started. Stays in `docs/plans/` until executed or abandoned. |
| `active` | Work in progress right now. |

Audited 2026-09-02. Still live in `docs/plans/`: sponsor ads (partial), batch-insert outbox (partial, Unit 8
cleanup pending), stacked coins rising platform (proposed).

Also archived here with a banner: `Scene.md` (Rev B PoC scene numbers) and `backend-optimization.md`
(early-2026 optimization plan, mostly done or superseded by the outbox).
