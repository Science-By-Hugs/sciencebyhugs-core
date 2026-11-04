# Step 3 — Nexus onboarding, PWA education, and iOS beta requests

## Repositories
- `Science-By-Hugs/sciencebyhugs-core`: database tables, operator analytics and manual beta queue
- `Science-By-Hugs/sciencebyhugs-nexus`: customer invitation, Home Screen guidance, persistent beta request action

## Release dependency
1. Review Core PR and merge after CI succeeds.
2. Apply its `nexus_onboarding_and_beta_requests` migration to shared production Supabase, verify RLS, policies and grants.
3. Merge the Nexus PR only after the new tables exist and run its tests/CI.
4. Open Nexus on an iPhone Safari tab, verify the lightweight prompt appears once for a signed-in unconfigured account, dismiss, reload, and verify it stays dismissed.
5. Open the PWA from Home Screen; ensure no automatic push permission prompt, and test Account → Notifications manually.
6. Submit a beta request using a test account. Verify a pending request appears in Core → Notifications and that only an owner/admin can view the full queue or mark a sent invite.

## Behavior
- “Email updates” is an explicit opt-in for order/status email preferences only; no marketing consent changes.
- Existing Push subscription system is unchanged. iOS Safari visitors see Share → Add to Home Screen → Open as Web App; iPhone-installed PWA users are directed to Account → Notifications.
- A customer can request beta access using their authenticated account email. Duplicate requests are not resubmitted.
- No TestFlight invite is sent automatically. Core's **Mark invite sent** is a manual acknowledgement with confirmation after an invitation is sent in Apple TestFlight.
- “Not now” is stored in local browser storage per account for 30 days. An action is recorded at most once per user/event in `nexus_onboarding_events`, without storing email in the metrics table.
- Preference or tracking errors should not block checkout, and the rollout preserves existing push delivery.

## Security considerations
- Both tables use RLS and explicit grants. Beta request email is checked against the signed-in JWT email.
- An ordinary signed-in customer can read their own beta status only; only owner/admin from immutable `app_metadata.role` can review/update all records and read analytics.
- Customer beta records are not publicly accessible; removing a customer auth account cascades removal.
- The release depends on Apple TestFlight external testing being set up separately; do not publish an unverified invitation URL.

## Validation
GitHub CI: `npm run build` and `node --test tests/*.test.cjs` on both repositories. Verify migration schema and policies before Nexus production deployment.
