# Step 3 — Nexus PWA onboarding and iOS beta SMS request

## Repositories
- `Science-By-Hugs/sciencebyhugs-core`: distinct signed-in account onboarding event metrics
- `Science-By-Hugs/sciencebyhugs-nexus`: gentle onboarding, Home Screen guide, email setup, SMS-to-owner beta request

## iOS beta request
The beta button composes a prefilled text to **(725) 310-7502** from the customer's own Messages app. The text contains the signed-in customer's account name and email, when available. They **must tap Send themselves**. When a name is unavailable, the text contains an editable [Your name] placeholder. The business does not send SMS and no Twilio or Brevo SMS messaging is involved.

SMS URI body support may vary by browser. Provide copy-text and direct-phone fallbacks; test on an actual iPhone Safari browser. Analytics record only the attempt to open a text, not whether the text was sent or received. Customers who text will be handled via the owner's messaging inbox and existing Apple TestFlight invitation process. No automatic invitation or in-app beta queue is created.

## Release dependency
1. Core branch CI and code review pass; merge Core.
2. Apply its `nexus_onboarding_adoption` migration to the shared production Supabase project; verify policies and admin-only analytics read.
3. Nexus branch CI passes, then merge; Nexus deploys automatically from main.
4. iPhone Safari acceptance: a signed-in unconfigured account sees optional invitation; not-now persists for 30 days; install steps display; email opt-in saves.
5. From both the optional invitation and Account → Notifications, request beta; Messages opens to 725-310-7502, with name/email prefilled where supported; verify message can be edited and sent manually.
6. Real installed PWA retains push notifications and test notification feature.

## Customer consent & privacy
- Order email preferences remain distinct from marketing consent.
- No new server-side storage of personal name/email for beta enrollment. The SMS leaves the app via the customer's own Messages handler.
- No automatic permission dialogs, repeated popups, or automatically sent texts.
- Core counts unique signed-in customer onboarding actions, never claims SMS send completion.
