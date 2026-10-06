import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { UserRepository, type User } from '../database/models/User.js';

const SALT_ROUNDS = 10;
const TOKEN_TTL = '7d';

export interface JwtPayload {
  sub: number;
  username: string;
  role: 'admin' | 'user';
}

export const authService = {
  hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
  },

  verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  },

  signToken(user: User): string {
    const payload: JwtPayload & { ver: number } = {
      sub: user.id, username: user.username, role: user.role, ver: user.token_version,
    };
    return jwt.sign(payload, config.jwtSecret, { expiresIn: TOKEN_TTL });
  },

  verifyToken(token: string): JwtPayload | null {
    try {
      // jsonwebtoken's verify can return `string | JwtPayload` because
      // tokens signed with `sign(string, secret)` decode back to a
      // string. We sign objects, so the string branch is unreachable
      // — but type-narrow on it anyway rather than a blind cast. Same
      // for the field shape: validate at the runtime boundary so a
      // token signed with the same secret but a different payload
      // shape (cross-app reuse, future schema migration, dev artefact)
      // gets rejected instead of silently flowing through as a
      // partially-shaped JwtPayload.
      const decoded = jwt.verify(token, config.jwtSecret);
      if (typeof decoded === 'string') return null;
      if (
        typeof decoded.sub !== 'number' ||
        typeof decoded.username !== 'string' ||
        (decoded.role !== 'admin' && decoded.role !== 'user')
      ) return null;
      // The signature alone isn't enough: a password change bumps the
      // account's token_version (revoking older tokens) and a deleted
      // account must lose access at once. Tokens signed before `ver`
      // existed read as version 0, the column default. Username and
      // role come from the row, so a rename shows up without re-login.
      const user = UserRepository.findById(decoded.sub);
      const ver = typeof decoded.ver === 'number' ? decoded.ver : 0;
      if (user?.token_version !== ver) return null;
      return { sub: user.id, username: user.username, role: user.role };
    } catch {
      return null;
    }
  },

  async register(
    username: string,
    password: string,
    opts?: { callerIsAdmin?: boolean },
  ): Promise<{ user: User; token: string }> {
    const trimmed = username.trim();
    if (trimmed.length < 3) throw new Error('Username must be at least 3 characters');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');

    const callerIsAdmin = opts?.callerIsAdmin ?? false;

    // Cheap pre-check so an obviously-rejected duplicate username fails
    // fast instead of paying the ~50-100ms bcrypt cost first. Re-checked
    // authoritatively inside doRegisterLocked's serialized section
    // below, since a concurrent request can still claim the name
    // between this read and the lock actually running. The
    // registration-closed rule (canRegister) is NOT pre-checked here on
    // top of it: routes/auth.ts already short-circuits that case before
    // ever calling register(), so duplicating it here would just be a
    // third place encoding the same rule for no real benefit — the rare
    // bootstrap-race caller that slips past the route still gets
    // rejected by doRegisterLocked, just after paying the hash cost
    // once, ever.
    if (UserRepository.findByUsername(trimmed)) {
      throw new Error('Username already taken');
    }

    // Hash BEFORE entering the serialized section below. bcrypt is the
    // slow part of registration and touches no shared state, so it's
    // safe — and much better for throughput — to run concurrently
    // across calls. Only the count()-based decisions and the INSERT
    // need to be serialized (see doRegisterLocked).
    const passwordHash = await this.hashPassword(password);

    const task = registerChain
      .catch(() => undefined)
      .then(() => doRegisterLocked(trimmed, passwordHash, callerIsAdmin));
    registerChain = task.catch(() => undefined);
    return task;
  },

  /** Self-service password change: the current password must match.
   *  Same 8-character minimum as register. Every other session of the
   *  account is signed out; returns a fresh token for this one. */
  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<string> {
    const user = UserRepository.findById(userId);
    if (!user) throw new AccountChangeError('Account not found', 404);
    if (!(await this.verifyPassword(currentPassword, user.password_hash))) {
      throw new AccountChangeError('Current password is incorrect', 403);
    }
    if (newPassword.length < 8) throw new AccountChangeError('Password must be at least 8 characters', 400);
    if (newPassword.length > 256) throw new AccountChangeError('Password must be at most 256 characters', 400);
    if (newPassword === currentPassword) throw new AccountChangeError('The new password must differ from the current one', 400);
    UserRepository.updatePassword(user.id, await this.hashPassword(newPassword));
    // Re-read: the update bumped token_version, the new token must carry it.
    return this.signToken(UserRepository.findById(user.id)!);
  },

  /** Self-service rename, gated on the current password like
   *  changePassword. Same 3-character minimum as register. Returns the
   *  renamed user and a fresh token (the JWT carries the username). */
  async changeUsername(userId: number, currentPassword: string, newUsername: string): Promise<{ user: User; token: string }> {
    const user = UserRepository.findById(userId);
    if (!user) throw new AccountChangeError('Account not found', 404);
    if (!(await this.verifyPassword(currentPassword, user.password_hash))) {
      throw new AccountChangeError('Current password is incorrect', 403);
    }
    const trimmed = newUsername.trim();
    if (trimmed.length < 3) throw new AccountChangeError('Username must be at least 3 characters', 400);
    if (trimmed.length > 64) throw new AccountChangeError('Username must be at most 64 characters', 400);
    // The name lands in log lines (ws connect/disconnect): no forged lines.
    if (/\p{Cc}/u.test(trimmed)) throw new AccountChangeError('Username must not contain control characters', 400);
    if (trimmed === user.username) throw new AccountChangeError('The new username must differ from the current one', 400);
    // No await between this check and the UPDATE (better-sqlite3 is
    // synchronous), and the UNIQUE constraint backs it up anyway.
    if (UserRepository.findByUsername(trimmed)) throw new AccountChangeError('Username already taken', 409);
    UserRepository.updateUsername(user.id, trimmed);
    const renamed = { ...user, username: trimmed };
    return { user: renamed, token: this.signToken(renamed) };
  },

  async login(username: string, password: string): Promise<{ user: User; token: string }> {
    const user = UserRepository.findByUsername(username.trim());
    if (!user) throw new Error('Invalid credentials');
    const ok = await this.verifyPassword(password, user.password_hash);
    if (!ok) throw new Error('Invalid credentials');
    return { user, token: this.signToken(user) };
  },
};

