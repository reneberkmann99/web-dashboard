-- Add explicit operator intent to the discovered container inventory so the
-- attention domain can tell an intentional stop (operator pressed Stop) apart
-- from an unexpected process exit while expected to be running.
ALTER TABLE "Container" ADD COLUMN "expectedState" TEXT;
