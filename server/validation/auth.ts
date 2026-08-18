import { z } from "zod";

// Accepts either an email (local accounts) or a bare Linux username (PAM accounts).
export const loginSchema = z.object({
  email: z.string().min(1).max(255),
  password: z.string().min(1).max(128)
});