/** A refused password change or rename, with the HTTP status the route returns. */
export class AccountChangeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Shared between routes/auth.ts's cheap pre-check and the
 *  authoritative re-check in doRegisterLocked below, so the two error
 *  paths can't drift apart in wording. */
export const REGISTRATION_CLOSED_MESSAGE = 'Registration is closed. Ask an admin to create your account.';

/** The one source of truth for "is registration open to this caller?":
 *  either no user exists yet (bootstrap) or the caller is already an
 *  authenticated admin. Used by both routes/auth.ts's fast pre-check
 *  (evaluated once, before ever calling register()) and
 *  doRegisterLocked's authoritative re-check (evaluated again inside
 *  the lock) — two different points in time on purpose, for the
 *  race-safety reasons explained on doRegisterLocked, but one rule. */
export function canRegister(existingUserCount: number, callerIsAdmin: boolean): boolean {
  return existingUserCount === 0 || callerIsAdmin;
}

// Serialization lock for register(): resolves once the previous
// register() call's doRegisterLocked (success or failure) has fully
// settled, so the next one's count()->role check can't run until the
// prior INSERT (or rejection) has landed. See the comment on
// authService.register. better-sqlite3 is synchronous, so everything
// inside doRegisterLocked below effectively runs atomically once its
// turn in the chain comes up — no awaits inside it to yield on.
let registerChain: Promise<unknown> = Promise.resolve();

function doRegisterLocked(
  trimmed: string,
  passwordHash: string,
  callerIsAdmin: boolean,
): { user: User; token: string } {
  if (UserRepository.findByUsername(trimmed)) {
    throw new Error('Username already taken');
  }
  // Authoritative check, now serialized: the route's own count()>0
  // guard runs before entering this lock, so two concurrent bootstrap
  // requests can both pass it with count()===0 and both queue up here.
  // Re-checking with a count() taken *after* acquiring the lock is
  // what makes only one of them actually win.
  const existingCount = UserRepository.count();
  if (!canRegister(existingCount, callerIsAdmin)) {
    throw new Error(REGISTRATION_CLOSED_MESSAGE);
  }
  // First user becomes admin automatically
  const role: 'admin' | 'user' = existingCount === 0 ? 'admin' : 'user';
  const user = UserRepository.create(trimmed, passwordHash, role);
  return { user, token: authService.signToken(user) };
}
