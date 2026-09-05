import type { Role } from '../modules/users/user.model.js';

declare global {
  // A namespace is the required shape for augmenting Express's Request.
  namespace Express {
    interface Request {
      /** Populated by requireAuth. Absent on public routes. */
      user?: {
        id: string;
        role: Role;
        sessionId: string;
        /** Subsidiary ids this user may access (PRD §2). Empty for Admin, who is unscoped. */
        subsidiaryAccess: string[];
      };
    }
  }
}

export {};
