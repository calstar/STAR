-- An admin's approval now parks a reimbursement here; only a PVP sends it on to
-- `approved` (the CalLink worker's queue).
ALTER TYPE "ReimbursementStatus" ADD VALUE 'awaiting_send' BEFORE 'approved';
