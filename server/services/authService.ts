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
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
  },

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  },

  signToken(user: User): string {
    const payload: JwtPayload = { sub: user.id, username: user.username, role: user.role };
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
      return { sub: decoded.sub, username: decoded.username, role: decoded.role };
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

    // Cheap pre-checks so an obviously-rejected request (duplicate
    // username, or registration already closed) fails fast instead of
    // paying the ~50-100ms bcrypt cost first — that cost is bounded by
    // authLimiter, but there's no reason to pay it for a request that
    // can't possibly succeed. Both are re-checked authoritatively
    // inside doRegisterLocked's serialized section below, since a
    // concurrent request can change either between this read and the
    // lock actually running.
    if (UserRepository.findByUsername(trimmed)) {
      throw new Error('Username already taken');
    }
    if (UserRepository.count() > 0 && !callerIsAdmin) {
      throw new Error(REGISTRATION_CLOSED_MESSAGE);
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

  async login(username: string, password: string): Promise<{ user: User; token: string }> {
    const user = UserRepository.findByUsername(username.trim());
    if (!user) throw new Error('Invalid credentials');
    const ok = await this.verifyPassword(password, user.password_hash);
    if (!ok) throw new Error('Invalid credentials');
    return { user, token: this.signToken(user) };
  },
};

/** Shared between routes/auth.ts's cheap pre-check and the
 *  authoritative re-check in doRegisterLocked below, so the two error
 *  paths can't drift apart in wording. */
export const REGISTRATION_CLOSED_MESSAGE = 'Registration is closed. Ask an admin to create your account.';

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
  if (existingCount > 0 && !callerIsAdmin) {
    throw new Error(REGISTRATION_CLOSED_MESSAGE);
  }
  // First user becomes admin automatically
  const role: 'admin' | 'user' = existingCount === 0 ? 'admin' : 'user';
  const user = UserRepository.create(trimmed, passwordHash, role);
  return { user, token: authService.signToken(user) };
}
