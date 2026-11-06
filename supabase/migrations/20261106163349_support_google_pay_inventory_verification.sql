-- Google Pay is captured by PayPal, just like Apple Pay. A payment may never be
-- considered verified without PayPal's capture receipt. This leaves historical
-- Venmo/Card rows readable while preventing either method from being selected by
-- the new Nexus checkout code.
ALTER TABLE public.payments
  ADD CONSTRAINT payments_google_pay_capture_required
  CHECK (
    provider IS DISTINCT FROM 'Google Pay'
    OR status IS DISTINCT FROM 'verified'
    OR NULLIF(provider_capture_id, '') IS NOT NULL
  ) NOT VALID;

ALTER TABLE public.payments
  VALIDATE CONSTRAINT payments_google_pay_capture_required;
